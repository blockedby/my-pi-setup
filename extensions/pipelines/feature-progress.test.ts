import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineRunSnapshot } from "./domain.ts";
import {
  featureExecutionRows,
  featureTaskDetails,
  featureTaskGlyph,
  projectFeatureTasks,
} from "./feature-progress.ts";
import { buildPipelineRows } from "./dashboard.ts";
import { projectPipelineCheck } from "./inspection.ts";

function progress() {
  return {
    artifactDir: "/state/pipelines/feature-test-run-12345678",
    canonicalSessionId: "sol-finalizer",
    planning: {
      candidates: [],
      canonical: "accepted",
      graph: "accepted",
      review: "waiting",
    },
    tree: {
      kind: "sequence",
      steps: [
        { kind: "task", taskId: "a" },
        {
          kind: "fork",
          branches: [
            { kind: "task", taskId: "b" },
            { kind: "task", taskId: "c" },
          ],
        },
        { kind: "task", taskId: "d" },
      ],
    },
    tasks: [
      {
        id: "a",
        kind: "task",
        objective: "Define contracts",
        status: "validated",
        attempt: 1,
        attempts: [{ attempt: 1, sessionId: "luna-a", status: "completed" }],
        branchId: "root",
        branch: "feature/test",
        worktree: "/repo/work",
        taskBaseCommit: "1111",
        validatedCommit: "abcdef1234567890",
        summary: "Exported contracts for following tasks.",
        checks: [],
        warnings: [],
        residualPaths: [],
      },
      {
        id: "b",
        kind: "task",
        objective: "Implement scheduler",
        status: "provisional",
        attempt: 2,
        attempts: [
          {
            attempt: 1,
            sessionId: "luna-b1",
            status: "failed",
            error: "Required check failed",
          },
          { attempt: 2, sessionId: "luna-b2", status: "running" },
        ],
        branchId: "branch-b",
        branch: "pipi-feature/run/branch-1-b",
        worktree: "/worktrees/run/b",
        provisionalCommit: "b1234567890",
        checks: [],
        warnings: [],
        residualPaths: [],
        error: "Required check failed",
      },
      {
        id: "c",
        kind: "task",
        objective: "Implement lifecycle",
        status: "validated",
        attempt: 1,
        attempts: [{ attempt: 1, sessionId: "luna-c", status: "completed" }],
        branchId: "branch-c",
        branch: "pipi-feature/run/branch-2-c",
        worktree: "/worktrees/run/c",
        validatedCommit: "c1234567890",
        checks: [],
        warnings: [],
        residualPaths: [],
      },
    ],
    branches: [],
    joins: [],
    warnings: ["Could not remove generated-cache"],
    residualPaths: ["generated-cache"],
  } satisfies NonNullable<PipelineRunSnapshot["featureGraph"]>;
}
function run() {
  return {
    id: "feature-test-run-12345678",
    definition: "feature-pipeline",
    workingDir: "/repo/work",
    stage: "build",
    status: "running",
    startedAt: 1,
    rootId: "sol-finalizer",
    agents: [],
    featureGraph: progress(),
  } satisfies PipelineRunSnapshot;
}

function detailsForTask(
  task: NonNullable<PipelineRunSnapshot["featureGraph"]>["tasks"][number],
) {
  const snapshot = run();
  return featureTaskDetails(
    {
      ...snapshot,
      featureGraph: {
        ...snapshot.featureGraph!,
        tasks: [task],
      },
    },
    task.id,
  );
}

function summaryFromDetails(details: string) {
  const summaryMarker = "\nSummary\n";
  const warningsMarker = "\n\nWarnings and residual paths";
  const summaryStart = details.indexOf(summaryMarker);
  const warningsStart = details.indexOf(warningsMarker, summaryStart);
  assert.ok(summaryStart >= 0);
  assert.ok(warningsStart > summaryStart);
  return details.slice(summaryStart + summaryMarker.length, warningsStart);
}

test("execution projection preserves fork structure, waiting tasks and provisional status", () => {
  const rows = featureExecutionRows(progress());
  assert.deepEqual(
    rows
      .filter((row) => row.kind === "task")
      .map((row) => [row.taskId, row.depth, row.status]),
    [
      ["a", 3, "validated"],
      ["b", 4, "provisional"],
      ["c", 4, "validated"],
      ["d", 3, "waiting"],
    ],
  );
  assert.equal(rows.filter((row) => row.kind === "boundary").length, 2);
  assert.equal(
    rows.find((row) => row.key === "parallel:02")?.label,
    "02 after 01: parallel [1/2 branches]",
  );
  assert.equal(
    rows.find((row) => row.taskId === "d")?.label,
    "03 after 02: d · waiting",
  );
  assert.equal(featureTaskGlyph("validated"), "done");
  assert.equal(featureTaskGlyph("provisional"), "running");
  assert.equal(featureTaskGlyph("waiting"), undefined);
  assert.equal(featureTaskGlyph("failed"), "error");
});

test("feature inspection exposes factual execution state without full capsules or summaries", () => {
  const projected = projectFeatureTasks(progress());
  assert.equal(projected.tasks[1]?.attempt, 2);
  assert.equal(projected.tasks[1]?.provisionalCommit, "b1234567890");
  assert.equal(projected.tasks[0]?.validatedCommit, "abcdef1234567890");
  assert.equal("summary" in (projected.tasks[0] ?? {}), false);
  assert.equal("capsule" in (projected.tasks[0] ?? {}), false);
  assert.deepEqual(projected.residualPaths, ["generated-cache"]);
  assert.deepEqual(projectPipelineCheck(run()).featureGraph, projected);
});

test("dashboard tasks are individually selectable and share the persistent final review target", () => {
  const snapshot = run();
  const rows = buildPipelineRows([snapshot], new Set([snapshot.id]));
  assert.deepEqual(
    rows.flatMap((row) => (row.kind === "task" ? [row.taskId] : [])),
    ["a", "b", "c", "d"],
  );
  assert.equal(
    rows
      .filter((row) => row.kind === "stage")
      .find((row) => row.stage === "review")?.agentId,
    "sol-finalizer",
  );
  const details = featureTaskDetails(snapshot, "b");
  assert.ok(details.includes("luna-b1"));
  assert.ok(details.includes("luna-b2"));
  assert.ok(details.includes("b1234567890"));
  assert.ok(details.includes("/worktrees/run/b"));
});

test("task details prefer a concrete failure when the agent never starts", () => {
  const base = progress().tasks.find((task) => task.id === "b")!;
  const task = {
    ...base,
    status: "failed" as const,
    attempt: 1,
    attempts: [],
    checks: [
      {
        checkId: "pre-agent-check",
        command: "bun test",
        cwd: "/worktrees/run/b",
        purpose: "required validation",
        required: true,
        status: "failed" as const,
        exitCode: 1,
        stdout: "",
        stderr: "check failed",
        changedPaths: [],
        startedAt: 1,
        finishedAt: 2,
        error: "check failed",
      },
    ],
    warnings: ["warning retained"],
    residualPaths: ["residual retained"],
    error: "Agent launch failed before session creation.",
  } satisfies NonNullable<PipelineRunSnapshot["featureGraph"]>["tasks"][number];
  const details = detailsForTask(task);

  assert.equal(summaryFromDetails(details), task.error);
  assert.ok(details.includes('"checkId": "pre-agent-check"'));
  assert.ok(details.includes("warning retained"));
  assert.ok(details.includes("residual retained"));
});

test("task details keep a validated summary when one is present", () => {
  const task = progress().tasks.find((candidate) => candidate.id === "a")!;
  const details = detailsForTask(task);

  assert.equal(summaryFromDetails(details), task.summary);
});

test("task details retain the generic summary fallback for pending tasks without an error", () => {
  const base = progress().tasks.find((task) => task.id === "b")!;
  const task = {
    ...base,
    status: "running" as const,
    attempt: 1,
    attempts: [],
    summary: undefined,
    error: undefined,
  } satisfies NonNullable<PipelineRunSnapshot["featureGraph"]>["tasks"][number];
  const details = detailsForTask(task);

  assert.equal(summaryFromDetails(details), "No validated summary yet.");
});
