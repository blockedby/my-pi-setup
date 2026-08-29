import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import type {
  PipelineDefinitionId,
  PipelineHandoff,
  PipelineStage,
} from "./domain.ts";
import { PipelineController } from "./controller.ts";
import { PIPELINE_RUN_PARAMETERS } from "./index.ts";
import {
  PIPELINE_EXECUTION_FINISH_PARAMETERS,
  createPipelineExecutionFinishTool,
} from "./session.ts";
import { Check } from "typebox/value";
import {
  MAX_PIPELINE_WALLCLOCK_LIMIT_MS,
  MIN_PIPELINE_WALLCLOCK_LIMIT_MS,
  parsePipelineWallclockLimit,
  timedPipelineStage,
  type PipelineMonotonicClock,
  type PipelineWallclockScheduler,
} from "./wallclock.ts";

class FakeClock implements PipelineMonotonicClock {
  value = 0;
  now() {
    return this.value;
  }
}

class FakeScheduler implements PipelineWallclockScheduler {
  private callbacks: Array<{
    at: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];
  private clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  schedule(delayMs: number, callback: () => void) {
    const entry = {
      at: this.clock.value + delayMs,
      callback,
      cancelled: false,
    };
    this.callbacks.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  runDue() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const due = this.callbacks
        .filter((entry) => !entry.cancelled && entry.at <= this.clock.value)
        .sort((left, right) => left.at - right.at);
      for (const entry of due) {
        entry.cancelled = true;
        entry.callback();
        progressed = true;
      }
    }
  }
}

class FakeSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly sends: string[] = [];
  readonly activeTools: ReadonlyArray<string> = [];
  readonly sessionFile = undefined;
  isStreaming = false;
  disposed = 0;

  constructor(readonly spec: AgentNodeSpec) {}

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt() {}

  async send(text: string) {
    this.sends.push(text);
  }

  enableMutation() {}

  async interrupt() {}

  dispose() {
    this.disposed++;
  }
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("wallclock parser accepts canonical inclusive bounds and disables omission", () => {
  assert.equal(parsePipelineWallclockLimit(), undefined);
  assert.equal(
    parsePipelineWallclockLimit("30s"),
    MIN_PIPELINE_WALLCLOCK_LIMIT_MS,
  );
  assert.equal(
    parsePipelineWallclockLimit("24h"),
    MAX_PIPELINE_WALLCLOCK_LIMIT_MS,
  );
  assert.equal(parsePipelineWallclockLimit("5m"), 300_000);
  for (const value of ["8640s", "9000s", "36000s", "86399s", "86400s"]) {
    assert.equal(
      parsePipelineWallclockLimit(value),
      Number(value.slice(0, -1)) * 1_000,
    );
  }
  for (const value of [
    "0s",
    "029s",
    "30.0s",
    "30s ",
    "30S",
    "1s30s",
    "-1h",
    "NaNs",
    "9007199254740992s",
    "29s",
    "25h",
    "86401s",
    "90000s",
  ]) {
    assert.throws(() => parsePipelineWallclockLimit(value), /wallclock_limit/);
  }
});

test("public pipeline input keeps the limit optional, canonical, and bounded", () => {
  const request = {
    pipeline_name: "bounded-wallclock-plan",
    pipeline: "plan-pipeline",
    task: "Produce a plan",
    plan_path: null,
  };
  assert.equal(Check(PIPELINE_RUN_PARAMETERS, request), true);
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, { ...request, wallclock_limit: "5m" }),
    true,
  );
  for (const wallclock_limit of [
    "29s",
    "30.5s",
    "30 s",
    "25h",
    "86401s",
    "90000s",
    30,
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        pipeline_name: "bounded-wallclock-plan",
        pipeline: "plan-pipeline",
        task: "Produce a plan",
        plan_path: null,
        wallclock_limit,
      }),
      false,
    );
  }
  for (const wallclock_limit of ["8640s", "9000s", "36000s", "86399s"]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        pipeline_name: "bounded-wallclock-plan",
        pipeline: "plan-pipeline",
        task: "Produce a plan",
        plan_path: null,
        wallclock_limit,
      }),
      true,
    );
  }
});

test("controller leaves timing disabled when the caller omits a limit", async () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const controller = new PipelineController({
    createSessionFactory: () => ({
      async create(spec) {
        return new FakeSession(spec);
      },
    }),
    onHandoff: () => {},
    makeRunId: () => "untimed-wallclock-plan-00000001",
    clock,
    scheduler,
  });
  const runId = controller.start({
    pipelineName: "untimed-wallclock-plan",
    pipeline: "plan-pipeline",
    task: "Produce a plan",
    workingDir: "/tmp",
    gitCommit: false,
    planPath: null,
  });
  const run = controller.get(runId);
  assert.equal(run?.wallclockLimitMs, undefined);
  assert.equal(run?.stageTiming, undefined);
  assert.equal(run?.wallclock, undefined);
  await controller.dispose();
});

test("controller rejects out-of-range limits before inserting or creating a run", () => {
  let sessionsCreated = 0;
  const controller = new PipelineController({
    createSessionFactory: () => ({
      async create(spec) {
        sessionsCreated++;
        return new FakeSession(spec);
      },
    }),
    onHandoff: () => {},
    makeRunId: () => "admission-wallclock-plan-00000001",
  });
  assert.throws(
    () =>
      controller.start({
        pipelineName: "admission-wallclock-plan",
        pipeline: "plan-pipeline",
        task: "Produce a plan",
        workingDir: "/tmp",
        gitCommit: false,
        planPath: null,
        wallclockLimit: "29s",
      }),
    /wallclock_limit/,
  );
  assert.deepEqual(controller.list(), []);
  assert.equal(sessionsCreated, 0);
});

test("execution finish is a constrained terminating provenance tool", async () => {
  let submitted: unknown;
  const tool = createPipelineExecutionFinishTool((value) => {
    submitted = value;
  });
  assert.equal(tool.name, "pipeline_execution_finish");
  assert.equal(
    Check(PIPELINE_EXECUTION_FINISH_PARAMETERS, { output: "partial" }),
    true,
  );
  assert.equal(Check(PIPELINE_EXECUTION_FINISH_PARAMETERS, {}), false);
  assert.equal(
    Check(PIPELINE_EXECUTION_FINISH_PARAMETERS, { changed_paths: [] }),
    false,
  );
  const result = await tool.execute(
    "finish-1",
    { output: "partial" },
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(submitted, { output: "partial" });
});

test("timed stage matrix leaves only plan completion untimed", () => {
  assert.deepEqual(
    (
      [
        "feature-pipeline",
        "small-feature-pipeline",
        "plan-pipeline",
        "audit-pipeline",
      ] as const
    )
      .flatMap((definition) =>
        (
          [
            "discover",
            "build",
            "audit",
            "audit-resolve",
            "final-audit",
            "final-resolve",
            "synthesize",
            "complete",
          ] as const
        ).map((stage) => [
          definition,
          stage,
          timedPipelineStage(definition, stage),
        ]),
      )
      .filter(([definition, _stage, timed]) => timed === true) as Array<
      [PipelineDefinitionId, PipelineStage, true]
    >,
    [
      ["feature-pipeline", "discover", true],
      ["feature-pipeline", "build", true],
      ["feature-pipeline", "audit", true],
      ["feature-pipeline", "audit-resolve", true],
      ["feature-pipeline", "final-audit", true],
      ["feature-pipeline", "final-resolve", true],
      ["small-feature-pipeline", "build", true],
      ["small-feature-pipeline", "final-audit", true],
      ["small-feature-pipeline", "final-resolve", true],
      ["plan-pipeline", "discover", true],
      ["plan-pipeline", "synthesize", true],
      ["audit-pipeline", "audit", true],
    ],
  );
});

test("controller warns current-stage sessions at 80% and settles once at 100%", async () => {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const sessions: FakeSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  const controller = new PipelineController({
    monotonicClock: clock,
    wallclockScheduler: scheduler,
    createSessionFactory: (_rootTools, _definitionForRun) => ({
      async create(spec) {
        const session = new FakeSession(spec);
        sessions.push(session);
        return session;
      },
    }),
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
    makeRunId: () => "wallclock-plan-test-00000001",
    makeAgentId: (() => {
      let id = 0;
      return () => `agent-${++id}`;
    })(),
  });

  const runId = controller.start({
    pipelineName: "wallclock-plan-test",
    pipeline: "plan-pipeline",
    task: "Produce a plan",
    workingDir: "/tmp",
    gitCommit: false,
    planPath: null,
    wallclockLimit: "30s",
  });
  await flush();
  clock.value = 24_000;
  scheduler.runDue();
  assert.equal(
    sessions.filter((session) => session.sends.length > 0).length,
    6,
  );
  assert.equal(controller.get(runId)?.wallclock?.warningReached, true);
  assert.equal(controller.get(runId)?.status, "running");

  clock.value = 30_000;
  scheduler.runDue();
  await flush();
  assert.equal(controller.get(runId)?.status, "limited");
  assert.equal(controller.get(runId)?.limitation?.stage, "discover");
  assert.equal(controller.get(runId)?.limitation?.elapsedMs, 30_000);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]?.status, "limited");
  assert.equal(handoffs[0]?.limitation?.reason, "stage-deadline");
  scheduler.runDue();
  assert.equal(handoffs.length, 1);
  await controller.dispose();
});
