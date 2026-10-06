import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentNodeSpec,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import { resolveSubscriptionModel } from "../shared/codex-subscription.ts";
import { PipelineController } from "./controller.ts";
import { AUDIT_PIPELINE_ID, SOL_MODEL } from "./domain.ts";

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Pipeline did not create its audit root and children");
}

test("controller captures each launch provider for admission and every root/child, not the first controller's account", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipi-subscription-controller-"));
  const availability: { model: string; provider?: string }[] = [];
  const created: { spec: AgentNodeSpec; provider?: string }[] = [];
  const controller = new PipelineController({
    artifactRoot: join(root, "artifacts"),
    modelAvailable: (model, provider) => {
      availability.push({ model, provider });
      return true;
    },
    createSessionFactory: (...args) => {
      const parentProviderForRun = args[13];
      assert.ok(parentProviderForRun);
      return {
        async create(spec) {
          created.push({
            spec,
            provider: parentProviderForRun(spec.scopeId ?? ""),
          });
          const listeners = new Set<(event: AgentTreeSessionEvent) => void>();
          return {
            activeTools: [],
            isStreaming: false,
            subscribe(listener) {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            async prompt() {},
            async send() {},
            enableMutation() {},
            async interrupt() {},
            dispose() {},
          };
        },
      };
    },
    onHandoff: () => {},
  });
  try {
    for (const [index, provider] of [
      "openai-codex-2",
      "openai-codex-3",
      "custom",
    ].entries()) {
      const request = {
        pipelineName: `review-account-${["two", "three", "custom"][index]}`,
        pipeline: AUDIT_PIPELINE_ID,
        parentProvider: provider,
        task: "Check subscription propagation",
        workingDir: root,
      };
      const run = controller.start(request);
      // Even if caller data or main selection changes after launch, run context is stable.
      request.parentProvider = "openai-codex";
      await waitFor(
        () => created.filter((entry) => entry.spec.scopeId === run).length >= 5,
      );
      const agents = created.filter((entry) => entry.spec.scopeId === run);
      assert.ok(agents.some((entry) => !entry.spec.parentId));
      assert.ok(agents.some((entry) => entry.spec.parentId));
      for (const entry of agents) assert.equal(entry.provider, provider);
      assert.ok(availability.some((entry) => entry.provider === provider));
      for (const entry of availability.filter(
        (entry) => entry.provider === provider,
      ))
        assert.ok(entry.model.startsWith("openai-codex/"));
    }
  } finally {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("pipeline admission fails on the launch account before creating sessions or artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipi-subscription-admission-"));
  const calls: string[] = [];
  let creates = 0;
  const controller = new PipelineController({
    artifactRoot: join(root, "artifacts"),
    modelAvailable: (hint, provider) =>
      Boolean(
        resolveSubscriptionModel(
          {
            find: (actual, id) => {
              calls.push(`${actual}/${id}`);
              return undefined;
            },
          },
          hint,
          provider,
        ),
      ),
    createSessionFactory: () => ({
      create: async () => {
        creates++;
        throw new Error("Unreachable");
      },
    }),
    onHandoff: () => {},
  });
  try {
    assert.throws(
      () =>
        controller.start({
          pipelineName: "review-missing-account",
          pipeline: AUDIT_PIPELINE_ID,
          parentProvider: "openai-codex-2",
          task: "Unavailable model probe",
          workingDir: root,
          roleModels: { "audit-synthesis": SOL_MODEL },
        }),
      /openai-codex-2.*No fallback/,
    );
    assert.equal(creates, 0);
    assert.equal(controller.list().length, 0);
    assert.ok(calls.length > 0);
    assert.ok(calls.every((call) => call.startsWith("openai-codex-2/")));
  } finally {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
