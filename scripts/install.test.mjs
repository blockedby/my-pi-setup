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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installScript = join(repositoryRoot, "scripts", "install.mjs");
const uninstallScript = join(repositoryRoot, "scripts", "uninstall.mjs");
const mcpAdapterPackage = "npm:pi-mcp-adapter@2.15.0";
const legacyMcpAdapterPackage = "npm:pi-mcp-adapter";

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
  writeFileSync(
    join(regularAgentDir, "mcp.json"),
    '{"mcpServers":{"private":{"env":{"API_KEY":"must-not-copy"}}}}\n',
  );

  const first = install(fixture);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Codex CLI:/);

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
  assert.equal(
    existsSync(join(fixture.home, ".pipi", "agent", "mcp.json")),
    false,
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
    agentDir: join(fixture.home, ".pipi", "agent"),
    sessionDir: join(fixture.home, ".pipi", "sessions"),
    codex: fixture.codexPath,
    args: ["--version", "argument with spaces"],
  });

  const firstLauncher = readFileSync(launcherPath, "utf8");
  const firstSettings = readFileSync(settingsPath, "utf8");
  const second = install(fixture);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(launcherPath, "utf8"), firstLauncher);
  assert.equal(readFileSync(settingsPath, "utf8"), firstSettings);
  assert.equal(readFileSync(regularSettingsPath, "utf8"), regularSettings);
});

test("default Pi resolution ignores npm's repository-local binary shim", async (t) => {
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
    `${JSON.stringify({ quietStartup: true, theme: "old-theme", packages: ["existing-package", repositoryRoot, { source: legacyMcpAdapterPackage, extensions: ["index.ts"] }] }, null, 2)}\n`,
  );

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
    return readFileSync(join(repositoryRoot, path), "utf8")
      .toLowerCase()
      .includes(removedProvider);
  });
  assert.deepEqual(matchingContents, []);
});
