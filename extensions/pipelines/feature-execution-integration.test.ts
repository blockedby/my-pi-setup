import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { compileFeatureExecutionGraph } from "./feature-graph.ts";
import { executeFeatureGraph } from "./feature-graph-executor.ts";
import { canonicalPlan, executionTask } from "./feature-planning.test.ts";
import { createFeatureReviewRuntime } from "./feature-task-runtime.ts";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

test("prepared nested graph completes real sandbox checks, Git joins and final review without model calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-real-feature-"));
  const primary = path.join(root, "primary");
  const workingDir = path.join(root, "caller");
  const worktreeRoot = path.join(root, "tasks");
  const runId = "integration-graph-a1b2c3d4";
  fs.mkdirSync(primary);
  fs.mkdirSync(worktreeRoot);
  try {
    git(primary, ["init", "-q"]);
    git(primary, ["config", "user.email", "fixture@example.invalid"]);
    git(primary, ["config", "user.name", "Fixture"]);
    fs.writeFileSync(path.join(primary, ".gitignore"), ".deps/\n");
    git(primary, ["add", ".gitignore"]);
    git(primary, ["commit", "-qm", "baseline"]);
    git(primary, ["worktree", "add", "-qb", "feature/integration", workingDir]);
    fs.mkdirSync(path.join(workingDir, ".deps"));
    fs.writeFileSync(path.join(workingDir, ".deps", "runtime"), "ready\n");
    const base = git(workingDir, ["rev-parse", "HEAD"]);
    const plan = canonicalPlan();
    const task = (id: string, dependencies: string[]) => ({
      ...executionTask(id, dependencies),
      readPaths: [".gitignore"],
      writePaths: [`${id}.txt`],
      checks: [
        {
          id: `${id}-check`,
          command: `test -f ${id}.txt`,
          cwd: ".",
          required: true,
          purpose: "Verify the task's committed output exists.",
        },
      ],
    });
    const tasks = [
      task("contracts", []),
      task("context", ["contracts"]),
      task("context-one", ["context"]),
      task("context-two", ["context"]),
      task("settings", ["contracts"]),
      task("integration", ["context-one", "context-two", "settings"]),
    ];
    const whitespace = {
      id: "whitespace",
      command: "git diff --check",
      cwd: ".",
      required: true,
      purpose: "Verify the complete task delta, including provisional commits.",
    };
    const graph = {
      reportType: "feature-execution-graph-v1" as const,
      summary:
        "Exercise the real prepared offline execution path with nested forks.",
      baselineChecks: [
        {
          id: "environment",
          command: 'test "$(cat .deps/runtime)" = ready',
          cwd: ".",
          required: true,
          purpose: "Prove branch preparation is visible inside the sandbox.",
        },
        whitespace,
      ],
      reviewChecks: [
        {
          id: "integrated-output",
          command: tasks.map(({ id }) => `test -f ${id}.txt`).join(" && "),
          cwd: ".",
          required: true,
          purpose:
            "Prove every branch contribution reached the integrated worktree.",
        },
        whitespace,
      ],
      tasks,
    };
    const tree = compileFeatureExecutionGraph(plan, graph);
    const sessions: string[] = [];
    const result = await executeFeatureGraph({
      runId,
      workingDir,
      worktreeRoot,
      canonicalPlan: plan,
      graph,
      tree,
      worktreePrepare: ["mkdir -p .deps && printf 'ready\\n' > .deps/runtime"],
      // Only model generation is simulated. The default check runner, real
      // bubblewrap, Git lifecycle, graph compiler and final review are used.
      async runSession(input) {
        const id = input.task!.id;
        sessions.push(id);
        assert.equal(input.attempt, 1);
        for (const dependency of input.task!.dependsOn) {
          assert.equal(
            fs.existsSync(path.join(input.cwd, `${dependency}.txt`)),
            true,
          );
        }
        const evidence = await input.tools.diff();
        assert.equal(
          evidence.currentHead,
          input.capsule.graphContext.currentHead,
        );
        fs.writeFileSync(path.join(input.cwd, `${id}.txt`), `${id}\n`);
        const finalized = await input.tools.finalize({
          commitPaths: [`${id}.txt`],
          summary: `Implemented ${id}.`,
        });
        assert.equal(
          finalized.validated,
          true,
          JSON.stringify(finalized.checks),
        );
        return { status: "settled", sessionId: `synthetic-${id}` };
      },
    });
    assert.equal(
      result.status,
      "completed",
      result.error ?? "graph execution failed",
    );
    assert.equal(sessions.length, tasks.length);
    assert.equal(new Set(sessions).size, tasks.length);
    assert.equal(result.joins.length, 2);
    assert.ok(result.tasks.every(({ status }) => status === "validated"));
    assert.equal(
      git(workingDir, ["rev-list", "--count", `${base}..HEAD`]),
      String(tasks.length),
    );
    assert.equal(git(workingDir, ["status", "--porcelain"]), "");
    const review = createFeatureReviewRuntime({
      runId,
      workingDir,
      checks: graph.reviewChecks,
      canonicalPlan: plan,
      graph,
      diffBaseCommit: base,
      knownResidualPaths: result.rootResidualPaths,
      knownTrackedResiduals: result.rootTrackedResiduals,
    });
    review.begin(result.head);
    const reviewed = await review.host.finalize({
      commitPaths: [],
      summary: "All integrated outputs and whitespace checks passed.",
    });
    assert.equal(reviewed.validated, true, JSON.stringify(reviewed.checks));
    assert.equal(git(workingDir, ["rev-parse", "HEAD"]), result.head);
    assert.deepEqual(result.cleanupCompleted(), []);
    assert.equal(
      fs.readFileSync(path.join(workingDir, ".deps", "runtime"), "utf8"),
      "ready\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
