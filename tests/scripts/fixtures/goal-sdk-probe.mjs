import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// One subprocess per scenario: isolate SDK globals, extension timers and credentials.
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const sdkRoot = resolve(
  process.argv[4] ??
    join(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent"),
);
const packageRoot = resolve(
  process.argv[2] ?? join(repositoryRoot, "node_modules/@narumitw/pi-goal"),
);
const scenario = process.argv[3] ?? "completion";
const longPlan = scenario === "long-plan";
const unlimited = ["unlimited", "unlimited-repeat", "long-plan"].includes(
  scenario,
);
const workTarget = longPlan ? 1125 : 3;
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
assert.equal(manifest.name, "@narumitw/pi-goal");
assert.equal(manifest.version, "0.54.8");
assert.deepEqual(manifest.pi.extensions, ["./dist/index.ts"]);
const home = mkdtempSync(join(tmpdir(), "pipi-goal-sdk-"));
const agentDir = join(home, "agent");
const cwd = join(home, "workspace");
mkdirSync(agentDir);
mkdirSync(cwd);
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PIPI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
for (const name of Object.keys(process.env)) {
  if (
    /API_KEY|TOKEN|SECRET|PASSWORD/.test(name) ||
    name.endsWith("SESSION_DIR")
  )
    delete process.env[name];
}
delete process.env.MULTI_SUB;
let networkRequests = 0;
Socket.prototype.connect = function () {
  networkRequests++;
  throw new Error("Network forbidden in goal SDK probe");
};
globalThis.fetch = async () => {
  networkRequests++;
  throw new Error("Network forbidden in goal SDK probe");
};
const deadline = setTimeout(
  () => {
    console.error("Goal probe deadline exceeded");
    process.exit(2);
  },
  longPlan ? 35000 : 15000,
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let session;
try {
  const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
  const ai = await import("@earendil-works/pi-ai");
  const { Type } = await import("typebox");
  const runtimeVersion = JSON.parse(
    readFileSync(join(sdkRoot, "package.json"), "utf8"),
  ).version;
  assert.equal(runtimeVersion, "1.0.3");
  const authPath = join(agentDir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      "goal-probe": { type: "api_key", key: "synthetic-only" },
    }),
    { mode: 0o600 },
  );
  if (scenario === "coexist") {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    for (const provider of ["openai-codex", "openai-codex-2"])
      auth[provider] = {
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() + 3600000,
        accountId: "synthetic-account",
      };
    writeFileSync(authPath, JSON.stringify(auth));
    writeFileSync(
      join(agentDir, "multi-pass.json"),
      JSON.stringify({
        subscriptions: [{ provider: "openai-codex", index: 2 }],
        pools: [],
        chains: [],
        presets: [],
      }),
    );
  }
  const authBefore = readFileSync(authPath);
  if (unlimited)
    writeFileSync(
      join(agentDir, "pi-goal.json"),
      JSON.stringify({
        continuationLimits: {
          automaticTurns: null,
          ...(scenario !== "unlimited" ? { noProgressTurns: null } : {}),
        },
        rpc: { enabled: false },
      }),
    );
  const settingsManager = sdk.SettingsManager.inMemory(
    {
      packages: [
        packageRoot,
        ...(["coexist", "production"].includes(scenario)
          ? [join(repositoryRoot, "node_modules/pi-multi-pass")]
          : []),
        ...(scenario === "production"
          ? [repositoryRoot, join(repositoryRoot, "adapters/codex-tools")]
          : []),
      ],
      retry: { enabled: false },
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    },
    { projectTrusted: false },
  );
  let requests = 0;
  let starts = 0;
  let settled = 0;
  let humanMessages = 0;
  let workStages = 0;
  let observedAutomaticResponses = 0;
  let finishLongPlan;
  const longPlanFinished = new Promise((resolve) => {
    finishLongPlan = resolve;
  });
  const errors = [];
  const notifications = [];
  const results = [];
  const transitions = [];
  const rpcEvents = [];
  let eventBus;
  let contextContract;
  const state = () =>
    session.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === "goal-state")
      .at(-1)?.data.goal;
  const call = (name, args) => [
    { type: "toolCall", id: "call-" + requests, name, arguments: args },
  ];
  const text = (value) => [{ type: "text", text: value }];
  const objective =
    "Write a deterministic artifact and verify recorded work stages";
  let goalRequest = 0;
  let compacting = false;
  let boundaryStop;
  let capturedId;
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        eventBus = pi.events;
        pi.on("context", (event) => {
          contextContract = event.messages
            .filter(
              (message) =>
                message.role === "custom" &&
                message.customType === "goal-contract",
            )
            .at(-1)?.details;
        });
        pi.events.on("pi-goal:event:synthetic-default-off", (event) =>
          rpcEvents.push(event),
        );
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary:
              "Synthetic compaction retains the objective in persisted goal state.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }));
        pi.registerTool({
          name: "probe_write",
          label: "Probe artifact",
          description: "Record a deterministic work stage",
          parameters: Type.Object({}),
          execute: async () => {
            workStages++;
            writeFileSync(
              join(cwd, "outcome.json"),
              JSON.stringify({ workStages, goalId: state()?.id }),
            );
            return { content: text("Stage recorded"), details: { workStages } };
          },
        });
        pi.registerProvider("goal-probe", {
          api: "goal-probe-api",
          apiKey: "synthetic-only",
          baseUrl: "https://invalid.invalid",
          models: [
            {
              id: "deterministic",
              name: "Deterministic",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100000,
              maxTokens: 1000,
            },
          ],
          streamSimple: (model) => {
            requests++;
            assert.ok(
              requests <= (longPlan ? 1130 : 60),
              "bounded provider requests",
            );
            const stream = ai.createAssistantMessageEventStream();
            const goal = state();
            observedAutomaticResponses = Math.max(
              observedAutomaticResponses,
              goal?.automaticModelTurns ?? 0,
            );
            if (goal?.status === "active") {
              assert.equal(contextContract?.version, 2);
              assert.equal(contextContract?.state, "active");
              assert.equal(contextContract?.goalId, goal.id);
            }
            let content = text("Baseline");
            if (goal && !compacting) {
              goalRequest++;
              capturedId ??= goal.id;
              if (["quota", "budget"].includes(scenario))
                content = text("Synthetic interrupted stage");
              else if (
                scenario === "tool-cap" ||
                (longPlan && workStages < workTarget)
              )
                content =
                  goalRequest === 1
                    ? text("Kickoff ended")
                    : call("probe_write", {});
              else if (scenario === "cap")
                content = text("Stage " + goalRequest);
              else if (scenario === "no-progress")
                content = text("Unchanged result");
              else if (scenario.startsWith("stale-"))
                content = text("In-flight work ended");
              else if (scenario === "clear") content = text("In-flight stage");
              else if (scenario === "pause")
                content = call("goal_complete", {
                  goal_id: goal.id,
                  summary: "Verified the deterministic artifact.",
                });
              else if (
                ["persistence", "coexist"].includes(scenario) &&
                !existsSync(join(cwd, "resume"))
              )
                content = call("goal_wait", {
                  goal_id: goal.id,
                  reason: "Synthetic external monitor installed",
                });
              else if (scenario === "completion" && goalRequest === 1)
                content = call("goal_complete", {
                  goal_id: "stale-id",
                  summary: "Verified recorded artifact.",
                });
              else if (scenario === "completion" && goalRequest === 2)
                content = call("goal_complete", {
                  goal_id: goal.id,
                  summary: "",
                });
              else if (
                ["unlimited", "unlimited-repeat"].includes(scenario) &&
                goalRequest <= 32
              )
                content =
                  goalRequest === 1
                    ? call("probe_write", {})
                    : text(
                        scenario === "unlimited-repeat"
                          ? "Unchanged result"
                          : "Stage " + goalRequest,
                      );
              else if (
                workStages < workTarget &&
                !["unlimited", "unlimited-repeat"].includes(scenario)
              )
                content =
                  goalRequest % 2 === 0
                    ? text("Stage " + goalRequest)
                    : call("probe_write", {});
              else
                content = call("goal_complete", {
                  goal_id: goal.id,
                  summary:
                    "Verified outcome.json records " +
                    workStages +
                    " work stages and the matching persisted goal identity.",
                });
            }
            const publish = () => {
              const message = {
                role: "assistant",
                api: model.api,
                provider: model.provider,
                model: model.id,
                timestamp: Date.now(),
                content,
                stopReason:
                  scenario === "quota" && goal
                    ? "error"
                    : content[0].type === "toolCall"
                      ? "toolUse"
                      : "stop",
                ...(scenario === "quota" && goal
                  ? { errorMessage: "quota exceeded" }
                  : {}),
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              };
              stream.push({ type: "start", partial: message });
              if (content[0].type === "text") {
                stream.push({
                  type: "text_start",
                  contentIndex: 0,
                  partial: message,
                });
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: content[0].text,
                  partial: message,
                });
                stream.push({
                  type: "text_end",
                  contentIndex: 0,
                  content: content[0].text,
                  partial: message,
                });
              } else {
                stream.push({
                  type: "toolcall_start",
                  contentIndex: 0,
                  partial: message,
                });
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: 0,
                  delta: JSON.stringify(content[0].arguments),
                  partial: message,
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: 0,
                  toolCall: content[0],
                  partial: message,
                });
              }
              if (message.stopReason === "error")
                stream.push({ type: "error", reason: "error", error: message });
              else
                stream.push({
                  type: "done",
                  reason: message.stopReason,
                  message,
                });
              stream.end();
            };
            if (goal && ["pause", "clear"].includes(scenario))
              setTimeout(publish, 100);
            else publish();
            return stream;
          },
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.deepEqual(loader.getExtensions().warnings, []);
  if (scenario === "production")
    assert.ok(loader.getExtensions().extensions.length > 3);
  else
    assert.equal(
      loader.getExtensions().extensions.length,
      scenario === "coexist" ? 3 : 2,
    );
  assert.ok(
    loader
      .getExtensions()
      .extensions.some(
        (e) => e.resolvedPath === join(packageRoot, "dist/index.ts"),
      ),
  );
  const runtime = await sdk.ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const create = async (manager) => {
    ({ session } = await sdk.createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      modelRuntime: runtime,
      sessionManager: manager,
    }));
    session.extensionRunner.onError((error) => errors.push(error));
    await session.bindExtensions({
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: (message, type) => notifications.push({ message, type }),
      },
    });
    await session.setModel(runtime.getModel("goal-probe", "deterministic"));
    session.subscribe((e) => {
      if (e.type === "agent_start") starts++;
      if (
        e.type === "agent_end" &&
        scenario.startsWith("stale-") &&
        state()?.status === "active" &&
        !boundaryStop
      ) {
        humanMessages++;
        boundaryStop = session.prompt("/goal " + scenario.slice(6));
      }
      if (e.type === "agent_settled") {
        settled++;
        transitions.push(state());
        if (longPlan && capturedId && state() === null) finishLongPlan();
      }
      if (e.type === "tool_execution_end")
        results.push({
          name: e.toolName,
          isError: e.isError,
          result: e.result,
          goal: structuredClone(state()),
        });
    });
  };
  const human = async (message) => {
    humanMessages++;
    await session.prompt(message);
  };
  await create(sdk.SessionManager.create(cwd, join(home, "sessions")));
  await human("One manual baseline response");
  await delay(50);
  assert.equal(requests, 1);
  assert.equal(state(), undefined);
  eventBus.emit("pi-goal:start", { runId: "synthetic-default-off", objective });
  await delay(20);
  assert.equal(rpcEvents[0]?.error.code, "RPC_DISABLED");
  assert.equal(state(), undefined);
  assert.equal(requests, 1);
  await human(
    "/goal " + (scenario === "budget" ? "--tokens 2 " : "") + objective,
  );
  if (["pause", "clear"].includes(scenario)) {
    await delay(20);
    await human("/goal " + scenario);
    await delay(250);
    assert.equal(requests, 2);
    assert.equal(
      state()?.status ?? null,
      scenario === "pause" ? "paused" : null,
    );
    assert.ok(!results.some((r) => r.name === "goal_complete" && !r.isError));
  } else {
    if (longPlan) await longPlanFinished;
    else await delay(300);
    if (scenario.startsWith("stale-")) {
      await boundaryStop;
      assert.equal(
        state()?.status ?? null,
        scenario === "stale-pause" ? "paused" : null,
      );
      assert.equal(requests, 2);
      assert.equal(starts, 2);
    } else if (["quota", "budget"].includes(scenario)) {
      assert.equal(
        state().status,
        scenario === "quota" ? "usage_limited" : "budget_limited",
      );
      assert.equal(requests, 2);
    } else if (["cap", "tool-cap"].includes(scenario)) {
      assert.equal(state().status, "paused");
      assert.equal(state().automaticModelTurns, 25);
      assert.equal(state().safetyPauseCause, "continuation_limit");
      assert.equal(requests, 27); // baseline + manual kickoff + 25 automatic responses
      if (scenario === "tool-cap") {
        assert.equal(starts, 3); // automatic model responses include one run\u2019s tool loop
        assert.ok(workStages >= 24);
      }
    } else if (scenario === "no-progress") {
      assert.equal(state().status, "paused");
      assert.equal(state().toolFreeRepeatCount, 3);
      assert.equal(state().safetyPauseCause, "no_progress");
      assert.equal(requests, 5); // initial output plus three repeated automatic runs
    } else if (scenario === "coexist") {
      assert.ok(state().waiting);
      const before = structuredClone(state());
      await session.setModel(runtime.getModel("openai-codex", "gpt-6.1-sol"));
      for (const provider of ["openai-codex-2", "openai-codex"]) {
        await human("/subs switch " + provider);
        assert.equal(session.model.provider, provider);
        assert.equal(session.model.id, "gpt-6.1-sol");
        assert.equal(state().id, before.id);
        assert.equal(state().text, objective);
        assert.ok(state().waiting);
      }
      assert.equal(requests, 2); // switching never starts a provider request
      await session.setModel(runtime.getModel("goal-probe", "deterministic"));
      writeFileSync(join(cwd, "resume"), "ready");
      await human("/goal resume");
      await delay(300);
      assert.equal(state(), null);
      assert.equal(workStages, 3);
    } else if (scenario === "persistence") {
      assert.ok(state().waiting);
      const before = structuredClone(state());
      await session.reload();
      assert.equal(state().id, before.id);
      assert.equal(state().text, objective);
      assert.ok(state().waiting);
      compacting = true;
      await session.compact();
      compacting = false;
      await delay(100);
      assert.equal(state().id, before.id);
      assert.equal(state().text, objective);
      assert.ok(state().waiting);
      const file = session.sessionManager.getSessionFile();
      await session.reload(); // genuine shutdown checkpoint, not manual lifecycle dispatch
      session.dispose();
      await loader.reload();
      await create(sdk.SessionManager.open(file, join(home, "sessions")));
      assert.equal(state().id, before.id);
      assert.equal(state().text, objective);
      assert.ok(state().waiting);
      writeFileSync(join(cwd, "resume"), "ready");
      await human("/goal resume");
      await delay(300);
      assert.equal(state(), null);
      await session.reload();
      session.dispose();
      await loader.reload();
      await create(sdk.SessionManager.create(cwd, join(home, "sessions")));
      assert.equal(state(), undefined);
      const previous = requests;
      await delay(100);
      assert.equal(requests, previous);
    } else {
      assert.equal(state(), null);
      assert.ok(starts >= 3);
      const completions = results.filter((r) => r.name === "goal_complete");
      assert.equal(completions.at(-1).isError, false);
      assert.equal(completions.at(-1).result.details.goal_id, capturedId);
      assert.ok(completions.at(-1).result.details.summary.length > 0);
      if (scenario === "completion") {
        assert.equal(completions[0].goal.status, "active");
        assert.equal(completions[0].result.details.goal_id, "stale-id");
        assert.equal(completions[1].isError, true); // SDK rejects empty evidence against schema
        assert.equal(completions[1].goal.status, "active");
      }
      if (unlimited) assert.ok(goalRequest > 25);
      if (scenario === "unlimited-repeat")
        assert.ok(observedAutomaticResponses >= 30);
      if (longPlan) {
        assert.equal(workStages, workTarget);
        assert.equal(observedAutomaticResponses, workTarget);
        assert.equal(starts, 3); // baseline, kickoff, one uninterrupted automatic tool loop
      }
      const artifact = JSON.parse(
        readFileSync(join(cwd, "outcome.json"), "utf8"),
      );
      assert.equal(artifact.goalId, capturedId);
      assert.equal(
        artifact.workStages,
        ["unlimited", "unlimited-repeat"].includes(scenario) ? 1 : workTarget,
      );
      assert.equal(humanMessages, 2);
    }
  }
  const stoppedAt = requests;
  await delay(100);
  assert.equal(requests, stoppedAt);
  assert.deepEqual(errors, []);
  assert.equal(networkRequests, 0);
  assert.ok(readFileSync(authPath).equals(authBefore));
  const beforeReload = structuredClone(state());
  await session.reload(); // orderly extension shutdown also clears upstream completion timers
  assert.equal(requests, stoppedAt);
  if (beforeReload) {
    for (const key of [
      "id",
      "text",
      "status",
      "automaticModelTurns",
      "toolFreeRepeatCount",
      "safetyPauseCause",
    ])
      assert.equal(state()[key], beforeReload[key]);
  }
  console.log(
    JSON.stringify({
      passed: true,
      scenario,
      runtime: runtimeVersion,
      package: manifest.version,
      requests,
      starts,
      settled,
      humanMessages,
      workStages,
      automaticResponses: Math.max(
        observedAutomaticResponses,
        ...transitions.map((g) => g?.automaticModelTurns ?? 0),
      ),
      networkRequests,
      authUnchanged: true,
    }),
  );
} finally {
  session?.dispose();
  clearTimeout(deadline);
  rmSync(home, { recursive: true, force: true });
}
// SDK dispose invalidates contexts but does not dispatch a final async shutdown.
// Production Pipi includes background UI pollers; this disposable subprocess
// owns their lifetime. Exit only after all assertions and file cleanup succeed.
if (scenario === "production") process.exit(0);
