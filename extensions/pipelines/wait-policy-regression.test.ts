import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import { PipelineController } from "./controller.ts";
import type { PipelineHandoff } from "./domain.ts";
import type {
  PipelineMonotonicClock,
  PipelineWallclockScheduler,
} from "./wallclock.ts";

class FakeClock implements PipelineMonotonicClock {
  value = 0;

  now() {
    return this.value;
  }
}

class FakeScheduler implements PipelineWallclockScheduler {
  readonly scheduled: Array<{
    delayMs: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  schedule(delayMs: number, callback: () => void) {
    const entry = { delayMs, callback, cancelled: false };
    this.scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  fire(delayMs: number) {
    for (const entry of this.scheduled) {
      if (entry.cancelled || entry.delayMs !== delayMs) continue;
      entry.cancelled = true;
      entry.callback();
    }
  }
}

class PendingSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly activeTools: ReadonlyArray<string> = [];
  readonly sessionFile = undefined;
  isStreaming = false;
  interrupted = 0;
  disposed = 0;

  constructor(readonly spec: AgentNodeSpec) {}

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt() {}

  async send() {}

  enableMutation() {}

  async interrupt() {
    this.interrupted++;
    for (const listener of this.listeners) {
      listener({ type: "settled", outcome: { type: "cancelled" } });
    }
  }

  dispose() {
    this.disposed++;
  }
}

function flush() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function createHandoffWaiter() {
  let resolveHandoff: (handoff: PipelineHandoff) => void = () => {};
  const promise = new Promise<PipelineHandoff>((resolve) => {
    resolveHandoff = (handoff) => resolve(handoff);
  });
  return { promise, resolve: resolveHandoff };
}

async function awaitHandoff(pending: Promise<PipelineHandoff>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("pipeline handoff did not settle promptly")),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settlePromptly<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("pipeline child wait did not settle promptly")),
          100,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function harness() {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler();
  const sessions: PendingSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  const handoffWaiter = createHandoffWaiter();
  const artifactRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-wait-policy-regression-"),
  );
  let agentSequence = 0;
  const controller = new PipelineController({
    artifactRoot,
    clock,
    scheduler,
    makeRunId: () => "wait-policy-regression-00000001",
    makeAgentId: () => `agent-${++agentSequence}`,
    createSessionFactory: () => ({
      async create(spec) {
        const session = new PendingSession(spec);
        sessions.push(session);
        return session;
      },
    }),
    onHandoff: (handoff) => {
      handoffs.push(handoff);
      handoffWaiter.resolve(handoff);
    },
  });
  return {
    clock,
    scheduler,
    sessions,
    handoffs,
    handoff: handoffWaiter.promise,
    artifactRoot,
    controller,
  };
}

async function startPendingPlan(fixture: ReturnType<typeof harness>) {
  const runId = fixture.controller.start({
    pipelineName: "wait-policy-regression",
    pipeline: "plan-pipeline",
    task: "Keep one discovery child pending",
    workingDir: "/tmp",
    gitCommit: false,
    planPath: null,
    wallclockLimit: "30s",
  });
  for (let turn = 0; turn < 8; turn++) {
    if (fixture.controller.get(runId)?.agents.length === 7) break;
    await flush();
  }
  const run = fixture.controller.get(runId);
  assert.equal(run?.status, "running");
  assert.equal(run?.stage, "discover");
  assert.equal(run?.agents.length, 7);
  const child = run?.agents.find((agent) => agent.parentId);
  assert.ok(child);
  assert.deepEqual(
    fixture.scheduler.scheduled.map((entry) => entry.delayMs),
    [24_000, 30_000],
  );
  return { runId, childId: child.id, initialAgents: run.agents };
}

async function waitForHandoff(fixture: ReturnType<typeof harness>) {
  const handoff = await awaitHandoff(fixture.handoff);
  assert.equal(fixture.handoffs.length, 1);
  return handoff;
}

test("an unbounded child wait settles when its pipeline run is cancelled", async () => {
  const fixture = harness();
  try {
    const { runId, childId, initialAgents } = await startPendingPlan(fixture);
    let settled = false;
    const waiting = fixture.controller
      .waitForChildren(runId, [childId])
      .then((children) => {
        settled = true;
        return children;
      });
    await flush();
    assert.equal(settled, false);

    const cancellation = fixture.controller.cancelRun(runId);
    const children = await settlePromptly(waiting);
    const cancelled = await settlePromptly(cancellation);
    await waitForHandoff(fixture);

    assert.equal(children[0]?.id, childId);
    assert.equal(children[0]?.status, "cancelled");
    assert.equal(cancelled.status, "cancelled");
    const after = fixture.controller.get(runId);
    assert.equal(after?.stage, "discover");
    assert.equal(after?.agents.length, initialAgents.length);
    assert.deepEqual(
      after?.agents.map(({ id, status }) => ({ id, status })),
      initialAgents.map(({ id }) => ({ id, status: "cancelled" as const })),
    );
    assert.equal(fixture.sessions.length, initialAgents.length);
    assert.equal(
      fixture.sessions.filter((session) => session.interrupted > 0).length,
      6,
    );
    assert.equal(
      fixture.sessions.every((session) => session.interrupted <= 1),
      true,
    );
    assert.equal(fixture.handoffs.length, 1);
    assert.equal(fixture.handoffs[0]?.status, "cancelled");
  } finally {
    await fixture.controller.dispose();
    fs.rmSync(fixture.artifactRoot, { recursive: true, force: true });
  }
});

test("an unbounded child wait settles when its configured stage deadline expires", async () => {
  const fixture = harness();
  try {
    const { runId, childId, initialAgents } = await startPendingPlan(fixture);
    let settled = false;
    const waiting = fixture.controller
      .waitForChildren(runId, [childId])
      .then((children) => {
        settled = true;
        return children;
      });
    await flush();
    assert.equal(settled, false);

    fixture.clock.value = 30_000;
    fixture.scheduler.fire(30_000);
    const children = await settlePromptly(waiting);
    await waitForHandoff(fixture);

    assert.equal(children[0]?.id, childId);
    assert.equal(children[0]?.status, "cancelled");
    const limited = fixture.controller.get(runId);
    assert.equal(limited?.status, "limited");
    assert.equal(limited?.stage, "discover");
    assert.equal(limited?.limitation?.reason, "stage-deadline");
    assert.equal(limited?.limitation?.elapsedMs, 30_000);
    assert.equal(limited?.agents.length, initialAgents.length);
    assert.deepEqual(
      limited?.agents.map(({ id, status }) => ({ id, status })),
      initialAgents.map(({ id }) => ({ id, status: "cancelled" as const })),
    );
    assert.equal(fixture.sessions.length, initialAgents.length);
    assert.equal(
      fixture.sessions.filter((session) => session.interrupted > 0).length,
      6,
    );
    assert.equal(
      fixture.sessions.every((session) => session.interrupted <= 1),
      true,
    );
    assert.equal(fixture.handoffs.length, 1);
    assert.equal(fixture.handoffs[0]?.status, "limited");
  } finally {
    await fixture.controller.dispose();
    fs.rmSync(fixture.artifactRoot, { recursive: true, force: true });
  }
});
