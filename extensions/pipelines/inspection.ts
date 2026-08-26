import {
  defineTool,
  truncateHead,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";
import { stagesForDefinition, type PipelineRunSnapshot } from "./domain.ts";

export const PIPELINE_CHECK_MAX_BYTES = 16 * 1024;
export const PIPELINE_PREVIEW_MAX_BYTES = 2 * 1024;
export const PIPELINE_PREVIEW_MAX_LINES = 20;

const AGENT_STATUSES = [
  "starting",
  "running",
  "idle",
  "done",
  "error",
  "cancelled",
] as const;

const PREVIEW_TRUNCATION_MARKER = "[Preview truncated.]";
const CHECK_TRUNCATION_MARKER =
  "[Pipeline check truncated at 16 KiB. Full transcripts remain available in /pipelines.]";

export const PIPELINE_CHECK_PARAMETERS = Type.Object(
  {
    id: Type.String({
      description: "Session-scoped pipeline run id to inspect.",
      minLength: 1,
      maxLength: 1024,
    }),
  },
  { additionalProperties: false },
);

export const PIPELINE_LIST_PARAMETERS = Type.Object(
  {},
  { additionalProperties: false },
);

interface PipelineInspectionController {
  get(runId: string): PipelineRunSnapshot | undefined;
  list(): ReadonlyArray<PipelineRunSnapshot>;
}

function boundedWithVisibleMarker(
  text: string,
  options: { maxBytes: number; maxLines: number; marker: string },
) {
  const initial = truncateHead(text, {
    maxBytes: options.maxBytes,
    maxLines: options.maxLines,
  });
  if (!initial.truncated) return initial.content;

  const suffix = `\n${options.marker}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const bounded = truncateHead(text, {
    maxBytes: Math.max(1, options.maxBytes - suffixBytes),
    maxLines: Math.max(1, options.maxLines - 1),
  });
  return `${bounded.content}${suffix}`;
}

function boundedPreview(text: string) {
  return boundedWithVisibleMarker(text, {
    maxBytes: PIPELINE_PREVIEW_MAX_BYTES,
    maxLines: PIPELINE_PREVIEW_MAX_LINES,
    marker: PREVIEW_TRUNCATION_MARKER,
  });
}

function latestFinalizedAssistantText(agent: AgentNodeSnapshot) {
  for (let index = agent.transcript.length - 1; index >= 0; index--) {
    const item = agent.transcript[index];
    if (item?.kind === "assistant" && item.text.trim()) return item.text;
  }
  return undefined;
}

function previewFor(agent: AgentNodeSnapshot) {
  const live = agent.liveAssistant?.text;
  const text = live?.trim() ? live : latestFinalizedAssistantText(agent);
  return text ? boundedPreview(text) : undefined;
}

function openToolFor(agent: AgentNodeSnapshot) {
  const settledCalls = new Set(
    agent.transcript.flatMap((item) =>
      item.kind === "tool" && item.phase === "result" ? [item.toolCallId] : [],
    ),
  );
  for (let index = agent.transcript.length - 1; index >= 0; index--) {
    const item = agent.transcript[index];
    if (
      item?.kind === "tool" &&
      item.phase === "call" &&
      !settledCalls.has(item.toolCallId)
    ) {
      return item.name;
    }
  }
  return undefined;
}

function orderedAgents(run: PipelineRunSnapshot) {
  return run.agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const leftRoot = left.agent.id === run.rootId || !left.agent.parentId;
      const rightRoot = right.agent.id === run.rootId || !right.agent.parentId;
      if (leftRoot !== rightRoot) return leftRoot ? -1 : 1;
      return (
        left.agent.createdAt - right.agent.createdAt || left.index - right.index
      );
    })
    .map(({ agent }) => agent);
}

function agentStatusCounts(agents: ReadonlyArray<AgentNodeSnapshot>) {
  return Object.fromEntries(
    AGENT_STATUSES.map((status) => [
      status,
      agents.filter((agent) => agent.status === status).length,
    ]),
  ) as Record<(typeof AGENT_STATUSES)[number], number>;
}

function elapsedMs(run: PipelineRunSnapshot, now: number) {
  return Math.max(0, (run.finishedAt ?? now) - run.startedAt);
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

function completionProjection(run: PipelineRunSnapshot) {
  if (!run.completion) return undefined;
  return {
    changedPathCount: run.completion.changedPaths.length,
    checkCount: run.completion.checks.length,
    assumptionCount: run.completion.assumptions.length,
    gitObservationCount: run.completion.git.length,
    reportCount: run.completion.reports.length,
    unresolvedItemCount: run.completion.unresolvedItems.length,
    ...(run.completion.planPath ? { planPath: run.completion.planPath } : {}),
  };
}

export function projectPipelineList(runs: ReadonlyArray<PipelineRunSnapshot>) {
  return runs
    .map((run, index) => ({ run, index }))
    .sort(
      (left, right) =>
        right.run.startedAt - left.run.startedAt || left.index - right.index,
    )
    .map(({ run }) => ({
      id: run.id,
      definition: run.definition,
      stage: run.stage,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      workingDir: run.workingDir,
    }));
}

export function formatPipelineList(
  pipelines: ReturnType<typeof projectPipelineList>,
) {
  if (pipelines.length === 0) return "No pipelines.";
  return pipelines
    .map(
      (run) =>
        `${run.id} [${run.status}] ${run.definition} · ${run.stage} · ${new Date(run.startedAt).toISOString()} · ${run.workingDir}`,
    )
    .join("\n");
}

export function projectPipelineCheck(
  run: PipelineRunSnapshot,
  now = Date.now(),
) {
  const agents = orderedAgents(run);
  const stages = stagesForDefinition(run.definition);
  const stageIndex = stages.indexOf(run.stage);
  const root = agents.find(
    (agent) => agent.id === run.rootId || !agent.parentId,
  );
  const projectedAgents = agents.map((agent) => {
    const active = agent.status === "starting" || agent.status === "running";
    const preview = active ? previewFor(agent) : undefined;
    const openTool = active ? openToolFor(agent) : undefined;
    return {
      id: agent.id,
      role: agent.role,
      attempt: agent.attempt,
      model: agent.model,
      status: agent.status,
      ...(active && preview ? { preview } : {}),
      ...(active && openTool ? { openTool } : {}),
      ...(active && !preview && !openTool
        ? { noModelVisibleOutput: true }
        : {}),
    };
  });

  const completion =
    run.status === "starting" || run.status === "running"
      ? undefined
      : completionProjection(run);

  return {
    id: run.id,
    definition: run.definition,
    status: run.status,
    stage: run.stage,
    stageProgress: {
      current: stageIndex >= 0 ? stageIndex + 1 : 0,
      total: stages.length,
    },
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    elapsedMs: elapsedMs(run, now),
    workingDir: run.workingDir,
    rootStatus: root?.status ?? "not-started",
    agentStatusCounts: agentStatusCounts(agents),
    agents: projectedAgents,
    ...(completion ? { completion } : {}),
  };
}

type ProjectedPipelineCheck = ReturnType<typeof projectPipelineCheck>;
type ProjectedAgent = ProjectedPipelineCheck["agents"][number];

function activeAgent(agent: ProjectedAgent) {
  return agent.status === "starting" || agent.status === "running";
}

function agentLine(agent: ProjectedAgent) {
  return `- ${agent.id} · ${agent.role} · attempt ${agent.attempt} · ${agent.model} · ${agent.status}`;
}

function compactAgentLines(agents: ReadonlyArray<ProjectedAgent>) {
  const settledGroups = new Map<string, ProjectedAgent[]>();
  for (const agent of agents.slice(1)) {
    if (activeAgent(agent)) continue;
    const key = JSON.stringify([agent.role, agent.model, agent.status]);
    const group = settledGroups.get(key) ?? [];
    group.push(agent);
    settledGroups.set(key, group);
  }

  const emittedGroups = new Set<string>();
  return agents.flatMap((agent, index) => {
    if (index === 0 || activeAgent(agent)) return [agentLine(agent)];
    const key = JSON.stringify([agent.role, agent.model, agent.status]);
    const group = settledGroups.get(key) ?? [agent];
    if (group.length === 1) return [agentLine(agent)];
    if (emittedGroups.has(key)) return [];
    emittedGroups.add(key);
    const attemptRange = group.reduce(
      (range, item) => ({
        first: Math.min(range.first, item.attempt),
        last: Math.max(range.last, item.attempt),
      }),
      { first: agent.attempt, last: agent.attempt },
    );
    return [
      `- ${agent.role} · attempts ${attemptRange.first}–${attemptRange.last} · ${agent.model} · ${agent.status} · ${group.length} agents (IDs in structured details)`,
    ];
  });
}

export function formatPipelineCheck(details: ProjectedPipelineCheck) {
  const counts = AGENT_STATUSES.map(
    (status) => `${status} ${details.agentStatusCounts[status]}`,
  ).join(", ");
  const lines = [
    `Pipeline ${details.id}`,
    `Definition: ${details.definition}`,
    `Status: ${details.status}`,
    `Stage: ${details.stage} (${details.stageProgress.current}/${details.stageProgress.total})`,
    `Elapsed: ${formatElapsed(details.elapsedMs)}`,
    `Working directory: ${details.workingDir}`,
    `Root status: ${details.rootStatus}`,
    `Agent status counts: ${counts}`,
  ];
  const previewSlots: Array<{ index: number; text: string }> = [];

  if (details.agents.length === 0) {
    lines.push("Agents: none.");
  } else {
    lines.push("Agents:", ...compactAgentLines(details.agents));
    const active = details.agents.filter(activeAgent);
    if (active.length > 0) lines.push("Active agent previews:");
    for (const agent of active) {
      lines.push(
        `${agent.id} · ${agent.role} · attempt ${agent.attempt} · ${agent.model} · ${agent.status}`,
      );
      if ("openTool" in agent && agent.openTool) {
        lines.push(`  Open tool: ${agent.openTool}`);
      }
      if ("preview" in agent && agent.preview) {
        lines.push("  Preview:");
        previewSlots.push({ index: lines.length, text: agent.preview });
        lines.push("");
      }
      if ("noModelVisibleOutput" in agent && agent.noModelVisibleOutput) {
        lines.push("  No model-visible output yet.");
      }
    }
  }

  if (details.completion) {
    lines.push(
      `Completion counts: changed paths ${details.completion.changedPathCount}, checks ${details.completion.checkCount}, assumptions ${details.completion.assumptionCount}, Git observations ${details.completion.gitObservationCount}, reports ${details.completion.reportCount}, unresolved items ${details.completion.unresolvedItemCount}`,
    );
    if (details.completion.planPath) {
      lines.push(`Plan path: ${details.completion.planPath}`);
    }
  }

  for (const slot of previewSlots) lines[slot.index] = slot.text;
  const complete = lines.join("\n");
  if (Buffer.byteLength(complete, "utf8") <= PIPELINE_CHECK_MAX_BYTES) {
    return complete;
  }

  const previewMarker = "[Preview truncated by whole-check limit.]";
  for (const slot of previewSlots) lines[slot.index] = previewMarker;
  const suffix = `\n${CHECK_TRUNCATION_MARKER}`;
  const fixedBytes = Buffer.byteLength(`${lines.join("\n")}${suffix}`, "utf8");
  const markerBytes = Buffer.byteLength(previewMarker, "utf8");
  const perPreviewBytes =
    previewSlots.length > 0
      ? markerBytes +
        Math.floor(
          Math.max(0, PIPELINE_CHECK_MAX_BYTES - fixedBytes) /
            previewSlots.length,
        )
      : 0;
  for (const slot of previewSlots) {
    lines[slot.index] = boundedWithVisibleMarker(slot.text, {
      maxBytes: perPreviewBytes,
      maxLines: PIPELINE_PREVIEW_MAX_LINES,
      marker: previewMarker,
    });
  }

  const prioritized = `${lines.join("\n")}${suffix}`;
  if (Buffer.byteLength(prioritized, "utf8") <= PIPELINE_CHECK_MAX_BYTES) {
    return prioritized;
  }
  return boundedWithVisibleMarker(prioritized, {
    maxBytes: PIPELINE_CHECK_MAX_BYTES,
    maxLines: PIPELINE_CHECK_MAX_BYTES,
    marker: CHECK_TRUNCATION_MARKER,
  });
}

export function inspectPipeline(
  controller: PipelineInspectionController,
  runId: string,
  now = Date.now(),
) {
  const run = controller.get(runId);
  if (!run) {
    const known = projectPipelineList(controller.list()).map((item) => item.id);
    throw new Error(
      `Unknown pipeline id "${runId}". Known: ${known.join(", ") || "none"}.`,
    );
  }
  const details = projectPipelineCheck(run, now);
  return {
    content: [{ type: "text" as const, text: formatPipelineCheck(details) }],
    details: { pipeline: details },
  };
}

export function listPipelines(controller: PipelineInspectionController) {
  const pipelines = projectPipelineList(controller.list());
  return {
    content: [{ type: "text" as const, text: formatPipelineList(pipelines) }],
    details: { pipelines },
  };
}

export function createPipelineInspectionTools(
  getController: (ctx: ExtensionContext) => PipelineInspectionController,
) {
  return [
    defineTool({
      name: "pipeline_check",
      label: "Check Pipeline",
      description:
        "Synchronously inspect one session-scoped pipeline run without waiting, changing lifecycle state, or consuming its automatic completion handoff. Active previews and total output are bounded.",
      promptSnippet: "Inspect one known pipeline run without waiting",
      promptGuidelines: [
        "Use pipeline_check only for an occasional nonblocking snapshot of a known run. Do not poll: pipeline completion arrives automatically as a follow-up handoff.",
      ],
      parameters: PIPELINE_CHECK_PARAMETERS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        return inspectPipeline(getController(ctx), params.id);
      },
    }),
    defineTool({
      name: "pipeline_list",
      label: "List Pipelines",
      description:
        "List all session-scoped pipeline runs newest-first using a compact projection. Returns No pipelines. when none are tracked.",
      promptSnippet: "List tracked pipeline runs without waiting",
      promptGuidelines: [
        "Use pipeline_list only when selecting among known session-scoped runs. Do not poll: pipeline completion arrives automatically as a follow-up handoff.",
      ],
      parameters: PIPELINE_LIST_PARAMETERS,
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        return listPipelines(getController(ctx));
      },
    }),
  ];
}
