import assert from "node:assert/strict";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import { guardResponseStream } from "./guard.ts";

const model = fauxProvider().getModel();

test("stalled provider is aborted and produces a retryable timeout even when it ignores abort", async () => {
  let sourceSignal: AbortSignal | undefined;
  const source = createAssistantMessageEventStream();
  const output = guardResponseStream(
    (signal) => {
      sourceSignal = signal;
      return source;
    },
    model,
    undefined,
    20,
  );
  const result = await output.result();
  assert.equal(sourceSignal?.aborted, true);
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /timeout/);
  source.push({
    type: "done",
    reason: "stop",
    message: fauxAssistantMessage("late"),
  });
  assert.equal(await output.result(), result);
});

test("stream activity resets the idle deadline and completed responses remain unchanged", async () => {
  const source = createAssistantMessageEventStream();
  const output = guardResponseStream(() => source, model, undefined, 60);
  const partial = fauxAssistantMessage("working");
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
  }
  source.push({ type: "done", reason: "stop", message: partial });
  assert.equal(await output.result(), partial);
});

test("explicit cancellation is not converted to a retryable timeout", async () => {
  const controller = new AbortController();
  const source = createAssistantMessageEventStream();
  const output = guardResponseStream(
    () => source,
    model,
    controller.signal,
    100,
  );
  controller.abort();
  assert.equal((await output.result()).stopReason, "aborted");
  source.end(fauxAssistantMessage("unused"));
});

test("stalled partial tool call never becomes an executable final message", async () => {
  const source = createAssistantMessageEventStream();
  const output = guardResponseStream(() => source, model, undefined, 20);
  const partial = fauxAssistantMessage(
    [{ type: "toolCall", id: "partial", name: "write", arguments: {} }],
    { stopReason: "toolUse" },
  );
  source.push({ type: "toolcall_start", contentIndex: 0, partial });
  const result = await output.result();
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.content, []);
  source.end(partial);
});
