import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { openAgentTakeover } from "../shared/agent-tree/takeover.ts";
import type { AgentNodeSnapshot } from "../shared/agent-tree/domain.ts";
import {
  PIPELINE_DEFINITIONS,
  stagesForDefinition,
  type PipelineRunSnapshot,
  type PipelineRunStatus,
  type PipelineStage,
} from "./domain.ts";
import type { PipelineController } from "./controller.ts";

export type PipelineRow =
  | {
      readonly key: string;
      readonly kind: "definition";
      readonly depth: 0;
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "run";
      readonly depth: 1;
      readonly label: string;
      readonly runId: string;
      readonly status: PipelineRunStatus;
      readonly expanded: boolean;
    }
  | {
      readonly key: string;
      readonly kind: "stage";
      readonly depth: 2;
      readonly label: string;
      readonly runId: string;
      readonly stage: PipelineStage;
      readonly status: "pending" | "running" | "done" | "failed" | "cancelled";
      readonly agentId?: string;
    }
  | {
      readonly key: string;
      readonly kind: "agent";
      readonly depth: 2 | 3;
      readonly label: string;
      readonly runId: string;
      readonly agentId: string;
      readonly status: AgentNodeSnapshot["status"];
    };

function childStage(role: string): PipelineStage {
  if (role === "implement-small-feature") return "build";
  if (role === "audit-small-feature") return "final-audit";
  if (role.startsWith("discover-")) return "discover";
  if (role.startsWith("audit-")) return "audit";
  return "final-audit";
}

function latestAgentId(agents: ReadonlyArray<AgentNodeSnapshot>) {
  return (
    agents.filter((agent) => agent.status === "running").at(-1) ?? agents.at(-1)
  )?.id;
}

function stageAgentId(
  run: PipelineRunSnapshot,
  stage: PipelineStage,
  root: AgentNodeSnapshot | undefined,
  children: ReadonlyArray<AgentNodeSnapshot>,
) {
  const matchingChild = latestAgentId(
    children.filter((agent) => childStage(agent.role) === stage),
  );
  if (matchingChild) return matchingChild;
  if (run.definition === "small-feature-pipeline") {
    if (stage !== "final-resolve") return undefined;
    return latestAgentId(
      children.filter((agent) => agent.role === "implement-small-feature"),
    );
  }
  if (
    stage === "build" ||
    stage === "audit-resolve" ||
    stage === "final-resolve" ||
    stage === "complete"
  ) {
    return root?.id;
  }
  return undefined;
}

export function buildPipelineRows(
  runs: ReadonlyArray<PipelineRunSnapshot>,
  expandedRunIds: ReadonlySet<string> = new Set(),
) {
  const rows: PipelineRow[] = [];
  for (const definition of PIPELINE_DEFINITIONS) {
    rows.push({
      key: `definition:${definition.id}`,
      kind: "definition",
      depth: 0,
      label: definition.id,
    });
    for (const run of runs.filter((run) => run.definition === definition.id)) {
      const expanded = expandedRunIds.has(run.id);
      rows.push({
        key: `run:${run.id}`,
        kind: "run",
        depth: 1,
        label: `${expanded ? "▾" : "▸"} ${run.id} · ${run.status} · ${run.workingDir}`,
        runId: run.id,
        status: run.status,
        expanded,
      });
      if (!expanded) continue;
      const root = run.rootId
        ? run.agents.find((agent) => agent.id === run.rootId)
        : undefined;
      const children = run.agents.filter(
        (agent) => agent.parentId === run.rootId,
      );
      if (root) {
        rows.push({
          key: `agent:${run.id}:root:${root.id}`,
          kind: "agent",
          depth: 2,
          label: `${root.title} · ${root.status}`,
          runId: run.id,
          agentId: root.id,
          status: root.status,
        });
      }
      const stages = stagesForDefinition(run.definition);
      const currentStageIndex = stages.indexOf(run.stage);
      for (const [stageIndex, stage] of stages.entries()) {
        const stageStatus =
          stageIndex < currentStageIndex
            ? "done"
            : stageIndex > currentStageIndex
              ? "pending"
              : run.status === "failed" || run.status === "cancelled"
                ? run.status
                : run.status === "completed"
                  ? "done"
                  : "running";
        rows.push({
          key: `stage:${run.id}:${stage}`,
          kind: "stage",
          depth: 2,
          label: `${stage} · ${stageStatus}`,
          runId: run.id,
          stage,
          status: stageStatus,
          agentId: stageAgentId(run, stage, root, children),
        });
        for (const child of children.filter(
          (agent) => childStage(agent.role) === stage,
        )) {
          rows.push({
            key: `agent:${run.id}:${stage}:${child.id}`,
            kind: "agent",
            depth: 3,
            label: `${child.role} · attempt ${child.attempt} · ${child.model} · ${child.status}`,
            runId: run.id,
            agentId: child.id,
            status: child.status,
          });
        }
      }
    }
  }
  return rows;
}

export async function cancelPipelineRow(
  controller: PipelineController,
  row: PipelineRow,
) {
  if (row.kind === "run") {
    await controller.cancelRun(row.runId);
    return;
  }
  if (row.kind !== "agent") return;
  const run = controller.get(row.runId);
  if (run?.rootId === row.agentId) {
    await controller.cancelRun(row.runId);
    return;
  }
  await controller.cancelChild(row.runId, row.agentId);
}

export interface PipelineSelection {
  key?: string;
  index: number;
}

export function reconcilePipelineSelection(
  selection: PipelineSelection,
  rows: ReadonlyArray<Pick<PipelineRow, "key">>,
) {
  const stable = selection.key
    ? rows.findIndex((row) => row.key === selection.key)
    : -1;
  selection.index =
    stable >= 0
      ? stable
      : Math.min(Math.max(0, selection.index), Math.max(0, rows.length - 1));
  selection.key = rows[selection.index]?.key;
}

export function agentIdForPipelineRow(row: PipelineRow) {
  if (row.kind === "agent" || row.kind === "stage") return row.agentId;
  return undefined;
}

export function togglePipelineRunExpansion(
  expandedRunIds: Set<string>,
  row: PipelineRow,
) {
  if (row.kind !== "run") return false;
  if (row.expanded) expandedRunIds.delete(row.runId);
  else expandedRunIds.add(row.runId);
  return true;
}

export function glyphStatusForPipelineRow(row: PipelineRow) {
  if (row.kind === "run") {
    if (row.status === "completed") return "done";
    if (row.status === "failed") return "error";
    if (row.status === "cancelled") return "cancelled";
    return "running";
  }
  if (row.kind === "stage") {
    if (row.status === "failed") return "error";
    if (row.status === "running" || row.status === "cancelled")
      return row.status;
  }
  if (row.kind === "agent" && row.depth === 3) return row.status;
  return undefined;
}

function statusGlyph(status: AgentNodeSnapshot["status"], theme: Theme) {
  if (status === "done" || status === "idle") return theme.fg("success", "■");
  if (status === "error" || status === "cancelled")
    return theme.fg("error", "■");
  return theme.fg("warning", "■");
}

class PipelineDashboard implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly controller: PipelineController;
  private readonly selection: PipelineSelection;
  private readonly expandedRunIds: Set<string>;
  private readonly done: (value: string | null) => void;
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    controller: PipelineController,
    selection: PipelineSelection,
    expandedRunIds: Set<string>,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.controller = controller;
    this.selection = selection;
    this.expandedRunIds = expandedRunIds;
    this.done = done;
    this.unsubscribe = controller.subscribe(() => tui.requestRender());
    this.ticker = setInterval(() => tui.requestRender(), 1_000);
  }

  private rows() {
    return buildPipelineRows(this.controller.list(), this.expandedRunIds);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    return true;
  }

  private close(value: string | null) {
    if (this.cleanup()) this.done(value);
  }

  dispose() {
    this.cleanup();
  }

  invalidate() {}

  handleInput(data: string) {
    const rows = this.rows();
    reconcilePipelineSelection(this.selection, rows);
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.selection.index =
        rows.length === 0
          ? 0
          : (this.selection.index - 1 + rows.length) % rows.length;
      this.selection.key = rows[this.selection.index]?.key;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.selection.index =
        rows.length === 0 ? 0 : (this.selection.index + 1) % rows.length;
      this.selection.key = rows[this.selection.index]?.key;
      this.tui.requestRender();
      return;
    }
    const selected = rows[this.selection.index];
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selectedAgentId = selected
        ? agentIdForPipelineRow(selected)
        : undefined;
      if (selectedAgentId) {
        this.close(selectedAgentId);
        return;
      }
      if (
        selected &&
        togglePipelineRunExpansion(this.expandedRunIds, selected)
      ) {
        reconcilePipelineSelection(this.selection, this.rows());
        this.tui.requestRender();
      }
      return;
    }
    if (
      data === "x" &&
      (selected?.kind === "run" || selected?.kind === "agent")
    ) {
      void cancelPipelineRow(this.controller, selected).catch(() => {});
    }
  }

  private pad(text: string, width: number) {
    const clipped = truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  render(width: number) {
    const rows = this.rows();
    reconcilePipelineSelection(this.selection, rows);
    const height = Math.max(8, (this.tui.terminal.rows || 30) - 5);
    const start = Math.min(
      Math.max(0, this.selection.index - Math.floor(height / 2)),
      Math.max(0, rows.length - height),
    );
    const visible = rows.slice(start, start + height);
    const lines = visible.map((row, offset) => {
      const index = start + offset;
      const marker =
        index === this.selection.index ? this.theme.fg("accent", "❯") : " ";
      const branch = row.depth === 0 ? "" : `${"  ".repeat(row.depth - 1)}└─ `;
      const glyphStatus = glyphStatusForPipelineRow(row);
      const glyph = glyphStatus
        ? `${statusGlyph(glyphStatus, this.theme)} `
        : "";
      const label =
        index === this.selection.index
          ? this.theme.fg("accent", row.label)
          : row.kind === "definition"
            ? this.theme.bold(row.label)
            : this.theme.fg("text", row.label);
      return this.pad(` ${marker} ${branch}${glyph}${label}`, width - 2);
    });
    while (lines.length < height)
      lines.push(" ".repeat(Math.max(0, width - 2)));
    const border = this.theme.fg("border", "─".repeat(Math.max(0, width - 2)));
    return [
      truncateToWidth(
        ` ${this.theme.bold(this.theme.fg("accent", "Pipelines"))}`,
        width,
      ),
      this.theme.fg("border", "╭") + border + this.theme.fg("border", "╮"),
      ...lines.map(
        (line) =>
          this.theme.fg("border", "│") + line + this.theme.fg("border", "│"),
      ),
      this.theme.fg("border", "╰") + border + this.theme.fg("border", "╯"),
      truncateToWidth(
        this.theme.fg(
          "dim",
          " j/k or up/down select · enter expand/collapse or transcript · x cancel · esc close",
        ),
        width,
      ),
    ];
  }
}

export async function showPipelineDashboard(
  ctx: ExtensionCommandContext,
  controller: PipelineController,
) {
  const selection: PipelineSelection = { index: 0 };
  const expandedRunIds = new Set<string>();
  while (true) {
    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new PipelineDashboard(
          tui,
          theme,
          keybindings,
          controller,
          selection,
          expandedRunIds,
          done,
        ),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    if (!picked) return;
    if (!controller.agentView.get(picked)) continue;
    await openAgentTakeover(ctx, controller.agentView, picked);
  }
}
