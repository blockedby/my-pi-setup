import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
// The selection tool deliberately does not use extension-context capabilities.
const unusedContext = {} as ExtensionToolContext;
import { PIPELINE_MODELS } from "./domain.ts";
import {
  createPipelineModelSelectTool,
  PIPELINE_MODEL_SELECT_PARAMETERS,
  type PipelineModelSelection,
} from "./model-selection.ts";

function fixture() {
  const models = PIPELINE_MODELS.map((key) => {
    const [provider, id] = key.split("/");
    return {
      provider,
      id,
      name: id,
      api: "test",
      baseUrl: "",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272000,
      maxTokens: 128000,
    } satisfies Model<Api>;
  });
  const history = ["original implementation context"];
  const selections: PipelineModelSelection[] = [];
  let current: Model<Api> = models[1];
  let persisted: boolean | undefined;
  const tool = createPipelineModelSelectTool({
    registry: {
      find: (provider, id) =>
        models.find((m) => m.provider === provider && m.id === id),
    },
    session: () => ({
      model: current,
      setModel: async (model, options) => {
        current = model;
        persisted = options?.persist;
      },
    }),
    selected: (value) => selections.push(value),
  });
  return {
    tool,
    history,
    selections,
    get model() {
      return current;
    },
    get persisted() {
      return persisted;
    },
  };
}

test("session model selection preserves context and does not persist global defaults", async () => {
  const f = fixture();
  for (const model of PIPELINE_MODELS) {
    assert.equal(
      Check(PIPELINE_MODEL_SELECT_PARAMETERS, {
        model,
        reason: "Task evidence justifies this model",
      }),
      true,
    );
    await f.tool.execute(
      "choose",
      { model, reason: "Task evidence justifies this model" },
      undefined,
      undefined,
      unusedContext,
    );
    assert.equal(`${f.model.provider}/${f.model.id}`, model);
    assert.equal(f.persisted, false);
    assert.deepEqual(f.history, ["original implementation context"]);
    assert.equal(f.selections.at(-1)?.model, model);
  }
  assert.equal(
    Check(PIPELINE_MODEL_SELECT_PARAMETERS, {
      model: "unknown/model",
      reason: "probe",
    }),
    false,
  );
});

test("model selection rejects unavailable, cancelled and unexplained choices without changing session", async () => {
  const f = fixture();
  await assert.rejects(
    f.tool.execute(
      "choose",
      { model: PIPELINE_MODELS[0], reason: " " },
      undefined,
      undefined,
      unusedContext,
    ),
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    f.tool.execute(
      "choose",
      { model: PIPELINE_MODELS[0], reason: "Complex invariant" },
      abort.signal,
      undefined,
      unusedContext,
    ),
  );
  const unavailable = createPipelineModelSelectTool({
    registry: { find: () => undefined },
    session: () => {
      throw new Error("Should not access session");
    },
    selected: () => {
      throw new Error("Should not record success");
    },
  });
  await assert.rejects(
    unavailable.execute(
      "choose",
      { model: PIPELINE_MODELS[0], reason: "Complex invariant" },
      undefined,
      undefined,
      unusedContext,
    ),
  );
  assert.equal(f.selections.length, 0);
  assert.equal(f.model.id, "gpt-6.1-sol");
});
