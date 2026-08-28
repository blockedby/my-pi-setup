import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  installAssetDirectory,
  normalizeCodexToolsPackage,
} from "../../scripts/install.mjs";
import {
  acquireInstallLock,
  encodeInstallLockOwner,
} from "../../scripts/install-state.mjs";
import {
  readBunLock,
  validatePipiVersionState,
} from "../../scripts/pipi-version.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const installScript = join(repositoryRoot, "scripts", "install.mjs");
const uninstallScript = join(repositoryRoot, "scripts", "uninstall.mjs");
const mcpAdapterPackage = (home) =>
  join(home, ".pipi", "agent", "runtime", "node_modules", "pi-mcp-adapter");
const legacyMcpAdapterPackage = "npm:pi-mcp-adapter";
const legacyPiSubagentsPackage = "npm:pi-subagents";
const browserSkillSource = join(
  repositoryRoot,
  "vendor",
  "pi-agent-setup",
  "skills",
  "browser-chrome",
);
const reviewerSubmodule = join(repositoryRoot, "vendor", "gpt5.6-reviewer");
const reviewerSkillSource = join(
  reviewerSubmodule,
  "skills",
  "code-review",
  "SKILL.md",
);
const backlogSubmodule = join(repositoryRoot, "vendor", "plan-gh-backlog");
const backlogSkillSource = join(backlogSubmodule, "SKILL.md");
const codexSubmodule = join(repositoryRoot, "vendor", "pi-codex");
const runtimePiPackage = "@earendil-works/pi-coding-agent";
const rootManifest = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const runtimePiSpec = rootManifest.dependencies[runtimePiPackage];
const runtimePiVersion = runtimePiSpec.match(/^\^(\d+\.\d+\.\d+)$/)?.[1];
if (!runtimePiVersion)
  throw new Error(`Unexpected Pi runtime dependency range: ${runtimePiSpec}`);
const createFixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "pipi-install-"));
  const fakeBin = join(home, "fake-bin");
  const codexTools = join(home, "pi-codex");
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(codexTools, { recursive: true });

  const piPath = join(fakeBin, "pi");
  // Keep a Node shebang to prove the managed launcher ignores it and invokes Bun.
  writeFileSync(
    piPath,
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const codex = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
process.stdout.write(JSON.stringify({
  pipiProfile: process.env.PIPI_PROFILE,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  pipiAgentDir: process.env.PIPI_CODING_AGENT_DIR,
  pipiSessionDir: process.env.PIPI_CODING_AGENT_SESSION_DIR,
  herdrAgent: process.env.HERDR_AGENT,
  runtime: process.env.PIPI_RUNTIME,
  bunRuntime: process.env.PIPI_BUN_RUNTIME,
  browserRuntime: process.env.BROWSER_CHROME_NODE,
  execPath: process.execPath,
  bunVersion: process.versions.bun,
  codex,
  args: process.argv.slice(2),
}));
`,
  );
  chmodSync(piPath, 0o755);

  const codexPath = join(fakeBin, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nprintf 'codex-test\\n'\n");
  chmodSync(codexPath, 0o755);

  const fakeBunPath = join(fakeBin, "bun");
  const bunInstallLog = join(home, "bun-install-invocations.log");
  const npmLog = join(home, "npm-invocations.log");
  writeFileSync(
    fakeBunPath,
    `#!${process.execPath}
const { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("1.4.0\\n");
  process.exit(0);
}
if (args[0] === "install") {
  if (process.env.PIPI_TEST_BUN_INSTALL_LOG) appendFileSync(process.env.PIPI_TEST_BUN_INSTALL_LOG, args.join(" ") + "\\n");
  if (process.env.PIPI_TEST_BUN_INSTALL_FAIL === "1") process.exit(23);
  if (process.env.PIPI_TEST_BUN_HOLD_MARKER) {
    writeFileSync(process.env.PIPI_TEST_BUN_HOLD_MARKER, "holding\\n");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      try { process.kill(process.ppid, 0); } catch { process.exit(44); }
      Atomics.wait(wait, 0, 0, 25);
    }
  }
  const cwd = args[args.indexOf("--cwd") + 1];
  if (process.env.PIPI_TEST_CONCURRENT_SETTINGS) {
    const agentDir = join(process.env.HOME, ".pipi", "agent");
    const marker = join(agentDir, "concurrent-settings-written");
    if (!existsSync(marker)) {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
        concurrentValue: "preserved",
        packages: ["concurrent-package"],
      }));
      writeFileSync(marker, "written");
    }
  }
  if (
    cwd.includes(".pipi-install-stage-") &&
    cwd.includes("runtime.stage-")
  ) {
    const binDir = join(cwd, "node_modules", ".bin");
    const piPackage = join(cwd, "node_modules", "@earendil-works", "pi-coding-agent");
    const adapterPackage = join(cwd, "node_modules", "pi-mcp-adapter");
    const browserPackage = join(cwd, "node_modules", "chrome-devtools-mcp");
    mkdirSync(binDir, { recursive: true });
    const piEntry = join(piPackage, "dist", "bundle", "cli.js");
    const adapterEntry = join(adapterPackage, "cli.js");
    const browserEntry = join(browserPackage, "build", "src", "bin", "chrome-devtools-mcp.js");
    mkdirSync(join(piPackage, "dist", "bundle"), { recursive: true });
    mkdirSync(adapterPackage, { recursive: true });
    mkdirSync(join(browserPackage, "build", "src", "bin"), { recursive: true });
    writeFileSync(join(piPackage, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: ${JSON.stringify(runtimePiVersion)}, piConfig: { configDir: ".pi" }, bin: { pi: "dist/bundle/cli.js" } }));
    writeFileSync(join(adapterPackage, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.15.0", bin: { "pi-mcp-adapter": "cli.js" } }));
    writeFileSync(join(browserPackage, "package.json"), JSON.stringify({ name: "chrome-devtools-mcp", version: "1.8.0", bin: { "chrome-devtools-mcp": "build/src/bin/chrome-devtools-mcp.js" } }));
    cpSync(process.env.PIPI_TEST_PI_FIXTURE, piEntry);
    chmodSync(piEntry, 0o755);
    writeFileSync(adapterEntry, "process.exit(0);\\n");
    writeFileSync(join(adapterPackage, "index.ts"), "export default {};\\n");
    writeFileSync(join(adapterPackage, "types.ts"), "export {};\\n");
    chmodSync(adapterEntry, 0o755);
    writeFileSync(browserEntry, 'process.stdout.write(JSON.stringify({ execPath: process.execPath, bunVersion: process.versions.bun, noUpdateChecks: process.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, args: process.argv.slice(2) }));\\n');
    chmodSync(browserEntry, 0o755);
    symlinkSync("../@earendil-works/pi-coding-agent/dist/bundle/cli.js", join(binDir, "pi"));
    symlinkSync("../pi-mcp-adapter/cli.js", join(binDir, "pi-mcp-adapter"));
    symlinkSync("../chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", join(binDir, "chrome-devtools-mcp"));
  }
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(process.execPath)}, args, { env: process.env, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`,
  );
  chmodSync(fakeBunPath, 0o755);

  const npmPath = join(fakeBin, "npm");
  writeFileSync(
    npmPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(npmLog)}
echo "npm must not be invoked" >&2
exit 99
`,
  );
  chmodSync(npmPath, 0o755);
  const npxPath = join(fakeBin, "npx");
  writeFileSync(
    npxPath,
    `#!/bin/sh
printf 'npx %s\\n' "$*" >> ${JSON.stringify(npmLog)}
echo "npx must not be invoked" >&2
exit 98
`,
  );
  chmodSync(npxPath, 0o755);
  const curlPath = join(fakeBin, "curl");
  writeFileSync(curlPath, "#!/bin/sh\nprintf '{}\\n'\n");
  chmodSync(curlPath, 0o755);
  writeFileSync(
    join(codexTools, "package.json"),
    JSON.stringify({ name: "pi-codex-tools" }),
  );

  const herdrLog = join(home, "herdr-install.jsonl");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("HERDR_")) delete env[key];
  }
  Object.assign(env, {
    HOME: home,
    HERDR_TEST_LOG: herdrLog,
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    PIPI_BUN_RUNTIME: fakeBunPath,
    PIPI_TEST_BUN_INSTALL_LOG: bunInstallLog,
    PIPI_TEST_PI_FIXTURE: piPath,
  });

  return {
    home,
    fakeBin,
    piPath,
    fakeBunPath,
    bunInstallLog,
    npmLog,
    codexPath,
    codexTools,
    herdrLog,
    env,
  };
};

const snapshotTree = (path) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { type: "absent" };
    }
    throw error;
  }
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) {
    return { type: "symlink", mode, target: readlinkSync(path) };
  }
  if (stat.isDirectory()) {
    return {
      type: "directory",
      mode,
      entries: Object.fromEntries(
        readdirSync(path)
          .sort()
          .map((entry) => [entry, snapshotTree(join(path, entry))]),
      ),
    };
  }
  return {
    type: "file",
    mode,
    bytes: readFileSync(path).toString("base64"),
  };
};

const snapshotManagedState = (home) => ({
  pipi: snapshotTree(join(home, ".pipi")),
  launcher: snapshotTree(join(home, ".local", "bin", "pipi")),
  lock: snapshotTree(join(home, ".pipi-install-lock")),
  stages: readdirSync(home)
    .filter((entry) => entry.startsWith(".pipi-install-stage-"))
    .sort(),
});

const snapshotRepositoryAuthority = () => {
  const paths = [
    "package.json",
    "bun.lock",
    "config/pipi-runtime/package.json",
    "config/pipi-runtime/bun.lock",
    ...readdirSync(join(repositoryRoot, "extensions"), {
      withFileTypes: true,
    })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(
            join(repositoryRoot, "extensions", entry.name, "package.json"),
          ),
      )
      .map((entry) => `extensions/${entry.name}/package.json`)
      .sort(),
  ];
  return Object.fromEntries(
    paths.map((path) => [
      path,
      readFileSync(join(repositoryRoot, path)).toString("base64"),
    ]),
  );
};

const browserTransactionArtifacts = (browserTarget) =>
  readdirSync(dirname(browserTarget))
    .filter((entry) => entry.startsWith(`${basename(browserTarget)}.`))
    .sort();

const addFakeHerdr = (
  fixture,
  { fail = false, writeIntegration = true } = {},
) => {
  const herdrPath = join(fixture.fakeBin, "herdr");
  writeFileSync(
    herdrPath,
    `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const record = {
  args: process.argv.slice(2),
  agentDir: process.env.PI_CODING_AGENT_DIR,
};
appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(record) + "\\n");
if (${JSON.stringify(fail)}) process.exit(23);
if (${JSON.stringify(writeIntegration)}) {
  const integrationPath = join(process.env.PI_CODING_AGENT_DIR, "extensions", "herdr-agent-state.ts");
  mkdirSync(dirname(integrationPath), { recursive: true });
  writeFileSync(integrationPath, "// fake official Herdr Pi integration\\n");
}
`,
  );
  chmodSync(herdrPath, 0o755);
  return herdrPath;
};

const install = (fixture, extraArgs = []) =>
  spawnSync(
    process.execPath,
    [
      installScript,
      "--skip-repository-dependencies",
      "--codex-tools",
      fixture.codexTools,
      ...extraArgs,
    ],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const expectedBrowserMcpServers = (home) => {
  const agentDir = join(home, ".pipi", "agent");
  const skillDir = join(agentDir, "skills", "browser-chrome");
  const browserBunWrapper = join(agentDir, "bin", "pipi-browser-bun");
  const bunRuntime = join(home, "fake-bin", "bun");
  const commonEnv = {
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
    PIPI_BUN_RUNTIME: bunRuntime,
    BROWSER_CHROME_NPX: browserBunWrapper,
    BROWSER_CHROME_MCP_PACKAGE: "chrome-devtools-mcp@1.8.0",
  };
  return {
    "browser-chrome-control": {
      command: join(skillDir, "scripts", "control-mcp.sh"),
      args: [],
      lifecycle: "lazy",
      env: {
        BROWSER_CHROME_NODE: bunRuntime,
        PIPI_BUN_RUNTIME: bunRuntime,
      },
    },
    "browser-chrome-headed": {
      command: join(skillDir, "scripts", "mcp.sh"),
      args: ["headed"],
      lifecycle: "lazy",
      env: commonEnv,
    },
    "browser-chrome-headless": {
      command: join(skillDir, "scripts", "mcp.sh"),
      args: ["headless"],
      lifecycle: "lazy",
      idleTimeout: 1,
      env: commonEnv,
    },
  };
};

test("clean install creates an isolated launcher and is idempotent", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const regularAgentDir = join(fixture.home, ".pi", "agent");
  mkdirSync(regularAgentDir, { recursive: true });
  const regularSettingsPath = join(regularAgentDir, "settings.json");
  const regularSettings = `${JSON.stringify(
    {
      defaultProvider: "provider-test",
      defaultModel: "model-test",
      defaultThinkingLevel: "high",
      packages: ["regular-only-package"],
    },
    null,
    2,
  )}\n`;
  writeFileSync(regularSettingsPath, regularSettings);
  writeFileSync(
    join(regularAgentDir, "auth.json"),
    '{"secret":"must-not-copy"}\n',
  );
  const regularMcp =
    '{"mcpServers":{"private":{"env":{"API_KEY":"must-not-copy"}}}}\n';
  writeFileSync(join(regularAgentDir, "mcp.json"), regularMcp);

  const first = install(fixture);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Codex CLI:/);
  assert.match(
    first.stdout,
    new RegExp(`Evidence-driven code-review skill: ${reviewerSubmodule}`),
  );
  assert.match(
    first.stdout,
    new RegExp(`Plan GitHub backlog skill: ${backlogSubmodule}`),
  );

  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  const settingsPath = join(fixture.home, ".pipi", "agent", "settings.json");
  assert.equal(existsSync(launcherPath), true);
  assert.equal(lstatSync(launcherPath).mode & 0o111, 0o111);
  assert.equal(readFileSync(regularSettingsPath, "utf8"), regularSettings);
  assert.equal(
    existsSync(join(fixture.home, ".pipi", "agent", "auth.json")),
    false,
  );
  assert.equal(
    readFileSync(join(fixture.home, ".pipi", "agent", "models.json"), "utf8"),
    readFileSync(
      join(repositoryRoot, "config", "pipi-model-overrides.json"),
      "utf8",
    ),
  );

  const settings = readJson(settingsPath);
  assert.equal(settings.defaultProvider, "provider-test");
  assert.equal(settings.defaultModel, "model-test");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.equal(settings.theme, "github-dark-default");
  assert.deepEqual(settings.packages, [
    repositoryRoot,
    mcpAdapterPackage(fixture.home),
    fixture.codexTools,
  ]);

  const pipiAgentDir = join(fixture.home, ".pipi", "agent");
  const installedBrowserSkill = join(pipiAgentDir, "skills", "browser-chrome");
  const pipiMcpPath = join(pipiAgentDir, "mcp.json");
  assert.equal(
    readFileSync(join(installedBrowserSkill, "SKILL.md"), "utf8"),
    readFileSync(join(browserSkillSource, "SKILL.md"), "utf8"),
  );
  assert.equal(
    existsSync(join(pipiAgentDir, "skills", "aad-task-package")),
    false,
  );
  assert.equal(
    existsSync(join(pipiAgentDir, "agents", "chrome-browser-agent.md")),
    false,
  );
  assert.equal(
    existsSync(join(pipiAgentDir, "npm", "node_modules", "pi-subagents")),
    false,
  );
  assert.equal(
    lstatSync(join(installedBrowserSkill, "scripts", "mcp.sh")).mode & 0o111,
    0o100,
  );
  assert.deepEqual(readJson(pipiMcpPath), {
    mcpServers: expectedBrowserMcpServers(fixture.home),
  });
  const browserBunWrapper = join(pipiAgentDir, "bin", "pipi-browser-bun");
  assert.equal(lstatSync(browserBunWrapper).mode & 0o111, 0o100);
  assert.doesNotMatch(readFileSync(browserBunWrapper, "utf8"), /npm exec/);
  assert.match(readFileSync(browserBunWrapper, "utf8"), /PIPI_BUN_RUNTIME/);
  const browserProbe = JSON.parse(
    execFileSync(
      browserBunWrapper,
      ["-y", "chrome-devtools-mcp@1.8.0", "argument with spaces"],
      {
        env: {
          ...fixture.env,
          PIPI_BUN_RUNTIME: fixture.fakeBunPath,
        },
        encoding: "utf8",
      },
    ),
  );
  assert.deepEqual(browserProbe, {
    execPath: process.execPath,
    bunVersion: process.versions.bun,
    noUpdateChecks: "1",
    args: ["argument with spaces"],
  });
  assert.equal(existsSync(fixture.npmLog), false);
  assert.equal(
    readFileSync(join(regularAgentDir, "mcp.json"), "utf8"),
    regularMcp,
  );

  const probe = execFileSync(
    launcherPath,
    ["--version", "argument with spaces"],
    {
      env: fixture.env,
      encoding: "utf8",
    },
  );
  assert.deepEqual(JSON.parse(probe), {
    pipiProfile: "1",
    agentDir: join(fixture.home, ".pipi", "agent"),
    sessionDir: join(fixture.home, ".pipi", "sessions"),
    pipiAgentDir: join(fixture.home, ".pipi", "agent"),
    pipiSessionDir: join(fixture.home, ".pipi", "sessions"),
    runtime: "bun",
    bunRuntime: fixture.fakeBunPath,
    browserRuntime: fixture.fakeBunPath,
    execPath: process.execPath,
    bunVersion: process.versions.bun,
    codex: fixture.codexPath,
    args: ["--version", "argument with spaces"],
  });

  const firstLauncher = readFileSync(launcherPath, "utf8");
  const firstSettings = readFileSync(settingsPath, "utf8");
  const firstMcp = readFileSync(pipiMcpPath, "utf8");
  const second = install(fixture);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(launcherPath, "utf8"), firstLauncher);
  assert.equal(readFileSync(settingsPath, "utf8"), firstSettings);
  assert.equal(readFileSync(pipiMcpPath, "utf8"), firstMcp);
  assert.equal(readFileSync(regularSettingsPath, "utf8"), regularSettings);
  assert.equal(
    readFileSync(join(regularAgentDir, "mcp.json"), "utf8"),
    regularMcp,
  );
});

test("launcher scopes the Pi process hint to Herdr panes", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = install(fixture);
  assert.equal(result.status, 0, result.stderr);
  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  const outsideHerdr = JSON.parse(
    execFileSync(launcherPath, [], {
      env: fixture.env,
      encoding: "utf8",
    }),
  );
  assert.equal("herdrAgent" in outsideHerdr, false);

  const insideHerdr = JSON.parse(
    execFileSync(launcherPath, [], {
      env: { ...fixture.env, HERDR_ENV: "1" },
      encoding: "utf8",
    }),
  );
  assert.equal(insideHerdr.herdrAgent, "pi");
});

test("install adds the official Pi integration when Herdr is available", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  addFakeHerdr(fixture);

  const first = install(fixture);
  assert.equal(first.status, 0, first.stderr);
  const integrationPath = join(
    fixture.home,
    ".pipi",
    "agent",
    "extensions",
    "herdr-agent-state.ts",
  );
  assert.equal(existsSync(integrationPath), true);
  assert.match(
    first.stdout,
    new RegExp(`Herdr Pi integration: ${integrationPath}`),
  );

  const second = install(fixture);
  assert.equal(second.status, 0, second.stderr);
  const records = readFileSync(fixture.herdrLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(records, [
    {
      args: ["integration", "install", "pi"],
      agentDir: join(fixture.home, ".pipi", "agent"),
    },
    {
      args: ["integration", "install", "pi"],
      agentDir: join(fixture.home, ".pipi", "agent"),
    },
  ]);
});

test("install skips the optional integration when Herdr is unavailable", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = install(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Herdr CLI not found; skipped the optional Pi integration\./,
  );
  assert.equal(existsSync(fixture.herdrLog), false);
});

test("install fails clearly when the detected Herdr integration fails", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  addFakeHerdr(fixture, { fail: true });

  const result = install(fixture);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Failed to install the official Herdr Pi integration/,
  );
  assert.equal(
    existsSync(
      join(
        fixture.home,
        ".pipi",
        "agent",
        "extensions",
        "herdr-agent-state.ts",
      ),
    ),
    false,
  );
});

test("install rejects a false-success Herdr integration result", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  addFakeHerdr(fixture, { writeIntegration: false });

  const result = install(fixture);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Herdr reported a successful Pi integration install but did not create/,
  );
});

test("Pi package, SDK, TUI, and TypeBox dependencies remain aligned", () => {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const lockfile = readBunLock(join(repositoryRoot, "bun.lock"));

  assert.equal(validatePipiVersionState(repositoryRoot), runtimePiVersion);
  assert.equal(manifest.dependencies.typebox, "1.3.7");
  assert.match(lockfile.packages.typebox[0], /typebox@1\.3\.7$/);
  assert.equal(
    lockfile.packages[runtimePiPackage][2].dependencies.typebox,
    "1.3.7",
  );
});

test("package loads canonical submodule resources", () => {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const submodules = readJson(
    join(repositoryRoot, "config", "submodules.json"),
  );
  const reviewer = submodules.submodules["gpt5.6-reviewer"];
  const backlog = submodules.submodules["plan-gh-backlog"];
  const codex = submodules.submodules["pi-codex"];

  assert.equal(existsSync(reviewerSkillSource), true);
  assert.match(
    readFileSync(reviewerSkillSource, "utf8"),
    /^---\nname: code-review\n/,
  );
  assert.equal(
    existsSync(join(repositoryRoot, "skills", "code-review")),
    false,
  );
  assert.equal(
    manifest.pi.skills.filter(
      (path) => path === "./vendor/gpt5.6-reviewer/skills",
    ).length,
    1,
  );
  assert.equal(reviewer.path, "vendor/gpt5.6-reviewer");
  assert.equal(
    reviewer.url,
    "https://github.com/blockedby/gpt5.6-reviewer.git",
  );
  assert.equal(reviewer.branch, "main");
  assert.equal(reviewer.piSkillPath, "./vendor/gpt5.6-reviewer/skills");

  assert.equal(existsSync(backlogSkillSource), true);
  assert.match(
    readFileSync(backlogSkillSource, "utf8"),
    /^---\nname: plan-gh-backlog\n/,
  );
  assert.equal(
    existsSync(join(repositoryRoot, "skills", "plan-gh-backlog")),
    false,
  );
  assert.equal(
    manifest.pi.skills.filter((path) => path === "./vendor/plan-gh-backlog")
      .length,
    1,
  );
  assert.equal(backlog.path, "vendor/plan-gh-backlog");
  assert.equal(backlog.url, "https://github.com/blockedby/plan-gh-backlog.git");
  assert.equal(backlog.branch, "main");
  assert.equal(backlog.piSkillPath, "./vendor/plan-gh-backlog");

  const codexManifest = readJson(join(codexSubmodule, "package.json"));
  assert.equal(codex.path, "vendor/pi-codex");
  assert.equal(codex.url, "https://github.com/blockedby/pi-codex.git");
  assert.equal(codex.branch, "main");
  assert.equal(codex.piPackageName, "pi-codex-tools");
  assert.equal(codexManifest.name, codex.piPackageName);
});

test("Codex package normalization removes legacy forms and selected duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pipi-codex-packages-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const settingsBaseDir = join(home, ".pipi", "agent");
  const desiredPath = join(root, "vendor", "pi-codex");
  const missingLegacyPath = join(root, "deleted-sibling", "pi-codex");
  const readableLegacyPath = join(root, "old-codex-checkout");
  const unavailableUnrelatedPath = join(root, "missing-unrelated-package");
  mkdirSync(readableLegacyPath, { recursive: true });
  writeFileSync(
    join(readableLegacyPath, "package.json"),
    JSON.stringify({ name: "pi-codex-tools" }),
  );

  const result = normalizeCodexToolsPackage({
    packages: [
      missingLegacyPath,
      { source: relative(settingsBaseDir, missingLegacyPath) },
      {
        source: relative(settingsBaseDir, desiredPath),
        extensions: ["extensions/codex-tools.ts"],
      },
      desiredPath,
      { source: desiredPath, skills: ["skills"] },
      readableLegacyPath,
      unavailableUnrelatedPath,
      "npm:unrelated@1.0.0",
    ],
    desiredPath,
    settingsBaseDir,
    home,
    legacyPath: missingLegacyPath,
  });

  assert.deepEqual(result, [
    {
      source: desiredPath,
      extensions: ["extensions/codex-tools.ts"],
    },
    unavailableUnrelatedPath,
    "npm:unrelated@1.0.0",
  ]);
});

test("default install replaces sibling Codex tools with the pinned submodule", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const legacyCodexTools = join(fixture.home, "pi-codex");
  mkdirSync(legacyCodexTools, { recursive: true });
  writeFileSync(
    join(legacyCodexTools, "package.json"),
    JSON.stringify({ name: "pi-codex-tools" }),
  );
  const pipiAgentDir = join(fixture.home, ".pipi", "agent");
  mkdirSync(pipiAgentDir, { recursive: true });
  writeFileSync(
    join(pipiAgentDir, "settings.json"),
    JSON.stringify({ packages: [legacyCodexTools] }),
  );

  const result = spawnSync(
    process.execPath,
    [installScript, "--skip-repository-dependencies"],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(join(pipiAgentDir, "settings.json")).packages, [
    repositoryRoot,
    mcpAdapterPackage(fixture.home),
    codexSubmodule,
  ]);
});

test("default install uses Pipi-owned Pi runtime pinned by package.json", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.includes(
      `Preparing repository Bun workspace dependency cache in ${repositoryRoot}`,
    ),
    true,
  );
  const pipiRuntime = join(fixture.home, ".pipi", "agent", "runtime");
  const runtimeManifestPath = join(
    pipiRuntime,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  const installedRuntime = readJson(runtimeManifestPath);
  assert.equal(installedRuntime.version, runtimePiVersion);
  assert.equal(existsSync(fixture.npmLog), false);
  assert.deepEqual(installedRuntime.piConfig, {
    configDir: ".pi",
    name: "pipi",
  });
  assert.equal(
    readJson(
      join(pipiRuntime, "node_modules", "pi-mcp-adapter", "package.json"),
    ).version,
    "2.15.0",
  );
  const isolatedManifest = readJson(join(pipiRuntime, "package.json"));
  assert.deepEqual(isolatedManifest.dependencies, {
    "@earendil-works/pi-coding-agent": runtimePiVersion,
    "chrome-devtools-mcp": "1.8.0",
    "pi-mcp-adapter": "2.15.0",
  });
  assert.deepEqual(isolatedManifest.trustedDependencies, [
    "@google/genai",
    "protobufjs",
  ]);
  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(
    launcher,
    new RegExp(`export PIPI_BUN_RUNTIME='${fixture.fakeBunPath}'`),
  );
  assert.match(
    launcher,
    new RegExp(
      `exec "\\$PIPI_BUN_RUNTIME" '${join(pipiRuntime, "node_modules", ".bin", "pi")}'`,
    ),
  );
  assert.equal(launcher.includes(fixture.piPath), false);
  assert.deepEqual(
    JSON.parse(
      execFileSync(launcherPath, ["--version"], {
        env: fixture.env,
        encoding: "utf8",
      }),
    ),
    {
      pipiProfile: "1",
      agentDir: join(fixture.home, ".pipi", "agent"),
      sessionDir: join(fixture.home, ".pipi", "sessions"),
      pipiAgentDir: join(fixture.home, ".pipi", "agent"),
      pipiSessionDir: join(fixture.home, ".pipi", "sessions"),
      runtime: "bun",
      bunRuntime: fixture.fakeBunPath,
      browserRuntime: fixture.fakeBunPath,
      execPath: process.execPath,
      bunVersion: process.versions.bun,
      codex: fixture.codexPath,
      args: ["--version"],
    },
  );

  writeFileSync(
    runtimeManifestPath,
    `${JSON.stringify({ ...installedRuntime, piConfig: { configDir: ".pi" } })}\n`,
  );
  const reinstalled = install(fixture);
  assert.equal(reinstalled.status, 0, reinstalled.stderr);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);
  assert.deepEqual(readJson(runtimeManifestPath).piConfig, {
    configDir: ".pi",
    name: "pipi",
  });
});

test("installer merges settings changed during dependency installation", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    {
      cwd: repositoryRoot,
      env: { ...fixture.env, PIPI_TEST_CONCURRENT_SETTINGS: "1" },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const settings = readJson(
    join(fixture.home, ".pipi", "agent", "settings.json"),
  );
  assert.equal(settings.concurrentValue, "preserved");
  assert.equal(settings.packages.includes("concurrent-package"), true);
  assert.equal(
    settings.packages.filter((entry) => entry === fixture.codexTools).length,
    1,
  );
});

test("repository dependency skip still installs isolated runtime dependencies", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [
      installScript,
      "--skip-repository-dependencies",
      "--codex-tools",
      fixture.codexTools,
    ],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.includes(`Installing dependencies in ${repositoryRoot}`),
    false,
  );

  const pipiRuntime = join(fixture.home, ".pipi", "agent", "runtime");
  assert.equal(
    readJson(
      join(
        pipiRuntime,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      ),
    ).version,
    runtimePiVersion,
  );
  assert.equal(
    readJson(
      join(pipiRuntime, "node_modules", "pi-mcp-adapter", "package.json"),
    ).version,
    "2.15.0",
  );
});

test("failed isolated Bun preparation preserves the prior runtime for retry", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const runtime = join(fixture.home, ".pipi", "agent", "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "preserved"), "previous working runtime\n");

  const failed = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    {
      cwd: repositoryRoot,
      env: { ...fixture.env, PIPI_TEST_BUN_INSTALL_FAIL: "1" },
      encoding: "utf8",
    },
  );
  assert.notEqual(failed.status, 0);
  assert.equal(
    readFileSync(join(runtime, "preserved"), "utf8"),
    "previous working runtime\n",
  );
  assert.equal(
    existsSync(join(fixture.home, ".pipi", "agent", ".pipi-install-lock")),
    false,
  );

  const retry = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(existsSync(join(runtime, "preserved")), false);
  assert.equal(
    readJson(
      join(
        runtime,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      ),
    ).version,
    runtimePiVersion,
  );
});

test("installer lock rejects concurrent mutation of one Pipi HOME", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const agentDir = join(fixture.home, ".pipi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const settings = join(agentDir, "settings.json");
  writeFileSync(settings, '{"preserved":true}\n');
  const heldLock = acquireInstallLock({ home: fixture.home });
  t.after(() => heldLock.release());

  const result = install(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Another Pipi installer is active/);
  assert.equal(readFileSync(settings, "utf8"), '{"preserved":true}\n');
});

test("install repairs stale isolated Bun package metadata", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const pipiRuntime = join(fixture.home, ".pipi", "agent", "runtime");
  const piPackageDir = join(
    pipiRuntime,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const mcpPackageDir = join(pipiRuntime, "node_modules", "pi-mcp-adapter");
  const binDir = join(pipiRuntime, "node_modules", ".bin");
  mkdirSync(piPackageDir, { recursive: true });
  mkdirSync(mcpPackageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(pipiRuntime, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@earendil-works/pi-coding-agent": runtimePiVersion,
        "pi-mcp-adapter": "^2.15.0",
      },
      allowScripts: {
        "@google/genai": true,
        "evil-package@1.0.0": true,
      },
    }),
  );
  writeFileSync(
    join(piPackageDir, "package.json"),
    JSON.stringify({ version: runtimePiVersion }),
  );
  writeFileSync(
    join(mcpPackageDir, "package.json"),
    JSON.stringify({ version: "2.15.0" }),
  );
  const piPath = join(binDir, "pi");
  writeFileSync(piPath, "#!/bin/sh\nexit 0\n");
  chmodSync(piPath, 0o755);

  const result = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const isolatedManifest = readJson(join(pipiRuntime, "package.json"));
  assert.deepEqual(isolatedManifest.dependencies, {
    "@earendil-works/pi-coding-agent": runtimePiVersion,
    "chrome-devtools-mcp": "1.8.0",
    "pi-mcp-adapter": "2.15.0",
  });
  assert.deepEqual(isolatedManifest.trustedDependencies, [
    "@google/genai",
    "protobufjs",
  ]);
});

test("browser asset activation and rollback restore a dangling target without following it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pipi-browser-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "managed", "browser-chrome");
  const externalTarget = join(root, "external", "missing-browser-skill");
  mkdirSync(source, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "fresh browser skill\n");

  symlinkSync(externalTarget, target);
  const before = snapshotTree(target);
  let observedBackup;
  assert.throws(
    () =>
      installAssetDirectory(source, target, {
        beforeActivation: ({ backup, stage }) => {
          observedBackup = backup;
          assert.equal(snapshotTree(target).type, "absent");
          assert.deepEqual(snapshotTree(backup), before);
          assert.equal(snapshotTree(stage).type, "directory");
          assert.equal(snapshotTree(externalTarget).type, "absent");
          throw new Error("injected browser asset activation failure");
        },
      }),
    /injected browser asset activation failure/,
  );
  assert.deepEqual(snapshotTree(target), before);
  assert.equal(snapshotTree(externalTarget).type, "absent");
  assert.equal(snapshotTree(observedBackup).type, "absent");
  assert.deepEqual(browserTransactionArtifacts(target), []);

  const transaction = installAssetDirectory(source, target);
  assert.equal(lstatSync(target).isDirectory(), true);
  assert.equal(
    readFileSync(join(target, "SKILL.md"), "utf8"),
    "fresh browser skill\n",
  );
  assert.equal(snapshotTree(externalTarget).type, "absent");
  transaction.rollback();
  assert.deepEqual(snapshotTree(target), before);
  assert.equal(snapshotTree(externalTarget).type, "absent");
  assert.deepEqual(browserTransactionArtifacts(target), []);
});

test("browser asset replacement preserves a pre-existing dangling backup until commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pipi-browser-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "managed", "browser-chrome");
  const backup = `${target}.rollback-${process.pid}`;
  const externalTarget = join(root, "external", "missing-browser-skill");
  const externalBackupTarget = join(root, "external", "missing-browser-backup");
  mkdirSync(source, { recursive: true });
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "fresh browser skill\n");
  symlinkSync(externalTarget, target);
  symlinkSync(externalBackupTarget, backup);
  const before = {
    target: snapshotTree(target),
    backup: snapshotTree(backup),
  };

  assert.throws(
    () =>
      installAssetDirectory(source, target, {
        beforeActivation: () => {
          assert.equal(snapshotTree(target).type, "absent");
          assert.deepEqual(snapshotTree(backup), before.target);
          throw new Error("injected activation with occupied backup");
        },
      }),
    /injected activation with occupied backup/,
  );
  assert.deepEqual(snapshotTree(target), before.target);
  assert.deepEqual(snapshotTree(backup), before.backup);
  assert.equal(snapshotTree(externalTarget).type, "absent");
  assert.equal(snapshotTree(externalBackupTarget).type, "absent");
  assert.deepEqual(browserTransactionArtifacts(target), [basename(backup)]);

  const rolledBack = installAssetDirectory(source, target);
  rolledBack.rollback();
  assert.deepEqual(snapshotTree(target), before.target);
  assert.deepEqual(snapshotTree(backup), before.backup);
  assert.deepEqual(browserTransactionArtifacts(target), [basename(backup)]);

  const committed = installAssetDirectory(source, target);
  committed.commit();
  assert.equal(lstatSync(target).isDirectory(), true);
  assert.equal(snapshotTree(backup).type, "absent");
  assert.equal(snapshotTree(externalTarget).type, "absent");
  assert.equal(snapshotTree(externalBackupTarget).type, "absent");
  assert.deepEqual(browserTransactionArtifacts(target), []);
});

test("normal and repository-skip reinstall replace a dangling browser skill", async () => {
  for (const skipRepositoryDependencies of [false, true]) {
    const fixture = await createFixture();
    try {
      const browserTarget = join(
        fixture.home,
        ".pipi",
        "agent",
        "skills",
        "browser-chrome",
      );
      const externalTarget = join(
        fixture.home,
        "external",
        "missing-browser-skill",
      );
      mkdirSync(dirname(browserTarget), { recursive: true });
      symlinkSync(externalTarget, browserTarget);

      const result = spawnSync(
        process.execPath,
        [
          installScript,
          ...(skipRepositoryDependencies
            ? ["--skip-repository-dependencies"]
            : []),
          "--codex-tools",
          fixture.codexTools,
        ],
        { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(lstatSync(browserTarget).isDirectory(), true);
      assert.equal(lstatSync(browserTarget).isSymbolicLink(), false);
      assert.equal(
        existsSync(join(browserTarget, "scripts", "control-mcp.sh")),
        true,
      );
      assert.equal(snapshotTree(externalTarget).type, "absent");
      assert.deepEqual(browserTransactionArtifacts(browserTarget), []);
      assert.deepEqual(snapshotManagedState(fixture.home).stages, []);
      const rootPreflights = readFileSync(fixture.bunInstallLog, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.includes(`--cwd ${repositoryRoot}`));
      assert.equal(rootPreflights.length, skipRepositoryDependencies ? 0 : 1);
      assert.equal(existsSync(fixture.npmLog), false);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }
});

test("late managed failure restores a dangling browser skill exactly", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const browserTarget = join(
    fixture.home,
    ".pipi",
    "agent",
    "skills",
    "browser-chrome",
  );
  const externalTarget = join(
    fixture.home,
    "external",
    "missing-browser-skill",
  );
  mkdirSync(dirname(browserTarget), { recursive: true });
  symlinkSync(externalTarget, browserTarget);
  const before = snapshotManagedState(fixture.home);

  const result = spawnSync(
    process.execPath,
    [
      installScript,
      "--skip-repository-dependencies",
      "--codex-tools",
      fixture.codexTools,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...fixture.env,
        PIPI_TEST_FAIL_AFTER_STEP: "launcher-stage",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /after launcher-stage/);
  assert.deepEqual(snapshotManagedState(fixture.home), before);
  assert.equal(snapshotTree(externalTarget).type, "absent");
  assert.deepEqual(browserTransactionArtifacts(browserTarget), []);
  assert.equal(existsSync(fixture.npmLog), false);
});

test("repository preflight remains retryable after a late managed failure", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const authorityBefore = snapshotRepositoryAuthority();
  const managedBefore = snapshotManagedState(fixture.home);

  const failed = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    {
      cwd: repositoryRoot,
      env: {
        ...fixture.env,
        PIPI_TEST_FAIL_AFTER_STEP: "launcher-stage",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /after launcher-stage/);
  assert.deepEqual(snapshotManagedState(fixture.home), managedBefore);
  assert.deepEqual(snapshotRepositoryAuthority(), authorityBefore);

  const retry = spawnSync(
    process.execPath,
    [installScript, "--codex-tools", fixture.codexTools],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(snapshotRepositoryAuthority(), authorityBefore);
  const rootPreflights = readFileSync(fixture.bunInstallLog, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.includes(`--cwd ${repositoryRoot}`));
  assert.equal(rootPreflights.length, 2);
  assert.deepEqual(snapshotManagedState(fixture.home).stages, []);
  assert.equal(existsSync(fixture.npmLog), false);
});

test("normal install replaces a dangling isolated-runtime path with a fresh runtime", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const agentDir = join(fixture.home, ".pipi", "agent");
  const runtime = join(agentDir, "runtime");
  const missingTarget = join(fixture.home, "missing-external-runtime");
  mkdirSync(agentDir, { recursive: true });
  symlinkSync(missingTarget, runtime);

  const result = install(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(runtime).isDirectory(), true);
  assert.equal(lstatSync(runtime).isSymbolicLink(), false);
  assert.equal(existsSync(missingTarget), false);
  assert.equal(
    readJson(
      join(
        runtime,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      ),
    ).piConfig.name,
    "pipi",
  );
});

test("normal reinstall ignores a repository-local Pi shim and refreshes isolated runtime", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const prepared = install(fixture);
  assert.equal(prepared.status, 0, prepared.stderr);
  const runtime = join(fixture.home, ".pipi", "agent", "runtime");
  const staleRuntimeMarker = join(runtime, "mutable-runtime-sentinel");
  const browserEntrypoint = join(
    runtime,
    "node_modules",
    "chrome-devtools-mcp",
    "build",
    "src",
    "bin",
    "chrome-devtools-mcp.js",
  );
  writeFileSync(staleRuntimeMarker, "must be removed by fresh staging\n");
  writeFileSync(
    browserEntrypoint,
    "throw new Error('stale browser dependency');\n",
  );

  const result = spawnSync(
    process.execPath,
    [
      installScript,
      "--skip-repository-dependencies",
      "--codex-tools",
      fixture.codexTools,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...fixture.env,
        PATH: `${join(repositoryRoot, "node_modules", ".bin")}:${fixture.env.PATH}`,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const launcher = readFileSync(
    join(fixture.home, ".local", "bin", "pipi"),
    "utf8",
  );
  assert.match(
    launcher,
    new RegExp(`export PIPI_BUN_RUNTIME='${fixture.fakeBunPath}'`),
  );
  assert.match(
    launcher,
    new RegExp(
      `exec "\\$PIPI_BUN_RUNTIME" '${join(fixture.home, ".pipi", "agent", "runtime", "node_modules", ".bin", "pi")}'`,
    ),
  );
  assert.equal(launcher.includes(join(repositoryRoot, "node_modules")), false);
  assert.equal(existsSync(staleRuntimeMarker), false);
  assert.doesNotMatch(readFileSync(browserEntrypoint, "utf8"), /stale browser/);
  const isolatedInstalls = readFileSync(fixture.bunInstallLog, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.includes("runtime.stage-"));
  assert.equal(isolatedInstalls.length, 2);
  assert.notEqual(isolatedInstalls[0], isolatedInstalls[1]);
  assert.equal(existsSync(fixture.npmLog), false);
});

test("existing Pipi settings retain unrelated values and packages", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const pipiAgentDir = join(fixture.home, ".pipi", "agent");
  mkdirSync(pipiAgentDir, { recursive: true });
  const settingsPath = join(pipiAgentDir, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ quietStartup: true, theme: "old-theme", packages: ["existing-package", repositoryRoot, { source: legacyMcpAdapterPackage, extensions: ["index.ts"] }, { source: legacyPiSubagentsPackage, skills: [] }] }, null, 2)}\n`,
  );
  writeFileSync(
    join(pipiAgentDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { existing: { command: "existing-command" } } }, null, 2)}\n`,
  );
  const staleSkillDir = join(pipiAgentDir, "skills", "browser-chrome");
  mkdirSync(staleSkillDir, { recursive: true });
  writeFileSync(join(staleSkillDir, "stale.txt"), "remove me\n");
  const removedTaskSkill = join(pipiAgentDir, "skills", "aad-task-package");
  mkdirSync(removedTaskSkill, { recursive: true });
  writeFileSync(join(removedTaskSkill, "SKILL.md"), "remove me\n");
  const removedAgent = join(pipiAgentDir, "agents", "chrome-browser-agent.md");
  mkdirSync(dirname(removedAgent), { recursive: true });
  writeFileSync(removedAgent, "remove me\n");
  const removedPackages = ["pi-subagents", "jiti", "typebox", "yaml"].map(
    (name) => join(pipiAgentDir, "npm", "node_modules", name),
  );
  for (const path of removedPackages) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), '{"version":"0.0.0"}\n');
  }
  const removedBins = ["pi-subagents", "jiti", "yaml"].map((name) =>
    join(pipiAgentDir, "npm", "node_modules", ".bin", name),
  );
  for (const path of removedBins) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "remove me\n");
  }

  const result = install(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(settingsPath), {
    quietStartup: true,
    theme: "github-dark-default",
    packages: [
      "existing-package",
      repositoryRoot,
      {
        source: mcpAdapterPackage(fixture.home),
        extensions: ["index.ts"],
      },
      fixture.codexTools,
    ],
  });
  assert.deepEqual(readJson(join(pipiAgentDir, "mcp.json")), {
    mcpServers: {
      existing: { command: "existing-command" },
      ...expectedBrowserMcpServers(fixture.home),
    },
  });
  assert.equal(existsSync(join(staleSkillDir, "stale.txt")), false);
  assert.equal(existsSync(removedTaskSkill), false);
  assert.equal(existsSync(removedAgent), false);
  for (const path of [...removedPackages, ...removedBins]) {
    assert.equal(existsSync(path), false);
  }
});

test("install rejects uninitialized submodules before writing Pipi state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const cloneRoot = join(fixture.home, "pipi-alias-uninitialized");
  execFileSync(
    "git",
    ["clone", "-q", "--no-hardlinks", repositoryRoot, cloneRoot],
    { encoding: "utf8" },
  );
  const result = spawnSync(
    process.execPath,
    [
      join(cloneRoot, "scripts", "install.mjs"),
      "--skip-repository-dependencies",
      "--pi",
      fixture.piPath,
      "--codex-tools",
      fixture.codexTools,
    ],
    { cwd: cloneRoot, env: fixture.env, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Submodule gpt5\.6-reviewer is not initialized/);
  assert.match(result.stderr, /git submodule update --init --recursive/);
  assert.equal(existsSync(join(fixture.home, ".pipi")), false);
  assert.equal(existsSync(join(fixture.home, ".local", "bin", "pipi")), false);
});

test("install rejects every configured missing submodule asset before writing Pipi state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const cloneRoot = join(fixture.home, "pipi-alias-clone");
  execFileSync(
    "git",
    ["clone", "-q", "--no-hardlinks", repositoryRoot, cloneRoot],
    { encoding: "utf8" },
  );
  for (const [name, source] of [
    ["vendor/gpt5.6-reviewer", reviewerSubmodule],
    ["vendor/plan-gh-backlog", backlogSubmodule],
    ["vendor/pi-codex", codexSubmodule],
  ]) {
    execFileSync("git", [
      "-C",
      cloneRoot,
      "config",
      `submodule.${name}.url`,
      source,
    ]);
  }
  execFileSync("git", [
    "-C",
    cloneRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  const submodules = readJson(join(cloneRoot, "config", "submodules.json"));
  for (const submodule of Object.values(submodules.submodules)) {
    execFileSync("git", [
      "-C",
      join(cloneRoot, submodule.path),
      "remote",
      "set-url",
      "origin",
      submodule.url,
    ]);
  }
  for (const [name, submodule] of Object.entries(submodules.submodules)) {
    for (const relativePath of submodule.requiredFiles) {
      const assetPath = join(cloneRoot, submodule.path, relativePath);
      await rm(assetPath);

      const result = spawnSync(
        process.execPath,
        [
          join(cloneRoot, "scripts", "install.mjs"),
          "--skip-repository-dependencies",
          "--pi",
          fixture.piPath,
          "--codex-tools",
          fixture.codexTools,
        ],
        { cwd: cloneRoot, env: fixture.env, encoding: "utf8" },
      );

      assert.notEqual(result.status, 0, `${name}: ${relativePath}`);
      assert.match(
        result.stderr,
        new RegExp(`Missing submodule ${name.replace(".", "\\.")} asset:`),
      );
      assert.equal(result.stderr.includes(relativePath), true, relativePath);
      assert.equal(existsSync(join(fixture.home, ".pipi")), false);
      assert.equal(
        existsSync(join(fixture.home, ".local", "bin", "pipi")),
        false,
      );
      execFileSync("git", [
        "-C",
        join(cloneRoot, submodule.path),
        "restore",
        "--",
        relativePath,
      ]);
    }
  }
});

test("install rejects backlog submodule pin, origin, and cleanliness drift before writing Pipi state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const cloneRoot = join(fixture.home, "pipi-alias-submodule-drift");
  execFileSync(
    "git",
    ["clone", "-q", "--no-hardlinks", repositoryRoot, cloneRoot],
    { encoding: "utf8" },
  );
  for (const [name, source] of [
    ["vendor/gpt5.6-reviewer", reviewerSubmodule],
    ["vendor/plan-gh-backlog", backlogSubmodule],
    ["vendor/pi-codex", codexSubmodule],
  ]) {
    execFileSync("git", [
      "-C",
      cloneRoot,
      "config",
      `submodule.${name}.url`,
      source,
    ]);
  }
  execFileSync("git", [
    "-C",
    cloneRoot,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
  const submodules = readJson(join(cloneRoot, "config", "submodules.json"));
  for (const submodule of Object.values(submodules.submodules)) {
    execFileSync("git", [
      "-C",
      join(cloneRoot, submodule.path),
      "remote",
      "set-url",
      "origin",
      submodule.url,
    ]);
  }
  const backlogRoot = join(cloneRoot, "vendor", "plan-gh-backlog");
  const runCloneInstaller = () =>
    spawnSync(
      process.execPath,
      [
        join(cloneRoot, "scripts", "install.mjs"),
        "--skip-repository-dependencies",
        "--pi",
        fixture.piPath,
        "--codex-tools",
        fixture.codexTools,
      ],
      { cwd: cloneRoot, env: fixture.env, encoding: "utf8" },
    );
  const assertRejectedWithoutState = (result, pattern) => {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(join(fixture.home, ".pipi")), false);
    assert.equal(
      existsSync(join(fixture.home, ".local", "bin", "pipi")),
      false,
    );
  };

  const skillPath = join(backlogRoot, "SKILL.md");
  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\ndrift\n`);
  assertRejectedWithoutState(
    runCloneInstaller(),
    /Submodule plan-gh-backlog has direct worktree changes/,
  );
  execFileSync("git", ["-C", backlogRoot, "restore", "."]);

  execFileSync("git", [
    "-C",
    backlogRoot,
    "remote",
    "set-url",
    "origin",
    "https://example.invalid/plan-gh-backlog.git",
  ]);
  assertRejectedWithoutState(
    runCloneInstaller(),
    /Submodule plan-gh-backlog origin URL does not match configured URL/,
  );
  execFileSync("git", [
    "-C",
    backlogRoot,
    "remote",
    "set-url",
    "origin",
    submodules.submodules["plan-gh-backlog"].url,
  ]);

  execFileSync("git", ["-C", backlogRoot, "config", "user.name", "Pipi Test"]);
  execFileSync("git", [
    "-C",
    backlogRoot,
    "config",
    "user.email",
    "pipi-test@example.invalid",
  ]);
  writeFileSync(
    join(backlogRoot, "README.md"),
    `${readFileSync(join(backlogRoot, "README.md"), "utf8")}\nnext\n`,
  );
  execFileSync("git", ["-C", backlogRoot, "add", "README.md"]);
  execFileSync("git", ["-C", backlogRoot, "commit", "-qm", "test drift"]);
  assertRejectedWithoutState(
    runCloneInstaller(),
    /Submodule plan-gh-backlog worktree is at .* expected/,
  );
});

test("install rejects missing, old, and prerelease Bun before managed mutation", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const oldBun = join(fixture.fakeBin, "old-bun");
  const prereleaseBun = join(fixture.fakeBin, "prerelease-bun");
  writeFileSync(oldBun, "#!/bin/sh\nprintf '1.3.9\\n'\n", { mode: 0o755 });
  writeFileSync(prereleaseBun, "#!/bin/sh\nprintf '1.4.1-canary.2\\n'\n", {
    mode: 0o755,
  });

  for (const [name, bun, pattern] of [
    [
      "missing",
      join(fixture.home, "missing-bun"),
      /Bun >= 1\.4\.0.*PIPI_BUN_RUNTIME/,
    ],
    ["old", oldBun, /Bun >= 1\.4\.0.*unsupported 1\.3\.9/],
    [
      "prerelease",
      prereleaseBun,
      /Bun >= 1\.4\.0.*unsupported 1\.4\.1-canary\.2/,
    ],
  ]) {
    const before = snapshotManagedState(fixture.home);
    const result = install(fixture, ["--bun", bun]);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, pattern, name);
    assert.deepEqual(snapshotManagedState(fixture.home), before, name);
    assert.equal(existsSync(fixture.bunInstallLog), false, name);
    assert.equal(existsSync(fixture.npmLog), false, name);
  }
});

test("install refuses a missing Pi executable before writing files", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const missingPi = join(fixture.home, "missing-pi");

  const result = spawnSync(
    process.execPath,
    [
      installScript,
      "--skip-repository-dependencies",
      "--pi",
      missingPi,
      "--codex-tools",
      fixture.codexTools,
    ],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Pi executable/);
  assert.equal(existsSync(join(fixture.home, ".local", "bin", "pipi")), false);
  assert.equal(existsSync(join(fixture.home, ".pipi")), false);
});

test("install refuses to overwrite an unmanaged launcher", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  mkdirSync(dirname(launcherPath), { recursive: true });
  const unmanagedLauncher = "#!/bin/sh\necho user-owned\n";
  writeFileSync(launcherPath, unmanagedLauncher);

  const result = install(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to replace launcher/);
  assert.equal(readFileSync(launcherPath, "utf8"), unmanagedLauncher);
  assert.equal(existsSync(join(fixture.home, ".pipi")), false);
});

test("auth sharing is explicit and creates a symlink without copying", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const regularAgentDir = join(fixture.home, ".pi", "agent");
  mkdirSync(regularAgentDir, { recursive: true });
  const regularAuthPath = join(regularAgentDir, "auth.json");
  const secret = '{"secret":"link-only"}\n';
  writeFileSync(regularAuthPath, secret);

  const result = install(fixture, ["--share-auth"]);
  assert.equal(result.status, 0, result.stderr);
  const pipiAuthPath = join(fixture.home, ".pipi", "agent", "auth.json");
  assert.equal(lstatSync(pipiAuthPath).isSymbolicLink(), true);
  assert.equal(readlinkSync(pipiAuthPath), regularAuthPath);
  assert.equal(readFileSync(regularAuthPath, "utf8"), secret);
});

test("late installer failures restore the complete prior managed state", async (t) => {
  const steps = [
    "legacy-removals",
    "runtime",
    "browser-assets",
    "browser-boundary",
    "mcp-config",
    "settings-config",
    "model-config",
    "agent-activation",
    "herdr-integration",
    "auth-link",
    "launcher-stage",
    "session-activation",
    "launcher-activation",
  ];

  for (const step of steps) {
    const fixture = await createFixture();
    try {
      addFakeHerdr(fixture);
      const agentDir = join(fixture.home, ".pipi", "agent");
      const sessionDir = join(fixture.home, ".pipi", "sessions");
      const launcher = join(fixture.home, ".local", "bin", "pipi");
      mkdirSync(join(agentDir, "skills", "aad-task-package"), {
        recursive: true,
      });
      mkdirSync(join(agentDir, "npm", "node_modules", "legacy"), {
        recursive: true,
      });
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      mkdirSync(dirname(launcher), { recursive: true });
      writeFileSync(join(agentDir, "settings.json"), '{"prior":true}\n', {
        mode: 0o640,
      });
      writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{}}\n', {
        mode: 0o620,
      });
      writeFileSync(join(agentDir, "models.json"), '{"priorModel":true}\n', {
        mode: 0o600,
      });
      writeFileSync(
        join(agentDir, "extensions", "herdr-agent-state.ts"),
        "// prior integration\n",
        { mode: 0o640 },
      );
      writeFileSync(
        join(agentDir, "skills", "aad-task-package", "SKILL.md"),
        "prior removed skill\n",
      );
      writeFileSync(
        join(agentDir, "npm", "node_modules", "legacy", "state"),
        "prior removed runtime\n",
      );
      writeFileSync(
        join(sessionDir, "prior-session.jsonl"),
        "prior session\n",
        {
          mode: 0o640,
        },
      );
      writeFileSync(
        launcher,
        "#!/bin/sh\n# Managed by pipi-alias installer.\necho prior\n",
        { mode: 0o751 },
      );
      const regularAuth = join(fixture.home, ".pi", "agent", "auth.json");
      mkdirSync(dirname(regularAuth), { recursive: true });
      writeFileSync(regularAuth, '{"secret":"never-read-by-snapshot"}\n', {
        mode: 0o600,
      });

      const before = snapshotManagedState(fixture.home);
      const result = spawnSync(
        process.execPath,
        [
          installScript,
          "--skip-repository-dependencies",
          "--share-auth",
          "--codex-tools",
          fixture.codexTools,
        ],
        {
          cwd: repositoryRoot,
          env: { ...fixture.env, PIPI_TEST_FAIL_AFTER_STEP: step },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0, step);
      assert.match(result.stderr, new RegExp(`after ${step}`), step);
      assert.deepEqual(snapshotManagedState(fixture.home), before, step);
      assert.equal(lstatSync(regularAuth).mode & 0o777, 0o600, step);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }
});

test("a failing late Herdr command restores configs, removals, links, launcher, and modes", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  addFakeHerdr(fixture, { fail: true });
  const agentDir = join(fixture.home, ".pipi", "agent");
  const launcher = join(fixture.home, ".local", "bin", "pipi");
  mkdirSync(join(agentDir, "npm"), { recursive: true });
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), '{"prior":true}\n', {
    mode: 0o640,
  });
  writeFileSync(join(agentDir, "mcp.json"), '{"mcpServers":{}}\n', {
    mode: 0o620,
  });
  writeFileSync(join(agentDir, "npm", "prior"), "restore removal\n");
  writeFileSync(
    launcher,
    "#!/bin/sh\n# Managed by pipi-alias installer.\necho prior\n",
    { mode: 0o751 },
  );
  const before = snapshotManagedState(fixture.home);

  const result = install(fixture);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Failed to install the official Herdr Pi integration/,
  );
  assert.deepEqual(snapshotManagedState(fixture.home), before);
});

test("fresh-state activation failures remove every created managed directory", async (t) => {
  for (const step of [
    "agent-activation",
    "session-activation",
    "launcher-activation",
  ]) {
    const fixture = await createFixture();
    try {
      const before = snapshotManagedState(fixture.home);
      const result = spawnSync(
        process.execPath,
        [
          installScript,
          "--skip-repository-dependencies",
          "--codex-tools",
          fixture.codexTools,
        ],
        {
          cwd: repositoryRoot,
          env: { ...fixture.env, PIPI_TEST_FAIL_AFTER_STEP: step },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0, step);
      assert.deepEqual(snapshotManagedState(fixture.home), before, step);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }
});

test("--skip-dependencies is unsupported before Bun, lock, HOME, launcher, or runtime mutation", async (t) => {
  for (const name of ["path-pi", "counterfeit-runtime"]) {
    const fixture = await createFixture();
    try {
      if (name === "counterfeit-runtime") {
        const runtime = join(fixture.home, ".pipi", "agent", "runtime");
        mkdirSync(runtime, { recursive: true });
        writeFileSync(
          join(runtime, "counterfeit"),
          "mutable runtime must not be reused\n",
        );
      }
      const before = snapshotManagedState(fixture.home);
      const result = spawnSync(
        process.execPath,
        [
          installScript,
          "--skip-dependencies",
          "--codex-tools",
          fixture.codexTools,
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...fixture.env,
            PIPI_BUN_RUNTIME: join(
              fixture.home,
              "counterfeit-bun-that-must-not-be-probed",
            ),
          },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, /--skip-dependencies is unsupported/, name);
      assert.match(result.stderr, /normal frozen Bun installation/, name);
      assert.deepEqual(snapshotManagedState(fixture.home), before, name);
      assert.equal(existsSync(fixture.bunInstallLog), false, name);
      assert.equal(existsSync(fixture.npmLog), false, name);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }
});

test("installer lock recovers dead owners but preserves foreign and malformed locks", async (t) => {
  const deadFixture = await createFixture();
  t.after(() => rm(deadFixture.home, { recursive: true, force: true }));
  const deadToken = randomUUID();
  const deadLock = join(deadFixture.home, ".pipi-install-lock");
  symlinkSync(
    encodeInstallLockOwner({
      version: 1,
      host: hostname(),
      pid: 999_999_999,
      bootId: null,
      processStart: "dead-owner",
      token: deadToken,
    }),
    deadLock,
  );
  const staleStage = join(deadFixture.home, `.pipi-install-stage-${deadToken}`);
  mkdirSync(staleStage);
  writeFileSync(join(staleStage, "partial"), "interrupted\n");
  const recovered = install(deadFixture);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(staleStage), false);
  assert.equal(snapshotTree(deadLock).type, "absent");

  for (const [name, createLock, pattern] of [
    [
      "foreign",
      (path) =>
        symlinkSync(
          encodeInstallLockOwner({
            version: 1,
            host: "foreign-host.invalid",
            pid: 42,
            bootId: null,
            processStart: null,
            token: randomUUID(),
          }),
          path,
        ),
      /belongs to another host/,
    ],
    ["malformed", (path) => mkdirSync(path), /malformed or ambiguous/],
    [
      "truncated",
      (path) => symlinkSync("pipi-install-lock-v1:truncated", path),
      /malformed or ambiguous/,
    ],
  ]) {
    const fixture = await createFixture();
    try {
      const lockPath = join(fixture.home, ".pipi-install-lock");
      createLock(lockPath);
      const result = install(fixture);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stderr, pattern, name);
      assert.notEqual(snapshotTree(lockPath).type, "absent", name);
      assert.equal(existsSync(join(fixture.home, ".pipi")), false, name);
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  }

  const reusedFixture = await createFixture();
  t.after(() => rm(reusedFixture.home, { recursive: true, force: true }));
  symlinkSync(
    encodeInstallLockOwner({
      version: 1,
      host: hostname(),
      pid: process.pid,
      bootId: null,
      processStart: "a-different-process-start-identity",
      token: randomUUID(),
    }),
    join(reusedFixture.home, ".pipi-install-lock"),
  );
  const reused = install(reusedFixture);
  assert.equal(reused.status, 0, reused.stderr);

  const recoveryFixture = await createFixture();
  t.after(() => rm(recoveryFixture.home, { recursive: true, force: true }));
  const recoveryPath = join(
    recoveryFixture.home,
    ".pipi-install-lock.recovery",
  );
  symlinkSync(
    encodeInstallLockOwner({
      version: 1,
      host: hostname(),
      pid: 999_999_999,
      bootId: null,
      processStart: "dead-recovery-owner",
      token: randomUUID(),
    }),
    recoveryPath,
  );
  const recoveredMarker = install(recoveryFixture);
  assert.equal(recoveredMarker.status, 0, recoveredMarker.stderr);
  assert.equal(snapshotTree(recoveryPath).type, "absent");

  const liveRecoveryFixture = await createFixture();
  t.after(() => rm(liveRecoveryFixture.home, { recursive: true, force: true }));
  const liveRecoveryPath = join(
    liveRecoveryFixture.home,
    ".pipi-install-lock.recovery",
  );
  symlinkSync(
    encodeInstallLockOwner({
      version: 1,
      host: hostname(),
      pid: process.pid,
      bootId: null,
      processStart: null,
      token: randomUUID(),
    }),
    liveRecoveryPath,
  );
  const liveRecovery = install(liveRecoveryFixture);
  assert.notEqual(liveRecovery.status, 0);
  assert.match(liveRecovery.stderr, /recovering stale ownership/);
  assert.notEqual(snapshotTree(liveRecoveryPath).type, "absent");
});

test("SIGKILL-left installer ownership is recovered on retry", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const holdMarker = join(fixture.home, "bun-holding");
  const child = spawn(
    process.execPath,
    [
      installScript,
      "--skip-repository-dependencies",
      "--codex-tools",
      fixture.codexTools,
    ],
    {
      cwd: repositoryRoot,
      env: { ...fixture.env, PIPI_TEST_BUN_HOLD_MARKER: holdMarker },
      stdio: "ignore",
    },
  );
  for (
    let attempt = 0;
    attempt < 500 && !existsSync(holdMarker);
    attempt += 1
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.equal(existsSync(holdMarker), true);
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  assert.notEqual(
    snapshotTree(join(fixture.home, ".pipi-install-lock")).type,
    "absent",
  );

  const retry = install(fixture);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(
    snapshotTree(join(fixture.home, ".pipi-install-lock")).type,
    "absent",
  );
  assert.equal(
    readdirSync(fixture.home).some((entry) =>
      entry.startsWith(".pipi-install-stage-"),
    ),
    false,
  );
});

test("installed direct browser, install-local, and generated MCP paths stay on pinned Bun", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  const installed = install(fixture);
  assert.equal(installed.status, 0, installed.stderr);
  const skill = join(
    fixture.home,
    ".pipi",
    "agent",
    "skills",
    "browser-chrome",
  );
  const directEnv = {
    ...fixture.env,
    BROWSER_CHROME_HEADED_URL: "http://127.0.0.1:9233",
  };
  delete directEnv.PIPI_BUN_RUNTIME;
  delete directEnv.BROWSER_CHROME_NPX;
  delete directEnv.BROWSER_CHROME_MCP_PACKAGE;
  const direct = JSON.parse(
    execFileSync(
      join(skill, "scripts", "mcp.sh"),
      ["headed", "argument with spaces"],
      {
        env: directEnv,
        encoding: "utf8",
      },
    ),
  );
  assert.equal(direct.bunVersion, process.versions.bun);
  assert.equal(direct.noUpdateChecks, "1");
  assert.deepEqual(direct.args, [
    "--no-usage-statistics",
    "--no-performance-crux",
    "--browser-url=http://127.0.0.1:9233",
    "argument with spaces",
  ]);

  const localInstall = execFileSync(
    join(skill, "scripts", "install-local.sh"),
    [],
    {
      env: fixture.env,
      encoding: "utf8",
    },
  );
  assert.match(localInstall, /Installed Bun-safe browser-chrome MCP wiring/);
  assert.deepEqual(
    readJson(join(fixture.home, ".pipi", "agent", "mcp.json")).mcpServers,
    expectedBrowserMcpServers(fixture.home),
  );

  const alternateAgent = join(fixture.home, "alternate-agent");
  const alternateSkill = join(alternateAgent, "skills", "browser-chrome");
  const alternateMcp = join(alternateAgent, "mcp.json");
  execFileSync(join(skill, "scripts", "install-local.sh"), [], {
    env: {
      ...fixture.env,
      PI_AGENT_DIR: alternateAgent,
      BROWSER_CHROME_SKILL_TARGET: alternateSkill,
      BROWSER_CHROME_MCP_JSON: alternateMcp,
    },
  });
  const alternateServers = readJson(alternateMcp).mcpServers;
  assert.equal(
    alternateServers["browser-chrome-headed"].command,
    join(alternateSkill, "scripts", "mcp.sh"),
  );
  const alternateDirect = JSON.parse(
    execFileSync(
      join(alternateSkill, "scripts", "mcp.sh"),
      ["headed", "alternate target argument"],
      { env: directEnv, encoding: "utf8" },
    ),
  );
  assert.equal(alternateDirect.bunVersion, process.versions.bun);
  assert.equal(alternateDirect.noUpdateChecks, "1");
  assert.equal(alternateDirect.args.at(-1), "alternate target argument");

  const invalid = spawnSync(join(skill, "scripts", "mcp.sh"), ["headed"], {
    env: { ...directEnv, PIPI_BUN_RUNTIME: join(fixture.home, "wrong-bun") },
    encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /must match the recorded Pipi Bun runtime/);
  assert.equal(existsSync(fixture.npmLog), false);

  const control = join(skill, "scripts", "control-mcp.sh");
  const controlServer = join(skill, "control-mcp", "server.mjs");
  const controlLog = join(fixture.home, "control-starts.jsonl");
  writeFileSync(
    controlServer,
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.PIPI_TEST_CONTROL_LOG, JSON.stringify({ args: process.argv.slice(2), runtime: process.execPath, bunVersion: process.versions.bun }) + "\\n");
`,
  );
  const controlEnv = {
    ...directEnv,
    PIPI_TEST_CONTROL_LOG: controlLog,
  };
  execFileSync(control, ["argument with spaces", "--flag=value"], {
    env: controlEnv,
  });
  execFileSync(control, ["matching runtime"], {
    env: { ...controlEnv, PIPI_BUN_RUNTIME: fixture.fakeBunPath },
  });
  const allowedStarts = readFileSync(controlLog, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(allowedStarts[0].args, [
    "--skill-dir",
    skill,
    "argument with spaces",
    "--flag=value",
  ]);
  assert.equal(allowedStarts[0].bunVersion, process.versions.bun);
  assert.equal(allowedStarts[1].args.at(-1), "matching runtime");
  rmSync(controlLog);

  const alternateBun = join(fixture.fakeBin, "alternate-bun");
  writeFileSync(alternateBun, "#!/bin/sh\nprintf '1.4.0\\n'\n", {
    mode: 0o755,
  });
  for (const [name, override] of [
    ["alternate", alternateBun],
    ["missing", join(fixture.home, "missing-bun")],
  ]) {
    const rejected = spawnSync(control, [], {
      env: { ...controlEnv, PIPI_BUN_RUNTIME: override },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0, name);
    assert.match(
      rejected.stderr,
      /PIPI_BUN_RUNTIME must match the recorded Pipi Bun runtime/,
      name,
    );
    assert.equal(existsSync(controlLog), false, name);
  }

  const recordedBunBytes = readFileSync(fixture.fakeBunPath);
  const recordedBunMode = lstatSync(fixture.fakeBunPath).mode & 0o777;
  const savedBun = `${fixture.fakeBunPath}.saved`;
  renameSync(fixture.fakeBunPath, savedBun);
  const missingRecorded = spawnSync(control, [], {
    env: { ...controlEnv, PIPI_BUN_RUNTIME: fixture.fakeBunPath },
    encoding: "utf8",
  });
  assert.notEqual(missingRecorded.status, 0);
  assert.match(missingRecorded.stderr, /not executable/);
  assert.equal(existsSync(controlLog), false);
  renameSync(savedBun, fixture.fakeBunPath);

  for (const [name, version] of [
    ["prerelease", "1.4.0-beta.1"],
    ["fake", "not-bun"],
  ]) {
    writeFileSync(
      fixture.fakeBunPath,
      `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '${version}\\n'; exit 0; fi\necho server-must-not-start >&2\nexit 91\n`,
      { mode: recordedBunMode },
    );
    const rejected = spawnSync(control, [], {
      env: { ...controlEnv, PIPI_BUN_RUNTIME: fixture.fakeBunPath },
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0, name);
    assert.match(rejected.stderr, /must remain stable version/, name);
    assert.equal(existsSync(controlLog), false, name);
  }
  writeFileSync(fixture.fakeBunPath, recordedBunBytes, {
    mode: recordedBunMode,
  });
  assert.equal(existsSync(fixture.npmLog), false);

  const installedText = [
    readFileSync(join(skill, "scripts", "control-mcp.sh"), "utf8"),
    readFileSync(join(skill, "scripts", "mcp.sh"), "utf8"),
    readFileSync(join(skill, "scripts", "install-local.sh"), "utf8"),
    readFileSync(join(skill, "README.md"), "utf8"),
    readFileSync(join(skill, "references", "mcp-config.md"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(installedText, /chrome-devtools-mcp@latest/);
  assert.doesNotMatch(installedText, /(?:^|\s)npx(?:\s|$)/m);
});

test("removed Bun bootstrap surfaces are absent from the active package, API, and docs", () => {
  assert.equal(
    existsSync(join(repositoryRoot, "scripts", "bootstrap-bun.sh")),
    false,
  );
  assert.equal(
    existsSync(
      join(repositoryRoot, "tests", "scripts", "bootstrap-bun.test.mjs"),
    ),
    false,
  );
  const manifest = readJson(join(repositoryRoot, "package.json"));
  assert.equal(Object.hasOwn(manifest.scripts, "bootstrap:bun"), false);

  const installerSource = readFileSync(installScript, "utf8");
  assert.doesNotMatch(installerSource, /bootstrap-bun|pipi-bun-bootstrap/);
  assert.doesNotMatch(
    installerSource,
    /validateIsolatedBunRuntime|skipDependencies/,
  );
  const help = spawnSync(process.execPath, [installScript, "--help"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--skip-dependencies/);

  for (const path of ["README.md", "SETUP.md", "docs/bun-runtime.md"]) {
    const text = readFileSync(join(repositoryRoot, path), "utf8");
    assert.doesNotMatch(
      text,
      /bootstrap-bun|pipi-bun-bootstrap|pipi-bootstrap-recovery/,
      path,
    );
  }
});

test("uninstall removes only the managed launcher unless purge is explicit", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = install(fixture);
  assert.equal(result.status, 0, result.stderr);
  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  const pipiDir = join(fixture.home, ".pipi");

  const uninstall = spawnSync(process.execPath, [uninstallScript], {
    cwd: repositoryRoot,
    env: fixture.env,
    encoding: "utf8",
  });
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.equal(existsSync(launcherPath), false);
  assert.equal(existsSync(pipiDir), true);

  const reinstall = install(fixture);
  assert.equal(reinstall.status, 0, reinstall.stderr);
  const purge = spawnSync(process.execPath, [uninstallScript, "--purge"], {
    cwd: repositoryRoot,
    env: fixture.env,
    encoding: "utf8",
  });
  assert.equal(purge.status, 0, purge.stderr);
  assert.equal(existsSync(launcherPath), false);
  assert.equal(existsSync(pipiDir), false);
});

test("removed web provider is absent from tracked source and manifests", () => {
  const removedProvider = ["fire", "crawl"].join("");
  const trackedFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n")
    .filter((path) => path && existsSync(join(repositoryRoot, path)));
  const matchingPaths = trackedFiles.filter((path) =>
    path.toLowerCase().includes(removedProvider),
  );
  assert.deepEqual(matchingPaths, []);

  const matchingContents = trackedFiles.filter((path) => {
    if (path === "assets/pi-setup.jpeg") return false;
    const absolutePath = join(repositoryRoot, path);
    if (!lstatSync(absolutePath).isFile()) return false;
    return readFileSync(absolutePath, "utf8")
      .toLowerCase()
      .includes(removedProvider);
  });
  assert.deepEqual(matchingContents, []);
});
