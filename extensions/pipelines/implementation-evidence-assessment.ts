import type { AuditFinalReport } from "./audit-segment.ts";
import {
  FEATURE_PIPELINE_ID,
  PLAN_PIPELINE_ID,
  type PipelineDefinitionId,
} from "./domain.ts";
import type { FeatureCanonicalPlan } from "./feature-planning.ts";
import type { FeatureTaskSnapshot } from "./feature-task-runtime.ts";
import type {
  AcceptanceCriterion,
  AcceptanceIdentity,
} from "./run-acceptance.ts";

const TASK_RESULTS_ARTIFACT_ID = "task-results";
const SOL_REVIEW_ARTIFACT_ID = "sol-review";
const AUDIT_REPORT_ARTIFACT_ID = "audit-report";

const VALIDATED_TASK_STATUSES = new Set([
  "validated",
  "satisfied_without_changes",
]);

export interface ImplementationEvidenceAssessmentInput {
  readonly canonicalPlan?: FeatureCanonicalPlan;
  readonly taskResults?: readonly FeatureTaskSnapshot[];
  readonly auditReport?: AuditFinalReport;
  readonly reviewedIdentity?: AcceptanceIdentity;
  readonly finalIdentity?: AcceptanceIdentity;
  readonly state: "provisional" | "final";
  readonly definition: PipelineDefinitionId;
}

function boundedDetail(value: string) {
  const maximum = 16 * 1024;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function criterion(
  id: string,
  status: AcceptanceCriterion["status"],
  detail: string,
  evidenceRefs: ReadonlyArray<string> = [],
) {
  return {
    id,
    status,
    evidenceRefs: [...evidenceRefs],
    detail: boundedDetail(detail),
  } satisfies AcceptanceCriterion;
}

/**
 * The revision identifies the observation in the evidence journal, not the
 * reviewed source state. It is expected to change as terminal evidence is
 * appended, so source identity compares base, HEAD, and worktree digest.
 */
function sameSourceIdentity(
  left: AcceptanceIdentity,
  right: AcceptanceIdentity,
) {
  return (
    left.base === right.base &&
    left.head === right.head &&
    left.diffDigest === right.diffDigest
  );
}

function auditMatchesIdentity(
  report: AuditFinalReport,
  identity: AcceptanceIdentity,
) {
  return report.baseSha === identity.base && report.headSha === identity.head;
}

function identityIssue(
  input: ImplementationEvidenceAssessmentInput,
  report: AuditFinalReport | undefined,
) {
  const reviewed = input.reviewedIdentity;
  const final = input.finalIdentity;

  if (!reviewed) {
    return "The immutable reviewed identity is unavailable.";
  }
  if (input.state === "final" && !final) {
    return "The immutable final identity is unavailable.";
  }
  if (final && !sameSourceIdentity(reviewed, final)) {
    return "The final identity differs from the reviewed identity; this helper has no proven resolution model for changed final state.";
  }
  if (report && !auditMatchesIdentity(report, reviewed)) {
    return "The final audit report does not identify the immutable reviewed state.";
  }
  return undefined;
}

function nonFeatureIdentityIssue(
  input: ImplementationEvidenceAssessmentInput,
  report: AuditFinalReport,
) {
  const reviewed = input.reviewedIdentity;
  const final = input.finalIdentity;
  if (!reviewed) {
    return "The immutable reviewed identity is unavailable.";
  }
  if (input.state === "final" && !final) {
    return "The immutable final identity is unavailable.";
  }
  if (final && !sameSourceIdentity(reviewed, final)) {
    return "The final identity differs from the reviewed identity; audit coverage cannot be transferred without proven resolution evidence.";
  }
  if (!auditMatchesIdentity(report, reviewed)) {
    return "The explicit audit report does not identify the supplied immutable reviewed state.";
  }
  return undefined;
}

function mappedSnapshots(
  snapshots: ReadonlyArray<FeatureTaskSnapshot>,
  acceptanceId: string,
) {
  return snapshots.filter((snapshot) => {
    const capsule = snapshot.capsule;
    return Boolean(
      capsule &&
      capsule.taskId === snapshot.id &&
      Array.isArray(capsule.acceptanceRefs) &&
      capsule.acceptanceRefs.includes(acceptanceId),
    );
  });
}

function duplicateIds(values: ReadonlyArray<string>) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function checkEvidence(snapshot: FeatureTaskSnapshot) {
  const capsule = snapshot.capsule;
  if (
    !capsule ||
    capsule.taskId !== snapshot.id ||
    !Array.isArray(capsule.checks)
  ) {
    return {
      status: "unproven" as const,
      detail: "The mapped snapshot has no valid declared check capsule.",
    };
  }

  const checks = capsule.checks;
  const duplicateCheckIds = duplicateIds(checks.map(({ id }) => id));
  if (duplicateCheckIds.length > 0) {
    return {
      status: "unproven" as const,
      detail: `The mapped snapshot has duplicate declared check IDs (${duplicateCheckIds.slice(0, 8).join(", ")}).`,
    };
  }

  const requiredChecks = checks.filter(({ required }) => required);
  if (requiredChecks.length === 0) {
    return {
      status: "unproven" as const,
      detail: "The mapped snapshot declares no required check evidence.",
    };
  }

  if (!Array.isArray(snapshot.checks)) {
    return {
      status: "unproven" as const,
      detail: "The mapped snapshot has no executed check results.",
    };
  }

  const resultIds = snapshot.checks.map(({ checkId }) => checkId);
  const duplicateResultIds = duplicateIds(resultIds);
  if (duplicateResultIds.length > 0) {
    return {
      status: "unproven" as const,
      detail: `The mapped snapshot has duplicate current check results (${duplicateResultIds.slice(0, 8).join(", ")}).`,
    };
  }

  for (const definition of requiredChecks) {
    const matches = snapshot.checks.filter(
      (result) => result.checkId === definition.id,
    );
    const result = matches[0];
    if (
      matches.length !== 1 ||
      !result ||
      result.required !== true ||
      result.command !== definition.command ||
      result.cwd !== definition.cwd ||
      result.purpose !== definition.purpose
    ) {
      return {
        status: "unproven" as const,
        detail: `Required check ${definition.id} has no unambiguous matching execution evidence.`,
      };
    }
    if (result.status === "failed") {
      return {
        status: "failed" as const,
        detail: `Required check ${definition.id} has failed execution evidence.`,
      };
    }
    if (
      result.status !== "passed" ||
      result.exitCode !== 0 ||
      !Array.isArray(result.changedPaths) ||
      result.changedPaths.length > 0
    ) {
      return {
        status: "unproven" as const,
        detail: `Required check ${definition.id} was not proven as a clean passing execution.`,
      };
    }
  }

  return {
    status: "passed" as const,
    detail: `All ${requiredChecks.length} required declared check(s) have matching passing execution evidence.`,
  };
}

function taskEvidence(
  snapshots: ReadonlyArray<FeatureTaskSnapshot>,
  acceptanceId: string,
) {
  const mapped = mappedSnapshots(snapshots, acceptanceId);
  if (mapped.length === 0) {
    return {
      status: "unproven" as const,
      detail: `No task or review snapshot capsule maps acceptance ${acceptanceId} through acceptanceRefs.`,
      mapped,
    };
  }

  const outcomes = mapped.map((snapshot) => {
    if (snapshot.status === "failed") {
      return {
        status: "failed" as const,
        detail: `Mapped task ${snapshot.id} has failed status.`,
      };
    }
    if (!VALIDATED_TASK_STATUSES.has(snapshot.status)) {
      return {
        status: "unproven" as const,
        detail: `Mapped task ${snapshot.id} is ${snapshot.status}, not validated.`,
      };
    }
    return checkEvidence(snapshot);
  });

  const failed = outcomes.find(({ status }) => status === "failed");
  if (failed) return { ...failed, mapped };
  const unproven = outcomes.find(({ status }) => status === "unproven");
  if (unproven) return { ...unproven, mapped };
  return {
    status: "passed" as const,
    detail: `${mapped.length} mapped validated task/review snapshot(s) have complete required check evidence.`,
    mapped,
  };
}

function auditOutcome(report: AuditFinalReport) {
  const findings = Array.isArray(report.findings) ? report.findings : undefined;
  const unprovenChecks = Array.isArray(report.unprovenChecks)
    ? report.unprovenChecks
    : undefined;
  const unresolvedConflicts = Array.isArray(report.unresolvedConflicts)
    ? report.unresolvedConflicts
    : undefined;
  if (!findings || !unprovenChecks || !unresolvedConflicts) {
    return {
      status: "unproven" as const,
      detail: "The final audit report is malformed or incomplete.",
    };
  }
  if (findings.length > 0) {
    return {
      status: "failed" as const,
      detail: `The final audit reported ${findings.length} finding(s) for the reviewed state; acceptance is conservatively failed because findings are not linked to canonical acceptance IDs.`,
    };
  }
  if (unprovenChecks.length > 0 || unresolvedConflicts.length > 0) {
    return {
      status: "unproven" as const,
      detail: `The final audit contains ${unprovenChecks.length} unproven check(s) and ${unresolvedConflicts.length} unresolved conflict(s).`,
    };
  }
  return {
    status: "passed" as const,
    detail:
      "The final audit contains no findings, unproven checks, or unresolved conflicts.",
  };
}

function evidenceRefs(
  input: ImplementationEvidenceAssessmentInput,
  mapped: ReadonlyArray<FeatureTaskSnapshot>,
) {
  return [
    ...(input.taskResults !== undefined ? [TASK_RESULTS_ARTIFACT_ID] : []),
    ...(mapped.some(({ kind }) => kind === "final-review")
      ? [SOL_REVIEW_ARTIFACT_ID]
      : []),
    ...(input.auditReport ? [AUDIT_REPORT_ARTIFACT_ID] : []),
  ];
}

function assessFeatureImplementationEvidence(
  input: ImplementationEvidenceAssessmentInput,
) {
  const plan = input.canonicalPlan;
  if (!plan) {
    return [
      criterion(
        "feature-implementation",
        "unproven",
        "The feature pipeline has no canonical plan, so no canonical acceptance IDs can be mapped to implementation evidence.",
        [
          ...(input.taskResults !== undefined
            ? [TASK_RESULTS_ARTIFACT_ID]
            : []),
          ...(input.auditReport ? [AUDIT_REPORT_ARTIFACT_ID] : []),
        ],
      ),
    ];
  }

  const snapshots = input.taskResults ?? [];
  const identityFailure = identityIssue(input, input.auditReport);
  const auditFailure =
    input.state === "final" && !input.auditReport
      ? "No final audit report evidence is available for the final feature assessment."
      : undefined;
  const audit = input.auditReport ? auditOutcome(input.auditReport) : undefined;

  return plan.acceptance.map(({ id }) => {
    const task = taskEvidence(snapshots, id);
    const refs = evidenceRefs(input, task.mapped);
    if (identityFailure) {
      return criterion(id, "unproven", identityFailure, refs);
    }
    if (auditFailure) {
      return criterion(id, "unproven", auditFailure, refs);
    }
    if (audit?.status === "failed") {
      return criterion(id, "failed", audit.detail, refs);
    }
    if (task.status !== "passed") {
      return criterion(id, task.status, task.detail, refs);
    }
    if (audit?.status === "unproven") {
      return criterion(id, "unproven", audit.detail, refs);
    }
    return criterion(
      id,
      "passed",
      `${task.detail} The immutable reviewed${input.state === "final" ? "/final source identity matches, and final audit coverage is clear." : " source identity is available; final audit coverage remains pending in this provisional assessment."}`,
      refs,
    );
  });
}

function assessNonFeatureImplementationEvidence(
  input: ImplementationEvidenceAssessmentInput,
) {
  if (input.definition === PLAN_PIPELINE_ID || !input.auditReport) {
    return [
      criterion(
        "feature-implementation",
        "not_applicable",
        input.definition === PLAN_PIPELINE_ID
          ? "Plan delivery does not define feature implementation acceptance criteria."
          : `No canonical feature plan or explicit audit coverage report was supplied for ${input.definition}; feature implementation acceptance is not applicable here.`,
      ),
    ];
  }

  const report = input.auditReport;
  const identityFailure = nonFeatureIdentityIssue(input, report);
  if (identityFailure) {
    return [
      criterion("audit-coverage", "unproven", identityFailure, [
        AUDIT_REPORT_ARTIFACT_ID,
      ]),
    ];
  }
  const audit = auditOutcome(report);
  return [
    criterion("audit-coverage", audit.status, audit.detail, [
      AUDIT_REPORT_ARTIFACT_ID,
    ]),
  ];
}

export function assessImplementationEvidence(
  input: ImplementationEvidenceAssessmentInput,
) {
  return input.definition === FEATURE_PIPELINE_ID
    ? assessFeatureImplementationEvidence(input)
    : assessNonFeatureImplementationEvidence(input);
}
