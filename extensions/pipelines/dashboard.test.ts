import assert from "node:assert/strict";
import test from "node:test";
import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";
import {
  agentIdForPipelineRow,
  buildPipelineRows,
  glyphStatusForPipelineRow,
  reconcilePipelineSelection,
  togglePipelineRunExpansion,
  type PipelineRow,
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
  definition: PipelineRunSnapshot["definition"] = "feature-pipeline",
): PipelineRunSnapshot {
  return {
    id,
    definition,
    workingDir: "/tmp/work",
    stage: "discover",
    status: "running",
    startedAt: 1,
    rootId: "root-1",
    agents,
  };
}

test("runs are collapsed by default with textual and colored summary status", () => {
  const statuses = [
    ["starting", "running"],
    ["running", "running"],
    ["completed", "done"],
    ["failed", "error"],
    ["cancelled", "cancelled"],
  ] as const;
  const rows = buildPipelineRows(
    statuses.map(([status]) => ({
      ...pipelineRun(`run-${status}`, []),
      status,
    })),
  );
  const runRows = rows.filter(
    (row): row is Extract<(typeof rows)[number], { kind: "run" }> =>
      row.kind === "run",
  );

  assert.equal(
    rows.some((row) => row.kind === "stage"),
    false,
  );
  assert.equal(
    rows.some((row) => row.kind === "agent"),
    false,
  );
  assert.deepEqual(
    runRows.map((row) => [row.label, glyphStatusForPipelineRow(row)]),
    statuses.map(([status, glyph]) => [
      `▸ run-${status} · ${status} · /tmp/work`,
      glyph,
    ]),
  );
});

test("only explicitly expanded runs expose selectable descendants", () => {
  const first = pipelineRun("run-1", [agent("root-1")]);
  const second = {
    ...pipelineRun("run-2", [agent("root-2")]),
    rootId: "root-2",
  };
  const rows = buildPipelineRows([first, second], new Set(["run-2"]));

  assert.equal(
    rows.find((row) => row.key === "run:run-1")?.label.startsWith("▸"),
    true,
  );
  assert.equal(
    rows.find((row) => row.key === "run:run-2")?.label.startsWith("▾"),
    true,
  );
  assert.equal(
    rows.some((row) => row.kind === "stage" && row.runId === "run-1"),
    false,
  );
  assert.equal(
    rows.some((row) => row.kind === "stage" && row.runId === "run-2"),
    true,
  );
});

test("run expansion toggles without moving the stable run selection", () => {
  const expandedRunIds = new Set<string>();
  const run = pipelineRun("run-1", [agent("root-1")]);
  const collapsedRows = buildPipelineRows([run], expandedRunIds);
  const runRow = collapsedRows.find((row) => row.kind === "run");
  assert.ok(runRow);
  const selection: PipelineSelection = {
    key: runRow.key,
    index: collapsedRows.indexOf(runRow),
  };

  assert.equal(togglePipelineRunExpansion(expandedRunIds, runRow), true);
  const expandedRows = buildPipelineRows([run], expandedRunIds);
  reconcilePipelineSelection(selection, expandedRows);
  assert.equal(expandedRows[selection.index]?.key, runRow.key);
  assert.equal(
    expandedRows.some((row) => row.kind === "stage"),
    true,
  );

  const expandedRunRow = expandedRows[selection.index];
  assert.ok(expandedRunRow);
  assert.equal(
    togglePipelineRunExpansion(expandedRunIds, expandedRunRow),
    true,
  );
  assert.equal(buildPipelineRows([run], expandedRunIds).length, 4);
  assert.equal(
    togglePipelineRunExpansion(expandedRunIds, {
      key: "definition:feature-pipeline",
      kind: "definition",
      depth: 0,
      label: "feature-pipeline",
    }),
    false,
  );
});

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
  const rows = buildPipelineRows(
    [pipelineRun("run-1", [root, discover])],
    new Set(["run-1"]),
  );

  assert.equal(rows[0]?.kind, "definition");
  assert.equal(rows[0]?.depth, 0);
  assert.equal(rows[1]?.kind, "run");
  assert.equal(rows[1]?.depth, 1);
  assert.deepEqual(
    rows.slice(0, 3).map((row) => [row.kind, row.depth, row.label]),
    [
      ["definition", 0, "feature-pipeline"],
      ["run", 1, "▾ run-1 · running · /tmp/work"],
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
      ["stage", 2, "discover · running"],
      [
        "agent",
        3,
        "discover-problem · attempt 2 · openai-codex/gpt-5.6-luna · running",
      ],
    ],
  );
});

test("running glyph follows the active stage instead of the persistent root", () => {
  const root = agent("root-1");
  const child = agent("child-1", {
    parentId: root.id,
    role: "discover-problem",
    status: "done",
  });
  const rows = buildPipelineRows(
    [{ ...pipelineRun("run-1", [root, child]), stage: "build" }],
    new Set(["run-1"]),
  );
  const rootRow = rows.find(
    (row) => row.kind === "agent" && row.agentId === root.id,
  );
  const childRow = rows.find(
    (row) => row.kind === "agent" && row.agentId === child.id,
  );
  const buildRow = rows.find(
    (row): row is Extract<(typeof rows)[number], { kind: "stage" }> =>
      row.kind === "stage" && row.stage === "build",
  );
  assert.ok(rootRow);
  assert.ok(childRow);
  assert.ok(buildRow);

  assert.equal(glyphStatusForPipelineRow(rootRow), undefined);
  assert.equal(glyphStatusForPipelineRow(childRow), "done");
  assert.equal(glyphStatusForPipelineRow(buildRow), "running");
  assert.equal(buildRow.label, "build · running");
  assert.equal(buildRow.agentId, root.id);
});

test("feature final-resolve stage opens the persistent Sol agent", () => {
  const root = agent("root-1", { status: "running" });
  const run = {
    ...pipelineRun("run-1", [root]),
    stage: "final-resolve" as const,
  };
  const finalResolve = buildPipelineRows([run], new Set([run.id])).find(
    (row): row is Extract<PipelineRow, { kind: "stage" }> =>
      row.kind === "stage" && row.stage === "final-resolve",
  );

  assert.ok(finalResolve);
  assert.equal(agentIdForPipelineRow(finalResolve), root.id);
});

test("dashboard lists all definitions and nests runs under the selected definition", () => {
  assert.deepEqual(
    buildPipelineRows([]).map((row) => [row.kind, row.label]),
    [
      ["definition", "feature-pipeline"],
      ["definition", "small-feature-pipeline"],
      ["definition", "plan-pipeline"],
    ],
  );
  const feature = pipelineRun("feature-run", [agent("feature-root")]);
  const small = {
    ...pipelineRun(
      "small-run",
      [agent("small-root", { scopeId: "small-run" })],
      "small-feature-pipeline",
    ),
    stage: "build" as const,
  };
  const plan = pipelineRun(
    "plan-run",
    [agent("plan-root", { scopeId: "plan-run" })],
    "plan-pipeline",
  );
  const rows = buildPipelineRows([plan, small, feature]);
  const featureDefinition = rows.findIndex(
    (row) => row.key === "definition:feature-pipeline",
  );
  const smallDefinition = rows.findIndex(
    (row) => row.key === "definition:small-feature-pipeline",
  );
  const planDefinition = rows.findIndex(
    (row) => row.key === "definition:plan-pipeline",
  );
  const featureRun = rows.findIndex((row) => row.key === "run:feature-run");
  const smallRun = rows.findIndex((row) => row.key === "run:small-run");
  const planRun = rows.findIndex((row) => row.key === "run:plan-run");

  assert.ok(featureDefinition >= 0);
  assert.ok(smallDefinition > featureDefinition);
  assert.ok(planDefinition > smallDefinition);
  assert.ok(featureRun > featureDefinition && featureRun < smallDefinition);
  assert.ok(smallRun > smallDefinition && smallRun < planDefinition);
  assert.ok(planRun > planDefinition);
});

test("small-feature dashboard shows only its fixed stages and child placement", () => {
  const root = agent("root-1");
  const implementer = agent("luna-1", {
    parentId: root.id,
    role: "implement-small-feature",
    model: "openai-codex/gpt-5.6-luna",
    persistent: true,
    status: "idle",
  });
  const auditor = agent("terra-1", {
    parentId: root.id,
    role: "audit-small-feature",
    model: "openai-codex/gpt-5.6-terra",
    persistent: false,
    status: "done",
  });
  const run = {
    ...pipelineRun(
      "run-1",
      [root, implementer, auditor],
      "small-feature-pipeline",
    ),
    stage: "final-resolve" as const,
  };
  const rows = buildPipelineRows([run], new Set(["run-1"]));
  const stages = rows
    .filter(
      (row): row is Extract<(typeof rows)[number], { kind: "stage" }> =>
        row.kind === "stage" && row.runId === "run-1",
    )
    .map((row) => row.stage);
  assert.deepEqual(stages, [
    "build",
    "final-audit",
    "final-resolve",
    "complete",
  ]);
  assert.equal(
    rows
      .find((row) => row.kind === "agent" && row.agentId === implementer.id)
      ?.key.includes(":build:"),
    true,
  );
  assert.equal(
    rows
      .find((row) => row.kind === "agent" && row.agentId === auditor.id)
      ?.key.includes(":final-audit:"),
    true,
  );
  const finalResolve = rows.find(
    (row): row is Extract<(typeof rows)[number], { kind: "stage" }> =>
      row.kind === "stage" && row.stage === "final-resolve",
  );
  assert.ok(finalResolve);
  assert.equal(finalResolve.agentId, implementer.id);
  assert.equal(agentIdForPipelineRow(finalResolve), implementer.id);
});

test("pipeline selection follows a stable nested row and reconciles removal", () => {
  const rows = buildPipelineRows(
    [pipelineRun("run-1", [agent("root-1")])],
    new Set(["run-1"]),
  );
  const target = rows.find(
    (row) => row.kind === "stage" && row.stage === "audit",
  );
  assert.ok(target);
  const selection: PipelineSelection = {
    key: target.key,
    index: rows.indexOf(target),
  };

  const withNewRun = buildPipelineRows(
    [
      pipelineRun("run-2", [agent("root-2", { scopeId: "run-2" })]),
      pipelineRun("run-1", [agent("root-1")]),
    ],
    new Set(["run-1"]),
  );
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
