/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: scripted
 * stub sessions registered under the claude/codex names (the production
 * backends launch real processes and have their own live test files), plus
 * the real pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import type { Api, Model } from "@earendil-works/pi-ai";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentEvent,
  SubagentSnapshot,
} from "./src/domain.ts";
import { SpawnError } from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { formatContextUtilization } from "./src/format.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "claude",
      defaultModelLabel: "claude/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const quotaModels = ["sol", "terra", "luna"].map(
  (id) =>
    ({
      provider: "openai-codex",
      id: `gpt-5.6-${id}`,
      name: id,
      api: "test",
      baseUrl: "",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 300_000,
      maxTokens: 128_000,
    }) satisfies Model<Api>,
);
const quotaRegistry = {
  find(provider: string, id: string) {
    return quotaModels.find(
      (model) => model.provider === provider && model.id === id,
    );
  },
  getAll() {
    return quotaModels;
  },
};
const quotaPiBackend = makeStubBackend({
  backend: "pi",
  defaultModelLabel: "openai-codex/gpt-5.6-sol",
  contextWindow: 300_000,
  toolName: "read",
  cadenceMs: 40,
});
const quotaRegistryLayer = (pi: SubagentBackend = quotaPiBackend) =>
  Layer.sync(
    BackendRegistry,
    () =>
      new Map<BackendName, SubagentBackend>([
        ["pi", pi],
        [
          "claude",
          makeStubBackend({
            backend: "claude",
            defaultModelLabel: "claude/sonnet",
            contextWindow: 200_000,
            toolName: "Bash",
            cadenceMs: 40,
          }),
        ],
        [
          "codex",
          makeStubBackend({
            backend: "codex",
            defaultModelLabel: "codex/gpt-5-codex",
            contextWindow: 272_000,
            toolName: "shell",
            cadenceMs: 30,
          }),
        ],
      ]),
  );

const createTestRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(TestRegistryLive)),
  );
const createQuotaRuntime = (pi?: SubagentBackend) =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(Layer.provide(quotaRegistryLayer(pi))),
  );

function makeContextUsageBackend() {
  let pushEvent: ((event: SubagentEvent) => Promise<unknown>) | undefined;
  const backend: SubagentBackend = {
    name: "claude",
    capabilities: {
      steering: false,
      modelSelection: false,
      reasoningEffort: false,
    },
    available: Effect.succeed(true),
    spawn: () =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<SubagentEvent>();
        pushEvent = (event) => {
          Queue.offerUnsafe(events, event);
          return Promise.resolve();
        };
        return {
          meta: Effect.succeed({
            backend: "claude" as const,
            contextWindow: 300_000,
          }),
          events: Stream.fromQueue(events),
          send: (_text) => Effect.void,
          interrupt: Effect.void,
        };
      }),
  };
  const push = async (event: SubagentEvent) => {
    if (!pushEvent) throw new Error("context usage backend is not spawned");
    await pushEvent(event);
  };
  return { backend, push };
}

const createSingleBackendRuntime = (backend: SubagentBackend) =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.sync(
          BackendRegistry,
          () =>
            new Map<BackendName, SubagentBackend>([[backend.name, backend]]),
        ),
      ),
    ),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

function quotaTask(prompt: string, model: string): SpawnTask {
  return {
    ...task(prompt),
    model,
    parent: { ...parent, modelRegistry: quotaRegistry },
  };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTestRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

async function withQuotaManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createQuotaRuntime>,
  ) => Promise<void>,
  pi?: SubagentBackend,
) {
  const runtime = createQuotaRuntime(pi);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "claude");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:claude\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("manager retains omitted usage and clears explicit null usage", async () => {
  const { backend, push } = makeContextUsageBackend();
  const runtime = createSingleBackendRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Track context occupancy")),
    );

    const waitForNextUsage = () =>
      new Promise<SubagentSnapshot["usage"]>((resolve) => {
        let unsubscribe = () => {};
        unsubscribe = manager.view.subscribeTo(snap.id, () => {
          const current = manager.view.get(snap.id);
          if (!current) return;
          unsubscribe();
          resolve({ ...current.usage });
        });
      });

    const firstUsage = waitForNextUsage();
    await push({
      _tag: "UsageChanged",
      tokens: 311_923,
      contextWindow: 300_000,
    });
    assert.deepEqual(await firstUsage, {
      tokens: 311_923,
      contextWindow: 300_000,
    });
    assert.equal(
      formatContextUtilization(manager.view.get(snap.id)?.usage ?? {}),
      ">100%/300k",
    );

    const retainedUsage = waitForNextUsage();
    await push({ _tag: "UsageChanged", contextWindow: 300_000 });
    assert.deepEqual(await retainedUsage, {
      tokens: 311_923,
      contextWindow: 300_000,
    });

    const clearedUsage = waitForNextUsage();
    await push({ _tag: "UsageChanged", tokens: null });
    assert.deepEqual(await clearedUsage, {
      tokens: null,
      contextWindow: 300_000,
    });
    assert.equal(
      formatContextUtilization(manager.view.get(snap.id)?.usage ?? {}),
      "?%/300k",
    );

    const retainedUnknownUsage = waitForNextUsage();
    await push({ _tag: "UsageChanged", contextWindow: 300_000 });
    assert.deepEqual(await retainedUnknownUsage, {
      tokens: null,
      contextWindow: 300_000,
    });

    await push({
      _tag: "RunSettled",
      outcome: { _tag: "Completed", finalText: "done" },
    });
    await runTool(runtime, manager.waitFor([snap.id]));
  } finally {
    await runtime.dispose();
  }
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("claude", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /max 4 concurrent subagents/,
    );
  });
});

test("Claude and Codex share one aggregate quota of four", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        ["claude", "codex", "claude", "codex"] as const,
        (backend, index) => manager.spawn(backend, task(`Task ${index + 1}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("claude", task("Task 5"))),
      /max 4 concurrent subagents/,
    );
  });
});

test("direct Pi quotas admit Sol 4, Terra 8, and Luna 16 independently", async () => {
  await withQuotaManager(async (manager, runtime) => {
    const capacities = [
      ["openai-codex/gpt-5.6-sol", 4],
      ["openai-codex/gpt-5.6-terra", 8],
      ["openai-codex/gpt-5.6-luna", 16],
    ] as const;
    const tasks = capacities.flatMap(([model, limit]) =>
      Array.from({ length: limit }, (_, index) =>
        quotaTask(`${model} task ${index + 1}`, model),
      ),
    );

    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("pi", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 28);

    for (const [model, limit] of capacities) {
      await assert.rejects(
        runTool(
          runtime,
          manager.spawn("pi", quotaTask(`${model} overflow`, model)),
        ),
        new RegExp(`${model}.*max ${limit} concurrent subagents`),
      );
    }
  });
});

test("inherited Pi models use their canonical model quota", async () => {
  await withQuotaManager(async (manager, runtime) => {
    const inheritedTerra = {
      ...task("inherited Terra"),
      parent: {
        ...parent,
        inheritedModel: {
          provider: "openai-codex",
          id: "gpt-5.6-terra",
        },
        modelRegistry: quotaRegistry,
      },
    };
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: 8 }, (_, index) => ({
          ...inheritedTerra,
          prompt: `inherited Terra ${index + 1}`,
        })),
        (spawnTask) => manager.spawn("pi", spawnTask),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 8);
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", inheritedTerra)),
      /gpt-5\.6-terra.*max 8 concurrent subagents/,
    );
  });
});

test("failed Pi backend spawn releases its model reservation", async () => {
  let failNext = true;
  const failOncePiBackend: SubagentBackend = {
    ...quotaPiBackend,
    spawn: (spawnTask) => {
      if (!failNext) return quotaPiBackend.spawn(spawnTask);
      failNext = false;
      return Effect.fail(
        new SpawnError({ message: "requested test spawn failure" }),
      );
    },
  };

  await withQuotaManager(async (manager, runtime) => {
    const sol = "openai-codex/gpt-5.6-sol";
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", quotaTask("fails", sol))),
      /requested test spawn failure/,
    );
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: 4 }, (_, index) =>
          quotaTask(`Sol ${index + 1}`, sol),
        ),
        (spawnTask) => manager.spawn("pi", spawnTask),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
  }, failOncePiBackend);
});

test("idle Pi restart reuses the original immutable model quota", async () => {
  await withQuotaManager(async (manager, runtime) => {
    const terra = "openai-codex/gpt-5.6-terra";
    const settled = await runTool(
      runtime,
      manager.spawn("pi", quotaTask("early Terra", terra)),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: 8 }, (_, index) =>
          quotaTask(`Terra ${index + 1}`, terra),
        ),
        (spawnTask) => manager.spawn("pi", spawnTask),
        { concurrency: "unbounded" },
      ),
    );

    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "restart")),
      /gpt-5\.6-terra.*max 8/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("claude", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /max 4/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("claude", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});
