import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  resolveSubscriptionModel,
  subscriptionModelHint,
} from "./codex-subscription.ts";
import {
  applySubagentProfile,
  canonicalPiModelKey,
  createQuotaAdmission,
  profileNames,
  quotaLimit,
  resolvePiModel,
} from "../subagents/src/policy.ts";

const providers = [
  "openai-codex",
  "openai-codex-2",
  "openai-codex-3",
  "custom",
];
const ids = [
  "gpt-6.1-sol",
  "gpt-6-luna",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-astra",
  "gpt-5.6-terra",
  "custom/id",
];
const models = providers.flatMap((provider) =>
  ids.map(
    (id) =>
      ({
        provider,
        id,
        name: id,
        api: "test",
        baseUrl: "",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 300_000,
        maxTokens: 128_000,
      }) satisfies Model<Api>,
  ),
);
const registry = {
  find: (provider: string, id: string) =>
    models.find((model) => model.provider === provider && model.id === id),
  getAll: () => models,
};

test("profile defaults and explicit base overrides retain the chosen model on the parent subscription", () => {
  for (const provider of providers.slice(0, 3)) {
    const parent = { provider, id: "gpt-6-astra" };
    for (const profile of profileNames()) {
      const choice = applySubagentProfile(profile, {});
      const resolved = resolvePiModel(registry, choice.model, parent);
      assert.equal(resolved?.provider, provider);
      assert.equal(resolved?.id, choice.model?.split("/")[1]);
    }
    // The explicit provider-qualified override used by the screenshot case.
    for (const id of ids) {
      assert.strictEqual(
        resolvePiModel(registry, `openai-codex/${id}`, parent),
        registry.find(provider, id),
      );
      assert.strictEqual(
        resolvePiModel(
          registry,
          id.includes("/") ? `${provider}/${id}` : id,
          parent,
        ),
        registry.find(provider, id),
      );
    }
    assert.strictEqual(
      resolvePiModel(registry, undefined, parent),
      registry.find(provider, parent.id),
    );
  }
});

test("numbered overrides are exact and non-Codex providers never inherit Codex accounts", () => {
  for (const parentProvider of [
    ...providers,
    undefined,
    "openai-codex-custom",
  ]) {
    for (const provider of [
      "openai-codex-3",
      "custom",
      "openai",
      "openai-codex-custom",
    ]) {
      const hint = `${provider}/custom/id`;
      assert.equal(subscriptionModelHint(hint, parentProvider), hint);
    }
    assert.strictEqual(
      resolveSubscriptionModel(
        registry,
        "openai-codex-3/gpt-6-luna",
        parentProvider,
      ),
      registry.find("openai-codex-3", "gpt-6-luna"),
    );
  }
  for (const provider of ["custom", "openai", "openai-codex-custom"]) {
    assert.equal(
      subscriptionModelHint("openai-codex/gpt-6-luna", provider),
      "openai-codex/gpt-6-luna",
    );
  }
  assert.strictEqual(
    resolvePiModel(registry, "custom/custom/id", {
      provider: "openai-codex-2",
      id: ids[0],
    }),
    registry.find("custom", "custom/id"),
  );
});

test("bare custom IDs retain unambiguous provider resolution with a Codex parent", () => {
  const custom = { ...models[0], provider: "custom", id: "task-model" };
  const registry = {
    find: () => undefined,
    getAll: () => [custom],
  };
  assert.strictEqual(
    resolvePiModel(registry, custom.id, {
      provider: "openai-codex-2",
      id: "gpt-6-luna",
    }),
    custom,
  );
});

test("missing inherited Codex models fail closed even when the base account has them", () => {
  const calls: string[] = [];
  const missing = {
    ...registry,
    find: (provider: string, id: string) => {
      calls.push(`${provider}/${id}`);
      return provider === "openai-codex-2"
        ? undefined
        : registry.find(provider, id);
    },
  };
  const parent = { provider: "openai-codex-2", id: "gpt-6-luna" };
  for (const hint of ["openai-codex/gpt-6-luna", "gpt-6-luna", undefined]) {
    calls.length = 0;
    assert.throws(
      () => resolvePiModel(missing, hint, parent),
      /openai-codex-2\/gpt-6-luna/,
    );
    assert.deepEqual(calls, ["openai-codex-2/gpt-6-luna"]);
  }
  assert.throws(
    () =>
      resolveSubscriptionModel(
        missing,
        "openai-codex/gpt-6-luna",
        parent.provider,
      ),
    /No fallback/,
  );
  assert.strictEqual(
    resolvePiModel(missing, "openai-codex-3/gpt-6-luna", parent),
    registry.find("openai-codex-3", parent.id),
  );
});

test("direct family admission counts current and legacy models across subscriptions together", () => {
  for (const [ids, limit] of [
    [["gpt-6.1-sol", "gpt-5.6-sol"], 4],
    [["gpt-6-luna", "gpt-5.6-luna"], 16],
    [["gpt-6-astra", "gpt-5.6-astra"], 4],
    [["gpt-5.6-terra"], 8],
  ] as const) {
    const admission = createQuotaAdmission();
    const canonical = canonicalPiModelKey({
      provider: "openai-codex",
      id: ids[0],
    });
    for (let index = 0; index < limit + 3; index++) {
      const key = canonicalPiModelKey({
        provider: providers[index % 3],
        id: ids[index % ids.length],
      });
      assert.equal(key, canonical);
      assert.equal(quotaLimit(key), limit);
      assert.equal(admission.tryReserve(key, 0), index < limit);
    }
    admission.release(canonical);
    assert.equal(admission.tryReserve(canonical, 0), true);
  }
  assert.equal(
    canonicalPiModelKey({ provider: "custom", id: "gpt-6-luna" }),
    "pi-unresolved",
  );
});
