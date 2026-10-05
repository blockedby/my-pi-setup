import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("production Pipi and pinned Codex adapter load without host dependency warnings", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pipi-host-peers-"));
  try {
    const settingsManager = SettingsManager.inMemory({
      packages: [
        repositoryRoot,
        join(repositoryRoot, "adapters", "codex-tools"),
      ],
    });
    const loader = new DefaultResourceLoader({
      cwd: repositoryRoot,
      agentDir,
      settingsManager,
      projectTrusted: false,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    const codex = result.extensions.filter(
      (extension) =>
        extension.resolvedPath ===
        join(
          repositoryRoot,
          "vendor",
          "pi-codex",
          "extensions",
          "codex-tools.ts",
        ),
    );
    assert.equal(codex.length, 1);
    for (const name of [
      "web_search_codex",
      "web_fetch_codex",
      "apply_patch_codex",
      "codex_task",
    ])
      assert.equal(codex[0].tools.has(name), true, name);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
