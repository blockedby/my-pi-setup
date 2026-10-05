import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  applySubagentProfile,
  canonicalPiModelKey,
  createQuotaAdmission,
  NON_PI_QUOTA,
  PI_MODEL_QUOTAS,
  profileNames,
  quotaKey,
  quotaLimit,
  resolvePiModel,
  SUBAGENT_PROFILES,
} from "./src/policy.ts";
import {
  appendProfileSystemPrompt,
  childExcludedToolNames,
} from "./src/backends/pi.ts";
import { CHILD_EXCLUDED_TOOL_NAMES } from "../shared/child-session.ts";

const roles = ["explore", "implement", "review"] as const;
const choices = [
  "openai-codex/gpt-6.1-sol",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-astra",
  "custom/task-model",
];

test("role defaults choose Pi and task-appropriate models independently", () => {
  for (const role of roles) {
    const resolved = applySubagentProfile(role, {});
    assert.equal(resolved.harness, "pi");
    assert.ok("role" in resolved && "readOnly" in resolved);
    assert.equal(resolved.role, role);
    assert.equal(resolved.readOnly, role !== "implement");
    assert.equal(
      resolved.model,
      role === "explore"
        ? "openai-codex/gpt-6-luna"
        : "openai-codex/gpt-6.1-sol",
    );
    assert.equal(
      resolved.reasoningEffort,
      role === "explore" ? "max" : "medium",
    );
  }
});

test("every profile accepts model and effort overrides without changing role semantics", () => {
  for (const profile of profileNames()) {
    const defaults = applySubagentProfile(profile, {});
    for (const model of choices) {
      for (const reasoningEffort of ["off", "medium", "high", "max"] as const) {
        const resolved = applySubagentProfile(profile, {
          harness: "pi",
          model,
          reasoningEffort,
        });
        assert.deepEqual(resolved, { ...defaults, model, reasoningEffort });
      }
      assert.deepEqual(applySubagentProfile(profile, { model }), {
        ...defaults,
        model,
      });
    }
    assert.deepEqual(
      applySubagentProfile(profile, { reasoningEffort: "off" }),
      {
        ...defaults,
        reasoningEffort: "off",
      },
    );
    for (const harness of ["claude", "codex"] as const) {
      assert.throws(
        () => applySubagentProfile(profile, { harness, model: "custom" }),
        /requires the Pi harness.*incompatible/,
      );
    }
  }
});

test("compatibility aliases share canonical roles with current model defaults", () => {
  const aliases = [
    ["luna-explore", "explore", "gpt-6-luna", "max"],
    ["luna-worker", "implement", "gpt-6-luna", "max"],
    ["sol-worker", "implement", "gpt-6.1-sol", "medium"],
  ] as const;
  for (const [alias, role, id, effort] of aliases) {
    assert.deepEqual(applySubagentProfile(alias, {}), {
      ...SUBAGENT_PROFILES[role],
      model: `openai-codex/${id}`,
      reasoningEffort: effort,
    });
  }
});

test("profile-free callers retain native harness defaults and custom selection", () => {
  for (const harness of ["pi", "claude", "codex"] as const) {
    assert.deepEqual(applySubagentProfile(undefined, { harness }), {
      harness,
      systemPrompt: undefined,
    });
    const options = {
      harness,
      model: "custom-model",
      reasoningEffort: "high" as const,
    };
    assert.deepEqual(applySubagentProfile(undefined, options), {
      ...options,
      systemPrompt: undefined,
    });
  }
  assert.throws(
    () => applySubagentProfile(undefined, {}),
    /harness is required/,
  );
});

test("model resolution supports current choices, legacy IDs, custom models and ambiguity errors", () => {
  const models = [
    ...Object.keys(PI_MODEL_QUOTAS),
    "custom/task-model",
    "other/task-model",
  ].map((key) => {
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
      contextWindow: 300_000,
      maxTokens: 128_000,
    } satisfies Model<Api>;
  });
  const registry = {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
  };
  for (const model of models) {
    assert.strictEqual(
      resolvePiModel(registry, `${model.provider}/${model.id}`, undefined),
      model,
    );
    assert.strictEqual(resolvePiModel(registry, undefined, model), model);
    assert.strictEqual(resolvePiModel(registry, model.id, model), model);
    if (model.provider === "openai-codex") {
      assert.strictEqual(resolvePiModel(registry, model.id, undefined), model);
    }
  }
  assert.equal(resolvePiModel(registry, undefined, undefined), undefined);
  assert.throws(
    () => resolvePiModel(registry, "task-model", undefined),
    /multiple providers/,
  );
  assert.throws(
    () => resolvePiModel(registry, "unknown/model", undefined),
    /Unknown model/,
  );
});

test("current and legacy identities share family quotas while other models remain supported", () => {
  for (const [key, limit] of Object.entries(PI_MODEL_QUOTAS)) {
    const [provider, id] = key.split("/");
    assert.equal(quotaLimit(canonicalPiModelKey({ provider, id })), limit);
  }
  for (const [legacy, current] of [
    ["gpt-5.6-sol", "gpt-6.1-sol"],
    ["gpt-5.6-luna", "gpt-6-luna"],
    ["gpt-5.6-astra", "gpt-6-astra"],
  ]) {
    assert.equal(
      canonicalPiModelKey({ provider: "openai-codex", id: legacy }),
      `openai-codex/${current}`,
    );
  }
  assert.equal(quotaKey("pi", undefined), "pi-unresolved");
  assert.equal(
    quotaKey("pi", { provider: "fixture", id: "gpt-6-luna" }),
    "pi-unresolved",
  );
  assert.equal(quotaKey("claude", undefined), "non-pi");
  assert.equal(quotaKey("codex", undefined), "non-pi");
  assert.equal(NON_PI_QUOTA, 4);
  assert.deepEqual(PI_MODEL_QUOTAS, {
    "openai-codex/gpt-6.1-sol": 4,
    "openai-codex/gpt-6-luna": 16,
    "openai-codex/gpt-6-astra": 4,
    "openai-codex/gpt-5.6-sol": 4,
    "openai-codex/gpt-5.6-terra": 8,
    "openai-codex/gpt-5.6-luna": 16,
  });
});

test("quota reservations are synchronous, count active work, and release independently", () => {
  const admission = createQuotaAdmission();
  const sol = "openai-codex/gpt-6.1-sol";
  const luna = "openai-codex/gpt-6-luna";
  assert.equal(admission.tryReserve(sol, 3), true);
  assert.equal(admission.tryReserve(sol, 3), false);
  assert.equal(admission.reserved(sol), 1);
  assert.equal(admission.tryReserve(luna, 15), true);
  admission.release(sol);
  assert.equal(admission.reserved(sol), 0);
  assert.equal(admission.reserved(luna), 1);
  assert.equal(admission.tryReserve(sol, 4), false);
  assert.equal(admission.tryReserve(sol, 3), true);
  admission.release(luna);
});

test("read-only roles exclude explicit mutators while retaining checks; implementation has normal tools", () => {
  for (const profile of profileNames()) {
    const excluded = childExcludedToolNames(profile);
    for (const name of CHILD_EXCLUDED_TOOL_NAMES)
      assert.ok(excluded.includes(name));
    for (const tool of ["edit", "write", "apply_patch_codex", "codex_task"]) {
      assert.equal(
        excluded.includes(tool),
        SUBAGENT_PROFILES[profile].readOnly,
      );
    }
    for (const tool of [
      "bash",
      "read",
      "rg",
      "fd",
      "bg_start",
      "codemode",
      "mcp",
    ]) {
      assert.equal(excluded.includes(tool), false);
    }
  }
  assert.deepEqual(childExcludedToolNames(), [...CHILD_EXCLUDED_TOOL_NAMES]);
});

test("profile guidance appends without replacing discovered prompts", () => {
  const base = ["project guidance", "settings guidance"];
  for (const role of roles) {
    const guidance = applySubagentProfile(role, {}).systemPrompt;
    assert.deepEqual(appendProfileSystemPrompt(base, guidance), [
      ...base,
      guidance,
    ]);
  }
  assert.deepEqual(appendProfileSystemPrompt(base, undefined), base);
});
