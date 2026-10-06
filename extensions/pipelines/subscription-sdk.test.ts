import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import {
  applySubagentProfile,
  resolvePiModel,
} from "../subagents/src/policy.ts";
import { createPipelineSessionFactory } from "./session.ts";
import {
  ASTRA_MODEL,
  AUDIT_PIPELINE_ID,
  LUNA_MODEL,
  PIPELINE_MODELS,
  SOL_MODEL,
} from "./domain.ts";

function emptyResources() {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Offline subscription regression fixture.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  } satisfies ResourceLoader;
}

function response(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: "toolUse" | "stop",
) {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } satisfies AssistantMessage;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pipi-subscription-sdk-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      packages: [],
      extensions: [],
      skills: [],
      prompts: [],
      themes: [],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      enableInstallTelemetry: false,
    }),
  );
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const provider of [
    "openai-codex",
    "openai-codex-2",
    "openai-codex-3",
    "custom",
  ]) {
    runtime.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: "https://offline.invalid",
      apiKey: "synthetic-offline-key",
      models: PIPELINE_MODELS.map((hint) => ({
        id: hint.split("/")[1],
        name: hint,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 128000,
      })),
    });
  }
  const registry = new ModelRegistry(runtime);
  const sessions: AgentSession[] = [];
  async function create(model: Model<Api>) {
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      model,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(root),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: "off",
        enableInstallTelemetry: false,
      }),
      resourceLoader: emptyResources(),
      tools: [],
    });
    sessions.push(session);
    return session;
  }
  const model = (provider: string, hint: string) => {
    const found = registry.find(provider, hint.split("/")[1]);
    assert.ok(found);
    return found;
  };
  return {
    root,
    agentDir,
    runtime,
    registry,
    sessions,
    create,
    model,
    async dispose() {
      for (const session of sessions) session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("offline SDK subagent choices preserve a switched parent's subscription and selected model on executed requests", async () => {
  const f = await fixture();
  try {
    const parent = await f.create(f.model("openai-codex", ASTRA_MODEL));
    await parent.setModel(f.model("openai-codex-2", ASTRA_MODEL), {
      persist: false,
    });
    for (const options of [
      { profile: "explore" as const },
      { profile: "implement" as const },
      { profile: "review" as const },
      { profile: "implement" as const, model: LUNA_MODEL },
      { profile: "review" as const, model: ASTRA_MODEL },
      { profile: "implement" as const, model: "openai-codex-3/gpt-6.1-sol" },
      { profile: "implement" as const, model: "custom/gpt-6.1-sol" },
    ]) {
      const choice = applySubagentProfile(options.profile, options);
      const resolved = resolvePiModel(f.registry, choice.model, parent.model);
      assert.ok(resolved);
      const child = await f.create(resolved);
      const requests: string[] = [];
      child.agent.streamFunction = (model) => {
        requests.push(`${model.provider}/${model.id}`);
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: response(model, [{ type: "text", text: "Done" }], "stop"),
        });
        return stream;
      };
      await child.prompt("Execute the offline probe");
      const expectedProvider = choice.model?.startsWith("openai-codex/")
        ? "openai-codex-2"
        : choice.model?.split("/")[0];
      assert.deepEqual(requests, [`${expectedProvider}/${resolved.id}`]);
      assert.equal(child.model?.provider, expectedProvider);
    }
  } finally {
    await f.dispose();
  }
});

test("offline pipeline roots, children and same-session model switches stay on the launch account with coherent evidence", async () => {
  const f = await fixture();
  const adapters: AgentTreeSession[] = [];
  try {
    const parent = await f.create(f.model("openai-codex", SOL_MODEL));
    await parent.setModel(f.model("openai-codex-2", SOL_MODEL), {
      persist: false,
    });
    const launchProviders = new Map([["run-a", parent.model?.provider]]);
    let latest: AgentSession | undefined;
    const factory = createPipelineSessionFactory({
      modelRegistry: f.registry,
      modelRuntime: f.runtime,
      agentDir: f.agentDir,
      parentCwd: f.root,
      parentTrusted: false,
      parentProviderForRun: (id) => launchProviders.get(id),
      sessionManager: (cwd) => SessionManager.inMemory(cwd),
      sessionCreated: (session) => {
        latest = session;
        f.sessions.push(session);
      },
      rootTools: () => [],
      definitionForRun: () => AUDIT_PIPELINE_ID,
    });
    await parent.setModel(f.model("openai-codex-3", ASTRA_MODEL), {
      persist: false,
    });
    launchProviders.set("run-b", parent.model?.provider);
    for (const runId of ["run-a", "run-b"]) {
      // Six Sol sessions in one pipeline exceed direct Sol capacity intentionally.
      for (let index = 0; index < 9; index++) {
        const canonical = index < 6 ? SOL_MODEL : PIPELINE_MODELS[index - 6];
        const adapter = await factory.create({
          scopeId: runId,
          id: `${runId}-${index}`,
          ...(index ? { parentId: `${runId}-0` } : {}),
          role: "offline-probe",
          attempt: 1,
          title: "Offline probe",
          model: canonical,
          cwd: f.root,
          prompt: "",
          deferPrompt: true,
        });
        adapters.push(adapter);
        assert.ok(latest);
        const session = latest;
        const provider = launchProviders.get(runId);
        assert.equal(session.model?.provider, provider);
        assert.equal(session.model?.id, canonical.split("/")[1]);
        const events: AgentTreeSessionEvent[] = [];
        adapter.subscribe((event) => events.push(event));
        const activeTools = session.getActiveToolNames();
        const settingsBefore = structuredClone(
          session.settingsManager.getSettings(),
        );
        const requests: { key: string; roles: string[] }[] = [];
        session.agent.streamFunction = (model, context) => {
          requests.push({
            key: `${model.provider}/${model.id}`,
            roles: context.messages.map((message) => message.role),
          });
          const message =
            requests.length === 1
              ? response(
                  model,
                  [
                    {
                      type: "toolCall",
                      id: "select-luna",
                      name: "pipeline_model_select",
                      arguments: {
                        model: LUNA_MODEL,
                        reason: "Remaining task is exploration",
                      },
                    },
                  ],
                  "toolUse",
                )
              : response(model, [{ type: "text", text: "Done" }], "stop");
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: message.stopReason, message });
          return stream;
        };
        const sessionId = session.sessionId;
        await adapter.prompt("Execute the offline switch probe");
        assert.deepEqual(
          requests.map((request) => request.key),
          [`${provider}/${canonical.split("/")[1]}`, `${provider}/gpt-6-luna`],
        );
        assert.ok(requests[1].roles.includes("toolResult"));
        assert.equal(session.sessionId, sessionId);
        assert.deepEqual(session.getActiveToolNames(), activeTools);
        assert.deepEqual(session.settingsManager.getSettings(), settingsBefore);
        assert.deepEqual(adapter.executionMetadata, {
          provider,
          model: "gpt-6-luna",
          thinkingLevel: canonical === LUNA_MODEL ? "medium" : "high",
        });
        assert.deepEqual(
          events.find((event) => event.type === "model_selected"),
          {
            type: "model_selected",
            previousModel: requests[0].key,
            model: `${provider}/gpt-6-luna`,
            reason: "Remaining task is exploration",
          },
        );
      }
    }
  } finally {
    for (const adapter of adapters) await adapter.dispose();
    await f.dispose();
  }
});

test("offline pipeline creation and selection reject an absent inherited model before any base-account request", async () => {
  const f = await fixture();
  let adapter: AgentTreeSession | undefined;
  try {
    const calls: string[] = [];
    const registry = {
      find(provider: string, id: string) {
        calls.push(`${provider}/${id}`);
        return provider === "openai-codex-2" && id === "gpt-6-luna"
          ? undefined
          : f.registry.find(provider, id);
      },
    };
    let created: AgentSession | undefined;
    const factory = createPipelineSessionFactory({
      modelRegistry: registry,
      modelRuntime: f.runtime,
      agentDir: f.agentDir,
      parentProviderForRun: () => "openai-codex-2",
      parentCwd: f.root,
      parentTrusted: false,
      sessionManager: (cwd) => SessionManager.inMemory(cwd),
      sessionCreated: (session) => {
        created = session;
        f.sessions.push(session);
      },
      rootTools: () => [],
      definitionForRun: () => AUDIT_PIPELINE_ID,
    });
    const spec = {
      scopeId: "missing",
      role: "offline-probe",
      attempt: 1,
      title: "Missing",
      model: LUNA_MODEL,
      cwd: f.root,
      prompt: "",
      deferPrompt: true,
    };
    await assert.rejects(
      factory.create(spec),
      /openai-codex-2\/gpt-6-luna.*No fallback/,
    );
    assert.equal(created, undefined);
    assert.deepEqual(calls, ["openai-codex-2/gpt-6-luna"]);
    adapter = await factory.create({ ...spec, model: SOL_MODEL });
    const session = f.sessions.at(-1);
    assert.ok(session);
    const select = session.getToolDefinition("pipeline_model_select");
    assert.ok(select);
    calls.length = 0;
    // A real SDK context is provided by the bound session runner.
    await assert.rejects(
      select.execute(
        "missing",
        { model: LUNA_MODEL, reason: "Probe unavailable account model" },
        undefined,
        undefined,
        session.extensionRunner.createToolContext("missing", undefined),
      ),
      /openai-codex-2\/gpt-6-luna.*No fallback/,
    );
    assert.deepEqual(calls, ["openai-codex-2/gpt-6-luna"]);
    assert.equal(session.model?.provider, "openai-codex-2");
    assert.equal(session.model?.id, "gpt-6.1-sol");
  } finally {
    await adapter?.dispose();
    await f.dispose();
  }
});
