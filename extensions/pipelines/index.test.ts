import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { assertPipelineGitCommitSupported } from "./domain.ts";
import { PIPELINE_DEFINITION_IDS } from "./domain.ts";
import { buildPipelineCommandMessage } from "./commands.ts";
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

test("pipeline slash commands dispatch the selected pipeline as a follow-up turn", async () => {
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const messages: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  const api = {
    on: () => {},
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerCommand: (name, command) => commands.set(name, command),
    sendUserMessage: (...args) => messages.push(args),
  } satisfies Partial<ExtensionAPI>;
  pipelinesExtension(api as unknown as ExtensionAPI);

  assert.deepEqual(
    [...commands.keys()].sort(),
    [
      ...PIPELINE_DEFINITION_IDS.map((id) => `pipeline:${id}`),
      "pipelines",
    ].sort(),
  );
  const ctx = {} as Parameters<
    Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
  >[1];
  for (const pipeline of PIPELINE_DEFINITION_IDS) {
    const command = commands.get(`pipeline:${pipeline}`);
    assert.ok(command);
    for (const task of [
      "Add a search field\nKeep keyboard navigation",
      "",
      "   ",
    ]) {
      const before = messages.length;
      await command.handler(task, ctx);
      assert.equal(messages.length, before + 1);
      assert.deepEqual(messages.at(-1), [
        buildPipelineCommandMessage(pipeline, task),
        { deliverAs: "followUp" },
      ]);
    }
  }
});

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
    "pipeline_artifact_read",
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
      worktree_root: "/repo/worktrees",
      worktree_prepare: [],
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
        worktree_root: "/repo/worktrees",
        worktree_prepare: ["bun run install:dependencies"],
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
      Check(PIPELINE_RUN_PARAMETERS, {
        pipeline_name,
        task: "Task",
        worktree_root: "/repo/worktrees",
        worktree_prepare: [],
      }),
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
      Check(PIPELINE_RUN_PARAMETERS, {
        pipeline_name,
        task: "Task",
        worktree_root: "/repo/worktrees",
        worktree_prepare: [],
      }),
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
      pipeline_name: "plan-approved-feature",
      pipeline: "plan-pipeline",
      task: "Plan a feature",
      plan_path: null,
    }),
    true,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "plan-approved-feature",
      pipeline: "plan-pipeline",
      task: "Plan a feature",
    }),
    false,
  );
  assert.equal(
    Check(PIPELINE_RUN_PARAMETERS, {
      pipeline_name: "audit-approved-feature",
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

test("feature and default launches require explicit child-worktree preparation inputs", () => {
  for (const definition of [{}, { pipeline: "feature-pipeline" }]) {
    const request = {
      ...definition,
      pipeline_name: "build-dynamic-feature",
      task: "Implement the feature",
      working_dir: "/repo/feature",
      git_commit: true,
    };
    assert.equal(Check(PIPELINE_RUN_PARAMETERS, request), false);
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        ...request,
        worktree_root: "/repo/worktrees",
      }),
      false,
    );
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...request, worktree_prepare: [] }),
      false,
    );
    for (const worktree_prepare of [
      [],
      ["bun run install:dependencies", "bun run check"],
    ]) {
      assert.equal(
        Check(PIPELINE_RUN_PARAMETERS, {
          ...request,
          worktree_root: "/repo/worktrees",
          worktree_prepare,
        }),
        true,
      );
    }
    for (const worktree_prepare of [
      null,
      "bun install",
      [""],
      Array.from({ length: 65 }, () => "true"),
    ]) {
      assert.equal(
        Check(PIPELINE_RUN_PARAMETERS, {
          ...request,
          worktree_root: "/repo/worktrees",
          worktree_prepare,
        }),
        false,
      );
    }
  }
});

test("neighboring definitions reject feature-only preparation fields", () => {
  for (const pipeline of [
    "small-feature-pipeline",
    "plan-pipeline",
    "audit-pipeline",
  ]) {
    const request = {
      pipeline,
      pipeline_name: "run-neighboring-pipeline",
      task: "Perform the requested operation",
      ...(pipeline === "plan-pipeline" ? { plan_path: null } : {}),
    };
    assert.equal(Check(PIPELINE_RUN_PARAMETERS, request), true);
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, {
        ...request,
        worktree_root: "/repo/worktrees",
      }),
      false,
    );
    assert.equal(
      Check(PIPELINE_RUN_PARAMETERS, { ...request, worktree_prepare: [] }),
      false,
    );
  }
});
