import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  EventBus,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  SessionShutdownEvent,
  AgentStartEvent,
  AgentSettledEvent,
  UIPromptEndEvent,
  UIPromptKind,
  UIPromptStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createActivityPublisher } from "./activity.ts";

type Hook = (event: unknown, context: unknown) => unknown;

type Request = {
  method: string;
  params: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRequest(value: unknown) {
  if (!isRecord(value) || typeof value.method !== "string") return undefined;
  if (!isRecord(value.params)) return undefined;
  return { method: value.method, params: value.params } satisfies Request;
}

// Match Pi's channel-scoped, non-replaying event bus. Replay must come from
// the bridge handshake, never from the test harness.
class TestEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown) {
    for (const listener of Array.from(this.listeners.get(channel) ?? []))
      listener(data);
  }

  on(channel: string, handler: (data: unknown) => void) {
    const listeners =
      this.listeners.get(channel) ?? new Set<(data: unknown) => void>();
    this.listeners.set(channel, listeners);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }

  listenerCount(channel: string) {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

class ExtensionHarness {
  private readonly handlers = new Map<string, Hook[]>();
  readonly api: ExtensionAPI;

  constructor(readonly events: TestEventBus) {
    this.api = {
      events,
      on: (event: string, handler: unknown) => {
        const hooks = this.handlers.get(event) ?? [];
        hooks.push(handler as Hook);
        this.handlers.set(event, hooks);
      },
    } as unknown as ExtensionAPI;
  }

  async install(factory: (api: ExtensionAPI) => unknown) {
    await factory(this.api);
  }

  async emit(event: string, payload: unknown, context: ExtensionContext) {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, context);
    }
  }
}

class HerdrSocketFixture {
  readonly requests: Request[] = [];
  supportsPipiResume = true;
  private readonly sockets = new Set<Socket>();
  private readonly waiters = new Set<() => void>();
  private readonly server = createServer((socket) => {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const line = input.slice(0, newline).trim();
        input = input.slice(newline + 1);
        if (!line) continue;
        let request: Request | undefined;
        try {
          request = asRequest(JSON.parse(line));
        } catch {
          request = undefined;
        }
        if (!request) continue;
        const envelope: unknown = JSON.parse(line);
        if (request.method === "ping") {
          socket.end(
            `${JSON.stringify({ id: isRecord(envelope) ? envelope.id : undefined, result: { type: "pong", capabilities: { pipi_resume_launcher: this.supportsPipiResume } } })}\n`,
          );
          continue;
        }
        this.requests.push(request);
        for (const waiter of Array.from(this.waiters)) waiter();
        socket.end(
          `${JSON.stringify({ id: isRecord(envelope) ? envelope.id : undefined, result: { type: "ok" } })}\n`,
        );
      }
    });
  });

  constructor(readonly socketPath: string) {}

  async start() {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  waitFor(predicate: (request: Request) => boolean) {
    const existing = this.requests.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise<Request>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("Timed out waiting for a Herdr request"));
      }, 1_000);
      const waiter = () => {
        const request = this.requests.find(predicate);
        if (!request) return;
        clearTimeout(timeout);
        this.waiters.delete(waiter);
        resolve(request);
      };
      this.waiters.add(waiter);
    });
  }

  waitForState(state: "working" | "blocked" | "idle", after = 0) {
    return this.waitFor(
      (request) =>
        this.requests.indexOf(request) >= after &&
        request.method === "pane.report_agent" &&
        request.params.state === state,
    );
  }

  states() {
    return this.requests.flatMap((request) => {
      if (request.method !== "pane.report_agent") return [];
      const state = request.params.state;
      return typeof state === "string" ? [state] : [];
    });
  }
}

const ENV_KEYS = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_AGENT",
] as const;
let moduleSerial = 0;

async function loadReporter() {
  const module = (await import(
    `./index.ts?herdr-test=${moduleSerial++}`
  )) as typeof import("./index.ts");
  return module.default;
}

async function withEnvironment(
  values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  run: () => Promise<void>,
) {
  const previous = new Map(
    ENV_KEYS.map((key) => [key, process.env[key]] as const),
  );
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withHerdrSocket(
  run: (socket: HerdrSocketFixture) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "pipi-herdr-test-"));
  const socket = new HerdrSocketFixture(path.join(directory, "herdr.sock"));
  await socket.start();
  try {
    await withEnvironment(
      {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: socket.socketPath,
        HERDR_PANE_ID: "pane-fixture",
        HERDR_AGENT: "pi",
      },
      () => run(socket),
    );
  } finally {
    await socket.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function context(
  mode: "tui" | "rpc" | "json" | "print",
  idle: boolean,
  sessionId = "session-fixture",
  notifications: string[] = [],
) {
  return {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    isIdle: () => idle,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: {
      getSessionFile: () => "/tmp/pipi-herdr-session.jsonl",
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

function sessionStart(reason: SessionStartEvent["reason"]): SessionStartEvent {
  return { type: "session_start", reason };
}

function sessionShutdown(
  reason: SessionShutdownEvent["reason"],
): SessionShutdownEvent {
  return { type: "session_shutdown", reason };
}

const agentStart = { type: "agent_start" } satisfies AgentStartEvent;
const agentSettled = { type: "agent_settled" } satisfies AgentSettledEvent;

function promptStart(kind: UIPromptKind): UIPromptStartEvent {
  return { type: "ui_prompt_start", reason: "ui_prompt", kind };
}

function promptEnd(kind: UIPromptKind): UIPromptEndEvent {
  return { type: "ui_prompt_end", reason: "ui_prompt", kind };
}

async function assertNoNewRequests(socket: HerdrSocketFixture, count: number) {
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.requests.length, count);
}

async function assertNoNewStates(socket: HerdrSocketFixture, count: number) {
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.states().length, count);
}

function assertSessionIdentity(socket: HerdrSocketFixture) {
  const session = socket.requests.find(
    (request) => request.method === "pane.report_agent_session",
  );
  assert.ok(session);
  assert.equal(session.params.pane_id, "pane-fixture");
  assert.equal(session.params.source, "herdr:pi");
  assert.equal(session.params.agent, "pi");
  assert.equal(session.params.resume_launcher, "pipi");
  assert.equal(
    session.params.agent_session_path,
    "/tmp/pipi-herdr-session.jsonl",
  );
}

function assertStateSessionIdentity(socket: HerdrSocketFixture) {
  const session = socket.requests.find(
    (request) => request.method === "pane.report_agent_session",
  );
  assert.ok(session);
  const states = socket.requests.filter(
    (request) => request.method === "pane.report_agent",
  );
  assert.ok(states.length > 0);
  const sessionIndex = socket.requests.indexOf(session);
  for (const state of states) {
    assert.equal(state.params.resume_launcher, "pipi");
    assert.ok(socket.requests.indexOf(state) > sessionIndex);
    assert.equal(
      state.params.agent_session_path,
      session.params.agent_session_path,
    );
    assert.equal(
      state.params.agent_session_id,
      session.params.agent_session_id,
    );
  }
}

function assertMonotonicSequences(socket: HerdrSocketFixture) {
  const sequences = socket.requests.flatMap((request) => {
    const sequence = request.params.seq;
    return typeof sequence === "number" ? [sequence] : [];
  });
  assert.ok(sequences.length > 0);
  for (let index = 1; index < sequences.length; index++) {
    assert.ok(sequences[index]! > sequences[index - 1]!);
  }
}

test("unsupported servers keep activity without claiming launcher support, and reconnect reprobes", async () => {
  await withHerdrSocket(async (socket) => {
    socket.supportsPipiResume = false;
    const notices: string[] = [];
    const ctx = context("tui", true, "session-fixture", notices);
    const harness = new ExtensionHarness(new TestEventBus());
    await harness.install(await loadReporter());
    await harness.emit("session_start", sessionStart("startup"), ctx);
    await socket.waitForState("idle");
    assert.equal(notices.length, 1);
    assert.ok(
      socket.requests.every(
        (request) => request.params.resume_launcher === undefined,
      ),
    );
    socket.supportsPipiResume = true;
    await harness.emit("agent_start", agentStart, ctx);
    const working = await socket.waitForState("working");
    assert.equal(working.params.resume_launcher, "pipi");
    assert.equal(notices.length, 1);
    await harness.emit("session_shutdown", sessionShutdown("quit"), ctx);
  });
});

test("TUI lifecycle reports session identity and derived root activity", async () => {
  await withHerdrSocket(async (socket) => {
    const harness = new ExtensionHarness(new TestEventBus());
    await harness.install(await loadReporter());
    const idleContext = context("tui", true);

    await harness.emit("session_start", sessionStart("startup"), idleContext);
    await socket.waitForState("idle");
    assertSessionIdentity(socket);

    const beforeWorking = socket.requests.length;
    await harness.emit("agent_start", agentStart, context("tui", false));
    await socket.waitForState("working", beforeWorking);

    const beforeIdle = socket.requests.length;
    await harness.emit("agent_settled", agentSettled, context("tui", true));
    await socket.waitForState("idle", beforeIdle);

    assert.deepEqual(socket.states().slice(-3), ["idle", "working", "idle"]);
    assertMonotonicSequences(socket);
  });
});

test("root settlement stays working while subagents or pipelines overlap", async () => {
  await withHerdrSocket(async (socket) => {
    const bus = new TestEventBus();
    const harness = new ExtensionHarness(bus);
    await harness.install(await loadReporter());
    const subagents = createActivityPublisher(bus, "subagents");
    const pipelines = createActivityPublisher(bus, "pipelines");

    await harness.emit(
      "session_start",
      sessionStart("startup"),
      context("tui", true),
    );
    await socket.waitForState("idle");

    const beforeRoot = socket.requests.length;
    await harness.emit("agent_start", agentStart, context("tui", false));
    await socket.waitForState("working", beforeRoot);

    subagents.update(["subagent-1"]);
    pipelines.update(["pipeline-1"]);
    const beforeRootSettled = socket.requests.length;
    await harness.emit("agent_settled", agentSettled, context("tui", true));
    await assertNoNewRequests(socket, beforeRootSettled);
    assert.equal(socket.states().at(-1), "working");

    const beforeSubagentsClear = socket.requests.length;
    subagents.update([]);
    await assertNoNewRequests(socket, beforeSubagentsClear);
    assert.equal(socket.states().at(-1), "working");

    const beforePipelinesClear = socket.requests.length;
    pipelines.update([]);
    await socket.waitForState("idle", beforePipelinesClear);
    assert.equal(socket.states().at(-1), "idle");
  });
});

test("prompt blocking takes precedence and prompt completion restores derived work", async () => {
  await withHerdrSocket(async (socket) => {
    const bus = new TestEventBus();
    const harness = new ExtensionHarness(bus);
    await harness.install(await loadReporter());
    const subagents = createActivityPublisher(bus, "subagents");

    await harness.emit(
      "session_start",
      sessionStart("startup"),
      context("tui", true),
    );
    await socket.waitForState("idle");

    await harness.emit("agent_start", agentStart, context("tui", false));
    await socket.waitForState("working");

    const beforeBlocked = socket.requests.length;
    await harness.emit(
      "ui_prompt_start",
      promptStart("confirm"),
      context("tui", false),
    );
    await socket.waitForState("blocked", beforeBlocked);

    const beforeSettledWhileBlocked = socket.requests.length;
    await harness.emit("agent_settled", agentSettled, context("tui", true));
    await assertNoNewRequests(socket, beforeSettledWhileBlocked);

    const beforePromptEnd = socket.requests.length;
    await harness.emit(
      "ui_prompt_end",
      promptEnd("confirm"),
      context("tui", true),
    );
    await socket.waitForState("idle", beforePromptEnd);

    subagents.update(["subagent-1"]);
    await socket.waitForState("working");

    // Pi emits the same lifecycle end notification for an answer, a
    // cancellation, or a dismissed prompt; the aggregate must return to the
    // state implied by remaining work.
    const completionKinds = [
      { kind: "confirm", outcome: "answer" },
      { kind: "select", outcome: "cancel" },
      { kind: "custom", outcome: "end" },
    ] as const;
    for (const { kind } of completionKinds) {
      const beforeStart = socket.requests.length;
      await harness.emit(
        "ui_prompt_start",
        promptStart(kind),
        context("tui", false),
      );
      await socket.waitForState("blocked", beforeStart);

      const beforeEnd = socket.requests.length;
      await harness.emit(
        "ui_prompt_end",
        promptEnd(kind),
        context("tui", false),
      );
      await socket.waitForState("working", beforeEnd);
    }

    const beforeClear = socket.requests.length;
    subagents.update([]);
    await socket.waitForState("idle", beforeClear);
  });
});

test("late reporter attachment replays activity and ignores duplicate or stale transitions", async () => {
  await withHerdrSocket(async (socket) => {
    const bus = new TestEventBus();
    const publisher = createActivityPublisher(bus, "subagents");
    publisher.update(["early-subagent"]);

    const harness = new ExtensionHarness(bus);
    await harness.install(await loadReporter());
    await harness.emit(
      "session_start",
      sessionStart("startup"),
      context("tui", true),
    );
    await socket.waitForState("working");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertStateSessionIdentity(socket);

    const beforeSettled = socket.states().length;
    await harness.emit("agent_settled", agentSettled, context("tui", true));
    await assertNoNewStates(socket, beforeSettled);
    assert.equal(socket.states().at(-1), "working");

    const beforeDispose = socket.requests.length;
    publisher.dispose();
    await socket.waitForState("idle", beforeDispose);

    const beforeStaleUpdate = socket.requests.length;
    publisher.update(["stale-after-dispose"]);
    await assertNoNewRequests(socket, beforeStaleUpdate);

    const replacement = createActivityPublisher(bus, "subagents");
    const beforeReplacement = socket.requests.length;
    replacement.update(["replacement-subagent"]);
    await socket.waitForState("working", beforeReplacement);
    const afterReplacement = socket.requests.length;
    replacement.update(["replacement-subagent"]);
    replacement.update(["replacement-subagent"]);
    await assertNoNewRequests(socket, afterReplacement);
  });
});

test("session shutdown reports final idle, detaches activity, and reload starts cleanly", async () => {
  await withHerdrSocket(async (socket) => {
    const bus = new TestEventBus();
    const harness = new ExtensionHarness(bus);
    await harness.install(await loadReporter());
    const publisher = createActivityPublisher(bus, "pipelines");

    await harness.emit(
      "session_start",
      sessionStart("startup"),
      context("tui", true),
    );
    await socket.waitForState("idle");
    publisher.update(["pipeline-1"]);
    await socket.waitForState("working");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const beforeShutdown = socket.requests.length;
    const beforeShutdownStates = socket.states().length;
    let shutdownResolved = false;
    const shutdown = harness
      .emit(
        "session_shutdown",
        sessionShutdown("reload"),
        context("tui", false),
      )
      .finally(() => {
        shutdownResolved = true;
      });
    await socket.waitForState("idle", beforeShutdown);
    assert.equal(shutdownResolved, false);
    await shutdown;
    assert.deepEqual(socket.states().slice(beforeShutdownStates), ["idle"]);
    assert.equal(socket.states().at(-1), "idle");
    assertStateSessionIdentity(socket);
    assert.equal(bus.listenerCount("herdr:blocked"), 0);

    const afterShutdown = socket.requests.length;
    publisher.update(["stale-after-shutdown"]);
    bus.emit("herdr:blocked", { active: true, label: "stale" });
    await assertNoNewRequests(socket, afterShutdown);
    publisher.dispose();

    const reloaded = new ExtensionHarness(bus);
    await reloaded.install(await loadReporter());
    const beforeReloadStart = socket.requests.length;
    await reloaded.emit(
      "session_start",
      sessionStart("reload"),
      context("tui", true, "session-after-reload"),
    );
    await socket.waitForState("idle", beforeReloadStart);

    const replacement = createActivityPublisher(bus, "pipelines");
    await reloaded.emit(
      "session_shutdown",
      sessionShutdown("quit"),
      context("tui", true),
    );
    const afterSecondShutdown = socket.requests.length;
    replacement.update(["late-pipeline"]);
    await assertNoNewRequests(socket, afterSecondShutdown);
  });
});

test("blocked session shutdown reports final idle before resolving", async () => {
  await withHerdrSocket(async (socket) => {
    const bus = new TestEventBus();
    const harness = new ExtensionHarness(bus);
    await harness.install(await loadReporter());

    await harness.emit(
      "session_start",
      sessionStart("startup"),
      context("tui", true),
    );
    await socket.waitForState("idle");

    const beforeBlocked = socket.requests.length;
    bus.emit("herdr:blocked", { active: true, label: "needs-answer" });
    await socket.waitForState("blocked", beforeBlocked);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const beforeShutdown = socket.requests.length;
    const beforeShutdownStates = socket.states().length;
    let shutdownResolved = false;
    const shutdown = harness
      .emit("session_shutdown", sessionShutdown("quit"), context("tui", false))
      .finally(() => {
        shutdownResolved = true;
      });
    await socket.waitForState("idle", beforeShutdown);
    assert.equal(shutdownResolved, false);
    await shutdown;
    assert.deepEqual(socket.states().slice(beforeShutdownStates), ["idle"]);
    assert.equal(socket.states().at(-1), "idle");
    assertStateSessionIdentity(socket);
    assertMonotonicSequences(socket);
    assert.equal(bus.listenerCount("herdr:blocked"), 0);

    const afterShutdown = socket.requests.length;
    bus.emit("herdr:blocked", { active: false });
    await assertNoNewRequests(socket, afterShutdown);
  });
});

test("headless modes do not report even when Herdr environment is present", async () => {
  await withHerdrSocket(async (socket) => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const harness = new ExtensionHarness(new TestEventBus());
      await harness.install(await loadReporter());
      const before = socket.requests.length;
      const modeContext = context(mode, false);
      await harness.emit("session_start", sessionStart("startup"), modeContext);
      await harness.emit("agent_start", agentStart, modeContext);
      await harness.emit("ui_prompt_start", promptStart("input"), modeContext);
      await harness.emit("ui_prompt_end", promptEnd("input"), modeContext);
      await harness.emit("agent_settled", agentSettled, context(mode, true));
      await harness.emit(
        "session_shutdown",
        sessionShutdown("quit"),
        modeContext,
      );
      await assertNoNewRequests(socket, before);
    }
    assert.equal(socket.requests.length, 0);
  });
});

test("absence of Herdr environment is harmless", async () => {
  await withEnvironment({}, async () => {
    const bus = new TestEventBus();
    const harness = new ExtensionHarness(bus);
    await harness.install(await loadReporter());
    const modeContext = context("tui", false);

    await harness.emit("session_start", sessionStart("startup"), modeContext);
    await harness.emit("agent_start", agentStart, modeContext);
    await harness.emit("ui_prompt_start", promptStart("confirm"), modeContext);
    await harness.emit("ui_prompt_end", promptEnd("confirm"), modeContext);
    await harness.emit("agent_settled", agentSettled, context("tui", true));
    await harness.emit(
      "session_shutdown",
      sessionShutdown("quit"),
      modeContext,
    );
  });
});
