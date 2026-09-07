import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createToolCallTimeoutGuard,
  runWithToolCallTimeout,
  CHILD_TOOL_CALL_TIMEOUT_MS,
  ToolCallTimeoutError,
} from "./tool-call-timeout.ts";

test("the production timeout error names the tool and three-minute limit", () => {
  assert.equal(
    new ToolCallTimeoutError("fixture_tool", CHILD_TOOL_CALL_TIMEOUT_MS)
      .message,
    'Tool call "fixture_tool" timed out after 3 minutes.',
  );
});

test("a hung tool call fails clearly and receives an abort signal", async () => {
  let executionSignal: AbortSignal | undefined;

  await assert.rejects(
    runWithToolCallTimeout("hung_fixture", 10, undefined, (signal) => {
      executionSignal = signal;
      return new Promise(() => {});
    }),
    (error: unknown) => {
      assert.equal(error instanceof ToolCallTimeoutError, true);
      assert.equal(
        error instanceof Error ? error.message : "",
        'Tool call "hung_fixture" timed out after 10 ms.',
      );
      return true;
    },
  );

  assert.equal(executionSignal?.aborted, true);
  assert.equal(executionSignal?.reason instanceof ToolCallTimeoutError, true);
});

test("parent cancellation still stops the timeout wrapper immediately", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled fixture");
  const pending = runWithToolCallTimeout(
    "hung_fixture",
    60_000,
    controller.signal,
    () => new Promise(() => {}),
  );

  controller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("the guard wraps each definition once and can discover later tools", () => {
  const definitions = new Map<string, ToolDefinition>();
  const createDefinition = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  });
  const first = createDefinition("first");
  definitions.set(first.name, first);
  const registry = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
  };
  const guard = createToolCallTimeoutGuard(10);

  const firstExecute = first.execute;
  guard.apply(registry);
  const firstWrappedExecute = first.execute;
  assert.notEqual(firstWrappedExecute, firstExecute);

  const second = createDefinition("second");
  const secondExecute = second.execute;
  definitions.set(second.name, second);
  guard.apply(registry);

  assert.equal(first.execute, firstWrappedExecute);
  assert.notEqual(second.execute, secondExecute);
});

test("a per-tool policy disables only the selected tool timeout", async () => {
  const definitions = new Map<string, ToolDefinition>();
  const createDefinition = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  });
  const wait = createDefinition("pipeline_child_wait");
  wait.execute = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { content: [{ type: "text", text: "waited" }], details: {} };
  };
  const other = createDefinition("pipeline_child_send");
  other.execute = async () => new Promise(() => {});
  definitions.set(wait.name, wait);
  definitions.set(other.name, other);
  const registry = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
  };
  const guard = createToolCallTimeoutGuard(5, (toolName) =>
    toolName === "pipeline_child_wait" ? null : undefined,
  );
  guard.apply(registry);
  const execute = (definition: ToolDefinition) =>
    definition.execute(
      "fixture",
      {},
      undefined,
      undefined,
      {} as ExtensionContext,
    );

  const result = await execute(wait);
  assert.equal(result.content[0]?.type, "text");
  await assert.rejects(
    execute(other),
    (error: unknown) => error instanceof ToolCallTimeoutError,
  );
});

test("a no-timeout call still honors parent cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled wait fixture");
  let executionSignal: AbortSignal | undefined;
  const pending = runWithToolCallTimeout(
    "pipeline_child_wait",
    undefined,
    controller.signal,
    (signal) => {
      executionSignal = signal;
      return new Promise(() => {});
    },
  );

  controller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.equal(executionSignal?.aborted, true);
});

test("a pre-aborted no-timeout call does not start execution", async () => {
  const controller = new AbortController();
  const reason = new Error("already cancelled fixture");
  controller.abort(reason);
  let executed = false;

  await assert.rejects(
    runWithToolCallTimeout(
      "pipeline_child_wait",
      undefined,
      controller.signal,
      async () => {
        executed = true;
        return "unexpected";
      },
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(executed, false);
});

test("successful and terminating tool results pass through unchanged", async () => {
  const result = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };

  assert.equal(
    await runWithToolCallTimeout(
      "structured_output",
      10,
      undefined,
      async () => result,
    ),
    result,
  );
});

test("the timeout is fresh for each tool call, not shared across calls", async () => {
  const execute = () =>
    runWithToolCallTimeout("slow_fixture", 100, undefined, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "done";
    });

  assert.equal(await execute(), "done");
  assert.equal(await execute(), "done");
});
