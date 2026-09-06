import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { graphPreviewRun } from "./__fixtures__/graph-preview.ts";
import { featureExecutionRows } from "./feature-progress.ts";
import {
  PipelineDashboard,
  pipelineRowPrefixes,
  buildPipelineRows,
} from "./dashboard.ts";

test("nested sequences retain order and parallel completion waits for every descendant", () => {
  const run = graphPreviewRun();
  assert.ok(run.featureGraph);
  const rows = featureExecutionRows(run.featureGraph);
  const byKey = new Map(rows.map((row) => [row.key, row]));
  assert.equal(
    byKey.get("parallel:02")?.label,
    "02 after 01: parallel [1/2 branches]",
  );
  assert.equal(
    byKey.get("parallel:02.A.2")?.label,
    "02.A.2 after 02.A.1: parallel [2/2 branches]",
  );
  assert.equal(
    byKey.get("migrate-data")?.label,
    "02.B.2 after 02.B.1: migrate-data · running · attempt 1",
  );
  assert.equal(
    byKey.get("implement-generation")?.label,
    "03 after 02: implement-generation · waiting · attempt 0",
  );
  assert.equal(
    byKey.get("parallel:05")?.label,
    "05 after 04: parallel [0/2 branches]",
  );
  assert.deepEqual(
    rows.filter((row) => row.kind === "task").map((row) => row.taskId),
    run.featureGraph.tasks.map((task) => task.id),
  );
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
  for (const status of [
    "provisional",
    "failed",
    "cancelled",
    "waiting",
    "satisfied_without_changes",
  ] as const) {
    const updated: NonNullable<typeof run.featureGraph> = {
      ...run.featureGraph,
      tasks: run.featureGraph.tasks.map((task) =>
        task.id === "migrate-data" ? { ...task, status } : task,
      ),
    };
    const group = featureExecutionRows(updated).find(
      (row) => row.key === "parallel:02",
    );
    assert.equal(
      group?.label,
      `02 after 01: parallel [${status === "satisfied_without_changes" ? 2 : 1}/2 branches]`,
    );
  }
});

test("tree connectors preserve ancestor continuations and reset at new definitions", () => {
  const depths = [0, 1, 2, 3, 4, 4, 3, 2, 1, 2, 0, 1];
  assert.deepEqual(pipelineRowPrefixes(depths.map((depth) => ({ depth }))), [
    "",
    "├─ ",
    "│  ├─ ",
    "│  │  ├─ ",
    "│  │  │  ├─ ",
    "│  │  │  └─ ",
    "│  │  └─ ",
    "│  └─ ",
    "└─ ",
    "   └─ ",
    "",
    "└─ ",
  ]);
});

test("dashboard renders bounded frames, keeps selection after updates and opens the selected task", () => {
  let snapshot = graphPreviewRun();
  let listener = () => {};
  let unsubscribed = false;
  let renders = 0;
  let picked: string | null | undefined;
  const selection = { key: `feature:${snapshot.id}:migrate-data`, index: 0 };
  const host = {
    terminal: { rows: 22 },
    requestRender() {
      renders++;
    },
  };
  const dashboard = new PipelineDashboard(
    host,
    { fg: (_color, text) => text, bold: (text) => text },
    {
      matches: (data, key) =>
        (data === "\r" && key === "tui.select.confirm") ||
        (data === "\u001b" && key === "tui.select.cancel"),
    },
    {
      list: () => [snapshot],
      get: () => snapshot,
      subscribe: (callback) => {
        listener = callback;
        return () => {
          unsubscribed = true;
          return true;
        };
      },
      cancelRun: async () => {
        throw new Error("Unexpected cancellation");
      },
      cancelChild: async () => {
        throw new Error("Unexpected cancellation");
      },
    },
    selection,
    new Set([snapshot.id]),
    (value) => {
      picked = value;
    },
  );
  try {
    for (const width of [40, 80, 120, 180]) {
      const lines = dashboard.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.length <= host.terminal.rows);
      assert.ok(
        lines.some((line) => stripVTControlCharacters(line).includes("02.B.2")),
      );
    }
    assert.ok(snapshot.featureGraph);
    snapshot = {
      ...snapshot,
      featureGraph: {
        ...snapshot.featureGraph,
        tasks: snapshot.featureGraph.tasks.map((task) =>
          task.id === "migrate-data" ? { ...task, status: "validated" } : task,
        ),
      },
    };
    listener();
    assert.equal(renders, 1);
    const lines = dashboard.render(180);
    assert.ok(lines.some((line) => line.includes("parallel [2/2 branches]")));
    const rows = buildPipelineRows([snapshot], new Set([snapshot.id]));
    assert.equal(rows[selection.index]?.key, selection.key);
    dashboard.handleInput("\r");
    assert.equal(picked, `task:${snapshot.id}:migrate-data`);
    assert.equal(unsubscribed, true);
  } finally {
    dashboard.dispose();
  }
});
