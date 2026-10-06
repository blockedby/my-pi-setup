import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Layer, ManagedRuntime, Queue, Stream } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import type { SpawnTask, SubagentEvent } from "./src/domain.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";
import { applySubagentProfile } from "./src/policy.ts";
import { runTool } from "./src/runtime.ts";

const models = ["openai-codex", "openai-codex-2", "openai-codex-3"].flatMap(
  (provider) =>
    [
      "gpt-6.1-sol",
      "gpt-6-luna",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
    ].map(
      (id) =>
        ({
          provider,
          id,
          name: id,
          api: "test",
          baseUrl: "",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 300000,
          maxTokens: 128000,
        }) satisfies Model<Api>,
    ),
);
const registry = {
  find: (provider: string, id: string) =>
    models.find((model) => model.provider === provider && model.id === id),
  getAll: () => models,
};

test("manager reserves and counts one family quota across parent switches, overrides and legacy versions", async () => {
  for (const [ids, limit] of [
    [["gpt-6.1-sol", "gpt-5.6-sol"], 4],
    [["gpt-6-luna", "gpt-5.6-luna"], 16],
    [["gpt-6-astra"], 4],
    [["gpt-5.6-terra"], 8],
  ] as const) {
    const started: SpawnTask[] = [];
    const backend: SubagentBackend = {
      name: "pi",
      capabilities: {
        steering: true,
        modelSelection: true,
        reasoningEffort: true,
      },
      available: Effect.succeed(true),
      spawn: (task) =>
        Effect.gen(function* () {
          started.push(task);
          yield* Effect.sleep("5 millis");
          const events = yield* Queue.unbounded<SubagentEvent>();
          assert.ok(task.resolvedPiModel);
          return {
            meta: Effect.succeed({
              backend: "pi" as const,
              modelLabel: `${task.resolvedPiModel.provider}/${task.resolvedPiModel.id}`,
            }),
            events: Stream.fromQueue(events),
            send: () => Effect.void,
            interrupt: Queue.offer(events, {
              _tag: "RunSettled",
              outcome: { _tag: "Interrupted" },
            }).pipe(Effect.asVoid),
          };
        }),
    };
    const runtime = ManagedRuntime.make(
      SubagentManagerLive.pipe(
        Layer.provide(
          Layer.sync(BackendRegistry, () => new Map([["pi", backend]])),
        ),
      ),
    );
    try {
      const manager = await runtime.runPromise(SubagentManager);
      const tasks = Array.from({ length: limit + 3 }, (_, index) => {
        const provider = ["openai-codex", "openai-codex-2", "openai-codex-3"][
          index % 3
        ];
        const choice = applySubagentProfile("implement", {
          model: `${index % 2 ? "openai-codex-3" : "openai-codex"}/${ids[index % ids.length]}`,
        });
        return {
          prompt: "Probe admission",
          title: "Admission",
          cwd: process.cwd(),
          model: choice.model,
          parent: {
            parentCwd: process.cwd(),
            projectTrusted: false,
            inheritedModel: { provider, id: "gpt-6-astra" },
            modelRegistry: registry,
          },
        } satisfies SpawnTask;
      });
      const outcomes = await Promise.allSettled(
        tasks.map((task) => runTool(runtime, manager.spawn("pi", task))),
      );
      const admitted = outcomes.filter(
        (result) => result.status === "fulfilled",
      );
      assert.equal(admitted.length, limit);
      assert.equal(started.length, limit);
      assert.equal(
        outcomes.filter((result) => result.status === "rejected").length,
        3,
      );
      for (const task of started) {
        assert.equal(
          task.resolvedPiModel?.provider,
          task.model?.startsWith("openai-codex-3/")
            ? "openai-codex-3"
            : task.parent.inheritedModel?.provider,
        );
      }
      await assert.rejects(
        runTool(runtime, manager.spawn("pi", tasks.at(-1)!)),
        /Quota.*full/,
      );
      await runTool(
        runtime,
        manager.cancel(admitted.map((result) => result.value.id)),
      );
      const replacement = await runTool(
        runtime,
        manager.spawn("pi", tasks.at(-1)!),
      );
      assert.equal(replacement.status, "running");
    } finally {
      await runtime.dispose();
    }
  }
});
