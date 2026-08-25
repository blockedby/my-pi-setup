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
  FEATURE_PIPELINE_ID,
  PIPELINE_STAGES,
  type PipelineRunSnapshot,
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
    }
  | {
      readonly key: string;
      readonly kind: "stage";
      readonly depth: 2;
      readonly label: string;
      readonly runId: string;
      readonly stage: PipelineStage;
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
  if (role.startsWith("discover-")) return "discover";
  if (role.startsWith("audit-")) return "audit";
  return "final-audit";
}

export function buildPipelineRows(runs: ReadonlyArray<PipelineRunSnapshot>) {
  const rows: PipelineRow[] = [
    {
      key: `definition:${FEATURE_PIPELINE_ID}`,
      kind: "definition",
      depth: 0,
      label: FEATURE_PIPELINE_ID,
    },
  ];
  for (const run of runs) {
    rows.push({
      key: `run:${run.id}`,
      kind: "run",
      depth: 1,
      label: `${run.id} · ${run.status} · ${run.workingDir}`,
      runId: run.id,
    });
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
    const currentStageIndex = PIPELINE_STAGES.indexOf(run.stage);
    for (const [stageIndex, stage] of PIPELINE_STAGES.entries()) {
      const stageStatus =
        stageIndex < currentStageIndex
          ? "done"
          : stageIndex > currentStageIndex
            ? "pending"
            : run.status === "failed" || run.status === "cancelled"
              ? run.status
              : run.status === "completed"
                ? "done"
                : "current";
      rows.push({
        key: `stage:${run.id}:${stage}`,
        kind: "stage",
        depth: 2,
        label: `${stage} · ${stageStatus}`,
        runId: run.id,
        stage,
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
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.controller = controller;
    this.selection = selection;
    this.done = done;
    this.unsubscribe = controller.subscribe(() => tui.requestRender());
    this.ticker = setInterval(() => tui.requestRender(), 1_000);
  }

  private rows() {
    return buildPipelineRows(this.controller.list());
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
      if (selected?.kind === "agent") this.close(selected.agentId);
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
      const glyph =
        row.kind === "agent" ? `${statusGlyph(row.status, this.theme)} ` : "";
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
          " j/k or up/down select · enter transcript/takeover · x cancel · esc close",
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
  while (true) {
    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new PipelineDashboard(
          tui,
          theme,
          keybindings,
          controller,
          selection,
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
