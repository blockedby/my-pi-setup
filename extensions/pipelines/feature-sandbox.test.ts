import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  cleanupFeatureSandboxRuntime,
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

test("explicit cleanup removes owned runtime scratch after a real sandbox check", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-runtime-cleanup-"));
  const workspace = path.join(root, "workspace");
  const runtimeParent = path.join(root, ".pipi-runtime");
  const runtimeRoot = path.join(runtimeParent, "workspace");
  fs.mkdirSync(workspace);
  try {
    const boundary = createFeatureToolBoundary({
      cwd: workspace,
      mode: "candidate",
    });
    await execute(tool(boundary, "bash"), {
      command: 'touch "$TMPDIR/from-tool" "$XDG_CACHE_HOME/from-tool"',
    });
    const result = await runFeatureSandboxCommand({
      workspaceRoot: workspace,
      cwd: ".",
      command: 'touch "$TMPDIR/from-check" "$XDG_CACHE_HOME/from-check"',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, "tmp", "from-tool")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, "tmp", "from-check")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, "cache", "from-tool")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, "cache", "from-check")),
      true,
    );

    assert.deepEqual(cleanupFeatureSandboxRuntime(workspace), []);
    assert.equal(fs.existsSync(runtimeRoot), true);

    fs.rmSync(workspace, { recursive: true, force: true });
    assert.deepEqual(cleanupFeatureSandboxRuntime(workspace), []);
    assert.equal(fs.existsSync(runtimeRoot), false);
    assert.equal(fs.existsSync(runtimeParent), false);
    assert.deepEqual(cleanupFeatureSandboxRuntime(workspace), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime cleanup leaves sibling scratch and a shared namespace parent intact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-runtime-siblings-"));
  const workspaceA = path.join(root, "workspace-a");
  const workspaceB = path.join(root, "workspace-b");
  const runtimeParent = path.join(root, ".pipi-runtime");
  const runtimeA = path.join(runtimeParent, "workspace-a");
  const runtimeB = path.join(runtimeParent, "workspace-b");
  fs.mkdirSync(workspaceA);
  fs.mkdirSync(workspaceB);
  try {
    for (const workspace of [workspaceA, workspaceB]) {
      const result = await runFeatureSandboxCommand({
        workspaceRoot: workspace,
        cwd: ".",
        command: 'touch "$TMPDIR/probe"',
      });
      assert.equal(result.exitCode, 0, result.stderr);
    }
    const sharedScratch = path.join(runtimeParent, "shared.txt");
    fs.writeFileSync(sharedScratch, "preserve\n");
    fs.rmSync(workspaceA, { recursive: true, force: true });

    assert.deepEqual(cleanupFeatureSandboxRuntime(workspaceA), []);
    assert.equal(fs.existsSync(runtimeA), false);
    assert.equal(fs.existsSync(runtimeB), true);
    assert.equal(fs.existsSync(sharedScratch), true);
    assert.equal(fs.existsSync(runtimeParent), true);

    fs.rmSync(workspaceB, { recursive: true, force: true });
    assert.deepEqual(cleanupFeatureSandboxRuntime(workspaceB), []);
    assert.equal(fs.existsSync(runtimeB), false);
    assert.equal(fs.existsSync(sharedScratch), true);
    assert.equal(fs.existsSync(runtimeParent), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime cleanup does not claim pre-existing scratch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-runtime-existing-"));
  const workspace = path.join(root, "workspace");
  const runtimeRoot = path.join(root, ".pipi-runtime", "workspace");
  const sentinel = path.join(runtimeRoot, "tmp", "pre-existing");
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, "preserve\n");
  fs.mkdirSync(workspace);
  try {
    const result = await runFeatureSandboxCommand({
      workspaceRoot: workspace,
      cwd: ".",
      command: 'touch "$XDG_CACHE_HOME/from-check"',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    fs.rmSync(workspace, { recursive: true, force: true });

    assert.deepEqual(cleanupFeatureSandboxRuntime(workspace), []);
    assert.equal(fs.existsSync(sentinel), true);
    assert.equal(
      fs.existsSync(path.join(runtimeRoot, "cache", "from-check")),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime cleanup fails closed for symlink and identity replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-runtime-replaced-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const runtimeRoot = path.join(root, ".pipi-runtime", "workspace");
  const outsideSentinel = path.join(outside, "do-not-delete");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(outsideSentinel, "preserve\n");
  try {
    const result = await runFeatureSandboxCommand({
      workspaceRoot: workspace,
      cwd: ".",
      command: 'touch "$TMPDIR/probe"',
    });
    assert.equal(result.exitCode, 0, result.stderr);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.symlinkSync(outside, runtimeRoot);

    const symlinkWarnings = cleanupFeatureSandboxRuntime(workspace);
    assert.equal(symlinkWarnings.length > 0, true);
    assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "preserve\n");
    assert.equal(fs.lstatSync(runtimeRoot).isSymbolicLink(), true);

    fs.unlinkSync(runtimeRoot);
    fs.mkdirSync(runtimeRoot);
    fs.writeFileSync(path.join(runtimeRoot, "replacement"), "preserve\n");
    const identityWarnings = cleanupFeatureSandboxRuntime(workspace);
    assert.equal(identityWarnings.length > 0, true);
    assert.equal(
      fs.readFileSync(path.join(runtimeRoot, "replacement"), "utf8"),
      "preserve\n",
    );
    assert.equal(fs.readFileSync(outsideSentinel, "utf8"), "preserve\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime cleanup refuses an ancestor symlink even when directory identities match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-runtime-ancestor-"));
  const container = path.join(root, "container");
  const workspace = path.join(container, "workspace");
  const moved = path.join(root, "moved-container");
  fs.mkdirSync(workspace, { recursive: true });
  try {
    createFeatureToolBoundary({ cwd: workspace, mode: "candidate" });
    fs.rmSync(workspace, { recursive: true });
    fs.renameSync(container, moved);
    fs.symlinkSync(moved, container);
    assert.ok(cleanupFeatureSandboxRuntime(workspace).length > 0);
    assert.equal(
      fs.existsSync(path.join(moved, ".pipi-runtime", "workspace", "tmp")),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const replaced of ["parent", "root"]) {
  test(`runtime reuse refuses a missing or replaced ${replaced} without transferring cleanup ownership`, () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "pipi-runtime-recreate-"),
    );
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    try {
      createFeatureToolBoundary({ cwd: workspace, mode: "candidate" });
      const runtimeParent = path.join(root, ".pipi-runtime");
      const runtimeRoot = path.join(runtimeParent, "workspace");
      const target = replaced === "parent" ? runtimeParent : runtimeRoot;
      fs.renameSync(target, `${target}-saved`);
      assert.throws(
        () => createFeatureToolBoundary({ cwd: workspace, mode: "candidate" }),
        /disappeared|replaced/,
      );
      assert.equal(
        fs.existsSync(target),
        false,
        "A failed reuse must not recreate a disappeared owned directory",
      );
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const sentinel = path.join(runtimeRoot, "unowned-data");
      fs.writeFileSync(sentinel, "preserve\n");
      assert.throws(
        () => createFeatureToolBoundary({ cwd: workspace, mode: "candidate" }),
        /replaced/,
      );
      fs.rmSync(workspace, { recursive: true });
      assert.ok(cleanupFeatureSandboxRuntime(workspace).length > 0);
      assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("runtime parent and root symlinks are rejected before sandbox mounting", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-runtime-links-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  const runtimeParent = path.join(root, ".pipi-runtime");
  const runtimeRoot = path.join(runtimeParent, "workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, runtimeParent);
    assert.throws(
      () => createFeatureToolBoundary({ cwd: workspace, mode: "candidate" }),
      /symbolic link/,
    );
    fs.unlinkSync(runtimeParent);
    fs.mkdirSync(runtimeParent);
    fs.symlinkSync(outside, runtimeRoot);
    assert.throws(
      () => createFeatureToolBoundary({ cwd: workspace, mode: "candidate" }),
      /symbolic link/,
    );
    assert.equal(fs.readdirSync(outside).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("declared shell checks retain network isolation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-check-network-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end("not exposed");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const script = `fetch("http://127.0.0.1:${address.port}", { signal: AbortSignal.timeout(1000) }).then(() => process.exit(0), () => process.exit(7))`;
    const result = await runFeatureSandboxCommand({
      workspaceRoot: workspace,
      cwd: ".",
      command: `${JSON.stringify(process.execPath)} -e '${script}'`,
    });
    assert.equal(result.exitCode, 7, result.stderr);
    assert.equal(requests, 0);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loaded skill packages support symlinks, resources and executable scripts without tool write grants", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-skill-sandbox-"));
  const cwd = path.join(root, "workspace");
  const packageRoot = path.join(root, "packages", "quality");
  const alias = path.join(root, ".pipi", "agent", "skills", "quality");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, "assets"));
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "SKILL.md"), "fixture skill");
  fs.writeFileSync(
    path.join(packageRoot, "assets", "value.txt"),
    "fixture resource",
  );
  fs.symlinkSync("assets/value.txt", path.join(packageRoot, "reference.txt"));
  fs.writeFileSync(
    path.join(packageRoot, "scripts", "run.sh"),
    '#!/bin/sh\ncat "$(dirname "$0")/../assets/value.txt" > "$TMPDIR/result"\ncat "$TMPDIR/result"\n',
    { mode: 0o755 },
  );
  fs.symlinkSync(packageRoot, alias);
  const secret = path.join(root, ".pipi", "agent", "auth.json");
  fs.writeFileSync(secret, "fixture secret");
  fs.symlinkSync(secret, path.join(packageRoot, "escape"));
  const sibling = path.join(root, "packages", "quality-other");
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "SKILL.md"), "unloaded");
  try {
    for (const mode of ["candidate", "selection"] as const) {
      const boundary = createFeatureToolBoundary({
        cwd,
        mode,
        skills: [{ baseDir: alias, filePath: path.join(alias, "SKILL.md") }],
      });
      for (const [relative, expected] of [
        ["SKILL.md", "fixture skill"],
        ["assets/value.txt", "fixture resource"],
        ["reference.txt", "fixture resource"],
      ] as const) {
        const result = await execute(tool(boundary, "read"), {
          path: path.join(alias, relative),
        });
        assert.equal(
          result.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join(""),
          expected,
        );
      }
      for (const denied of [
        secret,
        path.join(alias, "escape"),
        path.join(sibling, "SKILL.md"),
      ]) {
        await assert.rejects(
          execute(tool(boundary, "read"), { path: denied }),
          /denied/,
        );
      }
      for (const denied of [
        path.join(alias, "SKILL.md"),
        path.join(packageRoot, "new.txt"),
      ]) {
        await assert.rejects(
          execute(tool(boundary, "write"), { path: denied, content: "bad" }),
          /read-only/,
        );
      }
      await assert.rejects(
        execute(tool(boundary, "edit"), {
          path: path.join(alias, "SKILL.md"),
          edits: [{ oldText: "fixture", newText: "bad" }],
        }),
        /read-only/,
      );
      const result = await execute(tool(boundary, "bash"), {
        command: `'${alias}/scripts/run.sh'`,
      });
      assert.equal(
        result.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("")
          .trim(),
        "fixture resource",
      );
      await execute(tool(boundary, "bash"), {
        command: `! touch '${alias}/new.txt' && ! touch '${packageRoot}/new.txt'`,
      });
      assert.equal(fs.existsSync(path.join(packageRoot, "new.txt")), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file-symlink skill grants its target file but not its target's siblings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-file-skill-"));
  const cwd = path.join(root, "workspace");
  const baseDir = path.join(root, ".pipi", "agent", "skills", "file-skill");
  fs.mkdirSync(cwd);
  fs.mkdirSync(baseDir, { recursive: true });
  const target = path.join(root, "instructions.md");
  fs.writeFileSync(target, "file skill");
  fs.writeFileSync(path.join(root, "other.md"), "not a resource");
  const filePath = path.join(baseDir, "SKILL.md");
  fs.symlinkSync(target, filePath);
  try {
    const boundary = createFeatureToolBoundary({ cwd, mode: "candidate" });
    boundary.setSkills([{ baseDir, filePath }]);
    const result = await execute(tool(boundary, "read"), { path: filePath });
    assert.equal(
      result.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
      "file skill",
    );
    await assert.rejects(
      execute(tool(boundary, "read"), { path: path.join(root, "other.md") }),
      /denied/,
    );
    const shell = await execute(tool(boundary, "bash"), {
      command: `cat '${filePath}'`,
    });
    assert.equal(
      shell.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim(),
      "file skill",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("visible symlink packages stay executable and project packages stay read-only after augmentation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-visible-skill-"));
  const external = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-external-skill-"),
  );
  const cwd = path.join(root, "workspace");
  const baseDir = path.join(cwd, "skills", "local");
  const alias = path.join(external, "linked");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, "SKILL.md"), "local package");
  fs.symlinkSync(baseDir, alias);
  try {
    const boundary = createFeatureToolBoundary({
      cwd,
      mode: "selection",
      skills: [{ baseDir: alias, filePath: path.join(alias, "SKILL.md") }],
    });
    boundary.enableAugmentation();
    const shell = await execute(tool(boundary, "bash"), {
      command: `cat '${alias}/SKILL.md'; ! touch '${baseDir}/new.txt'`,
    });
    assert.equal(
      shell.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
        .startsWith("local package"),
      true,
    );
    assert.equal(fs.existsSync(path.join(baseDir, "new.txt")), false);
    await assert.rejects(
      execute(tool(boundary, "write"), {
        path: path.join(baseDir, "new.txt"),
        content: "bad",
      }),
      /read-only/,
    );
    await execute(tool(boundary, "write"), {
      path: path.join(cwd, "output.txt"),
      content: "allowed",
    });
    await assert.rejects(
      execute(tool(boundary, "read"), {
        path: path.join(alias, "SKILL.md", "missing"),
      }),
    );
    fs.unlinkSync(alias);
    fs.symlinkSync(external, alias);
    fs.writeFileSync(
      path.join(external, "SKILL.md"),
      "replacement must not gain access",
    );
    await assert.rejects(
      execute(tool(boundary, "read"), { path: path.join(alias, "SKILL.md") }),
      /denied/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
