import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import { PipelineController } from "./controller.ts";
import { inspectPipeline, PIPELINE_CHECK_MAX_BYTES } from "./inspection.ts";
import { pipelineSessionToolPolicy, pipelineThinkingLevel } from "./session.ts";
import { buildPipelineRows, cancelPipelineRow } from "./dashboard.ts";
import {
  PIPELINE_4_LUNA_AUDIT_ROLES,
  FINAL_AUDIT_ROLE,
  LUNA_MODEL,
  PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_AUDIT_ROLES,
  PLAN_PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  SOL_MODEL,
  TERRA_MODEL,
  childContextPolicyFor,
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
  readonly autoReport?: string;

  constructor(
    activeTools: ReadonlyArray<string>,
    spec: AgentNodeSpec,
    autoReport?: string,
  ) {
    this.activeTools = activeTools;
    this.spec = spec;
    this.autoReport = autoReport;
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
    if (this.autoReport) {
      queueMicrotask(() =>
        this.emit({
          type: "settled",
          outcome: { type: "completed", finalText: this.autoReport! },
        }),
      );
    }
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

function harness(
  options: {
    rootGate?: Promise<void>;
    autoCompleteFeatureDiscovery?: boolean;
  } = {},
) {
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
      definitionForRun,
    ) => ({
      async create(spec) {
        if (!spec.parentId && options.rootGate) await options.rootGate;
        const orchestration = !spec.parentId
          ? rootTools(spec.scopeId ?? "").map((tool) => tool.name)
          : [];
        if (!spec.parentId) rootToolNames = orchestration;
        const autoReport =
          options.autoCompleteFeatureDiscovery !== false &&
          spec.parentId &&
          definitionForRun(spec.scopeId ?? "") === "feature-pipeline" &&
          spec.role.startsWith("discover-")
            ? reportForRole(spec.role)
            : undefined;
        const session = new FakePipelineSession(
          ["read", "bash", "edit", "write", ...orchestration],
          spec,
          autoReport,
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

test("git_commit rejects every pipeline except small-feature-pipeline", () => {
  const { controller } = harness();
  for (const pipeline of [
    "feature-pipeline",
    "plan-pipeline",
    "audit-pipeline",
  ] as const) {
    assert.throws(
      () => controller.start({ ...request(), pipeline, gitCommit: true }),
      new RegExp(
        `git_commit is only supported for small-feature-pipeline.*${pipeline}`,
      ),
    );
  }
});

async function settleInitialization() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function reportForRole(role: string) {
  if (role === "implement-small-feature") {
    return JSON.stringify({
      summary: "Implemented and verified the bounded feature",
      changedPaths: ["src/feature.ts"],
      checks: ["focused tests passed"],
      assumptions: [],
      unresolvedItems: [],
    });
  }
  if (role.startsWith("discover-")) {
    return JSON.stringify({
      summary: role,
      evidence: ["repository evidence"],
      unknowns: [],
      constraints: [],
    });
  }
  if (role === "final-audit") {
    return JSON.stringify({
      mode: "initial",
      base_sha: "1234567",
      head_sha: "WORKTREE",
      verdict: "READY",
      findings: [],
      summary: "No actionable findings",
    });
  }
  return JSON.stringify({ track: role, findings: [], unprovenChecks: [] });
}

function settleRole(run: ReturnType<typeof harness>, role: string) {
  const session = run.sessions.find(
    (candidate) => candidate.spec.role === role,
  );
  assert.ok(session);
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: reportForRole(role) },
  });
}

function synthesisReport(
  reportType: "audit-synthesis-intermediate" | "audit-synthesis-final",
  integratedRoles: ReadonlyArray<string>,
) {
  if (reportType === "audit-synthesis-intermediate") {
    return JSON.stringify({
      reportType,
      integratedRoles,
      rootCauseCandidates: [],
      unresolvedConflicts: [],
      unprovenChecks: [],
      summary: "Incremental synthesis retained validated evidence",
    });
  }
  return JSON.stringify({
    reportType,
    mode: "initial",
    baseSha: "UNAVAILABLE",
    headSha: "UNAVAILABLE",
    integratedRoles,
    findings: [],
    closureResults: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    summary: "No supported findings",
  });
}

async function finishEmbeddedAudit(
  run: ReturnType<typeof harness>,
  runId: string,
) {
  run.controller.setStage(runId, "final-audit");
  const agents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "The approved feature contract",
    assumptions: [],
    checks: ["focused checks passed"],
  });
  const firstRole = PIPELINE_4_LUNA_AUDIT_ROLES[0];
  const first =
    run.sessions.find(
      (session) => session.spec.role === firstRole && session.spec.attempt > 1,
    ) ?? run.sessions.find((session) => session.spec.role === firstRole);
  assert.ok(first);
  first.emit({
    type: "settled",
    outcome: { type: "completed", finalText: reportForRole(firstRole) },
  });
  await settleInitialization();
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES.slice(1)) {
    const session = [...run.sessions]
      .reverse()
      .find((candidate) => candidate.spec.role === role);
    assert.ok(session);
    session.emit({
      type: "settled",
      outcome: { type: "completed", finalText: reportForRole(role) },
    });
  }
  const synthesizer = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesizer);
  synthesizer.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport("audit-synthesis-intermediate", [firstRole]),
    },
  });
  await settleInitialization();
  synthesizer.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport(
        "audit-synthesis-final",
        PIPELINE_4_LUNA_AUDIT_ROLES,
      ),
    },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.equal(agents.length, 5);
}

async function advancePlanToComplete(
  run: ReturnType<typeof harness>,
  runId: string,
  planPath: string,
) {
  await Promise.all(
    PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_DISCOVERY_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "build");
  run.controller.writePlan(runId, planPath, validPlan());
  run.controller.setStage(runId, "audit");
  await Promise.all(
    PLAN_PIPELINE_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_AUDIT_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "audit-resolve");
  await finishEmbeddedAudit(run, runId);
  run.controller.setStage(runId, "complete");
}

function validPlan() {
  return `# Implementation plan

## Goal and non-goals
Goal; non-goal.

## Evidence and assumptions
Evidence; assumption.

## Candidate acceptance criteria
- AC1

## Frontend tasks
Not applicable.

## Backend tasks
Not applicable.

## DevOps tasks
Not applicable.

## Cross-cutting tasks
### TASK-001: Update the package
- **Scope:** Make the bounded change.
- **Likely paths/components:** src/example.ts
- **Dependencies:** None.
- **Acceptance/verification evidence:** Focused test passes.

## Test plan
- Unit checks apply.
- Integration checks are not applicable.
- Contract checks are not applicable.
- E2E checks are not applicable.
- Operational checks are not applicable.

## Implementation waves
- Wave 1: TASK-001

## Risks, rollout, and rollback
Low risk; revert TASK-001 if needed.

## Unresolved questions
None.
`;
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
  assert.equal(gated.sessions.length, 12);
  assert.equal(
    gated.sessions
      .filter((session) => session.spec.role === "pipeline-root")
      .every(
        (session) => session.prompts.length === 0 && session.sends.length === 1,
      ),
    true,
  );

  await gated.controller.dispose();
});

test("feature discovery runs programmatically before the deferred Sol prompt", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  const before = run.controller.get(runId);
  const root = run.sessions.find(
    (session) => session.spec.role === "pipeline-root",
  );
  assert.equal(before?.status, "running");
  assert.equal(before?.stage, "discover");
  assert.equal(before?.agents[0]?.status, "idle");
  assert.deepEqual(root?.prompts, []);
  assert.deepEqual(root?.sends, []);
  assert.deepEqual(
    before?.agents.slice(1).map((agent) => agent.role),
    [
      "discover-problem",
      "discover-outcome",
      "discover-context",
      "discover-user-scenarios",
      "discover-product-precedents",
    ],
  );

  for (const role of [
    "discover-problem",
    "discover-outcome",
    "discover-context",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  await settleInitialization();

  const started = run.controller.get(runId);
  assert.equal(started?.stage, "build");
  assert.equal(started?.agents[0]?.status, "running");
  assert.deepEqual(root?.prompts, []);
  assert.equal(root?.sends.length, 1);
  assert.match(root?.sends[0] ?? "", /host completed the Discover stage/);
  assert.match(root?.sends[0] ?? "", /discover-product-precedents/);
  assert.match(root?.sends[0] ?? "", /repository evidence/);
  assert.throws(
    () => run.controller.setStage(runId, "discover"),
    /cannot return to controller-owned discovery after bootstrap/,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "discover-problem"),
    /controller-owned and unavailable to feature-pipeline Sol/,
  );
  const discovery = started?.agents.find(
    (agent) => agent.role === "discover-problem",
  );
  assert.ok(discovery);
  await assert.rejects(
    run.controller.sendChild(runId, discovery.id, "Retry discovery"),
    /controller-owned and unavailable to Sol/,
  );

  await run.controller.dispose();
});

test("programmatic feature discovery retries one malformed report in the same session", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of [
    "discover-outcome",
    "discover-context",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.ok(problem);
  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not-json" },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(problem.sends.length, 1);
  assert.match(problem.sends[0] ?? "", /Retry this same role once/);
  problem.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: reportForRole("discover-problem"),
    },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(
    run.sessions.find((session) => session.spec.role === "pipeline-root")?.sends
      .length,
    1,
  );
  await run.controller.dispose();
});

test("programmatic feature discovery fails closed after its one retry", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of [
    "discover-outcome",
    "discover-context",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.ok(problem);
  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not-json" },
  });
  await settleInitialization();
  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "still-not-json" },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.match(
    run.controller.get(runId)?.error ?? "",
    /no valid discover-problem report/,
  );
  assert.equal(
    run.sessions.find((session) => session.spec.role === "pipeline-root")?.sends
      .length,
    0,
  );
  await run.controller.dispose();
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

  assert.equal(run.controller.get(runId)?.agents.length, 6);
  assert.deepEqual(run.rootToolNames, [
    "pipeline_stage",
    "pipeline_child_spawn",
    "pipeline_child_list",
    "pipeline_child_check",
    "pipeline_child_wait",
    "pipeline_child_send",
    "pipeline_child_cancel",
    "pipeline_audit_start",
    "pipeline_complete",
  ]);
  const childSession = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.deepEqual(childSession?.activeTools, [
    "read",
    "bash",
    "edit",
    "write",
  ]);
  for (const forbidden of [
    "pipeline_run",
    "pipeline_check",
    "pipeline_list",
    "pipeline_child_spawn",
    "workflow",
    "subagent_spawn",
  ]) {
    assert.equal(childSession?.activeTools.includes(forbidden), false);
  }

  await run.controller.dispose();
});

test("definition role policies centralize child context requirements", () => {
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    assert.deepEqual(childContextPolicyFor("feature-pipeline", role), {
      gitEvidence: true,
    });
    assert.deepEqual(childContextPolicyFor("audit-pipeline", role), {
      gitEvidence: true,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", FINAL_AUDIT_ROLE),
    {},
  );
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    assert.deepEqual(childContextPolicyFor("small-feature-pipeline", role), {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", "discover-problem"),
    {},
  );
  assert.deepEqual(
    childContextPolicyFor("plan-pipeline", "audit-decomposition-dag"),
    {},
  );
});

test("small-feature Luna root and audit Lunas are read-only while the implementer keeps coding tools", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("small-feature-pipeline", true, "pipeline-root")
      .excludeTools,
  );
  const implementerDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "small-feature-pipeline",
      false,
      "implement-small-feature",
    ).excludeTools,
  );
  const auditorDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "small-feature-pipeline",
      false,
      PIPELINE_4_LUNA_AUDIT_ROLES[0],
    ).excludeTools,
  );
  for (const workspaceMutator of ["bash", "edit", "write"]) {
    assert.equal(rootDenied.has(workspaceMutator), true);
    assert.equal(auditorDenied.has(workspaceMutator), true);
    assert.equal(implementerDenied.has(workspaceMutator), false);
  }
  for (const delegatedOrExternalMutator of [
    "apply_patch_codex",
    "bg_start",
    "bg_kill",
    "codex_task",
    "mcp",
  ]) {
    assert.equal(rootDenied.has(delegatedOrExternalMutator), true);
    assert.equal(auditorDenied.has(delegatedOrExternalMutator), true);
    assert.equal(implementerDenied.has(delegatedOrExternalMutator), true);
  }
  assert.equal(rootDenied.has("pipeline_child_spawn"), false);
  assert.equal(implementerDenied.has("pipeline_child_spawn"), true);
  assert.equal(auditorDenied.has("pipeline_child_spawn"), true);
  for (const mainOnlyTool of ["pipeline_check", "pipeline_list"]) {
    assert.equal(rootDenied.has(mainOnlyTool), true);
    assert.equal(implementerDenied.has(mainOnlyTool), true);
    assert.equal(auditorDenied.has(mainOnlyTool), true);
  }
});

test("roles select fixed models, remain direct root children, and record attempts", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);

  run.controller.setStage(runId, "audit");
  const first = await run.controller.spawnChild(runId, "audit-feature-outcome");
  const retry = await run.controller.spawnChild(runId, "audit-feature-outcome");
  run.controller.setStage(runId, "final-audit");
  const finalAgents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved contract",
    assumptions: [],
    checks: [],
  });
  assert.equal(first.model, LUNA_MODEL);
  assert.equal(retry.model, LUNA_MODEL);
  assert.equal(
    finalAgents.every((agent) => agent.model === LUNA_MODEL),
    true,
  );
  assert.equal(first.parentId, rootId);
  assert.equal(retry.parentId, rootId);
  assert.equal(
    finalAgents.every((agent) => agent.parentId === rootId),
    true,
  );
  assert.equal(first.attempt, 1);
  assert.equal(retry.attempt, 2);
  assert.equal(run.controller.get(runId)?.agents[0]?.model, SOL_MODEL);
  assert.equal(pipelineThinkingLevel(SOL_MODEL), "high");
  assert.equal(pipelineThinkingLevel(TERRA_MODEL), "high");
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some((agent) => agent.model === TERRA_MODEL),
    false,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "not-a-role" as PipelineChildRole),
    /Unsupported feature-pipeline child role/,
  );

  await run.controller.dispose();
});

test("plan-pipeline preserves earlier roles and uses a controller-owned Luna final audit", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-roles-"));
  const run = harness();
  const runId = run.controller.start({
    ...request(workingDir),
    pipeline: "plan-pipeline",
  });
  await settleInitialization();
  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.definition, "plan-pipeline");
  assert.equal(snapshot?.agents[0]?.model, SOL_MODEL);
  assert.equal(snapshot?.agents[0]?.title, "Plan pipeline Sol");
  assert.deepEqual(run.rootToolNames.slice(0, 4), [
    "pipeline_stage",
    "pipeline_plan_write",
    "pipeline_plan_validate",
    "pipeline_git_status",
  ]);

  const discovery = await Promise.all(
    PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_DISCOVERY_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "build");
  run.controller.writePlan(runId, "docs/plans/roles.md", validPlan());
  run.controller.setStage(runId, "audit");
  const audits = await Promise.all(
    PLAN_PIPELINE_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_AUDIT_ROLES.forEach((role) => settleRole(run, role));
  run.controller.setStage(runId, "audit-resolve");
  run.controller.setStage(runId, "final-audit");
  const finalAgents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "validated plan artifact",
    assumptions: [],
    checks: ["plan contract passed"],
  });
  await assert.rejects(
    run.controller.startFinalAudit(runId, {
      acceptanceContract: "duplicate",
      assumptions: [],
      checks: [],
    }),
    /already started its final audit segment/,
  );
  const children = [...discovery, ...audits, ...finalAgents];
  assert.deepEqual(
    children.map((child) => child.role),
    [...PLAN_PIPELINE_CHILD_ROLES],
  );
  assert.equal(
    children.every((child) => child.parentId === snapshot?.rootId),
    true,
  );
  assert.equal(
    children.every((child) => child.model === LUNA_MODEL),
    true,
  );
  assert.equal(
    children.some((child) => child.model === TERRA_MODEL),
    false,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "discover-problem"),
    /Unsupported plan-pipeline child role/,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "final-audit"),
    /Unsupported plan-pipeline child role/,
  );
  assert.throws(
    () => run.controller.setStage(runId, "final-resolve"),
    /validated Luna audit synthesis/,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature-pipeline fans four Luna audits into one same-session remediation", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
  });
  await settleInitialization();

  const initial = run.controller.get(runId);
  assert.equal(initial?.stage, "build");
  assert.equal(initial?.agents[0]?.title, "Small feature pipeline Luna");
  assert.equal(initial?.agents[0]?.model, LUNA_MODEL);
  assert.equal(
    pipelineThinkingLevel(initial?.agents[0]?.model ?? ""),
    "medium",
  );
  assert.deepEqual(SMALL_FEATURE_PIPELINE_CHILD_ROLES, [
    SMALL_FEATURE_IMPLEMENTER_ROLE,
    ...PIPELINE_4_LUNA_AUDIT_ROLES,
  ]);

  const implementer = await run.controller.spawnChild(
    runId,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  assert.equal(implementer.model, LUNA_MODEL);
  assert.equal(implementer.persistent, true);
  await assert.rejects(
    run.controller.spawnChild(runId, SMALL_FEATURE_IMPLEMENTER_ROLE),
    /already has its allowed child session/,
  );
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  assert.equal(run.controller.getAgent(runId, implementer.id).status, "idle");
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");

  const auditors = await Promise.all(
    PIPELINE_4_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  await assert.rejects(
    run.controller.spawnChild(runId, PIPELINE_4_LUNA_AUDIT_ROLES[0]),
    /already has its allowed child session/,
  );
  for (const [index, role] of PIPELINE_4_LUNA_AUDIT_ROLES.entries()) {
    const auditor = auditors[index];
    assert.ok(auditor);
    assert.equal(auditor.model, LUNA_MODEL);
    assert.equal(auditor.persistent, false);
    const auditorSession = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(auditorSession);
    assert.equal(
      auditorSession.prompts[0]?.includes(
        reportForRole(SMALL_FEATURE_IMPLEMENTER_ROLE),
      ),
      true,
    );
  }
  const firstAuditor = auditors[0];
  assert.ok(firstAuditor);
  settleRole(run, PIPELINE_4_LUNA_AUDIT_ROLES[0]);
  await run.controller.waitForChildren(runId, [firstAuditor.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES.slice(1))
    settleRole(run, role);
  await run.controller.waitForChildren(
    runId,
    auditors.slice(1).map((auditor) => auditor.id),
  );
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  await assert.rejects(
    run.controller.sendChild(runId, firstAuditor.id, "Audit again"),
    /cannot be retried or continued/,
  );
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.throws(
    () => run.controller.setStage(runId, "complete"),
    /requires one same-session Luna remediation pass/,
  );

  const remediationMessage = "Resolve all audit reports";
  await run.controller.sendChild(runId, implementer.id, remediationMessage);
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  assert.ok(implementerSession);
  assert.equal(implementerSession.sends.length, 1);
  assert.match(
    implementerSession.sends[0] ?? "",
    /Independent Luna audit reports to resolve/,
  );
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    assert.equal(
      implementerSession.sends[0]?.includes(reportForRole(role)),
      true,
    );
  }
  assert.equal(implementerSession.sends[0]?.includes(remediationMessage), true);
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "complete");
  await assert.rejects(
    run.controller.sendChild(runId, implementer.id, "Fix twice"),
    /only run during final-resolve/,
  );

  const facts = {
    outcome: "Small feature implemented and remediated",
    changedPaths: ["src/feature.ts"],
    checks: ["focused tests passed"],
    assumptions: [],
    git: ["working tree inspected"],
    reports: ["Luna implementation", "Four Luna audits", "Luna remediation"],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };
  run.controller.complete(runId, facts);
  const finalFacts = run.controller.get(runId)?.completion;
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.ok(finalFacts?.git.some((item) => item.startsWith("Final Git HEAD:")));
  assert.ok(
    finalFacts?.git.some((item) =>
      item.includes("Final dirty HEAD..WORKTREE diff"),
    ),
  );
  assert.equal(run.handoffs[0]?.definition, "small-feature-pipeline");
  assert.deepEqual(
    run.controller
      .get(runId)
      ?.agents.filter((agent) => agent.parentId)
      .map((agent) => agent.role),
    [...SMALL_FEATURE_PIPELINE_CHILD_ROLES],
  );

  await run.controller.dispose();
});

test("feature audits and the embedded Luna segment receive captured fresh Git evidence", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-audit-evidence-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.mkdirSync(path.join(workingDir, "src"));
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "before\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();

  const run = harness();
  const runId = run.controller.start(request(workingDir));
  await settleInitialization();
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "after\n");
  run.controller.setStage(runId, "audit");
  await Promise.all(
    PIPELINE_4_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    const lunaAudit = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(lunaAudit);
    assert.equal(lunaAudit.prompts[0]?.includes(baseSha), true);
    assert.equal(lunaAudit.prompts[0]?.includes("-before"), true);
    assert.equal(lunaAudit.prompts[0]?.includes("+after"), true);
    settleRole(run, role);
  }

  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "final\n");
  run.controller.setStage(runId, "final-audit");
  await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved feature contract",
    assumptions: [],
    checks: ["focused tests passed"],
  });
  const finalAudits = PIPELINE_4_LUNA_AUDIT_ROLES.map((role) =>
    [...run.sessions].reverse().find((session) => session.spec.role === role),
  );
  assert.equal(finalAudits.every(Boolean), true);
  for (const lunaAudit of finalAudits) {
    assert.equal(lunaAudit?.prompts[0]?.includes(baseSha), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("-before"), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("+final"), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("+after"), false);
  }
  assert.equal(
    run.sessions.some((session) => session.spec.model === TERRA_MODEL),
    false,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature Luna audits receive the captured base, implementation report, and actual diff", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "small-feature-audit-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.mkdirSync(path.join(workingDir, "src"));
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "before\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();

  const run = harness();
  const runId = run.controller.start({
    ...request(workingDir),
    pipeline: "small-feature-pipeline",
  });
  await settleInitialization();
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "committed\n");
  execFileSync("git", ["add", "src/feature.ts"], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "implementation commit"], {
    cwd: workingDir,
  });
  fs.writeFileSync(
    path.join(workingDir, "src", "feature.ts"),
    `after\n${"x".repeat(300 * 1024)}`,
  );
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  settleRole(run, "implement-small-feature");
  await run.controller.waitForChildren(runId, [implementer.id]);
  await Promise.all(
    PIPELINE_4_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );

  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    const auditorSession = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(auditorSession);
    assert.equal(auditorSession.prompts[0]?.includes(baseSha), true);
    assert.equal(
      auditorSession.prompts[0]?.includes("implementation commit"),
      true,
    );
    assert.equal(auditorSession.prompts[0]?.includes("-before"), true);
    assert.equal(auditorSession.prompts[0]?.includes("+committed"), true);
    assert.equal(auditorSession.prompts[0]?.includes("-committed"), true);
    assert.equal(auditorSession.prompts[0]?.includes("+after"), true);
    assert.equal(
      auditorSession.prompts[0]?.includes('"baseIsAncestor": "yes"'),
      true,
    );
    assert.equal(
      auditorSession.prompts[0]?.includes('"state": "truncated"'),
      true,
    );
    assert.equal(
      auditorSession.prompts[0]?.includes(
        reportForRole(SMALL_FEATURE_IMPLEMENTER_ROLE),
      ),
      true,
    );
  }

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature-pipeline fails closed on a malformed implementation report", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
  });
  await settleInitialization();
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === "implement-small-feature",
  );
  assert.ok(implementerSession);
  implementerSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not structured JSON" },
  });

  await run.controller.waitForChildren(runId, [implementer.id]);

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(run.handoffs[0]?.status, "failed");
  assert.match(run.handoffs[0]?.error ?? "", /valid report/);
  assert.equal(
    run.controller.getAgent(runId, run.controller.get(runId)?.rootId ?? "")
      .status,
    "cancelled",
  );
  await run.controller.dispose();
});

test("small-feature-pipeline fails closed on a malformed Luna audit report", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
  });
  await settleInitialization();
  const implementer = await run.controller.spawnChild(
    runId,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  await run.controller.waitForChildren(runId, [implementer.id]);

  const auditRole = PIPELINE_4_LUNA_AUDIT_ROLES[0];
  const auditor = await run.controller.spawnChild(runId, auditRole);
  const auditorSession = run.sessions.find(
    (session) => session.spec.role === auditRole,
  );
  assert.ok(auditorSession);
  auditorSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not structured JSON" },
  });

  await run.controller.waitForChildren(runId, [auditor.id]);

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.controller.get(runId)?.stage, "final-audit");
  assert.equal(run.handoffs[0]?.status, "failed");
  assert.match(run.handoffs[0]?.error ?? "", /valid report/);
  await run.controller.dispose();
});

test("children run in parallel and wait returns reports in caller order", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "plan-pipeline",
  });
  await settleInitialization();
  const roles = PLAN_PIPELINE_DISCOVERY_ROLES;
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
  for (const child of children) {
    const session = run.sessions.find(
      (candidate) => candidate.spec.role === child.role,
    );
    session?.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: reportForRole(child.role),
      },
    });
  }
  const reports = await wait;
  assert.deepEqual(
    reports.map((child) => child.role),
    [...roles],
  );
  assert.equal(run.controller.get(runId)?.stage, "build");

  await run.controller.dispose();
});

test("successful audit fan-in atomically enters audit-resolve", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const auditRoles = PIPELINE_4_LUNA_AUDIT_ROLES;
  const children = await Promise.all(
    auditRoles.map((role) => run.controller.spawnChild(runId, role)),
  );
  auditRoles.forEach((role) => settleRole(run, role));

  await run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.stage, "audit-resolve");
  const rows = buildPipelineRows(
    snapshot ? [snapshot] : [],
    new Set(snapshot ? [snapshot.id] : []),
  );
  assert.equal(
    rows.find((row) => row.kind === "stage" && row.stage === "audit-resolve")
      ?.label,
    "audit-resolve · running",
  );

  await finishEmbeddedAudit(run, runId);

  await run.controller.dispose();
});

test("embedded roots cannot cancel a busy controller-owned audit synthesizer", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "final-audit");
  const agents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved contract",
    assumptions: [],
    checks: [],
  });
  const firstRole = PIPELINE_4_LUNA_AUDIT_ROLES[0];
  settleRole(run, firstRole);
  await settleInitialization();
  const synthesizer = agents.find((agent) => agent.role === "audit-synthesis");
  assert.ok(synthesizer);
  const synthesisSession = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesisSession);
  assert.equal(synthesisSession.sends.length, 1);

  settleRole(run, PIPELINE_4_LUNA_AUDIT_ROLES[1]);
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.auditSegment?.pendingReportCount, 1);
  await assert.rejects(
    run.controller.cancelChild(runId, synthesizer.id),
    /only be cancelled with the whole pipeline run/,
  );
  assert.equal(synthesisSession.interrupted, 0);
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.controller.get(runId)?.auditSegment?.reducerStatus, "busy");

  await run.controller.cancelRun(runId);
  assert.equal(synthesisSession.interrupted, 1);
  await run.controller.dispose();
});

test("fan-in does not advance when a required plan report is invalid", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "plan-pipeline",
  });
  await settleInitialization();
  const children = await Promise.all(
    PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  PLAN_PIPELINE_DISCOVERY_ROLES.slice(0, -1).forEach((role) =>
    settleRole(run, role),
  );
  const invalidRole = PLAN_PIPELINE_DISCOVERY_ROLES.at(-1);
  const invalidSession = run.sessions.find(
    (session) => session.spec.role === invalidRole,
  );
  assert.ok(invalidSession);
  invalidSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not valid report JSON" },
  });

  await run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );

  assert.equal(run.controller.get(runId)?.stage, "discover");
  await run.controller.dispose();
});

test("a settled child can be retried in its existing session", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-logic-invariants",
  );
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
      ?.agents.filter((agent) => agent.role === "audit-logic-invariants")
      .length,
    1,
  );
  assert.equal(run.controller.getAgent(runId, child.id).status, "running");
  await run.controller.dispose();
});

test("plan-pipeline enforces stage order and one Luna retry", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "plan-pipeline",
  });
  await settleInitialization();
  await assert.rejects(
    run.controller.spawnChild(runId, "audit-decomposition-dag"),
    /can only start during plan-pipeline stage audit/,
  );
  const child = await run.controller.spawnChild(
    runId,
    "discover-goal-outcomes",
  );
  const session = run.sessions.find(
    (candidate) => candidate.spec.role === child.role,
  );
  assert.ok(session);
  session.emit({
    type: "settled",
    outcome: { type: "failed", error: "transient failure" },
  });
  await run.controller.sendChild(runId, child.id, "Retry once.");
  await assert.rejects(
    run.controller.sendChild(runId, child.id, "Retry twice."),
    /already used its retry/,
  );
  assert.throws(
    () => run.controller.setStage(runId, "audit"),
    /Invalid plan-pipeline stage transition/,
  );
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
  assert.equal(rootSession.sends.length, 2);
  assert.equal(rootSession.sends.at(-1), "Resolve the audit reports");
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
  run.controller.setStage(runId, "audit");
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
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-reliability-regressions",
  );
  const rootRow = buildPipelineRows(
    [run.controller.get(runId)!],
    new Set([runId]),
  ).find((row) => row.kind === "agent" && row.agentId === rootId);
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
  await finishEmbeddedAudit(run, runId);
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

test("plan completion requires and validates a repository-local plan artifact", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-pipeline-"));
  const run = harness();
  const runId = run.controller.start({
    task: "Plan the approved goal",
    workingDir,
    pipeline: "plan-pipeline",
  });
  await settleInitialization();
  await advancePlanToComplete(run, runId, "docs/plans/example.md");
  const facts = {
    outcome: "Implementation plan written and audited",
    changedPaths: [],
    checks: ["plan contract passed"],
    assumptions: ["No UI layer exists"],
    git: ["working tree contains the plan artifact"],
    reports: ["five discovery and five audit reports summarized"],
    unresolvedItems: ["Owner assignment remains open"],
    workingDir,
  };

  assert.throws(
    () => run.controller.complete(runId, facts),
    /requires plan_path/,
  );
  const artifactPath = path.join(workingDir, "docs", "plans", "example.md");
  const replacementPath = path.join(
    workingDir,
    "docs",
    "plans",
    "replacement.md",
  );
  fs.writeFileSync(
    replacementPath,
    validPlan().replace("# Implementation plan", "# Replacement plan"),
  );
  fs.renameSync(replacementPath, artifactPath);
  assert.throws(
    () =>
      run.controller.complete(runId, {
        ...facts,
        planPath: "docs/plans/example.md",
      }),
    /changed after this plan-pipeline run wrote it/,
  );
  run.controller.writePlan(runId, "docs/plans/example.md", validPlan());
  run.controller.complete(runId, {
    ...facts,
    planPath: "docs/plans/example.md",
  });
  assert.equal(run.handoffs[0]?.definition, "plan-pipeline");
  assert.equal(run.handoffs[0]?.facts.planPath, "docs/plans/example.md");
  assert.deepEqual(run.handoffs[0]?.facts.changedPaths, [
    "docs/plans/example.md",
  ]);

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("pipeline inspection does not mutate lifecycle state or consume the automatic handoff", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: ["src/feature.ts"],
    checks: ["focused test passed"],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };
  await finishEmbeddedAudit(run, runId);
  run.controller.complete(runId, facts);
  await settleInitialization();
  const before = structuredClone(run.controller.get(runId));
  assert.equal(run.handoffs.length, 1);

  const inspected = inspectPipeline(run.controller, runId, 123_456);

  assert.equal(inspected.details.pipeline.id, runId);
  assert.deepEqual(run.controller.get(runId), before);
  assert.equal(run.handoffs.length, 1);
  assert.deepEqual(run.handoffs[0]?.facts, facts);
  await run.controller.dispose();
});

test("pipeline inspection compactly represents every controller-reachable settled attempt", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();

  run.controller.setStage(runId, "audit");
  for (let attempt = 1; attempt <= 300; attempt++) {
    await run.controller.spawnChild(runId, "audit-feature-outcome");
    const session = run.sessions.at(-1);
    assert.ok(session);
    session.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: reportForRole("audit-feature-outcome"),
      },
    });
  }

  const inspected = inspectPipeline(run.controller, runId, 123_456);
  const text = inspected.content[0]?.text ?? "";
  assert.equal(inspected.details.pipeline.agents.length, 306);
  assert.equal(inspected.details.pipeline.agents[0]?.id, "node-1");
  assert.equal(inspected.details.pipeline.agents.at(-1)?.id, "node-306");
  assert.ok(Buffer.byteLength(text, "utf8") <= PIPELINE_CHECK_MAX_BYTES);
  assert.match(
    text,
    /audit-feature-outcome · attempts 1–300 .* · done · 300 agents/,
  );
  assert.match(text, /- node-1 · pipeline-root/);
  await run.controller.dispose();
});

test("unknown IDs fail closed and cancellation/disposal stop active sessions", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
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

test("pipeline roots and children do not apply direct-subagent capacity limits", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const ids = Array.from({ length: 5 }, () => run.controller.start(request()));
  await settleInitialization();
  assert.equal(
    ids.every((id) => run.controller.get(id)?.status === "starting"),
    true,
  );
  releaseRoot();
  await settleInitialization();
  assert.equal(
    ids.every((id) => run.controller.get(id)?.status === "running"),
    true,
  );
  assert.equal(run.sessions.length, 30);

  await run.controller.dispose();
});
