import assert from "node:assert/strict";
import test from "node:test";
import {
  pipelineCommitPolicy,
  SMALL_FEATURE_AUDIT_GIT_REQUIREMENTS,
} from "./prompt.ts";

const commitRequested = {
  gitCommit: true,
  task: "Task prose may also request a commit",
};

test("small-feature commit authority is an explicit structured role policy", () => {
  assert.deepEqual(
    pipelineCommitPolicy(
      "small-feature-pipeline",
      "implement-small-feature",
      commitRequested,
    ),
    {
      requested: true,
      commitAllowed: true,
      taskProseCanGrant: false,
    },
  );
  assert.deepEqual(
    pipelineCommitPolicy("small-feature-pipeline", "implement-small-feature", {
      gitCommit: false,
    }),
    {
      requested: false,
      commitAllowed: false,
      taskProseCanGrant: false,
    },
  );
});

test("small-feature root and audit roles never receive commit authority", () => {
  assert.equal(
    pipelineCommitPolicy(
      "small-feature-pipeline",
      "pipeline-root",
      commitRequested,
    ).commitAllowed,
    false,
  );
  assert.equal(
    pipelineCommitPolicy(
      "small-feature-pipeline",
      "audit-logic-invariants",
      commitRequested,
    ).commitAllowed,
    false,
  );
});

test("git_commit does not grant commit authority to other definitions", () => {
  assert.equal(
    pipelineCommitPolicy("feature-pipeline", "pipeline-root", commitRequested)
      .commitAllowed,
    false,
  );
  assert.equal(
    pipelineCommitPolicy(
      "audit-pipeline",
      "audit-feature-outcome",
      commitRequested,
    ).commitAllowed,
    false,
  );
});

test("small-feature commit audit requirements are a structured contract", () => {
  assert.deepEqual(Object.keys(SMALL_FEATURE_AUDIT_GIT_REQUIREMENTS), [
    "evidence",
    "scope",
    "ancestry",
    "reviewedState",
    "uncertainty",
    "commitStyle",
  ]);
});
