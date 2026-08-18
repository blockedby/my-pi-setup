import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const installScript = join(repositoryRoot, "scripts", "install.mjs");
const uninstallScript = join(repositoryRoot, "scripts", "uninstall.mjs");
const mcpAdapterPackage = "npm:pi-mcp-adapter@2.15.0";
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
  writeFileSync(
    piPath,
    `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const codex = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
process.stdout.write(JSON.stringify({
  pipiProfile: process.env.PIPI_PROFILE,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  codex,
  args: process.argv.slice(2),
}));
`,
  );
  chmodSync(piPath, 0o755);

  const codexPath = join(fakeBin, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nprintf 'codex-test\\n'\n");
  chmodSync(codexPath, 0o755);

  const npmPath = join(fakeBin, "npm");
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const { chmodSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "install") {
  const prefix = args[args.indexOf("--prefix") + 1];
  const spec = args.at(-1);
  if (args.includes("--no-save"))
    rmSync(join(prefix, "node_modules"), { recursive: true, force: true });
  const separator = spec.lastIndexOf("@");
  const packageName = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  const manifestPath = join(prefix, "package.json");
  const manifest = require("node:fs").existsSync(manifestPath)
    ? JSON.parse(require("node:fs").readFileSync(manifestPath, "utf8"))
    : { private: true, dependencies: {} };
  manifest.dependencies[packageName] = args.includes("--save-exact")
    ? version
    : "^" + version;
  mkdirSync(prefix, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  if (spec.startsWith("@earendil-works/pi-coding-agent@")) {
    const binDir = join(prefix, "node_modules", ".bin");
    mkdirSync(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(prefix, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), JSON.stringify({ version }));
    const piPath = join(binDir, "pi");
    writeFileSync(piPath, '#!/usr/bin/env node\\nprocess.stdout.write(JSON.stringify({ pipiProfile: process.env.PIPI_PROFILE, agentDir: process.env.PI_CODING_AGENT_DIR, args: process.argv.slice(2) }));\\n');
    chmodSync(piPath, 0o755);
  }
  if (spec.startsWith("pi-mcp-adapter@")) {
    const packageDir = join(prefix, "node_modules", "pi-mcp-adapter");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: spec.slice(spec.lastIndexOf("@") + 1) }));
  }
}
`,
  );
  chmodSync(npmPath, 0o755);
  writeFileSync(
    join(codexTools, "package.json"),
    JSON.stringify({ name: "pi-codex-tools" }),
  );

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };

  return { home, fakeBin, piPath, codexPath, codexTools, env };
};

const install = (fixture, extraArgs = []) =>
  spawnSync(
    process.execPath,
    [
      installScript,
      "--skip-dependencies",
      "--pi",
      fixture.piPath,
      "--codex-tools",
      fixture.codexTools,
      ...extraArgs,
    ],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const expectedBrowserMcpServers = (home) => {
  const skillDir = join(home, ".pipi", "agent", "skills", "browser-chrome");
  const commonEnv = { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" };
  return {
    "browser-chrome-control": {
      command: join(skillDir, "scripts", "control-mcp.sh"),
      args: [],
      lifecycle: "lazy",
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

  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  const settingsPath = join(fixture.home, ".pipi", "agent", "settings.json");
  assert.equal(existsSync(launcherPath), true);
  assert.equal(lstatSync(launcherPath).mode & 0o111, 0o111);
  assert.equal(readFileSync(regularSettingsPath, "utf8"), regularSettings);
  assert.equal(
    existsSync(join(fixture.home, ".pipi", "agent", "auth.json")),
    false,
  );

  const settings = readJson(settingsPath);
  assert.equal(settings.defaultProvider, "provider-test");
  assert.equal(settings.defaultModel, "model-test");
  assert.equal(settings.defaultThinkingLevel, "high");
  assert.equal(settings.theme, "github-dark-default");
  assert.deepEqual(settings.packages, [
    repositoryRoot,
    mcpAdapterPackage,
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

test("Pi package, SDK, TUI, and TypeBox dependencies remain aligned", () => {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const lockfile = readJson(join(repositoryRoot, "package-lock.json"));
  const rootPackages = lockfile.packages;

  for (const packageName of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ]) {
    assert.equal(manifest.dependencies[packageName], `^${runtimePiVersion}`);
    assert.equal(
      rootPackages[`node_modules/${packageName}`].version,
      runtimePiVersion,
    );
  }
  assert.equal(manifest.dependencies.typebox, "^1.3.7");
  assert.equal(rootPackages["node_modules/typebox"].version, "1.3.7");

  const codingAgent = rootPackages[`node_modules/${runtimePiPackage}`];
  assert.deepEqual(
    {
      "@earendil-works/pi-agent-core":
        codingAgent.dependencies["@earendil-works/pi-agent-core"],
      "@earendil-works/pi-ai":
        codingAgent.dependencies["@earendil-works/pi-ai"],
      "@earendil-works/pi-tui":
        codingAgent.dependencies["@earendil-works/pi-tui"],
      typebox: codingAgent.dependencies.typebox,
    },
    {
      "@earendil-works/pi-agent-core": `^${runtimePiVersion}`,
      "@earendil-works/pi-ai": `^${runtimePiVersion}`,
      "@earendil-works/pi-tui": `^${runtimePiVersion}`,
      typebox: "1.3.7",
    },
  );
});

test("package loads the canonical submodule code-review skill once", () => {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const submodules = readJson(
    join(repositoryRoot, "config", "submodules.json"),
  );
  const reviewer = submodules.submodules["gpt5.6-reviewer"];

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
  const pipiNpm = join(fixture.home, ".pipi", "agent", "npm");
  assert.equal(
    readJson(
      join(
        pipiNpm,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "package.json",
      ),
    ).version,
    runtimePiVersion,
  );
  assert.equal(
    readJson(join(pipiNpm, "node_modules", "pi-mcp-adapter", "package.json"))
      .version,
    "2.15.0",
  );
  const isolatedManifest = readJson(join(pipiNpm, "package.json"));
  assert.deepEqual(isolatedManifest.dependencies, {
    "@earendil-works/pi-coding-agent": runtimePiVersion,
    "pi-mcp-adapter": "2.15.0",
  });
  assert.deepEqual(isolatedManifest.allowScripts, {
    "@google/genai@1.52.0": true,
    "protobufjs@7.6.5": true,
  });
  const launcherPath = join(fixture.home, ".local", "bin", "pipi");
  const launcher = readFileSync(launcherPath, "utf8");
  assert.match(
    launcher,
    new RegExp(`exec '${join(pipiNpm, "node_modules", ".bin", "pi")}'`),
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
      args: ["--version"],
    },
  );

  const skipped = spawnSync(
    process.execPath,
    [installScript, "--skip-dependencies", "--codex-tools", fixture.codexTools],
    { cwd: repositoryRoot, env: fixture.env, encoding: "utf8" },
  );
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(readFileSync(launcherPath, "utf8"), launcher);
});

test("install repairs non-exact isolated package metadata", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const pipiNpm = join(fixture.home, ".pipi", "agent", "npm");
  const piPackageDir = join(
    pipiNpm,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const mcpPackageDir = join(pipiNpm, "node_modules", "pi-mcp-adapter");
  const binDir = join(pipiNpm, "node_modules", ".bin");
  mkdirSync(piPackageDir, { recursive: true });
  mkdirSync(mcpPackageDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(pipiNpm, "package.json"),
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
  const isolatedManifest = readJson(join(pipiNpm, "package.json"));
  assert.deepEqual(isolatedManifest.dependencies, {
    "@earendil-works/pi-coding-agent": runtimePiVersion,
    "pi-mcp-adapter": "2.15.0",
  });
  assert.deepEqual(isolatedManifest.allowScripts, {
    "@google/genai@1.52.0": true,
    "protobufjs@7.6.5": true,
  });
});

test("skipped dependency installation ignores npm's repository-local binary shim", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    [installScript, "--skip-dependencies", "--codex-tools", fixture.codexTools],
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
  assert.match(launcher, new RegExp(`exec '${fixture.piPath}'`));
  assert.equal(launcher.includes(join(repositoryRoot, "node_modules")), false);
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
      { source: mcpAdapterPackage, extensions: ["index.ts"] },
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

test("install rejects an uninitialized reviewer submodule before writing Pipi state", async (t) => {
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
      "--skip-dependencies",
      "--pi",
      fixture.piPath,
      "--codex-tools",
      fixture.codexTools,
    ],
    { cwd: cloneRoot, env: fixture.env, encoding: "utf8" },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Reviewer submodule is not initialized/);
  assert.match(result.stderr, /git submodule update --init --recursive/);
  assert.equal(existsSync(join(fixture.home, ".pipi")), false);
  assert.equal(existsSync(join(fixture.home, ".local", "bin", "pipi")), false);
});

test("install rejects every configured missing reviewer asset before writing Pipi state", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));

  const cloneRoot = join(fixture.home, "pipi-alias-clone");
  execFileSync(
    "git",
    ["clone", "-q", "--no-hardlinks", repositoryRoot, cloneRoot],
    { encoding: "utf8" },
  );
  execFileSync("git", [
    "-C",
    cloneRoot,
    "config",
    "submodule.vendor/gpt5.6-reviewer.url",
    reviewerSubmodule,
  ]);
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
  const reviewer = submodules.submodules["gpt5.6-reviewer"];
  for (const relativePath of reviewer.requiredFiles) {
    const assetPath = join(cloneRoot, reviewer.path, relativePath);
    const original = readFileSync(assetPath);
    await rm(assetPath);

    const result = spawnSync(
      process.execPath,
      [
        join(cloneRoot, "scripts", "install.mjs"),
        "--skip-dependencies",
        "--pi",
        fixture.piPath,
        "--codex-tools",
        fixture.codexTools,
      ],
      { cwd: cloneRoot, env: fixture.env, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0, relativePath);
    assert.match(result.stderr, /Missing reviewer submodule asset:/);
    assert.equal(result.stderr.includes(relativePath), true, relativePath);
    assert.equal(existsSync(join(fixture.home, ".pipi")), false);
    assert.equal(
      existsSync(join(fixture.home, ".local", "bin", "pipi")),
      false,
    );
    writeFileSync(assetPath, original);
  }
});

test("install refuses a missing Pi executable before writing files", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.home, { recursive: true, force: true }));
  fixture.piPath = join(fixture.home, "missing-pi");

  const result = install(fixture);
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
