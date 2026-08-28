import {
  defineTool,
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PipelineRunSnapshot } from "./domain.ts";

export const PIPELINE_CANCEL_MAX_IDS = 32;
const PIPELINE_CANCEL_ERROR_MAX_BYTES = 512;
const PIPELINE_CANCEL_ERROR_MAX_LINES = 4;

export const PIPELINE_CANCEL_PARAMETERS = Type.Object(
  {
    ids: Type.Array(
      Type.String({
        description: "Session-scoped pipeline run id to cancel.",
        minLength: 1,
        maxLength: 256,
      }),
      {
        description:
          'Pipeline run ids to cancel, e.g. ["pipeline-1", "pipeline-2"].',
        minItems: 1,
        maxItems: PIPELINE_CANCEL_MAX_IDS,
        uniqueItems: true,
      },
    ),
  },
  { additionalProperties: false },
);

interface PipelineCancellationController {
  get(runId: string): PipelineRunSnapshot | undefined;
  cancelRun(runId: string): Promise<PipelineRunSnapshot>;
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return truncateHead(message, {
    maxBytes: PIPELINE_CANCEL_ERROR_MAX_BYTES,
    maxLines: PIPELINE_CANCEL_ERROR_MAX_LINES,
  }).content;
}

export async function cancelPipelines(
  controller: PipelineCancellationController,
  ids: ReadonlyArray<string>,
) {
  const results = [];
  for (const id of ids) {
    const run = controller.get(id);
    if (!run) {
      results.push({ id, outcome: "unknown" as const });
      continue;
    }
    if (run.status !== "starting" && run.status !== "running") {
      results.push({
        id,
        outcome: "already-settled" as const,
        status: run.status,
      });
      continue;
    }
    try {
      const cancelled = await controller.cancelRun(id);
      results.push(
        cancelled.status === "cancelled"
          ? { id, outcome: "cancelled" as const, status: cancelled.status }
          : {
              id,
              outcome: "already-settled" as const,
              status: cancelled.status,
            },
      );
    } catch (error) {
      results.push({
        id,
        outcome: "failed" as const,
        error: boundedError(error),
      });
    }
  }
  return results;
}

function formatCancellationResult(
  result: Awaited<ReturnType<typeof cancelPipelines>>[number],
) {
  if (result.outcome === "cancelled") return `Cancelled ${result.id}.`;
  if (result.outcome === "already-settled")
    return `${result.id} was already ${result.status}.`;
  if (result.outcome === "unknown") return `Unknown pipeline id ${result.id}.`;
  return `Failed to cancel ${result.id}: ${result.error}`;
}

export function createPipelineCancellationTool(
  getController: (ctx: ExtensionContext) => PipelineCancellationController,
) {
  return defineTool({
    name: "pipeline_cancel",
    label: "Cancel Pipelines",
    description:
      "Cancel one or more session-scoped pipeline runs in caller order. Active runs use controller-owned cancellation and cleanup; settled and unknown ids are reported without stopping the remaining requests.",
    promptSnippet: "Cancel one or more active pipeline runs",
    promptGuidelines: [
      "Use pipeline_cancel when the user asks to stop known pipeline runs. Pass each run id once; cancellation preserves normal controller-owned cleanup and automatic factual handoffs.",
    ],
    parameters: PIPELINE_CANCEL_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await cancelPipelines(getController(ctx), params.ids);
      return {
        content: [
          {
            type: "text" as const,
            text: results.map(formatCancellationResult).join("\n"),
          },
        ],
        details: { results },
      };
    },
  });
}
