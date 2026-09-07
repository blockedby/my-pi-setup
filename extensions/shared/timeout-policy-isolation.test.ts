import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createToolCallTimeoutGuard,
  ToolCallTimeoutError,
} from "./tool-call-timeout.ts";

test("direct-subagent guard does not exempt pipeline_child_wait", async () => {
  let executionSignal: AbortSignal | undefined;
  const wait = {
    name: "pipeline_child_wait",
    label: "Wait fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ) {
      executionSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  const registry = {
    getAllTools: () => [{ name: wait.name }],
    getToolDefinition: (name: string) =>
      name === wait.name ? wait : undefined,
  };

  const guard = createToolCallTimeoutGuard(5);
  guard.apply(registry);

  await assert.rejects(
    wait.execute("fixture", {}, undefined),
    (error: unknown) => error instanceof ToolCallTimeoutError,
  );
  assert.equal(executionSignal?.aborted, true);
  assert.equal(executionSignal?.reason instanceof ToolCallTimeoutError, true);
});
