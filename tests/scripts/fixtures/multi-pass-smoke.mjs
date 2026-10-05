import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Socket } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getDeclaredPipiVersion } from "../../../scripts/pipi-version.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const { values } = parseArgs({
  options: {
    "sdk-root": {
      type: "string",
      default: join(
        repositoryRoot,
        "node_modules/@earendil-works/pi-coding-agent",
      ),
    },
    "package-root": {
      type: "string",
      default: join(repositoryRoot, "node_modules/pi-multi-pass"),
    },
  },
});
const packageRoot = resolve(values["package-root"]);
assert.equal(
  JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
  "1.5.1",
);
const runtimeVersion = JSON.parse(
  readFileSync(join(values["sdk-root"], "package.json"), "utf8"),
).version;
assert.equal(
  runtimeVersion,
  getDeclaredPipiVersion(
    JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")),
  ),
);
const home = mkdtempSync(join(tmpdir(), "pipi-multi-pass-sdk-"));
const agentDir = join(home, ".pipi", "agent");
const cwd = join(home, "workspace");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd);
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PIPI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
delete process.env.MULTI_SUB;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
delete process.env.PIPI_CODING_AGENT_SESSION_DIR;
let networkRequests = 0;
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function () {
  networkRequests++;
  throw new Error("Socket connections forbidden in multi-pass smoke");
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  networkRequests++;
  throw new Error("Network forbidden in multi-pass smoke");
};
let session;
try {
  const sdk = await import(
    pathToFileURL(join(values["sdk-root"], "dist/index.js")).href
  );
  const credentials = Object.fromEntries(
    ["openai-codex", "openai-codex-2"].map((provider) => [
      provider,
      {
        type: "oauth",
        access: "synthetic-access-" + provider,
        refresh: "synthetic-refresh-" + provider,
        expires: Date.now() + 3600000,
        accountId: "synthetic-" + provider,
      },
    ]),
  );
  const authPath = join(agentDir, "auth.json");
  writeFileSync(authPath, JSON.stringify(credentials), { mode: 0o600 });
  const before = readFileSync(authPath);
  const settingsManager = sdk.SettingsManager.inMemory(
    {
      packages: [packageRoot],
      defaultProvider: "openai-codex",
      defaultModel: "gpt-6.1-sol",
      retry: { enabled: false },
    },
    { projectTrusted: false },
  );
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.equal(sdk.getAgentDir(), agentDir);
  let loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings, []);
  assert.equal(loaded.extensions.length, 1);
  const ext = loaded.extensions[0];
  assert.equal(ext.resolvedPath, join(packageRoot, "extensions/multi-sub.ts"));
  assert.deepEqual([...ext.commands.keys()].sort(), [
    "mp-preset",
    "pool",
    "subs",
  ]);
  const runtime = await sdk.ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const createSession = async () => {
    ({ session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      modelRuntime: runtime,
      sessionManager: sdk.SessionManager.inMemory(cwd),
      noTools: "all",
      model: runtime.getModel("openai-codex", "gpt-6.1-sol"),
    }));
    await session.bindExtensions({});
    await runtime.refresh({ allowNetwork: false });
  };
  await createSession();
  const errors = [];
  const exerciseNoPoolError = async () => {
    session.extensionRunner.onError((error) => errors.push(error));
    let switches = 0;
    let retries = 0;
    const originalSetModel = loaded.runtime.setModel;
    const originalSendUserMessage = loaded.runtime.sendUserMessage;
    loaded.runtime.setModel = async (...args) => {
      switches++;
      return originalSetModel(...args);
    };
    loaded.runtime.sendUserMessage = () => {
      retries++;
      throw new Error("Unexpected extension retry");
    };
    const model = session.model;
    try {
      await session.extensionRunner.emitBeforeAgentStart(
        "synthetic prompt",
        undefined,
        "synthetic system prompt",
      );
      await session.extensionRunner.emit({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        ],
      });
      assert.equal(session.model, model);
      assert.equal(switches, 0);
      assert.equal(retries, 0);
      assert.deepEqual(session.getFollowUpMessages(), []);
    } finally {
      loaded.runtime.setModel = originalSetModel;
      loaded.runtime.sendUserMessage = originalSendUserMessage;
    }
  };
  // Real default: no global or project configuration exists.
  await exerciseNoPoolError();
  assert.equal(existsSync(join(agentDir, "multi-pass.json")), false);
  assert.equal(existsSync(join(cwd, ".pi/multi-pass.json")), false);
  session.dispose();
  // Only the temporary manual scenario declares an extra subscription; no pools.
  writeFileSync(
    join(agentDir, "multi-pass.json"),
    JSON.stringify({
      subscriptions: [
        { provider: "openai-codex", index: 2, label: "secondary" },
      ],
      pools: [],
      chains: [],
      presets: [],
    }),
  );
  await loader.reload();
  loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  await createSession();
  const command = session.extensionRunner.getCommand("subs");
  assert.ok(command);
  for (const provider of ["openai-codex-2", "openai-codex"]) {
    await command.handler(
      "switch " + provider,
      session.extensionRunner.createCommandContext(),
    );
    assert.equal(session.model.provider, provider);
    assert.equal(session.model.id, "gpt-6.1-sol");
  }
  await exerciseNoPoolError();
  assert.deepEqual(errors, []);
  assert.deepEqual(readFileSync(authPath), before);
  assert.equal(networkRequests, 0);
  console.log(
    JSON.stringify({
      passed: true,
      runtime: runtimeVersion,
      package: "1.5.1",
      sameModelBothDirections: true,
      authUnchanged: true,
      defaultNoPoolSwitches: 0,
      defaultNoPoolRetries: 0,
      networkRequests,
    }),
  );
} finally {
  session?.dispose();
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
  rmSync(home, { recursive: true, force: true });
}
