import type { Static } from "typebox";
import {
  AUDIT_SEGMENT_LUNA_ROLES,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_PLAN_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  type FeaturePipelineDiscoveryRole,
  type FeaturePlanRole,
  type PipelineLunaAuditRole,
  type PlanPipelineDiscoveryRole,
} from "./domain.ts";
import {
  FEATURE_DISCOVERY_COVERAGE,
  type FeatureDiscoveryEvidence,
  type FeatureDiscoveryReportV2,
} from "./discovery-report.ts";
import type { auditTrackReportSchema } from "./audit-segment.ts";
import {
  planDiscoveryCoverage,
  type PlanDiscoveryReport,
} from "./plan-discovery-report.ts";
import type {
  FeatureCandidatePlan,
  FeatureCanonicalPlan,
  FeatureExecutionGraph,
  FeaturePlanCandidateRole,
} from "./feature-planning.ts";

export const FEATURE_CANONICAL_PLAN_EXAMPLE_ROLE =
  "feature-canonical-plan" as const;
export const FEATURE_EXECUTION_GRAPH_EXAMPLE_ROLE =
  "feature-execution-graph" as const;
export const PLAN_SUBMISSION_EXAMPLE_ROLE = "plan-synthesis" as const;

export type PlanSubmissionExample = { readonly plan: string };
type PlanDiscoveryEvidenceExample = PlanDiscoveryReport["evidence"][number];
type PlanDiscoveryCoverageItem = {
  readonly criterion: ReturnType<typeof planDiscoveryCoverage>[number];
  readonly status: "covered" | "partial" | "not_applicable" | "unknown";
  readonly conclusion: string;
  readonly evidence: ReadonlyArray<PlanDiscoveryEvidenceExample>;
  readonly implications: ReadonlyArray<string>;
};
export type PlanDiscoverySubmissionExample = Omit<
  PlanDiscoveryReport,
  "coverage"
> & {
  readonly coverage: ReadonlyArray<PlanDiscoveryCoverageItem>;
};
export type AuditTrackSubmissionExample = Static<
  ReturnType<typeof auditTrackReportSchema>
>;
export type AuditTrackFindingExample =
  AuditTrackSubmissionExample["findings"][number];

export type SubmissionExampleRole =
  | FeaturePipelineDiscoveryRole
  | PlanPipelineDiscoveryRole
  | PipelineLunaAuditRole
  | FeaturePlanRole
  | FeaturePlanCandidateRole
  | typeof FEATURE_CANONICAL_PLAN_EXAMPLE_ROLE
  | typeof FEATURE_EXECUTION_GRAPH_EXAMPLE_ROLE
  | typeof PLAN_SUBMISSION_EXAMPLE_ROLE;

export type SubmissionExample =
  | FeatureDiscoveryReportV2
  | PlanDiscoverySubmissionExample
  | AuditTrackSubmissionExample
  | FeatureCandidatePlan
  | FeatureCanonicalPlan
  | FeatureExecutionGraph
  | PlanSubmissionExample;

const illustrativeFeatureEvidence = {
  kind: "code",
  reference: "example://repository-evidence",
  detail:
    "Illustrative evidence only; replace with an observed repository fact.",
} satisfies FeatureDiscoveryEvidence;

const illustrativePlanEvidence = {
  kind: "code",
  reference: "example://repository-evidence",
  detail:
    "Illustrative evidence only; replace with an observed repository fact.",
} satisfies PlanDiscoveryEvidenceExample;

function featureDiscoveryExample(role: FeaturePipelineDiscoveryRole) {
  const candidateAcceptanceCriteria =
    role === "discover-outcome" || role === "discover-user-scenarios"
      ? [
          {
            scenario: "The primary example scenario occurs.",
            expected: "The observable outcome matches the task.",
            verification: "Run the focused behavior check.",
            evidence: [illustrativeFeatureEvidence],
          },
          {
            scenario: "The alternate example scenario occurs.",
            expected: "The alternate outcome remains bounded.",
            verification: "Run the alternate-path check.",
            evidence: [illustrativeFeatureEvidence],
          },
        ]
      : [];
  return {
    reportType: "feature-discovery-v2",
    role,
    applicability: "applicable",
    summary: "Compact illustrative discovery report.",
    coverage: FEATURE_DISCOVERY_COVERAGE[role].map((criterion) => ({
      criterion,
      status: "covered",
      conclusion: "The criterion has illustrative repository evidence.",
      evidence: [illustrativeFeatureEvidence],
      implications: [],
    })),
    candidateAcceptanceCriteria,
    unknowns: [],
    constraints: [],
  } satisfies FeatureDiscoveryReportV2;
}

export const FEATURE_DISCOVERY_EXAMPLES = {
  "discover-problem": featureDiscoveryExample("discover-problem"),
  "discover-outcome": featureDiscoveryExample("discover-outcome"),
  "discover-context": featureDiscoveryExample("discover-context"),
  "discover-user-scenarios": featureDiscoveryExample("discover-user-scenarios"),
  "discover-product-precedents": featureDiscoveryExample(
    "discover-product-precedents",
  ),
} satisfies Readonly<
  Record<FeaturePipelineDiscoveryRole, FeatureDiscoveryReportV2>
>;

function planDiscoveryExample(role: PlanPipelineDiscoveryRole) {
  return {
    reportType: "plan-discovery-v1",
    role,
    applicability: "applicable",
    summary: "Compact illustrative planning discovery report.",
    coverage: planDiscoveryCoverage(role).map((criterion) => ({
      criterion,
      status: "covered",
      conclusion: "The criterion has illustrative repository evidence.",
      evidence: [illustrativePlanEvidence],
      implications: [],
    })),
    evidence: [illustrativePlanEvidence],
    unknowns: [],
    constraints: [],
  } satisfies PlanDiscoverySubmissionExample;
}

export const PLAN_DISCOVERY_EXAMPLES = {
  "discover-requirements-boundaries": planDiscoveryExample(
    "discover-requirements-boundaries",
  ),
  "discover-architecture-responsibilities": planDiscoveryExample(
    "discover-architecture-responsibilities",
  ),
  "discover-contracts-invariants": planDiscoveryExample(
    "discover-contracts-invariants",
  ),
  "discover-reuse-simplicity": planDiscoveryExample(
    "discover-reuse-simplicity",
  ),
  "discover-quality-operations": planDiscoveryExample(
    "discover-quality-operations",
  ),
  "discover-external-evidence": planDiscoveryExample(
    "discover-external-evidence",
  ),
} satisfies Readonly<
  Record<PlanPipelineDiscoveryRole, PlanDiscoverySubmissionExample>
>;

function auditTrackExample(role: PipelineLunaAuditRole) {
  if (role === EXECUTOR_AUDIT_ROLE) {
    return {
      track: role,
      findings: [],
      unprovenChecks: [],
      executedChecks: [],
      workspaceChangesObserved: [],
    } satisfies AuditTrackSubmissionExample;
  }
  return {
    track: role,
    findings: [],
    unprovenChecks: [],
  } satisfies AuditTrackSubmissionExample;
}

export const AUDIT_SUBMISSION_EXAMPLES = {
  "audit-feature-outcome": auditTrackExample("audit-feature-outcome"),
  "audit-logic-invariants": auditTrackExample("audit-logic-invariants"),
  "audit-functional-correctness": auditTrackExample(
    "audit-functional-correctness",
  ),
  "audit-reliability-regressions": auditTrackExample(
    "audit-reliability-regressions",
  ),
  "audit-executor": auditTrackExample("audit-executor"),
} satisfies Readonly<
  Record<PipelineLunaAuditRole, AuditTrackSubmissionExample>
>;

function featurePlanCommon() {
  return {
    summary: "Compact illustrative feature plan.",
    decisions: [
      {
        id: "DEC-1",
        title: "Keep the change bounded",
        body: "Use the existing repository boundary for the requested behavior.",
        evidence: [
          {
            reference: "example://repository-evidence",
            finding:
              "Illustrative evidence only; replace with an observed precedent.",
          },
        ],
        rejectedAlternatives: [],
      },
    ],
    changes: [
      {
        id: "CHANGE-1",
        path: "extensions/example.ts",
        symbols: ["example"],
        action: "modify" as const,
        body: "Apply the bounded behavior at the existing boundary.",
        decisionRefs: ["DEC-1"],
        contractRefs: ["INV-1"],
        acceptanceRefs: ["AC-1"],
      },
    ],
    contracts: [
      {
        id: "INV-1",
        title: "Existing boundary remains valid",
        body: "The change preserves the current boundary contract.",
        paths: ["extensions/example.ts"],
      },
    ],
    acceptance: [
      {
        id: "AC-1",
        scenario: "The example behavior is requested.",
        expected: "The bounded behavior is observable.",
        verification: "Run the focused behavior check.",
      },
    ],
    verification: [
      {
        id: "CHECK-1",
        command: "bun run check",
        cwd: ".",
        purpose: "Verify the illustrative contract.",
        proves: ["AC-1", "INV-1"],
        required: true,
      },
    ],
    risks: [],
  };
}

function featureCandidatePlanExample(role: FeaturePlanCandidateRole) {
  return {
    reportType: "feature-plan-candidate-v1",
    role,
    ...featurePlanCommon(),
    blockers: [],
    tradeoffs: ["Prefer the smallest repository-native change."],
  } satisfies FeatureCandidatePlan;
}

export const FEATURE_CANDIDATE_PLAN_EXAMPLES = {
  Minimal: featureCandidatePlanExample("Minimal"),
  Robust: featureCandidatePlanExample("Robust"),
} satisfies Readonly<Record<FeaturePlanCandidateRole, FeatureCandidatePlan>>;

export const FEATURE_PLAN_EXAMPLES = {
  "feature-plan-minimal": FEATURE_CANDIDATE_PLAN_EXAMPLES.Minimal,
  "feature-plan-robust": FEATURE_CANDIDATE_PLAN_EXAMPLES.Robust,
} satisfies Readonly<Record<FeaturePlanRole, FeatureCandidatePlan>>;

export const FEATURE_CANONICAL_PLAN_EXAMPLE = {
  reportType: "feature-canonical-plan-v1",
  ...featurePlanCommon(),
  blockers: [],
  finalRationale:
    "The bounded illustrative plan preserves the existing contract.",
} satisfies FeatureCanonicalPlan;

export const FEATURE_EXECUTION_GRAPH_EXAMPLE = {
  reportType: "feature-execution-graph-v1",
  summary: "Compact illustrative execution graph.",
  baselineChecks: [],
  reviewChecks: [
    {
      id: "review-check",
      command: "bun run check",
      cwd: ".",
      purpose: "Verify the integrated illustrative change.",
      required: true,
    },
  ],
  tasks: [
    {
      id: "implement-example",
      objective: "Implement the bounded example behavior.",
      branchGoal: "Leave the example behavior complete and verified.",
      dependsOn: [],
      context: {
        problem: "The repository needs the requested bounded behavior.",
        repositoryConventions: ["Use existing TypeScript boundaries."],
        relevantDiscovery: ["Illustrative discovery evidence."],
        precedents: [
          {
            path: "extensions/example.ts",
            symbol: "example",
            lesson: "Preserve the existing boundary.",
          },
        ],
        invariants: ["The existing boundary contract remains valid."],
      },
      readPaths: ["extensions/example.ts"],
      writePaths: ["extensions/example.ts"],
      instructions: ["Implement only the requested bounded behavior."],
      implementationSketch: "Modify the existing boundary and verify it.",
      acceptanceRefs: ["AC-1"],
      doneWhen: ["The focused behavior check passes."],
      checks: [
        {
          id: "task-check",
          command: "bun run check",
          cwd: ".",
          purpose: "Verify the task.",
          required: true,
        },
      ],
    },
  ],
} satisfies FeatureExecutionGraph;

export const PLAN_SUBMISSION_EXAMPLE = {
  plan: "# Illustrative plan\n\nReplace this placeholder with the evidence-backed Markdown plan.",
} satisfies PlanSubmissionExample;

export const SUBMISSION_EXAMPLE_ROLES = [
  ...FEATURE_PIPELINE_DISCOVERY_ROLES,
  ...PLAN_PIPELINE_DISCOVERY_ROLES,
  ...AUDIT_SEGMENT_LUNA_ROLES,
  ...FEATURE_PLAN_ROLES,
  "Minimal",
  "Robust",
  FEATURE_CANONICAL_PLAN_EXAMPLE_ROLE,
  FEATURE_EXECUTION_GRAPH_EXAMPLE_ROLE,
  PLAN_SUBMISSION_EXAMPLE_ROLE,
] as const satisfies ReadonlyArray<SubmissionExampleRole>;

const SUBMISSION_EXAMPLES = {
  ...FEATURE_DISCOVERY_EXAMPLES,
  ...PLAN_DISCOVERY_EXAMPLES,
  ...AUDIT_SUBMISSION_EXAMPLES,
  ...FEATURE_PLAN_EXAMPLES,
  ...FEATURE_CANDIDATE_PLAN_EXAMPLES,
  [FEATURE_CANONICAL_PLAN_EXAMPLE_ROLE]: FEATURE_CANONICAL_PLAN_EXAMPLE,
  [FEATURE_EXECUTION_GRAPH_EXAMPLE_ROLE]: FEATURE_EXECUTION_GRAPH_EXAMPLE,
  [PLAN_SUBMISSION_EXAMPLE_ROLE]: PLAN_SUBMISSION_EXAMPLE,
} satisfies Readonly<Record<SubmissionExampleRole, SubmissionExample>>;

export function exampleFor(role: SubmissionExampleRole) {
  return SUBMISSION_EXAMPLES[role];
}

export function renderSubmissionExample(role: SubmissionExampleRole) {
  return JSON.stringify(exampleFor(role));
}
