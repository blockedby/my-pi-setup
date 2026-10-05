import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  assertPipelineGitCommitSupported,
  definitionFor,
  PIPELINE_DEFINITION_IDS,
  PUBLIC_PIPELINE_IDS,
  PIPELINE_MODELS,
} from "./domain.ts";
import { buildPipelineCommandMessage } from "./commands.ts";
import {
  assertPipelineName,
  canonicalPipelineId,
} from "./pipeline-identity.ts";
import pipelinesExtension, {
  PIPELINE_RUN_PARAMETERS,
  resolvePipelineDefinition,
  resolvePipelineWorkingDir,
} from "./index.ts";

const request = {
  pipeline_name: "implement-approved-change",
  task: "Implement the requested contract",
};

test("only public pipeline commands dispatch a follow-up launch", async () => {
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const messages: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const api = {
    on: () => () => {},
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (...args) => messages.push(args),
  } satisfies Partial<ExtensionAPI>;
  pipelinesExtension(api as unknown as ExtensionAPI);
  assert.deepEqual(
    [...commands.keys()].sort(),
    ["pipelines", ...PUBLIC_PIPELINE_IDS.map((id) => `pipelines:${id}`)].sort(),
  );
  const ctx = {} as Parameters<
    Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
  >[1];
  for (const pipeline of PUBLIC_PIPELINE_IDS) {
    for (const task of ["Implement the change", "", "  "]) {
      await commands.get(`pipelines:${pipeline}`)!.handler(task, ctx);
      assert.deepEqual(messages.at(-1), [
        buildPipelineCommandMessage(pipeline, task),
        { deliverAs: "followUp" },
      ]);
    }
  }
});

test("launch admission defaults to implementing and preserves historical identities", () => {
  assert.equal(resolvePipelineDefinition(), "implementing-pipeline");
  for (const definition of PIPELINE_DEFINITION_IDS) {
    assert.equal(definitionFor(definition).id, definition);
    if (PUBLIC_PIPELINE_IDS.some((id) => id === definition)) {
      assert.equal(resolvePipelineDefinition(definition), definition);
      assert.equal(
        Check(PIPELINE_RUN_PARAMETERS, { ...request, pipeline: definition }),
        true,
      );
    } else {
      assert.throws(() => resolvePipelineDefinition(definition));
      assert.equal(
        Check(PIPELINE_RUN_PARAMETERS, { ...request, pipeline: definition }),
        false,
      );
    }
  }
  assert.equal(Check(PIPELINE_RUN_PARAMETERS, request), true);
  for (const invalid of ["", "unknown-pipeline"])
    assert.throws(() => resolvePipelineDefinition(invalid));
});

test("the public interface rejects legacy graph/bootstrap/plan fields and unknown properties", () => {
  for (const extra of [
    { worktree_root: "/repo/worktrees" },
    { worktree_prepare: [] },
    { plan_path: null },
    { network_sandbox: true },
    { unknown: true },
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...request, ...extra }),
      false,
    );
  }
});

test("per-role models use the approved strict model enum", () => {
  for (const model of PIPELINE_MODELS) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        ...request,
        role_models: {
          "implement-small-feature": model,
          "pipeline-root": model,
        },
      }),
      true,
    );
  }
  for (const role_models of [
    { "implement-small-feature": "openai-codex/gpt-5.6-sol" },
    { unknown: PIPELINE_MODELS[0] },
    { "pipeline-root": "gpt-6.1-sol" },
    null,
    [],
  ])
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...request, role_models }),
      false,
    );
});

test("audit closure retains its typed scope contract", () => {
  const auditRequest = { ...request, pipeline: "audit-pipeline" };
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      ...auditRequest,
      audit: { mode: "initial", acceptance_criteria: ["Behavior holds"] },
    }),
    true,
  );
  const audit = {
    mode: "closure",
    prior_blockers: [
      { id: "REV-001", closure_condition: "The defect is fixed" },
    ],
    remediation_diff: "bounded supplied diff",
    touched_invariants: ["exactly-once delivery"],
  };
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, { ...auditRequest, audit }),
    true,
  );
  for (const invalid of [
    { ...audit, touched_invariants: [] },
    { ...audit, prior_blockers: [] },
    { ...audit, command: "git diff" },
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...auditRequest, audit: invalid }),
      false,
    );
  }
});

test("ordinary commit authority remains optional only for implementation launches", () => {
  for (const requested of [false, true]) {
    assert.doesNotThrow(() =>
      assertPipelineGitCommitSupported("implementing-pipeline", requested),
    );
  }
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("audit-pipeline", false),
  );
  assert.throws(() => assertPipelineGitCommitSupported("audit-pipeline", true));
});

test("pipeline names and canonical ids retain exact admission boundaries", () => {
  for (const pipeline_name of [
    "one-two-three",
    "one-two-three-four-five",
    `aa-${"b".repeat(30)}-${"c".repeat(30)}`,
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...request, pipeline_name }),
      true,
    );
    assert.doesNotThrow(() => assertPipelineName(pipeline_name));
  }
  for (const pipeline_name of [
    "one-two",
    "one-two-three-four-five-six",
    "One-two-three",
    "one--two-three",
    "one/two/three",
    "one-two-three\n",
    "x".repeat(65),
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...request, pipeline_name }),
      false,
    );
    assert.throws(() => assertPipelineName(pipeline_name));
  }
  assert.equal(Check(PIPELINE_RUN_PARAMETERS, { task: "Task" }), false);
  assert.equal(
    canonicalPipelineId("replace-heavy-plan-pipeline", "f82091ba"),
    "replace-heavy-plan-pipeline-f82091ba",
  );
  assert.throws(() =>
    canonicalPipelineId("replace-heavy-plan-pipeline", "ABCDEF12"),
  );
});

test("working directory resolution is unchanged", () => {
  assert.equal(resolvePipelineWorkingDir("/repo"), "/repo");
  assert.equal(
    resolvePipelineWorkingDir("/repo", ".worktrees/implementation"),
    "/repo/.worktrees/implementation",
  );
});

test("the extension registers only launch, evidence, cancellation and inspection tools", () => {
  const tools: string[] = [];
  const api = {
    on: () => {},
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  pipelinesExtension(api);
  assert.deepEqual(tools, [
    "pipeline_run",
    "pipeline_artifact_read",
    "pipeline_cancel",
    "pipeline_check",
    "pipeline_list",
  ]);
});
