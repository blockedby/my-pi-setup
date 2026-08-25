import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import { PipelineController } from "./controller.ts";
import { buildPipelineRows, cancelPipelineRow } from "./dashboard.ts";
import {
  LUNA_MODEL,
  PIPELINE_CHILD_ROLES,
  SOL_MODEL,
  TERRA_MODEL,
  type PipelineChildRole,
  type PipelineHandoff,
} from "./domain.ts";

class FakePipelineSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  readonly sessionFile: string;
  isStreaming = false;
  interrupted = 0;
  disposed = 0;

  readonly activeTools: ReadonlyArray<string>;
  readonly spec: AgentNodeSpec;

  constructor(activeTools: ReadonlyArray<string>, spec: AgentNodeSpec) {
    this.activeTools = activeTools;
    this.spec = spec;
    this.sessionFile = `/tmp/${spec.scopeId}-${spec.role}-${spec.attempt}.jsonl`;
  }

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentTreeSessionEvent) {
    if (event.type === "run_started") this.isStreaming = true;
    if (event.type === "settled") this.isStreaming = false;
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string) {
    this.prompts.push(text);
    this.isStreaming = true;
  }

  async send(text: string) {
    this.sends.push(text);
    this.emit({ type: "run_started" });
    this.emit({ type: "user", text });
  }

  async interrupt() {
    this.interrupted++;
    this.emit({ type: "settled", outcome: { type: "cancelled" } });
  }

  dispose() {
    this.disposed++;
  }
}

function harness(options: { rootGate?: Promise<void> } = {}) {
  const sessions: FakePipelineSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  let agentSequence = 0;
  let runSequence = 0;
  let rootToolNames: string[] = [];
  const controller = new PipelineController({
    makeRunId: () => `run-${++runSequence}`,
    makeAgentId: () => `node-${++agentSequence}`,
    createSessionFactory: (
      rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
    ) => ({
      async create(spec) {
        if (!spec.parentId && options.rootGate) await options.rootGate;
        const orchestration = !spec.parentId
          ? rootTools(spec.scopeId ?? "").map((tool) => tool.name)
          : [];
        if (!spec.parentId) rootToolNames = orchestration;
        const session = new FakePipelineSession(
          ["read", "bash", "edit", "write", ...orchestration],
          spec,
        );
        sessions.push(session);
        return session;
      },
    }),
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
  });
  return {
    controller,
    sessions,
    handoffs,
    get rootToolNames() {
      return rootToolNames;
    },
  };
}

const request = (workingDir = "/tmp/work") => ({
  task: "Implement the approved feature",
  workingDir,
});

async function settleInitialization() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("start is fire-and-forget and multiple same-cwd runs are admitted", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const gated = harness({ rootGate });
  const firstId = gated.controller.start(request());
  const secondId = gated.controller.start(request());

  assert.equal(firstId, "run-1");
  assert.equal(secondId, "run-2");
  assert.equal(gated.controller.get(firstId)?.status, "starting");
  assert.equal(gated.controller.get(secondId)?.workingDir, "/tmp/work");
  releaseRoot();
  await settleInitialization();
  assert.equal(gated.controller.get(firstId)?.status, "running");
  assert.equal(gated.controller.get(secondId)?.status, "running");
  assert.equal(gated.sessions.length, 2);

  await gated.controller.dispose();
});

test("dashboard cancellation of a starting run prevents its root prompt", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const runId = run.controller.start(request());
  const runRow = buildPipelineRows([run.controller.get(runId)!]).find(
    (row) => row.kind === "run" && row.runId === runId,
  );
  assert.ok(runRow);

  await cancelPipelineRow(run.controller, runRow);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);

  releaseRoot();
  await settleInitialization();

  assert.equal(run.sessions.length, 1);
  assert.equal(run.sessions[0]?.prompts.length, 0);
  assert.equal(run.sessions[0]?.disposed, 1);
  assert.equal(run.controller.get(runId)?.rootId, "node-1");
  assert.equal(run.controller.get(runId)?.agents[0]?.status, "cancelled");
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some(
        (agent) => agent.status === "starting" || agent.status === "running",
      ),
    false,
  );
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});

test("root tools are run-scoped and children have coding tools without orchestration", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.agents.length, 1);
  assert.deepEqual(run.rootToolNames, [
    "pipeline_stage",
    "pipeline_child_spawn",
    "pipeline_child_list",
    "pipeline_child_check",
    "pipeline_child_wait",
    "pipeline_child_send",
    "pipeline_child_cancel",
    "pipeline_complete",
  ]);
  const child = await run.controller.spawnChild(runId, "discover-problem");
  const childSession = run.sessions.find(
    (session) => session.spec.role === child.role,
  );
  assert.deepEqual(childSession?.activeTools, [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  for (const forbidden of [
    "pipeline_run",
    "pipeline_child_spawn",
    "workflow",
    "subagent_spawn",
  ]) {
    assert.equal(childSession?.activeTools.includes(forbidden), false);
  }

  await run.controller.dispose();
});

test("roles select fixed models, remain direct root children, and record attempts", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);

  const first = await run.controller.spawnChild(runId, "discover-problem");
  const retry = await run.controller.spawnChild(runId, "discover-problem");
  const terra = await run.controller.spawnChild(runId, "final-audit");
  assert.equal(first.model, LUNA_MODEL);
  assert.equal(retry.model, LUNA_MODEL);
  assert.equal(terra.model, TERRA_MODEL);
  assert.equal(first.parentId, rootId);
  assert.equal(retry.parentId, rootId);
  assert.equal(terra.parentId, rootId);
  assert.equal(first.attempt, 1);
  assert.equal(retry.attempt, 2);
  assert.equal(terra.attempt, 1);
  assert.equal(run.controller.get(runId)?.agents[0]?.model, SOL_MODEL);
  await assert.rejects(
    run.controller.spawnChild(runId, "not-a-role" as PipelineChildRole),
    /Unsupported feature-pipeline child role/,
  );

  await run.controller.dispose();
});

test("children run in parallel and wait returns reports in caller order", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const roles = PIPELINE_CHILD_ROLES.slice(0, 5);
  const children = await Promise.all(
    roles.map((role) => run.controller.spawnChild(runId, role)),
  );
  assert.equal(
    children.every((child) => child.status === "running"),
    true,
  );

  const wait = run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );
  for (const [index, child] of children.entries()) {
    const session = run.sessions.find(
      (candidate) => candidate.spec.role === child.role,
    );
    session?.emit({
      type: "settled",
      outcome: { type: "completed", finalText: `report-${index}` },
    });
  }
  const reports = await wait;
  assert.deepEqual(
    reports.map((child) => child.finalText),
    ["report-0", "report-1", "report-2", "report-3", "report-4"],
  );

  await run.controller.dispose();
});

test("a settled child can be retried in its existing session", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const child = await run.controller.spawnChild(runId, "discover-problem");
  const childSession = run.sessions.find(
    (session) => session.spec.role === child.role,
  );
  assert.ok(childSession);
  childSession.emit({
    type: "settled",
    outcome: { type: "failed", error: "transient provider failure" },
  });

  await run.controller.sendChild(
    runId,
    child.id,
    "Retry the same report once.",
  );

  assert.deepEqual(childSession.sends, ["Retry the same report once."]);
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.filter((agent) => agent.role === "discover-problem").length,
    1,
  );
  assert.equal(run.controller.getAgent(runId, child.id).status, "running");
  await run.controller.dispose();
});

test("persistent Sol session survives idle remediation turns", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions[0]!;
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "implementation turn" },
  });
  assert.equal(run.controller.agentView.get(rootId)?.status, "idle");

  run.controller.agentView.requestSend(rootId, "Resolve the audit reports");
  await settleInitialization();
  assert.deepEqual(rootSession.sends, ["Resolve the audit reports"]);
  assert.equal(
    run.sessions.filter((session) => !session.spec.parentId).length,
    1,
  );
  assert.equal(run.controller.agentView.get(rootId)?.status, "running");

  await run.controller.dispose();
});

test("completion is rejected while a child is still active", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  await run.controller.spawnChild(runId, "audit-feature-outcome");
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: [],
    checks: [],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };

  assert.throws(
    () => run.controller.complete(runId, facts),
    /while children are active/,
  );
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.handoffs.length, 0);
  await run.controller.dispose();
});

test("dashboard cancellation of an idle root cancels the run and active children", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions[0]!;
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "waiting for next stage" },
  });
  assert.equal(run.controller.agentView.get(rootId)?.status, "idle");
  const child = await run.controller.spawnChild(
    runId,
    "audit-reliability-regressions",
  );
  const rootRow = buildPipelineRows([run.controller.get(runId)!]).find(
    (row) => row.kind === "agent" && row.agentId === rootId,
  );
  assert.ok(rootRow);

  await cancelPipelineRow(run.controller, rootRow);

  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.controller.getAgent(runId, rootId).status, "cancelled");
  assert.equal(run.controller.getAgent(runId, child.id).status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  assert.equal(run.handoffs[0]?.status, "cancelled");
  await run.controller.dispose();
});

test("structured completion delivers one factual handoff without readiness status", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: ["src/feature.ts"],
    checks: ["npm test passed"],
    assumptions: ["Existing authenticated users are the target audience"],
    git: ["working tree has one modified file"],
    reports: ["discover-problem: user need verified"],
    unresolvedItems: ["manual browser check pending"],
    workingDir: "/tmp/work",
  };
  assert.throws(
    () => run.controller.complete(runId, { ...facts, workingDir: "/other" }),
    /working_dir must be/,
  );
  run.controller.complete(runId, facts);
  await settleInitialization();

  assert.equal(run.handoffs.length, 1);
  assert.deepEqual(run.handoffs[0], {
    runId,
    definition: "feature-pipeline",
    status: "completed",
    facts,
  });
  assert.equal("readiness" in run.handoffs[0]!, false);
  assert.equal(run.controller.get(runId)?.status, "completed");
  await assert.rejects(
    Promise.resolve().then(() =>
      run.controller.complete(runId, { ...facts, workingDir: "/other" }),
    ),
    /is completed/,
  );

  await run.controller.dispose();
});

test("unknown IDs fail closed and cancellation/disposal stop active sessions", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const child = await run.controller.spawnChild(
    runId,
    "audit-logic-invariants",
  );
  await assert.rejects(
    run.controller.waitForChildren(runId, ["unknown"]),
    /Unknown agent id/,
  );
  await assert.rejects(
    run.controller.cancelChild(runId, "unknown"),
    /Unknown agent id/,
  );

  await run.controller.cancelChild(runId, child.id);
  assert.equal(run.controller.getAgent(runId, child.id).status, "cancelled");
  await run.controller.cancelRun(runId);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
  assert.equal(
    run.sessions.every((session) => session.disposed === 1),
    true,
  );
});

test("normal Sol capacity admission limits concurrent roots", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const ids = Array.from({ length: 5 }, () => run.controller.start(request()));
  await settleInitialization();
  assert.equal(run.controller.get(ids[4]!)?.status, "failed");
  assert.match(run.controller.get(ids[4]!)?.error ?? "", /Capacity.*max 4/);
  releaseRoot();
  await settleInitialization();
  assert.equal(
    ids.slice(0, 4).every((id) => run.controller.get(id)?.status === "running"),
    true,
  );

  await run.controller.dispose();
});
