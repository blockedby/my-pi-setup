import assert from "node:assert/strict";
import test from "node:test";
import { AgentTreeController } from "./control.ts";
import { AgentSessionUnavailableError } from "./domain.ts";
import type {
  AgentNodeSpec,
  AgentTreeExecutionMetadata,
  AgentTreeSession,
  AgentTreeSessionEvent,
  AgentTreeSessionFactory,
  TreeEvidenceEvent,
} from "./domain.ts";

class ControlledSession implements AgentTreeSession {
  readonly activeTools = ["read"];
  readonly sessionFile = undefined;
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  readonly executionMetadata?: AgentTreeExecutionMetadata;
  isStreaming = false;
  disposed = false;
  disposeCalls = 0;
  interrupted = 0;

  constructor(executionMetadata?: AgentTreeExecutionMetadata) {
    this.executionMetadata = executionMetadata;
  }

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentTreeSessionEvent) {
    if (event.type === "run_started") this.isStreaming = true;
    if (event.type === "settled") this.isStreaming = false;
    // Snapshot listeners so callbacks can safely add/remove subscriptions.
    // eslint-disable-next-line unicorn/no-useless-spread -- mutation-safe notification snapshot.
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text: string) {
    this.prompts.push(text);
  }

  async send(text: string) {
    this.sends.push(text);
  }

  enableMutation() {}

  async interrupt() {
    this.interrupted++;
    this.emit({ type: "settled", outcome: { type: "cancelled" } });
  }

  dispose() {
    this.disposed = true;
    this.disposeCalls++;
  }
}

function controlledFactory(session: ControlledSession) {
  const specs: AgentNodeSpec[] = [];
  const factory: AgentTreeSessionFactory = {
    async create(spec) {
      specs.push(spec);
      return session;
    },
  };
  return { factory, specs };
}

function spec(overrides: Partial<AgentNodeSpec> = {}) {
  return {
    scopeId: "scope-1",
    parentId: undefined,
    role: "worker",
    attempt: 2,
    title: "worker title",
    model: "provider/requested-model",
    thinkingLevel: "high" as const,
    cwd: "/private/worker-cwd",
    prompt: "prompt-secret",
    ...overrides,
  } satisfies AgentNodeSpec;
}

test("retirement cannot hide an earlier failed disposal during creation", async () => {
  const session = new ControlledSession();
  const failure = new Error("Disposal did not establish quiescence");
  session.dispose = () => {
    session.disposeCalls++;
    throw failure;
  };
  const { factory } = controlledFactory(session);
  const tree = new AgentTreeController({ factory });
  await assert.rejects(
    tree.spawn(spec({ shouldStart: () => false })),
    (error) => error === failure,
  );
  const node = tree.view.list()[0]!;
  await assert.rejects(tree.retire(node.id), (error) => error === failure);
  await assert.rejects(tree.retire(node.id), (error) => error === failure);
  assert.equal(session.disposeCalls, 1);
});

test("availability rejects missing and disposed sends without dispatch or mutation", async () => {
  const session = new ControlledSession();
  const events: TreeEvidenceEvent[] = [];
  const tree = new AgentTreeController({
    ...controlledFactory(session),
    observer: (event) => events.push(event),
  });
  assert.deepEqual(tree.sessionAvailability("missing"), {
    kind: "unavailable",
    reason: "missing",
  });
  await assert.rejects(
    tree.send("missing", "hello"),
    new AgentSessionUnavailableError("missing", "missing"),
  );
  await tree.retire("missing");
  const node = await tree.spawn(spec());
  assert.deepEqual(tree.sessionAvailability(node.id), { kind: "available" });
  session.disposed = true;
  const before = structuredClone(node);
  const eventCount = events.length;
  await assert.rejects(
    tree.send(node.id, "hello"),
    new AgentSessionUnavailableError(node.id, "disposed"),
  );
  assert.deepEqual(node, before);
  assert.equal(events.length, eventCount);
  assert.deepEqual(session.sends, []);
  await tree.dispose();
  await assert.rejects(
    tree.send("missing", "hello"),
    new AgentSessionUnavailableError("missing", "disposed"),
  );
});

test("failed turns with live adapters remain reusable", async () => {
  const session = new ControlledSession();
  const tree = new AgentTreeController(controlledFactory(session));
  const node = await tree.spawn(spec());
  session.emit({
    type: "settled",
    outcome: {
      type: "failed",
      error: "session disposed: ordinary provider text",
    },
  });
  assert.deepEqual(tree.sessionAvailability(node.id), { kind: "available" });
  await tree.send(node.id, "retry");
  assert.deepEqual(session.sends, ["retry"]);
  assert.equal(node.status, "running");
  await tree.dispose();
});

for (const failed of [false, true]) {
  test(`retirement preserves ${failed ? "error" : "done"} outcome and transcript`, async () => {
    const session = new ControlledSession();
    const tree = new AgentTreeController(controlledFactory(session));
    const node = await tree.spawn(spec());
    session.emit({ type: "assistant", text: "retained" });
    session.emit({
      type: "settled",
      outcome: failed
        ? { type: "failed", error: "failure", finalText: "partial" }
        : { type: "completed", finalText: "result" },
    });
    const before = structuredClone(node);
    await tree.cancel(node.id);
    assert.deepEqual(node, before);
    assert.equal(session.disposeCalls, 0);
    await Promise.all([tree.retire(node.id), tree.retire(node.id)]);
    assert.deepEqual(node, before);
    assert.equal(session.listeners.size, 0);
    assert.equal(session.disposeCalls, 1);
    assert.equal(session.interrupted, 0);
    await assert.rejects(
      tree.send(node.id, "retry"),
      new AgentSessionUnavailableError(node.id, "disposed"),
    );
    await tree.dispose();
    assert.equal(session.disposeCalls, 1);
  });
}

test("running retirement drains cancellation once and preserves its evidence", async () => {
  const session = new ControlledSession();
  const tree = new AgentTreeController(controlledFactory(session));
  const node = await tree.spawn(spec());
  await Promise.all([tree.retire(node.id), tree.cancel(node.id)]);
  assert.equal(node.status, "cancelled");
  assert.equal(session.interrupted, 1);
  assert.equal(session.disposeCalls, 1);
  await tree.dispose();
});

test("failed retirement cannot manufacture settlement or successful disposal evidence", async () => {
  const session = new ControlledSession();
  const failure = new Error("cleanup failed");
  session.interrupt = async () => {
    throw failure;
  };
  session.dispose = () => {
    session.disposeCalls++;
    throw failure;
  };
  const events: TreeEvidenceEvent[] = [];
  const tree = new AgentTreeController({
    ...controlledFactory(session),
    observer: (event) => events.push(event),
  });
  const node = await tree.spawn(spec());
  await assert.rejects(tree.retire(node.id), failure);
  await assert.rejects(tree.retire(node.id), failure);
  assert.equal(node.status, "running");
  assert.equal(session.disposeCalls, 1);
  assert.equal(
    events.some((event) => event.type === "disposed"),
    false,
  );
  assert.equal(sessionEvents(events).length, 0);
  await tree.dispose();
});

function sessionEvents(events: ReadonlyArray<TreeEvidenceEvent>) {
  return events.filter((event) => event.type === "session_event");
}

test("observes copied identity, session metadata, dispatch, and ordered session events", async () => {
  const events: TreeEvidenceEvent[] = [];
  const metadata = {
    provider: "served-provider",
    model: "served-model",
    thinkingLevel: "medium" as const,
    servingRevision: "revision-7",
  };
  const session = new ControlledSession(metadata);
  const { factory, specs } = controlledFactory(session);
  const tree = new AgentTreeController({
    factory,
    makeId: () => "node-1",
    observer: (event) => events.push(event),
  });
  const requested = spec();

  const node = await tree.spawn(requested);
  assert.deepEqual(
    events.map((event) => event.type),
    ["spawn_requested", "session_created", "dispatch"],
  );
  assert.equal(specs[0]?.id, node.id);
  assert.equal(events[0]?.nodeId, node.id);
  assert.equal(events[0]?.requestedModel, requested.model);
  assert.equal(events[0]?.scopeId, requested.scopeId);
  assert.equal(events[0]?.parentId, requested.parentId);
  assert.equal(events[0]?.role, requested.role);
  assert.equal(events[0]?.attempt, requested.attempt);
  assert.equal(events[0]?.thinkingLevel, requested.thinkingLevel);

  const created = events[1];
  assert.equal(created?.type, "session_created");
  if (created?.type === "session_created") {
    assert.deepEqual(created.executionMetadata, metadata);
  }
  metadata.provider = "mutated-after-creation";
  requested.scopeId = "mutated-after-spawn";
  assert.equal(events[0]?.scopeId, "scope-1");
  if (created?.type === "session_created") {
    assert.equal(created.executionMetadata?.provider, "served-provider");
  }

  session.emit({ type: "run_started" });
  session.emit({
    type: "tool",
    phase: "call",
    toolCallId: "tool-1",
    name: "read",
    text: "argument-secret",
    isError: false,
  });
  session.emit({
    type: "tool",
    phase: "result",
    toolCallId: "tool-1",
    name: "read",
    text: "result-secret",
    isError: false,
  });
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "assistant-secret" },
  });

  assert.deepEqual(
    sessionEvents(events).map((event) =>
      event.type === "session_event" ? event.event.type : event.type,
    ),
    ["run_started", "tool", "tool", "settled"],
  );
  const toolEvents = sessionEvents(events).filter(
    (event) => event.type === "session_event" && event.event.type === "tool",
  );
  assert.equal(toolEvents.length, 2);
  assert.equal(
    toolEvents.every(
      (event) =>
        event.type === "session_event" && !("failureDetail" in event.event),
    ),
    true,
  );
  assert.equal(tree.view.get(node.id)?.status, "done");

  await tree.dispose();
});

test("records startup failure without requiring a session file", async () => {
  const events: TreeEvidenceEvent[] = [];
  const factory: AgentTreeSessionFactory = {
    async create() {
      throw new Error("provider startup failed");
    },
  };
  const tree = new AgentTreeController({
    factory,
    makeId: () => "failed-node",
    observer: (event) => events.push(event),
  });

  await assert.rejects(tree.spawn(spec()), /provider startup failed/);
  assert.deepEqual(
    events.map((event) => event.type),
    ["spawn_requested", "spawn_failed"],
  );
  const failed = events[1];
  assert.equal(failed?.type, "spawn_failed");
  if (failed?.type === "spawn_failed") {
    assert.equal(failed.error, "provider startup failed");
  }
  assert.equal(tree.view.get("failed-node")?.status, "error");
  assert.deepEqual(tree.sessionAvailability("failed-node"), {
    kind: "unavailable",
    reason: "missing",
  });
  await assert.rejects(
    tree.send("failed-node", "retry"),
    new AgentSessionUnavailableError("failed-node", "missing"),
  );
  await tree.dispose();
});

test("records distinct starts for multiple turns on one persistent session", async () => {
  const events: TreeEvidenceEvent[] = [];
  const session = new ControlledSession();
  const { factory } = controlledFactory(session);
  const tree = new AgentTreeController({
    factory,
    makeId: () => "persistent-node",
    observer: (event) => events.push(event),
  });
  const node = await tree.spawn({ ...spec(), persistent: true });

  session.emit({ type: "run_started" });
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "first" },
  });
  assert.equal(tree.view.get(node.id)?.status, "idle");

  await tree.send(node.id, "second-turn-secret");
  session.emit({ type: "run_started" });
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "second" },
  });

  const observed = sessionEvents(events).filter(
    (event) => event.type === "session_event",
  );
  assert.deepEqual(
    observed.map((event) => event.event.type),
    ["run_started", "settled", "run_started", "settled"],
  );
  assert.equal(events.filter((event) => event.type === "dispatch").length, 2);
  assert.equal(tree.view.get(node.id)?.status, "idle");
  assert.deepEqual(session.sends, ["second-turn-secret"]);

  await tree.dispose();
});

test("observer failures are reported without changing lifecycle", async () => {
  const errors: unknown[] = [];
  const session = new ControlledSession();
  const { factory } = controlledFactory(session);
  const tree = new AgentTreeController({
    factory,
    observer: () => {
      throw new Error("evidence sink failed");
    },
    onEvidenceError: (error) => errors.push(error),
  });
  const node = await tree.spawn({ ...spec(), persistent: true });

  session.emit({ type: "run_started" });
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "completed" },
  });
  await tree.send(node.id, "continue");
  assert.deepEqual(session.sends, ["continue"]);
  await tree.cancel(node.id);

  assert.equal(tree.view.get(node.id)?.status, "cancelled");
  assert.equal(session.disposeCalls, 1);
  assert.ok(errors.length >= 1);
  assert.equal(tree.evidenceStatus, "incomplete");
  await tree.dispose();
  assert.equal(session.disposeCalls, 1);
});

test("evidence never includes prompts, cwd, assistant text, or tool payload text", async () => {
  const events: TreeEvidenceEvent[] = [];
  const session = new ControlledSession();
  const { factory } = controlledFactory(session);
  const tree = new AgentTreeController({
    factory,
    observer: (event) => events.push(event),
  });
  const node = await tree.spawn(spec());

  session.emit({ type: "run_started" });
  session.emit({ type: "user", text: "prompt-secret" });
  session.emit({
    type: "assistant_delta",
    kind: "thinking",
    delta: "thinking-secret",
  });
  session.emit({
    type: "assistant",
    text: "assistant-secret",
    thinking: "thinking-secret",
  });
  session.emit({
    type: "tool",
    phase: "call",
    toolCallId: "tool-2",
    name: "bash",
    text: "argument-secret",
    isError: false,
  });
  session.emit({
    type: "tool",
    phase: "result",
    toolCallId: "tool-2",
    name: "bash",
    text: "failure-detail-secret",
    isError: true,
  });
  session.emit({
    type: "settled",
    outcome: {
      type: "failed",
      error: "settled-failure",
      finalText: "final-secret",
    },
  });

  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes("prompt-secret"), false);
  assert.equal(serialized.includes("/private/worker-cwd"), false);
  assert.equal(serialized.includes("assistant-secret"), false);
  assert.equal(serialized.includes("thinking-secret"), false);
  assert.equal(serialized.includes("argument-secret"), false);
  assert.equal(serialized.includes("final-secret"), false);
  assert.equal(serialized.includes("failure-detail-secret"), true);
  assert.equal(tree.view.get(node.id)?.status, "error");

  await tree.dispose();
});
