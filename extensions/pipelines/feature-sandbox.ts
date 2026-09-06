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

interface FeatureRuntimeDirectories {
  readonly root: string;
  readonly temp: string;
  readonly cache: string;
}

function createFeatureRuntimeDirectories(tempRoot: string, cwd: string) {
  const root = path.join(tempRoot, ".pipi-runtime", path.basename(cwd));
  const directories = {
    root,
    temp: path.join(root, "tmp"),
    cache: path.join(root, "cache"),
  } satisfies FeatureRuntimeDirectories;
  fs.mkdirSync(directories.temp, { recursive: true });
  fs.mkdirSync(directories.cache, { recursive: true });
  return directories;
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
