import assert from "node:assert/strict";
import test from "node:test";
import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";
import {
  buildPipelineRows,
  reconcilePipelineSelection,
  type PipelineSelection,
} from "./dashboard.ts";
import type { PipelineRunSnapshot } from "./domain.ts";
import { handoffText } from "./index.ts";

function agent(
  id: string,
  options: Partial<AgentNodeSnapshot> = {},
): AgentNodeSnapshot {
  return {
    id,
    scopeId: "run-1",
    role: "pipeline-root",
    attempt: 1,
    title: id,
    model: "openai-codex/gpt-5.6-sol",
    cwd: "/tmp/work",
    persistent: true,
    status: "running",
    createdAt: 1,
    finalText: "",
    transcript: [],
    activeTools: [],
    ...options,
  };
}

function pipelineRun(
  id: string,
  agents: ReadonlyArray<AgentNodeSnapshot>,
): PipelineRunSnapshot {
  return {
    id,
    definition: "feature-pipeline",
    workingDir: "/tmp/work",
    stage: "discover",
    status: "running",
    startedAt: 1,
    rootId: "root-1",
    agents,
  };
}

test("nested UI model is definition to run to root, stages, and child attempts", () => {
  const root = agent("root-1");
  const discover = agent("child-1", {
    parentId: root.id,
    role: "discover-problem",
    attempt: 2,
    title: "Problem",
    model: "openai-codex/gpt-5.6-luna",
    persistent: false,
  });
  const rows = buildPipelineRows([pipelineRun("run-1", [root, discover])]);

  assert.equal(rows[0]?.kind, "definition");
  assert.equal(rows[0]?.depth, 0);
  assert.equal(rows[1]?.kind, "run");
  assert.equal(rows[1]?.depth, 1);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => [row.kind, row.depth, row.label]),
    [
      ["definition", 0, "feature-pipeline"],
      ["run", 1, "run-1 · running · /tmp/work"],
      ["agent", 2, "root-1 · running"],
    ],
  );
  const discoverStage = rows.findIndex(
    (row) => row.kind === "stage" && row.stage === "discover",
  );
  assert.ok(discoverStage >= 0);
  assert.deepEqual(
    rows
      .slice(discoverStage, discoverStage + 2)
      .map((row) => [row.kind, row.depth, row.label]),
    [
      ["stage", 2, "discover · current"],
      [
        "agent",
        3,
        "discover-problem · attempt 2 · openai-codex/gpt-5.6-luna · running",
      ],
    ],
  );
});

test("pipeline selection follows a stable nested row and reconciles removal", () => {
  const rows = buildPipelineRows([pipelineRun("run-1", [agent("root-1")])]);
  const target = rows.find(
    (row) => row.kind === "stage" && row.stage === "audit",
  );
  assert.ok(target);
  const selection: PipelineSelection = {
    key: target.key,
    index: rows.indexOf(target),
  };

  const withNewRun = buildPipelineRows([
    pipelineRun("run-2", [agent("root-2", { scopeId: "run-2" })]),
    pipelineRun("run-1", [agent("root-1")]),
  ]);
  reconcilePipelineSelection(selection, withNewRun);
  assert.equal(selection.key, target.key);
  assert.equal(withNewRun[selection.index]?.key, target.key);

  reconcilePipelineSelection(selection, [{ key: "only" }]);
  assert.deepEqual(selection, { key: "only", index: 0 });
  reconcilePipelineSelection(selection, []);
  assert.deepEqual(selection, { key: undefined, index: 0 });
});

test("completion follow-up text is bounded", () => {
  const text = handoffText({
    runId: "run-large",
    definition: "feature-pipeline",
    status: "completed",
    facts: {
      outcome: "x".repeat(100_000),
      changedPaths: [],
      checks: [],
      assumptions: [],
      git: [],
      reports: [],
      unresolvedItems: [],
      workingDir: "/tmp/work",
    },
  });
  assert.ok(Buffer.byteLength(text, "utf8") < 34 * 1024);
  assert.match(text, /handoff truncated/);
});
