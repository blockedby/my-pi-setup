import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Check } from "typebox/value";
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
    const pipelines = result.extensions.find(
      (extension) =>
        extension.resolvedPath ===
        join(repositoryRoot, "extensions", "pipelines", "index.ts"),
    );
    assert.ok(pipelines, "Production pipeline extension is discovered");
    const parameters =
      pipelines.tools.get("pipeline_run")?.definition.parameters;
    assert.ok(parameters, "Production launch tool has its schema");
    const launch = {
      pipeline_name: "verify-modern-tool-schema",
      task: "Provider-free schema probe",
    };
    assert.equal(Check(parameters, launch), true);
    for (const pipeline of ["implementing-pipeline", "audit-pipeline"])
      assert.equal(Check(parameters, { ...launch, pipeline }), true);
    for (const pipeline of [
      "feature-pipeline",
      "small-feature-pipeline",
      "plan-pipeline",
    ])
      assert.equal(Check(parameters, { ...launch, pipeline }), false);
    assert.deepEqual(
      [...pipelines.commands.keys()]
        .filter((name) => name.startsWith("pipelines:"))
        .sort(),
      ["pipelines:audit-pipeline", "pipelines:implementing-pipeline"],
    );
    const subagents = result.extensions.find(
      (extension) =>
        extension.resolvedPath ===
        join(repositoryRoot, "extensions", "subagents", "index.ts"),
    );
    const spawnParameters =
      subagents?.tools.get("subagent_spawn")?.definition.parameters;
    assert.ok(
      spawnParameters,
      "Production subagent launch schema is discovered",
    );
    for (const profile of [
      "explore",
      "implement",
      "review",
      "luna-explore",
      "luna-worker",
      "sol-worker",
    ])
      assert.equal(
        Check(spawnParameters, {
          prompt: "Offline schema probe",
          name: "probe",
          profile,
          model: "openai-codex/gpt-6.1-sol",
          reasoning_effort: "max",
        }),
        true,
      );
    assert.equal(
      Check(spawnParameters, {
        prompt: "Offline schema probe",
        name: "probe",
        profile: "nonexistent",
      }),
      false,
    );
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
