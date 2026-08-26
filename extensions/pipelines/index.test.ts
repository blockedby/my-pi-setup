import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  PIPELINE_RUN_PARAMETERS,
  resolvePipelineDefinition,
  resolvePipelineWorkingDir,
} from "./index.ts";

test("pipeline_run accepts a task with an optional working directory", () => {
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, { task: "Build a feature" }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "plan-pipeline",
      task: "Plan a feature",
      working_dir: ".worktrees/feature",
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "unknown-pipeline",
      task: "Build a feature",
    }),
    false,
  );
  assert.equal(Check(PIPELINE_RUN_PARAMETERS, {}), false);
});

test("pipeline_run defaults to feature-pipeline and rejects unknown definitions", () => {
  assert.equal(resolvePipelineDefinition(), "feature-pipeline");
  assert.equal(
    resolvePipelineDefinition("feature-pipeline"),
    "feature-pipeline",
  );
  assert.equal(resolvePipelineDefinition("plan-pipeline"), "plan-pipeline");
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
