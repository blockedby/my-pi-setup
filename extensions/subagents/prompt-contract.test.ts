import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");

test("subagent guidance defaults nontrivial independent work to parallel Luna waves", () => {
  assert.match(guidance, /Optimize for wall-clock speed/);
  assert.match(guidance, /two or more dependency-ready, independent scopes/);
  assert.match(
    guidance,
    /spawn one self-contained Luna profile per scope in the same parallel wave/,
  );
  assert.match(
    guidance,
    /luna-explore or luna-worker rather than bare Pi\/inherited Sol/,
  );
  assert.match(guidance, /do not serialize independent Luna work/);
});

test("subagent guidance orchestrates nonblocking, bounded Luna waves", () => {
  assert.match(guidance, /lightweight manifest/);
  assert.match(guidance, /scope name\/id, prerequisites, exclusive edit scope/);
  assert.match(guidance, /conclusion and recommended next step/);
  assert.match(
    guidance,
    /exclusive edit scope \(shared read context is allowed\)/,
  );
  assert.match(
    guidance,
    /Treat automatic Luna results as dependency events, not a batch barrier/,
  );
  assert.match(guidance, /do not integrate on the first arrival/);
  assert.match(guidance, /use one status check only when that gate needs it/);
  assert.match(guidance, /concrete unblocked gap or failed scope/);
  assert.match(
    guidance,
    /Inspect claimed paths and validation before depending on a result/,
  );
  assert.match(guidance, /one narrower replacement with the missing input/);
  assert.match(guidance, /unless adversarial comparison is intentional/);
  assert.match(
    guidance,
    /integrated change, a high-risk claim, or conflicting Luna conclusions/,
  );
});

test("subagent guidance keeps local work only for bounded speed-safe exceptions", () => {
  assert.match(guidance, /trivial lookup/);
  assert.match(guidance, /shared decision or overlapping write ownership/);
  assert.match(guidance, /more latency than it saves/);
});

test("subagent description advertises the Luna concurrency quota", () => {
  assert.match(SUBAGENT_SPAWN_TOOL_DESCRIPTION, /Luna 16/);
});
