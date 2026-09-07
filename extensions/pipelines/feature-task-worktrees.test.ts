import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CleanupEvidence } from "./cleanup-evidence.ts";
import {
  createFeatureRootTaskGitTarget,
  createFeatureTaskWorktreeLifecycle,
} from "./feature-task-worktrees.ts";

function git(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function lines(value: string) {
  return value.split("\n").filter(Boolean).sort();
}

function evidenceCapture() {
  const records: CleanupEvidence[] = [];
  return {
    records,
    sink(record: CleanupEvidence) {
      records.push(record);
    },
  };
}

function fixture({
  trackedExternalSymlink = false,
}: {
  trackedExternalSymlink?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-task-worktrees-"));
  const primary = path.join(root, "primary");
  const workingDir = path.join(root, "caller");
  const worktreeRoot = path.join(root, "task-worktrees");
  const external = path.join(root, "external");
  fs.mkdirSync(primary);
  fs.mkdirSync(worktreeRoot);
  fs.mkdirSync(external);
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(primary, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(primary, "selected.txt"), "base\n");
  fs.writeFileSync(path.join(primary, "amendment.txt"), "base\n");
  if (trackedExternalSymlink) {
    fs.symlinkSync(external, path.join(primary, "external-link"));
  }
  git(primary, ["add", "."]);
  git(primary, ["commit", "-qm", "baseline"]);
  git(primary, [
    "worktree",
    "add",
    "-qb",
    "feature/dynamic-luna-tests",
    workingDir,
    "HEAD",
  ]);
  return {
    root,
    primary,
    workingDir,
    worktreeRoot,
    external,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("task commit paths cannot be expanded by repository pre-commit hooks", () => {
  const repo = fixture();
  try {
    const hooksPath = path.join(repo.root, "hooks");
    fs.mkdirSync(hooksPath);
    fs.writeFileSync(
      path.join(hooksPath, "pre-commit"),
      "#!/bin/sh\nprintf 'hook\n' > hook-artifact.txt\ngit add -- hook-artifact.txt\n",
      { mode: 0o755 },
    );
    git(repo.primary, ["config", "core.hooksPath", hooksPath]);
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-hook-a1b2c3d4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const base = lifecycle.root.head;
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "selected\n");

    const result = lifecycle.commit(
      "root",
      base,
      ["selected.txt"],
      "implement selected task",
    );

    assert.deepEqual(result.changedPaths, ["selected.txt"]);
    assert.deepEqual(
      lines(
        git(repo.workingDir, [
          "show",
          "--format=",
          "--name-only",
          result.commit,
        ]),
      ),
      ["selected.txt"],
    );
    assert.equal(
      fs.existsSync(path.join(repo.workingDir, "hook-artifact.txt")),
      false,
    );
  } finally {
    repo.cleanup();
  }
});

test("cleanup evidence records intent before tracked and untracked outcomes", () => {
  const repo = fixture();
  const evidence = evidenceCapture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-cleanup-evidence-a1b2c3d4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      cleanupEvidence: evidence.sink,
    });
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "selected\n");
    fs.writeFileSync(path.join(repo.workingDir, "amendment.txt"), "residual\n");
    const generated = path.join(repo.workingDir, "generated.txt");
    fs.writeFileSync(generated, "generated\n");

    const result = lifecycle.commit(
      "root",
      lifecycle.root.head,
      ["selected.txt"],
      "record cleanup evidence",
    );

    assert.deepEqual(result.warnings, []);
    assert.equal(fs.existsSync(generated), false);
    for (const filePath of ["amendment.txt", "generated.txt"]) {
      const records = evidence.records.filter(
        (record) =>
          record.resourceType === "residual" &&
          record.resource === path.join(repo.workingDir, filePath),
      );
      assert.deepEqual(
        records.map(({ event }) => event),
        ["intent", "outcome"],
      );
      assert.equal(records[1]?.disposition, "removed");
      assert.equal(records[1]?.operationStatus, "succeeded");
      assert.equal(records[1]?.expectedIdentity, result.commit);
      assert.equal(records[0]?.operationId, records[1]?.operationId);
    }
  } finally {
    repo.cleanup();
  }
});

test("root Git target accepts cleanup evidence after legacy factory arguments", () => {
  const repo = fixture();
  const evidence = evidenceCapture();
  try {
    const target = createFeatureRootTaskGitTarget(
      repo.workingDir,
      [],
      [],
      evidence.sink,
    );
    const base = target.head();
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "selected\n");
    fs.writeFileSync(
      path.join(repo.workingDir, "generated.txt"),
      "generated\n",
    );

    const result = target.commit(
      base,
      ["selected.txt"],
      "record root cleanup evidence",
    );

    assert.deepEqual(result.warnings, []);
    assert.equal(
      fs.existsSync(path.join(repo.workingDir, "generated.txt")),
      false,
    );
    const generatedRecords = evidence.records.filter(
      (record) =>
        record.resourceType === "residual" &&
        record.resource === path.join(repo.workingDir, "generated.txt"),
    );
    assert.equal(generatedRecords[1]?.disposition, "removed");
    assert.equal(generatedRecords[1]?.expectedIdentity, result.commit);
  } finally {
    repo.cleanup();
  }
});

test("failed tracked cleanup is retained and never reported as removed", () => {
  const repo = fixture();
  const originalPath = process.env.PATH;
  const evidence = evidenceCapture();
  try {
    const wrapperDirectory = path.join(repo.root, "git-wrapper");
    const wrapper = path.join(wrapperDirectory, "git");
    const realGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const quotedGit = "'" + realGit.replaceAll("'", "'\"'\"'") + "'";
    fs.mkdirSync(wrapperDirectory);
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" restore "*) exit 42;; esac\nexec ${quotedGit} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath ?? ""}`;

    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-cleanup-failure-b2c3d4e5",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      cleanupEvidence: evidence.sink,
    });
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "selected\n");
    fs.writeFileSync(path.join(repo.workingDir, "amendment.txt"), "residual\n");
    const result = lifecycle.commit(
      "root",
      lifecycle.root.head,
      ["selected.txt"],
      "retain failed cleanup",
    );

    process.env.PATH = originalPath;
    const records = evidence.records.filter(
      (record) =>
        record.resourceType === "residual" &&
        record.resource === path.join(repo.workingDir, "amendment.txt"),
    );
    assert.equal(result.warnings.length > 0, true);
    assert.deepEqual(
      records.map(({ event }) => event),
      ["intent", "outcome"],
    );
    assert.equal(records[1]?.disposition, "retained");
    assert.equal(records[1]?.operationStatus, "failed");
    assert.equal(records[1]?.reasonCode, "residual_remove_failed");
    assert.notEqual(records[1]?.disposition, "removed");
    assert.deepEqual(result.residualPaths, ["amendment.txt"]);
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "amendment.txt"), "utf8"),
      "residual\n",
    );
  } finally {
    process.env.PATH = originalPath;
    repo.cleanup();
  }
});

test("failed ref compare-delete retains the ref and records its expected SHA", () => {
  const repo = fixture();
  const originalPath = process.env.PATH;
  const evidence = evidenceCapture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-ref-evidence-c3d4e5f6",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      cleanupEvidence: evidence.sink,
    });
    const child = lifecycle.createChild("root", 1, "ref-task");
    const reference = `refs/heads/${child.branch}`;

    const wrapperDirectory = path.join(repo.root, "git-wrapper");
    const wrapper = path.join(wrapperDirectory, "git");
    const realGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const quotedGit = "'" + realGit.replaceAll("'", "'\"'\"'") + "'";
    fs.mkdirSync(wrapperDirectory);
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\ncase " $* " in *" update-ref "*) exit 43;; esac\nexec ${quotedGit} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath ?? ""}`;
    const warnings = lifecycle.cleanupCompleted();
    process.env.PATH = originalPath;

    assert.equal(warnings.length > 0, true);
    assert.equal(git(repo.workingDir, ["rev-parse", reference]), child.head);
    const records = evidence.records.filter(
      (record) =>
        record.resourceType === "ref" && record.resource === reference,
    );
    assert.deepEqual(
      records.map(({ event }) => event),
      ["intent", "outcome"],
    );
    assert.equal(records[0]?.expectedIdentity, child.head);
    assert.equal(records[1]?.expectedIdentity, child.head);
    assert.equal(records[1]?.disposition, "retained");
    assert.equal(records[1]?.operationStatus, "failed");
    assert.equal(records[1]?.reasonCode, "compare_delete_failed");
    assert.notEqual(records[1]?.disposition, "removed");
    const rootWorktree = evidence.records.find(
      (record) =>
        record.resourceType === "worktree" &&
        record.resource === repo.workingDir &&
        record.event === "outcome",
    );
    assert.equal(rootWorktree?.ownership, "caller");
    assert.equal(rootWorktree?.disposition, "retained");
    assert.equal(rootWorktree?.reasonCode, "caller_owned");
  } finally {
    process.env.PATH = originalPath;
    repo.cleanup();
  }
});

test("already absent refs are skipped without a fake deletion outcome", () => {
  const repo = fixture();
  const evidence = evidenceCapture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-absent-ref-evidence-e4f5a6b7",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      cleanupEvidence: evidence.sink,
    });
    const child = lifecycle.createChild("root", 1, "absent-ref-task");
    const reference = `refs/heads/${child.branch}`;
    git(repo.workingDir, ["update-ref", "-d", reference, child.head]);

    assert.deepEqual(lifecycle.cleanupCompleted(), []);
    const records = evidence.records.filter(
      (record) =>
        record.resourceType === "ref" && record.resource === reference,
    );
    assert.deepEqual(
      records.map(({ event }) => event),
      ["intent", "outcome"],
    );
    assert.equal(records[1]?.disposition, "skipped");
    assert.equal(records[1]?.operationStatus, "not_attempted");
    assert.equal(records[1]?.reasonCode, "ref_already_absent");
  } finally {
    repo.cleanup();
  }
});

test("repeated worktree cleanup is skipped and retained-resource recording does not delete", () => {
  const repo = fixture();
  const evidence = evidenceCapture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-retention-evidence-d4e5f6a7",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      cleanupEvidence: evidence.sink,
    });
    const child = lifecycle.createChild("root", 1, "retained-task");
    const reference = `refs/heads/${child.branch}`;
    assert.deepEqual(lifecycle.removeJoinedWorktree(child.id), []);
    assert.deepEqual(lifecycle.removeJoinedWorktree(child.id), []);
    lifecycle.recordRetainedResources("cancelled");

    assert.equal(fs.existsSync(lifecycle.runDirectory), true);
    assert.equal(git(repo.workingDir, ["rev-parse", reference]), child.head);
    const worktreeRecords = evidence.records.filter(
      (record) =>
        record.resourceType === "worktree" &&
        record.resource === child.worktree &&
        record.event === "outcome",
    );
    assert.equal(worktreeRecords[0]?.disposition, "removed");
    assert.equal(worktreeRecords[1]?.disposition, "skipped");
    assert.equal(worktreeRecords[1]?.reasonCode, "already_removed");
    const retainedRef = evidence.records.find(
      (record) =>
        record.resourceType === "ref" &&
        record.resource === reference &&
        record.event === "outcome",
    );
    assert.equal(retainedRef?.disposition, "retained");
    assert.equal(retainedRef?.operationStatus, "not_attempted");
    assert.equal(retainedRef?.reasonCode, "cancelled");
  } finally {
    repo.cleanup();
  }
});

test("failed checks amend the same logical task commit", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-amend-b1c2d3e4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const base = lifecycle.root.head;
    fs.writeFileSync(path.join(repo.workingDir, "amendment.txt"), "first\n");
    const provisional = lifecycle.commit(
      "root",
      base,
      ["amendment.txt"],
      "implement amendable task",
    );
    fs.writeFileSync(path.join(repo.workingDir, "amendment.txt"), "fixed\n");

    const amended = lifecycle.amend("root", provisional.commit, [
      "amendment.txt",
    ]);

    assert.notEqual(amended.commit, provisional.commit);
    assert.equal(
      git(repo.workingDir, ["rev-parse", `${amended.commit}^`]),
      base,
    );
    assert.equal(
      git(repo.workingDir, ["rev-list", "--count", `${base}..HEAD`]),
      "1",
    );
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "amendment.txt"), "utf8"),
      "fixed\n",
    );
  } finally {
    repo.cleanup();
  }
});

test("same-HEAD external branch switches reject task commits", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-branch-guard-c1d2e3f4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const base = lifecycle.root.head;
    git(repo.workingDir, ["switch", "-qc", "external-same-head"]);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "changed\n");

    assert.throws(
      () =>
        lifecycle.commit(
          "root",
          base,
          ["selected.txt"],
          "must not commit on another branch",
        ),
      /branch.*drift|git branch.*drift/i,
    );
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), base);
  } finally {
    repo.cleanup();
  }
});

test("caller and child preparation baselines survive commit and amend", () => {
  const repo = fixture();
  try {
    const callerCache = path.join(repo.workingDir, "caller-cache.tmp");
    fs.writeFileSync(callerCache, "caller cache\n");
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-d1e2f3a4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    assert.deepEqual(lifecycle.root.preparationBaseline, ["caller-cache.tmp"]);
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "root task\n");
    lifecycle.commit(
      "root",
      lifecycle.root.head,
      ["selected.txt"],
      "root task",
    );
    assert.equal(fs.readFileSync(callerCache, "utf8"), "caller cache\n");

    const child = lifecycle.createChild("root", 1, "child-task");
    lifecycle.notePreparationAttempt(child.id);
    const childCache = path.join(child.worktree, "child-cache.tmp");
    const ignoredDirectory = path.join(child.worktree, "node_modules");
    fs.writeFileSync(childCache, "child cache\n");
    fs.mkdirSync(path.join(ignoredDirectory, "nested"), { recursive: true });
    fs.writeFileSync(path.join(ignoredDirectory, "nested", "one.js"), "one\n");
    fs.writeFileSync(path.join(ignoredDirectory, "nested", "two.js"), "two\n");
    const prepared = lifecycle.recordPreparationBaseline(child.id);
    assert.deepEqual(prepared.preparationBaseline, [
      "child-cache.tmp",
      "node_modules/",
    ]);
    fs.writeFileSync(
      path.join(child.worktree, "amendment.txt"),
      "child first\n",
    );
    const provisional = lifecycle.commit(
      child.id,
      child.head,
      ["amendment.txt"],
      "child task",
    );
    fs.writeFileSync(
      path.join(child.worktree, "amendment.txt"),
      "child fixed\n",
    );
    lifecycle.amend(child.id, provisional.commit, ["amendment.txt"]);

    assert.equal(fs.readFileSync(childCache, "utf8"), "child cache\n");
    assert.equal(
      fs.readFileSync(path.join(ignoredDirectory, "nested", "one.js"), "utf8"),
      "one\n",
    );
    assert.deepEqual(lifecycle.branch(child.id).preparationBaseline, [
      "child-cache.tmp",
      "node_modules/",
    ]);
  } finally {
    repo.cleanup();
  }
});

test("task commits reject symlink chains that ultimately escape the worktree", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-symlink-chain-e1f2a3b4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    fs.symlinkSync(repo.external, path.join(repo.workingDir, "safe-hop"));
    fs.symlinkSync("safe-hop", path.join(repo.workingDir, "chain"));

    assert.throws(
      () =>
        lifecycle.commit(
          "root",
          lifecycle.root.head,
          ["chain"],
          "unsafe symlink chain",
        ),
      /symlink.*outside|escaping.*symlink/i,
    );
    assert.equal(git(repo.workingDir, ["diff", "--cached", "--name-only"]), "");
  } finally {
    repo.cleanup();
  }
});

test("task commits reject deletion of a tracked external symlink", () => {
  const repo = fixture({ trackedExternalSymlink: true });
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-symlink-delete-f1a2b3c4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    fs.rmSync(path.join(repo.workingDir, "external-link"));

    assert.throws(
      () =>
        lifecycle.commit(
          "root",
          lifecycle.root.head,
          ["external-link"],
          "unsafe symlink deletion",
        ),
      /symlink.*outside|escaping.*symlink/i,
    );
    assert.equal(git(repo.workingDir, ["diff", "--cached", "--name-only"]), "");
  } finally {
    repo.cleanup();
  }
});

test("failed child allocation never deletes an unowned existing ref", () => {
  const repo = fixture();
  const originalPath = process.env.PATH;
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-allocation-a2b3c4d5",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const branchName =
      "pipi-feature/feature-allocation-a2b3c4d5/branch-1-task-a";
    const reference = `refs/heads/${branchName}`;
    const expected = lifecycle.root.head;
    git(repo.workingDir, ["branch", branchName, expected]);

    const wrapperDirectory = path.join(repo.root, "git-wrapper");
    const wrapper = path.join(wrapperDirectory, "git");
    const realGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const quotedGit = "'" + realGit.replaceAll("'", "'\"'\"'") + "'";
    fs.mkdirSync(wrapperDirectory);
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "show-ref" ]; then exit 1; fi\nexec ${quotedGit} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath ?? ""}`;
    assert.throws(
      () => lifecycle.createChild("root", 1, "task-a"),
      /Unable to create child worktree/,
    );
    process.env.PATH = originalPath;

    assert.equal(git(repo.workingDir, ["rev-parse", reference]), expected);
  } finally {
    process.env.PATH = originalPath;
    repo.cleanup();
  }
});
