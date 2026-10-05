import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createChildResources } from "../shared/child-session.ts";

// Every pipeline node, including feature roots, uses this shared SDK loader.
test("pipeline resource loader does not load native MCP even with configured servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipi-pipeline-mcp-"));
  try {
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const config = JSON.stringify({
      mcpServers: { local: { command: "nonexistent-test-server" } },
    });
    await writeFile(join(agentDir, "mcp.json"), config);
    await writeFile(join(cwd, ".pi", "mcp.json"), config);
    for (const projectTrusted of [false, true]) {
      const { loader } = await createChildResources({
        cwd,
        agentDir,
        projectTrusted,
      });
      const extensions = loader.getExtensions().extensions;
      assert.equal(
        extensions.some((extension) => extension.path === "builtin:mcp"),
        false,
      );
      assert.equal(
        extensions.some((extension) => extension.commands.has("mcp")),
        false,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
