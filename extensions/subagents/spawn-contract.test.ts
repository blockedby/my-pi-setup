import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { SUBAGENT_SPAWN_PARAMETERS } from "./index.ts";

test("subagent_spawn schema exposes all supported profiles", () => {
  const base = { prompt: "Inspect the repository", name: "inspect" };

  for (const profile of ["luna-explore", "luna-worker", "terra-audit"]) {
    assert.equal(
      Check(SUBAGENT_SPAWN_PARAMETERS, { ...base, profile }),
      true,
      `${profile} should be accepted`,
    );
  }

  assert.equal(
    Check(SUBAGENT_SPAWN_PARAMETERS, {
      ...base,
      profile: "unknown-profile",
    }),
    false,
  );
});
