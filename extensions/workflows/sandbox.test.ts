import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflowSandbox } from "./sandbox.ts";

function run(
  source: string,
  overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {},
) {
  const abort = new AbortController();
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    signal: abort.signal,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    ...overrides,
  });
}

test("sandbox exposes only workflow capabilities and validates results", async () => {
  const phases: string[] = [];
  const result = await run(
    `
      phase("Gather");
      const replies = await parallel([
        () => agent("one"),
        () => agent("two"),
      ], { concurrency: 99 });
      return {
        replies: replies.map((reply) => reply.output),
        processType: typeof process,
        requireType: typeof require,
        fetchType: typeof fetch,
      };
    `,
    { onPhase: (title) => phases.push(title) },
  );
  assert.deepEqual(result, {
    replies: ["reply:one", "reply:two"],
    processType: "undefined",
    requireType: "undefined",
    fetchType: "undefined",
  });
  assert.deepEqual(phases, ["Gather"]);
});

test("sandbox parallel caps fanout at eight", async () => {
  let active = 0;
  let peak = 0;
  const result = await run(
    `
      const tasks = Array.from(
        { length: 12 },
        (_, index) => () => agent("task-" + index),
      );
      return (await parallel(tasks, { concurrency: 99 })).length;
    `,
    {
      onAgent: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { ok: true, output: "done" };
      },
    },
  );

  assert.equal(result, 12);
  assert.equal(peak, 8);
});

test("sandbox result serialization handles cycles and bigint", async () => {
  const result = await run(`
    const value = { count: 7n };
    value.self = value;
    return value;
  `);
  assert.deepEqual(result, { count: "7n", self: "[circular]" });
});

test("sandbox rejects unawaited agent calls", async () => {
  let calls = 0;
  await assert.rejects(
    run(`agent("orphan"); return "done";`, {
      onAgent: async () => {
        calls++;
        return { ok: true, output: "unexpected" };
      },
    }),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox source cannot escape the host accounting wrapper", async () => {
  let calls = 0;
  await assert.rejects(
    run(
      `}), agent("orphan"), Promise.resolve("bypass"); (async function () {`,
      {
        onAgent: async () => {
          calls++;
          return { ok: true, output: "unexpected" };
        },
      },
    ),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox VM rejects dynamic code generation and constructor escapes", async () => {
  await assert.rejects(
    run(`return Function("return 1")();`),
    /Code generation from strings disallowed/,
  );
  await assert.rejects(
    run(`return globalThis.constructor.constructor("return process")();`),
    /Code generation from strings disallowed/,
  );
  await assert.rejects(
    run(`return await WebAssembly.compile(new Uint8Array([0]));`),
    /Wasm code generation disallowed|WebAssembly\.compile\(\) is not allowed/,
  );
});

test("sandbox VM still rejects non-yielding synchronous code", async () => {
  await assert.rejects(run(`while (true) {}`), /timed out/);
});

test("sandbox parent enforces its authenticated IPC request budget", async () => {
  let calls = 0;
  await assert.rejects(
    run(
      `return await Promise.all(Array.from({ length: 33 }, (_, index) => agent("request-" + index)));`,
      {
        onAgent: async () => {
          calls++;
          return { ok: true, output: "done" };
        },
      },
    ),
    /agent request budget/,
  );
  assert.ok(calls <= 32);
});

test("sandbox fails closed when the configured Node exception is unavailable", async () => {
  const previous = process.env.PIPI_NODE_RUNTIME;
  process.env.PIPI_NODE_RUNTIME = "/missing/pipi-sandbox-node";
  try {
    await assert.rejects(
      run(`return "must-not-run";`),
      /Workflow sandbox requires the isolated Node fallback.*PIPI_NODE_RUNTIME/,
    );
  } finally {
    if (previous === undefined) delete process.env.PIPI_NODE_RUNTIME;
    else process.env.PIPI_NODE_RUNTIME = previous;
  }
});

test("workflow agent invocations have no per-request wall timer", async () => {
  let signalAborted = false;
  const result = await run(`return (await agent("delayed")).output;`, {
    onAgent: async (_prompt, _options, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      signalAborted = signal.aborted;
      return { ok: true, output: "completed" };
    },
  });

  assert.equal(result, "completed");
  assert.equal(signalAborted, false);
});

test("workflow cancellation aborts a pending agent request", async () => {
  const controller = new AbortController();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let requestAborted = false;
  const pending = run(`return await agent("pending");`, {
    signal: controller.signal,
    onAgent: async (_prompt, _options, signal) => {
      startedResolve?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { ok: false, output: "", error: "Agent was aborted" };
    },
  });

  await started;
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(pending, /Workflow was aborted/);
  assert.equal(requestAborted, true);
});
