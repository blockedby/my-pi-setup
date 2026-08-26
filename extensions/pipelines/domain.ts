import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";

export const FEATURE_PIPELINE_ID = "feature-pipeline" as const;
export const SMALL_FEATURE_PIPELINE_ID = "small-feature-pipeline" as const;
export const PLAN_PIPELINE_ID = "plan-pipeline" as const;
export const PIPELINE_DEFINITION_IDS = [
  FEATURE_PIPELINE_ID,
  SMALL_FEATURE_PIPELINE_ID,
  PLAN_PIPELINE_ID,
] as const;
export type PipelineDefinitionId = (typeof PIPELINE_DEFINITION_IDS)[number];

export const SOL_MODEL = "openai-codex/gpt-5.6-sol";
export const LUNA_MODEL = "openai-codex/gpt-5.6-luna";
export const TERRA_MODEL = "openai-codex/gpt-5.6-terra";

export const PIPELINE_STAGES = [
  "discover",
  "build",
  "audit",
  "audit-resolve",
  "final-audit",
  "final-resolve",
  "complete",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const SMALL_FEATURE_PIPELINE_STAGES = [
  "build",
  "final-audit",
  "final-resolve",
  "complete",
] as const satisfies ReadonlyArray<PipelineStage>;

export const FEATURE_PIPELINE_CHILD_ROLES = [
  "discover-problem",
  "discover-outcome",
  "discover-context",
  "discover-user-scenarios",
  "discover-product-precedents",
  "audit-feature-outcome",
  "audit-logic-invariants",
  "audit-functional-correctness",
  "audit-reliability-regressions",
  "final-audit",
] as const;

export const SMALL_FEATURE_PIPELINE_CHILD_ROLES = [
  "implement-small-feature",
  "audit-small-feature",
] as const;

export const PLAN_PIPELINE_DISCOVERY_ROLES = [
  "discover-goal-outcomes",
  "discover-frontend-scope",
  "discover-backend-scope",
  "discover-devops-scope",
  "discover-testing-strategy",
] as const;

export const PLAN_PIPELINE_AUDIT_ROLES = [
  "audit-product-traceability",
  "audit-decomposition-dag",
  "audit-cross-layer-integration",
  "audit-test-release-reliability",
] as const;

export const PLAN_PIPELINE_CHILD_ROLES = [
  ...PLAN_PIPELINE_DISCOVERY_ROLES,
  ...PLAN_PIPELINE_AUDIT_ROLES,
  "final-audit",
] as const;

// Backward-compatible alias for feature-pipeline callers and tests.
export const PIPELINE_CHILD_ROLES = FEATURE_PIPELINE_CHILD_ROLES;
export type FeaturePipelineChildRole =
  (typeof FEATURE_PIPELINE_CHILD_ROLES)[number];
export type SmallFeaturePipelineChildRole =
  (typeof SMALL_FEATURE_PIPELINE_CHILD_ROLES)[number];
export type PlanPipelineChildRole = (typeof PLAN_PIPELINE_CHILD_ROLES)[number];
export type PipelineChildRole =
  | FeaturePipelineChildRole
  | SmallFeaturePipelineChildRole
  | PlanPipelineChildRole;

export interface PipelineDefinition {
  readonly id: PipelineDefinitionId;
  readonly title: string;
  readonly rootTitle: string;
  readonly childRoles: ReadonlyArray<PipelineChildRole>;
}

export const PIPELINE_DEFINITIONS: ReadonlyArray<PipelineDefinition> = [
  {
    id: FEATURE_PIPELINE_ID,
    title: "Feature pipeline",
    rootTitle: "Feature pipeline Sol",
    childRoles: FEATURE_PIPELINE_CHILD_ROLES,
  },
  {
    id: SMALL_FEATURE_PIPELINE_ID,
    title: "Small feature pipeline",
    rootTitle: "Small feature pipeline Sol",
    childRoles: SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  },
  {
    id: PLAN_PIPELINE_ID,
    title: "Plan pipeline",
    rootTitle: "Plan pipeline Sol",
    childRoles: PLAN_PIPELINE_CHILD_ROLES,
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
  return PLAN_PIPELINE_CHILD_ROLES;
}

export function stagesForDefinition(
  id: PipelineDefinitionId,
): ReadonlyArray<PipelineStage> {
  return id === SMALL_FEATURE_PIPELINE_ID
    ? SMALL_FEATURE_PIPELINE_STAGES
    : PIPELINE_STAGES;
}

export function initialStageForDefinition(id: PipelineDefinitionId) {
  return id === SMALL_FEATURE_PIPELINE_ID ? "build" : "discover";
}

export function roleBelongsToDefinition(
  definition: PipelineDefinitionId,
  role: PipelineChildRole,
) {
  return (rolesForDefinition(definition) as ReadonlyArray<string>).includes(
    role,
  );
}

export interface PipelineCompletionFacts {
  readonly outcome: string;
  readonly planPath?: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
  readonly git: ReadonlyArray<string>;
  readonly reports: ReadonlyArray<string>;
  readonly unresolvedItems: ReadonlyArray<string>;
  readonly workingDir: string;
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
  readonly agents: ReadonlyArray<AgentNodeSnapshot>;
}

export interface PipelineRunRequest {
  readonly workingDir: string;
  readonly task: string;
  readonly pipeline?: PipelineDefinitionId;
}

export interface PipelineHandoff {
  readonly runId: string;
  readonly definition: PipelineDefinitionId;
  readonly status: Exclude<PipelineRunStatus, "starting" | "running">;
  readonly facts: PipelineCompletionFacts;
  readonly error?: string;
}

export function modelForRole(role: PipelineChildRole) {
  return role === "final-audit" || role === "audit-small-feature"
    ? TERRA_MODEL
    : LUNA_MODEL;
}

export function titleForRole(role: PipelineChildRole) {
  return role
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
