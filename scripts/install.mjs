import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findExecutable,
  resolveBunRuntime,
} from "../extensions/shared/executable-runtime.ts";
import {
  isolatedRuntimeSource,
  prepareIsolatedBunRuntime,
  prepareRepositoryDependencies,
} from "./install-dependencies.mjs";
import {
  acquireInstallLock,
  createManagedInstallTransaction,
  writeExecutable,
} from "./install-state.mjs";

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
const managedLauncherMarker = "# Managed by pipi-alias installer.";
const mcpAdapterVersion = "2.15.0";
const legacyMcpAdapterPackagePrefix = "npm:pi-mcp-adapter";
const removedPiSubagentsPackagePrefix = "npm:pi-subagents";
const browserMcpPackage = "chrome-devtools-mcp@1.8.0";
const isolatedRuntimeManifest = JSON.parse(
  readFileSync(join(isolatedRuntimeSource, "package.json"), "utf8"),
);
if (
  isolatedRuntimeManifest.dependencies?.["@earendil-works/pi-coding-agent"] !==
    runtimePiVersion ||
  isolatedRuntimeManifest.dependencies?.["pi-mcp-adapter"] !==
    mcpAdapterVersion ||
  isolatedRuntimeManifest.dependencies?.["chrome-devtools-mcp"] !== "1.8.0"
) {
  throw new Error(
    "config/pipi-runtime/package.json is not aligned with the installer package pins.",
  );
}
const browserAssetsRoot = join(repositoryRoot, "vendor", "pi-agent-setup");
const codexToolsSubmoduleRoot = join(repositoryRoot, "vendor", "pi-codex");
const legacyCodexToolsSiblingRoot = resolve(repositoryRoot, "..", "pi-codex");
const submoduleConfigPath = join(repositoryRoot, "config", "submodules.json");
const modelOverridesSource = join(
  repositoryRoot,
  "config",
  "pipi-model-overrides.json",
);
const modelDefaults = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
];

const git = (args, cwd = repositoryRoot) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const usage = `Usage: bun scripts/install.mjs [options]

Options:
  --bun PATH            Bun runtime override (default: PIPI_BUN_RUNTIME or PATH)
  --pi PATH             Pi JavaScript executable override (default: isolated version from package.json)
  --codex-tools PATH    Local pi-codex-tools override (default: pinned vendor/pi-codex submodule)
  --bin-dir PATH        Launcher directory (default: ~/.local/bin)
  --share-auth                    Symlink regular Pi auth into Pipi (opt-in)
  --skip-repository-dependencies  Skip only the root workspace install; isolated runtime installation remains required
  --help                          Show this help
`;

const parseArgs = (args) => {
  const options = {
    bun: undefined,
    pi: undefined,
    codexTools: codexToolsSubmoduleRoot,
    binDir: undefined,
    shareAuth: false,
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
      throw new Error(
        "--skip-dependencies is unsupported; run the normal frozen Bun installation instead: bun run install:pipi",
      );
    }
    if (argument === "--skip-repository-dependencies") {
      options.skipRepositoryDependencies = true;
      continue;
    }
    if (["--bun", "--pi", "--codex-tools", "--bin-dir"].includes(argument)) {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      index += 1;
      if (argument === "--bun") options.bun = value;
      if (argument === "--pi") options.pi = value;
      if (argument === "--codex-tools") options.codexTools = resolve(value);
      if (argument === "--bin-dir") options.binDir = resolve(value);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
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

const resolveSettingsPackagePath = (source, settingsBaseDir, home) => {
  if (source === "~") return home;
  if (source.startsWith("~/")) return resolve(home, source.slice(2));
  return resolve(settingsBaseDir, source);
};

export const normalizeCodexToolsPackage = ({
  packages,
  desiredPath,
  settingsBaseDir,
  home,
  legacyPath = legacyCodexToolsSiblingRoot,
}) => {
  const normalizedDesiredPath = resolve(desiredPath);
  const normalizedLegacyPath = resolve(legacyPath);
  const normalizedPackages = [];
  let selectedPackageAdded = false;

  for (const entry of packages) {
    const source = packageSource(entry);
    if (typeof source !== "string" || source.startsWith("npm:")) {
      normalizedPackages.push(entry);
      continue;
    }

    const resolvedSource = resolveSettingsPackagePath(
      source,
      settingsBaseDir,
      home,
    );
    if (resolvedSource === normalizedDesiredPath) {
      if (!selectedPackageAdded) {
        normalizedPackages.push(
          typeof entry === "string"
            ? normalizedDesiredPath
            : { ...entry, source: normalizedDesiredPath },
        );
        selectedPackageAdded = true;
      }
      continue;
    }
    if (resolvedSource === normalizedLegacyPath) continue;

    try {
      const manifest = JSON.parse(
        readFileSync(join(resolvedSource, "package.json"), "utf8"),
      );
      if (manifest.name === "pi-codex-tools") continue;
    } catch {
      // Preserve unavailable entries unless they match the known legacy path.
    }
    normalizedPackages.push(entry);
  }

  if (!selectedPackageAdded) normalizedPackages.push(normalizedDesiredPath);
  return normalizedPackages;
};

const pinLocalPackage = (packages, legacyPrefix, pinnedSource) => {
  const matchingIndexes = packages.flatMap((entry, index) => {
    const source = packageSource(entry);
    return source === pinnedSource ||
      source === legacyPrefix ||
      source?.startsWith(`${legacyPrefix}@`)
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

const pathLexists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

export const installAssetDirectory = (
  source,
  target,
  { beforeActivation = () => {} } = {},
) => {
  if (!existsSync(source)) throw new Error(`Missing bundled asset: ${source}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(`${target}.stage-`);
  const backup = `${target}.rollback-${process.pid}`;
  let previousBackupDirectory;
  let previousBackup;
  let targetMoved = false;
  const restorePreviousBackup = () => {
    if (previousBackup && pathLexists(previousBackup)) {
      if (pathLexists(backup)) rmSync(backup, { recursive: true, force: true });
      renameSync(previousBackup, backup);
    }
    if (previousBackupDirectory && pathLexists(previousBackupDirectory)) {
      rmSync(previousBackupDirectory, { recursive: true, force: true });
    }
  };
  try {
    cpSync(source, stage, { recursive: true });
    secureAssetTree(stage);
    if (pathLexists(backup)) {
      previousBackupDirectory = mkdtempSync(`${backup}.prior-`);
      previousBackup = join(previousBackupDirectory, "entry");
      renameSync(backup, previousBackup);
    }
    if (pathLexists(target)) {
      renameSync(target, backup);
      targetMoved = true;
    }
    beforeActivation({ backup, stage, target });
    renameSync(stage, target);
  } catch (error) {
    if (pathLexists(stage)) rmSync(stage, { recursive: true, force: true });
    if (targetMoved && !pathLexists(target) && pathLexists(backup)) {
      renameSync(backup, target);
    }
    restorePreviousBackup();
    throw error;
  }
  return {
    commit: () => {
      if (pathLexists(backup)) rmSync(backup, { recursive: true, force: true });
      if (previousBackupDirectory && pathLexists(previousBackupDirectory)) {
        rmSync(previousBackupDirectory, { recursive: true, force: true });
      }
    },
    rollback: () => {
      if (pathLexists(target)) rmSync(target, { recursive: true, force: true });
      if (targetMoved && pathLexists(backup)) renameSync(backup, target);
      restorePreviousBackup();
    },
  };
};

const removePiSubagentsAssets = (agentDir) => {
  rmSync(join(agentDir, "skills", "aad-task-package"), {
    recursive: true,
    force: true,
  });
  rmSync(join(agentDir, "agents", "chrome-browser-agent.md"), {
    force: true,
  });
  rmSync(join(agentDir, "npm"), { recursive: true, force: true });
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
    if (submodule.piPackageName !== undefined) {
      const packageManifest = JSON.parse(
        readFileSync(join(assetsRoot, "package.json"), "utf8"),
      );
      if (packageManifest.name !== submodule.piPackageName)
        throw new Error(
          `Submodule ${name} package name is ${packageManifest.name ?? "missing"}; expected ${submodule.piPackageName}`,
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

const validateManagedInstallSources = () => {
  for (const path of [
    modelOverridesSource,
    join(browserAssetsRoot, "skills", "browser-chrome", "SKILL.md"),
    join(browserAssetsRoot, "skills", "browser-chrome", "README.md"),
    join(browserAssetsRoot, "skills", "browser-chrome", "scripts", "mcp.sh"),
    join(
      browserAssetsRoot,
      "skills",
      "browser-chrome",
      "scripts",
      "install-local.sh",
    ),
    join(
      browserAssetsRoot,
      "skills",
      "browser-chrome",
      "scripts",
      "control-mcp.sh",
    ),
    join(
      browserAssetsRoot,
      "skills",
      "browser-chrome",
      "references",
      "mcp-config.md",
    ),
  ]) {
    if (!existsSync(path))
      throw new Error(`Missing managed install source: ${path}`);
  }
};

const installBrowserChromeAssets = (agentDir) => {
  const browserSkillDir = join(agentDir, "skills", "browser-chrome");
  const transaction = installAssetDirectory(
    join(browserAssetsRoot, "skills", "browser-chrome"),
    browserSkillDir,
  );
  return { browserSkillDir, transaction };
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

const installBrowserBunWrapper = ({
  stagedAgentDir,
  finalAgentDir,
  bunExecutable,
}) => {
  const stagedWrapperPath = join(stagedAgentDir, "bin", "pipi-browser-bun");
  const finalWrapperPath = join(finalAgentDir, "bin", "pipi-browser-bun");
  const browserEntry = join(
    finalAgentDir,
    "runtime",
    "node_modules",
    ".bin",
    "chrome-devtools-mcp",
  );
  writeExecutable(
    stagedWrapperPath,
    `#!/bin/sh
# Managed by pipi-alias installer. Uses only the pinned isolated Bun runtime.
set -eu
export CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
recorded_bun=${shellQuote(bunExecutable)}
if [ "\${PIPI_BUN_RUNTIME+x}" = x ] && [ "$PIPI_BUN_RUNTIME" != "$recorded_bun" ]; then
  echo "PIPI_BUN_RUNTIME must match the recorded Pipi Bun runtime: $recorded_bun" >&2
  exit 2
fi
if [ "\${BROWSER_CHROME_NPX+x}" = x ] && [ "$BROWSER_CHROME_NPX" != ${shellQuote(finalWrapperPath)} ]; then
  echo "BROWSER_CHROME_NPX must match the managed Pipi browser wrapper: ${finalWrapperPath}" >&2
  exit 2
fi
if [ "\${BROWSER_CHROME_MCP_PACKAGE+x}" = x ] && [ "$BROWSER_CHROME_MCP_PACKAGE" != ${shellQuote(browserMcpPackage)} ]; then
  echo "BROWSER_CHROME_MCP_PACKAGE must be ${browserMcpPackage}" >&2
  exit 2
fi
if [ "\${1:-}" = "-y" ]; then shift; fi
package="\${1:?${browserMcpPackage} package argument is required}"
shift
if [ "$package" != ${shellQuote(browserMcpPackage)} ]; then
  echo "Expected pinned ${browserMcpPackage}, received $package" >&2
  exit 2
fi
if [ ! -x "$recorded_bun" ]; then
  echo "Recorded Pipi Bun runtime is not executable: $recorded_bun" >&2
  exit 127
fi
if [ ! -f ${shellQuote(browserEntry)} ]; then
  echo "Pinned chrome-devtools-mcp entrypoint is missing: ${browserEntry}" >&2
  exit 127
fi
exec "$recorded_bun" ${shellQuote(browserEntry)} "$@"
`,
  );
  return finalWrapperPath;
};

const hardenInstalledBrowserSkill = ({
  stagedBrowserSkillDir,
  finalBrowserSkillDir,
  finalAgentDir,
  bunExecutable,
  bunVersion,
  browserBunWrapper,
}) => {
  const stagedScripts = join(stagedBrowserSkillDir, "scripts");
  const finalScripts = join(finalBrowserSkillDir, "scripts");
  const validateOverrides = `
if [ "\${PIPI_BUN_RUNTIME+x}" = x ] && [ "$PIPI_BUN_RUNTIME" != ${shellQuote(bunExecutable)} ]; then
  echo "PIPI_BUN_RUNTIME must match the recorded Pipi Bun runtime: ${bunExecutable}" >&2
  exit 2
fi
if [ "\${BROWSER_CHROME_NPX+x}" = x ] && [ "$BROWSER_CHROME_NPX" != ${shellQuote(browserBunWrapper)} ]; then
  echo "BROWSER_CHROME_NPX must match the managed Pipi browser wrapper: ${browserBunWrapper}" >&2
  exit 2
fi
if [ "\${BROWSER_CHROME_MCP_PACKAGE+x}" = x ] && [ "$BROWSER_CHROME_MCP_PACKAGE" != ${shellQuote(browserMcpPackage)} ]; then
  echo "BROWSER_CHROME_MCP_PACKAGE must be ${browserMcpPackage}" >&2
  exit 2
fi`;
  writeExecutable(
    join(stagedScripts, "mcp.sh"),
    `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=${shellQuote(finalScripts)}
source "$SCRIPT_DIR/common.sh"
${validateOverrides}
mode="\${1:-}"
shift || true
export CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1
common_args=("-y" ${shellQuote(browserMcpPackage)} "--no-usage-statistics" "--no-performance-crux")
case "$mode" in
  headed)
    "$SCRIPT_DIR/open-headed.sh" >/dev/null
    url="$(bc_headed_url)"
    exec ${shellQuote(browserBunWrapper)} "\${common_args[@]}" "--browser-url=$url" "$@"
    ;;
  headless)
    output="$("$SCRIPT_DIR/open-headless.sh")"
    id="$(awk '{for(i=1;i<=NF;i++){if($i ~ /^id=/){sub(/^id=/,"",$i); print $i}}}' <<<"$output" | tail -n1)"
    url="$(awk '{for(i=1;i<=NF;i++){if($i ~ /^url=/){sub(/^url=/,"",$i); print $i}}}' <<<"$output" | tail -n1)"
    if [ -z "$id" ] || [ -z "$url" ]; then
      echo "FAILED mode=headless reason=could-not-parse-open-output output=$output" >&2
      exit 1
    fi
    cleanup() { "$SCRIPT_DIR/close-headless.sh" "$id" >/dev/null 2>&1 || true; }
    trap cleanup EXIT INT TERM
    ${shellQuote(browserBunWrapper)} "\${common_args[@]}" "--browser-url=$url" "$@"
    ;;
  *)
    echo "Usage: $0 <headed|headless> [chrome-devtools-mcp args...]" >&2
    exit 2
    ;;
esac
`,
  );
  writeExecutable(
    join(stagedScripts, "control-mcp.sh"),
    `#!/bin/sh
set -eu
recorded_bun=${shellQuote(bunExecutable)}
recorded_bun_version=${shellQuote(bunVersion)}
if [ "\${PIPI_BUN_RUNTIME+x}" = x ] && [ "$PIPI_BUN_RUNTIME" != "$recorded_bun" ]; then
  echo "PIPI_BUN_RUNTIME must match the recorded Pipi Bun runtime: $recorded_bun" >&2
  exit 2
fi
if [ "\${BROWSER_CHROME_NODE+x}" = x ] && [ "$BROWSER_CHROME_NODE" != "$recorded_bun" ]; then
  echo "BROWSER_CHROME_NODE must match the recorded Pipi Bun runtime: $recorded_bun" >&2
  exit 2
fi
if [ ! -x "$recorded_bun" ]; then
  echo "Recorded Pipi Bun runtime is not executable: $recorded_bun" >&2
  exit 127
fi
actual_bun_version=$("$recorded_bun" --version 2>/dev/null) || {
  echo "Recorded Pipi Bun runtime version probe failed: $recorded_bun" >&2
  exit 127
}
if [ "$actual_bun_version" != "$recorded_bun_version" ]; then
  echo "Recorded Pipi Bun runtime must remain stable version $recorded_bun_version: $recorded_bun" >&2
  exit 2
fi
exec "$recorded_bun" ${shellQuote(join(finalBrowserSkillDir, "control-mcp", "server.mjs"))} --skill-dir ${shellQuote(finalBrowserSkillDir)} "$@"
`,
  );

  const installerModule = join(finalScripts, "install-local.mjs");
  writeExecutable(
    join(stagedScripts, "install-local.sh"),
    `#!/bin/sh
set -eu
${validateOverrides}
exec ${shellQuote(bunExecutable)} ${shellQuote(installerModule)} "$@"
`,
  );
  writeFileSync(
    join(stagedScripts, "install-local.mjs"),
    `import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const sourceSkill = resolve(fileURLToPath(new URL("..", import.meta.url)));
const agentDir = resolve(process.env.PI_AGENT_DIR ?? ${JSON.stringify(finalAgentDir)});
const targetSkill = resolve(process.env.BROWSER_CHROME_SKILL_TARGET ?? join(agentDir, "skills", "browser-chrome"));
const mcpPath = resolve(process.env.BROWSER_CHROME_MCP_JSON ?? join(agentDir, "mcp.json"));
if (targetSkill !== sourceSkill) {
  rmSync(targetSkill, { recursive: true, force: true });
  mkdirSync(dirname(targetSkill), { recursive: true, mode: 0o700 });
  cpSync(sourceSkill, targetSkill, { recursive: true, dereference: false, verbatimSymlinks: true });
}
const current = existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, "utf8")) : {};
if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("MCP config must be a JSON object");
const servers = current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers) ? current.mcpServers : {};
const commonEnv = { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1", PIPI_BUN_RUNTIME: ${JSON.stringify(bunExecutable)}, BROWSER_CHROME_NPX: ${JSON.stringify(browserBunWrapper)}, BROWSER_CHROME_MCP_PACKAGE: ${JSON.stringify(browserMcpPackage)} };
current.mcpServers = { ...servers,
  "browser-chrome-control": { command: join(targetSkill, "scripts", "control-mcp.sh"), args: [], lifecycle: "lazy", env: { BROWSER_CHROME_NODE: ${JSON.stringify(bunExecutable)}, PIPI_BUN_RUNTIME: ${JSON.stringify(bunExecutable)} } },
  "browser-chrome-headed": { command: join(targetSkill, "scripts", "mcp.sh"), args: ["headed"], lifecycle: "lazy", env: commonEnv },
  "browser-chrome-headless": { command: join(targetSkill, "scripts", "mcp.sh"), args: ["headless"], lifecycle: "lazy", idleTimeout: 1, env: commonEnv },
};
mkdirSync(dirname(mcpPath), { recursive: true, mode: 0o700 });
const temporary = mcpPath + "." + process.pid + ".tmp";
writeFileSync(temporary, JSON.stringify(current, null, 2) + "\\n", { mode: 0o600 });
renameSync(temporary, mcpPath);
chmodSync(mcpPath, 0o600);
console.log("Installed Bun-safe browser-chrome MCP wiring at " + mcpPath);
`,
    { mode: 0o600 },
  );

  writeFileSync(
    join(stagedBrowserSkillDir, "README.md"),
    `# Pipi-managed browser-chrome skill\n\nThis installed copy uses ${browserMcpPackage} from Pipi's isolated frozen Bun runtime. Run \`scripts/mcp.sh headed\` or \`scripts/mcp.sh headless\`; both invoke the recorded absolute Bun and local pinned entrypoint. Direct \`scripts/control-mcp.sh\`, \`scripts/mcp.sh\`, and \`scripts/install-local.sh\` accept an unset \`PIPI_BUN_RUNTIME\`; when set, it must exactly match the recorded absolute Bun or invocation fails before server startup. Control startup also rechecks that the recorded executable still reports its installed stable Bun version. \`scripts/install-local.sh\` copies only this hardened installed boundary and writes equivalent MCP entries. Registry lookup and alternate package-manager fallback are unavailable.\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(stagedBrowserSkillDir, "references", "mcp-config.md"),
    `# Pipi-managed Browser Chrome MCP config\n\nThe generated \`mcp.json\`, direct \`scripts/control-mcp.sh\`, \`scripts/mcp.sh\`, and \`scripts/install-local.sh\` all use the recorded Bun ${bunExecutable}; browser sessions use ${browserMcpPackage} through ${browserBunWrapper}. \`PIPI_BUN_RUNTIME\` may be unset, but a set value must exactly equal that recorded absolute Bun on every installed entrypoint. Control startup also rechecks the installed stable Bun version. Floating package resolution and alternate package-manager fallback are intentionally unavailable; invalid runtime, wrapper, or package overrides fail before browser MCP starts.\n`,
    { mode: 0o600 },
  );
};

const installBrowserChromeMcp = (
  mcpPath,
  browserSkillDir,
  bunExecutable,
  browserBunWrapper,
) => {
  const current = readSettings(mcpPath, true);
  const existingServers = current.mcpServers ?? {};
  if (
    !existingServers ||
    typeof existingServers !== "object" ||
    Array.isArray(existingServers)
  ) {
    throw new Error(`Cannot read ${mcpPath}: mcpServers must be an object`);
  }
  const commonEnv = {
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
    PIPI_BUN_RUNTIME: bunExecutable,
    BROWSER_CHROME_NPX: browserBunWrapper,
    BROWSER_CHROME_MCP_PACKAGE: browserMcpPackage,
  };
  writeJson(mcpPath, {
    ...current,
    mcpServers: {
      ...existingServers,
      "browser-chrome-control": {
        command: join(browserSkillDir, "scripts", "control-mcp.sh"),
        args: [],
        lifecycle: "lazy",
        env: {
          BROWSER_CHROME_NODE: bunExecutable,
          PIPI_BUN_RUNTIME: bunExecutable,
        },
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

const assertDirectoryWhenPresent = (path, label) => {
  try {
    if (!lstatSync(path).isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
};

const install = () => {
  const options = parseArgs(process.argv.slice(2));
  const bunRuntime = resolveBunRuntime({
    env: {
      ...process.env,
      ...(options.bun ? { PIPI_BUN_RUNTIME: options.bun } : {}),
    },
  });
  const home = process.env.HOME || homedir();
  const externalPiExecutable = options.pi
    ? findExecutable(options.pi)
    : undefined;
  if (options.pi && !externalPiExecutable) {
    throw new Error(
      `Pi executable is not executable or was not found: ${options.pi}`,
    );
  }

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
  const isolatedRuntimePrefix = join(agentDir, "runtime");

  assertDirectoryWhenPresent(agentDir, "Pipi agent path");
  assertDirectoryWhenPresent(sessionDir, "Pipi session path");
  try {
    const launcherStat = lstatSync(launcherPath);
    if (
      !launcherStat.isFile() ||
      !readFileSync(launcherPath, "utf8").includes(managedLauncherMarker)
    ) {
      throw new Error(
        `Refusing to replace launcher not managed by this installer: ${launcherPath}`,
      );
    }
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
  }

  const codexManifestPath = join(options.codexTools, "package.json");
  if (!existsSync(codexManifestPath)) {
    throw new Error(`Missing pi-codex-tools package: ${options.codexTools}`);
  }
  const codexManifest = JSON.parse(readFileSync(codexManifestPath, "utf8"));
  if (codexManifest.name !== "pi-codex-tools") {
    throw new Error(`Expected pi-codex-tools at ${options.codexTools}`);
  }

  if (options.shareAuth) validateAuthShare(regularAuthPath, pipiAuthPath);
  const submoduleAssets = validateSubmoduleAssets();
  const reviewerAssetsRoot = submoduleAssets["gpt5.6-reviewer"];
  const backlogSkillDir = submoduleAssets["plan-gh-backlog"];
  const codexToolsRoot = submoduleAssets["pi-codex"];
  if (!reviewerAssetsRoot || !backlogSkillDir || !codexToolsRoot) {
    throw new Error("Required submodule configuration is missing");
  }
  if (
    options.codexTools === codexToolsSubmoduleRoot &&
    codexToolsRoot !== options.codexTools
  ) {
    throw new Error("Configured pi-codex submodule path is inconsistent");
  }
  const reviewerSkillDir = join(reviewerAssetsRoot, "skills", "code-review");
  validateManagedInstallSources();

  let piExecutable = externalPiExecutable;

  const lock = acquireInstallLock({ home });
  let transaction;
  try {
    if (!options.skipRepositoryDependencies) {
      // Repository dependency preparation is a frozen, retryable preflight/cache
      // boundary. It intentionally precedes and is not rolled back with the
      // managed HOME transaction below; tracked manifests and locks stay
      // authoritative while Bun may repair repository node_modules or caches.
      prepareRepositoryDependencies({ bunExecutable: bunRuntime.executable });
    }

    transaction = createManagedInstallTransaction({
      home,
      token: lock.owner.token,
      agentDir,
      sessionDir,
      launcherPath,
    });
    const stagedAgentDir = transaction.stagedAgentDir;
    const stagedRuntimePrefix = join(stagedAgentDir, "runtime");
    removePiSubagentsAssets(stagedAgentDir);
    transaction.injectFailure("legacy-removals");

    const runtimeTransaction = prepareIsolatedBunRuntime({
      prefix: stagedRuntimePrefix,
      bunExecutable: bunRuntime.executable,
      cacheDirectory: join(stagedAgentDir, "cache", "bun"),
      appName: "pipi",
    });
    runtimeTransaction.commit();
    piExecutable ??= join(isolatedRuntimePrefix, "node_modules", ".bin", "pi");
    transaction.injectFailure("runtime");
    if (!piExecutable) {
      throw new Error("The isolated Pipi executable was not selected");
    }

    const {
      browserSkillDir: stagedBrowserSkillDir,
      transaction: browserAssets,
    } = installBrowserChromeAssets(stagedAgentDir);
    browserAssets.commit();
    const finalBrowserSkillDir = join(agentDir, "skills", "browser-chrome");
    transaction.injectFailure("browser-assets");

    const browserBunWrapper = installBrowserBunWrapper({
      stagedAgentDir,
      finalAgentDir: agentDir,
      bunExecutable: bunRuntime.executable,
    });
    hardenInstalledBrowserSkill({
      stagedBrowserSkillDir,
      finalBrowserSkillDir,
      finalAgentDir: agentDir,
      bunExecutable: bunRuntime.executable,
      bunVersion: bunRuntime.version,
      browserBunWrapper,
    });
    transaction.injectFailure("browser-boundary");

    installBrowserChromeMcp(
      join(stagedAgentDir, "mcp.json"),
      finalBrowserSkillDir,
      bunRuntime.executable,
      browserBunWrapper,
    );
    transaction.injectFailure("mcp-config");

    const pipiSettings = readSettings(
      join(stagedAgentDir, "settings.json"),
      true,
    );
    const regularSettings = readSettings(regularSettingsPath, false);
    let packages = Array.isArray(pipiSettings.packages)
      ? [...pipiSettings.packages]
      : [];
    addPackage(packages, repositoryRoot);
    pinLocalPackage(
      packages,
      legacyMcpAdapterPackagePrefix,
      join(isolatedRuntimePrefix, "node_modules", "pi-mcp-adapter"),
    );
    for (let index = packages.length - 1; index >= 0; index -= 1) {
      const source = packageSource(packages[index]);
      if (
        source === removedPiSubagentsPackagePrefix ||
        source?.startsWith(`${removedPiSubagentsPackagePrefix}@`)
      ) {
        packages.splice(index, 1);
      }
    }
    packages = normalizeCodexToolsPackage({
      packages,
      desiredPath: options.codexTools,
      settingsBaseDir: agentDir,
      home,
    });
    const nextSettings = {
      ...pipiSettings,
      theme: "github-dark-default",
      packages,
    };
    for (const key of modelDefaults) {
      if (
        nextSettings[key] === undefined &&
        regularSettings[key] !== undefined
      ) {
        nextSettings[key] = regularSettings[key];
      }
    }
    writeJson(join(stagedAgentDir, "settings.json"), nextSettings);
    transaction.injectFailure("settings-config");

    const stagedModelOverrides = join(stagedAgentDir, "models.json");
    if (!existsSync(stagedModelOverrides)) {
      writeFileSync(stagedModelOverrides, readFileSync(modelOverridesSource), {
        mode: 0o600,
      });
      chmodSync(stagedModelOverrides, 0o600);
    }
    transaction.injectFailure("model-config");

    transaction.activateAgent();
    const herdrIntegrationPath = installHerdrPiIntegration(
      herdrExecutable,
      agentDir,
    );
    transaction.injectFailure("herdr-integration");

    if (options.shareAuth && !existsSync(pipiAuthPath)) {
      symlinkSync(regularAuthPath, pipiAuthPath);
    }
    transaction.injectFailure("auth-link");

    const launcher = `#!/bin/sh\n${managedLauncherMarker}\nexport PIPI_PROFILE=1\nexport PIPI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexport PIPI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}\nexport PI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexport PI_CODING_AGENT_SESSION_DIR=${shellQuote(sessionDir)}\nexport PIPI_RUNTIME=bun\nexport PIPI_BUN_RUNTIME=${shellQuote(bunRuntime.executable)}\nexport BROWSER_CHROME_NODE="$PIPI_BUN_RUNTIME"\nif [ "\${HERDR_ENV:-}" = "1" ]; then\n  export HERDR_AGENT=pi\nfi\nexec "$PIPI_BUN_RUNTIME" ${shellQuote(piExecutable)} "$@"\n`;
    writeFileSync(transaction.stagedLauncherPath, launcher, { mode: 0o755 });
    chmodSync(transaction.stagedLauncherPath, 0o755);
    transaction.injectFailure("launcher-stage");

    transaction.commit();

    console.log(
      `Pipi runtime: Bun ${bunRuntime.version} (${bunRuntime.executable}) running ${runtimePiPackage}`,
    );
    console.log(`Installed Pipi launcher: ${launcherPath}`);
    console.log(`Pipi settings: ${pipiSettingsPath}`);
    console.log(`Pipi sessions: ${sessionDir}`);
    console.log(`Browser Chrome skill: ${finalBrowserSkillDir}`);
    console.log(`Evidence-driven code-review skill: ${reviewerSkillDir}`);
    console.log(`Plan GitHub backlog skill: ${backlogSkillDir}`);
    console.log(`Browser Chrome MCP config: ${pipiMcpPath}`);
    if (herdrIntegrationPath) {
      console.log(
        `Herdr Pi integration: ${join(agentDir, "extensions", "herdr-agent-state.ts")}`,
      );
    } else {
      console.log("Herdr CLI not found; skipped the optional Pi integration.");
    }
    if (codexExecutable) console.log(`Codex CLI: ${codexExecutable}`);
    else {
      console.warn(
        "Codex CLI was not found in PATH; Codex-backed tools will be unavailable until it is installed.",
      );
    }
    if (!options.shareAuth) {
      console.log(
        "Pipi auth remains isolated (use --share-auth to opt in to a symlink). ",
      );
    }
  } catch (error) {
    transaction?.rollback();
    throw error;
  } finally {
    lock.release();
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    install();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
