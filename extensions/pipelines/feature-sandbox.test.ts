import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createFeatureToolBoundary,
  runFeatureSandboxCommand,
} from "./feature-sandbox.ts";

const context = { cwd: "/" } as unknown as ExtensionContext;

function tool(
  boundary: ReturnType<typeof createFeatureToolBoundary>,
  name: string,
) {
  const selected = boundary.tools.find((item) => item.name === name);
  assert.ok(selected, name);
  return selected as ToolDefinition;
}

async function execute(selected: ToolDefinition, params: unknown) {
  return selected.execute("test", params, undefined, undefined, context);
}

test("candidate tools cannot read or mutate sibling worktrees and bash sees only its assigned writable root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-feature-sandbox-"));
  const candidateA = path.join(root, "candidate-minimal");
  const candidateB = path.join(root, "candidate-robust");
  fs.mkdirSync(candidateA);
  fs.mkdirSync(candidateB);
  fs.writeFileSync(path.join(candidateA, "own.txt"), "own\n");
  fs.writeFileSync(path.join(candidateB, "secret.txt"), "secret\n");
  try {
    const boundary = createFeatureToolBoundary({
      cwd: candidateA,
      mode: "candidate",
    });
    assert.deepEqual(boundary.availableToolNames, [
      "read",
      "bash",
      "edit",
      "write",
      "pipeline_feature_commit",
    ]);
    assert.deepEqual(boundary.initialActiveTools, boundary.availableToolNames);
    await assert.rejects(
      execute(tool(boundary, "read"), {
        path: path.join(candidateB, "secret.txt"),
      }),
      /denied outside the controller-assigned scope/,
    );
    await execute(tool(boundary, "bash"), {
      command:
        "printf changed > own.txt; printf leaked > ../candidate-robust/leak.txt || true",
    });
    const runtimeResult = await execute(tool(boundary, "bash"), {
      command:
        "printf '%s\\n' $TMPDIR $TMP $TEMP $XDG_CACHE_HOME; touch $TMPDIR/probe $XDG_CACHE_HOME/probe",
    });
    const runtimePaths = runtimeResult.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
      .split(/\r?\n/);
    assert.equal(runtimePaths.length, 4);
    assert.equal(
      runtimePaths.every((item) => item.includes("/.pipi-runtime/")),
      true,
    );
    assert.equal(
      runtimePaths.every((item) => !item.startsWith(candidateA)),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(root, ".pipi-runtime", "candidate-minimal", "tmp", "probe"),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(root, ".pipi-runtime", "candidate-minimal", "cache", "probe"),
      ),
      true,
    );
    assert.equal(
      fs.readFileSync(path.join(candidateA, "own.txt"), "utf8"),
      "changed",
    );
    assert.equal(fs.existsSync(path.join(candidateB, "leak.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selection tools are read-only across candidates until the controller enables augmentation", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-feature-selection-"),
  );
  const candidate = path.join(root, "candidate-minimal");
  const synthesis = path.join(root, "synthesis");
  fs.mkdirSync(candidate);
  fs.mkdirSync(synthesis);
  fs.writeFileSync(path.join(candidate, "candidate.txt"), "candidate\n");
  try {
    const boundary = createFeatureToolBoundary({
      cwd: synthesis,
      mode: "selection",
    });
    assert.deepEqual(boundary.availableToolNames, [
      "read",
      "bash",
      "edit",
      "write",
      "pipeline_feature_commit",
    ]);
    assert.deepEqual(boundary.initialActiveTools, ["read", "bash"]);
    assert.equal(
      boundary.availableToolNames.includes("pipeline_feature_commit"),
      true,
    );
    const readResult = await execute(tool(boundary, "read"), {
      path: path.join(candidate, "candidate.txt"),
    });
    assert.match(
      readResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      /candidate/,
    );
    await execute(tool(boundary, "bash"), {
      command: "printf illegal > ../candidate-minimal/illegal.txt || true",
    });
    assert.equal(fs.existsSync(path.join(candidate, "illegal.txt")), false);
    await assert.rejects(
      execute(tool(boundary, "write"), {
        path: path.join(synthesis, "before.txt"),
        content: "before",
      }),
      /Selection phase is read-only/,
    );

    boundary.enableAugmentation();
    await execute(tool(boundary, "write"), {
      path: path.join(synthesis, "after.txt"),
      content: "after",
    });
    assert.equal(
      fs.readFileSync(path.join(synthesis, "after.txt"), "utf8"),
      "after",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("task tools and shell cannot rewrite linked-worktree Git authority", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-feature-git-sandbox-"),
  );
  const main = path.join(root, "main");
  const worktree = path.join(root, "task");
  fs.mkdirSync(main);
  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(main, ["init", "-q"]);
    git(main, ["config", "user.email", "test@example.invalid"]);
    git(main, ["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(main, "tracked.txt"), "base\n");
    git(main, ["add", "tracked.txt"]);
    git(main, ["commit", "-qm", "base"]);
    git(main, ["worktree", "add", "-qb", "task", worktree]);
    const pointer = fs.readFileSync(path.join(worktree, ".git"), "utf8");
    const head = git(worktree, ["rev-parse", "HEAD"]);
    const boundary = createFeatureToolBoundary({
      cwd: worktree,
      mode: "candidate",
    });
    await assert.rejects(
      execute(tool(boundary, "write"), {
        path: path.join(worktree, ".git"),
        content: "gitdir: /other/repository",
      }),
      /controller-owned metadata/,
    );
    await assert.rejects(
      execute(tool(boundary, "read"), { path: path.join(worktree, ".git") }),
      /controller-owned metadata/,
    );
    await execute(tool(boundary, "bash"), {
      command: "printf corrupt > .git; rm -f .git; git reset --hard HEAD; true",
    });
    assert.equal(fs.readFileSync(path.join(worktree, ".git"), "utf8"), pointer);
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), head);
    await execute(tool(boundary, "write"), {
      path: path.join(worktree, "tracked.txt"),
      content: "implementation\n",
    });
    assert.equal(
      fs.readFileSync(path.join(worktree, "tracked.txt"), "utf8"),
      "implementation\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("graph commands use the contained package cwd and reject symlink escapes", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-feature-check-sandbox-"),
  );
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  fs.mkdirSync(path.join(workspace, "package"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, "escape"));
  try {
    const result = await runFeatureSandboxCommand({
      workspaceRoot: workspace,
      cwd: "package",
      command: "printf verified > output.txt; printf stdout; printf stderr >&2",
    });
    assert.deepEqual(result, {
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
    });
    assert.equal(
      fs.readFileSync(path.join(workspace, "package", "output.txt"), "utf8"),
      "verified",
    );
    await assert.rejects(
      runFeatureSandboxCommand({
        workspaceRoot: workspace,
        cwd: "escape",
        command: "true",
      }),
      /inside its assigned worktree/,
    );
    await assert.rejects(
      runFeatureSandboxCommand({
        workspaceRoot: workspace,
        cwd: "../outside",
        command: "true",
      }),
      /inside its assigned worktree/,
    );
    const denied = await runFeatureSandboxCommand({
      workspaceRoot: workspace,
      cwd: ".",
      command: "printf leaked > escape/leak.txt",
    });
    assert.notEqual(denied.exitCode, 0);
    assert.equal(fs.existsSync(path.join(outside, "leak.txt")), false);
    const signal = AbortSignal.abort();
    await assert.rejects(
      runFeatureSandboxCommand({
        workspaceRoot: workspace,
        cwd: ".",
        command: "true",
        signal,
      }),
      /cancelled/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
