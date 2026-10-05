import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import { PipelineController } from "./controller.ts";
import {
  ASTRA_MODEL,
  SOL_MODEL,
  LUNA_MODEL,
  AUDIT_SYNTHESIS_ROLE,
  AUDIT_SEGMENT_LUNA_ROLES,
  STATIC_LUNA_AUDIT_ROLES,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  IMPLEMENTING_PIPELINE_ID,
  PIPELINE_MODELS,
  modelRolesForDefinition,
  validatePipelineRoleModels,
  modelForRole,
  type PipelineHandoff,
  type PipelineRunRequest,
} from "./domain.ts";
import { pipelineCommitPolicy } from "./prompt.ts";
import {
  createPipelineSessionFactory,
  pipelineSessionToolPolicy,
} from "./session.ts";
import { assertImplementationPipelineWorkspace } from "./worktree-preflight.ts";

class Session implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly activeTools: ReadonlyArray<string> = [];
  readonly sessionFile = undefined;
  sends = 0;
  disposed = false;
  isStreaming = false;
  onSend?: () => void;
  constructor(readonly spec: AgentNodeSpec) {}
  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AgentTreeSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }
  async prompt() {
    this.isStreaming = true;
    this.emit({ type: "run_started" });
  }
  async send() {
    this.sends++;
    await this.prompt();
    this.onSend?.();
  }
  finish(report: string) {
    this.isStreaming = false;
    this.emit({
      type: "settled",
      outcome: { type: "completed", finalText: report },
    });
  }
  fail() {
    this.isStreaming = false;
    this.emit({
      type: "settled",
      outcome: { type: "failed", error: "provider failure" },
    });
  }
  enableMutation() {}
  async interrupt() {
    this.isStreaming = false;
  }
  dispose() {
    this.disposed = true;
  }
}

const implementationReport = JSON.stringify({
  summary: "Implemented the scoped change",
  changedPaths: ["src/feature.ts"],
  checks: ["focused tests passed"],
  assumptions: [],
  unresolvedItems: [],
});
const auditReport = (role: string) =>
  JSON.stringify({ track: role, findings: [], unprovenChecks: [] });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "implementing-contract-"));
  const primary = path.join(root, "primary");
  const linked = path.join(root, "linked");
  fs.mkdirSync(primary);
  execFileSync("git", ["init", "-q"], { cwd: primary });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ],
    { cwd: primary },
  );
  execFileSync("git", ["worktree", "add", "-qb", "implementation", linked], {
    cwd: primary,
  });
  return { root, primary, linked };
}

async function harness(
  t: test.TestContext,
  models: ReadonlyArray<string> = PIPELINE_MODELS,
) {
  const workspace = fixture();
  const sessions = new Map<string, Session>();
  const handoffs: PipelineHandoff[] = [];
  let runSequence = 0;
  let agentSequence = 0;
  const controller = new PipelineController({
    artifactRoot: path.join(workspace.root, "artifacts"),
    modelAvailable: (model) => models.includes(model),
    makeRunId: (name) =>
      `${name}-${(++runSequence).toString(16).padStart(8, "0")}`,
    makeAgentId: () => `agent-${++agentSequence}`,
    createSessionFactory: () => ({
      async create(spec) {
        const session = new Session(spec);
        sessions.set(spec.id!, session);
        return session;
      },
    }),
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
  });
  t.after(async () => {
    await controller.dispose();
    fs.rmSync(workspace.root, { recursive: true, force: true });
  });
  const request: PipelineRunRequest = {
    pipelineName: "implement-approved-change",
    task: "Implement the scoped contract",
    workingDir: workspace.linked,
  };
  const start = async (overrides: Partial<PipelineRunRequest> = {}) => {
    const id = controller.start({ ...request, ...overrides });
    for (
      let attempt = 0;
      attempt < 50 && controller.get(id)?.status === "starting";
      attempt++
    )
      await flush();
    assert.equal(controller.get(id)?.status, "running");
    return id;
  };
  const build = async (id: string) => {
    const implementer = await controller.spawnChild(
      id,
      SMALL_FEATURE_IMPLEMENTER_ROLE,
    );
    sessions.get(implementer.id)!.finish(implementationReport);
    await controller.waitForChildren(id, [implementer.id]);
    assert.equal(controller.get(id)?.stage, "final-audit");
    return implementer;
  };
  const audit = async (id: string) =>
    Promise.all(
      STATIC_LUNA_AUDIT_ROLES.map((role) => controller.spawnChild(id, role)),
    );
  return {
    ...workspace,
    controller,
    sessions,
    handoffs,
    request,
    start,
    build,
    audit,
  };
}

test("legacy launches fail before sessions, filesystem work or run insertion", async (t) => {
  const run = await harness(t);
  for (const pipeline of [
    "feature-pipeline",
    "small-feature-pipeline",
    "plan-pipeline",
  ] as const) {
    assert.throws(
      () =>
        run.controller.start({
          ...run.request,
          pipeline,
          workingDir: "/does/not/exist",
          gitCommit: true,
        }),
      /inspection-only/,
    );
  }
  assert.equal(run.sessions.size, 0);
  assert.deepEqual(run.controller.list(), []);
});

test("implementing retains linked-worktree isolation without clean-source or bootstrap gates", async (t) => {
  const run = await harness(t);
  assert.throws(() =>
    assertImplementationPipelineWorkspace(
      IMPLEMENTING_PIPELINE_ID,
      run.primary,
    ),
  );
  const nested = path.join(run.linked, "nested");
  fs.mkdirSync(nested);
  assert.throws(() =>
    assertImplementationPipelineWorkspace(IMPLEMENTING_PIPELINE_ID, nested),
  );
  fs.writeFileSync(
    path.join(run.linked, "existing-dirty.txt"),
    "caller-owned change",
  );
  const id = await run.start();
  assert.equal(run.controller.get(id)?.featureGraph, undefined);
  assert.equal(run.controller.get(id)?.stage, "build");
  assert.throws(
    () =>
      run.controller.start({
        ...run.request,
        pipelineName: "duplicate-workspace-launch",
      }),
    /leased/,
  );
});

test("implementing enforces four independent audits and one original-session remediation", async (t) => {
  const run = await harness(t);
  const id = await run.start();
  const root = run.controller.get(id)!.agents[0]!;
  assert.equal(root.model, SOL_MODEL);
  const implementer = await run.build(id);
  const originalSession = run.sessions.get(implementer.id)!;
  assert.equal(implementer.model, SOL_MODEL);
  assert.equal(implementer.persistent, true);
  await assert.rejects(
    run.controller.spawnChild(id, SMALL_FEATURE_IMPLEMENTER_ROLE),
  );
  await assert.rejects(run.controller.spawnChild(id, "discover-context"));
  const auditors = await run.audit(id);
  assert.equal(new Set(auditors.map(({ id }) => id)).size, 4);
  for (const child of auditors) {
    assert.equal(child.parentId, root.id);
    assert.equal(child.model, SOL_MODEL);
    assert.notEqual(run.sessions.get(child.id), originalSession);
  }
  await assert.rejects(
    run.controller.spawnChild(id, STATIC_LUNA_AUDIT_ROLES[0]),
  );
  run.sessions.get(auditors[0]!.id)!.finish(auditReport(auditors[0]!.role));
  await run.controller.waitForChildren(id, [auditors[0]!.id]);
  assert.equal(run.controller.get(id)?.stage, "final-audit");
  assert.throws(() => run.controller.setStage(id, "final-resolve"));
  for (const child of auditors.slice(1))
    run.sessions.get(child.id)!.finish(auditReport(child.role));
  await run.controller.waitForChildren(
    id,
    auditors.map(({ id }) => id),
  );
  assert.equal(run.controller.get(id)?.stage, "final-resolve");
  await assert.rejects(
    run.controller.sendChild(id, auditors[0]!.id, "Review again"),
  );
  assert.throws(() => run.controller.setStage(id, "complete"));
  await run.controller.sendChild(
    id,
    implementer.id,
    "Resolve findings and verify",
  );
  assert.equal(run.sessions.get(implementer.id), originalSession);
  assert.equal(originalSession.sends, 1);
  assert.throws(() =>
    run.controller.complete(id, {
      outcome: "premature",
      changedPaths: [],
      checks: [],
      assumptions: [],
      git: [],
      reports: [],
      unresolvedItems: [],
      workingDir: run.linked,
    }),
  );
  originalSession.finish(implementationReport);
  await run.controller.waitForChildren(id, [implementer.id]);
  assert.equal(run.controller.get(id)?.stage, "complete");
  await assert.rejects(
    run.controller.sendChild(id, implementer.id, "Second remediation"),
  );
  run.controller.complete(id, {
    outcome: "Implemented and checked",
    changedPaths: ["src/feature.ts"],
    checks: ["focused tests passed"],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: run.linked,
  });
  assert.equal(run.controller.get(id)?.status, "completed");
  assert.equal(run.sessions.size, 6);
});

test("role choices survive admission without altering model independence or cardinality", async (t) => {
  const run = await harness(t);
  const roleModels = {
    "pipeline-root": LUNA_MODEL,
    [SMALL_FEATURE_IMPLEMENTER_ROLE]: ASTRA_MODEL,
    [STATIC_LUNA_AUDIT_ROLES[0]]: LUNA_MODEL,
  } as const;
  const id = await run.start({ roleModels });
  assert.equal(run.controller.get(id)!.agents[0]!.model, LUNA_MODEL);
  const implementer = await run.build(id);
  assert.equal(implementer.model, ASTRA_MODEL);
  const auditors = await run.audit(id);
  assert.equal(auditors[0]!.model, LUNA_MODEL);
  assert.equal(auditors[1]!.model, SOL_MODEL);
  for (const child of auditors)
    run.sessions.get(child.id)!.finish(auditReport(child.role));
  await run.controller.waitForChildren(
    id,
    auditors.map(({ id }) => id),
  );
  await run.controller.sendChild(id, implementer.id, "Resolve findings");
  assert.equal(run.sessions.get(implementer.id)!.spec.model, ASTRA_MODEL);
});

test("model availability and applicable roles are validated before admission", async (t) => {
  assert.equal(modelForRole(SMALL_FEATURE_IMPLEMENTER_ROLE), SOL_MODEL);
  assert.equal(modelForRole(AUDIT_SYNTHESIS_ROLE), SOL_MODEL);
  const run = await harness(t, [LUNA_MODEL]);
  assert.throws(() => run.controller.start(run.request), /unavailable/);
  assert.equal(run.sessions.size, 0);
  assert.deepEqual(run.controller.list(), []);
  assert.throws(() =>
    validatePipelineRoleModels("audit-pipeline", {
      [SMALL_FEATURE_IMPLEMENTER_ROLE]: SOL_MODEL,
    }),
  );
  assert.throws(() =>
    validatePipelineRoleModels("implementing-pipeline", {
      [AUDIT_SYNTHESIS_ROLE]: SOL_MODEL,
    }),
  );
  const checked: string[] = [];
  validatePipelineRoleModels(
    "audit-pipeline",
    { [AUDIT_SYNTHESIS_ROLE]: ASTRA_MODEL },
    (model) => {
      checked.push(model);
      return true;
    },
  );
  assert.equal(
    checked.length,
    modelRolesForDefinition("audit-pipeline").length,
  );
  assert.ok(checked.includes(ASTRA_MODEL));
});

test("session creation checks actual registry lookup before loading resources", async () => {
  const lookups: string[] = [];
  const factory = createPipelineSessionFactory({
    modelRegistry: {
      find: (provider, id) => {
        lookups.push(`${provider}/${id}`);
        return undefined;
      },
    },
    parentCwd: "/missing-parent",
    parentTrusted: false,
    definitionForRun: () => IMPLEMENTING_PIPELINE_ID,
    rootTools: () => [],
  });
  await assert.rejects(
    factory.create({
      id: "session",
      role: SMALL_FEATURE_IMPLEMENTER_ROLE,
      title: "implementation",
      model: SOL_MODEL,
      cwd: "/missing-workspace",
      prompt: "",
      attempt: 1,
    }),
    /unavailable/,
  );
  assert.deepEqual(lookups, [SOL_MODEL]);
});

test("malformed audit transport gets bounded same-session correction instead of fail-fast", async (t) => {
  const run = await harness(t);
  const id = await run.start();
  await run.build(id);
  const auditors = await run.audit(id);
  const first = auditors[0]!;
  const session = run.sessions.get(first.id)!;
  session.finish("malformed JSON");
  session.onSend = () => session.finish(auditReport(first.role));
  for (const child of auditors.slice(1))
    run.sessions.get(child.id)!.finish(auditReport(child.role));
  await run.controller.waitForChildren(
    id,
    auditors.map(({ id }) => id),
  );
  assert.equal(run.controller.get(id)?.status, "running");
  assert.equal(run.controller.get(id)?.stage, "final-resolve");
  assert.equal(session.sends, 1);
  assert.equal(run.sessions.size, 6);
});

test("overlapping waits join one in-flight transport correction", async (t) => {
  const run = await harness(t);
  const id = await run.start();
  await run.build(id);
  const auditors = await run.audit(id);
  const first = auditors[0]!;
  const session = run.sessions.get(first.id)!;
  session.finish("{}");
  session.onSend = () => {
    setImmediate(() => session.finish(auditReport(first.role)));
  };
  for (const child of auditors.slice(1))
    run.sessions.get(child.id)!.finish(auditReport(child.role));
  await Promise.all([
    run.controller.waitForChildren(id, [first.id]),
    run.controller.waitForChildren(id, [first.id]),
  ]);
  assert.equal(session.sends, 1);
  assert.equal(run.controller.get(id)?.status, "running");
  assert.equal(run.controller.get(id)?.stage, "final-resolve");
});

test("audit correction is bounded and track identity cannot be substituted", async (t) => {
  const run = await harness(t);
  const id = await run.start();
  await run.build(id);
  const auditors = await run.audit(id);
  const first = auditors[0]!;
  const session = run.sessions.get(first.id)!;
  session.finish(auditReport("another-track"));
  session.onSend = () => session.finish(auditReport("another-track"));
  await run.controller.waitForChildren(id, [first.id]);
  assert.equal(session.sends, 3);
  assert.equal(run.controller.get(id)?.status, "failed");
  assert.equal(run.sessions.size, 6);
});

test("real child failures and malformed implementation reports remain terminal", async (t) => {
  for (const failure of ["provider", "report"] as const) {
    await t.test(failure, async (childTest) => {
      const run = await harness(childTest);
      const id = await run.start();
      const child = await run.controller.spawnChild(
        id,
        SMALL_FEATURE_IMPLEMENTER_ROLE,
      );
      const session = run.sessions.get(child.id)!;
      if (failure === "provider") session.fail();
      else session.finish("{}");
      await run.controller.waitForChildren(id, [child.id]);
      assert.equal(run.controller.get(id)?.status, "failed");
      assert.equal(session.sends, 0);
    });
  }
});

test("standalone audit starts with Sol synthesis and keeps independent registry-selected reviewers", async (t) => {
  const run = await harness(t);
  const id = await run.start({
    pipeline: "audit-pipeline",
    workingDir: run.primary,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Audit startup did not settle"));
    }, 5000);
    const unsubscribe = run.controller.subscribe(() => {
      const snapshot = run.controller.get(id);
      if (snapshot?.agents.length === 6 || snapshot?.status === "failed") {
        unsubscribe();
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.equal(
    run.controller.get(id)?.status,
    "running",
    run.controller.get(id)?.error ?? "Audit startup failed",
  );
  const agents = run.controller.get(id)!.agents;
  assert.equal(
    agents.find(({ role }) => role === AUDIT_SYNTHESIS_ROLE)?.model,
    SOL_MODEL,
  );
  assert.equal(agents.length, 6);
  for (const role of AUDIT_SEGMENT_LUNA_ROLES)
    assert.equal(agents.find((agent) => agent.role === role)?.model, SOL_MODEL);
});

test("implementation tools retain normal capabilities without recursive orchestration", () => {
  const policy = pipelineSessionToolPolicy(
    IMPLEMENTING_PIPELINE_ID,
    false,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  for (const name of [
    "read",
    "write",
    "edit",
    "bash",
    "bg_start",
    "mcp",
    "apply_patch_codex",
  ])
    assert.equal(policy.excludeTools.includes(name), false);
  for (const name of [
    "subagent_spawn",
    "workflow",
    "pipeline_run",
    "pipeline_child_spawn",
    "codex_task",
  ])
    assert.equal(policy.excludeTools.includes(name), true);
  for (const role of ["pipeline-root", ...STATIC_LUNA_AUDIT_ROLES]) {
    const rolePolicy = pipelineSessionToolPolicy(
      IMPLEMENTING_PIPELINE_ID,
      role === "pipeline-root",
      role,
    );
    for (const name of ["edit", "write", "bash"])
      assert.equal(rolePolicy.excludeTools.includes(name), true);
    assert.equal(
      pipelineCommitPolicy(
        IMPLEMENTING_PIPELINE_ID,
        role === "pipeline-root"
          ? role
          : STATIC_LUNA_AUDIT_ROLES.find((candidate) => candidate === role)!,
        { gitCommit: true },
      ).commitAllowed,
      false,
    );
  }
  assert.equal(
    pipelineCommitPolicy(
      IMPLEMENTING_PIPELINE_ID,
      SMALL_FEATURE_IMPLEMENTER_ROLE,
      {},
    ).commitAllowed,
    false,
  );
  assert.equal(
    pipelineCommitPolicy(
      IMPLEMENTING_PIPELINE_ID,
      SMALL_FEATURE_IMPLEMENTER_ROLE,
      { gitCommit: true },
    ).commitAllowed,
    true,
  );
});
