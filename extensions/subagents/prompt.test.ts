import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentSpawnResult,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

const spawnResult = buildSubagentSpawnResult({
  id: "sa-1",
  title: "review",
  harness: "pi",
  modelLabel: "provider/model",
  cwd: "/tmp/project",
});

const modelFacingSpawnText = [
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  ...SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  spawnResult,
].join("\n");

test("spawn guidance makes automatic follow-up turns explicit", () => {
  assert.match(modelFacingSpawnText, /delivered automatically/);
  assert.match(
    modelFacingSpawnText,
    /trigger(?:s| a) (?:new |a )?follow-up parent turn|trigger a new parent turn/,
  );
  assert.match(modelFacingSpawnText, /end the current turn/);
  assert.match(modelFacingSpawnText, /leave the overall task pending/);
});

test("spawn guidance rejects blocking waits and does not advertise wait", () => {
  assert.match(modelFacingSpawnText, /Do not wait or poll/);
  assert.match(modelFacingSpawnText, /sleep/);
  assert.ok(!modelFacingSpawnText.includes("subagent_wait"));
});
