import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
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
  SOL_MODEL,
} from "./domain.ts";
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

test("persistent Sol finalizer gains its pre-registered task tools only after mutation is enabled", async () => {
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
    fauxProvider = registerFauxProvider({
      api: "feature-finalizer-lifecycle-test-api",
      provider: "feature-finalizer-lifecycle-test-provider",
      models: [
        {
          id: "gpt-5.6-sol",
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
          assert.equal(id, "gpt-5.6-sol");
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
      model: SOL_MODEL,
      thinkingLevel: "xhigh",
      cwd: fixture.cwd,
      prompt: "",
      persistent: true,
      deferPrompt: true,
    });

    assert.ok(sdkSession);
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
