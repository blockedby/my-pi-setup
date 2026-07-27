import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureIsolatedNpmPackage,
  installDependencies,
} from "./install-dependencies.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const managedLauncherMarker = "# Managed by pipi-alias installer.";
const mcpAdapterVersion = "2.15.0";
const mcpAdapterPackage = `npm:pi-mcp-adapter@${mcpAdapterVersion}`;
const mcpAdapterPackagePrefix = "npm:pi-mcp-adapter";
const modelDefaults = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
];

const usage = `Usage: node scripts/install.mjs [options]

Options:
  --pi PATH             Pi executable to launch (default: pi from PATH)
  --codex-tools PATH    Local pi-codex-tools package (default: ../pi-codex)
  --bin-dir PATH        Launcher directory (default: ~/.local/bin)
  --share-auth          Symlink regular Pi auth into Pipi (opt-in)
  --skip-dependencies   Skip npm dependency installation
  --help                Show this help
`;

const parseArgs = (args) => {
  const options = {
    pi: undefined,
    codexTools: resolve(repositoryRoot, "..", "pi-codex"),
    binDir: undefined,
    shareAuth: false,
    skipDependencies: false,
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

const pinMcpAdapterPackage = (packages) => {
  const matchingIndexes = packages.flatMap((entry, index) => {
    const source = packageSource(entry);
    return source === mcpAdapterPackagePrefix ||
      source?.startsWith(`${mcpAdapterPackagePrefix}@`)
      ? [index]
      : [];
  });
  if (matchingIndexes.length === 0) {
    packages.push(mcpAdapterPackage);
    return;
  }

  const firstIndex = matchingIndexes[0];
  const firstEntry = packages[firstIndex];
  packages[firstIndex] =
    typeof firstEntry === "string"
      ? mcpAdapterPackage
      : { ...firstEntry, source: mcpAdapterPackage };
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
  const piExecutable = findExecutable(
    options.pi ?? "pi",
    options.pi ? [] : [join(repositoryRoot, "node_modules", ".bin")],
  );
  if (!piExecutable)
    throw new Error(
      `Pi executable is not executable or was not found: ${options.pi ?? "pi"}`,
    );

  const codexExecutable = findExecutable("codex");
  const agentDir = join(home, ".pipi", "agent");
  const sessionDir = join(home, ".pipi", "sessions");
  const binDir = options.binDir ?? join(home, ".local", "bin");
  const launcherPath = join(binDir, "pipi");
  const pipiSettingsPath = join(agentDir, "settings.json");
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
  pinMcpAdapterPackage(packages);

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
  if (!options.skipDependencies) installDependencies();

  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  mkdirSync(binDir, { recursive: true });
  if (!options.skipDependencies) {
    ensureIsolatedNpmPackage({
      prefix: join(agentDir, "npm"),
      packageName: "pi-mcp-adapter",
      packageSpec: `pi-mcp-adapter@${mcpAdapterVersion}`,
      expectedVersion: mcpAdapterVersion,
    });
  }
  writeJson(pipiSettingsPath, nextSettings);

  if (options.shareAuth && !existsSync(pipiAuthPath)) {
    symlinkSync(regularAuthPath, pipiAuthPath);
  }

  const launcher = `#!/bin/sh\n${managedLauncherMarker}\nexport PI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexport PI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}\nexec ${shellQuote(piExecutable)} "$@"\n`;
  writeFileSync(launcherPath, launcher, { mode: 0o755 });
  chmodSync(launcherPath, 0o755);

  console.log(`Installed Pipi launcher: ${launcherPath}`);
  console.log(`Pipi settings: ${pipiSettingsPath}`);
  console.log(`Pipi sessions: ${sessionDir}`);
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
