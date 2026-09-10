import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createEventBus,
  discoverAndLoadExtensions,
  type Extension,
} from "@earendil-works/pi-coding-agent";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const extensionPaths = [
  path.join(repositoryRoot, "extensions/subagents/index.ts"),
  path.join(repositoryRoot, "extensions/pipelines/index.ts"),
  path.join(repositoryRoot, "extensions/herdr-pipi/index.ts"),
];

const expectedRegistrations = {
  "extensions/subagents/index.ts": {
    tools: [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_check",
      "subagent_list",
    ],
    handlers: [
      "session_start",
      "agent_settled",
      "tool_result",
      "session_shutdown",
    ],
    commands: ["btw", "subagents"],
    messageRenderers: ["subagent-result"],
    entryRenderers: ["btw-result"],
  },
  "extensions/pipelines/index.ts": {
    tools: [
      "pipeline_run",
      "pipeline_artifact_read",
      "pipeline_cancel",
      "pipeline_check",
      "pipeline_list",
    ],
    handlers: ["session_start", "session_shutdown"],
    commands: [
      "pipeline:feature-pipeline",
      "pipeline:small-feature-pipeline",
      "pipeline:plan-pipeline",
      "pipeline:audit-pipeline",
      "pipelines",
    ],
    messageRenderers: ["pipeline-handoff"],
    entryRenderers: [],
  },
  "extensions/herdr-pipi/index.ts": {
    tools: [],
    handlers: [
      "session_start",
      "agent_start",
      "agent_settled",
      "ui_prompt_start",
      "ui_prompt_end",
      "session_shutdown",
    ],
    commands: [],
    messageRenderers: [],
    entryRenderers: [],
  },
} as const;

const herdrEnvironmentKeys = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
] as const;

function names(values: Iterable<string>) {
  return [...values].sort();
}

function assertRegistration(
  extension: Extension,
  expected: {
    readonly tools: readonly string[];
    readonly handlers: readonly string[];
    readonly commands: readonly string[];
    readonly messageRenderers: readonly string[];
    readonly entryRenderers: readonly string[];
  },
) {
  assert.deepEqual(names(extension.tools.keys()), names(expected.tools));
  assert.deepEqual(names(extension.handlers.keys()), names(expected.handlers));
  assert.deepEqual(names(extension.commands.keys()), names(expected.commands));
  assert.deepEqual(
    names(extension.messageRenderers.keys()),
    names(expected.messageRenderers),
  );
  assert.deepEqual(
    names(extension.entryRenderers?.keys() ?? []),
    names(expected.entryRenderers),
  );
}

function withoutHerdrEnvironment() {
  const previous = new Map(
    herdrEnvironmentKeys.map((key) => [key, process.env[key]] as const),
  );
  for (const key of herdrEnvironmentKeys) delete process.env[key];
  return () => {
    for (const key of herdrEnvironmentKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("loads all production extensions and preserves their registrations", async () => {
  const restoreHerdrEnvironment = withoutHerdrEnvironment();
  const eventBus = createEventBus();

  try {
    // Use Pi's exported production loader directly. One event bus is shared by
    // all factories so the Herdr consumer and activity publishers use the
    // same channel when sessions are later bound by Pi.
    const result = await discoverAndLoadExtensions(
      extensionPaths,
      repositoryRoot,
      path.join(repositoryRoot, ".loader-test-agent-dir"),
      eventBus,
    );

    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.extensions.map((extension) => extension.resolvedPath),
      extensionPaths,
    );

    for (const [relativePath, expected] of Object.entries(
      expectedRegistrations,
    )) {
      const extension = result.extensions.find(
        (candidate) =>
          path.relative(repositoryRoot, candidate.resolvedPath) ===
          relativePath,
      );
      assert.ok(extension, `Expected ${relativePath} to load`);
      assertRegistration(extension, expected);
    }
  } finally {
    eventBus.clear();
    restoreHerdrEnvironment();
  }
});
