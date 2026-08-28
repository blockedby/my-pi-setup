import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";

export const PIPELINE_NAME_MAX_LENGTH = 64;
export const PIPELINE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){2,4}$/;
export const PIPELINE_ID_ATTEMPTS = 8;

export function assertPipelineName(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > PIPELINE_NAME_MAX_LENGTH ||
    !PIPELINE_NAME_PATTERN.test(value)
  ) {
    throw new Error(
      `pipeline_name must be 3–5 lowercase kebab-case words, start with a letter, contain only lowercase letters/digits, and be at most ${PIPELINE_NAME_MAX_LENGTH} characters; no trimming or normalization is applied.`,
    );
  }
  return value;
}

export function isCanonicalPipelineRunId(value: string, pipelineName: string) {
  return (
    value.startsWith(`${pipelineName}-`) &&
    /^[a-f0-9]{8}$/.test(value.slice(pipelineName.length + 1))
  );
}

export const FEATURE_PIPELINE_ID = "feature-pipeline" as const;
export const SMALL_FEATURE_PIPELINE_ID = "small-feature-pipeline" as const;
export const PLAN_PIPELINE_ID = "plan-pipeline" as const;
export const AUDIT_PIPELINE_ID = "audit-pipeline" as const;
export const PIPELINE_DEFINITION_IDS = [
  FEATURE_PIPELINE_ID,
  SMALL_FEATURE_PIPELINE_ID,
  PLAN_PIPELINE_ID,
  AUDIT_PIPELINE_ID,
] as const;
export type PipelineDefinitionId = (typeof PIPELINE_DEFINITION_IDS)[number];

export const SOL_MODEL = "openai-codex/gpt-5.6-sol";
export const LUNA_MODEL = "openai-codex/gpt-5.6-luna";
export const TERRA_MODEL = "openai-codex/gpt-5.6-terra";

export function pipelineThinkingLevel(model: string) {
  return model === LUNA_MODEL ? "medium" : "high";
}

export const PIPELINE_STAGES = [
  "discover",
  "build",
  "audit",
  "audit-resolve",
  "final-audit",
  "final-resolve",
  "complete",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number] | "synthesize";

export const PLAN_PIPELINE_STAGES = [
  "discover",
  "synthesize",
  "complete",
] as const satisfies ReadonlyArray<PipelineStage>;
export type PlanPipelineStage = (typeof PLAN_PIPELINE_STAGES)[number];

export const SMALL_FEATURE_PIPELINE_STAGES = [
  "build",
  "final-audit",
  "final-resolve",
  "complete",
] as const satisfies ReadonlyArray<PipelineStage>;

export const AUDIT_PIPELINE_STAGES = [
  "audit",
  "complete",
] as const satisfies ReadonlyArray<PipelineStage>;

// Terra remains available for explicit/manual direct-subagent escalation. It is
// intentionally absent from every automatic pipeline definition.
export const FINAL_AUDIT_ROLE = "final-audit" as const;
export const AUDIT_SYNTHESIS_ROLE = "audit-synthesis" as const;

export const FEATURE_PIPELINE_DISCOVERY_ROLES = [
  "discover-problem",
  "discover-outcome",
  "discover-context",
  "discover-user-scenarios",
  "discover-product-precedents",
] as const;
export type FeaturePipelineDiscoveryRole =
  (typeof FEATURE_PIPELINE_DISCOVERY_ROLES)[number];

export const FEATURE_OUTCOME_AUDIT_ROLE = "audit-feature-outcome" as const;
export const FEATURE_LOGIC_AUDIT_ROLE = "audit-logic-invariants" as const;
export const FEATURE_CORRECTNESS_AUDIT_ROLE =
  "audit-functional-correctness" as const;
export const FEATURE_RELIABILITY_AUDIT_ROLE =
  "audit-reliability-regressions" as const;
export const EXECUTOR_AUDIT_ROLE = "audit-executor" as const;

/** The pre-final feature and small-feature audit wave remains four static tracks. */
export const STATIC_LUNA_AUDIT_ROLES = [
  FEATURE_OUTCOME_AUDIT_ROLE,
  FEATURE_LOGIC_AUDIT_ROLE,
  FEATURE_CORRECTNESS_AUDIT_ROLE,
  FEATURE_RELIABILITY_AUDIT_ROLE,
] as const;
export type StaticLunaAuditRole = (typeof STATIC_LUNA_AUDIT_ROLES)[number];

/** Reusable standalone/embedded audit segment contributors. */
export const AUDIT_SEGMENT_LUNA_ROLES = [
  ...STATIC_LUNA_AUDIT_ROLES,
  EXECUTOR_AUDIT_ROLE,
] as const;
export type PipelineLunaAuditRole = (typeof AUDIT_SEGMENT_LUNA_ROLES)[number];

export const FEATURE_PIPELINE_CHILD_ROLES = [
  ...FEATURE_PIPELINE_DISCOVERY_ROLES,
  ...AUDIT_SEGMENT_LUNA_ROLES,
  AUDIT_SYNTHESIS_ROLE,
] as const;

export const SMALL_FEATURE_IMPLEMENTER_ROLE =
  "implement-small-feature" as const;

export const SMALL_FEATURE_PIPELINE_CHILD_ROLES = [
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  ...STATIC_LUNA_AUDIT_ROLES,
] as const;

export const PLAN_PIPELINE_DISCOVERY_ROLES = [
  "discover-requirements-boundaries",
  "discover-architecture-responsibilities",
  "discover-contracts-invariants",
  "discover-reuse-simplicity",
  "discover-quality-operations",
  "discover-external-evidence",
] as const;
export type PlanPipelineDiscoveryRole =
  (typeof PLAN_PIPELINE_DISCOVERY_ROLES)[number];
export const PLAN_PIPELINE_SYNTHESIS_ROLE = "plan-synthesis" as const;

export const PLAN_PIPELINE_CHILD_ROLES = PLAN_PIPELINE_DISCOVERY_ROLES;

export const AUDIT_PIPELINE_CHILD_ROLES = [
  ...AUDIT_SEGMENT_LUNA_ROLES,
] as const;

// Backward-compatible alias for feature-pipeline callers and tests.
export const PIPELINE_CHILD_ROLES = FEATURE_PIPELINE_CHILD_ROLES;
export type FeaturePipelineChildRole =
  (typeof FEATURE_PIPELINE_CHILD_ROLES)[number];
export type SmallFeaturePipelineChildRole =
  (typeof SMALL_FEATURE_PIPELINE_CHILD_ROLES)[number];
export type PlanPipelineChildRole = (typeof PLAN_PIPELINE_CHILD_ROLES)[number];
export type AuditPipelineChildRole =
  (typeof AUDIT_PIPELINE_CHILD_ROLES)[number];
export type PipelineChildRole =
  | FeaturePipelineChildRole
  | SmallFeaturePipelineChildRole
  | PlanPipelineChildRole
  | AuditPipelineChildRole
  | typeof PLAN_PIPELINE_SYNTHESIS_ROLE
  | typeof FINAL_AUDIT_ROLE;

export interface PipelineChildContextPolicy {
  readonly gitEvidence?: true;
  readonly priorReportRole?: PipelineChildRole;
}

type PipelineChildContextPolicies = Readonly<
  Record<
    PipelineDefinitionId,
    Readonly<Partial<Record<PipelineChildRole, PipelineChildContextPolicy>>>
  >
>;

export const PIPELINE_CHILD_CONTEXT_POLICIES: PipelineChildContextPolicies = {
  [FEATURE_PIPELINE_ID]: {
    [FEATURE_OUTCOME_AUDIT_ROLE]: { gitEvidence: true },
    [FEATURE_LOGIC_AUDIT_ROLE]: { gitEvidence: true },
    [FEATURE_CORRECTNESS_AUDIT_ROLE]: { gitEvidence: true },
    [FEATURE_RELIABILITY_AUDIT_ROLE]: { gitEvidence: true },
    [EXECUTOR_AUDIT_ROLE]: { gitEvidence: true },
  },
  [SMALL_FEATURE_PIPELINE_ID]: {
    [FEATURE_OUTCOME_AUDIT_ROLE]: {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    },
    [FEATURE_LOGIC_AUDIT_ROLE]: {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    },
    [FEATURE_CORRECTNESS_AUDIT_ROLE]: {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    },
    [FEATURE_RELIABILITY_AUDIT_ROLE]: {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    },
  },
  [PLAN_PIPELINE_ID]: {},
  [AUDIT_PIPELINE_ID]: {
    [FEATURE_OUTCOME_AUDIT_ROLE]: { gitEvidence: true },
    [FEATURE_LOGIC_AUDIT_ROLE]: { gitEvidence: true },
    [FEATURE_CORRECTNESS_AUDIT_ROLE]: { gitEvidence: true },
    [FEATURE_RELIABILITY_AUDIT_ROLE]: { gitEvidence: true },
    [EXECUTOR_AUDIT_ROLE]: { gitEvidence: true },
  },
};

export function childContextPolicyFor(
  definition: PipelineDefinitionId,
  role: PipelineChildRole,
) {
  return PIPELINE_CHILD_CONTEXT_POLICIES[definition][role] ?? {};
}

export interface PipelineDefinition {
  readonly id: PipelineDefinitionId;
  readonly title: string;
  readonly rootTitle: string;
  readonly rootModel: typeof SOL_MODEL | typeof LUNA_MODEL;
  readonly childRoles: ReadonlyArray<PipelineChildRole>;
}

export const PIPELINE_DEFINITIONS: ReadonlyArray<PipelineDefinition> = [
  {
    id: FEATURE_PIPELINE_ID,
    title: "Feature pipeline",
    rootTitle: "Feature pipeline post-promotion audit and remediation root",
    // The controller creates this fixed Luna/xHIGH root only after Best-of-3
    // synthesis is promoted; implementation candidates are controller-owned.
    rootModel: LUNA_MODEL,
    childRoles: FEATURE_PIPELINE_CHILD_ROLES,
  },
  {
    id: SMALL_FEATURE_PIPELINE_ID,
    title: "Small feature pipeline",
    rootTitle: "Small feature pipeline Luna",
    rootModel: LUNA_MODEL,
    childRoles: SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  },
  {
    id: PLAN_PIPELINE_ID,
    title: "Plan pipeline",
    rootTitle: "Plan pipeline Luna synthesis",
    rootModel: LUNA_MODEL,
    childRoles: PLAN_PIPELINE_CHILD_ROLES,
  },
  {
    id: AUDIT_PIPELINE_ID,
    title: "Audit pipeline",
    rootTitle: "Audit pipeline Luna synthesizer",
    rootModel: LUNA_MODEL,
    childRoles: AUDIT_PIPELINE_CHILD_ROLES,
  },
];

export function definitionFor(id: PipelineDefinitionId) {
  return PIPELINE_DEFINITIONS.find((definition) => definition.id === id)!;
}

export function rolesForDefinition(id: PipelineDefinitionId) {
  if (id === FEATURE_PIPELINE_ID) return FEATURE_PIPELINE_CHILD_ROLES;
  if (id === SMALL_FEATURE_PIPELINE_ID) {
    return SMALL_FEATURE_PIPELINE_CHILD_ROLES;
  }
  if (id === PLAN_PIPELINE_ID) return PLAN_PIPELINE_CHILD_ROLES;
  return AUDIT_PIPELINE_CHILD_ROLES;
}

export function stagesForDefinition(
  id: PipelineDefinitionId,
): ReadonlyArray<PipelineStage> {
  if (id === SMALL_FEATURE_PIPELINE_ID) return SMALL_FEATURE_PIPELINE_STAGES;
  if (id === AUDIT_PIPELINE_ID) return AUDIT_PIPELINE_STAGES;
  if (id === PLAN_PIPELINE_ID) return PLAN_PIPELINE_STAGES;
  return PIPELINE_STAGES;
}

export function initialStageForDefinition(id: PipelineDefinitionId) {
  if (id === SMALL_FEATURE_PIPELINE_ID) return "build";
  if (id === AUDIT_PIPELINE_ID) return "audit";
  return "discover";
}

export function roleBelongsToDefinition(
  definition: PipelineDefinitionId,
  role: PipelineChildRole,
) {
  return (rolesForDefinition(definition) as ReadonlyArray<string>).includes(
    role,
  );
}

export type AuditMode = "initial" | "closure";

export interface AuditPriorBlocker {
  readonly id: string;
  readonly closureCondition: string;
}

export interface AuditPipelineInput {
  readonly mode: AuditMode;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly priorBlockers?: ReadonlyArray<AuditPriorBlocker>;
  readonly remediationDiff?: string;
  readonly touchedInvariants?: ReadonlyArray<string>;
}

export interface PipelineFinalFindingResolution {
  readonly findingId: string;
  readonly disposition: "fixed" | "rejected";
  readonly evidence: string;
  readonly verification: ReadonlyArray<string>;
}

export interface PipelineCompletionFacts {
  readonly outcome: string;
  readonly plan?: string;
  readonly planPath?: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
  readonly git: ReadonlyArray<string>;
  readonly reports: ReadonlyArray<string>;
  readonly unresolvedItems: ReadonlyArray<string>;
  readonly finalFindingResolutions?: ReadonlyArray<PipelineFinalFindingResolution>;
  readonly workingDir: string;
  readonly auditReport?: import("./audit-segment.ts").AuditFinalReport;
}

export type PipelineRunStatus =
  "starting" | "running" | "completed" | "failed" | "cancelled";

export interface PipelineRunSnapshot {
  readonly id: string;
  readonly definition: PipelineDefinitionId;
  readonly workingDir: string;
  readonly stage: PipelineStage;
  readonly status: PipelineRunStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
  readonly rootId?: string;
  readonly completion?: PipelineCompletionFacts;
  readonly auditSegment?: import("./audit-segment.ts").AuditSegmentProgress;
  readonly agents: ReadonlyArray<AgentNodeSnapshot>;
}

export interface PipelineRunRequest {
  readonly pipelineName: string;
  readonly workingDir: string;
  readonly task: string;
  readonly pipeline?: PipelineDefinitionId;
  /** Feature requires true; other definitions retain their scoped policy. */
  readonly gitCommit?: boolean;
  readonly audit?: AuditPipelineInput;
  /** Required explicitly for plan-pipeline; null means terminal-only delivery. */
  readonly planPath?: string | null;
}

export type PipelineCommitRole = PipelineChildRole | "pipeline-root";

/** The sole role that may receive ordinary-commit authority in each supported definition. */
export const PIPELINE_COMMIT_AUTHORITY_ROLES: Readonly<
  Partial<Record<PipelineDefinitionId, PipelineCommitRole>>
> = {
  [FEATURE_PIPELINE_ID]: "pipeline-root",
  [SMALL_FEATURE_PIPELINE_ID]: SMALL_FEATURE_IMPLEMENTER_ROLE,
};

export function pipelineCommitAuthorityRole(definition: PipelineDefinitionId) {
  return PIPELINE_COMMIT_AUTHORITY_ROLES[definition];
}

export function assertPipelineGitCommitSupported(
  definition: PipelineDefinitionId,
  requested: boolean,
) {
  if (definition === FEATURE_PIPELINE_ID && !requested) {
    throw new Error(
      "feature-pipeline requires explicit git_commit: true; false or omission is rejected.",
    );
  }
  if (requested && !pipelineCommitAuthorityRole(definition)) {
    throw new Error(
      `git_commit is only supported for feature-pipeline and small-feature-pipeline; received ${definition}.`,
    );
  }
}

export interface PipelineHandoff {
  readonly runId: string;
  readonly definition: PipelineDefinitionId;
  readonly status: Exclude<PipelineRunStatus, "starting" | "running">;
  readonly facts: PipelineCompletionFacts;
  readonly error?: string;
}

export function modelForRole(role: PipelineChildRole) {
  return role === FINAL_AUDIT_ROLE ? TERRA_MODEL : LUNA_MODEL;
}

export function titleForRole(role: PipelineChildRole) {
  return role
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
