import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import pipelinesExtension, {
  PIPELINE_RUN_PARAMETERS,
  resolvePipelineDefinition,
  resolvePipelineWorkingDir,
} from "./index.ts";

test("pipeline extension registers run plus main-agent check/list without status/wait aliases", () => {
  const tools: string[] = [];
  const api = {
    on: () => {},
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerMessageRenderer: () => {},
    registerCommand: () => {},
  } as unknown as ExtensionAPI;

  pipelinesExtension(api);

  assert.deepEqual(tools, ["pipeline_run", "pipeline_check", "pipeline_list"]);
  assert.equal(tools.includes("pipeline_status"), false);
  assert.equal(tools.includes("pipeline_wait"), false);
});

test("pipeline_run accepts a task with an optional working directory", () => {
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, { task: "Build a feature" }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline: "small-feature-pipeline",
      task: "Implement a bounded feature",
      working_dir: ".worktrees/small-feature",
    }),
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
      pipeline: "audit-pipeline",
      task: "Unsafe audit",
      audit: { mode: "closure", base_ref: "main", command: "git diff" },
    }),
    false,
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
