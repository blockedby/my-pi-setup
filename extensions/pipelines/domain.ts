import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";

export const FEATURE_PIPELINE_ID = "feature-pipeline" as const;
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

export const PIPELINE_CHILD_ROLES = [
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
export type PipelineChildRole = (typeof PIPELINE_CHILD_ROLES)[number];

export interface PipelineCompletionFacts {
  readonly outcome: string;
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
  readonly definition: typeof FEATURE_PIPELINE_ID;
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
}

export interface PipelineHandoff {
  readonly runId: string;
  readonly definition: typeof FEATURE_PIPELINE_ID;
  readonly status: Exclude<PipelineRunStatus, "starting" | "running">;
  readonly facts: PipelineCompletionFacts;
  readonly error?: string;
}

export function modelForRole(role: PipelineChildRole) {
  return role === "final-audit" ? TERRA_MODEL : LUNA_MODEL;
}

export function titleForRole(role: PipelineChildRole) {
  return role
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}
