import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { PipelineRunSnapshot } from "./domain.ts";
import {
  cancelPipelines,
  createPipelineCancellationTool,
  PIPELINE_CANCEL_MAX_IDS,
  PIPELINE_CANCEL_PARAMETERS,
} from "./cancellation.ts";

function snapshot(
  id: string,
  status: PipelineRunSnapshot["status"],
): PipelineRunSnapshot {
  return {
    id,
    definition: "feature-pipeline",
    workingDir: `/repo/${id}`,
    stage: "build",
    status,
    startedAt: 1,
    agents: [],
  };
}

test("pipeline cancellation schema is bounded, non-empty, unique, and exact", () => {
  assert.equal(
    Check(PIPELINE_CANCEL_PARAMETERS, {
      ids: ["cancel-me-now-00000001"],
    }),
    true,
  );
  assert.equal(Check(PIPELINE_CANCEL_PARAMETERS, { ids: [] }), false);
  assert.equal(
    Check(PIPELINE_CANCEL_PARAMETERS, {
      ids: ["cancel-me-now-00000001", "cancel-me-now-00000001"],
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_CANCEL_PARAMETERS, {
      ids: Array.from(
        { length: PIPELINE_CANCEL_MAX_IDS + 1 },
        (_, index) => `cancel-me-now-${index.toString(16).padStart(8, "0")}`,
      ),
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_CANCEL_PARAMETERS, {
      ids: ["cancel-me-now-00000001"],
      child_id: "agent-1",
    }),
    false,
  );
});

test("pipeline cancellation handles every id in caller order and isolates failures", async () => {
  const runs = new Map([
    ["active-a", snapshot("active-a", "running")],
    ["settled", snapshot("settled", "completed")],
    ["broken", snapshot("broken", "starting")],
    ["active-b", snapshot("active-b", "running")],
    ["unrelated", snapshot("unrelated", "running")],
  ]);
  const cancelled: string[] = [];
  const controller = {
    get: (id: string) => runs.get(id),
    cancelRun: async (id: string) => {
      cancelled.push(id);
      if (id === "broken") throw new Error("x".repeat(4_096));
      const result = snapshot(id, "cancelled");
      runs.set(id, result);
      return result;
    },
  };

  const results = await cancelPipelines(controller, [
    "active-a",
    "settled",
    "missing",
    "broken",
    "active-b",
  ]);

  assert.deepEqual(
    results.map((result) => [result.id, result.outcome]),
    [
      ["active-a", "cancelled"],
      ["settled", "already-settled"],
      ["missing", "unknown"],
      ["broken", "failed"],
      ["active-b", "cancelled"],
    ],
  );
  assert.deepEqual(cancelled, ["active-a", "broken", "active-b"]);
  assert.equal(runs.get("unrelated")?.status, "running");
  const failure = results.find((result) => result.outcome === "failed");
  assert.ok(failure && Buffer.byteLength(failure.error, "utf8") <= 512);
});

test("concurrent cancellation and settlement races produce one result per caller", async () => {
  const runs = new Map([["racing", snapshot("racing", "running")]]);
  let cancellations = 0;
  const controller = {
    get: (id: string) => runs.get(id),
    cancelRun: async (id: string) => {
      cancellations++;
      const result = snapshot(id, "cancelled");
      runs.set(id, result);
      await Promise.resolve();
      return result;
    },
  };

  const [first, second] = await Promise.all([
    cancelPipelines(controller, ["racing"]),
    cancelPipelines(controller, ["racing"]),
  ]);

  assert.equal(cancellations, 1);
  assert.deepEqual([first[0]?.outcome, second[0]?.outcome].sort(), [
    "already-settled",
    "cancelled",
  ]);

  runs.set("settling", snapshot("settling", "running"));
  const settled = await cancelPipelines(
    {
      get: (id) => runs.get(id),
      cancelRun: async (id) => {
        const result = snapshot(id, "completed");
        runs.set(id, result);
        return result;
      },
    },
    ["settling"],
  );
  assert.deepEqual(settled, [
    { id: "settling", outcome: "already-settled", status: "completed" },
  ]);
});

test("pipeline cancellation tool exposes bounded structured per-id outcomes", async () => {
  const runs = new Map([
    ["active", snapshot("active", "running")],
    ["done", snapshot("done", "failed")],
  ]);
  const tool = createPipelineCancellationTool(() => ({
    get: (id) => runs.get(id),
    cancelRun: async (id) => {
      const result = snapshot(id, "cancelled");
      runs.set(id, result);
      return result;
    },
  }));

  const result = await tool.execute(
    "tool-1",
    { ids: ["active", "done", "unknown"] },
    undefined,
    undefined,
    {} as ExtensionContext,
  );

  assert.equal(
    result.content[0]?.type === "text" ? result.content[0].text : "",
    "Cancelled active.\ndone was already failed.\nUnknown pipeline id unknown.",
  );
  assert.deepEqual(result.details, {
    results: [
      { id: "active", outcome: "cancelled", status: "cancelled" },
      { id: "done", outcome: "already-settled", status: "failed" },
      { id: "unknown", outcome: "unknown" },
    ],
  });
});
