import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { SUBAGENT_SPAWN_PARAMETERS } from "./index.ts";
import { SUBAGENT_SPAWN_PROMPT_GUIDELINES } from "./src/prompt.ts";

test("parent guidance decomposes Luna work into parallel owned scopes", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");

  assert.match(guidance, /exactly one bounded question or deliverable/);
  assert.match(guidance, /explicit list of files it may edit/);
  assert.match(guidance, /must not edit files outside its assigned edit scope/);
  assert.match(
    guidance,
    /schemas\/contracts, validators, fixtures\/tests, and documentation as separate scopes/,
  );
  assert.match(guidance, /compact pseudocode sketch/);
  assert.match(guidance, /Example: for a new feature/);
  assert.match(guidance, /same parallel wave, up to eight/);
  assert.match(guidance, /Do not serialize independent Luna work/);
  assert.match(guidance, /conflict resolution, and result integration/);
});

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
