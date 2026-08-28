import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { assertPipelineGitCommitSupported } from "./domain.ts";
import {
  assertPipelineName,
  canonicalPipelineId,
} from "./pipeline-identity.ts";
import pipelinesExtension, {
  PIPELINE_CANCEL_PARAMETERS,
  PIPELINE_RUN_PARAMETERS,
  resolvePipelineDefinition,
  resolvePipelineWorkingDir,
} from "./index.ts";

test("pipeline extension registers run/cancel/check/list without status/wait aliases", () => {
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
    "pipeline_cancel",
    "pipeline_check",
    "pipeline_list",
  ]);
  assert.equal(tools.includes("pipeline_status"), false);
  assert.equal(tools.includes("pipeline_wait"), false);
});

test("registered pipeline_cancel schema rejects malformed host payloads", () => {
  const tools: Array<{ name: string; parameters: TSchema }> = [];
  const api = {
    on: () => {},
    registerTool: (tool: { name: string; parameters: TSchema }) =>
      tools.push(tool),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;

  pipelinesExtension(api);
  const cancellation = tools.find((tool) => tool.name === "pipeline_cancel");
  assert.ok(cancellation);
  assert.deepEqual(cancellation.parameters, PIPELINE_CANCEL_PARAMETERS);
  for (const malformed of [
    { ids: [] },
    {
      ids: ["cancel-me-now-00000001", "cancel-me-now-00000001"],
    },
    { ids: ["x".repeat(257)] },
    { ids: ["cancel-me-now-00000001"], child_id: "agent-1" },
  ]) {
    assert.equal(Check(cancellation.parameters, malformed), false);
  }
});

test("pipeline_run requires a strict human-readable pipeline name", () => {
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "build-approved-feature",
      task: "Build a feature",
    }),
    true,
  );
  for (const git_commit of [true, false]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        pipeline_name: "implement-approved-feature",
        pipeline: "feature-pipeline",
        task: "Implement a feature",
        working_dir: "/repo/current-branch",
        git_commit,
      }),
      true,
    );
  }
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "implement-bounded-feature",
      pipeline: "small-feature-pipeline",
      task: "Implement a bounded feature",
      working_dir: ".worktrees/small-feature",
      git_commit: true,
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "plan-approved-feature",
      pipeline: "plan-pipeline",
      task: "Plan a feature",
      working_dir: ".worktrees/feature",
      plan_path: null,
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "audit-bounded-change",
      pipeline: "audit-pipeline",
      task: "Audit the bounded change",
      working_dir: ".worktrees/audit",
      audit: {
        mode: "initial",
        acceptance_criteria: ["The contract holds"],
      },
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "verify-prior-blockers",
      pipeline: "audit-pipeline",
      task: "Verify prior blockers",
      audit: {
        mode: "closure",
        prior_blockers: [
          { id: "AUD-001", closure_condition: "The defect is fixed" },
        ],
        remediation_diff: "bounded supplied diff",
        touched_invariants: ["exactly-once delivery"],
      },
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "verify-prior-blockers",
      pipeline: "audit-pipeline",
      task: "Incomplete closure audit",
      audit: {
        mode: "closure",
        prior_blockers: [
          { id: "AUD-001", closure_condition: "The defect is fixed" },
        ],
        remediation_diff: "bounded supplied diff",
        touched_invariants: [],
      },
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "unsafe-audit-input",
      pipeline: "audit-pipeline",
      task: "Unsafe audit",
      audit: { mode: "closure", base_ref: "main", command: "git diff" },
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "build-approved-feature",
      pipeline: "unknown-pipeline",
      task: "Build a feature",
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, { task: "Build a feature" }),
    false,
  );
});

test("pipeline names enforce exact word, casing, separator, and length boundaries", () => {
  const maxName = `aa-${"b".repeat(30)}-${"c".repeat(30)}`;
  assert.equal(maxName.length, 64);
  for (const pipeline_name of [
    "one-two-three",
    "one-two-three-four",
    "one-two-three-four-five",
    maxName,
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { pipeline_name, task: "Task" }),
      true,
    );
    assert.doesNotThrow(() => assertPipelineName(pipeline_name));
  }
  for (const pipeline_name of [
    "one-two",
    "one-two-three-four-five-six",
    "One-two-three",
    "one two three",
    "one/two/three",
    "one--two-three",
    "one-two-three-",
    "one-two-three!",
    "one-two-three\n",
    `${maxName}x`,
  ]) {
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { pipeline_name, task: "Task" }),
      false,
    );
    assert.throws(() => assertPipelineName(pipeline_name));
  }
  assert.equal(Check(PIPELINE_RUN_PARAMETERS, { task: "Task" }), false);
  assert.throws(() => assertPipelineName(undefined), /required/);
});

test("canonical pipeline ids preserve the base and append an exact token", () => {
  assert.equal(
    canonicalPipelineId("replace-heavy-plan-pipeline", "f82091ba"),
    "replace-heavy-plan-pipeline-f82091ba",
  );
  assert.throws(
    () => canonicalPipelineId("replace-heavy-plan-pipeline", "ABCDEF12"),
    /exactly eight lowercase hexadecimal/,
  );
});

test("pipeline_run schema makes plan_path required only for plan definitions", () => {
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "plan-pipeline",
      task: "Plan a feature",
      plan_path: null,
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "plan-pipeline",
      task: "Plan a feature",
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "audit-pipeline",
      task: "Audit a feature",
      plan_path: "unsafe.plan",
    }),
    false,
  );
});

test("git_commit validation requires feature true and rejects plan/audit true", () => {
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("feature-pipeline", true),
  );
  for (const requested of [false]) {
    assert.throws(
      () => assertPipelineGitCommitSupported("feature-pipeline", requested),
      /requires explicit git_commit: true/,
    );
  }
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("small-feature-pipeline", true),
  );
  assert.doesNotThrow(() =>
    assertPipelineGitCommitSupported("plan-pipeline", false),
  );
  for (const pipeline of ["plan-pipeline", "audit-pipeline"] as const) {
    assert.throws(
      () => assertPipelineGitCommitSupported(pipeline, true),
      new RegExp(
        `git_commit is only supported for feature-pipeline and small-feature-pipeline.*${pipeline}`,
      ),
    );
  }
});

test("pipeline_run defaults to feature-pipeline and rejects unknown definitions", () => {
  assert.equal(resolvePipelineDefinition(), "feature-pipeline");
  assert.equal(
    resolvePipelineDefinition("feature-pipeline"),
    "feature-pipeline",
  );
  assert.equal(
    resolvePipelineDefinition("small-feature-pipeline"),
    "small-feature-pipeline",
  );
  assert.equal(resolvePipelineDefinition("plan-pipeline"), "plan-pipeline");
  assert.equal(resolvePipelineDefinition("audit-pipeline"), "audit-pipeline");
  assert.throws(
    () => resolvePipelineDefinition("unknown-pipeline"),
    /Unsupported pipeline definition/,
  );
});

test("pipeline_run defaults to the current directory and resolves explicit workspaces", () => {
  assert.equal(resolvePipelineWorkingDir("/repo"), "/repo");
  assert.equal(
    resolvePipelineWorkingDir("/repo", ".worktrees/feature"),
    "/repo/.worktrees/feature",
  );
});
