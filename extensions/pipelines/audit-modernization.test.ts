import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  auditTrackReportSchema,
  type AuditFinalReport,
} from "./audit-segment.ts";
import {
  AUDIT_PIPELINE_ID,
  IMPLEMENTING_PIPELINE_ID,
  SMALL_FEATURE_PIPELINE_ID,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
} from "./domain.ts";
import { validatePipelineReport } from "./plan-contract.ts";
import { assessExecutionEvidence } from "./execution-evidence-assessment.ts";
import { assessImplementationEvidence } from "./implementation-evidence-assessment.ts";

const identity = {
  base: "base",
  head: "head",
  diffDigest: "stable",
  revision: 1,
};
function report(overrides: Partial<AuditFinalReport> = {}) {
  return {
    reportType: "audit-synthesis-final",
    mode: "initial",
    baseSha: identity.base,
    headSha: identity.head,
    integratedRoles: [],
    findings: [],
    closureResults: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: {
      capturedAfterExecutor: true,
      workspaceChanged: false,
      statusBefore: { state: "available", value: "clean" },
      statusAfter: { state: "available", value: "clean" },
      dirtyDiffAfter: { state: "available", value: "" },
      combinedDiffAfter: { state: "available", value: "" },
      summary: "Source remained stable.",
    },
    summary: "Bounded review completed.",
    ...overrides,
  } satisfies AuditFinalReport;
}
function coverage(auditReport: AuditFinalReport) {
  return assessImplementationEvidence({
    definition: AUDIT_PIPELINE_ID,
    state: "final",
    auditReport,
    reviewedIdentity: identity,
    finalIdentity: identity,
  })[0]?.status;
}
const check = {
  claim: "Additional browser probe",
  reason: "Outside closure scope",
  requiredCheck: "Run isolated browser probe",
};

test("modern implementation reports allow a verified no-change outcome without weakening historical contracts", () => {
  const text = JSON.stringify({
    summary: "Required behavior already works",
    changedPaths: [],
    checks: ["Existing focused behavior tests passed"],
    assumptions: [],
    unresolvedItems: [],
  });
  assert.deepEqual(
    validatePipelineReport(
      IMPLEMENTING_PIPELINE_ID,
      SMALL_FEATURE_IMPLEMENTER_ROLE,
      text,
    ),
    [],
  );
  assert.notDeepEqual(
    validatePipelineReport(
      SMALL_FEATURE_PIPELINE_ID,
      SMALL_FEATURE_IMPLEMENTER_ROLE,
      text,
    ),
    [],
  );
  assert.notDeepEqual(
    validatePipelineReport(
      IMPLEMENTING_PIPELINE_ID,
      SMALL_FEATURE_IMPLEMENTER_ROLE,
      JSON.stringify({
        summary: "No evidence",
        changedPaths: [],
        checks: [],
        assumptions: [],
        unresolvedItems: [],
      }),
    ),
    [],
  );
});

test("audit check classification preserves required evidence and optional follow-ups", () => {
  assert.equal(coverage(report({ unprovenChecks: [check] })), "unproven");
  assert.equal(
    coverage(
      report({ unprovenChecks: [{ ...check, requirement: "required" }] }),
    ),
    "unproven",
  );
  for (const requirement of ["follow_up", "not_applicable"] as const) {
    assert.equal(
      coverage(report({ unprovenChecks: [{ ...check, requirement }] })),
      "passed",
    );
    assert.equal(
      Check(auditTrackReportSchema("audit-functional-correctness"), {
        track: "audit-functional-correctness",
        findings: [],
        unprovenChecks: [{ ...check, requirement }],
      }),
      true,
    );
  }
  assert.equal(
    Check(auditTrackReportSchema("audit-functional-correctness"), {
      track: "audit-functional-correctness",
      findings: [],
      unprovenChecks: [{ ...check, requirement: "waived" }],
    }),
    false,
  );
});

test("closure acceptance reflects blocker dispositions, not just empty findings", () => {
  for (const [status, expected] of [
    ["closed", "passed"],
    ["open", "failed"],
    ["unproven", "unproven"],
  ] as const) {
    assert.equal(
      coverage(
        report({
          mode: "closure",
          closureResults: [
            {
              blockerId: "AUD-001",
              closureCondition: "One start per run",
              status,
              evidence: "Executed bounded lifecycle fixture.",
            },
          ],
        }),
      ),
      expected,
    );
  }
});

test("cleanup is inapplicable only for complete non-graph runs without cleanup operations", () => {
  for (const [featureGraphRequired, completeness, expected] of [
    [false, "complete", "not_applicable"],
    [true, "complete", "unproven"],
    [false, "incomplete", "unproven"],
  ] as const) {
    const assessed = assessExecutionEvidence({
      events: [],
      graphEvents: [],
      state: "final",
      featureGraphRequired,
      completeness,
    });
    assert.equal(
      assessed.criteria.find(({ id }) => id === "cleanup-policy")?.status,
      expected,
    );
  }
});
