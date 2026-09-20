import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { SUBAGENT_SPAWN_PARAMETERS } from "./index.ts";

test("subagent_spawn schema exposes all supported profiles", () => {
  const base = { prompt: "Inspect the repository", name: "inspect" };

  for (const profile of ["luna-explore", "luna-worker", "sol-worker"]) {
    assert.equal(
      Check(SUBAGENT_SPAWN_PARAMETERS, { ...base, profile }),
      true,
      `${profile} should be accepted`,
    );
  }

  for (const profile of ["terra-audit", "unknown-profile"]) {
    assert.equal(Check(SUBAGENT_SPAWN_PARAMETERS, { ...base, profile }), false);
  }
});

test("subagent_spawn retains profile-free harness and model selection", () => {
  for (const harness of ["pi", "claude", "codex"]) {
    assert.equal(
      Check(SUBAGENT_SPAWN_PARAMETERS, {
        prompt: "Implement the scoped task",
        name: "worker",
        harness,
        model: "task-selected-model",
        reasoning_effort: "high",
      }),
      true,
    );
  }
});
