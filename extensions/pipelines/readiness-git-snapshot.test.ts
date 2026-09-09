import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createReadinessGitSnapshot } from "./readiness-git-snapshot.ts";

type ReadinessGitSnapshot = ReturnType<typeof createReadinessGitSnapshot>;

const gitEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: gitEnvironment,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function explicitGit(
  binding: { source: string },
  workTree: string,
  args: ReadonlyArray<string>,
) {
  return execFileSync(
    "git",
    ["--git-dir", binding.source, "--work-tree", workTree, ...args],
    {
      cwd: workTree,
      encoding: "utf8",
      env: gitEnvironment,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trimEnd();
}

function optionalConfig(
  binding: { source: string },
  workTree: string,
  key: string,
) {
  try {
    return explicitGit(binding, workTree, ["config", "--get", key]);
  } catch {
    return undefined;
  }
}

function gitDirectory(cwd: string) {
  return fs.realpathSync.native(git(cwd, ["rev-parse", "--absolute-git-dir"]));
}

function initializeRepository(directory: string, bare = false) {
  fs.mkdirSync(directory, { recursive: true });
  git(
    directory,
    bare
      ? ["init", "-q", "--bare", "-b", "main"]
      : ["init", "-q", "-b", "main"],
  );
  if (!bare) {
    git(directory, ["config", "user.email", "readiness@example.invalid"]);
    git(directory, ["config", "user.name", "Readiness Fixture"]);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-readiness-git-"));
  const primary = path.join(root, "primary");
  const workspace = path.join(root, "assigned-worktree");
  const submodule = path.join(workspace, "modules", "fixture");
  const submoduleSource = path.join(root, "submodule-source");
  const rootOrigin = path.join(root, "root-origin.git");
  const submoduleOrigin = path.join(root, "submodule-origin.git");
  const alternateOrigin = path.join(root, "alternate-origin.git");
  const rootHooks = path.join(root, "root-hooks");
  const submoduleHooks = path.join(root, "submodule-hooks");

  initializeRepository(primary);
  initializeRepository(rootOrigin, true);
  initializeRepository(submoduleSource);
  initializeRepository(submoduleOrigin, true);
  initializeRepository(alternateOrigin, true);

  fs.writeFileSync(path.join(submoduleSource, "tracked.txt"), "first\n");
  fs.writeFileSync(path.join(submoduleSource, "staged.txt"), "stage-base\n");
  git(submoduleSource, ["add", "."]);
  git(submoduleSource, ["commit", "-qm", "submodule first"]);
  const firstSubmoduleHead = git(submoduleSource, ["rev-parse", "HEAD"]);
  git(submoduleSource, ["remote", "add", "origin", submoduleOrigin]);
  git(submoduleSource, [
    "-c",
    "protocol.file.allow=always",
    "push",
    "-q",
    "origin",
    "main",
  ]);

  fs.writeFileSync(path.join(submoduleSource, "tracked.txt"), "second\n");
  fs.writeFileSync(path.join(submoduleSource, "second-only.txt"), "second\n");
  git(submoduleSource, ["add", "."]);
  git(submoduleSource, ["commit", "-qm", "submodule second"]);
  const secondSubmoduleHead = git(submoduleSource, ["rev-parse", "HEAD"]);
  git(submoduleSource, [
    "-c",
    "protocol.file.allow=always",
    "push",
    "-q",
    "origin",
    "main",
  ]);

  git(primary, ["remote", "add", "origin", rootOrigin]);
  fs.writeFileSync(path.join(primary, "root.txt"), "root\n");
  git(primary, ["add", "root.txt"]);
  git(primary, ["commit", "-qm", "root base"]);
  git(primary, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "-q",
    submoduleOrigin,
    "modules/fixture",
  ]);
  git(path.join(primary, "modules", "fixture"), [
    "checkout",
    "-q",
    firstSubmoduleHead,
  ]);
  git(primary, ["add", ".gitmodules", "modules/fixture"]);
  git(primary, ["commit", "-qm", "root submodule link"]);
  const rootHead = git(primary, ["rev-parse", "HEAD"]);

  git(primary, ["branch", "sibling-secret", rootHead]);
  git(primary, ["switch", "-q", "sibling-secret"]);
  fs.writeFileSync(path.join(primary, "sibling-secret.txt"), "not assigned\n");
  git(primary, ["add", "sibling-secret.txt"]);
  git(primary, ["commit", "-qm", "sibling secret"]);
  const siblingSecretCommit = git(primary, ["rev-parse", "HEAD"]);
  git(primary, ["switch", "-q", "main"]);

  git(primary, [
    "worktree",
    "add",
    "-q",
    "-b",
    "assigned",
    workspace,
    rootHead,
  ]);
  git(workspace, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);

  fs.mkdirSync(rootHooks);
  fs.writeFileSync(
    path.join(rootHooks, "readiness-secret-hook"),
    "must not enter the snapshot\n",
    { mode: 0o755 },
  );
  git(workspace, ["config", "core.hooksPath", rootHooks]);
  git(workspace, ["config", "remote.origin.pushurl", alternateOrigin]);

  fs.mkdirSync(submoduleHooks);
  fs.writeFileSync(
    path.join(submoduleHooks, "readiness-submodule-secret-hook"),
    "must not enter the snapshot\n",
    { mode: 0o755 },
  );
  git(submodule, ["config", "core.hooksPath", submoduleHooks]);
  git(submodule, ["config", "remote.origin.pushurl", alternateOrigin]);
  git(submodule, ["checkout", "-q", secondSubmoduleHead]);

  fs.writeFileSync(path.join(submodule, "staged.txt"), "staged-change\n");
  git(submodule, ["add", "staged.txt"]);
  fs.writeFileSync(path.join(submodule, "tracked.txt"), "dirty-change\n");
  fs.writeFileSync(path.join(submodule, "untracked.txt"), "untracked\n");

  return {
    root,
    primary,
    workspace,
    submodule,
    rootOrigin,
    submoduleOrigin,
    alternateOrigin,
    rootHooks,
    submoduleHooks,
    rootHead,
    firstSubmoduleHead,
    secondSubmoduleHead,
    siblingSecretCommit,
    cleanup() {
      try {
        git(primary, ["worktree", "remove", "--force", workspace]);
      } catch {
        // The fixture directory is disposable even if Git cleanup was already incomplete.
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function snapshotBindings(
  repo: ReturnType<typeof fixture>,
  snapshot: ReadinessGitSnapshot,
) {
  const actualRootGitDir = gitDirectory(repo.workspace);
  const actualSubmoduleGitDir = gitDirectory(repo.submodule);
  const actualGitDirs = [actualRootGitDir, actualSubmoduleGitDir];
  const metadataBindings = snapshot.bindings.filter(({ source }) =>
    fs.statSync(source).isDirectory(),
  );
  assert.equal(metadataBindings.length, actualGitDirs.length);

  const destinations = new Set<string>();
  for (const binding of metadataBindings) {
    assert.equal(path.isAbsolute(binding.source), true);
    assert.equal(path.isAbsolute(binding.destination), true);
    const sourceStats = fs.lstatSync(binding.source);
    assert.equal(sourceStats.isDirectory(), true);
    assert.equal(sourceStats.isSymbolicLink(), false);
    const destination = fs.realpathSync.native(binding.destination);
    assert.equal(actualGitDirs.includes(destination), true);
    assert.equal(path.resolve(binding.destination), destination);
    assert.notEqual(fs.realpathSync.native(binding.source), destination);
    assert.equal(destinations.has(destination), false);
    destinations.add(destination);
  }
  assert.deepEqual([...destinations].sort(), [...actualGitDirs].sort());
  assert.notEqual(actualRootGitDir, gitDirectory(repo.primary));

  const rootBinding = snapshot.bindings.find(
    (binding) =>
      fs.realpathSync.native(binding.destination) === actualRootGitDir,
  );
  const submoduleBinding = snapshot.bindings.find(
    (binding) =>
      fs.realpathSync.native(binding.destination) === actualSubmoduleGitDir,
  );
  assert.ok(rootBinding);
  assert.ok(submoduleBinding);
  return { rootBinding, submoduleBinding };
}

function snapshotEntries(directory: string) {
  const entries: string[] = [];
  const visit = (current: string, relativeDirectory: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const relative = relativeDirectory
        ? path.join(relativeDirectory, entry.name)
        : entry.name;
      const stats = fs.lstatSync(child);
      assert.equal(stats.isSymbolicLink(), false);
      entries.push(relative);
      if (stats.isDirectory()) visit(child, relative);
    }
  };
  visit(directory, "");
  return entries;
}

function readinessSnapshotDirectories(root: string) {
  return fs
    .readdirSync(root)
    .filter((entry) => entry.startsWith(".pipi-readiness-git-"))
    .sort();
}

function isSharedOrUnsafeMetadata(relative: string) {
  const parts = relative.split(path.sep);
  return (
    parts.includes("commondir") ||
    parts.includes("worktrees") ||
    parts.includes("hooks") ||
    parts.includes("logs") ||
    relative === path.join("objects", "info", "alternates")
  );
}

function assertObjectClosure(
  binding: { source: string },
  workTree: string,
  ref: string,
) {
  const objectIds = new Set<string>();
  objectIds.add(git(workTree, ["rev-parse", ref]));
  objectIds.add(git(workTree, ["rev-parse", `${ref}^{tree}`]));
  for (const line of git(workTree, ["ls-tree", "-r", "-t", ref]).split(
    /\r?\n/u,
  )) {
    const fields = line.split(/\s+/u);
    if (fields[0] !== "160000" && fields[2]) objectIds.add(fields[2]);
  }
  for (const line of git(workTree, ["ls-files", "--stage"]).split(/\r?\n/u)) {
    const fields = line.split(/\s+/u);
    if (fields[0] !== "160000" && fields[1]) objectIds.add(fields[1]);
  }
  for (const objectId of objectIds) {
    assert.doesNotThrow(() =>
      explicitGit(binding, workTree, ["cat-file", "-e", objectId]),
    );
  }
}

function assertMutationDetected(
  mutate: (repo: ReturnType<typeof fixture>) => void,
) {
  const repo = fixture();
  let snapshot: ReadinessGitSnapshot | undefined;
  try {
    const activeSnapshot: ReadinessGitSnapshot = createReadinessGitSnapshot(
      repo.workspace,
    );
    snapshot = activeSnapshot;
    activeSnapshot.verifyUnchanged();
    mutate(repo);
    assert.throws(() => activeSnapshot.verifyUnchanged());
  } finally {
    snapshot?.dispose();
    repo.cleanup();
  }
}

test("binds a sanitized linked worktree and initialized submodule snapshot", () => {
  const repo = fixture();
  let snapshot: ReadinessGitSnapshot | undefined;
  try {
    assert.equal(
      git(repo.workspace, [
        "rev-parse",
        "--verify",
        "refs/heads/sibling-secret",
      ]),
      repo.siblingSecretCommit,
    );
    const activeSnapshot: ReadinessGitSnapshot = createReadinessGitSnapshot(
      repo.workspace,
    );
    snapshot = activeSnapshot;
    const { rootBinding, submoduleBinding } = snapshotBindings(
      repo,
      activeSnapshot,
    );

    const rootIndex = git(repo.workspace, ["ls-files", "--stage"]);
    assert.equal(
      explicitGit(rootBinding, repo.workspace, ["ls-files", "--stage"]),
      rootIndex,
    );
    const gitlink = rootIndex
      .split(/\r?\n/u)
      .find((line) => line.endsWith("\tmodules/fixture"));
    assert.ok(gitlink);
    const [gitlinkMode, gitlinkObject] = gitlink.split("\t")[0]!.split(" ");
    assert.equal(gitlinkMode, "160000");
    assert.equal(gitlinkObject, repo.firstSubmoduleHead);
    assert.notEqual(gitlinkObject, repo.secondSubmoduleHead);
    assert.equal(
      explicitGit(rootBinding, repo.workspace, [
        "ls-files",
        "--stage",
        "--",
        "modules/fixture",
      ]),
      gitlink,
    );

    assert.equal(
      explicitGit(rootBinding, repo.workspace, ["rev-parse", "HEAD"]),
      repo.rootHead,
    );
    assert.doesNotThrow(() =>
      explicitGit(rootBinding, repo.workspace, [
        "cat-file",
        "-e",
        "HEAD^{commit}",
      ]),
    );
    assertObjectClosure(rootBinding, repo.workspace, "HEAD");
    assert.throws(() =>
      explicitGit(rootBinding, repo.workspace, [
        "rev-parse",
        "--verify",
        "refs/heads/sibling-secret",
      ]),
    );
    assert.throws(() =>
      explicitGit(rootBinding, repo.workspace, [
        "cat-file",
        "-e",
        `${repo.siblingSecretCommit}^{commit}`,
      ]),
    );
    assert.equal(
      explicitGit(rootBinding, repo.workspace, [
        "for-each-ref",
        "--format=%(objectname)",
      ])
        .split(/\r?\n/u)
        .includes(repo.siblingSecretCommit),
      false,
    );

    assert.equal(
      explicitGit(submoduleBinding, repo.submodule, ["rev-parse", "HEAD"]),
      repo.secondSubmoduleHead,
    );
    assert.doesNotThrow(() =>
      explicitGit(submoduleBinding, repo.submodule, [
        "cat-file",
        "-e",
        "HEAD^{commit}",
      ]),
    );
    assertObjectClosure(submoduleBinding, repo.submodule, "HEAD");
    assert.equal(
      explicitGit(submoduleBinding, repo.submodule, ["ls-files", "--stage"]),
      git(repo.submodule, ["ls-files", "--stage"]),
    );
    const submoduleStatus = git(repo.submodule, [
      "status",
      "--short",
      "--untracked-files=all",
    ]);
    assert.deepEqual(
      submoduleStatus.split(/\r?\n/u).filter(Boolean).sort(),
      [" M tracked.txt", "M  staged.txt", "?? untracked.txt"].sort(),
    );
    assert.equal(
      explicitGit(submoduleBinding, repo.submodule, [
        "status",
        "--short",
        "--untracked-files=all",
      ]),
      submoduleStatus,
    );

    for (const [binding, workTree, expectedOrigin, forbiddenHook] of [
      [
        rootBinding,
        repo.workspace,
        git(repo.workspace, ["config", "--get", "remote.origin.url"]),
        repo.rootHooks,
      ],
      [
        submoduleBinding,
        repo.submodule,
        git(repo.submodule, ["config", "--get", "remote.origin.url"]),
        repo.submoduleHooks,
      ],
    ] as const) {
      assert.equal(
        optionalConfig(binding, workTree, "remote.origin.url"),
        expectedOrigin,
      );
      assert.equal(
        optionalConfig(binding, workTree, "remote.origin.pushurl"),
        undefined,
      );
      const hooksPath = optionalConfig(binding, workTree, "core.hooksPath");
      assert.equal(hooksPath === undefined || hooksPath === "/dev/null", true);
      const configuredWorktree = optionalConfig(
        binding,
        workTree,
        "core.worktree",
      );
      assert.ok(
        configuredWorktree === undefined || configuredWorktree === workTree,
      );
      const config = fs.readFileSync(
        path.join(binding.source, "config"),
        "utf8",
      );
      assert.equal(config.includes(forbiddenHook), false);
      assert.equal(
        snapshotEntries(binding.source).some(isSharedOrUnsafeMetadata),
        false,
      );
    }

    activeSnapshot.verifyUnchanged();
  } finally {
    snapshot?.dispose();
    repo.cleanup();
  }
});

test("preserves credential-free origin forms without rewriting their identity", () => {
  const repo = fixture();
  let snapshot: ReadinessGitSnapshot | undefined;
  const origins = [
    "https://example.invalid/repository.git",
    "https://example.invalid/repository.git?service=git-upload-pack#section",
    "ssh://git@example.invalid/repository.git",
    "git@example.invalid:repository.git",
    path.join(repo.root, "local-origin.git"),
  ];
  try {
    for (const workTree of [repo.workspace, repo.submodule]) {
      git(workTree, ["config", "remote.origin.url", origins[0]!]);
      for (const origin of origins.slice(1)) {
        git(workTree, ["config", "--add", "remote.origin.url", origin]);
      }
    }

    const activeSnapshot = createReadinessGitSnapshot(repo.workspace);
    snapshot = activeSnapshot;
    const { rootBinding, submoduleBinding } = snapshotBindings(
      repo,
      activeSnapshot,
    );
    for (const [binding, workTree] of [
      [rootBinding, repo.workspace],
      [submoduleBinding, repo.submodule],
    ] as const) {
      assert.deepEqual(
        explicitGit(binding, workTree, [
          "config",
          "--get-all",
          "remote.origin.url",
        ]).split(/\r?\n/u),
        origins,
      );
    }
  } finally {
    snapshot?.dispose();
    repo.cleanup();
  }
});

test("rejects secret-bearing origins without leaking values and cleans snapshots", () => {
  const repo = fixture();
  const fakeToken = "AUD002-fake/token";
  const invalidOrigins = [
    `https://fake-user:${fakeToken}@example.invalid/repository.git`,
    `https://fake%40user:${encodeURIComponent(fakeToken)}@example.invalid/repository.git`,
    `https://example.invalid/repository.git?access%5Ftoken=${encodeURIComponent(fakeToken)}`,
    `https://example.invalid/repository.git#${encodeURIComponent(fakeToken)}`,
    `ssh://git:${encodeURIComponent(fakeToken)}@example.invalid/repository.git`,
  ];
  try {
    for (const origin of invalidOrigins) {
      git(repo.workspace, ["config", "remote.origin.url", origin]);
      const before = readinessSnapshotDirectories(repo.root);
      let error: unknown;
      let snapshot: ReadinessGitSnapshot | undefined;
      try {
        snapshot = createReadinessGitSnapshot(repo.workspace);
      } catch (caught) {
        error = caught;
      } finally {
        snapshot?.dispose();
      }
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(fakeToken), false);
      assert.equal(error.message.includes(origin), false);
      assert.deepEqual(readinessSnapshotDirectories(repo.root), before);
    }
  } finally {
    repo.cleanup();
  }
});

test("detects linked-worktree and submodule authority changes", () => {
  assertMutationDetected((repo) => {
    git(repo.workspace, ["checkout", "-q", "--detach", "HEAD"]);
  });
  assertMutationDetected((repo) => {
    git(repo.workspace, [
      "checkout",
      "-q",
      "--detach",
      repo.siblingSecretCommit,
    ]);
  });
  assertMutationDetected((repo) => {
    fs.writeFileSync(path.join(repo.workspace, "root.txt"), "changed\n");
    git(repo.workspace, ["add", "root.txt"]);
  });
  assertMutationDetected((repo) => {
    git(repo.workspace, ["remote", "set-url", "origin", repo.alternateOrigin]);
  });
  assertMutationDetected((repo) => {
    git(repo.submodule, ["checkout", "-q", "-f", repo.firstSubmoduleHead]);
  });
  assertMutationDetected((repo) => {
    fs.writeFileSync(path.join(repo.submodule, "staged.txt"), "new-stage\n");
    git(repo.submodule, ["add", "staged.txt"]);
  });
  assertMutationDetected((repo) => {
    git(repo.submodule, ["remote", "set-url", "origin", repo.alternateOrigin]);
  });
  assertMutationDetected((repo) => {
    git(repo.workspace, ["submodule", "deinit", "-f", "--", "modules/fixture"]);
  });
});

test("dispose removes only owned snapshots and leaves Git fixtures usable", () => {
  const repo = fixture();
  let snapshot: ReadinessGitSnapshot | undefined;
  let foreignDirectory: string | undefined;
  try {
    const activeSnapshot: ReadinessGitSnapshot = createReadinessGitSnapshot(
      repo.workspace,
    );
    snapshot = activeSnapshot;
    const sources = activeSnapshot.bindings
      .filter(({ source }) => fs.statSync(source).isDirectory())
      .map(({ source }) => source);
    foreignDirectory = fs.mkdtempSync(
      path.join(repo.root, "readiness-foreign-"),
    );
    fs.writeFileSync(path.join(foreignDirectory, "keep.txt"), "keep\n");
    assert.equal(
      sources.every((source) => fs.existsSync(source)),
      true,
    );

    activeSnapshot.dispose();
    activeSnapshot.dispose();

    assert.equal(
      sources.every((source) => fs.existsSync(source)),
      false,
    );
    assert.equal(fs.existsSync(foreignDirectory), true);
    assert.equal(fs.existsSync(path.join(foreignDirectory, "keep.txt")), true);
    assert.equal(fs.existsSync(repo.primary), true);
    assert.equal(fs.existsSync(repo.workspace), true);
    assert.equal(git(repo.workspace, ["rev-parse", "HEAD"]), repo.rootHead);
    assert.equal(
      git(repo.submodule, ["rev-parse", "HEAD"]),
      repo.secondSubmoduleHead,
    );
  } finally {
    if (foreignDirectory)
      fs.rmSync(foreignDirectory, { recursive: true, force: true });
    snapshot?.dispose();
    repo.cleanup();
  }
});

test("fails closed for non-repository and missing inputs", () => {
  const repo = fixture();
  try {
    assert.throws(() => createReadinessGitSnapshot(repo.root));
    assert.throws(() =>
      createReadinessGitSnapshot(path.join(repo.root, "missing-workspace")),
    );
    const file = path.join(repo.root, "not-a-worktree");
    fs.writeFileSync(file, "not a worktree\n");
    assert.throws(() => createReadinessGitSnapshot(file));
  } finally {
    repo.cleanup();
  }

  const uninitialized = fixture();
  try {
    git(uninitialized.workspace, [
      "submodule",
      "deinit",
      "-f",
      "--",
      "modules/fixture",
    ]);
    const snapshot = createReadinessGitSnapshot(uninitialized.workspace);
    try {
      // Missing initialization remains visible to the real repository checker.
      assert.equal(
        fs.existsSync(path.join(uninitialized.submodule, ".git")),
        false,
      );
      assert.equal(
        snapshot.bindings.some(({ destination }) =>
          destination.endsWith("modules/fixture/.git"),
        ),
        false,
      );
    } finally {
      snapshot.dispose();
    }
  } finally {
    uninitialized.cleanup();
  }
});
