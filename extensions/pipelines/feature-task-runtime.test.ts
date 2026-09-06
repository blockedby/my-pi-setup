import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createFeatureReviewRuntime,
  createFeatureTaskRuntime,
  type FeatureCheckRunner,
  type FeatureTaskSnapshot,
} from "./feature-task-runtime.ts";
import { createFeatureTaskWorktreeLifecycle } from "./feature-task-worktrees.ts";
import {
  canonicalPlan,
  executionGraph,
  executionTask,
} from "./feature-planning.test.ts";

function git(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(runId: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-task-runtime-"));
  const primary = path.join(root, "primary");
  const workingDir = path.join(root, "caller");
  const worktreeRoot = path.join(root, "task-worktrees");
  fs.mkdirSync(primary);
  fs.mkdirSync(worktreeRoot);
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(primary, "selected.txt"), "base\n");
  fs.writeFileSync(path.join(primary, "generated.txt"), "base\n");
  git(primary, ["add", "."]);
  git(primary, ["commit", "-qm", "baseline"]);
  git(primary, [
    "worktree",
    "add",
    "-qb",
    `feature/${runId}`,
    workingDir,
    "HEAD",
  ]);
  const lifecycle = createFeatureTaskWorktreeLifecycle({
    runId,
    workingDir,
    worktreeRoot,
  });
  return {
    root,
    workingDir,
    lifecycle,
    target: lifecycle.target("root"),
    base: lifecycle.root.head,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function requiredCheck(id = "required-check") {
  return {
    id,
    command: `run ${id}`,
    cwd: ".",
    purpose: `Verify ${id}.`,
    required: true,
  };
}

function runtimeFor(
  repo: ReturnType<typeof fixture>,
  runCheck: FeatureCheckRunner,
  signal = new AbortController().signal,
  onSnapshot?: (snapshot: FeatureTaskSnapshot) => void,
) {
  const task = executionTask("implement-feature");
  return createFeatureTaskRuntime({
    kind: "task",
    task,
    canonicalPlan: canonicalPlan(),
    graph: executionGraph(),
    target: repo.target,
    taskBaseCommit: repo.base,
    checks: [requiredCheck()],
    runCheck,
    signal,
    onSnapshot,
  });
}

const passingCheck: FeatureCheckRunner = async () => ({
  exitCode: 0,
  stdout: "passed\n",
  stderr: "",
});

test("failed required verification leaves a provisional commit that a later attempt amends", async () => {
  const repo = fixture("runtime-amend-a1b2c3d4");
  try {
    let checkAttempt = 0;
    const runtime = runtimeFor(repo, async () => ({
      exitCode: ++checkAttempt === 1 ? 1 : 0,
      stdout: "",
      stderr: checkAttempt === 1 ? "first verification failed" : "",
    }));
    runtime.beginAttempt(1);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "first\n");

    const first = await runtime.host.finalize({
      commitPaths: ["selected.txt"],
      summary: "Implemented the first version and ran its required check.",
    });

    assert.equal(first.validated, false);
    assert.equal(first.status, "provisional");
    assert.ok(first.commit);
    runtime.settleAttempt({
      status: "settled",
      sessionId: "luna-attempt-1",
      error: first.error,
    });
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "fixed\n");
    const retry = runtime.beginAttempt(2, first.error);
    assert.equal(retry.graphContext.provisionalCommit, first.commit);

    const repaired = await runtime.host.finalize({
      commitPaths: ["selected.txt"],
      summary: "Repaired the failed behavior and reran verification.",
    });

    assert.equal(repaired.validated, true);
    assert.equal(repaired.status, "validated");
    assert.notEqual(repaired.commit, first.commit);
    assert.equal(
      git(repo.workingDir, ["rev-list", "--count", `${repo.base}..HEAD`]),
      "1",
    );
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD^"]), repo.base);
    assert.equal(runtime.snapshot().validatedCommit, repaired.commit);
  } finally {
    repo.cleanup();
  }
});

test("no-change finalization runs required checks without creating an empty commit", async () => {
  const repo = fixture("runtime-no-change-b1c2d3e4");
  try {
    let checks = 0;
    const runtime = runtimeFor(repo, async () => {
      checks += 1;
      return { exitCode: 0, stdout: "passed\n", stderr: "" };
    });
    runtime.beginAttempt(1);

    const result = await runtime.host.finalize({
      commitPaths: [],
      summary: "The accepted behavior already exists and verification passed.",
    });

    assert.equal(result.validated, true);
    assert.equal(result.status, "satisfied_without_changes");
    assert.equal(result.commit, undefined);
    assert.equal(checks, 1);
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), repo.base);
  } finally {
    repo.cleanup();
  }
});

test("empty commit paths cannot discard meaningful dirty work", async () => {
  const repo = fixture("runtime-dirty-empty-c1d2e3f4");
  try {
    const runtime = runtimeFor(repo, passingCheck);
    runtime.beginAttempt(1);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "dirty\n");

    await assert.rejects(
      runtime.host.finalize({
        commitPaths: [],
        summary: "Attempted an invalid no-change finalization.",
      }),
      /cannot discard meaningful task changes/i,
    );
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), repo.base);
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "selected.txt"), "utf8"),
      "dirty\n",
    );
  } finally {
    repo.cleanup();
  }
});

test("an aborted task signal prevents commit creation", async () => {
  const repo = fixture("runtime-cancel-d1e2f3a4");
  try {
    const cancellation = new AbortController();
    const runtime = runtimeFor(repo, passingCheck, cancellation.signal);
    runtime.beginAttempt(1);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "cancelled\n");
    cancellation.abort();

    await assert.rejects(
      runtime.host.finalize({
        commitPaths: ["selected.txt"],
        summary: "Cancellation arrived before finalization.",
      }),
      /cancelled/i,
    );
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), repo.base);
  } finally {
    repo.cleanup();
  }
});

test("same-branch HEAD drift blocks empty finalization", async () => {
  const repo = fixture("runtime-head-drift-e1f2a3b4");
  try {
    const runtime = runtimeFor(repo, passingCheck);
    runtime.beginAttempt(1);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "external\n");
    git(repo.workingDir, ["add", "selected.txt"]);
    git(repo.workingDir, ["commit", "-qm", "external same-branch commit"]);
    const driftedHead = git(repo.workingDir, ["rev-parse", "HEAD"]);

    await assert.rejects(
      runtime.host.finalize({
        commitPaths: [],
        summary: "Must not accept a different same-branch HEAD.",
      }),
      /head.*drift|drifted.*head|controller ownership/i,
    );
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), driftedHead);
    assert.notEqual(driftedHead, repo.base);
  } finally {
    repo.cleanup();
  }
});

test("tracked files changed by a check require an explicit later amend", async () => {
  const repo = fixture("runtime-check-mutation-f1a2b3c4");
  try {
    let checkAttempt = 0;
    const runtime = runtimeFor(repo, async () => {
      checkAttempt += 1;
      if (checkAttempt === 1) {
        fs.writeFileSync(
          path.join(repo.workingDir, "generated.txt"),
          "generated by check\n",
        );
      }
      return { exitCode: 0, stdout: "passed\n", stderr: "" };
    });
    runtime.beginAttempt(1);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "feature\n");

    const first = await runtime.host.finalize({
      commitPaths: ["selected.txt"],
      summary: "Implemented the feature before generated output appeared.",
    });

    assert.equal(first.validated, false);
    assert.equal(first.status, "provisional");
    assert.deepEqual(first.checks[0]?.changedPaths, ["generated.txt"]);
    runtime.settleAttempt({ status: "settled", error: first.error });
    runtime.beginAttempt(2, first.error);

    const amended = await runtime.host.finalize({
      commitPaths: ["generated.txt"],
      summary: "Explicitly included the verified generated source update.",
    });

    assert.equal(amended.validated, true);
    assert.equal(
      git(repo.workingDir, ["rev-list", "--count", `${repo.base}..HEAD`]),
      "1",
    );
    assert.deepEqual(
      git(repo.workingDir, ["diff", "--name-only", `${repo.base}..HEAD`])
        .split("\n")
        .sort(),
      ["generated.txt", "selected.txt"],
    );
  } finally {
    repo.cleanup();
  }
});

test("large failed-check evidence produces a bounded retry capsule with current diff", async () => {
  const repo = fixture("runtime-large-output-a2b3c4d5");
  try {
    const hugeOutput = "failure detail ".repeat(64 * 1024);
    const runtime = runtimeFor(repo, async () => ({
      exitCode: 1,
      stdout: hugeOutput,
      stderr: hugeOutput,
    }));
    runtime.beginAttempt(1);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "feature\n");
    const first = await runtime.host.finalize({
      commitPaths: ["selected.txt"],
      summary:
        "Created a provisional implementation before verification failed.",
    });
    assert.equal(first.validated, false);
    runtime.settleAttempt({ status: "settled", error: first.error });
    fs.writeFileSync(
      path.join(repo.workingDir, "generated.txt"),
      "retry work\n",
    );

    const retry = runtime.beginAttempt(2, first.error);

    assert.ok(Buffer.byteLength(JSON.stringify(retry), "utf8") <= 192 * 1024);
    assert.equal(retry.graphContext.previousFailure, first.error);
    assert.equal(retry.graphContext.provisionalCommit, first.commit);
    assert.ok(retry.graphContext.previousChecks.length > 0);
    assert.ok(
      Buffer.byteLength(retry.graphContext.previousChecks[0]!.stdout, "utf8") <
        Buffer.byteLength(hugeOutput, "utf8"),
    );
    assert.ok(retry.graphContext.currentDiff);
    assert.equal(retry.graphContext.currentDiff.truncated, false);
    assert.ok(retry.graphContext.currentDiff.text.includes("retry work"));
  } finally {
    repo.cleanup();
  }
});

test("final-review snapshots update and supplied cancellation prevents a review commit", async () => {
  const repo = fixture("runtime-review-b2c3d4e5");
  try {
    const snapshots: FeatureTaskSnapshot[] = [];
    const cancellation = new AbortController();
    const review = createFeatureReviewRuntime({
      runId: "runtime-review-b2c3d4e5",
      workingDir: repo.workingDir,
      checks: [requiredCheck("review-check")],
      runCheck: passingCheck,
      signal: cancellation.signal,
      canonicalPlan: canonicalPlan(),
      graph: executionGraph(),
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    assert.equal(review.snapshot().status, "waiting");
    review.begin(repo.base);
    assert.equal(review.snapshot().status, "running");
    fs.writeFileSync(
      path.join(repo.workingDir, "selected.txt"),
      "review edit\n",
    );
    cancellation.abort();

    await assert.rejects(
      review.host.finalize({
        commitPaths: ["selected.txt"],
        summary: "Review cancellation arrived before finalization.",
      }),
      /cancelled/i,
    );

    assert.equal(review.snapshot().status, "running");
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), repo.base);
    assert.ok(snapshots.some(({ status }) => status === "waiting"));
    assert.ok(snapshots.some(({ status }) => status === "running"));
  } finally {
    repo.cleanup();
  }
});
