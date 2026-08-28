import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE } from "./feature-best-of-three.ts";
import { FEATURE_PIPELINE_ID, LUNA_MODEL } from "./domain.ts";
import { createPipelineSessionFactory } from "./session.ts";

const FEATURE_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "pipeline_feature_commit",
];
const testModel = {
  id: "gpt-5.6-luna",
  name: "Pipeline Lifecycle Test",
  api: "pipeline-lifecycle-test",
  provider: "openai-codex",
  baseUrl: "http://127.0.0.1:1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 4_000,
} satisfies Model<Api>;

async function createFixture() {
  const root = await mkdtemp(
    path.join(process.cwd(), ".pipi-pipeline-session-"),
  );
  const cwd = path.join(root, "selection");
  const agentDir = path.join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  return { root, cwd, agentDir };
}

test("implementation synthesis keeps the registered commit tool across selection and mutation", async () => {
  const fixture = await createFixture();
  let sdkSession: AgentSession | undefined;
  let creationToolNames: string[] | undefined;
  let creationCommitTool:
    ReturnType<AgentSession["getToolDefinition"]> | undefined;
  const commitCalls: Array<{
    runId: string;
    role: string;
    workingDir: string;
  }> = [];
  let session:
    | Awaited<
        ReturnType<ReturnType<typeof createPipelineSessionFactory>["create"]>
      >
    | undefined;

  try {
    const factory = createPipelineSessionFactory({
      modelRegistry: {
        find(provider, id) {
          assert.equal(provider, "openai-codex");
          assert.equal(id, "gpt-5.6-luna");
          return testModel;
        },
      },
      parentCwd: fixture.root,
      parentTrusted: false,
      agentDir: fixture.agentDir,
      // In-memory session storage prevents this regression from touching the
      // caller's Pipi session directory while retaining a real AgentSession.
      sessionManager: (directory) => SessionManager.inMemory(directory),
      sessionCreated(created) {
        sdkSession = created;
        creationToolNames = created.getAllTools().map((tool) => tool.name);
        creationCommitTool = created.getToolDefinition(
          "pipeline_feature_commit",
        );
      },
      rootTools: () => [],
      definitionForRun: () => FEATURE_PIPELINE_ID,
      featureCommit(runId, role, workingDir) {
        commitCalls.push({ runId, role, workingDir });
        return "commit-pipeline-lifecycle-test";
      },
    });

    session = await factory.create({
      scopeId: "run-pipeline-lifecycle-test",
      role: FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
      attempt: 1,
      title: "Implementation synthesis lifecycle test",
      model: LUNA_MODEL,
      thinkingLevel: "xhigh",
      cwd: fixture.cwd,
      prompt: "",
      persistent: true,
      deferPrompt: true,
    });

    assert.ok(sdkSession);
    assert.deepEqual(creationToolNames, FEATURE_TOOL_NAMES);
    assert.ok(creationCommitTool);
    assert.deepEqual(session.activeTools, ["read", "bash"]);
    assert.deepEqual(sdkSession.getActiveToolNames(), ["read", "bash"]);
    assert.equal(session.isStreaming, false);

    const persistentSession = session;
    const persistentSdkSession = sdkSession;
    session.enableMutation();

    assert.strictEqual(session, persistentSession);
    assert.strictEqual(sdkSession, persistentSdkSession);
    assert.deepEqual(session.activeTools, FEATURE_TOOL_NAMES);
    assert.deepEqual(sdkSession.getActiveToolNames(), FEATURE_TOOL_NAMES);

    const commitTool = sdkSession.getToolDefinition("pipeline_feature_commit");
    assert.ok(commitTool);
    assert.strictEqual(commitTool, creationCommitTool);
    const result = await commitTool.execute(
      "pipeline-lifecycle-commit-call",
      {},
      undefined,
      undefined,
      { cwd: fixture.cwd } as unknown as ExtensionContext,
    );

    assert.deepEqual(result.details, {
      head: "commit-pipeline-lifecycle-test",
    });
    assert.deepEqual(commitCalls, [
      {
        runId: "run-pipeline-lifecycle-test",
        role: FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
        workingDir: fixture.cwd,
      },
    ]);
    assert.equal(session.isStreaming, false);
  } finally {
    await session?.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
