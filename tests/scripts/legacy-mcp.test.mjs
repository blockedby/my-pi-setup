import assert from "node:assert/strict";
import { test } from "node:test";
import { isLegacyMcpAdapterSource } from "../../scripts/legacy-mcp.mjs";

const agentDir = "/tmp/pipi-home/.pipi/agent";

test("legacy MCP recognition covers managed historical, current, and relative sources", () => {
  for (const source of [
    "npm:pi-mcp-adapter",
    "npm:pi-mcp-adapter@2.15.0",
    "runtime/node_modules/pi-mcp-adapter",
    "./npm/node_modules/pi-mcp-adapter",
    `${agentDir}/npm/node_modules/pi-mcp-adapter`,
    `${agentDir}/runtime/node_modules/pi-mcp-adapter`,
  ]) {
    assert.equal(isLegacyMcpAdapterSource(source, agentDir), true, source);
  }
  for (const source of [
    "npm:other-package",
    "npm:pi-mcp-adapter-extra",
    "/tmp/user-package/pi-mcp-adapter",
    "runtime/node_modules/other",
    undefined,
  ]) {
    assert.equal(
      isLegacyMcpAdapterSource(source, agentDir),
      false,
      String(source),
    );
  }
});
