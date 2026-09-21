import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CleanupEvidence } from "./cleanup-evidence.ts";
import { FeatureSubtreeOperationError } from "./feature-execution-contract.ts";
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

for (const mode of [
  "recreate",
  "submodule-layout",
  "mutated",
  "staged",
  "arbitrary",
  "drift",
  "conflict",
  "failure",
  "failure-after-move",
] as const) {
  test(`owned clean handoff: ${mode}`, () => {
    const repo = fixture();
    const originalPath = process.env.PATH;
    try {
      const lifecycle = createFeatureTaskWorktreeLifecycle({
        runId: "handoff-12345678",
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
      });
      const child = lifecycle.createChild("root", 1, "task");
      assert.deepEqual(lifecycle.recreateForHandoff(child.id), child);
      assert.deepEqual(
        lifecycle.recreateForHandoff("root"),
        lifecycle.branch("root"),
      );
      fs.writeFileSync(path.join(repo.workingDir, "foreign"), "caller");
      assert.throws(
        () => lifecycle.recreateForHandoff("root"),
        /caller-owned root/,
      );
      const oldTarget = lifecycle.target(child.id);
      const nested = path.join(child.worktree, "leftover");
      fs.mkdirSync(nested);
      git(nested, ["init", "-q"]);
      fs.writeFileSync(path.join(nested, "bytes"), "diagnostic bytes");
      fs.mkdirSync(path.join(child.worktree, "node_modules"));
      fs.writeFileSync(
        path.join(child.worktree, "node_modules", "cache"),
        "original cache",
      );
      fs.writeFileSync(path.join(child.worktree, "selected.txt"), "accepted\n");
      if (mode === "submodule-layout")
        git(child.worktree, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "-q",
          repo.primary,
          "component",
        ]);
      const accepted = lifecycle.commit(
        child.id,
        child.head,
        mode === "submodule-layout"
          ? ["selected.txt", ".gitmodules", "component"]
          : ["selected.txt"],
        "accepted",
      );
      assert.ok(lifecycle.branch(child.id).untrackedResiduals?.length);
      if (mode === "mutated")
        fs.writeFileSync(path.join(nested, "bytes"), "changed");
      if (mode === "staged") {
        fs.writeFileSync(path.join(child.worktree, "amendment.txt"), "staged");
        git(child.worktree, ["add", "amendment.txt"]);
      }
      if (mode === "arbitrary")
        fs.writeFileSync(path.join(child.worktree, "foreign"), "foreign");
      if (mode === "drift")
        git(child.worktree, ["commit", "--allow-empty", "-qm", "foreign"]);
      if (mode === "conflict")
        fs.writeFileSync(
          git(child.worktree, ["rev-parse", "--git-path", "MERGE_HEAD"]),
          accepted.commit,
        );
      if (mode === "failure")
        git(repo.workingDir, ["worktree", "lock", child.worktree]);
      if (mode === "failure-after-move") {
        const realGit = execFileSync("which", ["git"], {
          encoding: "utf8",
        }).trim();
        const wrapperDirectory = path.join(repo.root, "wrapper");
        fs.mkdirSync(wrapperDirectory);
        fs.writeFileSync(
          path.join(wrapperDirectory, "git"),
          `#!/bin/sh\ncase " $* " in *" worktree add "*) exit 43;; esac\nexec '${realGit.replaceAll("'", "'\\\"'\\\"'")}' "$@"\n`,
          { mode: 0o755 },
        );
        process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath ?? ""}`;
        assert.throws(
          () => lifecycle.recreateForHandoff(child.id),
          /recovery evidence/,
        );
        process.env.PATH = originalPath;
        assert.throws(() => lifecycle.target(child.id), /manual recovery/);
        lifecycle.cleanupCompleted();
        const directory = fs
          .readdirSync(lifecycle.runDirectory)
          .find((name) => name.startsWith("retained-handoff-"))!;
        const retained = path.join(
          lifecycle.runDirectory,
          directory,
          "worktree",
        );
        assert.equal(
          fs.readFileSync(path.join(retained, "leftover", "bytes"), "utf8"),
          "diagnostic bytes",
        );
        assert.equal(git(retained, ["rev-parse", "HEAD"]), accepted.commit);
        assert.equal(
          git(repo.workingDir, ["rev-parse", child.branch]),
          accepted.commit,
        );
        return;
      }
      if (mode !== "recreate" && mode !== "submodule-layout") {
        assert.throws(() => lifecycle.recreateForHandoff(child.id));
        assert.ok(fs.existsSync(nested));
        if (mode === "failure") {
          assert.throws(() => lifecycle.branch(child.id), /manual recovery/);
          lifecycle.cleanupCompleted();
          assert.ok(fs.existsSync(nested));
          assert.equal(
            git(child.worktree, ["rev-parse", "HEAD"]),
            accepted.commit,
          );
        }
        return;
      }
      const replacement = lifecycle.recreateForHandoff(child.id);
      if (mode === "submodule-layout") {
        assert.notEqual(replacement.worktree, child.worktree);
        assert.notEqual(replacement.branch, child.branch);
      } else {
        assert.equal(replacement.worktree, child.worktree);
        assert.equal(replacement.branch, child.branch);
      }
      assert.equal(replacement.head, accepted.commit);
      assert.equal(replacement.prepared, false);
      assert.deepEqual(replacement.untrackedResiduals, []);
      assert.deepEqual(replacement.trackedResiduals, []);
      assert.deepEqual(replacement.preparationBaseline, []);
      assert.equal(git(replacement.worktree, ["status", "--porcelain"]), "");
      lifecycle.target(child.id).assertCleanHandoff!();
      assert.throws(() => oldTarget.assertCleanHandoff!(), /ownership/);
      const retainedDirectory = fs
        .readdirSync(lifecycle.runDirectory)
        .find((name) => name.startsWith("retained-handoff-"))!;
      const directory = path.join(lifecycle.runDirectory, retainedDirectory);
      const retained =
        mode === "submodule-layout"
          ? child.worktree
          : path.join(directory, "worktree");
      const evidence = JSON.parse(
        fs.readFileSync(path.join(directory, "retention.json"), "utf8"),
      );
      assert.equal(evidence.branch.head, accepted.commit);
      assert.equal(git(retained, ["rev-parse", "HEAD"]), accepted.commit);
      assert.equal(
        fs.readFileSync(path.join(retained, "leftover", "bytes"), "utf8"),
        "diagnostic bytes",
      );
      assert.equal(
        fs.readFileSync(path.join(retained, "node_modules", "cache"), "utf8"),
        "original cache",
      );
      assert.equal(
        fs.existsSync(path.join(replacement.worktree, "node_modules")),
        false,
      );
      lifecycle.removeJoinedWorktree(child.id);
      lifecycle.cleanupCompleted();
      assert.ok(fs.existsSync(path.join(retained, "node_modules", "cache")));
      if (mode === "submodule-layout") {
        assert.equal(
          fs.readFileSync(
            path.join(retained, "component", "selected.txt"),
            "utf8",
          ),
          "base\n",
        );
        assert.equal(
          git(repo.workingDir, ["rev-parse", child.branch]),
          accepted.commit,
        );
      }
      assert.equal(git(retained, ["rev-parse", "HEAD"]), accepted.commit);
    } finally {
      process.env.PATH = originalPath;
      repo.cleanup();
    }
  });
}

test("tracked residual recreation preserves dirty bytes and committed source", () => {
  const repo = fixture();
  const originalPath = process.env.PATH;
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "tracked-handoff-12345678",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "task");
    fs.writeFileSync(path.join(child.worktree, "selected.txt"), "accepted\n");
    fs.writeFileSync(path.join(child.worktree, "amendment.txt"), "residual\n");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const wrapperDirectory = path.join(repo.root, "wrapper");
    fs.mkdirSync(wrapperDirectory);
    fs.writeFileSync(
      path.join(wrapperDirectory, "git"),
      `#!/bin/sh\ncase " $* " in *" restore "*) exit 43;; esac\nexec '${realGit.replaceAll("'", "'\\\"'\\\"'")}' "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath ?? ""}`;
    const result = lifecycle.commit(
      child.id,
      child.head,
      ["selected.txt"],
      "accepted",
    );
    process.env.PATH = originalPath;
    assert.deepEqual(lifecycle.branch(child.id).trackedResidualPaths, [
      "amendment.txt",
    ]);
    fs.writeFileSync(path.join(child.worktree, "amendment.txt"), "mutated\n");
    assert.throws(
      () => lifecycle.recreateForHandoff(child.id),
      /changed handoff residual/,
    );
    fs.writeFileSync(path.join(child.worktree, "amendment.txt"), "residual\n");
    const target = lifecycle.target(child.id);
    fs.writeFileSync(path.join(child.worktree, "selected.txt"), "checkpoint\n");
    target.stage!({ action: "stage", paths: ["selected.txt"] });
    const checkpoint = target.checkpoint!({ message: "checkpoint" });
    const replacement = lifecycle.recreateForHandoff(child.id);
    assert.equal(replacement.head, checkpoint.commit);
    assert.deepEqual(lifecycle.target(child.id).range!(result.commit).commits, [
      checkpoint.commit,
    ]);
    assert.equal(
      fs.readFileSync(path.join(replacement.worktree, "amendment.txt"), "utf8"),
      "base\n",
    );
    const directory = fs
      .readdirSync(lifecycle.runDirectory)
      .find((name) => name.startsWith("retained-handoff-"))!;
    const retained = path.join(lifecycle.runDirectory, directory, "worktree");
    assert.equal(
      fs.readFileSync(path.join(retained, "amendment.txt"), "utf8"),
      "residual\n",
    );
    assert.equal(git(retained, ["rev-parse", "HEAD"]), checkpoint.commit);
    lifecycle.assertCleanHandoff(child.id);
  } finally {
    process.env.PATH = originalPath;
    repo.cleanup();
  }
});

for (const rootTarget of [false, true]) {
  test(`scoped checkpoints preserve work and ordered range (root=${rootTarget})`, () => {
    const repo = fixture();
    try {
      const lifecycle = createFeatureTaskWorktreeLifecycle({
        runId: "checkpoints-12345678",
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
      });
      const child = rootTarget
        ? undefined
        : lifecycle.createChild("root", 1, "task");
      const target = rootTarget
        ? createFeatureRootTaskGitTarget(repo.workingDir)
        : lifecycle.target(child!.id);
      const cwd = target.worktree;
      const base = target.head();
      fs.mkdirSync(path.join(cwd, "node_modules"));
      fs.writeFileSync(path.join(cwd, "node_modules", "keep"), "environment");
      fs.writeFileSync(path.join(cwd, "leftover"), "user work");
      const commits: string[] = [];
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(cwd, "selected.txt"), `checkpoint ${i}\n`);
        target.stage!({ action: "stage", paths: ["selected.txt"] });
        assert.deepEqual(
          target.stage!({ action: "unstage", paths: ["selected.txt"] }).staged,
          [],
        );
        target.stage!({ action: "stage", paths: ["selected.txt"] });
        commits.push(target.checkpoint!({ message: `checkpoint ${i}` }).commit);
        assert.throws(() => target.checkpoint!({ message: "empty" }), /staged/);
      }
      assert.deepEqual(target.range!(base), {
        baseCommit: base,
        headCommit: commits[2],
        commits,
      });
      assert.deepEqual(target.range!(commits[0]!).commits, commits.slice(1));
      assert.equal(
        fs.readFileSync(path.join(cwd, "leftover"), "utf8"),
        "user work",
      );
      assert.equal(
        fs.readFileSync(path.join(cwd, "node_modules", "keep"), "utf8"),
        "environment",
      );
      assert.throws(() => target.assertCleanHandoff!(), /handoff/);
      fs.unlinkSync(path.join(cwd, "leftover"));
      target.assertCleanHandoff!();
      git(cwd, ["commit", "--allow-empty", "-qm", "foreign"]);
      assert.throws(() => target.range!(base), /ownership/);
      assert.throws(
        () => target.stage!({ action: "stage", paths: [] }),
        /ownership/,
      );
    } finally {
      repo.cleanup();
    }
  });
}

test("scoped staging rejects unsafe paths and disables hooks", () => {
  const repo = fixture();
  try {
    const target = createFeatureRootTaskGitTarget(repo.workingDir);
    fs.symlinkSync(repo.external, path.join(repo.workingDir, "escape"));
    assert.throws(
      () => target.stage({ action: "stage", paths: ["escape"] }),
      /symlink/,
    );
    assert.throws(
      () => target.stage({ action: "stage", paths: ["../external"] }),
      /unsafe/,
    );
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "changed");
    const hooks = path.join(repo.root, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    git(repo.workingDir, ["config", "core.hooksPath", hooks]);
    target.stage({ action: "stage", paths: ["selected.txt"] });
    target.checkpoint({ message: "hooks disabled" });
    git(repo.workingDir, ["checkout", "-qb", "foreign"]);
    assert.throws(() => target.checkpoint({ message: "denied" }), /ownership/);
  } finally {
    repo.cleanup();
  }
});

test("scoped checkpoints continue only controller-owned cherry-picks", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "conflict-12345678",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "task");
    const target = lifecycle.target(child.id);
    fs.writeFileSync(path.join(child.worktree, "selected.txt"), "child\n");
    target.stage!({ action: "stage", paths: ["selected.txt"] });
    const source = target.checkpoint!({ message: "child" }).commit;
    const root = lifecycle.target("root");
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "parent\n");
    root.stage!({ action: "stage", paths: ["selected.txt"] });
    const base = root.checkpoint!({ message: "parent" }).commit;
    assert.equal(lifecycle.cherryPick("root", source).status, "conflict");
    assert.throws(
      () => root.checkpoint!({ message: "unresolved" }),
      /Unresolved/,
    );
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "resolved\n");
    root.stage!({ action: "stage", paths: ["selected.txt"] });
    const commit = root.checkpoint!({ message: "resolved" }).commit;
    assert.deepEqual(root.range!(base).commits, [commit]);
    const gitDir = git(repo.workingDir, ["rev-parse", "--absolute-git-dir"]);
    fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), source);
    assert.throws(
      () => root.stage!({ action: "stage", paths: [] }),
      /sequencer/,
    );
  } finally {
    repo.cleanup();
  }
});

test("scoped target denies foreign ref movement and staged escaping symlink blobs", () => {
  const repo = fixture();
  try {
    const target = createFeatureRootTaskGitTarget(repo.workingDir);
    const base = target.head();
    fs.symlinkSync(repo.external, path.join(repo.workingDir, "link"));
    git(repo.workingDir, ["add", "link"]);
    fs.unlinkSync(path.join(repo.workingDir, "link"));
    fs.writeFileSync(
      path.join(repo.workingDir, "link"),
      "innocent working copy",
    );
    assert.throws(
      () => target.checkpoint({ message: "unsafe index" }),
      /symlink/,
    );
    target.stage({ action: "unstage", paths: ["link"] });
    fs.writeFileSync(path.join(repo.workingDir, "selected.txt"), "change");
    target.stage({ action: "stage", paths: ["selected.txt"] });
    target.checkpoint({ message: "checkpoint" });
    git(repo.workingDir, ["update-ref", `refs/heads/${target.branch}`, base]);
    assert.throws(() => target.range(base), /ownership/);
  } finally {
    repo.cleanup();
  }
});

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

function gitState(cwd: string) {
  return {
    branch: git(cwd, ["branch", "--show-current"]),
    head: git(cwd, ["rev-parse", "HEAD"]),
    index: git(cwd, ["ls-files", "--stage"]),
    stagedDiff: git(cwd, ["diff", "--cached", "--binary"]),
    worktreeDiff: git(cwd, ["diff", "--binary"]),
    status: git(cwd, ["status", "--short", "--untracked-files=all"]),
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
  fs.writeFileSync(
    path.join(primary, "build-identity.json"),
    '{"identity":"base"}\n',
  );
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

for (const failure of [
  "allocation",
  "identity",
  "evidence",
  "post-identity",
] as const) {
  test(
    `allocation boundary preserves ${failure} failure scope`,
    { skip: process.getuid?.() === 0 },
    () => {
      const repo = fixture();
      const records: CleanupEvidence[] = [];
      const sinkError = new Error("evidence persistence failed");
      const lifecycle = createFeatureTaskWorktreeLifecycle({
        runId: "allocation-12345678",
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        cleanupEvidence(record) {
          if (failure === "evidence") throw sinkError;
          records.push(record);
          if (failure === "post-identity" && records.length === 1)
            git(repo.workingDir, ["checkout", "-qb", "foreign"]);
        },
      });
      try {
        const parent = lifecycle.createChild("root", 1, "parent");
        fs.chmodSync(lifecycle.runDirectory, 0o555);
        if (failure === "identity")
          git(repo.workingDir, ["checkout", "-qb", "foreign"]);
        assert.throws(
          () => lifecycle.createChild(parent.id, 2, "nested"),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            if (failure === "allocation") {
              assert.ok(error instanceof FeatureSubtreeOperationError);
              assert.equal(error.operation, "worktree-allocation");
              assert.ok(error.cause instanceof Error);
              assert.ok("status" in error.cause);
              assert.equal(typeof error.cause.status, "number");
            } else {
              assert.ok(!(error instanceof FeatureSubtreeOperationError));
              if (failure === "evidence") assert.equal(error, sinkError);
            }
            return true;
          },
        );
        if (failure === "allocation") {
          lifecycle.verifyOwnership("root");
          lifecycle.verifyOwnership(parent.id);
          const reference = `refs/heads/pipi-feature/${lifecycle.runId}/branch-2-nested`;
          // Git creates the ref before failing to create the worktree directory.
          assert.equal(
            git(repo.workingDir, ["rev-parse", reference]),
            parent.head,
          );
          assert.ok(
            records.some(
              (record) =>
                record.resource === reference &&
                record.disposition === "retained",
            ),
          );
          records.length = 0;
          lifecycle.recordRetainedResources("failed_run");
          assert.ok(
            records.some(
              (record) =>
                record.resource === reference &&
                record.disposition === "retained",
            ),
          );
          fs.chmodSync(lifecycle.runDirectory, 0o755);
          assert.throws(() => lifecycle.createChild(parent.id, 2, "nested"));
          const sibling = lifecycle.createChild("root", 3, "sibling");
          lifecycle.verifyOwnership(sibling.id);
        }
      } finally {
        fs.chmodSync(lifecycle.runDirectory, 0o755);
        repo.cleanup();
      }
    },
  );
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

test("preparation baselines retain untracked outputs and report tracked changes", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-tracked-f1a2b3c4",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "tracked-preparation");
    lifecycle.notePreparationAttempt(child.id);

    fs.writeFileSync(
      path.join(child.worktree, "child-cache.tmp"),
      "preparation cache\n",
    );
    fs.mkdirSync(path.join(child.worktree, "node_modules", ".bin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(child.worktree, "node_modules", ".bin", "tool"),
      "tool\n",
    );
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared"}\n',
    );
    fs.writeFileSync(
      path.join(child.worktree, "amendment.txt"),
      "preparation update\n",
    );
    fs.writeFileSync(
      path.join(child.worktree, "preparation-added.txt"),
      "staged preparation output\n",
    );
    git(child.worktree, [
      "add",
      "--",
      "amendment.txt",
      "preparation-added.txt",
    ]);

    const prepared = lifecycle.recordPreparationBaseline(child.id);
    assert.equal(prepared.prepared, true);
    assert.deepEqual(prepared.preparationBaseline, [
      "child-cache.tmp",
      "node_modules/",
    ]);
    assert.ok(prepared.preparationChanges);
    assert.deepEqual(
      prepared.preparationChanges.map(({ path: filePath }) => filePath),
      ["amendment.txt", "build-identity.json", "preparation-added.txt"],
    );
    assert.equal(
      prepared.preparationChanges.every(
        ({ fingerprint }) => fingerprint.length > 0,
      ),
      true,
    );

    const target = lifecycle.target(child.id);
    assert.deepEqual(target.preparationChanges!(), prepared.preparationChanges);
    assert.deepEqual(
      lifecycle.branch(child.id).preparationChanges,
      prepared.preparationChanges,
    );
  } finally {
    repo.cleanup();
  }
});

test("preparation finalization rejects omissions and invalid selections without mutation", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-validation-a2b3c4d5",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "preparation-validation");
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared"}\n',
    );
    fs.writeFileSync(
      path.join(child.worktree, "amendment.txt"),
      "staged preparation update\n",
    );
    fs.writeFileSync(
      path.join(child.worktree, "preparation-added.txt"),
      "staged preparation output\n",
    );
    git(child.worktree, [
      "add",
      "--",
      "amendment.txt",
      "preparation-added.txt",
    ]);
    lifecycle.recordPreparationBaseline(child.id);

    const target = lifecycle.target(child.id);
    const pendingPaths = target.preparationChanges!()
      .map(({ path: filePath }) => filePath)
      .sort();
    const before = gitState(child.worktree);
    const rejectWithoutMutation = (
      commitPaths: ReadonlyArray<string>,
      discardPaths: ReadonlyArray<string>,
    ) => {
      assert.throws(() =>
        target.prepareFinalization!(commitPaths, discardPaths),
      );
      assert.deepEqual(gitState(child.worktree), before);
      assert.deepEqual(
        target.preparationChanges!()
          .map(({ path: filePath }) => filePath)
          .sort(),
        pendingPaths,
      );
    };

    rejectWithoutMutation(["build-identity.json"], ["amendment.txt"]);
    rejectWithoutMutation([], []);
    rejectWithoutMutation(
      ["build-identity.json", "build-identity.json"],
      ["amendment.txt", "preparation-added.txt"],
    );
    rejectWithoutMutation(
      ["build-identity.json"],
      ["build-identity.json", "amendment.txt", "preparation-added.txt"],
    );
    rejectWithoutMutation(
      [
        "build-identity.json",
        "amendment.txt",
        "preparation-added.txt",
        "../outside",
      ],
      [],
    );
    rejectWithoutMutation(
      ["build-identity.json", "amendment.txt", "preparation-added.txt"],
      ["selected.txt"],
    );
  } finally {
    repo.cleanup();
  }
});

test("preparation changes require explicit selection before a task commit", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-commit-b3c4d5e6",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "preparation-commit");
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared"}\n',
    );
    lifecycle.recordPreparationBaseline(child.id);
    fs.writeFileSync(path.join(child.worktree, "selected.txt"), "task\n");

    const target = lifecycle.target(child.id);
    const base = child.head;
    const before = gitState(child.worktree);
    assert.throws(() =>
      target.commit(base, ["selected.txt"], "bypass preparation selection"),
    );
    assert.deepEqual(gitState(child.worktree), before);
    assert.deepEqual(
      target.preparationChanges!().map(({ path: filePath }) => filePath),
      ["build-identity.json"],
    );

    target.prepareFinalization!(["build-identity.json", "selected.txt"], []);
    assert.deepEqual(
      target.preparationChanges!().map(({ path: filePath }) => filePath),
      ["build-identity.json"],
    );
    const result = target.commit(
      base,
      ["build-identity.json", "selected.txt"],
      "commit selected preparation output",
    );

    assert.deepEqual(result.changedPaths, [
      "build-identity.json",
      "selected.txt",
    ]);
    assert.deepEqual(
      lines(
        git(child.worktree, [
          "show",
          "--format=",
          "--name-only",
          result.commit,
        ]),
      ),
      ["build-identity.json", "selected.txt"],
    );
    assert.deepEqual(target.preparationChanges!(), []);
    assert.deepEqual(lifecycle.branch(child.id).preparationChanges ?? [], []);
  } finally {
    repo.cleanup();
  }
});

test("preparation fingerprints stay as provenance when selecting edited output", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-edited-output-c5d6e7f8",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "edited-preparation");
    const preparationPath = "build-identity.json";
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, preparationPath),
      '{"identity":"generated"}\n',
    );
    lifecycle.recordPreparationBaseline(child.id);

    const target = lifecycle.target(child.id);
    const pendingBeforeAgentEdit = target.preparationChanges!();
    assert.deepEqual(
      pendingBeforeAgentEdit.map(({ path: filePath }) => filePath),
      [preparationPath],
    );

    fs.writeFileSync(
      path.join(child.worktree, preparationPath),
      '{"identity":"rebuilt-by-agent"}\n',
    );
    git(child.worktree, ["add", "--", preparationPath]);

    target.prepareFinalization!([preparationPath], []);
    assert.deepEqual(target.preparationChanges!(), pendingBeforeAgentEdit);
    const result = target.commit(
      child.head,
      [preparationPath],
      "select edited preparation output",
    );

    assert.deepEqual(result.changedPaths, [preparationPath]);
    assert.equal(
      git(child.worktree, ["show", `${result.commit}:${preparationPath}`]),
      '{"identity":"rebuilt-by-agent"}',
    );
    assert.deepEqual(target.preparationChanges!(), []);
  } finally {
    repo.cleanup();
  }
});

test("preparation discard restores the base path without touching unrelated edits", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-edited-discard-d6e7f8a9",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild(
      "root",
      1,
      "discard-edited-preparation",
    );
    const preparationPath = "build-identity.json";
    const unrelatedPath = "selected.txt";
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, preparationPath),
      '{"identity":"generated"}\n',
    );
    lifecycle.recordPreparationBaseline(child.id);

    const target = lifecycle.target(child.id);
    const pendingBeforeAgentEdit = target.preparationChanges!();
    fs.writeFileSync(
      path.join(child.worktree, preparationPath),
      '{"identity":"edited-after-generation"}\n',
    );
    git(child.worktree, ["add", "--", preparationPath]);
    fs.writeFileSync(
      path.join(child.worktree, unrelatedPath),
      "unrelated edit\n",
    );
    git(child.worktree, ["add", "--", unrelatedPath]);

    const beforeOmittedDiscard = gitState(child.worktree);
    assert.throws(() => target.prepareFinalization!([], []));
    assert.deepEqual(gitState(child.worktree), beforeOmittedDiscard);
    assert.deepEqual(target.preparationChanges!(), pendingBeforeAgentEdit);

    target.prepareFinalization!([], [preparationPath]);
    assert.equal(
      fs.readFileSync(path.join(child.worktree, preparationPath), "utf8"),
      '{"identity":"base"}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(child.worktree, unrelatedPath), "utf8"),
      "unrelated edit\n",
    );
    assert.equal(
      git(child.worktree, [
        "diff",
        "--cached",
        "--name-only",
        "--",
        preparationPath,
      ]),
      "",
    );
    assert.equal(
      git(child.worktree, ["diff", "--name-only", "--", preparationPath]),
      "",
    );
    assert.equal(
      git(child.worktree, ["diff", "--cached", "--name-only"]),
      unrelatedPath,
    );
    assert.deepEqual(target.preparationChanges!(), []);
  } finally {
    repo.cleanup();
  }
});

test("explicit empty commit selection discards only preparation changes", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-discard-c4d5e6f7",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "preparation-discard");
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "child-cache.tmp"),
      "preparation cache\n",
    );
    fs.mkdirSync(path.join(child.worktree, "node_modules", "nested"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(child.worktree, "node_modules", "nested", "one.js"),
      "one\n",
    );
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared"}\n',
    );
    fs.writeFileSync(
      path.join(child.worktree, "amendment.txt"),
      "staged preparation update\n",
    );
    fs.writeFileSync(
      path.join(child.worktree, "preparation-added.txt"),
      "staged preparation output\n",
    );
    git(child.worktree, [
      "add",
      "--",
      "amendment.txt",
      "preparation-added.txt",
    ]);
    lifecycle.recordPreparationBaseline(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "unrelated-after-preparation.txt"),
      "keep this file\n",
    );

    const target = lifecycle.target(child.id);
    target.prepareFinalization!(
      [],
      ["amendment.txt", "build-identity.json", "preparation-added.txt"],
    );

    assert.equal(
      fs.readFileSync(path.join(child.worktree, "build-identity.json"), "utf8"),
      '{"identity":"base"}\n',
    );
    assert.equal(
      fs.readFileSync(path.join(child.worktree, "amendment.txt"), "utf8"),
      "base\n",
    );
    assert.equal(
      fs.existsSync(path.join(child.worktree, "preparation-added.txt")),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(child.worktree, "child-cache.tmp")),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(child.worktree, "node_modules", "nested", "one.js"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(child.worktree, "unrelated-after-preparation.txt"),
      ),
      true,
    );
    assert.equal(git(child.worktree, ["diff", "--cached", "--name-only"]), "");
    assert.equal(git(child.worktree, ["rev-parse", "HEAD"]), child.head);
    assert.deepEqual(target.preparationChanges!(), []);
  } finally {
    repo.cleanup();
  }
});

test("mixed preparation commit and discard clears pending paths after the commit", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-mixed-d5e6f7a8",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "preparation-mixed");
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared"}\n',
    );
    fs.writeFileSync(
      path.join(child.worktree, "preparation-added.txt"),
      "discard this preparation output\n",
    );
    git(child.worktree, ["add", "--", "preparation-added.txt"]);
    lifecycle.recordPreparationBaseline(child.id);
    fs.writeFileSync(path.join(child.worktree, "selected.txt"), "task\n");

    const target = lifecycle.target(child.id);
    const base = child.head;
    target.prepareFinalization!(
      ["build-identity.json", "selected.txt"],
      ["preparation-added.txt"],
    );
    assert.equal(
      fs.readFileSync(path.join(child.worktree, "build-identity.json"), "utf8"),
      '{"identity":"prepared"}\n',
    );
    assert.equal(
      fs.existsSync(path.join(child.worktree, "preparation-added.txt")),
      false,
    );
    assert.deepEqual(
      target.preparationChanges!().map(({ path: filePath }) => filePath),
      ["build-identity.json"],
    );

    const result = target.commit(
      base,
      ["build-identity.json", "selected.txt"],
      "commit and discard preparation outputs",
    );
    assert.deepEqual(result.changedPaths, [
      "build-identity.json",
      "selected.txt",
    ]);
    assert.deepEqual(target.preparationChanges!(), []);
  } finally {
    repo.cleanup();
  }
});

test("failed preparation commit keeps pending selection for a successful retry", () => {
  const repo = fixture();
  const originalPath = process.env.PATH;
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-retry-e6f7a8b9",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "preparation-retry");
    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared"}\n',
    );
    lifecycle.recordPreparationBaseline(child.id);
    const target = lifecycle.target(child.id);
    const base = child.head;
    target.prepareFinalization!(["build-identity.json"], []);

    const wrapperDirectory = path.join(repo.root, "git-wrapper");
    const wrapper = path.join(wrapperDirectory, "git");
    const failedOnce = path.join(wrapperDirectory, "failed-once");
    const realGit = execFileSync("which", ["git"], {
      encoding: "utf8",
    }).trim();
    const quotedGit = "'" + realGit.replaceAll("'", "'\"'\"'") + "'";
    fs.mkdirSync(wrapperDirectory);
    fs.writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'case " $* " in',
        '  *" commit "*)',
        '    if [ ! -e "' + failedOnce + '" ]; then',
        '      : > "' + failedOnce + '"',
        "      exit 42",
        "    fi",
        "    ;;",
        "esac",
        "exec " + quotedGit + ' "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath ?? ""}`;
    assert.throws(() =>
      target.commit(
        base,
        ["build-identity.json"],
        "retryable preparation commit",
      ),
    );
    process.env.PATH = originalPath;

    assert.equal(git(child.worktree, ["rev-parse", "HEAD"]), base);
    assert.deepEqual(
      target.preparationChanges!().map(({ path: filePath }) => filePath),
      ["build-identity.json"],
    );
    const retried = target.commit(
      base,
      ["build-identity.json"],
      "retryable preparation commit",
    );
    assert.notEqual(retried.commit, base);
    assert.deepEqual(target.preparationChanges!(), []);
  } finally {
    process.env.PATH = originalPath;
    repo.cleanup();
  }
});

test("successful amend clears a selected preparation change", () => {
  const repo = fixture();
  try {
    const lifecycle = createFeatureTaskWorktreeLifecycle({
      runId: "feature-preparation-amend-f7a8b9c0",
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
    });
    const child = lifecycle.createChild("root", 1, "preparation-amend");
    lifecycle.notePreparationAttempt(child.id);
    const target = lifecycle.target(child.id);
    const base = child.head;
    fs.writeFileSync(path.join(child.worktree, "selected.txt"), "task\n");
    const provisional = target.commit(
      base,
      ["selected.txt"],
      "provisional task",
    );

    lifecycle.notePreparationAttempt(child.id);
    fs.writeFileSync(
      path.join(child.worktree, "build-identity.json"),
      '{"identity":"prepared-after-provisional"}\n',
    );
    git(child.worktree, ["add", "--", "build-identity.json"]);
    lifecycle.recordPreparationBaseline(child.id);
    target.prepareFinalization!(["build-identity.json"], []);

    const beforeOmittedAmend = gitState(child.worktree);
    assert.throws(() => target.amend(provisional.commit, []));
    assert.deepEqual(gitState(child.worktree), beforeOmittedAmend);
    assert.deepEqual(
      target.preparationChanges!().map(({ path: filePath }) => filePath),
      ["build-identity.json"],
    );

    const amended = target.amend(provisional.commit, ["build-identity.json"]);
    assert.notEqual(amended.commit, provisional.commit);
    assert.equal(
      git(child.worktree, ["rev-parse", `${amended.commit}^`]),
      base,
    );
    assert.equal(
      git(child.worktree, ["rev-list", "--count", `${base}..HEAD`]),
      "1",
    );
    assert.deepEqual(target.preparationChanges!(), []);
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
      /Owned child branch already exists/,
    );
    process.env.PATH = originalPath;

    assert.equal(git(repo.workingDir, ["rev-parse", reference]), expected);
  } finally {
    process.env.PATH = originalPath;
    repo.cleanup();
  }
});
