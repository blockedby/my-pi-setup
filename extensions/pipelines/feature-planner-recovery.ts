import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { FeatureCommitRange } from "./feature-execution-contract.ts";

/** Planner advice cannot mutate the graph, history, ownership or obligations. */
export interface FeaturePlannerRecoveryRequest {
  readonly taskId: string;
  readonly role: string;
  readonly attempt: number;
  readonly remainingAttempts: number;
  readonly failure: string;
  readonly currentHead: string;
  readonly commitRange?: FeatureCommitRange;
  readonly completedTaskIds: ReadonlyArray<string>;
  readonly unstartedTaskIds: ReadonlyArray<string>;
}

export const featurePlannerRecoveryDecisionSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    taskId: Type.String({ minLength: 1, maxLength: 256 }),
    attempt: Type.Integer({ minimum: 1, maximum: 24 }),
    action: Type.Union([Type.Literal("retry"), Type.Literal("blocked")]),
    message: Type.String({ minLength: 1, maxLength: 8192 }),
  },
  { additionalProperties: false },
);

export type FeaturePlannerRecoveryDecision = Static<
  typeof featurePlannerRecoveryDecisionSchema
>;

export function parseFeaturePlannerRecoveryDecision(
  value: unknown,
  request: FeaturePlannerRecoveryRequest,
) {
  if (!Value.Check(featurePlannerRecoveryDecisionSchema, value))
    throw new Error("Invalid planner recovery decision.");
  if (
    value.taskId !== request.taskId ||
    value.attempt !== request.attempt ||
    !value.message.trim() ||
    (value.action === "retry" && request.remainingAttempts < 1)
  )
    throw new Error(
      "Planner recovery decision does not match the active request.",
    );
  return value;
}
