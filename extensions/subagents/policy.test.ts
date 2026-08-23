import assert from "node:assert/strict";
import test from "node:test";
import {
  applySubagentProfile,
  canonicalPiModelKey,
  createQuotaAdmission,
  NON_PI_QUOTA,
  PI_MODEL_QUOTAS,
  quotaKey,
  quotaLimit,
  SUBAGENT_PROFILES,
} from "./src/policy.ts";
import { appendProfileSystemPrompt } from "./src/backends/pi.ts";

test("profiles fix Pi models and reasoning", () => {
  assert.deepEqual(applySubagentProfile("luna-explore", {}), {
    ...SUBAGENT_PROFILES["luna-explore"],
  });
  assert.equal(applySubagentProfile("luna-explore", {}).reasoningEffort, "max");
  const worker = applySubagentProfile("luna-worker", {});
  assert.equal(worker.model, "openai-codex/gpt-5.6-luna");
  assert.equal(worker.reasoningEffort, "max");
  assert.equal(
    applySubagentProfile("terra-audit", {}).model,
    "openai-codex/gpt-5.6-terra",
  );
  for (const profile of ["luna-explore", "luna-worker"] as const) {
    for (const conflicting of [
      { harness: "pi" as const },
      { model: "other" },
      { reasoningEffort: "high" as const },
    ]) {
      assert.throws(
        () => applySubagentProfile(profile, conflicting),
        /conflicting explicit values/,
      );
    }
  }
  assert.deepEqual(
    applySubagentProfile(undefined, {
      harness: "pi",
      model: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "medium",
    }),
    {
      harness: "pi",
      model: "openai-codex/gpt-5.6-sol",
      reasoningEffort: "medium",
      systemPrompt: undefined,
    },
  );
  assert.throws(
    () => applySubagentProfile(undefined, {}),
    /harness is required/,
  );
});

test("Pi model identities map to canonical quota keys", () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  assert.equal(canonicalPiModelKey(model), "openai-codex/gpt-5.6-luna");
  assert.equal(quotaKey("pi", model), "openai-codex/gpt-5.6-luna");
  assert.equal(quotaKey("pi", undefined), "pi-unresolved");
  assert.equal(
    quotaKey("pi", { provider: "fixture", id: "other-model" }),
    "pi-unresolved",
  );
});

test("canonical quotas are Sol 4, Terra 8, Luna 16, non-Pi 4", () => {
  assert.deepEqual(PI_MODEL_QUOTAS, {
    "openai-codex/gpt-5.6-sol": 4,
    "openai-codex/gpt-5.6-terra": 8,
    "openai-codex/gpt-5.6-luna": 16,
  });
  assert.equal(quotaLimit("openai-codex/gpt-5.6-sol"), 4);
  assert.equal(quotaLimit("openai-codex/gpt-5.6-terra"), 8);
  assert.equal(quotaLimit("openai-codex/gpt-5.6-luna"), 16);
  assert.equal(NON_PI_QUOTA, 4);
});

test("quota admission is mixed-model, race-safe, and releases failed reservations", () => {
  const admission = createQuotaAdmission();
  const sol = "openai-codex/gpt-5.6-sol" as const;
  const luna = "openai-codex/gpt-5.6-luna" as const;
  assert.equal(
    Array.from({ length: 4 }, () => admission.tryReserve(sol, 0)).filter(
      Boolean,
    ).length,
    4,
  );
  assert.equal(admission.tryReserve(sol, 0), false);
  assert.equal(admission.tryReserve(luna, 0), true);
  admission.release(sol);
  assert.equal(admission.tryReserve(sol, 0), true);
  admission.release(luna);
});

test("profile prompt guidance appends without replacing discovered prompts", () => {
  assert.deepEqual(
    appendProfileSystemPrompt(
      ["from AGENTS.md", "from settings"],
      "Luna guidance",
    ),
    ["from AGENTS.md", "from settings", "Luna guidance"],
  );
});
