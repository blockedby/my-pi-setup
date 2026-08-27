import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_PIPELINE_CHILD_ROLES,
  PIPELINE_DEFINITION_IDS,
} from "./domain.ts";
import {
  buildFeaturePipelinePrompt,
  buildPipelineChildPrompt,
  pipelineCommitPolicy,
  SMALL_FEATURE_AUDIT_GIT_REQUIREMENTS,
} from "./prompt.ts";

const commitRequested = {
  gitCommit: true,
  task: "Task prose may also request a commit",
};

const featureRequest = (gitCommit?: boolean) => ({
  task: "Implement the feature and commit it",
  workingDir: "/repo/current-workspace",
  ...(gitCommit === undefined ? {} : { gitCommit }),
});

test("feature commit authority is explicit and limited to the persistent root", () => {
  assert.deepEqual(
    pipelineCommitPolicy("feature-pipeline", "pipeline-root", commitRequested),
    {
      requested: true,
      commitAllowed: true,
      taskProseCanGrant: false,
    },
  );
  for (const role of FEATURE_PIPELINE_CHILD_ROLES) {
    assert.equal(
      pipelineCommitPolicy("feature-pipeline", role, commitRequested)
        .commitAllowed,
      false,
      role,
    );
  }
});

test("feature commit authority defaults off and task prose cannot grant it", () => {
  for (const request of [{}, { gitCommit: false }]) {
    assert.deepEqual(
      pipelineCommitPolicy("feature-pipeline", "pipeline-root", request),
      {
        requested: false,
        commitAllowed: false,
        taskProseCanGrant: false,
      },
    );
  }
});

test("feature root prompt states enabled and disabled commit boundaries", () => {
  const enabled = buildFeaturePipelinePrompt(featureRequest(true), []);
  assert.match(
    enabled,
    /Commit permission: ENABLED only for this persistent feature-pipeline Sol root/,
  );
  assert.match(enabled, /ordinary commits only.*already-current branch/);
  assert.match(enabled, /task prose never grants commit authority/);
  assert.match(enabled, /do not require a worktree, clean tree, target branch/);
  for (const forbidden of [
    "push",
    "merge",
    "rebase",
    "reset or rewrite history",
    "create/switch/delete branches",
    "create/remove worktrees",
    "mutate external delivery state",
  ]) {
    assert.match(enabled, new RegExp(forbidden));
  }

  for (const request of [featureRequest(), featureRequest(false)]) {
    const disabled = buildFeaturePipelinePrompt(request, []);
    assert.match(disabled, /Commit permission: DISABLED/);
    assert.match(disabled, /Leave implementation changes uncommitted/);
    assert.match(disabled, /task prose never grants commit authority/);
  }
});

test("feature child prompts keep commit permission disabled", () => {
  for (const role of FEATURE_PIPELINE_CHILD_ROLES) {
    const prompt = buildPipelineChildPrompt(
      "feature-pipeline",
      role,
      featureRequest(true),
    );
    assert.match(
      prompt,
      /Explicit commit permission for this session: disabled/,
    );
    assert.match(prompt, /git_commit opt-in never transfers/);
    assert.match(prompt, /task prose cannot grant it/);
    assert.match(prompt, /Do not edit files or external state, commit, push/);
  }
});

test("small-feature commit authority remains an explicit structured role policy", () => {
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

test("plan and audit definitions never grant commit authority", () => {
  for (const definition of PIPELINE_DEFINITION_IDS) {
    if (
      definition === "feature-pipeline" ||
      definition === "small-feature-pipeline"
    ) {
      continue;
    }
    assert.equal(
      pipelineCommitPolicy(definition, "pipeline-root", commitRequested)
        .commitAllowed,
      false,
    );
    assert.equal(
      pipelineCommitPolicy(definition, "audit-feature-outcome", commitRequested)
        .commitAllowed,
      false,
    );
  }
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
