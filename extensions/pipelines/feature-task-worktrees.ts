import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSafeRepositoryRelativePath } from "./feature-planning.ts";
import { cleanupFeatureSandboxRuntime } from "./feature-sandbox.ts";
import {
  createCleanupRecorder,
  type CleanupEvidence,
  type CleanupEvidenceSink,
} from "./cleanup-evidence.ts";

const GIT_OUTPUT_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_LIMIT = 8 * 1024;
const PATH_LIMIT = 512;
const PATH_BYTES_LIMIT = 4 * 1024;

function cleanupResource(
  resourceType: CleanupEvidence["resourceType"],
  resource: string,
) {
  return `${resourceType}:${resource}`;
}

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
  readonly trackedResidualPaths: ReadonlyArray<string>;
  readonly trackedResiduals: ReadonlyArray<FeatureTrackedResidualState>;
}

export interface FeatureTrackedResidualState {
  readonly path: string;
  readonly fingerprint: string;
}

export interface FeatureDiffPageRequest {
  readonly offset?: number;
  readonly fingerprint?: string;
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
  readonly offset: number;
  readonly nextOffset?: number;
  readonly fingerprint: string;
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
  inspect(
    baseCommit: string,
    maxBytes?: number,
    request?: FeatureDiffPageRequest,
  ): FeatureTaskGitDiff;
  trackedResidualPaths?(): ReadonlyArray<string>;
  assertRecordedResidualsUnchanged?(
    excludedPaths?: ReadonlyArray<string>,
  ): void;
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
    request?: FeatureDiffPageRequest,
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
  recordRetainedResources(reason: string): void;
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
  trackedResiduals: Map<string, string>;
  removed: boolean;
  refRemoved: boolean;
  cherryPickSource?: string;
}

interface TrackedResidualOwner {
  readonly id: string;
  readonly worktree: string;
  trackedResiduals: Map<string, string>;
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
    trackedResidualPaths: [...branch.trackedResiduals.keys()].sort(),
    trackedResiduals: [...branch.trackedResiduals]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, fingerprint]) => ({ path, fingerprint })),
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

function readByte(file: number, offset: number) {
  const value = Buffer.allocUnsafe(1);
  return fs.readSync(file, value, 0, 1, offset) === 1 ? value[0] : undefined;
}

function readUtf8Page(
  file: number,
  offset: number,
  bytes: number,
  maxBytes: number,
) {
  const first = readByte(file, offset);
  if (first !== undefined && (first & 0xc0) === 0x80) {
    throw new Error(`Diff offset ${offset} is not a UTF-8 page boundary.`);
  }
  const requestedEnd = Math.min(bytes, offset + maxBytes);
  let nextOffset = requestedEnd;
  if (nextOffset < bytes && (readByte(file, nextOffset)! & 0xc0) === 0x80) {
    while (
      nextOffset > offset &&
      (readByte(file, nextOffset)! & 0xc0) === 0x80
    ) {
      nextOffset -= 1;
    }
    // A page smaller than one code point may exceed maxBytes by at most three
    // bytes so the returned cursor always makes progress.
    if (nextOffset === offset) {
      nextOffset = requestedEnd;
      while (
        nextOffset < bytes &&
        (readByte(file, nextOffset)! & 0xc0) === 0x80
      ) {
        nextOffset += 1;
      }
    }
  }
  const page = Buffer.allocUnsafe(nextOffset - offset);
  let read = 0;
  while (read < page.length) {
    const count = fs.readSync(
      file,
      page,
      read,
      page.length - read,
      offset + read,
    );
    if (count === 0) throw new Error("Diff spool page ended early.");
    read += count;
  }
  return { text: page.toString("utf8"), nextOffset };
}

function boundedGitOutput(
  cwd: string,
  args: ReadonlyArray<string>,
  label: string,
  maxBytes: number,
  request: FeatureDiffPageRequest = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Diff page size must be a positive safe integer.");
  }
  const offset = request.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Diff offset must be a nonnegative safe integer.");
  }
  if (offset > 0 && !request.fingerprint) {
    throw new Error("A diff fingerprint is required for continuation pages.");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-diff-"));
  const outputPath = path.join(directory, "diff");
  const output = fs.openSync(outputPath, "wx+");
  try {
    const result = spawnSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: GIT_OUTPUT_LIMIT,
        stdio: ["ignore", output, "pipe"],
      },
    );
    if (result.error || result.status !== 0) {
      const detail = result.error
        ? diagnostic(result.error)
        : (result.stderr ?? "").replace(/\s+/g, " ").slice(0, DIAGNOSTIC_LIMIT);
      throw new Error(`${label}: ${detail || `Git exited ${result.status}`}`);
    }
    const bytes = fs.fstatSync(output).size;
    const fingerprintHash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < bytes) {
      const count = fs.readSync(
        output,
        chunk,
        0,
        Math.min(chunk.length, bytes - position),
        position,
      );
      if (count === 0) throw new Error(`${label}: diff spool ended early.`);
      fingerprintHash.update(chunk.subarray(0, count));
      position += count;
    }
    const fingerprint = fingerprintHash.digest("hex");
    if (request.fingerprint && request.fingerprint !== fingerprint) {
      throw new Error(
        "Diff changed since the requested page cursor was issued.",
      );
    }
    if (offset > bytes) {
      throw new Error(`Diff offset ${offset} exceeds ${bytes} bytes.`);
    }
    const page = readUtf8Page(output, offset, bytes, maxBytes);
    return {
      text: page.text,
      truncated: page.nextOffset < bytes,
      bytes,
      offset,
      ...(page.nextOffset < bytes ? { nextOffset: page.nextOffset } : {}),
      fingerprint,
    };
  } finally {
    fs.closeSync(output);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function boundedDiff(
  cwd: string,
  base: string,
  maxBytes: number,
  request?: FeatureDiffPageRequest,
) {
  return boundedGitOutput(
    cwd,
    ["diff", "--no-ext-diff", "--binary", base, "--"],
    "Unable to inspect task diff",
    maxBytes,
    request,
  );
}

function currentTrackedPaths(cwd: string) {
  return [...new Set([...readStaged(cwd), ...readTracked(cwd)])].sort();
}

function trackedPathFingerprint(cwd: string, filePath: string) {
  const staged = boundedGitOutput(
    cwd,
    [
      "--literal-pathspecs",
      "diff",
      "--cached",
      "--no-ext-diff",
      "--binary",
      "HEAD",
      "--",
      filePath,
    ],
    `Unable to fingerprint cleanup residual ${filePath}`,
    1,
  ).fingerprint;
  const worktree = boundedGitOutput(
    cwd,
    [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--binary",
      "--",
      filePath,
    ],
    `Unable to fingerprint cleanup residual ${filePath}`,
    1,
  ).fingerprint;
  return createHash("sha256")
    .update(staged)
    .update("\0")
    .update(worktree)
    .digest("hex");
}

function recordTrackedResiduals(branch: TrackedResidualOwner) {
  branch.trackedResiduals = new Map(
    currentTrackedPaths(branch.worktree).map((filePath) => [
      filePath,
      trackedPathFingerprint(branch.worktree, filePath),
    ]),
  );
}

function assertRecordedResidualsUnchanged(
  branch: TrackedResidualOwner,
  excludedPaths: ReadonlySet<string> = new Set(),
) {
  const actual = new Set(currentTrackedPaths(branch.worktree));
  for (const [filePath, fingerprint] of branch.trackedResiduals) {
    if (excludedPaths.has(filePath)) continue;
    if (!actual.has(filePath)) {
      branch.trackedResiduals.delete(filePath);
      continue;
    }
    if (trackedPathFingerprint(branch.worktree, filePath) !== fingerprint) {
      throw new Error(
        `Recorded cleanup residual changed outside controller ownership: ${filePath}.`,
      );
    }
  }
  return actual;
}

function verifyTrackedResiduals(branch: TrackedResidualOwner) {
  const actual = assertRecordedResidualsUnchanged(branch);
  const unexpected = [...actual].filter(
    (filePath) => !branch.trackedResiduals.has(filePath),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Feature graph tracked drift exists on branch ${branch.id}: ${unexpected.join(", ")}.`,
    );
  }
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

function residualExists(cwd: string, filePath: string) {
  try {
    fs.lstatSync(path.resolve(cwd, filePath));
    return true;
  } catch {
    return false;
  }
}

function refExists(cwd: string, reference: string) {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", reference], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function cleanupAfterCommit(
  cwd: string,
  preparationBaseline: ReadonlyArray<string> = [],
  cleanupEvidence?: CleanupEvidenceSink,
  expectedIdentity?: string,
) {
  const warnings: string[] = [];
  const phase = "feature-worktree-finalization";
  const preserved = (filePath: string) =>
    preparationBaseline.some(
      (baseline) =>
        filePath === baseline ||
        (baseline.endsWith("/") && filePath.startsWith(baseline)),
    );
  const tracked = [...new Set([...readStaged(cwd), ...readTracked(cwd)])];
  const trackedRecorders = tracked.map((filePath) => {
    const resource = path.resolve(cwd, filePath);
    const recorder = cleanupRecorder(cleanupEvidence, {
      resourceId: cleanupResource("residual", resource),
      resourceType: "residual",
      resource,
      ownership: "controller",
      phase,
      expectedIdentity,
    });
    recorder.intent();
    return recorder;
  });
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
      for (const recorder of trackedRecorders) {
        recorder.outcome({
          disposition: "removed",
          operationStatus: "succeeded",
          reasonCode: "residual_removed",
        });
      }
    } catch (error) {
      const detail = diagnostic(error);
      warnings.push(detail);
      for (const recorder of trackedRecorders) {
        recorder.outcome({
          disposition: "retained",
          operationStatus: "failed",
          reasonCode: "residual_remove_failed",
          detail,
        });
      }
    }
  }
  const budget = { remaining: 2048 };
  let limitWarningIssued = false;
  for (const filePath of readUntracked(cwd).filter(
    (filePath) => !preserved(filePath),
  )) {
    const resource = path.resolve(cwd, filePath);
    const recorder = cleanupRecorder(cleanupEvidence, {
      resourceId: cleanupResource("residual", resource),
      resourceType: "residual",
      resource,
      ownership: "controller",
      phase,
      expectedIdentity,
    });
    recorder.intent();
    if (budget.remaining <= 0) {
      if (!limitWarningIssued) {
        warnings.push(
          "Task cleanup entry limit reached; remaining files were retained.",
        );
        limitWarningIssued = true;
      }
      recorder.outcome({
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "cleanup_entry_limit",
      });
      continue;
    }
    const existed = residualExists(cwd, filePath);
    if (!existed) {
      recorder.outcome({
        disposition: "skipped",
        operationStatus: "not_attempted",
        reasonCode: "residual_already_absent",
      });
      continue;
    }
    try {
      removeUntrackedPath(cwd, filePath, budget);
      recorder.outcome({
        disposition: "removed",
        operationStatus: "succeeded",
        reasonCode: "residual_removed",
      });
    } catch (error) {
      const detail = diagnostic(error);
      if (warnings.length < 32)
        warnings.push(`Unable to clean ${filePath}: ${detail}`);
      recorder.outcome({
        disposition: "retained",
        operationStatus: "failed",
        reasonCode: "residual_remove_failed",
        detail,
      });
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

type CleanupRecorderContext = Parameters<typeof createCleanupRecorder>[1];

function cleanupRecorder(
  sink: CleanupEvidenceSink | undefined,
  context: CleanupRecorderContext,
) {
  const recorder = createCleanupRecorder(sink, context);
  return {
    intent() {
      try {
        recorder.intent();
      } catch {
        // Cleanup evidence is observational and cannot change authority.
      }
    },
    outcome(result: Parameters<typeof recorder.outcome>[0]) {
      try {
        recorder.outcome(result);
      } catch {
        // Cleanup evidence is observational and cannot change authority.
      }
    },
  };
}

type CleanupRecorderOutcome = Parameters<
  ReturnType<typeof cleanupRecorder>["outcome"]
>[0];

function recordCleanupDecision(
  sink: CleanupEvidenceSink | undefined,
  context: CleanupRecorderContext,
  outcome: CleanupRecorderOutcome,
) {
  const recorder = cleanupRecorder(sink, context);
  recorder.intent();
  recorder.outcome(outcome);
}

class GitFeatureTaskWorktreeLifecycle implements FeatureTaskWorktreeLifecycle {
  readonly runId: string;
  readonly runDirectory: string;
  readonly root: FeatureTaskBranch;
  private readonly mutableBranches = new Map<string, MutableBranch>();
  private readonly namespace: string;
  private readonly cleanupEvidence?: CleanupEvidenceSink;
  private completedCleanup = false;
  private runDirectoryRemoved = false;

  constructor(options: {
    runId: string;
    workingDir: string;
    worktreeRoot: string;
    cleanupEvidence?: CleanupEvidenceSink;
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
    this.cleanupEvidence = options.cleanupEvidence;
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
      trackedResiduals: new Map(),
      removed: false,
      refRemoved: false,
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
      inspect: (baseCommit, maxBytes, request) =>
        this.inspect(branchId, baseCommit, maxBytes, request),
      trackedResidualPaths: () => [...branch.trackedResiduals.keys()].sort(),
      assertRecordedResidualsUnchanged: (excludedPaths) =>
        assertRecordedResidualsUnchanged(branch, new Set(excludedPaths ?? [])),
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
    verifyTrackedResiduals(branch);
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
      trackedResiduals: new Map(),
      removed: false,
      refRemoved: false,
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

  inspect(
    branchId: string,
    baseCommit: string,
    maxBytes = 256 * 1024,
    request?: FeatureDiffPageRequest,
  ) {
    const branch = this.mutable(branchId);
    if (readBranch(branch.worktree) !== branch.branch)
      throw new Error("Task branch drifted outside controller ownership.");
    const head = readHead(branch.worktree);
    const diff = boundedDiff(branch.worktree, baseCommit, maxBytes, request);
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
    const changed = new Set([
      ...readStaged(branch.worktree),
      ...readTracked(branch.worktree),
      ...readUntracked(branch.worktree),
    ]);
    assertSafeCommitPaths(branch.worktree, commitPaths, changed);
    const selected = new Set(commitPaths);
    assertRecordedResidualsUnchanged(branch, selected);
    const inheritedStaged = readStaged(branch.worktree).filter(
      (filePath) =>
        branch.trackedResiduals.has(filePath) && !selected.has(filePath),
    );
    if (inheritedStaged.length > 0) {
      requireGit(
        branch.worktree,
        [
          "--literal-pathspecs",
          "restore",
          "--staged",
          "--",
          ...inheritedStaged,
        ],
        "Unable to isolate recorded cleanup residuals from task staging",
      );
    }
    const stagedBefore = readStaged(branch.worktree);
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
      this.cleanupEvidence,
      commit,
    );
    recordTrackedResiduals(branch);
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
      recordTrackedResiduals(parent);
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
    const cleanup = cleanupAfterCommit(
      parent.worktree,
      parent.preparationBaseline,
      this.cleanupEvidence,
      commit,
    );
    recordTrackedResiduals(parent);
    return {
      commit,
      changedPaths,
      ...cleanup,
    };
  }

  private recordCallerOwnedRoot(reason: string, phase: string) {
    const root = this.mutableBranches.get("root");
    if (!root) return;
    recordCleanupDecision(
      this.cleanupEvidence,
      {
        resourceId: cleanupResource("worktree", root.worktree),
        resourceType: "worktree",
        resource: root.worktree,
        ownership: "caller",
        phase,
        expectedIdentity: root.head,
      },
      {
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "caller_owned",
        ...(reason === "successful_cleanup" ? {} : { detail: reason }),
      },
    );
    recordCleanupDecision(
      this.cleanupEvidence,
      {
        resourceId: cleanupResource("ref", `refs/heads/${root.branch}`),
        resourceType: "ref",
        resource: `refs/heads/${root.branch}`,
        ownership: "caller",
        phase,
        expectedIdentity: root.head,
      },
      {
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "caller_owned",
        ...(reason === "successful_cleanup" ? {} : { detail: reason }),
      },
    );
  }

  removeJoinedWorktree(branchId: string) {
    const branch = this.mutableBranches.get(branchId);
    if (!branch || !branch.owned) return [];
    const recorder = cleanupRecorder(this.cleanupEvidence, {
      resourceId: cleanupResource("worktree", branch.worktree),
      resourceType: "worktree",
      resource: branch.worktree,
      ownership: "controller",
      phase: "feature-worktree-lifecycle-cleanup",
      expectedIdentity: branch.head,
    });
    recorder.intent();
    if (branch.removed) {
      recorder.outcome({
        disposition: "skipped",
        operationStatus: "not_attempted",
        reasonCode: "already_removed",
      });
      return [];
    }
    const warnings: string[] = [];
    try {
      requireGit(
        this.root.worktree,
        ["worktree", "remove", "--force", branch.worktree],
        `Unable to remove joined worktree ${branch.id}`,
      );
      branch.removed = true;
      recorder.outcome({
        disposition: "removed",
        operationStatus: "succeeded",
        reasonCode: "worktree_removed",
      });
    } catch (error) {
      const detail = diagnostic(error);
      warnings.push(detail);
      recorder.outcome({
        disposition: "retained",
        operationStatus: "failed",
        reasonCode: "worktree_remove_failed",
        detail,
      });
    }
    return warnings;
  }

  cleanupCompleted() {
    const warnings: string[] = [];
    this.recordCallerOwnedRoot(
      "successful_cleanup",
      "feature-worktree-lifecycle-cleanup",
    );
    for (const branch of [...this.mutableBranches.values()]
      .filter(({ owned }) => owned)
      .sort((left, right) => right.number - left.number)) {
      warnings.push(...this.removeJoinedWorktree(branch.id));
    }
    for (const branch of [...this.mutableBranches.values()]
      .filter(({ owned }) => owned)
      .sort((left, right) => right.number - left.number)) {
      const reference = `refs/heads/${branch.branch}`;
      const recorder = cleanupRecorder(this.cleanupEvidence, {
        resourceId: cleanupResource("ref", reference),
        resourceType: "ref",
        resource: reference,
        ownership: "controller",
        phase: "feature-worktree-lifecycle-cleanup",
        expectedIdentity: branch.head,
      });
      recorder.intent();
      const existed = refExists(this.root.worktree, reference);
      if (!existed) {
        branch.refRemoved = true;
        recorder.outcome({
          disposition: "skipped",
          operationStatus: "not_attempted",
          reasonCode: "ref_already_absent",
        });
        continue;
      }
      try {
        requireGit(
          this.root.worktree,
          ["update-ref", "-d", reference, branch.head],
          `Unable to remove completed branch ${branch.branch}`,
        );
        branch.refRemoved = true;
        recorder.outcome({
          disposition: "removed",
          operationStatus: "succeeded",
          reasonCode: "compare_delete_succeeded",
        });
      } catch (error) {
        const detail = diagnostic(error);
        warnings.push(detail);
        recorder.outcome({
          disposition: "retained",
          operationStatus: "failed",
          reasonCode: "compare_delete_failed",
          detail,
        });
      }
    }
    // Failed/cancelled graphs retain diagnostic worktrees and scratch. Only
    // successful completion reclaims process-owned sandbox runtime roots.
    for (const branch of this.mutableBranches.values()) {
      if (branch.owned && branch.removed) {
        warnings.push(
          ...cleanupFeatureSandboxRuntime(
            branch.worktree,
            this.cleanupEvidence,
          ),
        );
      }
    }
    const runDirectoryRecorder = cleanupRecorder(this.cleanupEvidence, {
      resourceId: cleanupResource("directory", this.runDirectory),
      resourceType: "directory",
      resource: this.runDirectory,
      ownership: "controller",
      phase: "feature-worktree-lifecycle-cleanup",
    });
    runDirectoryRecorder.intent();
    const runDirectoryExisted = fs.existsSync(this.runDirectory);
    try {
      fs.rmdirSync(this.runDirectory);
      this.runDirectoryRemoved = true;
      runDirectoryRecorder.outcome({
        disposition: runDirectoryExisted ? "removed" : "skipped",
        operationStatus: runDirectoryExisted ? "succeeded" : "not_attempted",
        reasonCode: runDirectoryExisted
          ? "temporary_root_removed"
          : "temporary_root_already_absent",
      });
    } catch (error) {
      const detail = diagnostic(error);
      if (fs.existsSync(this.runDirectory) || runDirectoryExisted) {
        warnings.push(detail);
        runDirectoryRecorder.outcome({
          disposition: "retained",
          operationStatus: "failed",
          reasonCode: "temporary_root_remove_failed",
          detail,
        });
      } else {
        runDirectoryRecorder.outcome({
          disposition: "skipped",
          operationStatus: "not_attempted",
          reasonCode: "temporary_root_already_absent",
          detail,
        });
      }
    }
    this.completedCleanup = true;
    return warnings;
  }

  recordRetainedResources(reason: string) {
    const phase = "feature-worktree-lifecycle-cleanup";
    this.recordCallerOwnedRoot(reason, phase);
    for (const branch of [...this.mutableBranches.values()]
      .filter(({ owned }) => owned)
      .sort((left, right) => right.number - left.number)) {
      recordCleanupDecision(
        this.cleanupEvidence,
        {
          resourceId: cleanupResource("worktree", branch.worktree),
          resourceType: "worktree",
          resource: branch.worktree,
          ownership: "controller",
          phase,
          expectedIdentity: branch.head,
        },
        branch.removed
          ? {
              disposition: "skipped",
              operationStatus: "not_attempted",
              reasonCode: "already_removed",
            }
          : {
              disposition: "retained",
              operationStatus: "not_attempted",
              reasonCode: reason,
            },
      );
      recordCleanupDecision(
        this.cleanupEvidence,
        {
          resourceId: cleanupResource("ref", `refs/heads/${branch.branch}`),
          resourceType: "ref",
          resource: `refs/heads/${branch.branch}`,
          ownership: "controller",
          phase,
          expectedIdentity: branch.head,
        },
        branch.refRemoved
          ? {
              disposition: "skipped",
              operationStatus: "not_attempted",
              reasonCode: "already_removed",
            }
          : {
              disposition: "retained",
              operationStatus: "not_attempted",
              reasonCode: reason,
            },
      );
    }
    recordCleanupDecision(
      this.cleanupEvidence,
      {
        resourceId: cleanupResource("directory", this.runDirectory),
        resourceType: "directory",
        resource: this.runDirectory,
        ownership: "controller",
        phase,
      },
      this.runDirectoryRemoved
        ? {
            disposition: "skipped",
            operationStatus: "not_attempted",
            reasonCode: "already_removed",
          }
        : {
            disposition: "retained",
            operationStatus: "not_attempted",
            reasonCode: reason,
          },
    );
  }
}

export function createFeatureTaskWorktreeLifecycle(options: {
  readonly runId: string;
  readonly workingDir: string;
  readonly worktreeRoot: string;
  readonly cleanupEvidence?: CleanupEvidenceSink;
}) {
  return new GitFeatureTaskWorktreeLifecycle(options);
}

export function createFeatureRootTaskGitTarget(
  workingDir: string,
  knownResidualPaths: ReadonlyArray<string> = [],
  knownTrackedResiduals: ReadonlyArray<FeatureTrackedResidualState> = [],
  cleanupEvidence?: CleanupEvidenceSink,
) {
  const worktree = canonical(workingDir);
  const branch = readBranch(worktree);
  let expectedHead = readHead(worktree);
  const suppliedTrackedResiduals = new Map(
    knownTrackedResiduals.map(({ path: filePath, fingerprint }) => [
      filePath,
      fingerprint,
    ]),
  );
  const residualOwner: TrackedResidualOwner = {
    id: "root-review",
    worktree,
    trackedResiduals: new Map(suppliedTrackedResiduals),
  };
  verifyTrackedResiduals(residualOwner);
  const preparationBaseline = [
    ...readUntracked(worktree),
    ...readIgnored(worktree),
  ];
  const isolateRecordedStaging = (commitPaths: ReadonlyArray<string>) => {
    const selected = new Set(commitPaths);
    assertRecordedResidualsUnchanged(residualOwner, selected);
    const inheritedStaged = readStaged(worktree).filter(
      (filePath) =>
        residualOwner.trackedResiduals.has(filePath) && !selected.has(filePath),
    );
    if (inheritedStaged.length > 0) {
      requireGit(
        worktree,
        [
          "--literal-pathspecs",
          "restore",
          "--staged",
          "--",
          ...inheritedStaged,
        ],
        "Unable to isolate recorded cleanup residuals from final-review staging",
      );
    }
    return { selected, stagedBefore: readStaged(worktree) };
  };
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
    inspect: (
      baseCommit: string,
      maxBytes?: number,
      request?: FeatureDiffPageRequest,
    ) => ({
      baseToHead: changedBetween(worktree, baseCommit, readHead(worktree)),
      tracked: readTracked(worktree),
      staged: readStaged(worktree),
      untracked: readUntracked(worktree),
      ignored: readIgnored(worktree),
      conflictPaths: readConflicts(worktree),
      ...boundedDiff(worktree, baseCommit, maxBytes ?? 256 * 1024, request),
    }),
    trackedResidualPaths: () =>
      [...residualOwner.trackedResiduals.keys()].sort(),
    assertRecordedResidualsUnchanged: (excludedPaths) =>
      assertRecordedResidualsUnchanged(
        residualOwner,
        new Set(excludedPaths ?? []),
      ),
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
      const changed = new Set([
        ...readStaged(worktree),
        ...readTracked(worktree),
        ...readUntracked(worktree),
      ]);
      assertSafeCommitPaths(worktree, commitPaths, changed);
      const { selected, stagedBefore } = isolateRecordedStaging(commitPaths);
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
      const cleanup = cleanupAfterCommit(
        worktree,
        preparationBaseline,
        cleanupEvidence,
        commit,
      );
      recordTrackedResiduals(residualOwner);
      return {
        commit,
        changedPaths: changedBetween(worktree, baseCommit, commit),
        ...cleanup,
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
      const changed = new Set([
        ...readStaged(worktree),
        ...readTracked(worktree),
        ...readUntracked(worktree),
      ]);
      assertSafeCommitPaths(worktree, commitPaths, changed);
      const { selected, stagedBefore } = isolateRecordedStaging(commitPaths);
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
      const cleanup = cleanupAfterCommit(
        worktree,
        preparationBaseline,
        cleanupEvidence,
        commit,
      );
      recordTrackedResiduals(residualOwner);
      return {
        commit,
        changedPaths: changedBetween(worktree, parent, commit),
        ...cleanup,
      };
    },
    continueCherryPick: (_commitPaths: ReadonlyArray<string>) => {
      throw new Error("Final review cannot continue a cherry-pick.");
    },
  } satisfies FeatureTaskGitTarget;
}
