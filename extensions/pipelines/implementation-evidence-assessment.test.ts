import assert from "node:assert/strict";
import test from "node:test";
import type { AuditFinalReport } from "./audit-segment.ts";
import {
  AUDIT_PIPELINE_ID,
  FEATURE_PIPELINE_ID,
  PLAN_PIPELINE_ID,
} from "./domain.ts";
import type {
  FeatureCanonicalPlan,
  FeatureExecutionCheck,
} from "./feature-planning.ts";
import type { FeatureTaskSnapshot } from "./feature-task-runtime.ts";
import {
  assessImplementationEvidence,
  type ImplementationEvidenceAssessmentInput,
} from "./implementation-evidence-assessment.ts";
import type { AcceptanceIdentity } from "./run-acceptance.ts";

const plan = {
  reportType: "feature-canonical-plan-v1",
  summary: "A bounded feature implementation.",
  decisions: [
    {
      id: "DEC-1",
      title: "Keep the change local.",
      body: "Use the existing controller boundary.",
      evidence: [
        { reference: "controller", finding: "The controller owns state." },
      ],
      rejectedAlternatives: [],
    },
  ],
  changes: [
    {
      id: "CHANGE-1",
      path: "extensions/pipelines/example.ts",
      symbols: ["example"],
      action: "modify",
      body: "Implement the bounded behavior.",
      decisionRefs: ["DEC-1"],
      contractRefs: ["INV-1"],
      acceptanceRefs: ["AC-1", "AC-2"],
    },
  ],
  contracts: [
    {
      id: "INV-1",
      title: "The behavior remains bounded.",
      body: "The implementation preserves the existing boundary.",
      paths: ["extensions/pipelines/example.ts"],
    },
  ],
  acceptance: [
    {
      id: "AC-1",
      scenario: "A primary request is handled.",
      expected: "The primary result is returned.",
      verification: "Run the primary behavior check.",
    },
    {
      id: "AC-2",
      scenario: "An alternate request is handled.",
      expected: "The alternate result is returned.",
      verification: "Run the alternate behavior check.",
    },
  ],
  verification: [
    {
      id: "CHECK-1",
      command: "bun test extensions/pipelines/example.test.ts",
      cwd: ".",
      purpose: "Verify the bounded behavior.",
      proves: ["AC-1", "AC-2"],
      required: true,
    },
  ],
  risks: [],
  blockers: [],
  finalRationale: "The bounded design is complete.",
} satisfies FeatureCanonicalPlan;

function identity(diffDigest = "digest-reviewed") {
  return {
    base: "base-sha",
    head: "head-sha",
    diffDigest,
    revision: 4,
  } satisfies AcceptanceIdentity;
}

function checkDefinition(id: string) {
  return {
    id,
    command: `bun test ${id}.test.ts`,
    cwd: ".",
    purpose: `Verify ${id}.`,
    required: true,
  } satisfies FeatureExecutionCheck;
}

function taskSnapshot(options: {
  readonly id: string;
  readonly acceptanceRefs: ReadonlyArray<string>;
  readonly kind?: FeatureTaskSnapshot["kind"];
  readonly checkId?: string;
  readonly status?: FeatureTaskSnapshot["status"];
}) {
  const kind = options.kind ?? "task";
  const check = checkDefinition(options.checkId ?? `${options.id}-check`);
  return {
    id: options.id,
    kind,
    objective: `Complete ${options.id}.`,
    status: options.status ?? "validated",
    attempt: 1,
    attempts: [{ attempt: 1, status: "completed" }],
    branchId: "root",
    branch: "feature",
    worktree: "/tmp/feature-worktree",
    taskBaseCommit: "base-sha",
    provisionalCommit: "commit-sha",
    validatedCommit: "commit-sha",
    summary: "The task was completed.",
    checks: [
      {
        checkId: check.id,
        command: check.command,
        cwd: check.cwd,
        purpose: check.purpose,
        required: check.required,
        status: "passed",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        changedPaths: [],
        startedAt: 1,
        finishedAt: 2,
      },
    ],
    checkHistory: [],
    warnings: [],
    residualPaths: [],
    capsule: {
      kind,
      taskId: options.id,
      objective: `Complete ${options.id}.`,
      branchGoal: "Leave the bounded task complete.",
      context: {
        problem: "The bounded feature needs this task.",
        repositoryConventions: ["Use the existing repository conventions."],
        relevantDiscovery: ["The accepted plan is authoritative."],
        precedents: [
          {
            path: "extensions/pipelines/example.ts",
            symbol: "example",
            lesson: "Keep the implementation local.",
          },
        ],
        invariants: ["Preserve the existing boundary."],
      },
      readPaths: ["extensions/pipelines/example.ts"],
      writePaths: ["extensions/pipelines/example.ts"],
      instructions: ["Implement and verify the bounded task."],
      implementationSketch:
        "Make the smallest implementation consistent with the plan.",
      acceptanceRefs: [...options.acceptanceRefs],
      doneWhen: ["The required check passes."],
      checks: [check],
      graphContext: {
        currentHead: "base-sha",
        currentBranch: "feature",
        worktree: "/tmp/feature-worktree",
        attempt: 1,
        completedDependencies: [],
        nextTasks: [],
        knownResidualPaths: [],
        preparationBaseline: [],
        previousFailure: null,
        provisionalCommit: null,
        previousChecks: [],
      },
    },
  } satisfies FeatureTaskSnapshot;
}

function auditReport(overrides: Partial<AuditFinalReport> = {}) {
  return {
    reportType: "audit-synthesis-final" as const,
    mode: "initial" as const,
    baseSha: "base-sha",
    headSha: "head-sha",
    integratedRoles: [
      "audit-feature-outcome",
      "audit-logic-invariants",
      "audit-functional-correctness",
      "audit-reliability-regressions",
      "audit-executor",
    ] as const,
    findings: [],
    closureResults: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: {
      capturedAfterExecutor: true as const,
      workspaceChanged: false,
      statusBefore: { state: "available" as const, value: "clean" },
      statusAfter: { state: "available" as const, value: "clean" },
      dirtyDiffAfter: { state: "available" as const, value: "" },
      combinedDiffAfter: { state: "available" as const, value: "diff" },
      summary: "The host workspace observation is complete.",
    },
    summary: "The audit completed.",
    ...overrides,
  } satisfies AuditFinalReport;
}

function assessment(
  overrides: Partial<ImplementationEvidenceAssessmentInput> = {},
) {
  return assessImplementationEvidence({
    canonicalPlan: plan,
    taskResults: [
      taskSnapshot({ id: "task-primary", acceptanceRefs: ["AC-1"] }),
      taskSnapshot({ id: "task-alternate", acceptanceRefs: ["AC-2"] }),
      taskSnapshot({
        id: "__final-review",
        kind: "final-review",
        acceptanceRefs: ["AC-1", "AC-2"],
        checkId: "review-check",
      }),
    ],
    auditReport: auditReport(),
    reviewedIdentity: identity(),
    finalIdentity: identity(),
    state: "final",
    definition: FEATURE_PIPELINE_ID,
    ...overrides,
  });
}

test("maps each canonical acceptance ID to capsule checks and validated snapshots", () => {
  const result = assessment();

  assert.deepEqual(
    result.map(({ id, status }) => ({ id, status })),
    [
      { id: "AC-1", status: "passed" },
      { id: "AC-2", status: "passed" },
    ],
  );
  assert.deepEqual(result[0]?.evidenceRefs, [
    "task-results",
    "sol-review",
    "audit-report",
  ]);
  assert.equal(
    result.some(({ id }) => id === "review-coverage"),
    false,
  );
});

test("does not pass an acceptance ID when its mapping or required check evidence is missing", () => {
  const missingMapping = assessment({
    taskResults: [
      taskSnapshot({ id: "task-primary", acceptanceRefs: ["AC-1"] }),
    ],
  });
  assert.equal(
    missingMapping.find(({ id }) => id === "AC-1")?.status,
    "passed",
  );
  assert.equal(
    missingMapping.find(({ id }) => id === "AC-2")?.status,
    "unproven",
  );

  const incomplete = taskSnapshot({
    id: "task-primary",
    acceptanceRefs: ["AC-1"],
  });
  const withoutCheck = {
    ...incomplete,
    checks: [],
    capsule: { ...incomplete.capsule, checks: [] },
  } satisfies FeatureTaskSnapshot;
  const missingCheck = assessment({ taskResults: [withoutCheck] });
  assert.equal(
    missingCheck.find(({ id }) => id === "AC-1")?.status,
    "unproven",
  );
});

test("turns findings on the unchanged reviewed state into conservative failures without paths", () => {
  const result = assessment({
    auditReport: auditReport({
      findings: [
        {
          id: "AUD-001",
          title: "The primary behavior regresses.",
          sourceRoles: ["audit-feature-outcome"],
          scope: "initial",
          scopeReference: "task",
          scenario: "A primary request is handled.",
          expected: "The primary result is returned.",
          actual: "The primary result is not returned.",
          affectedPaths: ["extensions/pipelines/example.ts"],
          relationship: "introduced",
          evidenceType: "test",
          evidence: "The focused check reproduces the issue.",
          impact: 3,
          confidence: 90,
          minimalNextAction: "Repair the primary behavior.",
        },
      ],
    }),
  });

  assert.deepEqual(
    result.map(({ status }) => status),
    ["failed", "failed"],
  );
  for (const criterion of result) {
    assert.equal("affectedPaths" in criterion, false);
  }
});

test("does not transfer acceptance when the dirty digest changes despite the same HEAD", () => {
  const result = assessment({
    finalIdentity: identity("digest-final-different"),
  });

  assert.deepEqual(
    result.map(({ status }) => status),
    ["unproven", "unproven"],
  );
});

test("keeps legacy snapshots without graph capsules unproven", () => {
  const legacy = taskSnapshot({
    id: "legacy-task",
    acceptanceRefs: ["AC-1", "AC-2"],
  });
  const result = assessment({
    taskResults: [{ ...legacy, capsule: undefined }],
  });

  assert.deepEqual(
    result.map(({ status }) => status),
    ["unproven", "unproven"],
  );
});

test("does not pass final standalone audit coverage without both identities", () => {
  const bothAbsent = assessImplementationEvidence({
    auditReport: auditReport(),
    state: "final",
    definition: AUDIT_PIPELINE_ID,
  });
  const missingReviewed = assessImplementationEvidence({
    auditReport: auditReport(),
    finalIdentity: identity(),
    state: "final",
    definition: AUDIT_PIPELINE_ID,
  });
  const missingFinal = assessImplementationEvidence({
    auditReport: auditReport(),
    reviewedIdentity: identity(),
    state: "final",
    definition: AUDIT_PIPELINE_ID,
  });

  for (const result of [bothAbsent, missingReviewed, missingFinal]) {
    assert.equal(result[0]?.status, "unproven");
  }
});

test("requires reviewed identity for provisional standalone audit coverage", () => {
  const finalOnly = assessImplementationEvidence({
    auditReport: auditReport(),
    finalIdentity: identity(),
    state: "provisional",
    definition: AUDIT_PIPELINE_ID,
  });
  const reviewedOnly = assessImplementationEvidence({
    auditReport: auditReport(),
    reviewedIdentity: identity(),
    state: "provisional",
    definition: AUDIT_PIPELINE_ID,
  });

  assert.equal(finalOnly[0]?.status, "unproven");
  assert.equal(reviewedOnly[0]?.status, "passed");
});

test("uses explicit non-feature audit coverage and does not invent feature readiness", () => {
  const audit = assessImplementationEvidence({
    auditReport: auditReport(),
    reviewedIdentity: identity(),
    finalIdentity: identity(),
    state: "final",
    definition: AUDIT_PIPELINE_ID,
  });
  assert.deepEqual(audit, [
    {
      id: "audit-coverage",
      status: "passed",
      evidenceRefs: ["audit-report"],
      detail:
        "The final audit contains no findings, unproven checks, or unresolved conflicts.",
    },
  ]);

  const planDelivery = assessImplementationEvidence({
    state: "final",
    definition: PLAN_PIPELINE_ID,
  });
  assert.deepEqual(planDelivery, [
    {
      id: "feature-implementation",
      status: "not_applicable",
      evidenceRefs: [],
      detail:
        "Plan delivery does not define feature implementation acceptance criteria.",
    },
  ]);
});
