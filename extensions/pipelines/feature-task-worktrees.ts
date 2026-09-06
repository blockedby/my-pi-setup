import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeRepositoryRelativePath } from "./feature-planning.ts";

const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 8 * 1024;
const PATH_LIMIT = 512;
const PATH_BYTES_LIMIT = 4 * 1024;

export interface FeatureTaskBranch {
  readonly id: string;
  readonly parentId?: string;
  readonly number: number;
  readonly firstTaskId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly baseCommit: string;
  readonly head: string;
  readonly owned: boolean;
  readonly preparationAttempts: number;
  readonly prepared: boolean;
  readonly preparationBaseline: ReadonlyArray<string>;
}

export interface FeatureTaskGitDiff {
  readonly baseToHead: ReadonlyArray<string>;
  readonly tracked: ReadonlyArray<string>;
  readonly staged: ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<string>;
  readonly conflictPaths: ReadonlyArray<string>;
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly fingerprint?: string;
}

export interface FeatureTaskCommitResult {
  readonly commit: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly residualPaths: ReadonlyArray<string>;
}

export interface FeatureTaskGitTarget {
  readonly branchId: string;
  readonly branch: string;
  readonly worktree: string;
  head(): string;
  inspect(baseCommit: string, maxBytes?: number): FeatureTaskGitDiff;
  commit(
    baseCommit: string,
    commitPaths: ReadonlyArray<string>,
    message: string,
  ): FeatureTaskCommitResult;
  amend(
    provisionalCommit: string,
    commitPaths: ReadonlyArray<string>,
  ): FeatureTaskCommitResult;
  continueCherryPick(
    commitPaths: ReadonlyArray<string>,
  ): FeatureTaskCommitResult;
}

export type FeatureCherryPickResult =
  | { readonly status: "picked"; readonly integratedCommit: string }
  | {
      readonly status: "conflict";
      readonly conflictPaths: ReadonlyArray<string>;
    };

export interface FeatureTaskWorktreeLifecycle {
  readonly runId: string;
  readonly runDirectory: string;
  readonly root: FeatureTaskBranch;
  branch(branchId: string): FeatureTaskBranch;
  target(branchId: string): FeatureTaskGitTarget;
  branches(): ReadonlyArray<FeatureTaskBranch>;
  verify(branchId: string, expectedHead?: string): FeatureTaskBranch;
  createChild(
    parentBranchId: string,
    number: number,
    firstTaskId: string,
  ): FeatureTaskBranch;
  notePreparationAttempt(branchId: string): FeatureTaskBranch;
  recordPreparationBaseline(branchId: string): FeatureTaskBranch;
  inspect(
    branchId: string,
    baseCommit: string,
    maxBytes?: number,
  ): FeatureTaskGitDiff;
  commit(
    branchId: string,
    baseCommit: string,
    commitPaths: ReadonlyArray<string>,
    message: string,
  ): FeatureTaskCommitResult;
  amend(
    branchId: string,
    provisionalCommit: string,
    commitPaths: ReadonlyArray<string>,
  ): FeatureTaskCommitResult;
  cherryPick(
    parentBranchId: string,
    sourceCommit: string,
  ): FeatureCherryPickResult;
  continueCherryPick(
    parentBranchId: string,
    commitPaths: ReadonlyArray<string>,
  ): FeatureTaskCommitResult;
  removeJoinedWorktree(branchId: string): ReadonlyArray<string>;
  cleanupCompleted(): ReadonlyArray<string>;
}

interface MutableBranch {
  id: string;
  parentId?: string;
  number: number;
  firstTaskId: string;
  branch: string;
  worktree: string;
  baseCommit: string;
  head: string;
  owned: boolean;
  preparationAttempts: number;
  prepared: boolean;
  preparationBaseline: string[];
  removed: boolean;
  cherryPickSource?: string;
}

function diagnostic(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, DIAGNOSTIC_LIMIT);
}

function gitRaw(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function git(cwd: string, args: ReadonlyArray<string>) {
  return gitRaw(cwd, args).trim();
}

function requireGit(cwd: string, args: ReadonlyArray<string>, label: string) {
  try {
    return git(cwd, args);
  } catch (error) {
    throw new Error(`${label}: ${diagnostic(error)}`);
  }
}

function requireGitRaw(
  cwd: string,
  args: ReadonlyArray<string>,
  label: string,
) {
  try {
    return gitRaw(cwd, args);
  } catch (error) {
    throw new Error(`${label}: ${diagnostic(error)}`);
  }
}

function nulPaths(value: string) {
  return value.split("\0").filter(Boolean).sort();
}

function canonical(value: string) {
  return fs.realpathSync.native(path.resolve(value));
}

function readHead(cwd: string) {
  return requireGit(cwd, ["rev-parse", "HEAD"], "Unable to read branch HEAD");
}

function readBranch(cwd: string) {
  return requireGit(
    cwd,
    ["symbolic-ref", "--short", "HEAD"],
    "Unable to read attached branch",
  );
}

function readStaged(cwd: string) {
  return nulPaths(
    requireGitRaw(
      cwd,
      ["--literal-pathspecs", "diff", "--cached", "--name-only", "-z"],
      "Unable to inspect staged paths",
    ),
  );
}

function readTracked(cwd: string) {
  return nulPaths(
    requireGitRaw(
      cwd,
      ["--literal-pathspecs", "diff", "--name-only", "-z"],
      "Unable to inspect tracked paths",
    ),
  );
}

function readUntracked(cwd: string) {
  return nulPaths(
    requireGitRaw(
      cwd,
      [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      "Unable to inspect untracked paths",
    ),
  );
}

function readIgnored(cwd: string) {
  return nulPaths(
    requireGitRaw(
      cwd,
      [
        "--literal-pathspecs",
        "ls-files",
        "--others",
        "--ignored",
        "--directory",
        "--exclude-standard",
        "-z",
      ],
      "Unable to inspect ignored paths",
    ),
  );
}

function readConflicts(cwd: string) {
  return nulPaths(
    requireGitRaw(
      cwd,
      ["--literal-pathspecs", "diff", "--name-only", "--diff-filter=U", "-z"],
      "Unable to inspect conflict paths",
    ),
  );
}

function changedBetween(cwd: string, from: string, to: string) {
  return nulPaths(
    requireGitRaw(
      cwd,
      [
        "--literal-pathspecs",
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${from}..${to}`,
        "--",
      ],
      "Unable to inspect committed task paths",
    ),
  );
}

function toSnapshot(branch: MutableBranch): FeatureTaskBranch {
  return {
    id: branch.id,
    ...(branch.parentId ? { parentId: branch.parentId } : {}),
    number: branch.number,
    firstTaskId: branch.firstTaskId,
    branch: branch.branch,
    worktree: branch.worktree,
    baseCommit: branch.baseCommit,
    head: branch.head,
    owned: branch.owned,
    preparationAttempts: branch.preparationAttempts,
    prepared: branch.prepared,
    preparationBaseline: [...branch.preparationBaseline],
  };
}

function safeSlug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "task"
  );
}

function assertSafeCommitPaths(
  cwd: string,
  commitPaths: ReadonlyArray<string>,
  changedPaths: ReadonlySet<string>,
) {
  if (commitPaths.length > PATH_LIMIT) {
    throw new Error(`commitPaths exceeds the ${PATH_LIMIT}-path limit.`);
  }
  const unique = new Set(commitPaths);
  if (unique.size !== commitPaths.length) {
    throw new Error("commitPaths must contain unique paths.");
  }
  for (const filePath of commitPaths) {
    if (
      Buffer.byteLength(filePath, "utf8") > PATH_BYTES_LIMIT ||
      !isSafeRepositoryRelativePath(filePath) ||
      filePath.split("/").includes(".git")
    ) {
      throw new Error(
        `commitPaths contains an unsafe repository path: ${JSON.stringify(filePath)}.`,
      );
    }
    if (!changedPaths.has(filePath)) {
      throw new Error(
        `commitPaths path is not an exact changed, added, or deleted path: ${JSON.stringify(filePath)}.`,
      );
    }
    assertNoEscapingSymlink(cwd, filePath);
  }
}

function isInside(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertNoEscapingSymlink(cwd: string, filePath: string) {
  const root = canonical(cwd);
  const pending = filePath.split("/");
  const seen = new Set<string>();
  let current = root;
  while (pending.length > 0) {
    current = path.resolve(current, pending.shift()!);
    if (!isInside(current, root)) {
      throw new Error(
        `commitPaths path crosses a symlink outside the assigned worktree: ${JSON.stringify(filePath)}.`,
      );
    }
    let link: string | undefined;
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        link = fs.readlinkSync(current);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "ENOENT" && error.code !== "ENOTDIR")
      )
        throw error;
      // A deleted symlink retains its authority in HEAD, even if its target
      // or another link in the same chain was deleted in this task as well.
      const relative = path.relative(root, current);
      const entry = gitRaw(root, [
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        "HEAD",
        "--",
        relative,
      ]).split("\0")[0];
      const metadata = entry?.split("\t")[0]?.split(" ");
      if (metadata?.[0] === "120000" && metadata[2]) {
        link = gitRaw(root, ["cat-file", "blob", metadata[2]]);
      }
    }
    if (link === undefined) continue;
    if (seen.has(current) || seen.size >= 40)
      throw new Error(
        `commitPaths contains an unresolved symlink chain: ${filePath}.`,
      );
    seen.add(current);
    const target = path.resolve(path.dirname(current), link);
    if (!isInside(target, root))
      throw new Error(
        `commitPaths path crosses a symlink outside the assigned worktree: ${JSON.stringify(filePath)}.`,
      );
    pending.unshift(...path.relative(root, target).split("/").filter(Boolean));
    current = root;
  }
}

function boundedDiff(cwd: string, base: string, maxBytes: number) {
  const full = requireGitRaw(
    cwd,
    ["diff", "--no-ext-diff", "--binary", base, "--"],
    "Unable to inspect task diff",
  );
  const bytes = Buffer.byteLength(full, "utf8");
  const fingerprint = createHash("sha256").update(full).digest("hex");
  if (bytes <= maxBytes) {
    return { text: full, truncated: false, bytes, fingerprint };
  }
  let text = full.slice(0, maxBytes);
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  return { text, truncated: true, bytes, fingerprint };
}

function removeUntrackedPath(
  cwd: string,
  filePath: string,
  budget: { remaining: number },
) {
  const absolute = path.resolve(cwd, filePath);
  const root = canonical(cwd);
  if (!isInside(absolute, root) || absolute === root)
    throw new Error(`Refusing cleanup outside worktree: ${filePath}.`);
  // Inspect parent containment without following the final symlink; unlinking
  // a leftover symlink is safe, traversing a symlinked parent is not.
  if (!isInside(canonical(path.dirname(absolute)), root))
    throw new Error(`Refusing cleanup through symlink: ${filePath}.`);
  function remove(entry: string) {
    if (--budget.remaining < 0)
      throw new Error("Task cleanup entry limit reached.");
    const stats = fs.lstatSync(entry);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      fs.unlinkSync(entry);
      return;
    }
    // Do not recursively delete an untracked repository or controller state.
    if (fs.existsSync(path.join(entry, ".git")))
      throw new Error("Task cleanup retained an untracked Git repository.");
    const directory = fs.opendirSync(entry);
    try {
      let child;
      while ((child = directory.readSync()) !== null) {
        if (child.name === ".git")
          throw new Error("Task cleanup retained Git metadata.");
        remove(path.join(entry, child.name));
      }
    } finally {
      directory.closeSync();
    }
    fs.rmdirSync(entry);
  }
  remove(absolute);
}

function cleanupAfterCommit(
  cwd: string,
  preparationBaseline: ReadonlyArray<string> = [],
) {
  const warnings: string[] = [];
  const preserved = (filePath: string) =>
    preparationBaseline.some(
      (baseline) =>
        filePath === baseline ||
        (baseline.endsWith("/") && filePath.startsWith(baseline)),
    );
  const tracked = [...new Set([...readStaged(cwd), ...readTracked(cwd)])];
  if (tracked.length > 0) {
    try {
      requireGit(
        cwd,
        [
          "--literal-pathspecs",
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...tracked,
        ],
        "Unable to restore remaining tracked changes",
      );
    } catch (error) {
      warnings.push(diagnostic(error));
    }
  }
  const budget = { remaining: 2048 };
  for (const filePath of readUntracked(cwd).filter(
    (filePath) => !preserved(filePath),
  )) {
    if (budget.remaining <= 0) {
      warnings.push(
        "Task cleanup entry limit reached; remaining files were retained.",
      );
      break;
    }
    try {
      removeUntrackedPath(cwd, filePath, budget);
    } catch (error) {
      if (warnings.length < 32)
        warnings.push(`Unable to clean ${filePath}: ${diagnostic(error)}`);
    }
  }
  const residualPaths = [
    ...new Set([
      ...readStaged(cwd),
      ...readTracked(cwd),
      ...readUntracked(cwd).filter((filePath) => !preserved(filePath)),
    ]),
  ].sort();
  if (residualPaths.length > 0)
    warnings.push(
      `Task cleanup retained ${residualPaths.length} residual path(s): ${residualPaths.slice(0, 32).join(", ")}.`,
    );
  return { warnings, residualPaths };
}

class GitFeatureTaskWorktreeLifecycle implements FeatureTaskWorktreeLifecycle {
  readonly runId: string;
  readonly runDirectory: string;
  readonly root: FeatureTaskBranch;
  private readonly mutableBranches = new Map<string, MutableBranch>();
  private readonly namespace: string;
  private completedCleanup = false;

  constructor(options: {
    runId: string;
    workingDir: string;
    worktreeRoot: string;
  }) {
    if (!/^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/.test(options.runId)) {
      throw new Error(
        "Feature graph runId must be canonical lower-kebab plus eight hex characters.",
      );
    }
    if (!path.isAbsolute(options.worktreeRoot)) {
      throw new Error("feature-pipeline worktree_root must be absolute.");
    }
    const worktreeRoot = canonical(options.worktreeRoot);
    const workingDir = canonical(options.workingDir);
    const runDirectoryPath = path.join(worktreeRoot, options.runId);
    if (!fs.existsSync(runDirectoryPath)) {
      fs.mkdirSync(runDirectoryPath, { recursive: false });
    }
    this.runDirectory = canonical(runDirectoryPath);
    if (path.dirname(this.runDirectory) !== worktreeRoot) {
      throw new Error("Owned feature run directory escaped worktree_root.");
    }
    this.runId = options.runId;
    this.namespace = `pipi-feature/${options.runId}`;
    const branch = readBranch(workingDir);
    const head = readHead(workingDir);
    const root: MutableBranch = {
      id: "root",
      number: 0,
      firstTaskId: "root",
      branch,
      worktree: workingDir,
      baseCommit: head,
      head,
      owned: false,
      preparationAttempts: 0,
      prepared: true,
      preparationBaseline: [
        ...new Set([...readUntracked(workingDir), ...readIgnored(workingDir)]),
      ],
      removed: false,
    };
    if (
      readStaged(workingDir).length > 0 ||
      readTracked(workingDir).length > 0
    ) {
      throw new Error("Feature graph requires a clean tracked root worktree.");
    }
    this.mutableBranches.set(root.id, root);
    this.root = toSnapshot(root);
  }

  private mutable(branchId: string) {
    const branch = this.mutableBranches.get(branchId);
    if (!branch) throw new Error(`Unknown feature graph branch ${branchId}.`);
    if (branch.removed)
      throw new Error(`Feature graph branch ${branchId} worktree was removed.`);
    return branch;
  }

  branch(branchId: string) {
    return toSnapshot(this.mutable(branchId));
  }

  target(branchId: string): FeatureTaskGitTarget {
    const branch = this.mutable(branchId);
    return {
      branchId,
      branch: branch.branch,
      worktree: branch.worktree,
      head: () => {
        if (readBranch(branch.worktree) !== branch.branch)
          throw new Error("Task branch drifted outside controller ownership.");
        return readHead(branch.worktree);
      },
      inspect: (baseCommit, maxBytes) =>
        this.inspect(branchId, baseCommit, maxBytes),
      commit: (baseCommit, commitPaths, message) =>
        this.commit(branchId, baseCommit, commitPaths, message),
      amend: (provisionalCommit, commitPaths) =>
        this.amend(branchId, provisionalCommit, commitPaths),
      continueCherryPick: (commitPaths) =>
        this.continueCherryPick(branchId, commitPaths),
    };
  }

  branches() {
    return [...this.mutableBranches.values()]
      .sort((left, right) => left.number - right.number)
      .map(toSnapshot);
  }

  verify(branchId: string, expectedHead?: string) {
    const branch = this.mutable(branchId);
    const actualBranch = readBranch(branch.worktree);
    const actualHead = readHead(branch.worktree);
    if (actualBranch !== branch.branch) {
      throw new Error(
        `Feature graph branch drift: expected ${branch.branch}, found ${actualBranch}.`,
      );
    }
    const requiredHead = expectedHead ?? branch.head;
    if (actualHead !== requiredHead) {
      throw new Error(
        `Feature graph HEAD drift on ${branch.id}: expected ${requiredHead}, found ${actualHead}.`,
      );
    }
    if (
      readStaged(branch.worktree).length > 0 ||
      readTracked(branch.worktree).length > 0
    ) {
      throw new Error(
        `Feature graph tracked drift exists on branch ${branch.id}.`,
      );
    }
    branch.head = actualHead;
    return toSnapshot(branch);
  }

  createChild(parentBranchId: string, number: number, firstTaskId: string) {
    if (this.completedCleanup)
      throw new Error("Feature graph worktree lifecycle is closed.");
    const parent = this.mutable(parentBranchId);
    this.verify(parentBranchId);
    const id = `branch-${number}-${safeSlug(firstTaskId)}`;
    if (this.mutableBranches.has(id)) {
      throw new Error(
        `Feature graph branch number ${number} is already owned.`,
      );
    }
    const branchName = `${this.namespace}/${id}`;
    const worktree = path.join(this.runDirectory, id);
    if (fs.existsSync(worktree)) {
      throw new Error(`Owned child worktree path already exists: ${worktree}.`);
    }
    try {
      execFileSync(
        "git",
        ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
        { cwd: parent.worktree, stdio: "ignore" },
      );
      throw new Error(`Owned child branch already exists: ${branchName}.`);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === `Owned child branch already exists: ${branchName}.`
      ) {
        throw error;
      }
    }
    requireGit(
      parent.worktree,
      ["worktree", "add", "-q", "-b", branchName, worktree, parent.head],
      `Unable to create child worktree ${id}`,
    );
    const child: MutableBranch = {
      id,
      parentId: parent.id,
      number,
      firstTaskId,
      branch: branchName,
      worktree: canonical(worktree),
      baseCommit: parent.head,
      head: parent.head,
      owned: true,
      preparationAttempts: 0,
      prepared: false,
      preparationBaseline: [],
      removed: false,
    };
    this.mutableBranches.set(id, child);
    return toSnapshot(child);
  }

  notePreparationAttempt(branchId: string) {
    const branch = this.mutable(branchId);
    if (!branch.owned)
      throw new Error("Root worktree preparation is caller-owned.");
    branch.preparationAttempts += 1;
    return toSnapshot(branch);
  }

  recordPreparationBaseline(branchId: string) {
    const branch = this.mutable(branchId);
    if (
      readStaged(branch.worktree).length > 0 ||
      readTracked(branch.worktree).length > 0
    ) {
      throw new Error(
        `Child worktree preparation changed tracked files on ${branch.id}.`,
      );
    }
    if (
      readHead(branch.worktree) !== branch.head ||
      readBranch(branch.worktree) !== branch.branch
    ) {
      throw new Error(
        `Child worktree preparation changed Git state on ${branch.id}.`,
      );
    }
    branch.preparationBaseline = [
      ...new Set([
        ...readUntracked(branch.worktree),
        ...readIgnored(branch.worktree),
      ]),
    ].sort();
    branch.prepared = true;
    return toSnapshot(branch);
  }

  inspect(branchId: string, baseCommit: string, maxBytes = 256 * 1024) {
    const branch = this.mutable(branchId);
    if (readBranch(branch.worktree) !== branch.branch)
      throw new Error("Task branch drifted outside controller ownership.");
    const head = readHead(branch.worktree);
    const diff = boundedDiff(branch.worktree, baseCommit, maxBytes);
    return {
      baseToHead: changedBetween(branch.worktree, baseCommit, head),
      tracked: readTracked(branch.worktree),
      staged: readStaged(branch.worktree),
      untracked: readUntracked(branch.worktree),
      ignored: readIgnored(branch.worktree),
      conflictPaths: readConflicts(branch.worktree),
      ...diff,
    };
  }

  private selectedCommit(
    branchId: string,
    baseCommit: string,
    commitPaths: ReadonlyArray<string>,
    args: ReadonlyArray<string>,
  ) {
    const branch = this.mutable(branchId);
    if (
      readBranch(branch.worktree) !== branch.branch ||
      readHead(branch.worktree) !== branch.head
    )
      throw new Error(
        "Task Git branch or HEAD drifted outside controller ownership.",
      );
    const stagedBefore = readStaged(branch.worktree);
    const changed = new Set([
      ...stagedBefore,
      ...readTracked(branch.worktree),
      ...readUntracked(branch.worktree),
    ]);
    assertSafeCommitPaths(branch.worktree, commitPaths, changed);
    const selected = new Set(commitPaths);
    const unrelatedStaged = stagedBefore.filter(
      (filePath) => !selected.has(filePath),
    );
    if (unrelatedStaged.length > 0) {
      throw new Error(
        `Refusing finalization with staged paths outside commitPaths: ${unrelatedStaged.join(", ")}.`,
      );
    }
    if (commitPaths.length > 0) {
      requireGit(
        branch.worktree,
        ["--literal-pathspecs", "add", "-A", "--", ...commitPaths],
        "Unable to stage exact task paths",
      );
    }
    const staged = readStaged(branch.worktree);
    if (staged.length === 0) {
      throw new Error("Selected task paths produced no staged changes.");
    }
    const outside = staged.filter((filePath) => !selected.has(filePath));
    if (outside.length > 0) {
      throw new Error(
        `Exact finalization staged unexpected paths: ${outside.join(", ")}.`,
      );
    }
    requireGit(
      branch.worktree,
      args,
      "Unable to create controller-owned task commit",
    );
    const commit = readHead(branch.worktree);
    const changedPaths = changedBetween(branch.worktree, baseCommit, commit);
    branch.head = commit;
    const cleanup = cleanupAfterCommit(
      branch.worktree,
      branch.preparationBaseline,
    );
    return { commit, changedPaths, ...cleanup };
  }

  commit(
    branchId: string,
    baseCommit: string,
    commitPaths: ReadonlyArray<string>,
    message: string,
  ) {
    const branch = this.mutable(branchId);
    if (
      readHead(branch.worktree) !== baseCommit ||
      branch.head !== baseCommit
    ) {
      throw new Error(
        "Task base commit no longer matches controller-owned branch HEAD.",
      );
    }
    return this.selectedCommit(branchId, baseCommit, commitPaths, [
      "commit",
      "-q",
      "-m",
      message.slice(0, 512),
    ]);
  }

  amend(
    branchId: string,
    provisionalCommit: string,
    commitPaths: ReadonlyArray<string>,
  ) {
    const branch = this.mutable(branchId);
    if (
      readHead(branch.worktree) !== provisionalCommit ||
      branch.head !== provisionalCommit
    ) {
      throw new Error(
        "Provisional commit is no longer the controller-owned branch HEAD.",
      );
    }
    const parent = requireGit(
      branch.worktree,
      ["rev-parse", `${provisionalCommit}^`],
      "Unable to resolve provisional task parent",
    );
    return this.selectedCommit(branchId, parent, commitPaths, [
      "commit",
      "-q",
      "--amend",
      "--no-edit",
    ]);
  }

  cherryPick(parentBranchId: string, sourceCommit: string) {
    const parent = this.mutable(parentBranchId);
    this.verify(parentBranchId);
    try {
      requireGit(
        parent.worktree,
        ["cherry-pick", "-x", "--keep-redundant-commits", sourceCommit],
        `Unable to cherry-pick ${sourceCommit}`,
      );
      const integratedCommit = readHead(parent.worktree);
      parent.head = integratedCommit;
      return { status: "picked", integratedCommit } as const;
    } catch (error) {
      const conflicts = readConflicts(parent.worktree);
      const cherryPickHead = path.join(
        requireGit(
          parent.worktree,
          ["rev-parse", "--git-path", "CHERRY_PICK_HEAD"],
          "Unable to resolve cherry-pick state",
        ),
      );
      if (
        conflicts.length === 0 ||
        !fs.existsSync(path.resolve(parent.worktree, cherryPickHead))
      ) {
        throw error;
      }
      parent.cherryPickSource = sourceCommit;
      return { status: "conflict", conflictPaths: conflicts } as const;
    }
  }

  continueCherryPick(
    parentBranchId: string,
    commitPaths: ReadonlyArray<string>,
  ) {
    const parent = this.mutable(parentBranchId);
    if (
      readBranch(parent.worktree) !== parent.branch ||
      readHead(parent.worktree) !== parent.head ||
      !parent.cherryPickSource ||
      git(parent.worktree, ["rev-parse", "CHERRY_PICK_HEAD"]) !==
        parent.cherryPickSource
    ) {
      throw new Error(
        "Conflict Git state changed outside controller ownership.",
      );
    }
    const changed = new Set([
      ...readStaged(parent.worktree),
      ...readTracked(parent.worktree),
      ...readConflicts(parent.worktree),
      ...readUntracked(parent.worktree),
    ]);
    assertSafeCommitPaths(parent.worktree, commitPaths, changed);
    if (commitPaths.length > 0) {
      requireGit(
        parent.worktree,
        ["--literal-pathspecs", "add", "-A", "--", ...commitPaths],
        "Unable to stage conflict-resolution paths",
      );
    }
    const conflicts = readConflicts(parent.worktree);
    if (conflicts.length > 0) {
      throw new Error(
        `Cherry-pick still has unresolved paths: ${conflicts.join(", ")}.`,
      );
    }
    requireGit(
      parent.worktree,
      ["cherry-pick", "--continue"],
      "Unable to continue cherry-pick",
    );
    const commit = readHead(parent.worktree);
    parent.head = commit;
    parent.cherryPickSource = undefined;
    const changedPaths = nulPaths(
      requireGitRaw(
        parent.worktree,
        [
          "--literal-pathspecs",
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          commit,
        ],
        "Unable to inspect continued cherry-pick",
      ),
    );
    return {
      commit,
      changedPaths,
      ...cleanupAfterCommit(parent.worktree, parent.preparationBaseline),
    };
  }

  removeJoinedWorktree(branchId: string) {
    const branch = this.mutableBranches.get(branchId);
    if (!branch || !branch.owned || branch.removed) return [];
    const warnings: string[] = [];
    try {
      requireGit(
        this.root.worktree,
        ["worktree", "remove", "--force", branch.worktree],
        `Unable to remove joined worktree ${branch.id}`,
      );
      branch.removed = true;
    } catch (error) {
      warnings.push(diagnostic(error));
    }
    return warnings;
  }

  cleanupCompleted() {
    const warnings: string[] = [];
    for (const branch of [...this.mutableBranches.values()]
      .filter(({ owned }) => owned)
      .sort((left, right) => right.number - left.number)) {
      warnings.push(...this.removeJoinedWorktree(branch.id));
    }
    for (const branch of [...this.mutableBranches.values()]
      .filter(({ owned }) => owned)
      .sort((left, right) => right.number - left.number)) {
      try {
        requireGit(
          this.root.worktree,
          ["update-ref", "-d", `refs/heads/${branch.branch}`, branch.head],
          `Unable to remove completed branch ${branch.branch}`,
        );
      } catch (error) {
        warnings.push(diagnostic(error));
      }
    }
    try {
      fs.rmdirSync(this.runDirectory);
    } catch (error) {
      if (fs.existsSync(this.runDirectory)) warnings.push(diagnostic(error));
    }
    this.completedCleanup = true;
    return warnings;
  }
}

export function createFeatureTaskWorktreeLifecycle(options: {
  readonly runId: string;
  readonly workingDir: string;
  readonly worktreeRoot: string;
}) {
  return new GitFeatureTaskWorktreeLifecycle(options);
}

export function createFeatureRootTaskGitTarget(workingDir: string) {
  const worktree = canonical(workingDir);
  const branch = readBranch(worktree);
  let expectedHead = readHead(worktree);
  const preparationBaseline = [
    ...readUntracked(worktree),
    ...readIgnored(worktree),
  ];
  return {
    branchId: "root",
    branch,
    worktree,
    head: () => {
      if (readBranch(worktree) !== branch)
        throw new Error(
          "Final review branch drifted outside controller ownership.",
        );
      return readHead(worktree);
    },
    inspect: (baseCommit: string, maxBytes?: number) => ({
      baseToHead: changedBetween(worktree, baseCommit, readHead(worktree)),
      tracked: readTracked(worktree),
      staged: readStaged(worktree),
      untracked: readUntracked(worktree),
      ignored: readIgnored(worktree),
      conflictPaths: readConflicts(worktree),
      ...boundedDiff(worktree, baseCommit, maxBytes ?? 256 * 1024),
    }),
    commit: (
      baseCommit: string,
      commitPaths: ReadonlyArray<string>,
      message: string,
    ) => {
      if (
        readBranch(worktree) !== branch ||
        readHead(worktree) !== expectedHead
      ) {
        throw new Error(
          "Final review Git state changed outside controller ownership.",
        );
      }
      if (baseCommit !== expectedHead) {
        throw new Error(
          "Final review base commit does not match controller-owned HEAD.",
        );
      }
      const stagedBefore = readStaged(worktree);
      const changed = new Set([
        ...stagedBefore,
        ...readTracked(worktree),
        ...readUntracked(worktree),
      ]);
      assertSafeCommitPaths(worktree, commitPaths, changed);
      const selected = new Set(commitPaths);
      const unrelatedStaged = stagedBefore.filter(
        (filePath) => !selected.has(filePath),
      );
      if (unrelatedStaged.length > 0) {
        throw new Error(
          `Refusing final review with staged paths outside commitPaths: ${unrelatedStaged.join(", ")}.`,
        );
      }
      if (commitPaths.length === 0)
        throw new Error(
          "Empty finalization must rerun checks without creating a commit.",
        );
      requireGit(
        worktree,
        ["--literal-pathspecs", "add", "-A", "--", ...commitPaths],
        "Unable to stage exact final-review paths",
      );
      if (readStaged(worktree).some((filePath) => !selected.has(filePath)))
        throw new Error(
          "Final review staged unexpected paths outside commitPaths.",
        );
      requireGit(
        worktree,
        ["commit", "-q", "-m", message.slice(0, 512)],
        "Unable to create controller-owned final-review commit",
      );
      const commit = readHead(worktree);
      expectedHead = commit;
      return {
        commit,
        changedPaths: changedBetween(worktree, baseCommit, commit),
        ...cleanupAfterCommit(worktree, preparationBaseline),
      };
    },
    amend: (provisionalCommit: string, commitPaths: ReadonlyArray<string>) => {
      if (
        readBranch(worktree) !== branch ||
        readHead(worktree) !== expectedHead ||
        provisionalCommit !== expectedHead
      ) {
        throw new Error("Final review provisional commit ownership changed.");
      }
      const parent = requireGit(
        worktree,
        ["rev-parse", `${provisionalCommit}^`],
        "Unable to resolve final-review provisional parent",
      );
      const stagedBefore = readStaged(worktree);
      const changed = new Set([
        ...stagedBefore,
        ...readTracked(worktree),
        ...readUntracked(worktree),
      ]);
      assertSafeCommitPaths(worktree, commitPaths, changed);
      const selected = new Set(commitPaths);
      const unrelatedStaged = stagedBefore.filter(
        (filePath) => !selected.has(filePath),
      );
      if (unrelatedStaged.length > 0) {
        throw new Error(
          `Refusing final review amend with staged paths outside commitPaths: ${unrelatedStaged.join(", ")}.`,
        );
      }
      if (commitPaths.length === 0)
        throw new Error(
          "Empty finalization must rerun checks without creating a commit.",
        );
      requireGit(
        worktree,
        ["--literal-pathspecs", "add", "-A", "--", ...commitPaths],
        "Unable to stage exact final-review amend paths",
      );
      if (readStaged(worktree).some((filePath) => !selected.has(filePath)))
        throw new Error(
          "Final review staged unexpected paths outside commitPaths.",
        );
      requireGit(
        worktree,
        ["commit", "-q", "--amend", "--no-edit"],
        "Unable to amend controller-owned final-review commit",
      );
      const commit = readHead(worktree);
      expectedHead = commit;
      return {
        commit,
        changedPaths: changedBetween(worktree, parent, commit),
        ...cleanupAfterCommit(worktree, preparationBaseline),
      };
    },
    continueCherryPick: (_commitPaths: ReadonlyArray<string>) => {
      throw new Error("Final review cannot continue a cherry-pick.");
    },
  } satisfies FeatureTaskGitTarget;
}
