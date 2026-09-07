import { randomUUID } from "node:crypto";

export interface CleanupEvidence {
  readonly operationId: string;
  readonly resourceId: string;
  readonly resourceType:
    "worktree" | "ref" | "sandbox" | "directory" | "residual";
  readonly resource: string;
  readonly ownership: "controller" | "caller" | "foreign" | "unknown";
  readonly phase: string;
  readonly event: "intent" | "outcome";
  readonly at: number;
  readonly disposition?: "removed" | "retained" | "skipped";
  readonly operationStatus?:
    "succeeded" | "failed" | "timed_out" | "not_attempted";
  readonly reasonCode?: string;
  readonly detail?: string;
  readonly expectedIdentity?: string;
}

/** Sinks must record their own persistence failures without changing cleanup authority. */
export type CleanupEvidenceSink = (record: CleanupEvidence) => void;

export function createCleanupRecorder(
  sink: CleanupEvidenceSink | undefined,
  context: Pick<
    CleanupEvidence,
    | "resourceId"
    | "resourceType"
    | "resource"
    | "ownership"
    | "phase"
    | "expectedIdentity"
  >,
) {
  const operationId = randomUUID();
  const emit = (
    event: "intent" | "outcome",
    result: Partial<
      Pick<
        CleanupEvidence,
        "disposition" | "operationStatus" | "reasonCode" | "detail"
      >
    > = {},
  ) => {
    sink?.({
      ...context,
      operationId,
      event,
      at: Date.now(),
      ...result,
      ...(result.detail === undefined
        ? {}
        : { detail: result.detail.slice(0, 2048) }),
    });
  };
  return {
    intent: () => emit("intent"),
    outcome: (
      result: Required<
        Pick<CleanupEvidence, "disposition" | "operationStatus" | "reasonCode">
      > &
        Pick<CleanupEvidence, "detail">,
    ) => emit("outcome", result),
  };
}
