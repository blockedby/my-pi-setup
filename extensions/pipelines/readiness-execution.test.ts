import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runFeatureCheckCommand } from "./feature-task-runtime.ts";
import {
  cleanupFeatureSandboxRuntime,
  runFeatureReadinessCommand,
  runFeatureSandboxCommand,
} from "./feature-sandbox.ts";

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-readiness-git-exec-"),
  );
  const main = path.join(root, "main");
  const origin = path.join(root, "origin");
  const worktree = path.join(root, "task");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
      ),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    for (const directory of [main, origin]) {
      fs.mkdirSync(directory);
      git(directory, "init", "-q", "-b", "main");
      git(directory, "config", "user.name", "Readiness Test");
      git(directory, "config", "user.email", "readiness@example.invalid");
    }
    fs.writeFileSync(path.join(origin, "tracked.txt"), "base\n");
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "submodule base");
    git(
      main,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-b",
      "main",
      origin,
      "vendor/fixture",
    );
    fs.mkdirSync(path.join(main, "scripts"));
    fs.mkdirSync(path.join(main, "config"));
    fs.copyFileSync(
      new URL("../../scripts/check-submodules.mjs", import.meta.url),
      path.join(main, "scripts/check-submodules.mjs"),
    );
    fs.writeFileSync(
      path.join(main, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { "check:submodules": "bun scripts/check-submodules.mjs" },
      }),
    );
    fs.writeFileSync(
      path.join(main, "config/submodules.json"),
      JSON.stringify({
        submodules: {
          fixture: {
            path: "vendor/fixture",
            gitmodulesName: "vendor/fixture",
            url: origin,
            branch: "main",
            requiredFiles: ["tracked.txt"],
          },
        },
      }),
    );
    git(main, "add", ".");
    git(main, "commit", "-qm", "repository fixture");
    git(main, "worktree", "add", "-qb", "task", worktree);
    git(
      worktree,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "update",
      "--init",
      "--recursive",
    );
    return {
      root,
      main,
      worktree,
      git,
      dispose() {
        cleanupFeatureSandboxRuntime(worktree);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test("readiness runs the real submodule checker without exposing writable Git authority", async () => {
  const repo = fixture();
  try {
    const head = repo.git(repo.worktree, "rev-parse", "HEAD");
    const input = {
      workspaceRoot: repo.worktree,
      cwd: ".",
      command: "bun run check:submodules",
    };
    const outside = execFileSync("bun", ["run", "check:submodules"], {
      cwd: repo.worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const isolated = await runFeatureSandboxCommand(input);
    assert.notEqual(isolated.exitCode, 0);
    const readiness = await runFeatureReadinessCommand(input);
    assert.equal(readiness.exitCode, 0, readiness.stderr);
    assert.equal(readiness.stdout, outside);
    const baseline = await runFeatureCheckCommand({
      ...input,
      kind: "check",
      signal: new AbortController().signal,
    });
    assert.equal(baseline.exitCode, 0, baseline.stderr);
    assert.equal(baseline.stdout, outside);

    const mutation = await runFeatureReadinessCommand({
      ...input,
      command: "git update-ref refs/heads/unauthorized HEAD",
    });
    assert.notEqual(mutation.exitCode, 0);
    assert.equal(repo.git(repo.worktree, "rev-parse", "HEAD"), head);
    assert.equal(
      repo.git(repo.worktree, "for-each-ref", "refs/heads/unauthorized"),
      "",
    );

    fs.appendFileSync(
      path.join(repo.worktree, "vendor/fixture/tracked.txt"),
      "dirty\n",
    );
    const dirty = await runFeatureReadinessCommand(input);
    assert.notEqual(dirty.exitCode, 0);
    assert.match(dirty.stderr, /direct worktree changes/);
    repo.git(
      repo.worktree,
      "submodule",
      "deinit",
      "-f",
      "--",
      "vendor/fixture",
    );
    const missing = await runFeatureReadinessCommand(input);
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.stderr, /not initialized/);
  } finally {
    repo.dispose();
  }
});

test("readiness masks sibling repositories even with explicit Git selectors", async () => {
  const repo = fixture();
  try {
    const siblingGit = path.join(repo.main, ".git");
    for (const command of [
      `git -C '${repo.main}' rev-parse HEAD`,
      `GIT_DIR='${siblingGit}' GIT_WORK_TREE='${repo.main}' git rev-parse HEAD`,
      `git --git-dir='${siblingGit}' rev-parse HEAD`,
      "git show-ref refs/heads/main",
    ]) {
      const result = await runFeatureReadinessCommand({
        workspaceRoot: repo.worktree,
        cwd: ".",
        command,
      });
      assert.notEqual(result.exitCode, 0, command);
      assert.equal(result.stdout, "", command);
    }
  } finally {
    repo.dispose();
  }
});

test("readiness ignores inherited Git overrides and leaves agent Git access masked", async () => {
  const repo = fixture();
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = "/nonexistent/inherited-git-dir";
    const result = await runFeatureReadinessCommand({
      workspaceRoot: repo.worktree,
      cwd: ".",
      command: "git rev-parse HEAD",
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      repo.git(repo.worktree, "rev-parse", "HEAD"),
    );
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    const masked = await runFeatureSandboxCommand({
      workspaceRoot: repo.worktree,
      cwd: ".",
      command: "git rev-parse HEAD",
    });
    assert.notEqual(masked.exitCode, 0);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    repo.dispose();
  }
});
