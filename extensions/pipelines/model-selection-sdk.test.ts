import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSession,
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { LUNA_MODEL, SOL_MODEL } from "./domain.ts";
import {
  createPipelineModelSelectTool,
  type PipelineModelSelection,
} from "./model-selection.ts";

function syntheticModel(key: string) {
  const [provider, id] = key.split("/");
  return {
    provider,
    id,
    name: id,
    api: "openai-codex-responses",
    baseUrl: "https://provider-free.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  } satisfies Model<Api>;
}

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: "toolUse" | "stop",
  timestamp: number,
) {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp,
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

test("Pi 1.0.2 model selection uses Luna on the next request in the same Sol run without losing context or permissions or persisting defaults", async () => {
  assert.equal(VERSION, "1.0.2");
  const agentDir = await mkdtemp(
    join(tmpdir(), "pipeline-model-selection-sdk-"),
  );
  let session: AgentSession | undefined;
  try {
    const sol = syntheticModel(SOL_MODEL);
    const luna = syntheticModel(LUNA_MODEL);
    const credentials = new InMemoryCredentialStore();
    // Only checkAuth is needed: no OAuth resolution/refresh or provider request.
    const syntheticCredential = {
      type: "oauth" as const,
      access: "synthetic-test-access-not-a-real-token",
      refresh: "synthetic-test-refresh-not-a-real-token",
      expires: Number.MAX_SAFE_INTEGER,
    };
    await credentials.modify(sol.provider, async () => syntheticCredential);
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: sol.provider,
      defaultModel: sol.id,
      defaultThinkingLevel: "medium",
      defaultTools: ["read"],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      enableInstallTelemetry: false,
    });
    const settingsBefore = structuredClone({
      merged: settingsManager.getSettings(),
      global: settingsManager.getGlobalSettings(),
      project: settingsManager.getProjectSettings(),
    });
    const sessionManager = SessionManager.inMemory(agentDir);
    sessionManager.appendModelChange(sol.provider, sol.id);
    sessionManager.appendThinkingLevelChange("medium");
    const priorUser: UserMessage = {
      role: "user",
      content: [
        { type: "text", text: "Retain the existing implementation state." },
      ],
      timestamp: 1,
    };
    const priorAssistant = assistantMessage(
      sol,
      [{ type: "text", text: "Existing state acknowledged." }],
      "stop",
      2,
    );
    sessionManager.appendMessage(priorUser);
    sessionManager.appendMessage(priorAssistant);
    const entriesBefore = structuredClone(sessionManager.getEntries());
    const selections: PipelineModelSelection[] = [];
    const selectTool = createPipelineModelSelectTool({
      registry: {
        find: (provider, id) =>
          [sol, luna].find(
            (model) => model.provider === provider && model.id === id,
          ),
      },
      session: () => {
        assert.ok(session);
        return session;
      },
      selected: (selection) => selections.push(selection),
    });
    // Explicit resources bypass all extension/skill/context/profile discovery.
    const extensionRuntime = createExtensionRuntime();
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({
        extensions: [],
        errors: [],
        runtime: extensionRuntime,
      }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Provider-free SDK regression fixture.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    ({ session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      model: sol,
      thinkingLevel: "medium",
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: ["read", selectTool.name],
      customTools: [selectTool],
    }));
    assert.ok(session instanceof AgentSession);
    const originalSession = session;
    const agent = session.agent;
    const sessionId = session.sessionId;
    const activeToolsBefore = session.getActiveToolNames();
    const registeredToolsBefore = structuredClone(session.getAllTools());
    const beforeToolCall = agent.beforeToolCall;
    const afterToolCall = agent.afterToolCall;
    assert.deepEqual(
      [...activeToolsBefore].sort(),
      [selectTool.name, "read"].sort(),
    );
    const selection = {
      previousModel: SOL_MODEL,
      model: LUNA_MODEL,
      reason: "The remaining exploration fits Luna.",
    };
    const toolCall = {
      type: "toolCall" as const,
      id: "select-luna",
      name: selectTool.name,
      arguments: { model: LUNA_MODEL, reason: selection.reason },
    };
    const requests: {
      model: Model<Api>;
      context: TranscriptContext;
      sessionId: string | undefined;
      signal: SimpleStreamOptions["signal"];
    }[] = [];
    const responses: AssistantMessage[] = [];
    const lifecycle: string[] = [];
    session.subscribe((event) => {
      if (
        event.type === "agent_start" ||
        event.type === "agent_end" ||
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_end"
      ) {
        lifecycle.push(event.type);
      }
    });
    // Replace only the public transport seam, not setModel or turn-refresh hooks.
    agent.streamFunction = (model, context, options) => {
      requests.push({
        model: structuredClone(model),
        context: structuredClone(context),
        sessionId: options?.sessionId,
        signal: options?.signal,
      });
      lifecycle.push("request");
      const response = assistantMessage(
        model,
        requests.length === 1
          ? [toolCall]
          : [{ type: "text", text: "Exploration complete." }],
        requests.length === 1 ? "toolUse" : "stop",
        requests.length + 2,
      );
      responses.push(response);
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "start",
        partial: { ...response, content: [], stopReason: "pending" },
      });
      stream.push({
        type: "done",
        reason: response.stopReason,
        message: response,
      });
      return stream;
    };

    await session.prompt("Continue with the existing state.");
    await session.waitForIdle();

    assert.deepEqual(lifecycle, [
      "agent_start",
      "request",
      "tool_execution_start",
      "tool_execution_end",
      "request",
      "agent_end",
    ]);
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map(({ model }) => `${model.provider}/${model.id}`),
      [SOL_MODEL, LUNA_MODEL],
    );
    assert.deepEqual(
      requests.map((request) => request.sessionId),
      [sessionId, sessionId],
    );
    assert.ok(requests[0].signal);
    assert.equal(requests[1].signal, requests[0].signal);
    assert.deepEqual(selections, [selection]);
    assert.equal(session, originalSession);
    assert.equal(session.agent, agent);
    assert.equal(session.sessionManager, sessionManager);
    assert.equal(session.settingsManager, settingsManager);
    assert.equal(session.sessionId, sessionId);
    assert.equal(session.model, luna);
    assert.deepEqual(session.getActiveToolNames(), activeToolsBefore);
    assert.deepEqual(session.getAllTools(), registeredToolsBefore);
    assert.equal(agent.beforeToolCall, beforeToolCall);
    assert.equal(agent.afterToolCall, afterToolCall);

    const firstContext = requests[0].context.messages;
    const nextContext = requests[1].context.messages;
    assert.deepEqual(
      firstContext.filter((message) => message.role !== "system").slice(0, 2),
      [priorUser, priorAssistant],
    );
    assert.deepEqual(nextContext.slice(0, firstContext.length), firstContext);
    assert.deepEqual(
      nextContext.slice(firstContext.length).map((message) => message.role),
      ["assistant", "toolResult"],
    );
    assert.deepEqual(nextContext.at(-2), responses[0]);
    const result = nextContext.at(-1);
    assert.ok(result?.role === "toolResult");
    assert.equal(result.toolCallId, toolCall.id);
    assert.equal(result.toolName, selectTool.name);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content, [
      { type: "text", text: JSON.stringify(selection) },
    ]);
    assert.deepEqual(session.messages, [...nextContext, responses[1]]);
    assert.deepEqual(
      sessionManager.buildSessionContext().messages,
      session.messages,
    );
    assert.deepEqual(
      sessionManager.getEntries().slice(0, entriesBefore.length),
      entriesBefore,
    );
    assert.deepEqual(sessionManager.getBranch(), sessionManager.getEntries());
    assert.deepEqual(sessionManager.buildSessionContext().model, {
      provider: luna.provider,
      modelId: luna.id,
    });
    assert.equal(sessionManager.isPersisted(), false);
    assert.equal(sessionManager.getSessionFile(), undefined);
    await settingsManager.flush();
    assert.deepEqual(
      {
        merged: settingsManager.getSettings(),
        global: settingsManager.getGlobalSettings(),
        project: settingsManager.getProjectSettings(),
      },
      settingsBefore,
    );
    assert.deepEqual(settingsManager.drainErrors(), []);
    assert.deepEqual(await credentials.read(sol.provider), syntheticCredential);
    assert.deepEqual(await readdir(agentDir), []);
  } finally {
    try {
      await session?.abort();
    } finally {
      try {
        session?.dispose();
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    }
  }
});
