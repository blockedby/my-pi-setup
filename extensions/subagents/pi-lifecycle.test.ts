import assert from "node:assert/strict";
import test from "node:test";
import { createPiRunLifecycle } from "./src/backends/pi.ts";

type FakeAgentEvent = "agent_start" | "agent_settled";
type FakePromptBehavior = "settle" | "reject" | "stream";

class FakeAgentSession {
  isStreaming = false;
  readonly #behaviors: FakePromptBehavior[];
  #listener: ((event: FakeAgentEvent) => void) | undefined;

  constructor(behaviors: FakePromptBehavior[]) {
    this.#behaviors = [...behaviors];
  }

  subscribe(listener: (event: FakeAgentEvent) => void) {
    this.#listener = listener;
  }

  prompt() {
    const behavior = this.#behaviors.shift();
    this.#listener?.("agent_start");
    if (behavior === "reject") return Promise.reject(new Error("rejected"));
    if (behavior === "stream") {
      this.isStreaming = true;
      return new Promise<void>(() => {});
    }
    this.#listener?.("agent_settled");
    return Promise.resolve();
  }

  stopStreaming() {
    this.isStreaming = false;
  }

  emitSettled() {
    this.#listener?.("agent_settled");
  }
}

test("Pi lifecycle emits one start per fake AgentSession run and settles prompt rejection once", async () => {
  const session = new FakeAgentSession(["settle", "reject", "stream"]);
  const events: Array<"started" | "completed" | "failed" | "interrupted"> = [];
  const lifecycle = createPiRunLifecycle(() => events.push("started"));

  const settle = () => {
    if (!lifecycle.claimSettlement()) return;
    events.push(lifecycle.runError ? "failed" : "completed");
  };
  session.subscribe((event) => {
    if (event === "agent_start") lifecycle.agentStarted();
    else settle();
  });

  lifecycle.start(
    () => session.prompt(),
    () => session.isStreaming,
    settle,
  );
  lifecycle.start(
    () => session.prompt(),
    () => session.isStreaming,
    settle,
  );
  await Promise.resolve();

  assert.deepEqual(events, ["started", "completed", "started", "failed"]);
  assert.equal(lifecycle.runError, "rejected");

  lifecycle.start(
    () => session.prompt(),
    () => session.isStreaming,
    settle,
  );
  session.stopStreaming();
  if (lifecycle.claimSettlement()) events.push("interrupted");
  session.emitSettled();

  assert.deepEqual(events, [
    "started",
    "completed",
    "started",
    "failed",
    "started",
    "interrupted",
  ]);
});
