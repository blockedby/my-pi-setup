import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FeatureCandidateHandoff,
  FeatureCandidateRole,
  FeatureSelection,
  FeatureSynthesisProvenance,
} from "./feature-best-of-three.ts";

const GIT_OUTPUT_LIMIT = 512 * 1024;
const CANDIDATE_DIFF_LIMIT = 48 * 1024;
const SYNTHESIS_DIFF_LIMIT = 128 * 1024;
const SYNTHESIS_CHANGED_PATH_LIMIT = 64;
const FEATURE_COMMIT_PATH_LIMIT = 256;
const FEATURE_COMMIT_PATHSPEC_LIMIT = 128 * 1024;
const UNTRACKED_CLEANUP_PATH_LIMIT = 512;
const MAX_PATH_BYTES = 4 * 1024;

export interface FeatureCallerWorktree {
  readonly workingDir: string;
  readonly repositoryRoot: string;
  readonly commonGitDir: string;
  readonly branch: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}

export interface FeatureTemporaryWorktree {
  readonly role: FeatureCandidateRole;
  readonly path: string;
  readonly branchRef: string;
  readonly baseCommit: string;
}

export interface FeatureCommitResult {
  readonly head: string;
  readonly changedPaths: ReadonlyArray<string>;
}

export interface FeatureCandidateWarning {
  readonly category: "candidate-report-changed-paths-mismatch";
  readonly reportedPathCount: number;
  readonly canonicalPathCount: number;
  readonly reportedOnlyPathCount: number;
  readonly canonicalOnlyPathCount: number;
}

export interface FrozenFeatureCandidate extends FeatureTemporaryWorktree {
  readonly headCommit: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<FeatureCandidateWarning>;
  readonly boundedDiff: {
    readonly text: string;
    readonly truncated: boolean;
    readonly bytes: number;
  };
  readonly frozen: true;
}

export interface FeatureSynthesisWorktree {
  readonly path: string;
  readonly branchRef: string;
  readonly primaryRole: FeatureCandidateRole;
  readonly primaryCommit: string;
}

export interface ValidatedFeatureSynthesis extends FeatureSynthesisWorktree {
  readonly finalCommit: string;
  readonly changedPaths: ReadonlyArray<string>;
}

export interface FeatureWorktreeLifecycle {
  readonly caller: FeatureCallerWorktree;
  readonly temporaryRoot: string;
  createCandidateWorktrees(): ReadonlyArray<FeatureTemporaryWorktree>;
  freezeCandidate(
    worktree: FeatureTemporaryWorktree,
    handoff: FeatureCandidateHandoff,
  ): FrozenFeatureCandidate;
  prepareSelectionDirectory(): string;
  assertSelectionReadOnly(
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): void;
  validateSelection(
    selection: FeatureSelection,
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): void;
  createSynthesisWorktree(
    primary: FrozenFeatureCandidate,
  ): FeatureSynthesisWorktree;
  commitAssignedWorktree(
    role: string,
    workingDir: string,
    paths: ReadonlyArray<string>,
  ): FeatureCommitResult;
  validateSynthesis(
    worktree: FeatureSynthesisWorktree,
    provenance: FeatureSynthesisProvenance,
    selection: FeatureSelection,
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): ValidatedFeatureSynthesis;
  promote(synthesis: ValidatedFeatureSynthesis): void;
  cleanup(): ReadonlyArray<string>;
}

export interface FeatureGitOperations {
  preflight(workingDir: string): FeatureCallerWorktree;
  namespaceAvailable(caller: FeatureCallerWorktree, runId: string): boolean;
  createLifecycle(
    caller: FeatureCallerWorktree,
    runId: string,
  ): FeatureWorktreeLifecycle;
}

function gitRaw(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = GIT_OUTPUT_LIMIT,
) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function git(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer = GIT_OUTPUT_LIMIT,
) {
  return gitRaw(cwd, args, maxBuffer).trim();
}

function boundedDiagnostic(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 2 * 1024);
}

function requireGit(cwd: string, args: ReadonlyArray<string>, label: string) {
  try {
    return git(cwd, args);
  } catch (error) {
    throw new Error(`${label}: ${boundedDiagnostic(error)}`);
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
    throw new Error(`${label}: ${boundedDiagnostic(error)}`);
  }
}

function cleanStatus(workingDir: string) {
  return requireGit(
    workingDir,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignored=matching",
    ],
    "Unable to inspect worktree cleanliness",
  );
}

function canonical(value: string) {
  return fs.realpathSync.native(path.resolve(value));
}

function comparablePath(value: string) {
  try {
    return canonical(value);
  } catch {
    return path.resolve(value);
  }
}

function parseWorktreeList(value: string) {
  return value
    .split(/\n\s*\n/)
    .map((block) =>
      Object.fromEntries(
        block
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const space = line.indexOf(" ");
            return space < 0
              ? [line, "true"]
              : [line.slice(0, space), line.slice(space + 1)];
          }),
      ),
    )
    .filter((entry) => typeof entry.worktree === "string");
}

export function validateDedicatedFeatureWorktree(
  workingDir: string,
): FeatureCallerWorktree {
  if (process.platform !== "linux" || !fs.existsSync("/usr/bin/bwrap")) {
    throw new Error(
      "feature-pipeline requires Linux bubblewrap at /usr/bin/bwrap for candidate workspace isolation.",
    );
  }
  try {
    fs.accessSync("/usr/bin/bwrap", fs.constants.X_OK);
  } catch {
    throw new Error(
      "feature-pipeline requires executable /usr/bin/bwrap for candidate workspace isolation.",
    );
  }
  let resolved: string;
  try {
    resolved = canonical(workingDir);
  } catch (error) {
    throw new Error(
      `feature-pipeline working_dir is unavailable: ${boundedDiagnostic(error)}`,
    );
  }
  const repositoryRoot = canonical(
    requireGit(
      resolved,
      ["rev-parse", "--show-toplevel"],
      "Not a Git worktree",
    ),
  );
  if (repositoryRoot !== resolved) {
    throw new Error(
      "feature-pipeline working_dir must be the root of its dedicated linked Git worktree.",
    );
  }
  const worktrees = parseWorktreeList(
    requireGit(
      resolved,
      ["worktree", "list", "--porcelain"],
      "Unable to list Git worktrees",
    ),
  );
  const currentIndex = worktrees.findIndex(
    (entry) => comparablePath(entry.worktree!) === resolved,
  );
  if (currentIndex < 0) {
    throw new Error(
      "feature-pipeline working_dir is not registered as a linked Git worktree.",
    );
  }
  if (currentIndex === 0) {
    throw new Error(
      "feature-pipeline rejects the repository primary checkout; use a dedicated linked Git worktree.",
    );
  }
  const entry = worktrees[currentIndex]!;
  if (entry.detached === "true" || !entry.branch) {
    throw new Error(
      "feature-pipeline requires an attached branch in the dedicated linked worktree.",
    );
  }
  const branchRef = requireGit(
    resolved,
    ["symbolic-ref", "-q", "HEAD"],
    "feature-pipeline requires an attached branch",
  );
  const branch = requireGit(
    resolved,
    ["symbolic-ref", "--short", "HEAD"],
    "Unable to resolve feature branch",
  );
  const firstHead = requireGit(
    resolved,
    ["rev-parse", "HEAD"],
    "Unable to capture feature base commit",
  );
  const status = cleanStatus(resolved);
  if (status) {
    throw new Error(
      `feature-pipeline requires a clean dedicated worktree; status is non-empty (${status.slice(0, 1024)}).`,
    );
  }
  const secondHead = requireGit(
    resolved,
    ["rev-parse", "HEAD"],
    "Unable to confirm stable feature base commit",
  );
  if (firstHead !== secondHead) {
    throw new Error(
      "feature-pipeline base commit changed during preflight; retry from a stable worktree.",
    );
  }
  const commonGitDir = canonical(
    path.resolve(
      resolved,
      requireGit(
        resolved,
        ["rev-parse", "--git-common-dir"],
        "Unable to resolve common Git directory",
      ),
    ),
  );
  const gitDir = canonical(
    path.resolve(
      resolved,
      requireGit(
        resolved,
        ["rev-parse", "--git-dir"],
        "Unable to resolve Git directory",
      ),
    ),
  );
  if (gitDir === commonGitDir) {
    throw new Error(
      "feature-pipeline requires a linked worktree with a worktree-specific Git directory.",
    );
  }
  return {
    workingDir: resolved,
    repositoryRoot,
    commonGitDir,
    branch,
    branchRef,
    baseCommit: firstHead,
  };
}

function featureNamespace(runId: string) {
  return `pipi-feature/${runId}`;
}

function branchSlug(runId: string) {
  return featureNamespace(runId);
}

export function featureNamespaceAvailable(
  caller: FeatureCallerWorktree,
  runId: string,
) {
  const namespace = featureNamespace(runId);
  const refs = requireGit(
    caller.workingDir,
    ["for-each-ref", "--format=%(refname)", `refs/heads/${namespace}`],
    "Unable to inspect retained feature refs",
  );
  if (refs) return false;
  const worktrees = parseWorktreeList(
    requireGit(
      caller.workingDir,
      ["worktree", "list", "--porcelain"],
      "Unable to inspect registered feature worktrees",
    ),
  );
  return !worktrees.some(
    (entry) =>
      typeof entry.branch === "string" &&
      (entry.branch === `refs/heads/${namespace}` ||
        entry.branch.startsWith(`refs/heads/${namespace}/`)),
  );
}

function roleSlug(role: FeatureCandidateRole) {
  return role.toLowerCase();
}

function requireAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
  label: string,
) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `${label}: ${ancestor} is not an ancestor of ${descendant}.`,
    );
  }
}

function nulSeparatedPaths(value: string) {
  return value.split("\0").filter(Boolean);
}

function readChangedPaths(cwd: string, from: string, to: string) {
  return nulSeparatedPaths(
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
      "Unable to inspect changed paths",
    ),
  );
}

function readStagedPaths(cwd: string) {
  return nulSeparatedPaths(
    requireGitRaw(
      cwd,
      [
        "--literal-pathspecs",
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "-z",
        "--",
      ],
      "Unable to inspect staged paths",
    ),
  );
}

function readCommittedTreePaths(cwd: string, commit: string) {
  return nulSeparatedPaths(
    requireGitRaw(
      cwd,
      ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", commit],
      "Unable to inspect committed feature tree",
    ),
  );
}

interface WorktreeStatusEntry {
  readonly status: string;
  readonly filePath: string;
}

function readStatusEntries(cwd: string) {
  const entries = nulSeparatedPaths(
    requireGitRaw(
      cwd,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=traditional",
      ],
      "Unable to inspect worktree status",
    ),
  );
  return entries.flatMap((entry): ReadonlyArray<WorktreeStatusEntry> => {
    if (entry.length < 4) return [];
    return [{ status: entry.slice(0, 2), filePath: entry.slice(3) }];
  });
}

function isUntrackedStatus(status: string) {
  return status === "??" || status === "!!";
}

function pathHasExternalSymlink(cwd: string, filePath: string) {
  const worktreeRoot = path.resolve(cwd);
  const absolutePath = path.resolve(cwd, filePath);
  const relativePath = path.relative(worktreeRoot, absolutePath);
  if (
    path.isAbsolute(relativePath) ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return true;
  }

  let currentPath = worktreeRoot;
  for (const part of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, part);
    const seen = new Set<string>();
    while (true) {
      if (
        currentPath !== worktreeRoot &&
        !currentPath.startsWith(`${worktreeRoot}${path.sep}`)
      ) {
        return true;
      }
      let stats: fs.Stats;
      try {
        stats = fs.lstatSync(currentPath);
      } catch {
        break;
      }
      if (!stats.isSymbolicLink()) break;
      if (seen.has(currentPath)) return true;
      seen.add(currentPath);
      currentPath = path.resolve(
        path.dirname(currentPath),
        fs.readlinkSync(currentPath),
      );
    }
  }
  return false;
}

const generatedDirectoryNames = new Set([
  "node_modules",
  ".cache",
  ".pi",
  ".pi-subagents",
  ".worktrees",
]);
const generatedRootDirectoryNames = new Set([
  "bin",
  "build",
  "dist",
  "coverage",
  "tmp",
  "temp",
]);

function isGeneratedArtifactPath(filePath: string) {
  const parts = filePath.split("/");
  return (
    parts.some((part) => generatedDirectoryNames.has(part)) ||
    (parts.length > 0 && generatedRootDirectoryNames.has(parts[0]!))
  );
}

function readIgnoredPaths(cwd: string, paths: ReadonlyArray<string>) {
  return paths.filter((filePath) => {
    try {
      execFileSync("git", ["check-ignore", "--no-index", "--", filePath], {
        cwd,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
}

export function rollbackOwnedFeatureBranches(
  cwd: string,
  ownedBranchRefs: ReadonlyMap<string, string>,
) {
  const failures: string[] = [];
  for (const [branchRef, expectedCommit] of [
    ...ownedBranchRefs.entries(),
  ].reverse()) {
    try {
      requireGit(
        cwd,
        ["update-ref", "-d", `refs/heads/${branchRef}`, expectedCommit],
        `Unable to roll back controller-owned branch ${branchRef}`,
      );
    } catch (error) {
      failures.push(boundedDiagnostic(error));
    }
  }
  return failures;
}

export function candidateReservationFailure(
  error: unknown,
  rollbackFailures: ReadonlyArray<string>,
) {
  if (rollbackFailures.length === 0) {
    return error instanceof Error ? error : new Error(boundedDiagnostic(error));
  }
  return new Error(
    `${boundedDiagnostic(error)} Candidate reservation rollback also failed: ${rollbackFailures.join(" ")}`,
  );
}

function equalUniquePathSets(
  reported: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
) {
  const reportedSet = new Set(reported);
  const actualSet = new Set(actual);
  return (
    reportedSet.size === reported.length &&
    actualSet.size === actual.length &&
    reportedSet.size === actualSet.size &&
    [...reportedSet].every((item) => actualSet.has(item))
  );
}

function candidateReportWarning(
  reported: ReadonlyArray<string>,
  canonicalPaths: ReadonlyArray<string>,
): FeatureCandidateWarning {
  const reportedSet = new Set(reported);
  const canonicalSet = new Set(canonicalPaths);
  return {
    category: "candidate-report-changed-paths-mismatch",
    reportedPathCount: reported.length,
    canonicalPathCount: canonicalPaths.length,
    reportedOnlyPathCount: [...reportedSet].filter(
      (item) => !canonicalSet.has(item),
    ).length,
    canonicalOnlyPathCount: [...canonicalSet].filter(
      (item) => !reportedSet.has(item),
    ).length,
  };
}

function selectionAugmentationKey(value: {
  sourceRole: FeatureCandidateRole;
  idea: string;
  objectiveBenefit: string;
  evidence: string;
  sourcePaths: ReadonlyArray<string>;
}) {
  return JSON.stringify([
    value.sourceRole,
    value.idea,
    value.objectiveBenefit,
    value.evidence,
    [...value.sourcePaths].sort(),
  ]);
}

function blobIdentity(cwd: string, commit: string, filePath: string) {
  const value = requireGit(
    cwd,
    ["ls-tree", "-z", commit, "--", filePath],
    "Unable to inspect augmentation blob",
  );
  if (!value) return "MISSING";
  const [metadata, listedPath] = value.replace(/\0$/, "").split("\t");
  if (listedPath !== filePath) return "MISSING";
  const objectId = metadata?.split(/\s+/)[2];
  if (!objectId) {
    throw new Error("Unable to parse augmentation blob identity.");
  }
  return objectId;
}

function validateAugmentationAttribution(
  provenance: FeatureSynthesisProvenance,
  selection: FeatureSelection,
  candidates: ReadonlyArray<FrozenFeatureCandidate>,
  finalCommit: string,
  synthesisPath: string,
  actualChangedPaths: ReadonlyArray<string>,
) {
  const selectedIdeas = new Set(
    selection.augmentationCandidates.map(selectionAugmentationKey),
  );
  const usedIdeas = new Set<string>();
  const attributedPaths: string[] = [];
  for (const augmentation of provenance.acceptedAugmentations) {
    if (augmentation.sourceRole === provenance.primaryCandidate) {
      throw new Error(
        "Accepted augmentation must originate from a losing candidate.",
      );
    }
    const ideaKey = selectionAugmentationKey(augmentation);
    if (!selectedIdeas.has(ideaKey) || usedIdeas.has(ideaKey)) {
      throw new Error(
        "Accepted augmentation must match exactly one validated selection idea.",
      );
    }
    usedIdeas.add(ideaKey);
    const source = candidates.find(
      ({ role }) => role === augmentation.sourceRole,
    );
    if (
      !source ||
      !equalUniquePathSets(
        augmentation.sourcePaths,
        augmentation.sourcePaths.filter((item) =>
          source.changedPaths.includes(item),
        ),
      )
    ) {
      throw new Error(
        "Accepted augmentation sourcePaths must be unique paths from its losing candidate diff.",
      );
    }
    const mappedSourcePaths = augmentation.pathMappings.map(
      ({ sourcePath }) => sourcePath,
    );
    const mappedFinalPaths = augmentation.pathMappings.map(
      ({ finalPath }) => finalPath,
    );
    if (
      !equalUniquePathSets(mappedSourcePaths, augmentation.sourcePaths) ||
      new Set(mappedFinalPaths).size !== mappedFinalPaths.length ||
      mappedFinalPaths.some((item) => !actualChangedPaths.includes(item))
    ) {
      throw new Error(
        "Accepted augmentation pathMappings must map every selected source path exactly once to unique actual final paths.",
      );
    }
    for (const mapping of augmentation.pathMappings) {
      if (
        blobIdentity(source.path, source.headCommit, mapping.sourcePath) !==
        blobIdentity(synthesisPath, finalCommit, mapping.finalPath)
      ) {
        throw new Error(
          "Accepted augmentation final content must exactly match its frozen losing-candidate source blob or deletion.",
        );
      }
    }
    attributedPaths.push(...mappedFinalPaths);
  }
  if (!equalUniquePathSets(attributedPaths, actualChangedPaths)) {
    throw new Error(
      "Every primary-to-final changed path must be attributed exactly once to a validated losing-candidate idea.",
    );
  }
}

function boundedDiff(cwd: string, from: string, to: string, limit: number) {
  const value = requireGit(
    cwd,
    ["diff", "--no-ext-diff", "--no-color", `${from}..${to}`, "--"],
    "Unable to inspect candidate diff",
  );
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= limit) return { text: value, truncated: false, bytes };
  const marker = `\n[diff truncated at ${limit} UTF-8 bytes]`;
  const payload = Buffer.from(value, "utf8")
    .subarray(0, limit - Buffer.byteLength(marker, "utf8"))
    .toString("utf8");
  return { text: `${payload}${marker}`, truncated: true, bytes };
}

function isHostControlledPath(filePath: string) {
  return filePath.split("/").some((part) => part === ".git");
}

function invalidRelativePath(filePath: string) {
  if (
    !filePath ||
    filePath === "." ||
    filePath.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.startsWith(":") ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    filePath.endsWith("/") ||
    path.posix.normalize(filePath) !== filePath
  ) {
    return true;
  }
  return false;
}

function pathspecBytes(paths: ReadonlyArray<string>) {
  return paths.reduce(
    (total, filePath) =>
      total +
      (typeof filePath === "string"
        ? Buffer.byteLength(filePath, "utf8")
        : MAX_PATH_BYTES + 1) +
      1,
    0,
  );
}

function validateExplicitCommitPaths(
  workingDir: string,
  paths: ReadonlyArray<string>,
  candidateRole: FeatureCandidateRole | undefined,
) {
  if (!Array.isArray(paths)) {
    throw new Error("Feature commit paths must be an array.");
  }
  const pathLimit = candidateRole
    ? FEATURE_COMMIT_PATH_LIMIT
    : SYNTHESIS_CHANGED_PATH_LIMIT;
  if (paths.length > pathLimit) {
    throw new Error(
      `Feature commit path list exceeds the bounded maximum of ${pathLimit} paths.`,
    );
  }
  if (candidateRole && paths.length === 0) {
    throw new Error(
      "Feature candidate commits require at least one explicit path.",
    );
  }
  if (pathspecBytes(paths) > FEATURE_COMMIT_PATHSPEC_LIMIT) {
    throw new Error(
      `Feature commit pathspecs exceed the bounded maximum of ${FEATURE_COMMIT_PATHSPEC_LIMIT} UTF-8 bytes.`,
    );
  }
  const duplicates = paths.filter(
    (filePath, index) => paths.indexOf(filePath) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Feature commit paths must be unique; duplicate path: ${duplicates[0]}.`,
    );
  }
  const invalid = paths.filter((filePath) => {
    if (typeof filePath !== "string") return true;
    const relative = path.relative(
      workingDir,
      path.resolve(workingDir, filePath),
    );
    return (
      Buffer.byteLength(filePath, "utf8") > MAX_PATH_BYTES ||
      invalidRelativePath(filePath) ||
      path.isAbsolute(filePath) ||
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`)
    );
  });
  if (invalid.length > 0) {
    throw new Error(
      `Feature commit rejected unsafe/outside repository-relative paths: ${invalid.slice(0, 16).join(", ")}.`,
    );
  }
  const generated = paths.filter(
    (filePath) =>
      isGeneratedArtifactPath(filePath) || isHostControlledPath(filePath),
  );
  const ignored = readIgnoredPaths(workingDir, paths);
  if (generated.length > 0 || ignored.length > 0) {
    const rejected = [...new Set([...generated, ...ignored])];
    throw new Error(
      `Feature commit rejected generated or host-controlled paths (including ignored paths): ${rejected.slice(0, 16).join(", ")}.`,
    );
  }
  const escaped = paths.filter((filePath) =>
    pathHasExternalSymlink(workingDir, filePath),
  );
  if (escaped.length > 0) {
    throw new Error(
      `Feature commit rejected paths escaping the assigned worktree through symlinks: ${escaped.slice(0, 16).join(", ")}.`,
    );
  }
  const missing = paths.filter((filePath) => {
    if (fs.existsSync(path.resolve(workingDir, filePath))) {
      try {
        if (fs.lstatSync(path.resolve(workingDir, filePath)).isDirectory()) {
          return true;
        }
      } catch {
        return true;
      }
      return false;
    }
    try {
      execFileSync(
        "git",
        ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", filePath],
        { cwd: workingDir, stdio: "ignore" },
      );
      return false;
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `Feature commit paths must name existing files or tracked deletions: ${missing.slice(0, 16).join(", ")}.`,
    );
  }
  return [...paths];
}

function classifyUnsafeCommittedPaths(
  workingDir: string,
  paths: ReadonlyArray<string>,
) {
  const generated = paths.filter(
    (filePath) =>
      isGeneratedArtifactPath(filePath) || isHostControlledPath(filePath),
  );
  const ignored = readIgnoredPaths(workingDir, paths);
  const escaped = paths.filter((filePath) =>
    pathHasExternalSymlink(workingDir, filePath),
  );
  return {
    generated: [...new Set([...generated, ...ignored])],
    escaped,
  };
}

function assertCommittedPathsSafe(
  workingDir: string,
  paths: ReadonlyArray<string>,
  label: string,
) {
  const unsafe = classifyUnsafeCommittedPaths(workingDir, paths);
  if (unsafe.generated.length > 0) {
    throw new Error(
      `${label} rejected generated or host-controlled paths in committed diff: ${unsafe.generated.slice(0, 16).join(", ")}.`,
    );
  }
  if (unsafe.escaped.length > 0) {
    throw new Error(
      `${label} rejected paths escaping the assigned worktree through symlinks in committed diff: ${unsafe.escaped.slice(0, 16).join(", ")}.`,
    );
  }
}

function assertCommittedTreeSafe(
  workingDir: string,
  commit: string,
  label: string,
) {
  const treePaths = readCommittedTreePaths(workingDir, commit);
  const unsafe = classifyUnsafeCommittedPaths(workingDir, treePaths);
  if (unsafe.generated.length > 0) {
    throw new Error(
      `${label} rejected generated or host-controlled paths in committed tree: ${unsafe.generated.slice(0, 16).join(", ")}.`,
    );
  }
  if (unsafe.escaped.length > 0) {
    throw new Error(
      `${label} rejected paths escaping the assigned worktree through symlinks in committed tree: ${unsafe.escaped.slice(0, 16).join(", ")}.`,
    );
  }
}

function unstageAllPaths(workingDir: string) {
  const staged = readStagedPaths(workingDir);
  if (staged.length === 0) return;
  requireGit(
    workingDir,
    ["--literal-pathspecs", "reset", "--quiet", "--", ...staged],
    "Unable to unstage rejected feature paths",
  );
}

function removeOwnedUntrackedEntry(
  root: string,
  absolute: string,
  budget: { remaining: number },
) {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch {
    return;
  }
  if (budget.remaining <= 0) {
    throw new Error(
      `Untracked cleanup exceeded the bounded entry limit of ${UNTRACKED_CLEANUP_PATH_LIMIT}.`,
    );
  }
  budget.remaining -= 1;
  if (stats.isSymbolicLink()) {
    fs.unlinkSync(absolute);
    return;
  }
  if (!isWithinPath(root, comparablePath(absolute))) {
    throw new Error("Untracked cleanup path escapes the owned worktree.");
  }
  if (!stats.isDirectory()) {
    fs.unlinkSync(absolute);
    return;
  }
  for (const entry of fs.readdirSync(absolute)) {
    removeOwnedUntrackedEntry(root, path.join(absolute, entry), budget);
  }
  try {
    fs.rmdirSync(absolute);
  } catch (error) {
    throw new Error(
      `Unable to remove owned untracked directory: ${boundedDiagnostic(error)}`,
    );
  }
}

function removeEmptyOwnedAncestors(
  root: string,
  start: string,
  budget: { remaining: number },
) {
  let current = start;
  while (current !== root && isWithinPath(root, current)) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      current = path.dirname(current);
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) break;
    if (fs.readdirSync(current).length > 0) break;
    removeOwnedUntrackedEntry(root, current, budget);
    current = path.dirname(current);
  }
}

function removeOwnedUntrackedPath(
  workingDir: string,
  filePath: string,
  budget: { remaining: number },
) {
  const root = canonical(workingDir);
  const withoutTrailingSlash = filePath.replace(/\/$/, "");
  if (
    !withoutTrailingSlash ||
    invalidRelativePath(withoutTrailingSlash) ||
    !isWithinPath(root, path.resolve(root, withoutTrailingSlash))
  ) {
    throw new Error(
      `Untracked cleanup path is outside the owned worktree: ${filePath}.`,
    );
  }
  const absolute = path.resolve(root, withoutTrailingSlash);
  removeOwnedUntrackedEntry(root, absolute, budget);
  removeEmptyOwnedAncestors(root, path.dirname(absolute), budget);
}

function isWithinPath(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function finalizeOwnedWorktree(
  workingDir: string,
  label: string,
  allowUntrackedCleanup: boolean,
) {
  const statuses = readStatusEntries(workingDir);
  const trackedOrStaged = statuses.filter(
    ({ status }) => !isUntrackedStatus(status),
  );
  if (trackedOrStaged.length > 0) {
    throw new Error(
      `${label} has tracked/staged leftovers after its final commit: ${trackedOrStaged
        .slice(0, 16)
        .map(({ status, filePath }) => `${status} ${filePath}`)
        .join(", ")}.`,
    );
  }
  if (statuses.length === 0) return;
  if (!allowUntrackedCleanup) {
    throw new Error(
      `${label} has untracked leftovers after its final commit: ${statuses
        .slice(0, 16)
        .map(({ filePath }) => filePath)
        .join(", ")}.`,
    );
  }
  if (statuses.length > UNTRACKED_CLEANUP_PATH_LIMIT) {
    throw new Error(
      `${label} has ${statuses.length} untracked leftovers; bounded cleanup allows at most ${UNTRACKED_CLEANUP_PATH_LIMIT}.`,
    );
  }
  const cleanupBudget = { remaining: UNTRACKED_CLEANUP_PATH_LIMIT };
  try {
    for (const { filePath } of statuses) {
      removeOwnedUntrackedPath(workingDir, filePath, cleanupBudget);
    }
  } catch (error) {
    throw new Error(
      `${label} untracked cleanup failed: ${boundedDiagnostic(error)}`,
    );
  }
  const remaining = readStatusEntries(workingDir);
  if (remaining.length > 0) {
    throw new Error(
      `${label} remained dirty after bounded untracked cleanup: ${remaining
        .slice(0, 16)
        .map(({ status, filePath }) => `${status} ${filePath}`)
        .join(", ")}.`,
    );
  }
}

export function cleanupOwnedFeatureWorktreePaths(
  temporaryRoot: string,
  ownedPaths: ReadonlyArray<string>,
  removeWorktree: (worktreePath: string) => void,
) {
  const failures: string[] = [];
  const rootPath = path.resolve(temporaryRoot);
  const root = comparablePath(temporaryRoot);
  for (const worktreePath of [...ownedPaths].reverse()) {
    const lexicalPath = path.resolve(worktreePath);
    if (!isWithinPath(rootPath, lexicalPath)) continue;
    const resolvedPath = comparablePath(worktreePath);
    if (!isWithinPath(root, resolvedPath)) continue;
    try {
      removeWorktree(worktreePath);
    } catch (error) {
      failures.push(
        `Failed to remove controller-owned worktree ${worktreePath}: ${boundedDiagnostic(error)}`,
      );
    }
  }
  if (failures.length > 0) return failures;
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(
      `Failed to remove controller-owned temporary root ${temporaryRoot}: ${boundedDiagnostic(error)}`,
    );
  }
  return failures;
}

class GitFeatureWorktreeLifecycle implements FeatureWorktreeLifecycle {
  readonly caller: FeatureCallerWorktree;
  readonly runId: string;
  readonly temporaryRoot: string;
  private readonly ownedWorktreePaths = new Set<string>();
  private readonly ownedBranchRefs = new Map<string, string>();
  private readonly candidateHeads = new Map<FeatureCandidateRole, string>();
  private selectionDirectory?: string;
  private synthesis?: FeatureSynthesisWorktree;
  private candidateWorktrees?: ReadonlyArray<FeatureTemporaryWorktree>;
  private cleaned = false;

  constructor(caller: FeatureCallerWorktree, runId: string) {
    this.caller = caller;
    this.runId = runId;
    const worktreeRoot = path.join(
      path.dirname(caller.commonGitDir),
      ".worktrees",
    );
    fs.mkdirSync(worktreeRoot, { recursive: true });
    const resolvedWorktreeRoot = canonical(worktreeRoot);
    const repositoryContainer = canonical(path.dirname(caller.commonGitDir));
    if (!isWithinPath(repositoryContainer, resolvedWorktreeRoot)) {
      throw new Error(
        `Feature pipeline temporary worktree root must remain inside the caller repository (${resolvedWorktreeRoot} is outside ${repositoryContainer}).`,
      );
    }
    this.temporaryRoot = fs.mkdtempSync(
      path.join(
        resolvedWorktreeRoot,
        `pipi-feature-${branchSlug(runId).split("/").at(-1)}-`,
      ),
    );
  }

  private worktreeAdd(worktreePath: string, branchRef: string, commit: string) {
    requireGit(
      this.caller.workingDir,
      ["worktree", "add", "--no-track", "-b", branchRef, worktreePath, commit],
      `Unable to create controller-owned worktree ${branchRef}`,
    );
    this.ownedWorktreePaths.add(worktreePath);
    this.ownedBranchRefs.set(branchRef, commit);
  }

  private rollbackCandidateReservation() {
    return [
      ...this.cleanup(),
      ...rollbackOwnedFeatureBranches(
        this.caller.workingDir,
        this.ownedBranchRefs,
      ),
    ];
  }

  createCandidateWorktrees() {
    if (this.candidateWorktrees) return this.candidateWorktrees;
    const base = branchSlug(this.runId);
    const worktrees = (["Minimal", "Robust", "Architectural"] as const).map(
      (role) => ({
        role,
        path: path.join(this.temporaryRoot, `candidate-${roleSlug(role)}`),
        branchRef: `${base}/candidate-${roleSlug(role)}`,
        baseCommit: this.caller.baseCommit,
      }),
    );
    try {
      for (const worktree of worktrees) {
        this.worktreeAdd(
          worktree.path,
          worktree.branchRef,
          this.caller.baseCommit,
        );
      }
      this.candidateWorktrees = worktrees;
      return worktrees;
    } catch (error) {
      throw candidateReservationFailure(
        error,
        this.rollbackCandidateReservation(),
      );
    }
  }

  freezeCandidate(
    worktree: FeatureTemporaryWorktree,
    handoff: FeatureCandidateHandoff,
  ) {
    const headCommit = requireGit(
      worktree.path,
      ["rev-parse", "HEAD"],
      `Unable to inspect ${worktree.role} candidate HEAD`,
    );
    const branchRef = requireGit(
      worktree.path,
      ["symbolic-ref", "--short", "HEAD"],
      `Unable to inspect ${worktree.role} candidate branch`,
    );
    const expected = {
      role: worktree.role,
      worktreePath: worktree.path,
      branchRef: worktree.branchRef,
      baseCommit: worktree.baseCommit,
      candidateHeadCommit: headCommit,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (handoff[key as keyof typeof expected] !== value) {
        throw new Error(
          `${worktree.role} candidate handoff ${key} does not match controller Git state.`,
        );
      }
    }
    if (branchRef !== worktree.branchRef) {
      throw new Error(
        `${worktree.role} candidate changed its controller-owned branch.`,
      );
    }
    if (headCommit === worktree.baseCommit) {
      throw new Error(
        `${worktree.role} candidate did not create an implementation commit.`,
      );
    }
    requireAncestor(
      worktree.path,
      worktree.baseCommit,
      headCommit,
      `${worktree.role} candidate ancestry is invalid`,
    );
    finalizeOwnedWorktree(worktree.path, `${worktree.role} candidate`, true);
    const finalizedHead = requireGit(
      worktree.path,
      ["rev-parse", "HEAD"],
      `Unable to confirm ${worktree.role} candidate HEAD after cleanup`,
    );
    if (finalizedHead !== headCommit) {
      throw new Error(
        `${worktree.role} candidate changed during finalization cleanup.`,
      );
    }
    const changedPaths = readChangedPaths(
      worktree.path,
      worktree.baseCommit,
      headCommit,
    );
    if (changedPaths.length === 0) {
      throw new Error(
        `${worktree.role} candidate commit contains no implementation changes.`,
      );
    }
    if (changedPaths.length > FEATURE_COMMIT_PATH_LIMIT) {
      throw new Error(
        `${worktree.role} candidate changed ${changedPaths.length} paths; maximum is ${FEATURE_COMMIT_PATH_LIMIT}.`,
      );
    }
    assertCommittedPathsSafe(
      worktree.path,
      changedPaths,
      `${worktree.role} candidate`,
    );
    assertCommittedTreeSafe(
      worktree.path,
      headCommit,
      `${worktree.role} candidate`,
    );
    const warnings = equalUniquePathSets(handoff.changedPaths, changedPaths)
      ? []
      : [candidateReportWarning(handoff.changedPaths, changedPaths)];
    const diff = boundedDiff(
      worktree.path,
      worktree.baseCommit,
      headCommit,
      CANDIDATE_DIFF_LIMIT,
    );
    if (diff.truncated) {
      throw new Error(
        `${worktree.role} candidate diff exceeds ${CANDIDATE_DIFF_LIMIT} UTF-8 bytes.`,
      );
    }
    this.candidateHeads.set(worktree.role, headCommit);
    return {
      ...worktree,
      headCommit,
      changedPaths,
      warnings,
      boundedDiff: diff,
      frozen: true as const,
    };
  }

  prepareSelectionDirectory() {
    if (this.selectionDirectory) return this.selectionDirectory;
    this.selectionDirectory = path.join(this.temporaryRoot, "selection");
    fs.mkdirSync(this.selectionDirectory);
    return this.selectionDirectory;
  }

  assertSelectionReadOnly(candidates: ReadonlyArray<FrozenFeatureCandidate>) {
    if (!this.selectionDirectory) {
      throw new Error("Selection directory was not prepared.");
    }
    if (fs.readdirSync(this.selectionDirectory).length > 0) {
      throw new Error(
        "Selection phase wrote before choosing a primary candidate.",
      );
    }
    for (const candidate of candidates) {
      const head = requireGit(
        candidate.path,
        ["rev-parse", "HEAD"],
        "Unable to confirm frozen candidate",
      );
      if (
        head !== candidate.headCommit ||
        this.candidateHeads.get(candidate.role) !== head ||
        cleanStatus(candidate.path)
      ) {
        throw new Error(`${candidate.role} candidate changed after freeze.`);
      }
    }
  }

  validateSelection(
    selection: FeatureSelection,
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ) {
    for (const augmentation of selection.augmentationCandidates) {
      if (augmentation.sourceRole === selection.primaryCandidate) {
        throw new Error(
          "Selection augmentation must originate from a losing candidate before synthesis mutation.",
        );
      }
      const source = candidates.find(
        ({ role }) => role === augmentation.sourceRole,
      );
      if (
        !source ||
        !equalUniquePathSets(
          augmentation.sourcePaths,
          augmentation.sourcePaths.filter((item) =>
            source.changedPaths.includes(item),
          ),
        )
      ) {
        throw new Error(
          "Selection augmentation sourcePaths must be exact unique paths from the frozen losing-candidate diff.",
        );
      }
    }
  }

  createSynthesisWorktree(primary: FrozenFeatureCandidate) {
    this.assertSelectionReadOnly(
      [...this.candidateHeads].map(([role, headCommit]) => {
        if (role === primary.role) return primary;
        const candidatePath = path.join(
          this.temporaryRoot,
          `candidate-${roleSlug(role)}`,
        );
        return {
          role,
          path: candidatePath,
          branchRef: `${branchSlug(this.runId)}/candidate-${roleSlug(role)}`,
          baseCommit: this.caller.baseCommit,
          headCommit,
          changedPaths: [],
          warnings: [],
          boundedDiff: { text: "", truncated: false, bytes: 0 },
          frozen: true as const,
        };
      }),
    );
    const synthesisPath = this.selectionDirectory!;
    fs.rmdirSync(synthesisPath);
    const synthesis: FeatureSynthesisWorktree = {
      path: synthesisPath,
      branchRef: `${branchSlug(this.runId)}/synthesis`,
      primaryRole: primary.role,
      primaryCommit: primary.headCommit,
    };
    this.worktreeAdd(
      synthesis.path,
      synthesis.branchRef,
      synthesis.primaryCommit,
    );
    this.synthesis = synthesis;
    return synthesis;
  }

  commitAssignedWorktree(
    role: string,
    workingDir: string,
    paths: ReadonlyArray<string>,
  ): FeatureCommitResult {
    if (this.cleaned) {
      throw new Error(
        "Feature commit authority is closed after lifecycle cleanup.",
      );
    }
    const resolved = comparablePath(workingDir);
    if (!this.ownedWorktreePaths.has(resolved)) {
      throw new Error("Feature commit path is not owned by this pipeline run.");
    }
    const candidateRole = (
      ["Minimal", "Robust", "Architectural"] as const
    ).find((item) => `candidate-${item.toLowerCase()}` === role);
    const expectedPath = candidateRole
      ? path.join(this.temporaryRoot, `candidate-${roleSlug(candidateRole)}`)
      : role === "implementation-synthesis"
        ? this.synthesis?.path
        : undefined;
    if (!expectedPath || comparablePath(expectedPath) !== resolved) {
      throw new Error(
        "Feature commit role does not own the assigned worktree.",
      );
    }
    const selectedPaths = validateExplicitCommitPaths(
      resolved,
      paths,
      candidateRole,
    );
    const initialStagedPaths = readStagedPaths(resolved);
    const unsafeInitial = classifyUnsafeCommittedPaths(
      resolved,
      initialStagedPaths,
    );
    if (unsafeInitial.generated.length > 0) {
      throw new Error(
        `Feature commit rejected generated or host-controlled paths already staged: ${unsafeInitial.generated.slice(0, 16).join(", ")}.`,
      );
    }
    if (unsafeInitial.escaped.length > 0) {
      throw new Error(
        `Feature commit rejected paths escaping the assigned worktree through symlinks already staged: ${unsafeInitial.escaped.slice(0, 16).join(", ")}.`,
      );
    }
    const unselectedStagedPaths = initialStagedPaths.filter(
      (filePath) => !selectedPaths.includes(filePath),
    );
    if (unselectedStagedPaths.length > 0) {
      throw new Error(
        `Feature commit rejected tracked/staged residue outside explicit paths: ${unselectedStagedPaths.slice(0, 16).join(", ")}.`,
      );
    }
    try {
      if (selectedPaths.length > 0) {
        requireGit(
          resolved,
          ["--literal-pathspecs", "add", "--", ...selectedPaths],
          "Unable to stage explicit feature implementation paths",
        );
      }
      const stagedPaths = readStagedPaths(resolved);
      const unexpectedStagedPaths = stagedPaths.filter(
        (filePath) => !selectedPaths.includes(filePath),
      );
      if (unexpectedStagedPaths.length > 0) {
        throw new Error(
          `Feature commit rejected tracked/staged residue outside explicit paths: ${unexpectedStagedPaths.slice(0, 16).join(", ")}.`,
        );
      }
      const unsafe = classifyUnsafeCommittedPaths(resolved, stagedPaths);
      if (unsafe.generated.length > 0) {
        throw new Error(
          `Feature commit rejected generated or host-controlled paths (including ignored paths): ${unsafe.generated.slice(0, 16).join(", ")}.`,
        );
      }
      if (unsafe.escaped.length > 0) {
        throw new Error(
          `Feature commit rejected paths escaping the assigned worktree through symlinks: ${unsafe.escaped.slice(0, 16).join(", ")}.`,
        );
      }
      const commitArgs = [
        "commit",
        "--no-verify",
        "-m",
        candidateRole
          ? `feature-pipeline ${candidateRole.toLowerCase()} candidate`
          : "feature-pipeline final synthesis",
      ];
      if (!candidateRole) commitArgs.push("--allow-empty");
      requireGit(
        resolved,
        commitArgs,
        "Unable to commit assigned feature worktree",
      );
    } catch (error) {
      try {
        unstageAllPaths(resolved);
      } catch (resetError) {
        throw new Error(
          `${boundedDiagnostic(error)}; unable to clean rejected feature index: ${boundedDiagnostic(resetError)}`,
        );
      }
      throw error;
    }
    const head = requireGit(
      resolved,
      ["rev-parse", "HEAD"],
      "Unable to read committed feature HEAD",
    );
    const from = candidateRole
      ? this.caller.baseCommit
      : this.synthesis?.primaryCommit;
    if (!from) {
      throw new Error("Feature synthesis base commit is unavailable.");
    }
    const changedPaths = readChangedPaths(resolved, from, head);
    const changedPathLimit = candidateRole
      ? FEATURE_COMMIT_PATH_LIMIT
      : SYNTHESIS_CHANGED_PATH_LIMIT;
    if (changedPaths.length > changedPathLimit) {
      throw new Error(
        `${candidateRole ? "Feature candidate" : "Feature synthesis"} changed ${changedPaths.length} paths; maximum is ${changedPathLimit}.`,
      );
    }
    assertCommittedPathsSafe(
      resolved,
      changedPaths,
      candidateRole ? `${candidateRole} candidate` : "Feature synthesis",
    );
    const diff = boundedDiff(
      resolved,
      from,
      head,
      candidateRole ? CANDIDATE_DIFF_LIMIT : SYNTHESIS_DIFF_LIMIT,
    );
    if (diff.truncated) {
      throw new Error(
        `${candidateRole ? "Feature candidate" : "Feature synthesis"} diff exceeds ${candidateRole ? CANDIDATE_DIFF_LIMIT : SYNTHESIS_DIFF_LIMIT} UTF-8 bytes.`,
      );
    }
    return { head, changedPaths };
  }

  validateSynthesis(
    worktree: FeatureSynthesisWorktree,
    provenance: FeatureSynthesisProvenance,
    selection: FeatureSelection,
    candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ) {
    if (this.synthesis?.path !== worktree.path) {
      throw new Error(
        "Synthesis worktree is not controller-owned by this run.",
      );
    }
    const finalCommit = requireGit(
      worktree.path,
      ["rev-parse", "HEAD"],
      "Unable to inspect final synthesis commit",
    );
    if (
      provenance.primaryCandidate !== worktree.primaryRole ||
      provenance.primaryCommit !== worktree.primaryCommit ||
      provenance.finalCommit !== finalCommit
    ) {
      throw new Error(
        "Synthesis provenance does not match controller Git state.",
      );
    }
    if (finalCommit === worktree.primaryCommit) {
      throw new Error(
        "Synthesis must create a distinct final commit, including for no-augmentation selection.",
      );
    }
    requireAncestor(
      worktree.path,
      worktree.primaryCommit,
      finalCommit,
      "Synthesis ancestry is invalid",
    );
    finalizeOwnedWorktree(worktree.path, "Synthesis worktree", true);
    const finalizedCommit = requireGit(
      worktree.path,
      ["rev-parse", "HEAD"],
      "Unable to confirm final synthesis commit after cleanup",
    );
    if (finalizedCommit !== finalCommit) {
      throw new Error("Synthesis commit changed during finalization cleanup.");
    }
    const changedPaths = readChangedPaths(
      worktree.path,
      worktree.primaryCommit,
      finalCommit,
    );
    assertCommittedPathsSafe(worktree.path, changedPaths, "Synthesis worktree");
    assertCommittedTreeSafe(worktree.path, finalCommit, "Synthesis worktree");
    if (changedPaths.length > SYNTHESIS_CHANGED_PATH_LIMIT) {
      throw new Error(
        `Bounded augmentation changed ${changedPaths.length} paths; maximum is ${SYNTHESIS_CHANGED_PATH_LIMIT}.`,
      );
    }
    const diff = boundedDiff(
      worktree.path,
      worktree.primaryCommit,
      finalCommit,
      SYNTHESIS_DIFF_LIMIT,
    );
    if (diff.truncated) {
      throw new Error(
        `Bounded augmentation diff exceeds ${SYNTHESIS_DIFF_LIMIT} UTF-8 bytes.`,
      );
    }
    if (!equalUniquePathSets(provenance.changedPaths, changedPaths)) {
      throw new Error(
        "Synthesis changedPaths do not match its augmentation diff.",
      );
    }
    validateAugmentationAttribution(
      provenance,
      selection,
      candidates,
      finalCommit,
      worktree.path,
      changedPaths,
    );
    return { ...worktree, finalCommit, changedPaths };
  }

  promote(synthesis: ValidatedFeatureSynthesis) {
    const currentHead = requireGit(
      this.caller.workingDir,
      ["rev-parse", "HEAD"],
      "Unable to inspect caller HEAD before promotion",
    );
    const branch = requireGit(
      this.caller.workingDir,
      ["symbolic-ref", "-q", "HEAD"],
      "Caller branch detached before promotion",
    );
    if (
      currentHead !== this.caller.baseCommit ||
      branch !== this.caller.branchRef ||
      cleanStatus(this.caller.workingDir)
    ) {
      throw new Error(
        "Caller feature worktree drifted after preflight; incomplete synthesis was not promoted.",
      );
    }
    requireGit(
      this.caller.workingDir,
      ["merge", "--ff-only", "--no-edit", synthesis.finalCommit],
      "Exact synthesized commit promotion failed",
    );
    const promotedHead = requireGit(
      this.caller.workingDir,
      ["rev-parse", "HEAD"],
      "Unable to verify promoted HEAD",
    );
    const promotedTree = requireGit(
      this.caller.workingDir,
      ["rev-parse", "HEAD^{tree}"],
      "Unable to verify promoted tree",
    );
    const synthesisTree = requireGit(
      synthesis.path,
      ["rev-parse", `${synthesis.finalCommit}^{tree}`],
      "Unable to verify synthesis tree",
    );
    if (
      promotedHead !== synthesis.finalCommit ||
      promotedTree !== synthesisTree ||
      cleanStatus(this.caller.workingDir)
    ) {
      throw new Error(
        "Promoted caller state is not the exact synthesized commit/state.",
      );
    }
  }

  cleanup() {
    if (this.cleaned) return [];
    this.cleaned = true;
    return cleanupOwnedFeatureWorktreePaths(
      this.temporaryRoot,
      [...this.ownedWorktreePaths],
      (worktreePath) =>
        git(this.caller.workingDir, [
          "worktree",
          "remove",
          "--force",
          worktreePath,
        ]),
    );
  }
}

export const defaultFeatureGitOperations: FeatureGitOperations = {
  preflight: validateDedicatedFeatureWorktree,
  namespaceAvailable: featureNamespaceAvailable,
  createLifecycle: (caller, runId) =>
    new GitFeatureWorktreeLifecycle(caller, runId),
};
