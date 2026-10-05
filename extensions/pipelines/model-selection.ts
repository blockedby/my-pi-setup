import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentSession,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PIPELINE_MODELS } from "./domain.ts";

export const PIPELINE_MODEL_SELECT_PARAMETERS = Type.Object(
  {
    model: StringEnum(PIPELINE_MODELS),
    reason: Type.String({ minLength: 1, maxLength: 2048 }),
  },
  { additionalProperties: false },
);

export interface PipelineModelSelection {
  readonly previousModel: string;
  readonly model: string;
  readonly reason: string;
}

/** Switching changes only this session's model, never its role, tools, history
 * or global defaults. SDK selection performs its normal credential validation. */
export function createPipelineModelSelectTool(options: {
  registry: Pick<ModelRegistry, "find">;
  session: () => Pick<AgentSession, "model" | "setModel">;
  selected: (selection: PipelineModelSelection) => void;
}) {
  return defineTool({
    name: "pipeline_model_select",
    label: "Choose pipeline session model",
    description:
      "Choose the model for this session's next requests without losing context or changing role/permissions. Prefer Sol 6.1 for implementation and synthesis, Luna 6 for exploration/simple work, Astra only for justified complex reasoning. Give a task-specific reason. Does not persist global defaults.",
    parameters: PIPELINE_MODEL_SELECT_PARAMETERS,
    async execute(_id, input, signal) {
      if (signal?.aborted) throw new Error("Model selection was cancelled.");
      if (!input.reason.trim())
        throw new Error("Model selection requires a concrete reason.");
      const [provider, id] = input.model.split("/");
      const model = options.registry.find(provider, id);
      if (!model) throw new Error(`Unavailable pipeline model: ${input.model}`);
      const session = options.session();
      const previousModel = session.model
        ? `${session.model.provider}/${session.model.id}`
        : "unselected";
      await session.setModel(model, { persist: false });
      const selection = {
        previousModel,
        model: input.model,
        reason: input.reason.trim(),
      };
      options.selected(selection);
      return {
        content: [{ type: "text", text: JSON.stringify(selection) }],
        details: selection,
      };
    },
  });
}
