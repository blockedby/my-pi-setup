import { execFileSync } from "node:child_process";
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
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

export type FeatureSandboxMode = "candidate" | "selection" | "augmentation";

export interface FeatureToolBoundary {
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly availableToolNames: ReadonlyArray<string>;
  readonly initialActiveTools: ReadonlyArray<string>;
  enableAugmentation(): void;
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

function assertAllowedPath(
  value: string,
  roots: ReadonlyArray<string>,
  operation: "read" | "write",
) {
  const resolvedRoots = roots.map(comparableExistingPath);
  const resolved =
    operation === "read" || fs.existsSync(value)
      ? comparableExistingPath(value)
      : nearestExisting(value);
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

function sandboxCommand(
  command: string,
  mode: FeatureSandboxMode,
  tempRoot: string,
  cwd: string,
  runtime: FeatureRuntimeDirectories,
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
  args.push("--chdir", cwd, "--", "/bin/bash", "-lc", command);
  return `/usr/bin/bwrap ${args.map(shellQuote).join(" ")}`;
}

export function createFeatureToolBoundary(options: {
  readonly cwd: string;
  readonly mode: "candidate" | "selection";
}) {
  const cwd = comparableExistingPath(options.cwd);
  const tempRoot = comparableExistingPath(path.dirname(cwd));
  const runtime = createFeatureRuntimeDirectories(tempRoot, cwd);
  let mode: FeatureSandboxMode = options.mode;
  const localBash = createLocalBashOperations();
  const bashOperations: BashOperations = {
    async exec(command, _requestedCwd, execution) {
      const result = await localBash.exec(
        sandboxCommand(command, mode, tempRoot, cwd, runtime),
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
      );
      return fs.promises.readFile(allowed);
    },
    async access(absolutePath) {
      const allowed = assertAllowedPath(
        absolutePath,
        visibleRoots(mode, tempRoot, cwd),
        "read",
      );
      await fs.promises.access(allowed, fs.constants.R_OK);
    },
  };
  const editOperations: EditOperations = {
    async readFile(absolutePath) {
      const allowed = assertAllowedPath(absolutePath, [cwd], "write");
      return fs.promises.readFile(allowed);
    },
    async writeFile(absolutePath, content) {
      if (mode === "selection") {
        throw new Error(
          "Selection phase is read-only until primary validation.",
        );
      }
      const allowed = assertAllowedPath(absolutePath, [cwd], "write");
      await fs.promises.writeFile(allowed, content);
    },
    async access(absolutePath) {
      const allowed = assertAllowedPath(absolutePath, [cwd], "write");
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
      const allowed = assertAllowedPath(absolutePath, [cwd], "write");
      await fs.promises.writeFile(allowed, content);
    },
    async mkdir(directory) {
      if (mode === "selection") {
        throw new Error(
          "Selection phase is read-only until primary validation.",
        );
      }
      const allowed = assertAllowedPath(directory, [cwd], "write");
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
    enableAugmentation() {
      if (options.mode !== "selection") return;
      mode = "augmentation";
    },
  } satisfies FeatureToolBoundary;
}
