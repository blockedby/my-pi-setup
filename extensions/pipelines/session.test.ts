import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  defineTool,
  SessionManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  FEATURE_FINALIZER_ROLE,
  FEATURE_PIPELINE_ID,
  LUNA_MODEL,
  PLAN_PIPELINE_ID,
  PLAN_PIPELINE_SYNTHESIS_ROLE,
  ASTRA_MODEL,
} from "./domain.ts";
import { ToolCallTimeoutError } from "../shared/tool-call-timeout.ts";
import { createPipelineSessionFactory } from "./session.ts";

const FEATURE_TASK_TOOL_NAMES = [
  "pipeline_task_diff",
  "pipeline_task_check",
  "pipeline_task_finalize",
];
async function createFixture() {
  const root = await mkdtemp(
    path.join(process.cwd(), ".pipi-pipeline-session-"),
  );
  const cwd = path.join(root, "selection");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  return { root, cwd, agentDir };
}

test("persistent Astra finalizer gains its pre-registered task tools only after mutation is enabled", async () => {
  const fixture = await createFixture();
  let sdkSession: AgentSession | undefined;
  let session:
    | Awaited<
        ReturnType<ReturnType<typeof createPipelineSessionFactory>["create"]>
      >
    | undefined;
  let fauxProvider: ReturnType<typeof registerFauxProvider> | undefined;
  let finalized = 0;
  const diffRequests: unknown[] = [];

  try {
    const skillDir = path.join(fixture.agentDir, "skills", "fixture");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: fixture\ndescription: Test package resources.\n---\nFixture\n",
    );
    await writeFile(path.join(skillDir, "resource.txt"), "session resource");
    const discoveredDir = path.join(fixture.root, "discovered-skill");
    await mkdir(discoveredDir);
    await writeFile(
      path.join(discoveredDir, "SKILL.md"),
      "---\nname: discovered\ndescription: Extension-discovered package.\n---\nFixture\n",
    );
    await writeFile(
      path.join(discoveredDir, "resource.txt"),
      "discovered resource",
    );
    const extensionDir = path.join(fixture.agentDir, "extensions");
    await mkdir(extensionDir);
    await writeFile(
      path.join(extensionDir, "skill-fixture.ts"),
      `export default function (pi) { pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(discoveredDir)}] })); }`,
    );
    fauxProvider = registerFauxProvider({
      api: "feature-finalizer-lifecycle-test-api",
      provider: "feature-finalizer-lifecycle-test-provider",
      models: [
        {
          id: "gpt-6-astra",
          name: "Feature Finalizer Lifecycle Test",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_000,
        },
      ],
    });
    const factory = createPipelineSessionFactory({
      modelRegistry: {
        find(provider, id) {
          assert.equal(provider, "openai-codex");
          assert.equal(id, "gpt-6-astra");
          return fauxProvider!.getModel();
        },
      },
      parentCwd: fixture.root,
      parentTrusted: false,
      agentDir: fixture.agentDir,
      sessionManager: (directory) => SessionManager.inMemory(directory),
      sessionCreated(created) {
        sdkSession = created;
      },
      rootTools: () => [],
      definitionForRun: () => FEATURE_PIPELINE_ID,
      discoverySubmit() {},
      discoveryToolAllowed: () => false,
      featureTaskHost: () => ({
        async diff(request) {
          diffRequests.push(request);
          return {
            taskBaseCommit: "base",
            currentHead: "head",
            currentBranch: "feature/test",
            worktree: fixture.cwd,
            baseToHead: [],
            tracked: [],
            staged: [],
            untracked: [],
            ignored: [],
            conflictPaths: [],
            knownResidualPaths: [],
            preparationBaseline: [],
            previousChecks: [],
            diff: {
              text: "",
              truncated: false,
              bytes: 0,
              offset: 0,
              fingerprint: "a".repeat(64),
            },
          };
        },
        async check({ checkId }) {
          return {
            checkId,
            command: "bun run check",
            cwd: ".",
            purpose: "Verify final state",
            required: true,
            status: "passed" as const,
            exitCode: 0,
            stdout: "",
            stderr: "",
            changedPaths: [],
            startedAt: 1,
            finishedAt: 2,
          };
        },
        async finalize() {
          finalized++;
          return {
            validated: true,
            status: "satisfied_without_changes" as const,
            changedPaths: [],
            checks: [],
            warnings: [],
            residualPaths: [],
          };
        },
      }),
    });

    session = await factory.create({
      scopeId: "feature-finalizer-lifecycle-test",
      role: FEATURE_FINALIZER_ROLE,
      attempt: 1,
      title: "Persistent feature finalizer",
      model: ASTRA_MODEL,
      thinkingLevel: "low",
      cwd: fixture.cwd,
      prompt: "",
      persistent: true,
      deferPrompt: true,
    });

    assert.ok(sdkSession);
    assert.equal(sdkSession.thinkingLevel, "low");
    const read = sdkSession.getToolDefinition("read");
    assert.ok(read);
    const resource = await read.execute(
      "read-loaded-skill-resource",
      { path: path.join(skillDir, "resource.txt") },
      undefined,
      undefined,
      { cwd: fixture.cwd } as unknown as ExtensionContext,
    );
    assert.equal(
      resource.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      "session resource",
    );
    const discovered = await read.execute(
      "read-discovered-skill-resource",
      { path: path.join(discoveredDir, "resource.txt") },
      undefined,
      undefined,
      { cwd: fixture.cwd } as unknown as ExtensionContext,
    );
    assert.equal(
      discovered.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      "discovered resource",
    );
    assert.deepEqual(session.activeTools, [
      "read",
      "bash",
      "pipeline_feature_canonical_plan_submit",
      "pipeline_feature_execution_graph_submit",
    ]);
    for (const tool of ["edit", "write", ...FEATURE_TASK_TOOL_NAMES]) {
      assert.equal(session.activeTools.includes(tool), false);
    }
    for (const tool of FEATURE_TASK_TOOL_NAMES) {
      assert.ok(sdkSession.getToolDefinition(tool));
    }

    session.enableMutation();
    assert.deepEqual(session.activeTools, [
      "read",
      "bash",
      "edit",
      "write",
      ...FEATURE_TASK_TOOL_NAMES,
    ]);
    for (const tool of [
      "pipeline_feature_commit",
      "pipeline_feature_canonical_plan_submit",
      "pipeline_feature_execution_graph_submit",
    ]) {
      assert.equal(session.activeTools.includes(tool), false);
    }

    const diff = sdkSession.getToolDefinition("pipeline_task_diff");
    assert.ok(diff);
    const pageRequest = { offset: 262144, fingerprint: "a".repeat(64) };
    assert.equal(Value.Check(diff.parameters, pageRequest), true);
    assert.equal(Value.Check(diff.parameters, {}), true);
    for (const invalid of [
      { offset: -1 },
      { offset: 0.5 },
      { offset: Number.MAX_SAFE_INTEGER + 1 },
      { fingerprint: "invalid" },
      { unexpected: true },
    ]) {
      assert.equal(Value.Check(diff.parameters, invalid), false);
    }
    await diff.execute(
      "feature-finalizer-diff-page",
      pageRequest,
      undefined,
      undefined,
      { cwd: fixture.cwd } as unknown as ExtensionContext,
    );
    assert.deepEqual(diffRequests, [pageRequest]);

    const finalize = sdkSession.getToolDefinition("pipeline_task_finalize");
    assert.ok(finalize);
    const result = await finalize.execute(
      "feature-finalizer-finalize",
      { commitPaths: [], summary: "The accepted feature needs no changes." },
      undefined,
      undefined,
      { cwd: fixture.cwd } as unknown as ExtensionContext,
    );
    assert.equal(result.terminate, true);
    assert.equal(finalized, 1);
  } finally {
    await session?.dispose();
    fauxProvider?.unregister();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("feature workers expose task finalization but not the unrelated execution-finish tool", async () => {
  const fixture = await createFixture();
  const provider = registerFauxProvider({
    api: "feature-task-finish-test-api",
    provider: "feature-task-finish-test-provider",
    models: [
      {
        id: "gpt-5.6-luna",
        name: "Task tool test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4000,
      },
    ],
  });
  let sdkSession: AgentSession | undefined;
  let registered = 0;
  const factory = createPipelineSessionFactory({
    modelRegistry: { find: () => provider.getModel() },
    parentCwd: fixture.root,
    parentTrusted: false,
    agentDir: fixture.agentDir,
    sessionManager: (cwd) => SessionManager.inMemory(cwd),
    sessionCreated(created) {
      sdkSession = created;
    },
    rootTools: () => [],
    definitionForRun: () => FEATURE_PIPELINE_ID,
    executionFinish() {
      throw new Error("Unexpected execution-finish call");
    },
    executionFinishSessionCreated() {
      registered++;
    },
    featureTaskHost: () => ({
      async diff() {
        throw new Error("Not invoked");
      },
      async check() {
        throw new Error("Not invoked");
      },
      async finalize() {
        throw new Error("Not invoked");
      },
    }),
  });
  try {
    const session = await factory.create({
      scopeId: "task-tool-test",
      parentId: "root",
      role: "feature-task-docs",
      attempt: 1,
      title: "Task",
      model: LUNA_MODEL,
      thinkingLevel: "high",
      cwd: fixture.cwd,
      prompt: "",
      deferPrompt: true,
    });
    try {
      assert.equal(registered, 0);
      assert.equal(
        session.activeTools.includes("pipeline_execution_finish"),
        false,
      );
      assert.equal(
        sdkSession!.getToolDefinition("pipeline_execution_finish"),
        undefined,
      );
      for (const name of FEATURE_TASK_TOOL_NAMES)
        assert.equal(session.activeTools.includes(name), true);
    } finally {
      await session.dispose();
    }
  } finally {
    provider.unregister();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pipeline sessions leave only child waits unbounded", async () => {
  const fixture = await createFixture();
  const provider = registerFauxProvider({
    api: "pipeline-timeout-policy-test-api",
    provider: "pipeline-timeout-policy-test-provider",
    models: [
      {
        id: "gpt-5.6-luna",
        name: "Pipeline timeout policy test",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 4_000,
      },
    ],
  });
  let sdkSession: AgentSession | undefined;
  let session:
    | Awaited<
        ReturnType<ReturnType<typeof createPipelineSessionFactory>["create"]>
      >
    | undefined;
  const waitTool = defineTool({
    name: "pipeline_child_wait",
    label: "Wait fixture",
    description: "Wait fixture",
    parameters: Type.Object({}),
    async execute() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        content: [{ type: "text" as const, text: "waited" }],
        details: {},
      };
    },
  });
  const otherTool = defineTool({
    name: "pipeline_child_send",
    label: "Other fixture",
    description: "Other fixture",
    parameters: Type.Object({}),
    async execute() {
      return new Promise<never>(() => {});
    },
  });

  try {
    const factory = createPipelineSessionFactory({
      modelRegistry: { find: () => provider.getModel() },
      parentCwd: fixture.root,
      parentTrusted: false,
      agentDir: fixture.agentDir,
      toolCallTimeoutMs: 5,
      sessionManager: (cwd) => SessionManager.inMemory(cwd),
      sessionCreated(created) {
        sdkSession = created;
      },
      rootTools: () => [waitTool, otherTool],
      definitionForRun: () => FEATURE_PIPELINE_ID,
    });
    session = await factory.create({
      scopeId: "pipeline-timeout-policy-test",
      role: "pipeline-root",
      attempt: 1,
      title: "Pipeline timeout policy test",
      model: LUNA_MODEL,
      thinkingLevel: "low",
      cwd: fixture.cwd,
      prompt: "",
      persistent: true,
      deferPrompt: true,
    });

    assert.ok(sdkSession);
    const invoke = (name: string, signal?: AbortSignal) => {
      const definition = sdkSession!.getToolDefinition(name);
      assert.ok(definition);
      return definition.execute(
        `timeout-policy-${name}`,
        {},
        signal,
        undefined,
        { cwd: fixture.cwd } as unknown as ExtensionContext,
      );
    };

    const result = await invoke("pipeline_child_wait");
    assert.equal(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      "waited",
    );
    await assert.rejects(
      invoke("pipeline_child_send"),
      (error: unknown) => error instanceof ToolCallTimeoutError,
    );

    const controller = new AbortController();
    const reason = new Error("pipeline wait cancelled");
    const pending = invoke("pipeline_child_wait", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
  } finally {
    await session?.dispose();
    provider.unregister();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("plan synthesis sessions expose only local reads and their terminating submission", async () => {
  const fixture = await createFixture();
  let session:
    | Awaited<
        ReturnType<ReturnType<typeof createPipelineSessionFactory>["create"]>
      >
    | undefined;
  let sdkSession: AgentSession | undefined;
  let submitted: unknown;
  let fauxProvider: ReturnType<typeof registerFauxProvider> | undefined;
  try {
    fauxProvider = registerFauxProvider({
      api: "plan-lifecycle-test-api",
      provider: "plan-lifecycle-test-provider",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "Plan Lifecycle Test",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32_000,
          maxTokens: 4_000,
        },
      ],
    });
    const factory = createPipelineSessionFactory({
      modelRegistry: {
        find(provider, id) {
          assert.equal(provider, "openai-codex");
          assert.equal(id, "gpt-5.6-luna");
          return fauxProvider!.getModel();
        },
      },
      parentCwd: fixture.root,
      parentTrusted: false,
      agentDir: fixture.agentDir,
      sessionManager: (directory) => SessionManager.inMemory(directory),
      sessionCreated(created) {
        sdkSession = created;
      },
      rootTools: () => [],
      definitionForRun: () => PLAN_PIPELINE_ID,
      discoverySubmit(_runId, _role, _token, value) {
        submitted = value;
      },
      discoveryToolAllowed: () => true,
    });
    session = await factory.create({
      scopeId: "plan-lifecycle-test",
      role: PLAN_PIPELINE_SYNTHESIS_ROLE,
      attempt: 1,
      title: "Plan synthesis lifecycle test",
      model: LUNA_MODEL,
      thinkingLevel: "xhigh",
      cwd: fixture.cwd,
      prompt: "",
      persistent: true,
      deferPrompt: true,
    });
    assert.ok(sdkSession);
    const names = new Set(sdkSession.getActiveToolNames());
    for (const denied of [
      "bash",
      "edit",
      "write",
      "web_search_codex",
      "web_fetch_codex",
      "pipeline_complete",
      "pipeline_child_spawn",
      "pipeline_plan_write",
      "pipeline_plan_validate",
    ]) {
      assert.equal(names.has(denied), false, denied);
    }
    assert.equal(names.has("read"), true);
    assert.equal(names.has("pipeline_plan_submit"), true);
    const submit = sdkSession.getToolDefinition("pipeline_plan_submit");
    assert.ok(submit);
    const result = await submit.execute(
      "plan-submit",
      { plan: "# Exact plan\n" },
      undefined,
      undefined,
      { cwd: fixture.cwd } as unknown as ExtensionContext,
    );
    assert.equal(result.terminate, true);
    assert.deepEqual(submitted, { plan: "# Exact plan\n" });
    assert.strictEqual(
      session.activeTools.includes("pipeline_plan_submit"),
      true,
    );
  } finally {
    await session?.dispose();
    fauxProvider?.unregister();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
