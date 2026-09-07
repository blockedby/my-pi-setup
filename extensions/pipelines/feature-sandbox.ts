import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type Skill,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createCleanupRecorder,
  type CleanupEvidenceSink,
} from "./cleanup-evidence.ts";

export type FeatureSandboxMode = "candidate" | "selection" | "augmentation";

export interface FeatureToolBoundary {
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly availableToolNames: ReadonlyArray<string>;
  readonly initialActiveTools: ReadonlyArray<string>;
  enableAugmentation(): void;
  setSkills(skills: ReadonlyArray<Pick<Skill, "baseDir" | "filePath">>): void;
}

function comparableExistingPath(value: string) {
  return fs.realpathSync.native(path.resolve(value));
}

function isWithin(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function nearestExisting(value: string) {
  let current = path.resolve(value);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing parent for ${value}.`);
    current = parent;
  }
  return comparableExistingPath(current);
}

// Grants come from the host resource loader, never tool arguments. Prompts
// use lexical paths; containment uses canonical package roots pinned here.
function skillResources(
  skills: ReadonlyArray<Pick<Skill, "baseDir" | "filePath">>,
) {
  return skills.flatMap((skill) => [
    {
      source: comparableExistingPath(skill.baseDir),
      destination: path.resolve(skill.baseDir),
      directory: true,
    },
    {
      source: comparableExistingPath(skill.filePath),
      destination: path.resolve(skill.filePath),
      directory: false,
    },
  ]);
}

type SkillResources = ReturnType<typeof skillResources>;

function withinSkill(value: string, resources: SkillResources) {
  return resources.some(({ source, directory }) =>
    directory ? isWithin(value, source) : value === source,
  );
}

function assertAllowedPath(
  value: string,
  roots: ReadonlyArray<string>,
  operation: "read" | "write",
  resources: SkillResources = [],
) {
  const target =
    operation === "read" || fs.existsSync(value)
      ? comparableExistingPath(value)
      : nearestExisting(value);
  if (withinSkill(target, resources)) {
    if (operation === "write") {
      throw new Error("Feature skill packages are read-only.");
    }
    // .pipi ancestors are legitimate for installed skills; nested metadata
    // is not part of the package resource grant.
    const allowed = resources.some(({ source, directory }) => {
      if (!directory) return target === source;
      return (
        isWithin(target, source) &&
        !path
          .relative(source, target)
          .split(path.sep)
          .some((part) => [".git", ".pi-subagents", ".pipi"].includes(part))
      );
    });
    if (allowed) return target;
  }
  const requestedParts = path.resolve(value).split(path.sep);
  if (
    requestedParts.some(
      (part) => part === ".git" || part === ".pi-subagents" || part === ".pipi",
    )
  ) {
    throw new Error(
      "Feature workspace access denied to controller-owned metadata.",
    );
  }
  const resolvedRoots = roots.map(comparableExistingPath);
  const resolved =
    operation === "read" || fs.existsSync(value)
      ? comparableExistingPath(value)
      : nearestExisting(value);
  if (
    resolved
      .split(path.sep)
      .some(
        (part) =>
          part === ".git" || part === ".pi-subagents" || part === ".pipi",
      )
  ) {
    throw new Error(
      "Feature workspace access denied to controller-owned metadata.",
    );
  }
  if (!resolvedRoots.some((root) => isWithin(resolved, root))) {
    throw new Error(
      `Feature workspace ${operation} denied outside the controller-assigned scope.`,
    );
  }
  return path.resolve(value);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function commonGitDir(tempRoot: string, cwd: string) {
  const source = fs.existsSync(path.join(cwd, ".git"))
    ? cwd
    : fs
        .readdirSync(tempRoot, { withFileTypes: true })
        .find(
          (entry) => entry.isDirectory() && entry.name.startsWith("candidate-"),
        )?.name;
  if (!source) return undefined;
  const gitCwd = path.isAbsolute(source) ? source : path.join(tempRoot, source);
  try {
    const value = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: gitCwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return comparableExistingPath(path.resolve(gitCwd, value));
  } catch {
    return undefined;
  }
}

function visibleRoots(mode: FeatureSandboxMode, tempRoot: string, cwd: string) {
  if (mode !== "selection") return [cwd];
  return [
    cwd,
    ...fs
      .readdirSync(tempRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("candidate-"),
      )
      .map((entry) => path.join(tempRoot, entry.name)),
  ];
}

interface FeatureSandboxDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface FeatureRuntimeDirectories {
  readonly root: string;
  readonly temp: string;
  readonly cache: string;
  readonly parentIdentity: FeatureSandboxDirectoryIdentity;
  readonly rootIdentity: FeatureSandboxDirectoryIdentity;
  readonly tempIdentity: FeatureSandboxDirectoryIdentity;
  readonly cacheIdentity: FeatureSandboxDirectoryIdentity;
}

interface OwnedFeatureSandboxRuntime {
  readonly workspaceRoot: string;
  readonly runtimeParent: string;
  readonly runtimeRoot: string;
  readonly parentIdentity: FeatureSandboxDirectoryIdentity;
  readonly rootIdentity: FeatureSandboxDirectoryIdentity;
  readonly tempIdentity?: FeatureSandboxDirectoryIdentity;
  readonly cacheIdentity?: FeatureSandboxDirectoryIdentity;
}

const ownedFeatureSandboxRuntimes = new Map<
  string,
  OwnedFeatureSandboxRuntime
>();

function lstatIfPresent(value: string) {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function runtimeDirectoryIdentity(stats: fs.Stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameRuntimeDirectory(
  left: FeatureSandboxDirectoryIdentity,
  right: FeatureSandboxDirectoryIdentity,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertRuntimeDirectory(value: string, label: string) {
  const stats = lstatIfPresent(value);
  if (!stats) throw new Error(`Feature sandbox runtime ${label} disappeared.`);
  if (stats.isSymbolicLink())
    throw new Error(
      `Feature sandbox runtime ${label} must not be a symbolic link.`,
    );
  if (!stats.isDirectory())
    throw new Error(`Feature sandbox runtime ${label} must be a directory.`);
  if (comparableExistingPath(value) !== path.resolve(value)) {
    throw new Error(
      `Feature sandbox runtime ${label} has a symbolic-link ancestor.`,
    );
  }
  return stats;
}

function ensureRuntimeDirectory(value: string, label: string) {
  let created = false;
  if (!lstatIfPresent(value)) {
    try {
      fs.mkdirSync(value);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return { created, stats: assertRuntimeDirectory(value, label) };
}

function assertCurrentRuntimeDirectory(
  value: string,
  expected: FeatureSandboxDirectoryIdentity,
  label: string,
) {
  const stats = assertRuntimeDirectory(value, label);
  if (!sameRuntimeDirectory(runtimeDirectoryIdentity(stats), expected)) {
    throw new Error(
      `Feature sandbox runtime ${label} was replaced after setup.`,
    );
  }
  return stats;
}

function createFeatureRuntimeDirectories(tempRoot: string, cwd: string) {
  const workspaceRoot = comparableExistingPath(cwd);
  const canonicalTempRoot = comparableExistingPath(tempRoot);
  const runtimeParent = path.join(canonicalTempRoot, ".pipi-runtime");
  const workspaceName = path.basename(workspaceRoot);
  if (!workspaceName) {
    throw new Error(
      "Feature sandbox workspace must have a stable directory name.",
    );
  }
  const root = path.join(runtimeParent, workspaceName);
  if (
    isWithin(runtimeParent, workspaceRoot) ||
    isWithin(workspaceRoot, runtimeParent) ||
    isWithin(root, workspaceRoot)
  ) {
    throw new Error(
      "Feature sandbox runtime must remain outside its assigned workspace.",
    );
  }
  const existing = ownedFeatureSandboxRuntimes.get(workspaceRoot);
  // Reuse is not a fresh allocation. Validate before mkdir can recreate a
  // missing path, and never transfer the old cleanup grant to a new inode.
  if (existing) {
    assertCurrentRuntimeDirectory(
      runtimeParent,
      existing.parentIdentity,
      "parent directory",
    );
    assertCurrentRuntimeDirectory(
      root,
      existing.rootIdentity,
      "root directory",
    );
  }
  const parentResult = ensureRuntimeDirectory(
    runtimeParent,
    "parent directory",
  );
  if (
    existing &&
    !sameRuntimeDirectory(
      runtimeDirectoryIdentity(parentResult.stats),
      existing.parentIdentity,
    )
  ) {
    throw new Error(
      "Feature sandbox runtime parent was replaced after setup; refusing to use it.",
    );
  }
  const rootResult = ensureRuntimeDirectory(root, "root directory");
  if (
    existing &&
    !sameRuntimeDirectory(
      runtimeDirectoryIdentity(rootResult.stats),
      existing.rootIdentity,
    )
  ) {
    throw new Error(
      "Feature sandbox runtime root was replaced after setup; refusing to use it.",
    );
  }
  if (rootResult.created || existing) {
    ownedFeatureSandboxRuntimes.set(workspaceRoot, {
      ...(existing && !rootResult.created ? existing : {}),
      workspaceRoot,
      runtimeParent,
      runtimeRoot: root,
      parentIdentity: runtimeDirectoryIdentity(parentResult.stats),
      rootIdentity: runtimeDirectoryIdentity(rootResult.stats),
    });
  }
  const tempResult = ensureRuntimeDirectory(path.join(root, "tmp"), "temp");
  const cacheResult = ensureRuntimeDirectory(path.join(root, "cache"), "cache");
  const tracked = ownedFeatureSandboxRuntimes.get(workspaceRoot);
  if (
    tracked?.tempIdentity &&
    !sameRuntimeDirectory(
      runtimeDirectoryIdentity(tempResult.stats),
      tracked.tempIdentity,
    )
  ) {
    throw new Error(
      "Feature sandbox runtime temp directory was replaced after setup; refusing to use it.",
    );
  }
  if (
    tracked?.cacheIdentity &&
    !sameRuntimeDirectory(
      runtimeDirectoryIdentity(cacheResult.stats),
      tracked.cacheIdentity,
    )
  ) {
    throw new Error(
      "Feature sandbox runtime cache directory was replaced after setup; refusing to use it.",
    );
  }
  if (tracked) {
    ownedFeatureSandboxRuntimes.set(workspaceRoot, {
      ...tracked,
      tempIdentity: runtimeDirectoryIdentity(tempResult.stats),
      cacheIdentity: runtimeDirectoryIdentity(cacheResult.stats),
    });
  }
  return {
    root,
    temp: path.join(root, "tmp"),
    cache: path.join(root, "cache"),
    parentIdentity: runtimeDirectoryIdentity(parentResult.stats),
    rootIdentity: runtimeDirectoryIdentity(rootResult.stats),
    tempIdentity: runtimeDirectoryIdentity(tempResult.stats),
    cacheIdentity: runtimeDirectoryIdentity(cacheResult.stats),
  } satisfies FeatureRuntimeDirectories;
}

function assertFeatureRuntimeDirectories(runtime: FeatureRuntimeDirectories) {
  assertCurrentRuntimeDirectory(
    path.dirname(runtime.root),
    runtime.parentIdentity,
    "parent directory",
  );
  assertCurrentRuntimeDirectory(runtime.root, runtime.rootIdentity, "root");
  assertCurrentRuntimeDirectory(runtime.temp, runtime.tempIdentity, "temp");
  assertCurrentRuntimeDirectory(runtime.cache, runtime.cacheIdentity, "cache");
}

function cleanupWorkspaceKeys(workspaceRoot: string) {
  const absolute = path.resolve(workspaceRoot);
  try {
    return [...new Set([comparableExistingPath(absolute), absolute])];
  } catch {
    return [absolute];
  }
}

function cleanupWarning(runtime: OwnedFeatureSandboxRuntime, message: string) {
  return `Feature sandbox runtime cleanup skipped for ${runtime.runtimeRoot}: ${message}`;
}

function cleanupErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const FEATURE_SANDBOX_CLEANUP_PHASE = "feature-sandbox-runtime-cleanup";

function cleanupIdentity(identity: FeatureSandboxDirectoryIdentity) {
  return `${identity.dev}:${identity.ino}`;
}

function createSandboxCleanupRecorder(
  sink: CleanupEvidenceSink | undefined,
  resource: string,
  resourceType: "sandbox" | "directory",
  ownership: "controller" | "caller" | "foreign" | "unknown",
  expectedIdentity?: FeatureSandboxDirectoryIdentity,
) {
  return createCleanupRecorder(sink, {
    resourceId: resource,
    resourceType,
    resource,
    ownership,
    phase: FEATURE_SANDBOX_CLEANUP_PHASE,
    ...(expectedIdentity === undefined
      ? {}
      : { expectedIdentity: cleanupIdentity(expectedIdentity) }),
  });
}

function unownedSandboxRuntimeRoot(workspaceRoot: string) {
  const absolute = path.resolve(workspaceRoot);
  return path.join(
    path.dirname(absolute),
    ".pipi-runtime",
    path.basename(absolute),
  );
}

function recordUnownedSandboxCleanup(
  workspaceRoot: string,
  sink: CleanupEvidenceSink | undefined,
) {
  const resource = unownedSandboxRuntimeRoot(workspaceRoot);
  const recorder = createSandboxCleanupRecorder(
    sink,
    resource,
    "sandbox",
    "unknown",
  );
  try {
    if (lstatIfPresent(resource)) {
      recorder.outcome({
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "no_controller_ownership",
        detail:
          "The runtime path exists, but this process has no cleanup ownership.",
      });
    } else {
      recorder.outcome({
        disposition: "skipped",
        operationStatus: "not_attempted",
        reasonCode: "no_controller_ownership",
        detail: "No controller-owned runtime is registered for this workspace.",
      });
    }
  } catch (error) {
    recorder.outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "unowned_runtime_observation_failed",
      detail: cleanupErrorMessage(error),
    });
  }
}

/** Remove only runtime scratch that this process created for a removed workspace. */
export function cleanupFeatureSandboxRuntime(
  workspaceRoot: string,
  sink?: CleanupEvidenceSink,
) {
  const key = cleanupWorkspaceKeys(workspaceRoot).find((candidate) =>
    ownedFeatureSandboxRuntimes.has(candidate),
  );
  if (!key) {
    recordUnownedSandboxCleanup(workspaceRoot, sink);
    return [];
  }
  const owned = ownedFeatureSandboxRuntimes.get(key);
  if (!owned) {
    recordUnownedSandboxCleanup(workspaceRoot, sink);
    return [];
  }
  const warnings: string[] = [];
  const parentRecorder = (
    ownership: "controller" | "caller" | "foreign" | "unknown" = "controller",
  ) =>
    createSandboxCleanupRecorder(
      sink,
      owned.runtimeParent,
      "directory",
      ownership,
      owned.parentIdentity,
    );
  const rootRecorder = (
    ownership: "controller" | "caller" | "foreign" | "unknown" = "controller",
  ) =>
    createSandboxCleanupRecorder(
      sink,
      owned.runtimeRoot,
      "sandbox",
      ownership,
      owned.rootIdentity,
    );

  let workspace: fs.Stats | undefined;
  try {
    workspace = lstatIfPresent(owned.workspaceRoot);
  } catch (error) {
    rootRecorder().outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "workspace_observation_failed",
      detail: cleanupErrorMessage(error),
    });
    warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
    return warnings;
  }
  if (workspace) {
    rootRecorder().outcome({
      disposition: "retained",
      operationStatus: "not_attempted",
      reasonCode: "workspace_still_present",
      detail:
        "The assigned workspace is still present; runtime cleanup is deferred.",
    });
    return warnings;
  }

  let parent: fs.Stats | undefined;
  try {
    parent = lstatIfPresent(owned.runtimeParent);
  } catch (error) {
    parentRecorder().outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_parent_observation_failed",
      detail: cleanupErrorMessage(error),
    });
    warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
    return warnings;
  }
  if (!parent) {
    parentRecorder().outcome({
      disposition: "skipped",
      operationStatus: "not_attempted",
      reasonCode: "runtime_parent_absent",
      detail:
        "The runtime parent was already absent; no removal was attempted.",
    });
    ownedFeatureSandboxRuntimes.delete(key);
    return warnings;
  }
  try {
    if (comparableExistingPath(owned.runtimeParent) !== owned.runtimeParent) {
      parentRecorder("foreign").outcome({
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "runtime_parent_ancestry_redirected",
        detail: "The runtime ancestry was redirected; refusing to remove it.",
      });
      warnings.push(
        cleanupWarning(
          owned,
          "the runtime ancestry was redirected; refusing to remove it",
        ),
      );
      return warnings;
    }
  } catch (error) {
    parentRecorder("unknown").outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_parent_canonicalization_failed",
      detail: cleanupErrorMessage(error),
    });
    warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
    return warnings;
  }
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    parentRecorder("foreign").outcome({
      disposition: "retained",
      operationStatus: "not_attempted",
      reasonCode: "runtime_parent_invalid_type",
      detail:
        "The runtime parent is not a non-symlink directory; refusing to remove it.",
    });
    warnings.push(
      cleanupWarning(
        owned,
        "the runtime parent is not a non-symlink directory; refusing to remove it",
      ),
    );
    return warnings;
  }
  if (
    !sameRuntimeDirectory(
      runtimeDirectoryIdentity(parent),
      owned.parentIdentity,
    )
  ) {
    parentRecorder("foreign").outcome({
      disposition: "retained",
      operationStatus: "not_attempted",
      reasonCode: "runtime_parent_identity_mismatch",
      detail: "The runtime parent identity changed; refusing to remove it.",
    });
    warnings.push(
      cleanupWarning(
        owned,
        "the runtime parent identity changed; refusing to remove it",
      ),
    );
    return warnings;
  }
  if (
    owned.runtimeParent === owned.workspaceRoot ||
    isWithin(owned.runtimeParent, owned.workspaceRoot) ||
    isWithin(owned.workspaceRoot, owned.runtimeParent) ||
    path.dirname(owned.runtimeRoot) !== owned.runtimeParent
  ) {
    parentRecorder("unknown").outcome({
      disposition: "retained",
      operationStatus: "not_attempted",
      reasonCode: "unsafe_runtime_path",
      detail:
        "The recorded runtime path is not safely separate from the workspace.",
    });
    warnings.push(
      cleanupWarning(
        owned,
        "the recorded runtime path is not safely separate from the workspace",
      ),
    );
    return warnings;
  }

  let runtimeRoot: fs.Stats | undefined;
  try {
    runtimeRoot = lstatIfPresent(owned.runtimeRoot);
  } catch (error) {
    rootRecorder().outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_root_observation_failed",
      detail: cleanupErrorMessage(error),
    });
    warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
    return warnings;
  }
  if (runtimeRoot) {
    if (runtimeRoot.isSymbolicLink() || !runtimeRoot.isDirectory()) {
      rootRecorder("foreign").outcome({
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "runtime_root_invalid_type",
        detail:
          "The recorded runtime root is not a non-symlink directory; refusing to remove it.",
      });
      warnings.push(
        cleanupWarning(
          owned,
          "the recorded runtime root is not a non-symlink directory; refusing to remove it",
        ),
      );
      return warnings;
    }
    if (
      !sameRuntimeDirectory(
        runtimeDirectoryIdentity(runtimeRoot),
        owned.rootIdentity,
      )
    ) {
      rootRecorder("foreign").outcome({
        disposition: "retained",
        operationStatus: "not_attempted",
        reasonCode: "runtime_root_identity_mismatch",
        detail: "The runtime root identity changed; refusing to remove it.",
      });
      warnings.push(
        cleanupWarning(
          owned,
          "the runtime root identity changed; refusing to remove it",
        ),
      );
      return warnings;
    }
  }

  const rootRemovalRecorder = rootRecorder();
  let rootRemovalAttempted = false;
  if (runtimeRoot) {
    rootRemovalRecorder.intent();
    rootRemovalAttempted = true;
    try {
      fs.rmSync(owned.runtimeRoot, { recursive: true, force: true });
    } catch (error) {
      rootRemovalRecorder.outcome({
        disposition: "retained",
        operationStatus: "failed",
        reasonCode: "runtime_root_remove_failed",
        detail: cleanupErrorMessage(error),
      });
      warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
      return warnings;
    }
  }

  let remainingRoot: fs.Stats | undefined;
  try {
    remainingRoot = lstatIfPresent(owned.runtimeRoot);
  } catch (error) {
    rootRemovalRecorder.outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_root_verification_failed",
      detail: cleanupErrorMessage(error),
    });
    warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
    return warnings;
  }
  if (remainingRoot) {
    rootRemovalRecorder.outcome({
      disposition: "retained",
      operationStatus: rootRemovalAttempted ? "failed" : "not_attempted",
      reasonCode: "runtime_root_remained",
      detail:
        "The runtime root remained after the cleanup check; refusing to remove its parent.",
    });
    warnings.push(
      cleanupWarning(
        owned,
        "the runtime root remained after removal; refusing to remove its parent",
      ),
    );
    return warnings;
  }
  rootRemovalRecorder.outcome(
    rootRemovalAttempted
      ? {
          disposition: "removed",
          operationStatus: "succeeded",
          reasonCode: "runtime_root_removed",
        }
      : {
          disposition: "skipped",
          operationStatus: "not_attempted",
          reasonCode: "runtime_root_absent",
          detail:
            "The runtime root was already absent; no removal was attempted.",
        },
  );

  let currentParent: fs.Stats | undefined;
  try {
    currentParent = lstatIfPresent(owned.runtimeParent);
  } catch (error) {
    parentRecorder().outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_parent_observation_failed",
      detail: cleanupErrorMessage(error),
    });
    warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
    return warnings;
  }
  if (!currentParent) {
    parentRecorder().outcome({
      disposition: "skipped",
      operationStatus: "not_attempted",
      reasonCode: "runtime_parent_absent",
      detail:
        "The runtime parent was already absent; no removal was attempted.",
    });
    ownedFeatureSandboxRuntimes.delete(key);
    return warnings;
  }
  if (
    currentParent.isSymbolicLink() ||
    !currentParent.isDirectory() ||
    !sameRuntimeDirectory(
      runtimeDirectoryIdentity(currentParent),
      owned.parentIdentity,
    )
  ) {
    parentRecorder("foreign").outcome({
      disposition: "retained",
      operationStatus: "not_attempted",
      reasonCode: "runtime_parent_changed_during_removal",
      detail:
        "The runtime parent changed during removal; refusing to remove it.",
    });
    warnings.push(
      cleanupWarning(
        owned,
        "the runtime parent changed during removal; refusing to remove it",
      ),
    );
    return warnings;
  }

  const parentRemovalRecorder = parentRecorder();
  parentRemovalRecorder.intent();
  try {
    fs.rmdirSync(owned.runtimeParent);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      parentRemovalRecorder.outcome({
        disposition: "retained",
        operationStatus: "failed",
        reasonCode: "runtime_parent_remove_failed",
        detail: cleanupErrorMessage(error),
      });
      warnings.push(cleanupWarning(owned, cleanupErrorMessage(error)));
      ownedFeatureSandboxRuntimes.delete(key);
      return warnings;
    }
    let remainingParent: fs.Stats | undefined;
    try {
      remainingParent = lstatIfPresent(owned.runtimeParent);
    } catch (verificationError) {
      parentRemovalRecorder.outcome({
        disposition: "retained",
        operationStatus: "failed",
        reasonCode: "runtime_parent_verification_failed",
        detail: cleanupErrorMessage(verificationError),
      });
      ownedFeatureSandboxRuntimes.delete(key);
      return warnings;
    }
    parentRemovalRecorder.outcome(
      remainingParent
        ? {
            disposition: "retained",
            operationStatus: "failed",
            reasonCode:
              code === "ENOTEMPTY" || code === "EEXIST"
                ? "runtime_parent_nonempty"
                : "runtime_parent_remove_failed",
            detail: cleanupErrorMessage(error),
          }
        : {
            disposition: "skipped",
            operationStatus: "failed",
            reasonCode: "runtime_parent_already_absent",
            detail: cleanupErrorMessage(error),
          },
    );
    ownedFeatureSandboxRuntimes.delete(key);
    return warnings;
  }

  let remainingParent: fs.Stats | undefined;
  try {
    remainingParent = lstatIfPresent(owned.runtimeParent);
  } catch (error) {
    parentRemovalRecorder.outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_parent_verification_failed",
      detail: cleanupErrorMessage(error),
    });
    ownedFeatureSandboxRuntimes.delete(key);
    return warnings;
  }
  if (remainingParent) {
    parentRemovalRecorder.outcome({
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "runtime_parent_remained",
      detail: "The runtime parent remained after removal.",
    });
    ownedFeatureSandboxRuntimes.delete(key);
    return warnings;
  }
  parentRemovalRecorder.outcome({
    disposition: "removed",
    operationStatus: "succeeded",
    reasonCode: "runtime_parent_removed",
  });
  ownedFeatureSandboxRuntimes.delete(key);
  return warnings;
}

function sandboxCommandArguments(
  command: string,
  mode: FeatureSandboxMode,
  tempRoot: string,
  cwd: string,
  runtime: FeatureRuntimeDirectories,
  executionCwd = cwd,
  resources: SkillResources = [],
) {
  assertFeatureRuntimeDirectories(runtime);
  const roots = visibleRoots(mode, tempRoot, cwd);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    tempRoot,
  ];
  for (const root of roots) {
    args.push("--dir", root);
    args.push(mode === "selection" ? "--ro-bind" : "--bind", root, root);
  }
  const gitDir = commonGitDir(tempRoot, cwd);
  if (gitDir) args.push("--tmpfs", gitDir);
  args.push("--dir", runtime.root);
  args.push("--bind", runtime.root, runtime.root);
  args.push("--setenv", "TMPDIR", runtime.temp);
  args.push("--setenv", "TMP", runtime.temp);
  args.push("--setenv", "TEMP", runtime.temp);
  args.push("--setenv", "XDG_CACHE_HOME", runtime.cache);
  for (const root of roots) {
    for (const name of [".git", ".pi-subagents", ".pipi"]) {
      const protectedPath = path.join(root, name);
      if (fs.existsSync(protectedPath))
        args.push("--ro-bind", protectedPath, protectedPath);
    }
  }
  // Restore loaded packages even when tempRoot masked their paths. These
  // bindings also override writable workspace mounts. Keep original paths
  // so scripts can locate resources relative to their package directory.
  const exposedDirectories = [...roots];
  // Canonical targets first; aliases may resolve through another package.
  for (const { source, directory } of resources) {
    args.push("--ro-bind", source, source);
    if (directory) exposedDirectories.push(source);
  }
  for (const { source, destination, directory } of resources) {
    if (source === destination) continue;
    // Existing symlinks must be followed, not used as bind destinations.
    // Only recreate aliases erased by the controller's tempRoot mount.
    if (
      isWithin(destination, tempRoot) &&
      !exposedDirectories.some((root) => isWithin(destination, root))
    ) {
      args.push("--ro-bind", source, destination);
      if (directory) exposedDirectories.push(destination);
    }
  }
  args.push("--chdir", executionCwd, "--", "/bin/bash", "-lc", command);
  return args;
}

export function createFeatureToolBoundary(options: {
  readonly cwd: string;
  readonly mode: "candidate" | "selection";
  readonly skills?: ReadonlyArray<Pick<Skill, "baseDir" | "filePath">>;
}) {
  let resources = skillResources(options.skills ?? []);
  const cwd = comparableExistingPath(options.cwd);
  const tempRoot = comparableExistingPath(path.dirname(cwd));
  const runtime = createFeatureRuntimeDirectories(tempRoot, cwd);
  let mode: FeatureSandboxMode = options.mode;
  const localBash = createLocalBashOperations();
  const bashOperations: BashOperations = {
    async exec(command, _requestedCwd, execution) {
      const result = await localBash.exec(
        `/usr/bin/bwrap ${sandboxCommandArguments(command, mode, tempRoot, cwd, runtime, cwd, resources).map(shellQuote).join(" ")}`,
        "/",
        execution,
      );
      return result;
    },
  };
  const readOperations: ReadOperations = {
    async readFile(absolutePath) {
      const allowed = assertAllowedPath(
        absolutePath,
        visibleRoots(mode, tempRoot, cwd),
        "read",
        resources,
      );
      return fs.promises.readFile(allowed);
    },
    async access(absolutePath) {
      const allowed = assertAllowedPath(
        absolutePath,
        visibleRoots(mode, tempRoot, cwd),
        "read",
        resources,
      );
      await fs.promises.access(allowed, fs.constants.R_OK);
    },
  };
  const editOperations: EditOperations = {
    async readFile(absolutePath) {
      const allowed = assertAllowedPath(
        absolutePath,
        [cwd],
        "write",
        resources,
      );
      return fs.promises.readFile(allowed);
    },
    async writeFile(absolutePath, content) {
      if (mode === "selection") {
        throw new Error(
          "Selection phase is read-only until primary validation.",
        );
      }
      const allowed = assertAllowedPath(
        absolutePath,
        [cwd],
        "write",
        resources,
      );
      await fs.promises.writeFile(allowed, content);
    },
    async access(absolutePath) {
      const allowed = assertAllowedPath(
        absolutePath,
        [cwd],
        "write",
        resources,
      );
      await fs.promises.access(allowed, fs.constants.R_OK | fs.constants.W_OK);
    },
  };
  const writeOperations: WriteOperations = {
    async writeFile(absolutePath, content) {
      if (mode === "selection") {
        throw new Error(
          "Selection phase is read-only until primary validation.",
        );
      }
      const allowed = assertAllowedPath(
        absolutePath,
        [cwd],
        "write",
        resources,
      );
      await fs.promises.writeFile(allowed, content);
    },
    async mkdir(directory) {
      if (mode === "selection") {
        throw new Error(
          "Selection phase is read-only until primary validation.",
        );
      }
      const allowed = assertAllowedPath(directory, [cwd], "write", resources);
      await fs.promises.mkdir(allowed, { recursive: true });
    },
  };
  const tools = [
    defineTool(
      createReadToolDefinition(cwd, {
        operations: readOperations,
        autoResizeImages: false,
      }),
    ),
    defineTool(
      createBashToolDefinition(cwd, {
        operations: bashOperations,
        exposeSessionEnvironment: false,
      }),
    ),
    defineTool(createEditToolDefinition(cwd, { operations: editOperations })),
    defineTool(createWriteToolDefinition(cwd, { operations: writeOperations })),
  ];
  return {
    tools,
    availableToolNames: [
      "read",
      "bash",
      "edit",
      "write",
      "pipeline_feature_commit",
    ],
    initialActiveTools:
      options.mode === "selection"
        ? ["read", "bash"]
        : ["read", "bash", "edit", "write", "pipeline_feature_commit"],
    setSkills(skills) {
      resources = skillResources(skills);
    },
    enableAugmentation() {
      if (options.mode !== "selection") return;
      mode = "augmentation";
    },
  } satisfies FeatureToolBoundary;
}

/** Run an accepted graph check or caller-supplied preparation in its assigned workspace. */
export async function runFeatureSandboxCommand(options: {
  workspaceRoot: string;
  cwd: string;
  command: string;
  signal?: AbortSignal;
}) {
  if (options.signal?.aborted) throw new Error("Feature command cancelled.");
  const workspaceRoot = comparableExistingPath(options.workspaceRoot);
  const cwd = comparableExistingPath(path.resolve(workspaceRoot, options.cwd));
  if (!isWithin(cwd, workspaceRoot) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(
      "Feature check cwd must remain inside its assigned worktree.",
    );
  }
  const tempRoot = comparableExistingPath(path.dirname(workspaceRoot));
  const runtime = createFeatureRuntimeDirectories(tempRoot, workspaceRoot);
  const args = sandboxCommandArguments(
    options.command,
    "candidate",
    tempRoot,
    workspaceRoot,
    runtime,
    cwd,
  );
  const maxBytes = 256 * 1024;
  return new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", args, {
      cwd: "/",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutTruncated ||= stdout.length + chunk.length > maxBytes;
      stdout = Buffer.concat([
        stdout,
        chunk.subarray(0, Math.max(0, maxBytes - stdout.length)),
      ]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTruncated ||= stderr.length + chunk.length > maxBytes;
      stderr = Buffer.concat([
        stderr,
        chunk.subarray(0, Math.max(0, maxBytes - stderr.length)),
      ]);
    });
    const cancel = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.once("error", (error) => {
      options.signal?.removeEventListener("abort", cancel);
      reject(error);
    });
    child.once("close", (exitCode) => {
      options.signal?.removeEventListener("abort", cancel);
      const marker = "\n[Output truncated.]";
      resolve({
        exitCode,
        stdout: stdout.toString("utf8") + (stdoutTruncated ? marker : ""),
        stderr: stderr.toString("utf8") + (stderrTruncated ? marker : ""),
      });
    });
  });
}
