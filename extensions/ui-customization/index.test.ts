import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PIPI_TITLE_LINES, pipiLogoLines, pipiWindowTitle } from "./index.ts";

test("welcome branding renders the full PIPI block logo", () => {
  assert.deepEqual(PIPI_TITLE_LINES, [
    "  ██████╗  ██╗ ██████╗  ██╗ ",
    "  ██╔══██╗ ██║ ██╔══██╗ ██║ ",
    "  ██████╔╝ ██║ ██████╔╝ ██║ ",
    "  ██╔═══╝  ██║ ██╔═══╝  ██║ ",
    "  ██║      ██║ ██║      ██║ ",
    "  ╚═╝      ╚═╝ ╚═╝      ╚═╝ ",
  ]);
  assert.equal(new Set(PIPI_TITLE_LINES.map(visibleWidth)).size, 1);
  assert.equal(pipiLogoLines(80), PIPI_TITLE_LINES);
  assert.deepEqual(pipiLogoLines(20), ["PIPI"]);
});

test("window title identifies Pipi", () => {
  assert.equal(pipiWindowTitle("~/code/project"), "pipi · ~/code/project");
});
