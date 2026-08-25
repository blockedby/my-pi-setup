import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentNodeSnapshot, AgentTreeReadModel } from "./domain.ts";

function transcriptLines(node: AgentNodeSnapshot, width: number, theme: Theme) {
  const lines: string[] = [];
  for (const item of node.transcript) {
    if (item.kind === "user") {
      lines.push(
        ...wrapTextWithAnsi(
          theme.fg("userMessageText", `> ${item.text}`),
          width,
        ),
      );
    } else if (item.kind === "assistant") {
      if (item.thinking) {
        lines.push(
          ...wrapTextWithAnsi(theme.fg("muted", `~ ${item.thinking}`), width),
        );
      }
      lines.push(...wrapTextWithAnsi(item.text, width));
    } else {
      const color = item.isError ? "error" : "dim";
      const label = item.phase === "call" ? `→ ${item.name}` : `← ${item.name}`;
      lines.push(
        ...wrapTextWithAnsi(
          theme.fg(color, `${label}: ${item.text || "(no output)"}`),
          width,
        ),
      );
    }
    lines.push("");
  }
  while (lines.at(-1) === "") lines.pop();
  if (node.liveAssistant?.thinking) {
    lines.push(
      ...wrapTextWithAnsi(
        theme.fg("muted", `~ ${node.liveAssistant.thinking}`),
        width,
      ),
    );
  }
  if (node.liveAssistant?.text) {
    lines.push(...wrapTextWithAnsi(node.liveAssistant.text, width));
  }
  return lines;
}

class AgentTakeoverView implements Component, Focusable {
  private readonly input = new Input();
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly view: AgentTreeReadModel;
  private readonly id: string;
  private readonly done: (value: null) => void;
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private scroll = 0;
  private closed = false;
  private _focused = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: AgentTreeReadModel,
    id: string,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.id = id;
    this.done = done;
    this.unsubscribe = view.subscribeTo(id, () => tui.requestRender());
    this.ticker = setInterval(() => tui.requestRender(), 1_000);
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scroll = 0;
      this.tui.requestRender();
    };
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.ticker);
    return true;
  }

  dispose() {
    this.cleanup();
  }

  invalidate() {
    this.input.invalidate();
  }

  handleInput(data: string) {
    if (this.keybindings.matches(data, "app.clear")) {
      this.view.requestCancel(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      if (this.cleanup()) this.done(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scroll += 6;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scroll = Math.max(0, this.scroll - 6);
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number) {
    const node = this.view.get(this.id);
    if (!node) return [this.theme.fg("error", `Agent ${this.id} is unknown`)];
    const height = Math.max(6, (this.tui.terminal.rows || 30) - 8);
    const transcript = transcriptLines(node, width, this.theme);
    const maxScroll = Math.max(0, transcript.length - height);
    this.scroll = Math.min(this.scroll, maxScroll);
    const end = transcript.length - this.scroll;
    const visible = transcript.slice(Math.max(0, end - height), end);
    while (visible.length < height) visible.unshift("");

    const border = this.theme.fg("borderAccent", "─".repeat(width));
    return [
      border,
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold(node.title))} ${this.theme.fg("muted", `· ${node.role} · attempt ${node.attempt} · ${node.model} · ${node.status}`)}`,
        width,
      ),
      border,
      ...visible,
      border,
      ...this.input.render(width),
      truncateToWidth(
        this.theme.fg(
          "dim",
          "enter send · esc back · ctrl+c cancel · up/down scroll",
        ),
        width,
      ),
      border,
    ];
  }
}

export async function openAgentTakeover(
  ctx: ExtensionCommandContext,
  view: AgentTreeReadModel,
  id: string,
) {
  if (!view.get(id)) throw new Error(`Unknown agent id "${id}".`);
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new AgentTakeoverView(tui, theme, keybindings, view, id, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
