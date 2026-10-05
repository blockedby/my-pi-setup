import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  type CompactionResult,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createChildBuiltinExtensions,
  normalizePiContextUsage,
  refreshPiUsageAfterCompaction,
} from "./src/backends/pi.ts";

const compactionResult: CompactionResult = {
  summary: "summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 311_923,
  details: { readFiles: [], modifiedFiles: [] },
};

async function loadChildBuiltinPaths(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}) {
  const settingsManager = SettingsManager.create(
    options.cwd,
    options.agentDir,
    { projectTrusted: options.projectTrusted },
  );
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: createChildBuiltinExtensions(),
  });
  await loader.reload();
  return loader
    .getExtensions()
    .extensions.map((extension) => extension.path)
    .filter((extensionPath) => extensionPath.startsWith("builtin:"))
    .sort();
}

test("ordinary Pi children load native MCP helpers and honor trusted project settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pipi-child-mcp-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  try {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "settings.json"),
      JSON.stringify({ extensions: ["-builtin:mcp"] }),
    );

    assert.deepEqual(
      await loadChildBuiltinPaths({ cwd, agentDir, projectTrusted: false }),
      ["builtin:codemode", "builtin:mcp", "builtin:tool-search"],
    );
    assert.deepEqual(
      await loadChildBuiltinPaths({ cwd, agentDir, projectTrusted: true }),
      ["builtin:codemode", "builtin:tool-search"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi context adapter preserves an explicit unknown token count", () => {
  assert.deepEqual(
    normalizePiContextUsage({
      tokens: null,
      contextWindow: 300_000,
      percent: null,
    }),
    { tokens: null, contextWindow: 300_000 },
  );
});

test("Pi context adapter omits unavailable tokens without clearing prior state", () => {
  assert.deepEqual(normalizePiContextUsage(undefined, 300_000), {
    contextWindow: 300_000,
  });
});

test("Pi context adapter prefers the active model capacity", () => {
  assert.deepEqual(
    normalizePiContextUsage(
      { tokens: 311_923, contextWindow: 200_000, percent: 155.9615 },
      300_000,
    ),
    { tokens: 311_923, contextWindow: 300_000 },
  );
});

test("successful Pi compaction refreshes usage", () => {
  let refreshes = 0;
  refreshPiUsageAfterCompaction(
    {
      type: "compaction_end",
      reason: "threshold",
      result: compactionResult,
      aborted: false,
      willRetry: false,
    },
    () => {
      refreshes += 1;
    },
  );
  assert.equal(refreshes, 1);
});

test("aborted or result-less Pi compaction keeps prior usage", () => {
  let refreshes = 0;
  const emitUsage = () => {
    refreshes += 1;
  };
  refreshPiUsageAfterCompaction(
    {
      type: "compaction_end",
      reason: "threshold",
      result: compactionResult,
      aborted: true,
      willRetry: false,
    },
    emitUsage,
  );
  refreshPiUsageAfterCompaction(
    {
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    },
    emitUsage,
  );
  assert.equal(refreshes, 0);
});
