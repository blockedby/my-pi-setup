import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import { AuditSegment } from "./audit-segment.ts";
import { PipelineController } from "./controller.ts";
import { pipelineSessionToolPolicy } from "./session.ts";
import {
  LUNA_MODEL,
  PIPELINE_4_LUNA_AUDIT_ROLES,
  SOL_MODEL,
  TERRA_MODEL,
  type PipelineHandoff,
} from "./domain.ts";

class FakeSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  readonly activeTools: ReadonlyArray<string> = ["read"];
  readonly sessionFile: string;
  isStreaming = false;
  interrupted = 0;
  disposed = 0;
  readonly spec: AgentNodeSpec;

  constructor(spec: AgentNodeSpec) {
    this.spec = spec;
    this.sessionFile = `/private/${spec.scopeId}-${spec.role}.jsonl`;
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

function harness() {
  const sessions: FakeSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  let agent = 0;
  const controller = new PipelineController({
    makeRunId: () => "audit-run",
    makeAgentId: () => `audit-agent-${++agent}`,
    createSessionFactory: (
      _rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
    ) => ({
      async create(spec) {
        const session = new FakeSession(spec);
        sessions.push(session);
        return session;
      },
    }),
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
  });
  return { controller, sessions, handoffs };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function trackReport(role: string) {
  return JSON.stringify({ track: role, findings: [], unprovenChecks: [] });
}

function intermediate(roles: ReadonlyArray<string>) {
  return JSON.stringify({
    reportType: "audit-synthesis-intermediate",
    integratedRoles: roles,
    rootCauseCandidates: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    summary: "Integrated the current validated batch",
  });
}

function finalReport(
  roles: ReadonlyArray<string>,
  closureResults: ReadonlyArray<Record<string, string>> = [],
  mode: "initial" | "closure" = "initial",
) {
  return JSON.stringify({
    reportType: "audit-synthesis-final",
    mode,
    baseSha: "UNAVAILABLE",
    headSha: "UNAVAILABLE",
    integratedRoles: roles,
    findings: [],
    closureResults,
    unresolvedConflicts: [],
    unprovenChecks: [],
    summary: "Bounded factual audit synthesis",
  });
}

function settle(session: FakeSession, finalText: string) {
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText },
  });
}

function sessionFor(harnessValue: ReturnType<typeof harness>, role: string) {
  const session = harnessValue.sessions.find(
    (candidate) => candidate.spec.role === role,
  );
  assert.ok(session);
  return session;
}

test("audit roots, tracks, and synthesis children deny mutation and orchestration tools", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("audit-pipeline", true, "audit-synthesis")
      .excludeTools,
  );
  const childDenied = new Set<string>(
    pipelineSessionToolPolicy("audit-pipeline", false, "audit-feature-outcome")
      .excludeTools,
  );
  for (const tool of ["bash", "edit", "write", "codex_task", "pipeline_run"]) {
    assert.equal(rootDenied.has(tool), true);
    assert.equal(childDenied.has(tool), true);
  }
  for (const tool of [
    "pipeline_stage",
    "pipeline_child_spawn",
    "pipeline_audit_start",
    "pipeline_complete",
  ]) {
    assert.equal(rootDenied.has(tool), true);
    assert.equal(childDenied.has(tool), true);
  }
});

test("standalone audit graph is Luna-only and activates synthesis on the first valid report", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit the bounded change",
    workingDir: "/tmp/work",
    audit: { mode: "initial", acceptanceCriteria: ["The contract holds"] },
  });
  await flush();

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.definition, "audit-pipeline");
  assert.equal(snapshot?.stage, "audit");
  assert.equal(snapshot?.agents.length, 5);
  assert.equal(
    snapshot?.agents.every((item) => item.model === LUNA_MODEL),
    true,
  );
  assert.equal(
    snapshot?.agents.some((item) => item.model === SOL_MODEL),
    false,
  );
  assert.equal(
    snapshot?.agents.some((item) => item.model === TERRA_MODEL),
    false,
  );
  const synthesizer = sessionFor(run, "audit-synthesis");
  assert.equal(synthesizer.sends.length, 0);

  settle(
    sessionFor(run, PIPELINE_4_LUNA_AUDIT_ROLES[0]),
    trackReport(PIPELINE_4_LUNA_AUDIT_ROLES[0]),
  );
  await flush();
  assert.equal(synthesizer.sends.length, 1);
  assert.match(synthesizer.sends[0] ?? "", /audit-feature-outcome/);
  assert.equal(run.controller.get(runId)?.auditSegment?.reducerStatus, "busy");
  assert.equal(run.handoffs.length, 0);

  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES.slice(1)) {
    settle(sessionFor(run, role), trackReport(role));
  }
  await flush();
  assert.equal(synthesizer.sends.length, 1);
  assert.equal(synthesizer.interrupted, 0);
  assert.equal(run.controller.get(runId)?.auditSegment?.pendingReportCount, 3);

  settle(synthesizer, intermediate([PIPELINE_4_LUNA_AUDIT_ROLES[0]]));
  await flush();
  assert.equal(synthesizer.sends.length, 2);
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES.slice(1)) {
    assert.match(synthesizer.sends[1] ?? "", new RegExp(role));
  }
  assert.equal(run.handoffs.length, 0);

  settle(synthesizer, finalReport(PIPELINE_4_LUNA_AUDIT_ROLES));
  await flush();
  const completed = run.controller.get(runId);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.stage, "complete");
  assert.equal(completed?.auditSegment?.integratedReportCount, 4);
  assert.equal(completed?.auditSegment?.revision, 2);
  assert.equal(completed?.auditSegment?.finalReportValidated, true);
  assert.equal(run.handoffs.length, 1);
  assert.equal(
    run.handoffs[0]?.facts.auditReport?.reportType,
    "audit-synthesis-final",
  );
  await run.controller.dispose();
});

test("final audit findings are canonicalized, deduplicated, and assigned IDs host-side", () => {
  const segment = new AuditSegment({
    task: "Audit stable IDs",
    acceptanceContract: "The final report is deterministic",
    assumptions: [],
    checks: [],
    input: { mode: "initial", acceptanceCriteria: [] },
    git: {
      baseSha: "base123",
      headSha: "head123",
      worktreeLabel: "WORKTREE",
      workingDir: "/tmp/work",
      branch: "main",
      status: { state: "available", value: "" },
      baseIsAncestor: "yes",
      commits: { state: "available", value: "" },
      committedDiff: { state: "available", value: "" },
      dirtyDiff: { state: "available", value: "" },
      combinedDiff: { state: "available", value: "" },
    },
  });
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    segment.accept(role, trackReport(role), 1);
  }
  assert.equal(segment.nextPrompt()?.turn.final, true);
  const finding = (title: string, impact: number) => ({
    title,
    sourceRoles: [PIPELINE_4_LUNA_AUDIT_ROLES[0]],
    scope: "initial",
    scopeReference: "task",
    scenario: `Scenario ${title}`,
    expected: "Expected behavior",
    actual: "Actual behavior",
    affectedPaths: ["src/example.ts"],
    relationship: "introduced",
    evidenceType: "static",
    evidence: `Evidence ${title}`,
    impact,
    confidence: 90,
    minimalNextAction: `Fix ${title}`,
  });
  segment.settle(
    JSON.stringify({
      reportType: "audit-synthesis-final",
      mode: "initial",
      baseSha: "base123",
      headSha: "head123",
      integratedRoles: PIPELINE_4_LUNA_AUDIT_ROLES,
      findings: [
        finding("lower", 2),
        finding("higher", 4),
        finding("higher", 4),
      ],
      closureResults: [],
      unresolvedConflicts: [],
      unprovenChecks: [],
      summary: "Canonical findings",
    }),
  );
  assert.deepEqual(
    segment.finalReport?.findings.map((item) => [item.id, item.title]),
    [
      ["AUD-001", "higher"],
      ["AUD-002", "lower"],
    ],
  );
});

test("closure audit input rejects an empty directly touched invariant scope", async () => {
  const run = harness();
  assert.throws(
    () =>
      run.controller.start({
        pipeline: "audit-pipeline",
        task: "Incomplete closure audit",
        workingDir: "/tmp/work",
        audit: {
          mode: "closure",
          acceptanceCriteria: [],
          priorBlockers: [{ id: "BLOCK-1", closureCondition: "Fixed" }],
          remediationDiff: "diff",
          touchedInvariants: [],
        },
      }),
    /at least one directly touched invariant/,
  );
  await run.controller.dispose();
});

test("standalone audit fails closed on malformed or missing reports", async () => {
  const malformed = harness();
  const malformedId = malformed.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit malformed output",
    workingDir: "/tmp/work",
  });
  await flush();
  settle(
    sessionFor(malformed, PIPELINE_4_LUNA_AUDIT_ROLES[0]),
    JSON.stringify({ track: "wrong", findings: [], unprovenChecks: [] }),
  );
  await flush();
  assert.equal(malformed.controller.get(malformedId)?.status, "failed");
  assert.match(
    malformed.handoffs[0]?.error ?? "",
    /invalid or mismatched report/,
  );
  await malformed.controller.dispose();

  const missing = harness();
  const missingId = missing.controller.start({
    pipeline: "audit-pipeline",
    task: "Audit missing output",
    workingDir: "/tmp/work",
  });
  await flush();
  settle(sessionFor(missing, PIPELINE_4_LUNA_AUDIT_ROLES[0]), "");
  await flush();
  assert.equal(missing.controller.get(missingId)?.status, "failed");
  assert.equal(missing.handoffs.length, 1);
  await missing.controller.dispose();
});

test("standalone closure audit preserves supplied blocker scope and cancels session-scoped agents", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Verify blocker closure",
    workingDir: "/tmp/work",
    audit: {
      mode: "closure",
      acceptanceCriteria: ["Prior blocker is closed"],
      priorBlockers: [
        { id: "AUD-004", closureCondition: "The race is impossible" },
      ],
      remediationDiff: "Bounded supplied remediation diff",
      touchedInvariants: ["Exactly-once delivery"],
    },
  });
  await flush();
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES) {
    const prompt = sessionFor(run, role).prompts[0] ?? "";
    assert.match(prompt, /Do not reopen broad discovery/);
    assert.match(prompt, /AUD-004/);
  }
  await run.controller.cancelRun(runId);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  assert.equal(
    run.sessions
      .filter((session) => session.spec.role !== "audit-synthesis")
      .every((session) => session.interrupted === 1),
    true,
  );
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.every((agent) => agent.status === "cancelled"),
    true,
  );
  await run.controller.dispose();
});

test("closure finalization rejects blocker substitution", async () => {
  const run = harness();
  const runId = run.controller.start({
    pipeline: "audit-pipeline",
    task: "Verify blocker closure",
    workingDir: "/tmp/work",
    audit: {
      mode: "closure",
      acceptanceCriteria: [],
      priorBlockers: [{ id: "BLOCK-1", closureCondition: "Condition one" }],
      remediationDiff: "diff",
      touchedInvariants: ["Invariant one"],
    },
  });
  await flush();
  const firstRole = PIPELINE_4_LUNA_AUDIT_ROLES[0];
  settle(sessionFor(run, firstRole), trackReport(firstRole));
  await flush();
  for (const role of PIPELINE_4_LUNA_AUDIT_ROLES.slice(1)) {
    settle(sessionFor(run, role), trackReport(role));
  }
  const synthesizer = sessionFor(run, "audit-synthesis");
  settle(synthesizer, intermediate([firstRole]));
  await flush();
  settle(
    synthesizer,
    finalReport(
      PIPELINE_4_LUNA_AUDIT_ROLES,
      [
        {
          blockerId: "OTHER",
          closureCondition: "Condition one",
          status: "closed",
          evidence: "proof",
        },
      ],
      "closure",
    ),
  );
  await flush();
  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});
