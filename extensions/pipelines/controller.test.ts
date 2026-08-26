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
import { pipelineSessionToolPolicy } from "./session.ts";
import { buildPipelineRows, cancelPipelineRow } from "./dashboard.ts";
import {
  FEATURE_PIPELINE_LUNA_AUDIT_ROLES,
  FINAL_AUDIT_ROLE,
  LUNA_MODEL,
  PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_AUDIT_ROLES,
  PLAN_PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  SMALL_FEATURE_AUDIT_ROLE,
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
  if (role === "final-audit" || role === "audit-small-feature") {
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
  run.controller.setStage(runId, "final-audit");
  await run.controller.spawnChild(runId, "final-audit");
  settleRole(run, "final-audit");
  run.controller.setStage(runId, "final-resolve");
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

test("definition role policies centralize child context requirements", () => {
  for (const role of [...FEATURE_PIPELINE_LUNA_AUDIT_ROLES, FINAL_AUDIT_ROLE]) {
    assert.deepEqual(childContextPolicyFor("feature-pipeline", role), {
      gitEvidence: true,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("small-feature-pipeline", SMALL_FEATURE_AUDIT_ROLE),
    {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    },
  );
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", "discover-problem"),
    {},
  );
  assert.deepEqual(
    childContextPolicyFor("plan-pipeline", "audit-decomposition-dag"),
    {},
  );
});

test("small-feature Sol and Terra are read-only while Luna keeps coding tools", () => {
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
      "audit-small-feature",
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

test("plan-pipeline has fixed staged direct Luna/Terra roles and rejects feature roles", async () => {
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
  const terra = await run.controller.spawnChild(runId, "final-audit");
  const children = [...discovery, ...audits, terra];
  assert.deepEqual(
    children.map((child) => child.role),
    [...PLAN_PIPELINE_CHILD_ROLES],
  );
  assert.equal(
    children.every((child) => child.parentId === snapshot?.rootId),
    true,
  );
  assert.equal(
    children.slice(0, 9).every((child) => child.model === LUNA_MODEL),
    true,
  );
  assert.equal(children[9]?.model, TERRA_MODEL);
  await assert.rejects(
    run.controller.spawnChild(runId, "discover-problem"),
    /Unsupported plan-pipeline child role/,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "final-audit"),
    /already has its allowed child session/,
  );
  const terraSession = run.sessions.find(
    (candidate) => candidate.spec.role === "final-audit",
  );
  assert.ok(terraSession);
  terraSession.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify({
        mode: "initial",
        verdict: "anything",
        findings: [],
        summary: "Incomplete canonical result",
      }),
    },
  });
  assert.throws(
    () => run.controller.setStage(runId, "final-resolve"),
    /missing valid reports: final-audit/,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature-pipeline reuses one persistent Luna after one Terra audit", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...request(),
    pipeline: "small-feature-pipeline",
  });
  await settleInitialization();

  const initial = run.controller.get(runId);
  assert.equal(initial?.stage, "build");
  assert.equal(initial?.agents[0]?.title, "Small feature pipeline Sol");
  assert.deepEqual(SMALL_FEATURE_PIPELINE_CHILD_ROLES, [
    "implement-small-feature",
    "audit-small-feature",
  ]);

  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  assert.equal(implementer.model, LUNA_MODEL);
  assert.equal(implementer.persistent, true);
  await assert.rejects(
    run.controller.spawnChild(runId, "implement-small-feature"),
    /already has its allowed child session/,
  );
  settleRole(run, "implement-small-feature");
  assert.equal(run.controller.getAgent(runId, implementer.id).status, "idle");
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");

  const auditor = await run.controller.spawnChild(runId, "audit-small-feature");
  assert.equal(auditor.model, TERRA_MODEL);
  assert.equal(auditor.persistent, false);
  const auditorSession = run.sessions.find(
    (session) => session.spec.role === "audit-small-feature",
  );
  assert.ok(auditorSession);
  assert.equal(
    auditorSession.prompts[0]?.includes(
      reportForRole("implement-small-feature"),
    ),
    true,
  );
  settleRole(run, "audit-small-feature");
  await run.controller.waitForChildren(runId, [auditor.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  await assert.rejects(
    run.controller.sendChild(runId, auditor.id, "Audit again"),
    /cannot be retried or continued/,
  );
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.throws(
    () => run.controller.setStage(runId, "complete"),
    /requires one same-session Luna remediation pass/,
  );

  const remediationMessage = `Resolve this audit:\n${reportForRole("audit-small-feature")}`;
  await run.controller.sendChild(runId, implementer.id, remediationMessage);
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === "implement-small-feature",
  );
  assert.ok(implementerSession);
  assert.equal(implementerSession.sends.length, 1);
  assert.match(
    implementerSession.sends[0] ?? "",
    /Independent Terra audit to resolve/,
  );
  assert.equal(
    implementerSession.sends[0]?.includes(reportForRole("audit-small-feature")),
    true,
  );
  assert.equal(implementerSession.sends[0]?.includes(remediationMessage), true);
  settleRole(run, "implement-small-feature");
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
    reports: ["Luna implementation", "Terra audit", "Luna remediation"],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };
  run.controller.complete(runId, facts);
  assert.equal(run.controller.get(runId)?.status, "completed");
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

test("feature Luna audits and final Terra receive fresh base-relative Git evidence", async () => {
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
    FEATURE_PIPELINE_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  for (const role of FEATURE_PIPELINE_LUNA_AUDIT_ROLES) {
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
  await run.controller.spawnChild(runId, "final-audit");
  const terraAudit = run.sessions.find(
    (session) => session.spec.role === "final-audit",
  );
  assert.ok(terraAudit);
  assert.equal(terraAudit.prompts[0]?.includes(baseSha), true);
  assert.equal(terraAudit.prompts[0]?.includes("-before"), true);
  assert.equal(terraAudit.prompts[0]?.includes("+final"), true);
  assert.equal(terraAudit.prompts[0]?.includes("+after"), false);

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature Terra receives the captured base and actual workspace diff", async () => {
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
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "after\n");
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  settleRole(run, "implement-small-feature");
  await run.controller.waitForChildren(runId, [implementer.id]);
  await run.controller.spawnChild(runId, "audit-small-feature");

  const auditorSession = run.sessions.find(
    (session) => session.spec.role === "audit-small-feature",
  );
  assert.ok(auditorSession);
  assert.equal(auditorSession.prompts[0]?.includes(baseSha), true);
  assert.equal(auditorSession.prompts[0]?.includes("-before"), true);
  assert.equal(auditorSession.prompts[0]?.includes("+after"), true);

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature-pipeline fails closed on a malformed child report", async () => {
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
  assert.equal(run.controller.get(runId)?.stage, "build");

  await run.controller.dispose();
});

test("successful audit fan-in atomically enters audit-resolve", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const auditRoles = PIPELINE_CHILD_ROLES.filter((role) =>
    role.startsWith("audit-"),
  );
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
  const rows = buildPipelineRows(snapshot ? [snapshot] : []);
  assert.equal(
    rows.find((row) => row.kind === "stage" && row.stage === "audit-resolve")
      ?.label,
    "audit-resolve · running",
  );

  run.controller.setStage(runId, "final-audit");
  const finalAudit = await run.controller.spawnChild(runId, "final-audit");
  settleRole(run, "final-audit");
  await run.controller.waitForChildren(runId, [finalAudit.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");

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
