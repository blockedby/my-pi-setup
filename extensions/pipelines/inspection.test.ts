import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";
import {
  PIPELINE_DEFINITION_IDS,
  stagesForDefinition,
  type PipelineRunSnapshot,
  type PipelineRunStatus,
} from "./domain.ts";
import {
  createPipelineInspectionTools,
  formatPipelineCheck,
  inspectPipeline,
  listPipelines,
  PIPELINE_CHECK_MAX_BYTES,
  PIPELINE_CHECK_PARAMETERS,
  PIPELINE_LIST_PARAMETERS,
  PIPELINE_PREVIEW_MAX_BYTES,
  PIPELINE_PREVIEW_MAX_LINES,
  projectPipelineCheck,
} from "./inspection.ts";

const now = 20_000;

function agent(
  overrides: Partial<AgentNodeSnapshot> &
    Pick<AgentNodeSnapshot, "id" | "status">,
): AgentNodeSnapshot {
  const { id, status, ...rest } = overrides;
  return {
    id,
    scopeId: "run-1",
    role: "discover-problem",
    attempt: 1,
    title: "Discover Problem",
    model: "openai-codex/gpt-5.6-luna",
    cwd: "/secret-agent-cwd",
    persistent: false,
    status,
    createdAt: 2_000,
    finalText: "",
    transcript: [],
    activeTools: [],
    ...rest,
  };
}

function snapshot(
  overrides: Partial<PipelineRunSnapshot> = {},
): PipelineRunSnapshot {
  return {
    id: "run-1",
    definition: "feature-pipeline",
    workingDir: "/repo/worktree",
    stage: "build",
    status: "running",
    startedAt: 10_000,
    rootId: "root-1",
    agents: [
      agent({
        id: "root-1",
        role: "pipeline-root",
        model: "openai-codex/gpt-5.6-sol",
        status: "running",
        createdAt: 1_000,
      }),
    ],
    ...overrides,
  };
}

test("pipeline inspection schemas accept exactly check id and empty list inputs", () => {
  assert.equal(Check(PIPELINE_CHECK_PARAMETERS, { id: "run-1" }), true);
  assert.equal(Check(PIPELINE_CHECK_PARAMETERS, {}), false);
  assert.equal(
    Check(PIPELINE_CHECK_PARAMETERS, { id: "run-1", wait: true }),
    false,
  );
  assert.equal(Check(PIPELINE_LIST_PARAMETERS, {}), true);
  assert.equal(Check(PIPELINE_LIST_PARAMETERS, { status: "running" }), false);
});

test("registers only pipeline_check and pipeline_list inspection tools and executes projections", async () => {
  const controller = {
    get: (id: string) => (id === "run-1" ? snapshot() : undefined),
    list: () => [snapshot()],
  };
  const tools = createPipelineInspectionTools(() => controller);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["pipeline_check", "pipeline_list"],
  );
  assert.equal(
    tools.some((tool) => tool.name === "pipeline_status"),
    false,
  );
  assert.equal(
    tools.some((tool) => tool.name === "pipeline_wait"),
    false,
  );
  assert.deepEqual(tools[0]?.parameters, PIPELINE_CHECK_PARAMETERS);
  assert.deepEqual(tools[1]?.parameters, PIPELINE_LIST_PARAMETERS);

  const ctx = {} as ExtensionContext;
  const checked = await tools[0]!.execute(
    "tool-1",
    { id: "run-1" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(
    checked.content[0]?.type === "text" ? checked.content[0].text : "",
    /Pipeline run-1/,
  );
  const checkedDetails = checked.details as ReturnType<
    typeof inspectPipeline
  >["details"];
  assert.equal(checkedDetails.pipeline.id, "run-1");

  const listed = await tools[1]!.execute(
    "tool-2",
    {},
    undefined,
    undefined,
    ctx,
  );
  const listedDetails = listed.details as ReturnType<
    typeof listPipelines
  >["details"];
  assert.equal(listedDetails.pipelines[0]?.id, "run-1");
});

test("pipeline_list returns the exact empty state and newest-first compact details", () => {
  assert.deepEqual(listPipelines({ get: () => undefined, list: () => [] }), {
    content: [{ type: "text", text: "No pipelines." }],
    details: { pipelines: [] },
  });

  const older = snapshot({
    id: "older",
    startedAt: 1_000,
    status: "completed",
    finishedAt: 2_000,
    agents: [],
  });
  const newer = snapshot({
    id: "newer",
    definition: "small-feature-pipeline",
    stage: "final-audit",
    startedAt: 3_000,
    agents: [],
  });
  const result = listPipelines({
    get: () => undefined,
    list: () => [older, newer],
  });
  assert.deepEqual(result.details, {
    pipelines: [
      {
        id: "newer",
        definition: "small-feature-pipeline",
        stage: "final-audit",
        status: "running",
        startedAt: 3_000,
        workingDir: "/repo/worktree",
      },
      {
        id: "older",
        definition: "feature-pipeline",
        stage: "build",
        status: "completed",
        startedAt: 1_000,
        finishedAt: 2_000,
        workingDir: "/repo/worktree",
      },
    ],
  });
  assert.deepEqual(Object.keys(result.details.pipelines[0]!).sort(), [
    "definition",
    "id",
    "stage",
    "startedAt",
    "status",
    "workingDir",
  ]);
  assert.match(result.content[0].text, /^newer .*\nolder /);
});

test("pipeline_check rejects an unknown id with newest-first known ids", () => {
  assert.throws(
    () =>
      inspectPipeline(
        {
          get: () => undefined,
          list: () => [
            snapshot({ id: "older", startedAt: 1_000 }),
            snapshot({ id: "newer", startedAt: 2_000 }),
          ],
        },
        "missing",
      ),
    /Unknown pipeline id "missing"\. Known: newer, older\./,
  );
  assert.throws(
    () => inspectPipeline({ get: () => undefined, list: () => [] }, "missing"),
    /Known: none\./,
  );
});

test("stage progress is definition-relative for every stage in every definition", () => {
  for (const definition of PIPELINE_DEFINITION_IDS) {
    const stages = stagesForDefinition(definition);
    for (const [index, stage] of stages.entries()) {
      const details = projectPipelineCheck(
        snapshot({ definition, stage, agents: [] }),
        now,
      );
      assert.deepEqual(details.stageProgress, {
        current: index + 1,
        total: stages.length,
      });
    }
  }
});

test("all run and agent statuses project with deterministic root-first creation ordering", () => {
  const runStatuses: PipelineRunStatus[] = [
    "starting",
    "running",
    "completed",
    "failed",
    "cancelled",
  ];
  for (const status of runStatuses) {
    const details = projectPipelineCheck(snapshot({ status }), now);
    assert.equal(details.status, status);
    if (status !== "starting" && status !== "running") {
      assert.equal("completion" in details, false);
    }
  }

  const agents = [
    agent({ id: "done", parentId: "root", status: "done", createdAt: 4 }),
    agent({ id: "running", parentId: "root", status: "running", createdAt: 2 }),
    agent({
      id: "root",
      role: "pipeline-root",
      model: "openai-codex/gpt-5.6-sol",
      status: "idle",
      createdAt: 9,
    }),
    agent({
      id: "starting",
      parentId: "root",
      status: "starting",
      createdAt: 1,
    }),
    agent({ id: "error", parentId: "root", status: "error", createdAt: 5 }),
    agent({
      id: "cancelled",
      parentId: "root",
      status: "cancelled",
      createdAt: 6,
    }),
  ];
  const details = projectPipelineCheck(
    snapshot({ rootId: "root", agents }),
    now,
  );
  assert.deepEqual(
    details.agents.map((item) => item.id),
    ["root", "starting", "running", "done", "error", "cancelled"],
  );
  assert.equal(details.rootStatus, "idle");
  assert.deepEqual(details.agentStatusCounts, {
    starting: 1,
    running: 1,
    idle: 1,
    done: 1,
    error: 1,
    cancelled: 1,
  });
  assert.equal(details.agents[0]?.thinkingLevel, "high");
  assert.equal(details.agents[1]?.thinkingLevel, "medium");
  assert.match(
    formatPipelineCheck(details),
    /openai-codex\/gpt-5\.6-sol · high · idle/,
  );
  assert.match(
    formatPipelineCheck(details),
    /openai-codex\/gpt-5\.6-luna · medium · starting/,
  );
  assert.equal(
    projectPipelineCheck(snapshot({ rootId: undefined, agents: [] }), now)
      .rootStatus,
    "not-started",
  );
});

test("active previews prefer live text, fall back to finalized assistant text, and show open tool independently", () => {
  const transcript = [
    { kind: "user" as const, text: "PROMPT_SECRET", at: 1 },
    {
      kind: "assistant" as const,
      text: "finalized assistant preview",
      thinking: "THINKING_SECRET",
      at: 2,
    },
    {
      kind: "tool" as const,
      phase: "call" as const,
      toolCallId: "closed",
      name: "bash",
      text: "TOOL_ARGUMENT_SECRET",
      isError: false,
      at: 3,
    },
    {
      kind: "tool" as const,
      phase: "result" as const,
      toolCallId: "closed",
      name: "bash",
      text: "SHELL_OUTPUT_SECRET",
      isError: false,
      at: 4,
    },
    {
      kind: "tool" as const,
      phase: "call" as const,
      toolCallId: "open",
      name: "read",
      text: "OPEN_ARGUMENT_SECRET",
      isError: false,
      at: 5,
    },
  ];
  const live = agent({
    id: "live",
    parentId: "root",
    status: "running",
    transcript,
    liveAssistant: {
      text: "live assistant preview",
      thinking: "LIVE_THINKING",
    },
    finalText: "FINAL_MODEL_OUTPUT_SECRET",
    sessionFile: "/secret/session.jsonl",
    activeTools: ["ACTIVE_TOOL_LIST_SECRET"],
  });
  const fallback = agent({
    id: "finalized",
    parentId: "root",
    status: "starting",
    transcript,
  });
  const noOutput = agent({
    id: "empty",
    parentId: "root",
    status: "running",
  });
  const settled = agent({
    id: "settled",
    parentId: "root",
    status: "done",
    transcript,
    finalText: "SETTLED_FINAL_SECRET",
  });
  const details = projectPipelineCheck(
    snapshot({
      agents: [live, fallback, noOutput, settled],
      rootId: undefined,
    }),
    now,
  );

  assert.deepEqual(details.agents[0], {
    id: "live",
    role: "discover-problem",
    attempt: 1,
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium",
    status: "running",
    preview: "live assistant preview",
    openTool: "read",
  });
  assert.equal(details.agents[1]?.preview, "finalized assistant preview");
  assert.equal(details.agents[1]?.openTool, "read");
  assert.equal(details.agents[2]?.noModelVisibleOutput, true);
  assert.equal("preview" in details.agents[3]!, false);
  assert.equal("openTool" in details.agents[3]!, false);

  const serialized = JSON.stringify(details);
  for (const excluded of [
    "PROMPT_SECRET",
    "THINKING_SECRET",
    "LIVE_THINKING",
    "TOOL_ARGUMENT_SECRET",
    "SHELL_OUTPUT_SECRET",
    "OPEN_ARGUMENT_SECRET",
    "FINAL_MODEL_OUTPUT_SECRET",
    "SETTLED_FINAL_SECRET",
    "/secret/session.jsonl",
    "ACTIVE_TOOL_LIST_SECRET",
  ]) {
    assert.equal(serialized.includes(excluded), false, excluded);
  }
});

test("settled check details expose completion counts and optional plan path but no raw facts", () => {
  const completion = {
    outcome: "RAW_OUTCOME_SECRET",
    planPath: "docs/plans/example.md",
    changedPaths: ["RAW_CHANGED_PATH_SECRET"],
    checks: ["RAW_CHECK_SECRET", "another"],
    assumptions: ["RAW_ASSUMPTION_SECRET"],
    git: ["RAW_GIT_SECRET"],
    reports: ["RAW_REPORT_SECRET"],
    unresolvedItems: ["RAW_UNRESOLVED_SECRET"],
    workingDir: "/repo/worktree",
  };
  const details = projectPipelineCheck(
    snapshot({
      definition: "plan-pipeline",
      status: "completed",
      stage: "complete",
      finishedAt: 15_000,
      completion,
      error: "RAW_ERROR_SECRET",
      agents: [],
    }),
    now,
  );
  assert.deepEqual(details.completion, {
    changedPathCount: 1,
    checkCount: 2,
    assumptionCount: 1,
    gitObservationCount: 1,
    reportCount: 1,
    unresolvedItemCount: 1,
    planPath: "docs/plans/example.md",
  });
  const serialized = JSON.stringify(details);
  for (const excluded of [
    "RAW_OUTCOME_SECRET",
    "RAW_CHANGED_PATH_SECRET",
    "RAW_CHECK_SECRET",
    "RAW_ASSUMPTION_SECRET",
    "RAW_GIT_SECRET",
    "RAW_REPORT_SECRET",
    "RAW_UNRESOLVED_SECRET",
    "RAW_ERROR_SECRET",
  ]) {
    assert.equal(serialized.includes(excluded), false, excluded);
  }
  for (const forbiddenKey of [
    "transcript",
    "liveAssistant",
    "finalText",
    "sessionFile",
    "activeTools",
    "error",
    "outcome",
    "changedPaths",
    "checks",
    "assumptions",
    "git",
    "reports",
    "unresolvedItems",
  ]) {
    assert.equal(forbiddenKey in details, false, forbiddenKey);
    assert.equal(
      details.agents.some((item) => forbiddenKey in item),
      false,
      forbiddenKey,
    );
  }
});

test("audit segment inspection is explicit, bounded, and omits private reducer evidence", () => {
  const run = snapshot({
    definition: "audit-pipeline",
    stage: "audit",
    agents: [
      agent({
        id: "audit-root",
        role: "audit-synthesis",
        model: "openai-codex/gpt-5.6-luna",
        status: "running",
        transcript: [
          {
            kind: "assistant",
            text: "private raw intermediate report and Git evidence",
            at: 1,
          },
        ],
      }),
      agent({
        id: "executor-1",
        parentId: "audit-root",
        role: "audit-executor",
        model: "openai-codex/gpt-5.6-luna",
        status: "running",
        transcript: [
          {
            kind: "tool",
            phase: "call",
            toolCallId: "bash-1",
            name: "bash",
            text: '{"command":"private command"}',
            isError: false,
            at: 2,
          },
        ],
      }),
    ],
    rootId: "audit-root",
    auditSegment: {
      mode: "closure",
      phase: "synthesizing",
      expectedReportCount: 5,
      acceptedReportCount: 3,
      pendingReportCount: 2,
      integratedReportCount: 1,
      reducerStatus: "busy",
      revision: 1,
      finalReportValidated: false,
    },
  });
  const projected = projectPipelineCheck(run, now);
  assert.deepEqual(projected.auditSegment, run.auditSegment);
  const serialized = JSON.stringify(projected);
  for (const privateField of [
    "prompt",
    "rawReport",
    "raw intermediate report",
    "Git evidence",
    "gitEvidence",
    "sessionFile",
    "toolArguments",
  ]) {
    assert.equal(serialized.includes(privateField), false);
  }
  assert.equal(projected.agents[1]?.role, "audit-executor");
  assert.equal("preview" in (projected.agents[1] ?? {}), false);
  assert.match(formatPipelineCheck(projected), /audit-executor/);
  assert.match(formatPipelineCheck(projected), /Open tool: bash/);
  assert.match(formatPipelineCheck(projected), /reports accepted 3\/5/);
});

test("active previews and whole check text enforce visible byte and line bounds", () => {
  const oversized = `${"🙂".repeat(700)}\n${Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n")}`;
  const previewDetails = projectPipelineCheck(
    snapshot({
      agents: [
        agent({
          id: "root-1",
          role: "pipeline-root",
          status: "running",
          liveAssistant: { text: oversized, thinking: "" },
        }),
      ],
    }),
    now,
  );
  const preview = previewDetails.agents[0]?.preview ?? "";
  assert.ok(Buffer.byteLength(preview, "utf8") <= PIPELINE_PREVIEW_MAX_BYTES);
  assert.ok(preview.split("\n").length <= PIPELINE_PREVIEW_MAX_LINES);
  assert.match(preview, /\[Preview truncated\.\]$/);

  const manyAgents = Array.from({ length: 30 }, (_, index) =>
    agent({
      id: `agent-${index}`,
      parentId: index === 0 ? undefined : "agent-0",
      role: index === 0 ? "pipeline-root" : `child-${index}`,
      status: "running",
      createdAt: index,
      liveAssistant: { text: "x".repeat(2_000), thinking: "" },
    }),
  );
  const whole = formatPipelineCheck(
    projectPipelineCheck(
      snapshot({ rootId: "agent-0", agents: manyAgents }),
      now,
    ),
  );
  assert.ok(Buffer.byteLength(whole, "utf8") <= PIPELINE_CHECK_MAX_BYTES);
  assert.match(whole, /\[Pipeline check truncated at 16 KiB\./);
  for (const item of manyAgents) {
    assert.match(whole, new RegExp(`- ${item.id} ·`));
  }
  assert.equal(whole.match(/  Preview:/g)?.length, manyAgents.length);
});
