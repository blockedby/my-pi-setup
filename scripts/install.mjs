import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureIsolatedNpmPackage,
  ensureIsolatedNpmPolicy,
  ensureIsolatedPiBranding,
  installDependencies,
} from "./install-dependencies.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeManifest = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const runtimePiSpec =
  runtimeManifest.dependencies?.["@earendil-works/pi-coding-agent"];
const runtimePiVersion =
  typeof runtimePiSpec === "string"
    ? runtimePiSpec.match(/^\^?(\d+\.\d+\.\d+)$/)?.[1]
    : undefined;
if (!runtimePiVersion)
  throw new Error(
    "package.json must declare @earendil-works/pi-coding-agent with an exact semver or caret range.",
  );
const runtimePiPackage = `@earendil-works/pi-coding-agent@${runtimePiVersion}`;
const isolatedAllowedInstallScripts = [
  "@google/genai@1.52.0",
  "protobufjs@7.6.5",
];
const managedLauncherMarker = "# Managed by pipi-alias installer.";
const mcpAdapterVersion = "2.15.0";
const mcpAdapterPackage = `npm:pi-mcp-adapter@${mcpAdapterVersion}`;
const mcpAdapterPackagePrefix = "npm:pi-mcp-adapter";
const removedPiSubagentsPackagePrefix = "npm:pi-subagents";
const browserAssetsRoot = join(repositoryRoot, "vendor", "pi-agent-setup");
const submoduleConfigPath = join(repositoryRoot, "config", "submodules.json");
const modelDefaults = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
];

const git = (args, cwd = repositoryRoot) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const usage = `Usage: node scripts/install.mjs [options]

Options:
  --pi PATH             Pi executable override (default: isolated version from package.json)
  --codex-tools PATH    Local pi-codex-tools package (default: ../pi-codex)
  --bin-dir PATH        Launcher directory (default: ~/.local/bin)
  --share-auth                    Symlink regular Pi auth into Pipi (opt-in)
  --skip-dependencies             Skip repository and isolated runtime dependency installation
  --skip-repository-dependencies  Skip only repository dependency installation
  --help                          Show this help
`;

const parseArgs = (args) => {
  const options = {
    pi: undefined,
    codexTools: resolve(repositoryRoot, "..", "pi-codex"),
    binDir: undefined,
    shareAuth: false,
    skipDependencies: false,
    skipRepositoryDependencies: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (argument === "--share-auth") {
      options.shareAuth = true;
      continue;
    }
    if (argument === "--skip-dependencies") {
      options.skipDependencies = true;
      continue;
    }
    if (argument === "--skip-repository-dependencies") {
      options.skipRepositoryDependencies = true;
      continue;
    }
    if (["--pi", "--codex-tools", "--bin-dir"].includes(argument)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--pi") options.pi = value;
      if (argument === "--codex-tools") options.codexTools = resolve(value);
      if (argument === "--bin-dir") options.binDir = resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
};

const findExecutable = (command, excludedDirectories = []) => {
  const excluded = new Set(excludedDirectories.map((path) => resolve(path)));
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(command)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));

  for (const candidate of candidates) {
    try {
      if (excluded.has(resolve(dirname(candidate)))) continue;
      accessSync(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
};

const readSettings = (path, requiredValidJson) => {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("settings must be a JSON object");
    }
    return value;
  } catch (error) {
    if (requiredValidJson)
      throw new Error(`Cannot read ${path}: ${error.message}`);
    console.warn(
      `Skipping model defaults from invalid regular Pi settings: ${error.message}`,
    );
    return {};
  }
};

const packageSource = (entry) =>
  typeof entry === "string" ? entry : entry?.source;

const addPackage = (packages, path) => {
  if (!packages.some((entry) => packageSource(entry) === path))
    packages.push(path);
};

const pinNpmPackage = (packages, packagePrefix, pinnedSource) => {
  const matchingIndexes = packages.flatMap((entry, index) => {
    const source = packageSource(entry);
    return source === packagePrefix || source?.startsWith(`${packagePrefix}@`)
      ? [index]
      : [];
  });
  if (matchingIndexes.length === 0) {
    packages.push(pinnedSource);
    return;
  }

  const firstIndex = matchingIndexes[0];
  const firstEntry = packages[firstIndex];
  packages[firstIndex] =
    typeof firstEntry === "string"
      ? pinnedSource
      : { ...firstEntry, source: pinnedSource };
  for (const index of matchingIndexes.slice(1).reverse())
    packages.splice(index, 1);
};

const writeJson = (path, value) => {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
};

const secureAssetTree = (directory) => {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) secureAssetTree(path);
    else chmodSync(path, entry.name.endsWith(".sh") ? 0o700 : 0o600);
  }
};

const installAssetDirectory = (source, target) => {
  if (!existsSync(source)) throw new Error(`Missing bundled asset: ${source}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, { recursive: true });
  secureAssetTree(target);
};

const removePiSubagentsAssets = (agentDir) => {
  rmSync(join(agentDir, "skills", "aad-task-package"), {
    recursive: true,
    force: true,
  });
  rmSync(join(agentDir, "agents", "chrome-browser-agent.md"), {
    force: true,
  });
  for (const packageName of ["pi-subagents", "jiti", "typebox", "yaml"]) {
    rmSync(join(agentDir, "npm", "node_modules", packageName), {
      recursive: true,
      force: true,
    });
  }
  for (const binaryName of ["pi-subagents", "jiti", "yaml"]) {
    rmSync(join(agentDir, "npm", "node_modules", ".bin", binaryName), {
      force: true,
    });
  }
};

const validateSubmoduleAssets = () => {
  let submodules;
  try {
    const config = JSON.parse(readFileSync(submoduleConfigPath, "utf8"));
    submodules = config.submodules;
  } catch (error) {
    throw new Error(
      `Cannot read submodule config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!submodules || typeof submodules !== "object")
    throw new Error(`Invalid submodule config: ${submoduleConfigPath}`);

  const assetRoots = {};
  for (const [name, submodule] of Object.entries(submodules)) {
    if (
      !submodule ||
      typeof submodule.path !== "string" ||
      typeof submodule.url !== "string" ||
      !Array.isArray(submodule.requiredFiles) ||
      submodule.requiredFiles.length === 0 ||
      submodule.requiredFiles.some((path) => typeof path !== "string" || !path)
    ) {
      throw new Error(
        `Invalid submodule config for ${name}: ${submoduleConfigPath}`,
      );
    }

    const assetsRoot = join(repositoryRoot, submodule.path);
    if (!existsSync(join(assetsRoot, ".git"))) {
      throw new Error(
        `Submodule ${name} is not initialized: ${assetsRoot}; run git submodule update --init --recursive`,
      );
    }
    for (const relativePath of submodule.requiredFiles) {
      const path = join(assetsRoot, relativePath);
      if (!existsSync(path))
        throw new Error(
          `Missing submodule ${name} asset: ${path}; run git submodule update --init --recursive`,
        );
    }

    const indexEntry = git(["ls-files", "--stage", "--", submodule.path]);
    const gitlink = indexEntry.match(/^160000 ([0-9a-f]{40}) 0\t/);
    if (!gitlink)
      throw new Error(
        `Submodule ${name} is not recorded as a parent Git gitlink`,
      );
    const pinnedCommit = gitlink[1];
    const worktreeCommit = git(["rev-parse", "HEAD"], assetsRoot);
    if (worktreeCommit !== pinnedCommit)
      throw new Error(
        `Submodule ${name} worktree is at ${worktreeCommit}, expected ${pinnedCommit}`,
      );
    if (git(["remote", "get-url", "origin"], assetsRoot) !== submodule.url)
      throw new Error(
        `Submodule ${name} origin URL does not match configured URL`,
      );
    if (git(["status", "--porcelain=v1", "--untracked-files=all"], assetsRoot))
      throw new Error(`Submodule ${name} has direct worktree changes`);

    assetRoots[name] = assetsRoot;
  }
  return assetRoots;
};

const installBrowserChromeAssets = (agentDir) => {
  const browserSkillDir = join(agentDir, "skills", "browser-chrome");
  installAssetDirectory(
    join(browserAssetsRoot, "skills", "browser-chrome"),
    browserSkillDir,
  );
  return browserSkillDir;
};

const installHerdrPiIntegration = (herdrExecutable, agentDir) => {
  if (!herdrExecutable) return undefined;

  const integrationPath = join(agentDir, "extensions", "herdr-agent-state.ts");
  try {
    execFileSync(herdrExecutable, ["integration", "install", "pi"], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Failed to install the official Herdr Pi integration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!existsSync(integrationPath)) {
    throw new Error(
      `Herdr reported a successful Pi integration install but did not create ${integrationPath}`,
    );
  }
  return integrationPath;
};

const installBrowserChromeMcp = (mcpPath, browserSkillDir) => {
  const current = readSettings(mcpPath, true);
  const existingServers = current.mcpServers ?? {};
  if (
    !existingServers ||
    typeof existingServers !== "object" ||
    Array.isArray(existingServers)
  ) {
    throw new Error(`Cannot read ${mcpPath}: mcpServers must be an object`);
  }
  const commonEnv = { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" };
  writeJson(mcpPath, {
    ...current,
    mcpServers: {
      ...existingServers,
      "browser-chrome-control": {
        command: join(browserSkillDir, "scripts", "control-mcp.sh"),
        args: [],
        lifecycle: "lazy",
      },
      "browser-chrome-headed": {
        command: join(browserSkillDir, "scripts", "mcp.sh"),
        args: ["headed"],
        lifecycle: "lazy",
        env: commonEnv,
      },
      "browser-chrome-headless": {
        command: join(browserSkillDir, "scripts", "mcp.sh"),
        args: ["headless"],
        lifecycle: "lazy",
        idleTimeout: 1,
        env: commonEnv,
      },
    },
  });
};

const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;

const validateAuthShare = (regularAuthPath, pipiAuthPath) => {
  if (!existsSync(regularAuthPath)) {
    throw new Error(
      `Cannot share auth because regular Pi auth does not exist: ${regularAuthPath}`,
    );
  }
  try {
    const stat = lstatSync(pipiAuthPath);
    if (
      !stat.isSymbolicLink() ||
      readlinkSync(pipiAuthPath) !== regularAuthPath
    ) {
      throw new Error(
        `Refusing to replace existing Pipi auth: ${pipiAuthPath}`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const install = () => {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.HOME || homedir();
  const externalPiExecutable = options.pi
    ? findExecutable(options.pi)
    : undefined;
  if (options.pi && !externalPiExecutable)
    throw new Error(
      `Pi executable is not executable or was not found: ${options.pi}`,
    );

  const codexExecutable = findExecutable("codex");
  const herdrExecutable = findExecutable("herdr");
  const agentDir = join(home, ".pipi", "agent");
  const sessionDir = join(home, ".pipi", "sessions");
  const binDir = options.binDir ?? join(home, ".local", "bin");
  const launcherPath = join(binDir, "pipi");
  const pipiSettingsPath = join(agentDir, "settings.json");
  const pipiMcpPath = join(agentDir, "mcp.json");
  const regularAgentDir = join(home, ".pi", "agent");
  const regularSettingsPath = join(regularAgentDir, "settings.json");
  const regularAuthPath = join(regularAgentDir, "auth.json");
  const pipiAuthPath = join(agentDir, "auth.json");

  if (
    existsSync(launcherPath) &&
    !readFileSync(launcherPath, "utf8").includes(managedLauncherMarker)
  ) {
    throw new Error(
      `Refusing to replace launcher not managed by this installer: ${launcherPath}`,
    );
  }

  const pipiSettings = readSettings(pipiSettingsPath, true);
  const regularSettings = readSettings(regularSettingsPath, false);
  const packages = Array.isArray(pipiSettings.packages)
    ? [...pipiSettings.packages]
    : [];
  addPackage(packages, repositoryRoot);
  pinNpmPackage(packages, mcpAdapterPackagePrefix, mcpAdapterPackage);
  for (let index = packages.length - 1; index >= 0; index -= 1) {
    const source = packageSource(packages[index]);
    if (
      source === removedPiSubagentsPackagePrefix ||
      source?.startsWith(`${removedPiSubagentsPackagePrefix}@`)
    ) {
      packages.splice(index, 1);
    }
  }

  const codexManifestPath = join(options.codexTools, "package.json");
  if (existsSync(codexManifestPath)) {
    const codexManifest = JSON.parse(readFileSync(codexManifestPath, "utf8"));
    if (codexManifest.name !== "pi-codex-tools") {
      throw new Error(`Expected pi-codex-tools at ${options.codexTools}`);
    }
    addPackage(packages, options.codexTools);
  } else {
    console.warn(
      `Local pi-codex-tools package not found; continuing without it: ${options.codexTools}`,
    );
  }

  const nextSettings = {
    ...pipiSettings,
    theme: "github-dark-default",
    packages,
  };
  for (const key of modelDefaults) {
    if (nextSettings[key] === undefined && regularSettings[key] !== undefined) {
      nextSettings[key] = regularSettings[key];
    }
  }

  if (options.shareAuth) validateAuthShare(regularAuthPath, pipiAuthPath);
  const submoduleAssets = validateSubmoduleAssets();
  const reviewerAssetsRoot = submoduleAssets["gpt5.6-reviewer"];
  const backlogSkillDir = submoduleAssets["plan-gh-backlog"];
  if (!reviewerAssetsRoot || !backlogSkillDir)
    throw new Error("Required submodule skill configuration is missing");
  const reviewerSkillDir = join(reviewerAssetsRoot, "skills", "code-review");
  if (!options.skipDependencies && !options.skipRepositoryDependencies) {
    installDependencies();
  }

  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  mkdirSync(binDir, { recursive: true });
  removePiSubagentsAssets(agentDir);
  const isolatedNpmPrefix = join(agentDir, "npm");
  ensureIsolatedNpmPolicy({
    prefix: isolatedNpmPrefix,
    allowScripts: isolatedAllowedInstallScripts,
  });
  if (!options.skipDependencies) {
    ensureIsolatedNpmPackage({
      prefix: isolatedNpmPrefix,
      packageName: "@earendil-works/pi-coding-agent",
      packageSpec: runtimePiPackage,
      expectedVersion: runtimePiVersion,
    });
    ensureIsolatedNpmPackage({
      prefix: isolatedNpmPrefix,
      packageName: "pi-mcp-adapter",
      packageSpec: `pi-mcp-adapter@${mcpAdapterVersion}`,
      expectedVersion: mcpAdapterVersion,
    });
  }
  ensureIsolatedPiBranding({ prefix: isolatedNpmPrefix, appName: "pipi" });
  const isolatedPiExecutable = join(
    isolatedNpmPrefix,
    "node_modules",
    ".bin",
    "pi",
  );
  const piExecutable =
    externalPiExecutable ??
    (!options.skipDependencies || existsSync(isolatedPiExecutable)
      ? isolatedPiExecutable
      : findExecutable("pi", [join(repositoryRoot, "node_modules", ".bin")]));
  if (!piExecutable)
    throw new Error("Pi executable is not executable or was not found: pi");
  try {
    accessSync(piExecutable, constants.X_OK);
  } catch {
    throw new Error(`Pi executable is not executable: ${piExecutable}`);
  }
  const browserSkillDir = installBrowserChromeAssets(agentDir);
  installBrowserChromeMcp(pipiMcpPath, browserSkillDir);
  writeJson(pipiSettingsPath, nextSettings);
  const herdrIntegrationPath = installHerdrPiIntegration(
    herdrExecutable,
    agentDir,
  );

  if (options.shareAuth && !existsSync(pipiAuthPath)) {
    symlinkSync(regularAuthPath, pipiAuthPath);
  }

  const launcher = `#!/bin/sh\n${managedLauncherMarker}\nexport PIPI_PROFILE=1\nexport PIPI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexport PIPI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}\nexport PI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexport PI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}\nexec ${shellQuote(piExecutable)} "$@"\n`;
  writeFileSync(launcherPath, launcher, { mode: 0o755 });
  chmodSync(launcherPath, 0o755);

  console.log(`Pipi runtime: ${runtimePiPackage}`);
  console.log(`Installed Pipi launcher: ${launcherPath}`);
  console.log(`Pipi settings: ${pipiSettingsPath}`);
  console.log(`Pipi sessions: ${sessionDir}`);
  console.log(`Browser Chrome skill: ${browserSkillDir}`);
  console.log(`Evidence-driven code-review skill: ${reviewerSkillDir}`);
  console.log(`Plan GitHub backlog skill: ${backlogSkillDir}`);
  console.log(`Browser Chrome MCP config: ${pipiMcpPath}`);
  if (herdrIntegrationPath)
    console.log(`Herdr Pi integration: ${herdrIntegrationPath}`);
  else console.log("Herdr CLI not found; skipped the optional Pi integration.");
  if (codexExecutable) console.log(`Codex CLI: ${codexExecutable}`);
  else
    console.warn(
      "Codex CLI was not found in PATH; Codex-backed tools will be unavailable until it is installed.",
    );
  if (!options.shareAuth)
    console.log(
      "Pipi auth remains isolated (use --share-auth to opt in to a symlink). ",
    );
};

try {
  install();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
