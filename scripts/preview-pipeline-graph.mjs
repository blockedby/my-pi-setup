// Run with Bun in a terminal. Exercises the production dashboard with a fixed
// nested graph snapshot; never launches pipelines, agents, or Git operations.
import {
  ProcessTerminal,
  TuiMainScreen,
  matchesKey,
} from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { PipelineDashboard } from "../extensions/pipelines/dashboard.ts";
import { graphPreviewRun } from "../extensions/pipelines/__fixtures__/graph-preview.ts";

if (!process.stdin.isTTY)
  throw new Error("Run this preview in an interactive terminal.");
initTheme("dark", false);
const snapshot = graphPreviewRun();
const tui = new TuiMainScreen(new ProcessTerminal());
const stop = () => {
  dashboard.dispose();
  tui.stop();
};
const dashboard = new PipelineDashboard(
  tui,
  theme,
  {
    matches: (data, key) => {
      const keys = {
        "tui.select.cancel": "escape",
        "tui.select.confirm": "enter",
        "tui.select.up": "up",
        "tui.select.down": "down",
      };
      return keys[key] ? matchesKey(data, keys[key]) : false;
    },
  },
  {
    list: () => [snapshot],
    get: () => snapshot,
    subscribe: () => () => true,
    cancelRun: async () => {
      throw new Error("UI-only preview: cancellation disabled");
    },
    cancelChild: async () => {
      throw new Error("UI-only preview: cancellation disabled");
    },
  },
  { index: 0, key: `feature:${snapshot.id}:migrate-data` },
  new Set([snapshot.id]),
  stop,
);
tui.addChild(dashboard);
tui.setFocus(dashboard);
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
tui.start();
