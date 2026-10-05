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
import { normalizeCodexToolsPackage } from "../../scripts/install.mjs";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const codexToolsAdapterRoot = join(repositoryRoot, "adapters", "codex-tools");
const codexExtensionPath = join(
  repositoryRoot,
  "vendor",
  "pi-codex",
  "extensions",
  "codex-tools.ts",
);
const codexToolNames = [
  "web_search_codex",
  "web_fetch_codex",
  "apply_patch_codex",
  "codex_task",
];
const normalizedNpmLegacyEntries = [
  ["unversioned string", "npm:pi-codex-tools"],
  ["versioned string", "npm:pi-codex-tools@1.2.3"],
  [
    "unversioned object",
    { source: "npm:pi-codex-tools", extensions: ["extensions/codex-tools.ts"] },
  ],
  [
    "versioned object",
    {
      source: "npm:pi-codex-tools@1.2.3",
      extensions: ["extensions/codex-tools.ts"],
    },
  ],
];

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

test("normalized npm legacy Codex entries discover one registration with all tools", async (t) => {
  for (const [label, legacyEntry] of normalizedNpmLegacyEntries) {
    await t.test(label, async () => {
      const agentDir = await mkdtemp(join(tmpdir(), "pipi-host-legacy-codex-"));
      try {
        const normalizedPackages = normalizeCodexToolsPackage({
          packages: [legacyEntry],
          desiredPath: codexToolsAdapterRoot,
          settingsBaseDir: agentDir,
          home: dirname(agentDir),
        });
        const settingsManager = SettingsManager.inMemory({
          packages: [repositoryRoot, ...normalizedPackages],
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
          (extension) => extension.resolvedPath === codexExtensionPath,
        );
        assert.equal(codex.length, 1);
        for (const name of codexToolNames)
          assert.equal(codex[0].tools.has(name), true, name);
      } finally {
        await rm(agentDir, { recursive: true, force: true });
      }
    });
  }
});
