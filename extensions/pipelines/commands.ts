import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PIPELINE_DEFINITION_IDS,
  type PipelineDefinitionId,
} from "./domain.ts";

export function buildPipelineCommandMessage(
  pipeline: PipelineDefinitionId,
  task: string,
) {
  return [
    `Run ${pipeline} using pipeline_run for the task below.`,
    "Follow the repository instructions and pipeline_run requirements, including caller-owned worktree preparation for implementation pipelines. Resolve required launch parameters from the task and conversation; ask only when required information or authorization is missing.",
    task.trim() ||
      "Use the task discussed in this conversation. If no task has been established, ask what to work on.",
  ].join("\n\n");
}

export function registerPipelineCommands(pi: ExtensionAPI) {
  for (const pipeline of PIPELINE_DEFINITION_IDS) {
    pi.registerCommand(`pipelines:${pipeline}`, {
      description: `Run ${pipeline} with an optional task description`,
      handler: async (args) => {
        pi.sendUserMessage(buildPipelineCommandMessage(pipeline, args), {
          deliverAs: "followUp",
        });
      },
    });
  }
}
