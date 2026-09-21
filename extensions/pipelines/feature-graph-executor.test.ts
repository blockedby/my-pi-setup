import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExecutionTree } from "./feature-graph.ts";
import { createFeatureReviewRuntime } from "./feature-task-runtime.ts";
import { FeatureSubtreeOperationError } from "./feature-execution-contract.ts";
import type { CleanupEvidence } from "./cleanup-evidence.ts";
import {
  executeFeatureGraph,
  type FeatureGraphEvidenceEvent,
} from "./feature-graph-executor.ts";
import type {
  FeatureCanonicalPlan,
  FeatureExecutionCheck,
  FeatureExecutionGraph,
  FeatureExecutionTask,
} from "./feature-planning.ts";

function git(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture({
  trackedBuildIdentity = false,
}: { trackedBuildIdentity?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-graph-executor-"));
  const primary = path.join(root, "primary");
  const workingDir = path.join(root, "caller");
  const worktreeRoot = path.join(root, "worktrees");
  const runId = "dynamic-graph-1234abcd";
  fs.mkdirSync(primary);
  fs.mkdirSync(worktreeRoot);
  fs.mkdirSync(path.join(worktreeRoot, runId));
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "test@example.com"]);
  git(primary, ["config", "user.name", "Pipi Test"]);
  fs.writeFileSync(path.join(primary, "shared.txt"), "base\n");
  if (trackedBuildIdentity) {
    fs.writeFileSync(path.join(primary, "build-identity.ts"), "base\n");
  }
  git(primary, ["add", "."]);
  git(primary, ["commit", "-qm", "baseline"]);
  git(primary, ["worktree", "add", "-qb", "feature/test", workingDir, "HEAD"]);
  return {
    root,
    primary,
    workingDir,
    worktreeRoot,
    runId,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const baselineCheck = {
  id: "baseline",
  command: "verify baseline",
  cwd: ".",
  purpose: "The branch remains compatible.",
  required: true,
} satisfies FeatureExecutionCheck;

const canonicalPlan = {
  reportType: "feature-canonical-plan-v1",
  summary:
    "Implement the fixture feature through controller-owned graph tasks.",
  decisions: [
    {
      id: "DEC-1",
      title: "Controller ownership",
      body: "The controller owns graph Git mutations.",
      evidence: [{ reference: "fixture", finding: "Git state is observable." }],
      rejectedAlternatives: [],
    },
  ],
  changes: [
    {
      id: "CHANGE-1",
      path: "shared.txt",
      symbols: ["fixture"],
      action: "modify",
      body: "Update the fixture through bounded tasks.",
      decisionRefs: ["DEC-1"],
      contractRefs: ["INV-1"],
      acceptanceRefs: ["AC-1"],
    },
  ],
  contracts: [
    {
      id: "INV-1",
      title: "Validated commits",
      body: "Only validated commits are integrated.",
      paths: ["shared.txt"],
    },
  ],
  acceptance: [
    {
      id: "AC-1",
      scenario: "The graph completes.",
      expected: "Every branch is joined deterministically.",
      verification: "Fixture assertions.",
    },
  ],
  verification: [
    {
      id: "CHECK-1",
      command: "verify baseline",
      cwd: ".",
      purpose: "Verify the fixture.",
      proves: ["AC-1"],
      required: true,
    },
  ],
  risks: [],
  blockers: [],
  finalRationale: "This plan exercises controller-owned graph behavior.",
} satisfies FeatureCanonicalPlan;

function graphTask(id: string, dependsOn: ReadonlyArray<string> = []) {
  return {
    id,
    objective: `Implement ${id}`,
    branchGoal: `Complete ${id} on its assigned branch`,
    dependsOn: [...dependsOn],
    context: {
      problem: `The fixture needs ${id}.`,
      repositoryConventions: ["Use one explicit fixture path."],
      relevantDiscovery: ["Tasks must remain independently valid."],
      precedents: [
        {
          path: "shared.txt",
          symbol: id,
          lesson: "Use a small deterministic fixture edit.",
        },
      ],
      invariants: ["Only controller-created commits advance the task."],
    },
    readPaths: ["shared.txt"],
    writePaths: [`${id}.txt`],
    instructions: [`Create ${id}.txt.`],
    implementationSketch: `Write the bounded ${id} fixture and finalize it.`,
    acceptanceRefs: ["AC-1"],
    doneWhen: [`${id}.txt is committed and checks pass.`],
    checks: [
      {
        id: `check-${id}`,
        command: `verify ${id}`,
        cwd: ".",
        purpose: `Verify ${id}.`,
        required: true,
      },
    ],
  } satisfies FeatureExecutionTask;
}

function graph(
  tasks: ReadonlyArray<FeatureExecutionTask>,
  checks: ReadonlyArray<FeatureExecutionCheck> = [baselineCheck],
) {
  return {
    reportType: "feature-execution-graph-v1",
    summary: "Execute the fixture graph.",
    baselineChecks: [...checks],
    reviewChecks: [baselineCheck],
    tasks: [...tasks],
  } satisfies FeatureExecutionGraph;
}

const passingCheck = async () => ({
  exitCode: 0,
  stdout: "passed",
  stderr: "",
});

test("fork branches prepare once, run without a quota queue, and join in deterministic commit order", async () => {
  const repo = fixture();
  try {
    const tasks = [
      graphTask("branch-b"),
      graphTask("branch-d", ["branch-b"]),
      graphTask("branch-c"),
      graphTask("branch-e", ["branch-c"]),
    ];
    const executionGraph = graph(tasks);
    const tree = {
      kind: "fork",
      branches: [
        {
          kind: "sequence",
          steps: [
            { kind: "task", taskId: "branch-c" },
            { kind: "task", taskId: "branch-e" },
          ],
        },
        {
          kind: "sequence",
          steps: [
            { kind: "task", taskId: "branch-b" },
            { kind: "task", taskId: "branch-d" },
          ],
        },
      ],
    } satisfies ExecutionTree;
    const prepareCalls: string[] = [];
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: ["prepare fixture"],
      canonicalPlan,
      graph: executionGraph,
      tree,
      async runCheck(input) {
        if (input.kind === "prepare") {
          prepareCalls.push(input.workspaceRoot);
          fs.writeFileSync(
            path.join(input.workspaceRoot, ".prepared"),
            "yes\n",
          );
        }
        return passingCheck();
      },
      async runSession(input) {
        assert.equal(input.model, "openai-codex/gpt-6-astra");
        assert.equal(input.thinkingLevel, "low");
        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), `${input.task!.id}\n`);
        const finalized = await input.tools.finalize({
          commitPaths: [filePath],
          summary: `Implemented ${input.task!.id} in its branch.`,
        });
        assert.equal(finalized.validated, true);
        return {
          status: "settled",
          sessionId: `${input.role}-${input.attempt}`,
        };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(prepareCalls.length, 2);
    assert.deepEqual(
      git(repo.workingDir, [
        "log",
        "--reverse",
        "--format=%s",
        "HEAD~4..HEAD",
      ]).split("\n"),
      [
        "feature: branch-b Implement branch-b",
        "feature: branch-d Implement branch-d",
        "feature: branch-c Implement branch-c",
        "feature: branch-e Implement branch-e",
      ],
    );
    assert.deepEqual(
      result.joins[0]!.commits.map(({ taskId }) => taskId),
      ["branch-b", "branch-d", "branch-c", "branch-e"],
    );
    assert.equal(
      result.branches[1]!.branch.includes("branch-1-branch-b"),
      true,
    );
    assert.equal(
      result.branches[2]!.branch.includes("branch-2-branch-c"),
      true,
    );
    assert.equal(
      git(repo.workingDir, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/pipi-feature/${repo.runId}`,
      ])
        .split("\n")
        .filter(Boolean).length,
      2,
    );
    assert.deepEqual(result.cleanupCompleted(), []);
    assert.equal(
      git(repo.workingDir, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/pipi-feature/${repo.runId}`,
      ]),
      "",
    );
  } finally {
    repo.cleanup();
  }
});

test("nested forks use actual first tasks for numbering and preserve provenance through each join", async () => {
  const repo = fixture();
  try {
    const tasks = [
      graphTask("z-start"),
      graphTask("a-tail", ["nested-b", "nested-c"]),
      graphTask("nested-b", ["z-start"]),
      graphTask("nested-c", ["z-start"]),
      graphTask("middle-root"),
      graphTask("downstream", ["a-tail", "middle-root", "nested-b"]),
    ];
    const executionGraph = graph(tasks);
    const tree = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          branches: [
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: "z-start" },
                {
                  kind: "fork",
                  branches: [
                    { kind: "task", taskId: "nested-c" },
                    { kind: "task", taskId: "nested-b" },
                  ],
                },
                { kind: "task", taskId: "a-tail" },
              ],
            },
            { kind: "task", taskId: "middle-root" },
          ],
        },
        { kind: "task", taskId: "downstream" },
      ],
    } satisfies ExecutionTree;
    let downstreamDependencies:
      ReadonlyArray<{ taskId: string; commit: string }> | undefined;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: [],
      canonicalPlan,
      graph: executionGraph,
      tree,
      runCheck: passingCheck,
      async runSession(input) {
        if (input.task!.id === "downstream") {
          downstreamDependencies =
            input.capsule.graphContext.completedDependencies;
        }
        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), `${input.task!.id}\n`);
        await input.tools.finalize({
          commitPaths: [filePath],
          summary: `Implemented ${input.task!.id}.`,
        });
        return { status: "settled", sessionId: input.role };
      },
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.branches.slice(1).map(({ number, firstTaskId }) => ({
        number,
        firstTaskId,
      })),
      [
        { number: 1, firstTaskId: "middle-root" },
        { number: 2, firstTaskId: "z-start" },
        { number: 3, firstTaskId: "nested-b" },
        { number: 4, firstTaskId: "nested-c" },
      ],
    );
    assert.deepEqual(
      result.joins.map(({ id }) => id),
      ["join-1", "join-2"],
    );
    assert.deepEqual(
      result.joins
        .find(({ id }) => id === "join-2")!
        .commits.map(({ taskId }) => taskId),
      ["nested-b", "nested-c"],
    );
    assert.deepEqual(
      result.joins
        .find(({ id }) => id === "join-1")!
        .commits.map(({ taskId }) => taskId),
      ["middle-root", "z-start", "nested-b", "nested-c", "a-tail"],
    );
    const nestedSource = result.joins
      .find(({ id }) => id === "join-2")!
      .commits.find(({ taskId }) => taskId === "nested-b")!;
    const outerSource = result.joins
      .find(({ id }) => id === "join-1")!
      .commits.find(({ taskId }) => taskId === "nested-b")!;
    assert.equal(outerSource.sourceCommit, nestedSource.integratedCommit);
    assert.notEqual(outerSource.integratedCommit, outerSource.sourceCommit);
    const downstreamNested = downstreamDependencies?.find(
      ({ taskId }) => taskId === "nested-b",
    );
    assert.equal(downstreamNested?.commit, outerSource.integratedCommit);
  } finally {
    repo.cleanup();
  }
});

test("a failed provisional check is repaired by amending the same logical task commit", async () => {
  const repo = fixture();
  try {
    const task = graphTask("retry-task");
    const executionGraph = graph([task], []);
    const tree = { kind: "task", taskId: task.id } satisfies ExecutionTree;
    let firstCommit = "";
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      async runCheck(input) {
        const content = fs.readFileSync(
          path.join(input.workspaceRoot, "retry-task.txt"),
          "utf8",
        );
        return {
          exitCode: content === "fixed\n" ? 0 : 1,
          stdout: content,
          stderr: content === "fixed\n" ? "" : "still broken",
        };
      },
      async runSession(input) {
        fs.writeFileSync(
          path.join(input.cwd, "retry-task.txt"),
          input.attempt === 1 ? "broken\n" : "fixed\n",
        );
        const finalized = await input.tools.finalize({
          commitPaths: ["retry-task.txt"],
          summary: `Retry task attempt ${input.attempt}.`,
        });
        if (input.attempt === 1) {
          assert.equal(finalized.validated, false);
          firstCommit = finalized.commit!;
        } else {
          assert.equal(finalized.validated, true);
          assert.notEqual(finalized.commit, firstCommit);
        }
        return { status: "settled", sessionId: `retry-${input.attempt}` };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.tasks[0]!.attempt, 2);
    assert.deepEqual(
      result.tasks[0]!.attempts.map(({ status }) => status),
      ["completed", "completed"],
    );
    assert.equal(git(repo.workingDir, ["rev-list", "--count", "HEAD"]), "2");
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "retry-task.txt"), "utf8"),
      "fixed\n",
    );
  } finally {
    repo.cleanup();
  }
});

test("child preparation failure reaches bounded persistent recovery", async () => {
  const repo = fixture();
  try {
    const task = graphTask("prepared-task");
    const executionGraph = graph([task]);
    const tree = {
      kind: "fork",
      branches: [{ kind: "task", taskId: task.id }],
    } satisfies ExecutionTree;
    let preparationAttempts = 0;
    let sessionAttempts = 0;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: ["prepare fixture"],
      canonicalPlan,
      graph: executionGraph,
      tree,
      async runCheck(input) {
        if (input.kind === "prepare") {
          preparationAttempts += 1;
          return {
            exitCode: 1,
            stdout: "preparation stdout",
            stderr: "preparation unavailable",
          };
        }
        return passingCheck();
      },
      async runSession() {
        sessionAttempts += 1;
        return { status: "settled" };
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.tasks[0]!.status, "failed");
    assert.equal(preparationAttempts, 1);
    assert.equal(sessionAttempts, 3);
    assert.equal(result.tasks[0]!.attempts.length, 3);
    assert.equal(result.branches[1]!.preparation.attempts, 1);
    assert.equal(result.branches[1]!.preparation.complete, false);
    assert.deepEqual(result.branches[1]!.preparation.commands, [
      {
        command: "prepare fixture",
        cwd: result.branches[1]!.worktree,
        exitCode: 1,
        stdout: "preparation stdout",
        stderr: "preparation unavailable",
      },
    ]);
  } finally {
    repo.cleanup();
  }
});

test("preparation retains ordered command history when a later command fails", async () => {
  const repo = fixture();
  try {
    const task = graphTask("preparation-history");
    const prepareCommands = [
      "prepare first",
      "prepare second",
      "prepare never",
    ];
    const calls: string[] = [];
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: prepareCommands,
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "fork", branches: [{ kind: "task", taskId: task.id }] },
      async runCheck(input) {
        if (input.kind !== "prepare") return passingCheck();
        calls.push(input.command);
        return input.command === prepareCommands[0]
          ? {
              exitCode: 0,
              stdout: "first stdout",
              stderr: "first stderr",
            }
          : {
              exitCode: 7,
              stdout: "second stdout",
              stderr: "second stderr",
            };
      },
      async runSession() {
        throw new Error("preparation should prevent launch");
      },
    });

    const branch = result.branches[1]!;
    assert.equal(result.status, "failed");
    assert.deepEqual(calls, prepareCommands.slice(0, 2));
    assert.deepEqual(branch.preparation.commands, [
      {
        command: prepareCommands[0],
        cwd: branch.worktree,
        exitCode: 0,
        stdout: "first stdout",
        stderr: "first stderr",
      },
      {
        command: prepareCommands[1],
        cwd: branch.worktree,
        exitCode: 7,
        stdout: "second stdout",
        stderr: "second stderr",
      },
    ]);
    assert.equal(
      branch.preparation.error,
      "Preparation command exited 7: second stderr",
    );
    assert.equal(branch.preparation.complete, false);
    assert.equal(result.tasks[0]!.attempt, 3);
  } finally {
    repo.cleanup();
  }
});

test("preparation preserves nullable exit codes from command runners", async () => {
  const repo = fixture();
  try {
    const task = graphTask("nullable-preparation");
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: ["prepare nullable"],
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "fork", branches: [{ kind: "task", taskId: task.id }] },
      async runCheck(input) {
        if (input.kind === "prepare") {
          return {
            exitCode: null,
            stdout: "partial stdout",
            stderr: "partial stderr",
          };
        }
        return passingCheck();
      },
      async runSession() {
        throw new Error("preparation should prevent launch");
      },
    });

    const branch = result.branches[1]!;
    assert.equal(result.status, "failed");
    assert.deepEqual(branch.preparation.commands, [
      {
        command: "prepare nullable",
        cwd: branch.worktree,
        exitCode: null,
        stdout: "partial stdout",
        stderr: "partial stderr",
      },
    ]);
    assert.match(branch.preparation.error!, /exited null: partial stderr/);
  } finally {
    repo.cleanup();
  }
});

test("successful tracked preparation reaches the first worker and can be committed", async () => {
  const repo = fixture({ trackedBuildIdentity: true });
  const preparationPath = "build-identity.ts";
  try {
    const task = graphTask("prepared-task");
    let sessions = 0;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: ["prepare build identity"],
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "fork", branches: [{ kind: "task", taskId: task.id }] },
      async runCheck(input) {
        if (input.kind === "prepare") {
          fs.writeFileSync(
            path.join(input.workspaceRoot, preparationPath),
            "generated by preparation\n",
          );
        }
        return passingCheck();
      },
      async runSession(input) {
        sessions++;
        assert.equal(input.attempt, 1);
        assert.equal(
          input.capsule.graphContext.preparationBaseline.includes(
            preparationPath,
          ),
          false,
        );
        const capsuleChanges = input.capsule.graphContext.preparationChanges;
        assert.ok(capsuleChanges);
        assert.deepEqual(
          capsuleChanges.map(({ path: filePath }) => filePath),
          [preparationPath],
        );
        assert.notEqual(capsuleChanges[0]!.fingerprint, "");

        const evidence = await input.tools.diff();
        assert.deepEqual(evidence.tracked, [preparationPath]);
        assert.deepEqual(evidence.staged, []);
        assert.equal(
          evidence.preparationBaseline.includes(preparationPath),
          false,
        );
        const diffChanges = evidence.preparationChanges;
        assert.deepEqual(diffChanges, capsuleChanges);
        assert.ok(
          input.capsule.graphContext.currentDiff?.text.includes(
            "generated by preparation",
          ),
        );
        assert.ok(evidence.diff.text.includes("generated by preparation"));
        assert.ok(evidence.diff.bytes > 0);

        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), `${filePath}\n`);
        const finalized = await input.tools.finalize({
          commitPaths: [preparationPath, filePath],
          summary: "Commit the prepared build identity with the task output.",
        });
        assert.equal(finalized.validated, true);
        assert.deepEqual(
          [...finalized.changedPaths].sort(),
          [filePath, preparationPath].sort(),
        );
        return { status: "settled", sessionId: "prepared-task-session" };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(sessions, 1);
    assert.equal(result.tasks[0]!.attempt, 1);
    assert.equal(
      git(repo.workingDir, ["show", `HEAD:${preparationPath}`]),
      "generated by preparation",
    );
    assert.deepEqual(
      git(repo.workingDir, ["show", "--format=", "--name-only", "HEAD"])
        .split("\n")
        .filter(Boolean)
        .sort(),
      ["prepared-task.txt", preparationPath].sort(),
    );
    assert.deepEqual(result.cleanupCompleted(), []);
  } finally {
    repo.cleanup();
  }
});

test("omitted tracked preparation output stays pending until explicitly discarded", async () => {
  const repo = fixture({ trackedBuildIdentity: true });
  const preparationPath = "build-identity.ts";
  try {
    const task = graphTask("discard-prepared-task");
    let sessions = 0;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: ["prepare build identity"],
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "fork", branches: [{ kind: "task", taskId: task.id }] },
      async runCheck(input) {
        if (input.kind === "prepare") {
          fs.writeFileSync(
            path.join(input.workspaceRoot, preparationPath),
            "generated by preparation\n",
          );
        }
        return passingCheck();
      },
      async runSession(input) {
        sessions++;
        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), `${filePath}\n`);
        const headBeforeOmission = git(input.cwd, ["rev-parse", "HEAD"]);
        await assert.rejects(
          input.tools.finalize({
            commitPaths: [filePath],
            summary: "Try finalization without selecting prepared output.",
          }),
        );
        assert.equal(git(input.cwd, ["rev-parse", "HEAD"]), headBeforeOmission);
        assert.equal(
          fs.readFileSync(path.join(input.cwd, preparationPath), "utf8"),
          "generated by preparation\n",
        );
        assert.ok(
          git(input.cwd, ["status", "--porcelain"])
            .split("\n")
            .some((line) => line.endsWith(` ${preparationPath}`)),
        );

        const discardRequest = {
          commitPaths: [filePath],
          discardPaths: [preparationPath],
          summary:
            "Explicitly discard prepared output before committing the task.",
        };
        const finalized = await input.tools.finalize(discardRequest);
        assert.equal(finalized.validated, true);
        assert.equal(
          fs.readFileSync(path.join(input.cwd, preparationPath), "utf8"),
          "base\n",
        );
        return {
          status: "settled",
          sessionId: "discard-prepared-task-session",
        };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(sessions, 1);
    assert.equal(
      git(repo.workingDir, ["show", `HEAD:${preparationPath}`]),
      "base",
    );
    assert.deepEqual(
      git(repo.workingDir, ["show", "--format=", "--name-only", "HEAD"])
        .split("\n")
        .filter(Boolean),
      ["discard-prepared-task.txt"],
    );
    assert.equal(git(repo.workingDir, ["status", "--porcelain"]), "");
    assert.deepEqual(result.cleanupCompleted(), []);
  } finally {
    repo.cleanup();
  }
});

test("baseline failure reaches recovery without granting acceptance", async () => {
  const repo = fixture();
  try {
    const task = graphTask("blocked-task");
    let sessions = 0;
    let checks = 0;
    const head = git(repo.workingDir, ["rev-parse", "HEAD"]);
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "task", taskId: task.id },
      async runCheck() {
        checks++;
        return {
          exitCode: 1,
          stdout: "",
          stderr: "dependency unavailable in sandbox",
        };
      },
      async runSession() {
        sessions++;
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(sessions, 3);
    assert.equal(checks, 1);
    assert.equal(result.tasks[0]!.attempt, 3);
    assert.equal(result.tasks[0]!.attempts.length, 3);
    assert.equal(result.tasks[0]!.checks[0]!.exitCode, 1);
    assert.ok(result.error);
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), head);
  } finally {
    repo.cleanup();
  }
});

test("local failure blocks its subtree while a sibling starts its next task", async () => {
  const repo = fixture();
  const siblingStarted = barrier();
  const failureSettled = barrier();
  const a = graphTask("a-fails");
  const blocked = graphTask("a-blocked");
  const b = graphTask("b-first");
  const next = graphTask("b-next");
  const launched: string[] = [];
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([a, blocked, b, next]),
      tree: {
        kind: "fork",
        branches: [
          {
            kind: "sequence",
            steps: [
              { kind: "task", taskId: a.id },
              { kind: "task", taskId: blocked.id },
            ],
          },
          {
            kind: "sequence",
            steps: [
              { kind: "task", taskId: b.id },
              { kind: "task", taskId: next.id },
            ],
          },
        ],
      },
      runCheck: async () => passingCheck(),
      onSnapshot(snapshot) {
        if (
          snapshot.tasks.some(
            (task) => task.id === a.id && task.status === "failed",
          )
        )
          failureSettled.resolve();
      },
      async runSession(input) {
        const id = input.task!.id;
        launched.push(id);
        if (id === a.id) {
          await siblingStarted.promise;
          return { status: "failed", error: "local failure" };
        }
        if (id === b.id) {
          siblingStarted.resolve();
          await failureSettled.promise;
        }
        fs.writeFileSync(path.join(input.cwd, `${id}.txt`), id);
        await input.tools.finalize({ commitPaths: [`${id}.txt`], summary: id });
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "failed");
    assert.ok(launched.includes(next.id));
    assert.ok(!launched.includes(blocked.id));
    assert.ok(result.blockedTasks?.some(({ taskId }) => taskId === blocked.id));
    assert.equal(result.joins[0]!.status, "failed");
  } finally {
    repo.cleanup();
  }
});

for (const cancel of [false, true]) {
  test(`AUD-001 nested lifecycle throw ${cancel ? "still honors global cancellation" : "does not stop a later independent task"}`, async () => {
    const repo = fixture();
    const siblingStarted = barrier();
    const failureSettled = barrier();
    const controller = new AbortController();
    const start = graphTask("a-start");
    const left = graphTask("a-left", [start.id]);
    const right = graphTask("a-right", [start.id]);
    const blocked = graphTask("a-after", [left.id, right.id]);
    const first = graphTask("b-first");
    const next = graphTask("b-next", [first.id]);
    const launched: string[] = [];
    try {
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        canonicalPlan,
        graph: graph([start, left, right, blocked, first, next]),
        tree: {
          kind: "fork",
          branches: [
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: start.id },
                {
                  kind: "fork",
                  branches: [
                    { kind: "task", taskId: left.id },
                    { kind: "task", taskId: right.id },
                  ],
                },
                { kind: "task", taskId: blocked.id },
              ],
            },
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: first.id },
                { kind: "task", taskId: next.id },
              ],
            },
          ],
        },
        signal: controller.signal,
        runCheck: async () => passingCheck(),
        onSnapshot(snapshot) {
          if (
            snapshot.branches.some(
              (branch) =>
                branch.firstTaskId === start.id && branch.status === "failed",
            )
          ) {
            if (cancel) controller.abort();
            failureSettled.resolve();
          }
        },
        async runSession(input) {
          const id = input.task!.id;
          launched.push(id);
          if (id === first.id) {
            siblingStarted.resolve();
            await failureSettled.promise;
            if (input.signal.aborted) return { status: "cancelled" };
          }
          fs.writeFileSync(path.join(input.cwd, `${id}.txt`), id);
          await input.tools.finalize({
            commitPaths: [`${id}.txt`],
            summary: id,
          });
          if (id === start.id) {
            await siblingStarted.promise;
            // Existing worktrees remain writable; only creation of another
            // nested worktree fails with a real local filesystem error.
            fs.chmodSync(path.join(repo.worktreeRoot, repo.runId), 0o555);
          }
          return { status: "settled" };
        },
      });
      assert.equal(result.status, cancel ? "cancelled" : "failed");
      assert.match(result.error!, /Permission denied/);
      assert.ok(!launched.includes(left.id));
      assert.ok(!launched.includes(right.id));
      assert.ok(!launched.includes(blocked.id));
      assert.ok(
        result.blockedTasks?.some(({ taskId }) => taskId === blocked.id),
      );
      assert.equal(result.joins[0]!.status, cancel ? "cancelled" : "failed");
      assert.equal(
        result.tasks.find(({ id }) => id === first.id)!.status,
        cancel ? "cancelled" : "validated",
      );
      assert.equal(launched.includes(next.id), !cancel);
      if (!cancel)
        assert.equal(
          result.tasks.find(({ id }) => id === next.id)!.status,
          "validated",
        );
    } finally {
      fs.chmodSync(path.join(repo.worktreeRoot, repo.runId), 0o755);
      repo.cleanup();
    }
  });
}

for (const mode of [
  "typed-local",
  "unknown",
  "ownership",
  "persistence",
] as const) {
  test(`AUD-001 nested ${mode} boundary drains active siblings and scopes launches`, async () => {
    const repo = fixture();
    const siblingStarted = barrier();
    const failureObserved = barrier();
    const start = graphTask("a-start");
    const left = graphTask("a-left", [start.id]);
    const right = graphTask("a-right", [start.id]);
    const blocked = graphTask("a-after", [left.id, right.id]);
    const first = graphTask("b-first");
    const next = graphTask("b-next", [first.id]);
    const launched: string[] = [];
    let injected = false;
    let siblingSettled = false;
    let persistenceFailed = false;
    let snapshots = 0;
    const message = `${mode}: worktree allocation permission denied`;
    try {
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        canonicalPlan,
        graph: graph([start, left, right, blocked, first, next]),
        tree: {
          kind: "fork",
          branches: [
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: start.id },
                {
                  kind: "fork",
                  branches: [
                    { kind: "task", taskId: left.id },
                    { kind: "task", taskId: right.id },
                  ],
                },
                { kind: "task", taskId: blocked.id },
              ],
            },
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: first.id },
                { kind: "task", taskId: next.id },
              ],
            },
          ],
        },
        runCheck: async () => passingCheck(),
        onSnapshot(snapshot) {
          snapshots++;
          if (
            mode !== "ownership" &&
            !injected &&
            snapshot.branches.some((branch) => branch.firstTaskId === left.id)
          ) {
            injected = true;
            if (mode === "typed-local" || mode === "persistence")
              throw new FeatureSubtreeOperationError(
                message,
                "worktree-allocation",
              );
            // Neither matching text nor a serialized-looking tag grants local authority.
            throw Object.assign(new Error(message), {
              name: "FeatureSubtreeOperationError",
              operation: "worktree-allocation",
            });
          }
          if (
            snapshot.branches.some(
              (branch) =>
                branch.firstTaskId === start.id && branch.status === "failed",
            )
          ) {
            failureObserved.resolve();
            if (mode === "persistence" && !persistenceFailed) {
              // Fail the settlement observer itself, outside executeNode's catch.
              persistenceFailed = true;
              throw new Error(message);
            }
          }
        },
        async runSession(input) {
          const id = input.task!.id;
          launched.push(id);
          if (id === first.id) {
            siblingStarted.resolve();
            await failureObserved.promise;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          fs.writeFileSync(path.join(input.cwd, `${id}.txt`), id);
          await input.tools.finalize({
            commitPaths: [`${id}.txt`],
            summary: id,
          });
          if (id === start.id) {
            await siblingStarted.promise;
            if (mode === "ownership")
              git(input.cwd, ["checkout", "-b", "unauthorized-branch"]);
          }
          if (id === first.id) siblingSettled = true;
          return { status: "settled" };
        },
      });
      assert.equal(result.status, "failed");
      if (mode === "ownership") assert.match(result.error!, /branch drift/);
      else assert.equal(result.error, message);
      assert.equal(siblingSettled, true);
      assert.equal(launched.includes(next.id), mode === "typed-local");
      assert.ok(!launched.includes(left.id));
      assert.ok(!launched.includes(right.id));
      assert.ok(!launched.includes(blocked.id));
      assert.ok(
        result.blockedTasks?.some(({ taskId }) => taskId === blocked.id),
      );
      assert.equal(
        result.tasks.find(({ id }) => id === first.id)!.status,
        "validated",
      );
      assert.equal(result.joins[0]!.status, "failed");
      const settledSnapshots = snapshots;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(snapshots, settledSnapshots);
    } finally {
      repo.cleanup();
    }
  });
}

test("accepted checkpoint ranges survive nested joins", async () => {
  const repo = fixture();
  const tasks = [
    graphTask("range-a"),
    graphTask("range-b"),
    graphTask("range-c"),
  ];
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph(tasks),
      tree: {
        kind: "fork",
        branches: [
          {
            kind: "fork",
            branches: tasks
              .slice(0, 2)
              .map(({ id }) => ({ kind: "task", taskId: id })),
          },
          { kind: "task", taskId: tasks[2]!.id },
        ],
      },
      runCheck: async () => passingCheck(),
      async runSession(input) {
        assert.ok(input.tools.stage);
        assert.ok(input.tools.checkpoint);
        const id = input.task!.id;
        for (let i = 0; i < 2; i++) {
          const file = `${id}-${i}.txt`;
          fs.writeFileSync(path.join(input.cwd, file), `${i}`);
          await input.tools.stage({ paths: [file], action: "stage" });
          await input.tools.checkpoint({ message: `${id} checkpoint ${i}` });
        }
        for (const check of [baselineCheck, ...input.task!.checks])
          await input.tools.check({ checkId: check.id });
        const finalized = await input.tools.finalize({ summary: id });
        assert.equal(
          finalized.validated,
          true,
          finalized.error ?? "acceptance failed",
        );
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.deepEqual(
      result.tasks.map((task) => task.commitRange?.commits.length),
      [2, 2, 2],
    );
    assert.equal(
      result.joins.find(({ id }) => id === "join-1")!.commits.length,
      6,
    );
    for (const task of tasks)
      for (let i = 0; i < 2; i++) {
        assert.equal(
          fs.readFileSync(
            path.join(repo.workingDir, `${task.id}-${i}.txt`),
            "utf8",
          ),
          `${i}`,
        );
      }
  } finally {
    repo.cleanup();
  }
});

test("preparation failure and generated baseline output can be repaired by the first session", async () => {
  const repo = fixture();
  const task = graphTask("repair-preparation");
  let generated = false;
  let sessions = 0;
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([task]),
      worktreePrepare: ["broken bootstrap"],
      tree: { kind: "fork", branches: [{ kind: "task", taskId: task.id }] },
      async runCheck(input) {
        if (input.command === "broken bootstrap")
          return {
            exitCode: 1,
            stdout: "bootstrap evidence",
            stderr: "unavailable",
          };
        if (input.command === baselineCheck.command && !generated) {
          generated = true;
          fs.writeFileSync(
            path.join(input.workspaceRoot, "generated.txt"),
            "generated\n",
          );
        }
        return passingCheck();
      },
      async runSession(input) {
        sessions++;
        assert.ok(input.tools.prepare);
        assert.ok(input.tools.stage);
        assert.ok(input.tools.checkpoint);
        assert.ok(input.capsule.graphContext.previousFailure);
        assert.equal(input.attempt, 1);
        const preparation = await input.tools.prepare({
          command: "repair bootstrap",
          cwd: ".",
          purpose: "Repair environment",
        });
        assert.equal(preparation.status, "passed");
        await input.tools.stage({ paths: ["generated.txt"], action: "stage" });
        await input.tools.checkpoint({ message: "Keep generated baseline" });
        for (const check of [baselineCheck, ...task.checks])
          await input.tools.check({ checkId: check.id });
        const finalized = await input.tools.finalize({
          summary: "Repaired preparation",
        });
        assert.equal(
          finalized.validated,
          true,
          finalized.error ?? "acceptance failed",
        );
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.equal(sessions, 1);
    assert.equal(
      result.branches[1]!.preparation.commands![0]!.stdout,
      "bootstrap evidence",
    );
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "generated.txt"), "utf8"),
      "generated\n",
    );
  } finally {
    repo.cleanup();
  }
});

for (const repairPasses of [false, true]) {
  test(`root preparation replacement is inherited only when successful (${repairPasses})`, async () => {
    const repo = fixture();
    const rootTask = graphTask("repair-root");
    const children = [
      graphTask("child-a", [rootTask.id]),
      graphTask("child-b", [rootTask.id]),
    ];
    const original = "broken bootstrap";
    const corrected = "corrected bootstrap";
    const recipe = ["prepare before", original, "prepare after"];
    const callerRecipe = [...recipe];
    const calls = new Map<string, string[]>();
    try {
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        worktreePrepare: recipe,
        canonicalPlan,
        graph: graph([rootTask, ...children]),
        tree: {
          kind: "sequence",
          steps: [
            { kind: "task", taskId: rootTask.id },
            {
              kind: "fork",
              branches: children.map((task) => ({
                kind: "task",
                taskId: task.id,
              })),
            },
          ],
        },
        async runCheck(input) {
          if (input.kind === "prepare") {
            const commands = calls.get(input.workspaceRoot) ?? [];
            commands.push(input.command);
            calls.set(input.workspaceRoot, commands);
            if (
              input.command === original ||
              (input.command === corrected && !repairPasses)
            )
              return {
                exitCode: 1,
                stdout: "",
                stderr: "bootstrap unavailable",
              };
          }
          return passingCheck();
        },
        async runSession(input) {
          if (input.task!.id === rootTask.id) {
            // The caller root is already prepared: an explicit repair needs no prior attempt.
            assert.equal(calls.has(input.cwd), false);
            assert.ok(input.tools.prepare);
            const repair = await input.tools.prepare({
              command: corrected,
              cwd: ".",
              purpose: "Repair bootstrap",
              replacesCommand: original,
            });
            assert.equal(repair.status, repairPasses ? "passed" : "failed");
            assert.equal(repair.exitCode, repairPasses ? 0 : 1);
            assert.equal(repair.replacesCommand, original);
          }
          const file = `${input.task!.id}.txt`;
          fs.writeFileSync(path.join(input.cwd, file), "done\n");
          const accepted = await input.tools.finalize({
            commitPaths: [file],
            summary: "Accept task",
          });
          assert.equal(
            accepted.validated,
            true,
            accepted.error ?? "acceptance failed",
          );
          return { status: "settled" };
        },
      });
      assert.equal(result.status, "completed", result.error ?? "graph failed");
      assert.deepEqual(recipe, callerRecipe);
      assert.deepEqual(calls.get(repo.workingDir), [corrected]);
      const childCalls = [...calls].filter(([cwd]) => cwd !== repo.workingDir);
      assert.equal(childCalls.length, 2);
      for (const [, commands] of childCalls)
        assert.deepEqual(
          commands,
          repairPasses
            ? [recipe[0], corrected, recipe[2]]
            : [recipe[0], original],
        );
      const preparation = result.tasks.find(
        ({ id }) => id === rootTask.id,
      )!.preparations!;
      assert.equal(preparation.length, 1);
      assert.equal(preparation[0]!.status, repairPasses ? "passed" : "failed");
      assert.equal(preparation[0]!.replacesCommand, original);
    } finally {
      repo.cleanup();
    }
  });
}

for (const acceptedRepair of [false, true]) {
  test(`branch-local preparation replacement does not rewrite independent siblings (${acceptedRepair})`, async () => {
    const repo = fixture();
    const repairTask = graphTask("local-repair");
    const descendant = graphTask("local-child", [repairTask.id]);
    const sibling = graphTask("independent-root");
    const siblingChild = graphTask("independent-child", [sibling.id]);
    const repairSettled = barrier();
    const original = "original bootstrap";
    const corrected = "local corrected bootstrap";
    const recipe = ["prepare before", original, "prepare after"];
    const calls = new Map<string, string[]>();
    const taskCwds = new Map<string, string>();
    try {
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        worktreePrepare: recipe,
        canonicalPlan,
        graph: graph([repairTask, descendant, sibling, siblingChild]),
        tree: {
          kind: "fork",
          branches: [
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: repairTask.id },
                {
                  kind: "fork",
                  branches: [{ kind: "task", taskId: descendant.id }],
                },
              ],
            },
            {
              kind: "sequence",
              steps: [
                { kind: "task", taskId: sibling.id },
                {
                  kind: "fork",
                  branches: [{ kind: "task", taskId: siblingChild.id }],
                },
              ],
            },
          ],
        },
        async runCheck(input) {
          if (input.kind === "prepare") {
            const commands = calls.get(input.workspaceRoot) ?? [];
            commands.push(input.command);
            calls.set(input.workspaceRoot, commands);
          }
          return passingCheck();
        },
        async runSession(input) {
          const id = input.task!.id;
          taskCwds.set(id, input.cwd);
          if (id === sibling.id) await repairSettled.promise;
          if (id === repairTask.id) {
            if (input.attempt === 1) {
              assert.ok(input.tools.prepare);
              const repair = await input.tools.prepare({
                command: corrected,
                cwd: ".",
                purpose: "Repair local bootstrap",
                replacesCommand: original,
              });
              assert.equal(repair.status, "passed");
            }
            if (!acceptedRepair) {
              repairSettled.resolve();
              return { status: "settled" };
            }
          }
          const file = `${id}.txt`;
          fs.writeFileSync(path.join(input.cwd, file), "done\n");
          const accepted = await input.tools.finalize({
            commitPaths: [file],
            summary: "Accept branch task",
          });
          assert.equal(
            accepted.validated,
            true,
            accepted.error ?? "acceptance failed",
          );
          if (id === repairTask.id) repairSettled.resolve();
          return { status: "settled" };
        },
      });
      assert.equal(
        result.status,
        acceptedRepair ? "completed" : "failed",
        result.error ?? "graph failed",
      );
      assert.deepEqual(recipe, ["prepare before", original, "prepare after"]);
      assert.deepEqual(calls.get(taskCwds.get(sibling.id)!), recipe);
      assert.deepEqual(calls.get(taskCwds.get(siblingChild.id)!), recipe);
      const repaired = result.tasks.find(({ id }) => id === repairTask.id)!;
      assert.equal(repaired.preparations![0]!.status, "passed");
      if (acceptedRepair) {
        assert.deepEqual(calls.get(taskCwds.get(descendant.id)!), [
          recipe[0],
          corrected,
          recipe[2],
        ]);
      } else {
        assert.equal(taskCwds.has(descendant.id), false);
        assert.equal(repaired.status, "failed");
        assert.equal(
          [...calls.values()].flat().filter((command) => command === corrected)
            .length,
          1,
        );
      }
    } finally {
      repairSettled.resolve();
      repo.cleanup();
    }
  });
}

for (const mode of [
  "retry",
  "blocked",
  "malformed",
  "cancel",
  "absent",
  "cap",
  "success",
] as const) {
  test(`planner recovery is bounded and preserves runtime: ${mode}`, async () => {
    const repo = fixture();
    const task = graphTask("planner-recovery");
    const abort = new AbortController();
    const hosts = new Set<unknown>();
    const worktrees = new Set<string>();
    let calls = 0;
    let consultations = 0;
    try {
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        canonicalPlan,
        graph: graph([task]),
        tree: { kind: "task", taskId: task.id },
        signal: abort.signal,
        runCheck: async () => passingCheck(),
        requestPlannerRecovery:
          mode === "absent"
            ? undefined
            : async (request, signal) => {
                consultations++;
                assert.equal(request.taskId, task.id);
                assert.equal(request.attempt, calls);
                assert.equal(request.remainingAttempts, 24 - calls);
                assert.equal(
                  request.currentHead,
                  git(repo.workingDir, ["rev-parse", "HEAD"]),
                );
                assert.equal(signal.aborted, false);
                if (mode === "cancel") abort.abort();
                return {
                  schemaVersion: 1,
                  taskId: mode === "malformed" ? "wrong-task" : task.id,
                  attempt: request.attempt,
                  action: mode === "blocked" ? "blocked" : "retry",
                  message: "Inspect the missing acceptance evidence",
                };
              },
        async runSession(input) {
          calls++;
          assert.equal(input.attempt, calls);
          hosts.add(input.tools);
          worktrees.add(input.cwd);
          if (mode === "success" && consultations) {
            assert.ok(input.capsule.graphContext.previousFailure);
            fs.writeFileSync(path.join(input.cwd, "recovered.txt"), "done\n");
            const finalized = await input.tools.finalize({
              commitPaths: ["recovered.txt"],
              summary: "Recovered with verified evidence",
            });
            assert.equal(finalized.validated, true);
          }
          if (mode === "cap" && consultations) {
            fs.writeFileSync(
              path.join(input.cwd, "shared.txt"),
              `progress ${calls}\n`,
            );
          }
          return { status: "settled", sessionId: "same-session" };
        },
      });
      assert.equal(
        result.status,
        mode === "cancel"
          ? "cancelled"
          : mode === "success"
            ? "completed"
            : "failed",
      );
      assert.equal(consultations, mode === "absent" ? 0 : 1);
      assert.equal(
        calls,
        mode === "cap" ? 24 : mode === "retry" ? 6 : mode === "success" ? 4 : 3,
      );
      assert.equal(hosts.size, 1);
      assert.equal(worktrees.size, 1);
      assert.equal(result.tasks[0]!.attempts.length, calls);
    } finally {
      repo.cleanup();
    }
  });
}

test("planner blocked keeps dependents blocked while independent branches complete", async () => {
  const repo = fixture();
  const failing = graphTask("planner-blocked");
  const dependent = graphTask("dependent", [failing.id]);
  const independent = graphTask("independent");
  const started: string[] = [];
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([failing, dependent, independent]),
      tree: {
        kind: "fork",
        branches: [
          {
            kind: "sequence",
            steps: [
              { kind: "task", taskId: failing.id },
              { kind: "task", taskId: dependent.id },
            ],
          },
          { kind: "task", taskId: independent.id },
        ],
      },
      runCheck: passingCheck,
      async requestPlannerRecovery(request) {
        return {
          schemaVersion: 1,
          taskId: request.taskId,
          attempt: request.attempt,
          action: "blocked",
          message: "Needs user input",
        };
      },
      async runSession(input) {
        started.push(input.task!.id);
        if (input.task!.id === independent.id) {
          fs.writeFileSync(path.join(input.cwd, "independent.txt"), "done\n");
          await input.tools.finalize({
            commitPaths: ["independent.txt"],
            summary: "Independent work",
          });
        }
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(started.includes(dependent.id), false);
    assert.equal(
      result.tasks.find((task) => task.id === independent.id)?.status,
      "validated",
    );
    assert.equal(
      result.tasks.find((task) => task.id === failing.id)?.attempts.length,
      3,
    );
  } finally {
    repo.cleanup();
  }
});

test("persistent recovery has a total ceiling even with continuous factual changes", async () => {
  const repo = fixture();
  const task = graphTask("bounded-progress");
  const hosts = new Set<unknown>();
  const roles = new Set<string>();
  let calls = 0;
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "task", taskId: task.id },
      now: () => 0,
      runCheck: async () => passingCheck(),
      async runSession(input) {
        calls++;
        hosts.add(input.tools);
        roles.add(input.role);
        fs.writeFileSync(
          path.join(input.cwd, "shared.txt"),
          `progress ${calls}\n`,
        );
        return { status: "settled", sessionId: "persistent-session" };
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(calls, 24);
    assert.equal(hosts.size, 1);
    assert.equal(roles.size, 1);
    assert.equal(result.tasks[0]!.attempts.length, 24);
  } finally {
    repo.cleanup();
  }
});

test("environment-only join repair accepts an empty range", async () => {
  const repo = fixture();
  const task = graphTask("environment-child");
  let repaired = false;
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([task]),
      tree: { kind: "fork", branches: [{ kind: "task", taskId: task.id }] },
      async runCheck(input) {
        if (input.command === "repair environment") repaired = true;
        if (input.workspaceRoot === repo.workingDir && !repaired)
          return { exitCode: 1, stdout: "", stderr: "environment unavailable" };
        return passingCheck();
      },
      async runSession(input) {
        if (input.kind === "task") {
          fs.writeFileSync(
            path.join(input.cwd, "environment-child.txt"),
            "child",
          );
          await input.tools.finalize({
            commitPaths: ["environment-child.txt"],
            summary: "Child",
          });
        } else {
          assert.ok(input.tools.prepare);
          await input.tools.prepare({
            command: "repair environment",
            cwd: ".",
            purpose: "Repair environment",
          });
          await input.tools.check({ checkId: baselineCheck.id });
          const finalized = await input.tools.finalize({
            summary: "Environment repaired",
          });
          assert.equal(
            finalized.validated,
            true,
            finalized.error ?? "acceptance failed",
          );
        }
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.deepEqual(
      result.tasks.find(({ kind }) => kind === "join-repair")!.commitRange!
        .commits,
      [],
    );
    assert.equal(result.joins[0]!.status, "completed");
  } finally {
    repo.cleanup();
  }
});

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}

function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const validates of [false, true]) {
  test(`baseline failure lets an active sibling settle (${validates ? "validated" : "provisional"}) without a new attempt`, async () => {
    const repo = fixture();
    const started = barrier();
    const stopped = barrier();
    const blocked = graphTask("blocked-branch");
    const active = graphTask("active-branch");
    let sessions = 0;
    let lateCheck: (() => Promise<unknown>) | undefined;
    try {
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        canonicalPlan,
        graph: graph([blocked, active]),
        tree: {
          kind: "fork",
          branches: [
            { kind: "task", taskId: blocked.id },
            { kind: "task", taskId: active.id },
          ],
        },
        onSnapshot(snapshot) {
          if (
            snapshot.tasks.some(
              (task) => task.id === blocked.id && task.status === "failed",
            )
          )
            stopped.resolve();
        },
        async runCheck(input) {
          if (
            input.command === baselineCheck.command &&
            path.basename(input.workspaceRoot).endsWith(blocked.id)
          ) {
            await started.promise;
            return { exitCode: 1, stdout: "", stderr: "blocked baseline" };
          }
          if (input.command === active.checks[0]!.command && !validates)
            return { exitCode: 1, stdout: "", stderr: "task needs repair" };
          return passingCheck();
        },
        async runSession(input) {
          if (input.task!.id === blocked.id)
            return { status: "failed", error: "blocked baseline" };
          assert.equal(input.task!.id, active.id);
          sessions++;
          started.resolve();
          await stopped.promise;
          assert.equal(input.signal.aborted, false);
          lateCheck = () => input.tools.check({ checkId: baselineCheck.id });
          fs.writeFileSync(
            path.join(input.cwd, `${active.id}.txt`),
            "implementation\n",
          );
          await input.tools.finalize({
            commitPaths: [`${active.id}.txt`],
            summary: "Settle the session that was already active.",
          });
          return { status: "settled", sessionId: "active-attempt-1" };
        },
      });
      assert.equal(result.status, "failed");
      assert.match(result.error!, /blocked baseline/);
      assert.equal(sessions, validates ? 1 : 4);
      const task = result.tasks.find(({ id }) => id === active.id)!;
      assert.equal(task.status, validates ? "validated" : "failed");
      assert.equal(task.attempt, validates ? 1 : 4);
      assert.ok(task.provisionalCommit);
      if (!validates) assert.ok(task.error);
      assert.ok(lateCheck);
      await assert.rejects(lateCheck(), /authority is closed/);
    } finally {
      repo.cleanup();
    }
  });
}

test("cancellation prevents late finalization and preserves the factual task state", async () => {
  const repo = fixture();
  try {
    const task = graphTask("cancel-task");
    const executionGraph = graph([task], []);
    const tree = { kind: "task", taskId: task.id } satisfies ExecutionTree;
    const controller = new AbortController();
    const base = git(repo.workingDir, ["rev-parse", "HEAD"]);
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      signal: controller.signal,
      runCheck: passingCheck,
      async runSession(input) {
        fs.writeFileSync(path.join(input.cwd, "cancel-task.txt"), "late\n");
        controller.abort();
        await assert.rejects(
          input.tools.finalize({
            commitPaths: ["cancel-task.txt"],
            summary: "This finalization is too late.",
          }),
          /cancelled/,
        );
        return { status: "cancelled", sessionId: "cancelled-session" };
      },
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.tasks[0]!.status, "cancelled");
    assert.equal(result.tasks[0]!.attempts[0]!.sessionId, "cancelled-session");
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), base);
    assert.equal(
      fs.existsSync(path.join(repo.workingDir, "cancel-task.txt")),
      true,
    );
  } finally {
    repo.cleanup();
  }
});

test("join verification cancellation records a terminal join without mutating caller state", async () => {
  const repo = fixture();
  const controller = new AbortController();
  const joinCheckStarted = barrier();
  const releaseJoinCheck = barrier();
  const left = graphTask("cancel-left");
  const right = graphTask("cancel-right");
  let joinCheckCalls = 0;
  const callerBranch = git(repo.workingDir, [
    "symbolic-ref",
    "--short",
    "HEAD",
  ]);
  const execution = executeFeatureGraph({
    runId: repo.runId,
    workingDir: repo.workingDir,
    worktreeRoot: repo.worktreeRoot,
    canonicalPlan,
    graph: graph([left, right]),
    tree: {
      kind: "fork",
      branches: [
        { kind: "task", taskId: left.id },
        { kind: "task", taskId: right.id },
      ],
    } satisfies ExecutionTree,
    signal: controller.signal,
    async runCheck(input) {
      if (input.workspaceRoot === repo.workingDir) {
        assert.equal(input.kind, "check");
        joinCheckCalls += 1;
        joinCheckStarted.resolve();
        await releaseJoinCheck.promise;
      }
      return passingCheck();
    },
    async runSession(input) {
      const filePath = `${input.task!.id}.txt`;
      fs.writeFileSync(path.join(input.cwd, filePath), `${input.task!.id}\n`);
      const finalized = await input.tools.finalize({
        commitPaths: [filePath],
        summary: `Finalize ${input.task!.id} before joining.`,
      });
      assert.equal(finalized.validated, true);
      return { status: "settled", sessionId: `synthetic-${input.task!.id}` };
    },
  });
  try {
    await joinCheckStarted.promise;
    const callerHead = git(repo.workingDir, ["rev-parse", "HEAD"]);
    const callerRef = git(repo.workingDir, [
      "rev-parse",
      `refs/heads/${callerBranch}`,
    ]);
    const ownedRefs = git(repo.workingDir, [
      "for-each-ref",
      "--format=%(refname)=%(objectname)",
      `refs/heads/pipi-feature/${repo.runId}`,
    ]);
    controller.abort();
    releaseJoinCheck.resolve();
    const result = await execution;

    assert.equal(result.status, "cancelled");
    assert.equal(joinCheckCalls, 1);
    assert.equal(result.joins.length, 1);
    const join = result.joins[0]!;
    assert.equal(join.commits.length, 2);
    assert.equal(join.status, "cancelled");
    assert.ok(join.error);
    assert.match(join.error, /cancelled/i);
    assert.ok(join.error.length <= 16 * 1024);
    assert.equal(
      result.branches.find(({ id }) => id === "root")?.status,
      "cancelled",
    );
    assert.equal(
      result.tasks.every(({ status }) => status === "validated"),
      true,
    );
    assert.equal(
      result.branches
        .filter(({ id }) => id !== "root")
        .every(({ status }) => status === "completed"),
      true,
    );
    assert.equal(
      git(repo.workingDir, ["symbolic-ref", "--short", "HEAD"]),
      callerBranch,
    );
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), callerHead);
    assert.equal(
      git(repo.workingDir, ["rev-parse", `refs/heads/${callerBranch}`]),
      callerRef,
    );
    assert.equal(
      git(repo.workingDir, [
        "for-each-ref",
        "--format=%(refname)=%(objectname)",
        `refs/heads/pipi-feature/${repo.runId}`,
      ]),
      ownedRefs,
    );
    assert.equal(
      result.branches
        .filter(({ id }) => id !== "root")
        .every(({ worktree }) => fs.existsSync(worktree)),
      true,
    );
  } finally {
    repo.cleanup();
  }
});

test("bounded no-progress recovery lets an active sibling settle and retains diagnostic branches", async () => {
  const repo = fixture();
  try {
    const failing = graphTask("failing-branch");
    const independent = graphTask("independent-branch");
    const executionGraph = graph([failing, independent]);
    const tree = {
      kind: "fork",
      branches: [
        { kind: "task", taskId: failing.id },
        { kind: "task", taskId: independent.id },
      ],
    } satisfies ExecutionTree;
    let independentStarted = () => {};
    const siblingActive = new Promise<void>((resolve) => {
      independentStarted = resolve;
    });
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      runCheck: passingCheck,
      async runSession(input) {
        if (input.task!.id === failing.id) {
          await siblingActive;
          return {
            status: "failed",
            sessionId: `failure-${input.attempt}`,
            error: `attempt ${input.attempt} failed`,
          };
        }
        independentStarted();
        fs.writeFileSync(
          path.join(input.cwd, "independent-branch.txt"),
          "completed\n",
        );
        await input.tools.finalize({
          commitPaths: ["independent-branch.txt"],
          summary: "The independent active branch settled successfully.",
        });
        return { status: "settled", sessionId: "independent-session" };
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(
      result.tasks.find(({ id }) => id === failing.id)?.attempts.length,
      3,
    );
    assert.equal(
      result.tasks.find(({ id }) => id === independent.id)?.status,
      "validated",
    );
    assert.equal(
      git(repo.workingDir, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/pipi-feature/${repo.runId}`,
      ])
        .split("\n")
        .filter(Boolean).length,
      2,
    );
    assert.equal(
      result.branches
        .filter(({ id }) => id !== "root")
        .every(({ worktree }) => fs.existsSync(worktree)),
      true,
    );
  } finally {
    repo.cleanup();
  }
});

test("cleanup residual warnings remain observable without invalidating a verified commit", async () => {
  const repo = fixture();
  try {
    const task = graphTask("warning-task");
    const executionGraph = graph([task], []);
    const tree = { kind: "task", taskId: task.id } satisfies ExecutionTree;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      runCheck: passingCheck,
      async runSession(input) {
        fs.writeFileSync(path.join(input.cwd, "warning-task.txt"), "done\n");
        fs.mkdirSync(path.join(input.cwd, "retained"));
        for (let index = 0; index < 2_050; index++) {
          fs.writeFileSync(
            path.join(input.cwd, "retained", `file-${index}`),
            "diagnostic\n",
          );
        }
        const finalized = await input.tools.finalize({
          commitPaths: ["warning-task.txt"],
          summary: "Implemented while retaining a diagnostic cleanup residual.",
        });
        assert.equal(finalized.validated, true);
        assert.equal(
          finalized.residualPaths.some((filePath) =>
            filePath.startsWith("retained/"),
          ),
          true,
        );
        return { status: "settled", sessionId: "warning-task-session" };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.tasks[0]!.status, "validated");
    assert.equal(
      result.warnings.length > 0,
      true,
      JSON.stringify(result.tasks[0]),
    );
    assert.equal(
      result.residualPaths.some((filePath) => filePath.startsWith("retained/")),
      true,
    );
  } finally {
    repo.cleanup();
  }
});

for (const mutation of [
  "none",
  "changed",
  "staged",
  "arbitrary",
  "arbitrary-prebegin",
] as const) {
  test(`AUD-003 graph residual handoff to final review: ${mutation}`, async () => {
    const repo = fixture();
    const output = path.join(repo.workingDir, "retained.txt");
    try {
      const task = graphTask("residual-source");
      const executionGraph = graph([task]);
      const result = await executeFeatureGraph({
        runId: repo.runId,
        workingDir: repo.workingDir,
        worktreeRoot: repo.worktreeRoot,
        canonicalPlan,
        graph: executionGraph,
        tree: { kind: "task", taskId: task.id },
        runCheck: passingCheck,
        async runSession(input) {
          assert.equal(input.cwd, repo.workingDir);
          fs.writeFileSync(path.join(input.cwd, `${task.id}.txt`), "done\n");
          fs.writeFileSync(output, "retained\n");
          // Prevent only deletion in this disposable directory during commit
          // cleanup; Git metadata remains writable in the linked worktree.
          fs.chmodSync(input.cwd, 0o500);
          try {
            const finalized = await input.tools.finalize({
              commitPaths: [`${task.id}.txt`],
              summary: "Commit selected output while retaining failed cleanup.",
            });
            assert.equal(finalized.validated, true);
            assert.ok(finalized.residualPaths.includes("retained.txt"));
          } finally {
            fs.chmodSync(input.cwd, 0o700);
          }
          return { status: "settled", sessionId: task.id };
        },
      });
      assert.equal(result.status, "completed", result.error ?? "graph failed");
      assert.equal(result.tasks[0]!.status, "validated");
      assert.ok(result.rootResidualPaths?.includes("retained.txt"));
      assert.deepEqual(
        result.rootUntrackedResiduals?.map((record) => record.path),
        ["retained.txt"],
      );
      assert.equal(fs.readFileSync(output, "utf8"), "retained\n");
      const head = git(repo.workingDir, ["rev-parse", "HEAD"]);
      const review = createFeatureReviewRuntime({
        runId: repo.runId,
        workingDir: repo.workingDir,
        checks: executionGraph.reviewChecks,
        runCheck: passingCheck,
        knownResidualPaths: result.rootResidualPaths,
        knownTrackedResiduals: result.rootTrackedResiduals,
        knownUntrackedResiduals: result.rootUntrackedResiduals,
      });
      if (mutation === "arbitrary-prebegin")
        fs.writeFileSync(path.join(repo.workingDir, "dirt.txt"), "dirt\n");
      review.begin(head);
      if (mutation === "changed") fs.appendFileSync(output, "changed\n");
      if (mutation === "staged") git(repo.workingDir, ["add", "retained.txt"]);
      if (mutation === "arbitrary")
        fs.writeFileSync(path.join(repo.workingDir, "dirt.txt"), "dirt\n");
      await review.host.check({ checkId: baselineCheck.id });
      if (mutation === "changed" || mutation === "staged") {
        await assert.rejects(
          review.host.finalize({ summary: "Final review" }),
          /residual changed/i,
        );
      } else {
        const acceptance = await review.host.finalize({
          summary: "Final review",
        });
        assert.equal(acceptance.validated, mutation === "none");
        if (mutation === "arbitrary-prebegin") {
          assert.match(acceptance.error ?? "", /dirt\.txt/);
          assert.equal(
            fs.readFileSync(path.join(repo.workingDir, "dirt.txt"), "utf8"),
            "dirt\n",
          );
        }
      }
      assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), head);
      assert.equal(
        fs.readFileSync(output, "utf8"),
        mutation === "changed" ? "retained\nchanged\n" : "retained\n",
      );
    } finally {
      fs.chmodSync(repo.workingDir, 0o700);
      repo.cleanup();
    }
  });
}

test("owned fork handoff recreates a clean prepared checkout and retains dirty diagnostics", async () => {
  const repo = fixture();
  try {
    const first = graphTask("handoff-source");
    const next = graphTask("handoff-next", [first.id]);
    const independent = graphTask("independent");
    const prepareCalls: string[] = [];
    const baselineCalls: string[] = [];
    const commits = new Map<string, string>();
    let originalPath = "";
    let originalBranch = "";
    let retainedPath = "";
    let nextObserved = false;
    let baselineBeforeHandoff = 0;
    // Ignore the cache repository-wide so both the old and replacement worktrees
    // share the rule without adding an unrelated accepted commit.
    fs.writeFileSync(
      path.join(repo.primary, ".git", "info", "exclude"),
      ".cache/\n",
    );
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: ["prepare fixture"],
      canonicalPlan,
      graph: graph([first, next, independent]),
      tree: {
        kind: "fork",
        branches: [
          {
            kind: "sequence",
            steps: [
              { kind: "task", taskId: first.id },
              { kind: "task", taskId: next.id },
            ],
          },
          { kind: "task", taskId: independent.id },
        ],
      },
      async runCheck(input) {
        if (input.kind === "prepare") prepareCalls.push(input.workspaceRoot);
        if (input.command === baselineCheck.command)
          baselineCalls.push(input.workspaceRoot);
        return passingCheck();
      },
      async runSession(input) {
        const taskId = input.task!.id;
        if (taskId === first.id) {
          originalPath = input.cwd;
          originalBranch = git(input.cwd, ["symbolic-ref", "HEAD"]);
          fs.mkdirSync(path.join(input.cwd, ".cache"));
          fs.writeFileSync(
            path.join(input.cwd, ".cache", "diagnostic"),
            "ignored cache\n",
          );
          fs.writeFileSync(
            path.join(input.cwd, "shared.txt"),
            "dirty diagnostic\n",
          );
        }
        if (taskId === next.id) {
          assert.equal(input.cwd, originalPath);
          assert.equal(
            git(input.cwd, ["symbolic-ref", "HEAD"]),
            originalBranch,
          );
          assert.equal(
            git(input.cwd, ["rev-parse", "HEAD"]),
            commits.get(first.id),
          );
          assert.equal(git(input.cwd, ["status", "--porcelain"]), "");
          assert.equal(
            fs.readFileSync(path.join(input.cwd, `${first.id}.txt`), "utf8"),
            `${first.id}\n`,
          );
          assert.equal(
            fs.readFileSync(path.join(input.cwd, "shared.txt"), "utf8"),
            "base\n",
          );
          assert.equal(fs.existsSync(path.join(input.cwd, ".cache")), false);
          assert.deepEqual((await input.tools.diff()).knownResidualPaths, []);
          assert.equal(
            prepareCalls.filter((cwd) => cwd === input.cwd).length,
            2,
          );
          assert.equal(
            baselineCalls.filter((cwd) => cwd === input.cwd).length,
            baselineBeforeHandoff + 1,
          );
          const retained = git(repo.primary, [
            "worktree",
            "list",
            "--porcelain",
          ])
            .split("\n\n")
            .find(
              (entry) =>
                entry.includes(`HEAD ${commits.get(first.id)}\n`) &&
                entry.includes("\ndetached"),
            );
          assert.ok(
            retained,
            "dirty diagnostic worktree must remain registered and detached",
          );
          retainedPath = retained.split("\n")[0]!.slice("worktree ".length);
          assert.notEqual(retainedPath, originalPath);
          assert.equal(
            fs.readFileSync(path.join(retainedPath, "shared.txt"), "utf8"),
            "dirty diagnostic\n",
          );
          assert.equal(
            fs.readFileSync(
              path.join(retainedPath, ".cache", "diagnostic"),
              "utf8",
            ),
            "ignored cache\n",
          );
          assert.equal(
            git(retainedPath, ["status", "--porcelain"]),
            "M shared.txt",
          );
          nextObserved = true;
        }
        fs.writeFileSync(path.join(input.cwd, `${taskId}.txt`), `${taskId}\n`);
        if (taskId === first.id) {
          // Existing cleanup-failure fixture: commit metadata remains writable,
          // but restoring the tracked diagnostic is deliberately denied.
          fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o400);
          fs.chmodSync(input.cwd, 0o500);
        }
        try {
          const finalized = await input.tools.finalize({
            commitPaths: [`${taskId}.txt`],
            summary: `Accepted ${taskId}.`,
          });
          assert.equal(finalized.validated, true);
          if (taskId === first.id)
            assert.ok(finalized.residualPaths.includes("shared.txt"));
          commits.set(taskId, git(input.cwd, ["rev-parse", "HEAD"]));
          if (taskId === first.id)
            baselineBeforeHandoff = baselineCalls.filter(
              (cwd) => cwd === input.cwd,
            ).length;
        } finally {
          if (taskId === first.id) {
            fs.chmodSync(input.cwd, 0o700);
            fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o600);
          }
        }
        return { status: "settled", sessionId: taskId };
      },
    });
    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.equal(nextObserved, true);
    assert.equal(prepareCalls.length, 3);
    assert.equal(commits.size, 3);
    assert.deepEqual(
      result.joins[0]!.commits.map(({ taskId }) => taskId),
      [first.id, next.id, independent.id],
    );
    for (const integrated of result.joins[0]!.commits) {
      assert.equal(integrated.sourceCommit, commits.get(integrated.taskId));
      assert.equal(
        git(repo.workingDir, [
          "show",
          `${integrated.integratedCommit}:${integrated.taskId}.txt`,
        ]),
        integrated.taskId,
      );
      git(repo.workingDir, [
        "merge-base",
        "--is-ancestor",
        integrated.integratedCommit,
        "HEAD",
      ]);
    }
    for (const task of [first, next, independent]) {
      assert.equal(
        fs.readFileSync(path.join(repo.workingDir, `${task.id}.txt`), "utf8"),
        `${task.id}\n`,
      );
    }
    assert.equal(
      git(repo.workingDir, ["rev-list", "--count", "HEAD~3..HEAD"]),
      "3",
    );
    assert.equal(git(repo.workingDir, ["status", "--porcelain"]), "");
    assert.deepEqual(result.rootResidualPaths, []);
    assert.equal(
      fs.readFileSync(path.join(retainedPath, "shared.txt"), "utf8"),
      "dirty diagnostic\n",
    );
    assert.equal(
      fs.readFileSync(path.join(retainedPath, ".cache", "diagnostic"), "utf8"),
      "ignored cache\n",
    );
  } finally {
    repo.cleanup();
  }
});

test("recorded tracked cleanup residuals survive a linear task and fork join", async () => {
  const repo = fixture();
  try {
    const first = graphTask("residual-source");
    const second = graphTask("linear-nochange", [first.id]);
    const left = graphTask("residual-left", [second.id]);
    const right = graphTask("residual-right", [second.id]);
    const executionGraph = graph([first, second, left, right]);
    const tree = {
      kind: "sequence",
      steps: [
        { kind: "task", taskId: first.id },
        { kind: "task", taskId: second.id },
        {
          kind: "fork",
          branches: [
            { kind: "task", taskId: left.id },
            { kind: "task", taskId: right.id },
          ],
        },
      ],
    } satisfies ExecutionTree;
    let observedInheritedResidual = false;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      runCheck: passingCheck,
      async runSession(input) {
        if (input.task!.id === first.id) {
          fs.writeFileSync(path.join(input.cwd, "shared.txt"), "retained\n");
          fs.writeFileSync(path.join(input.cwd, `${first.id}.txt`), "done\n");
          fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o400);
          fs.chmodSync(input.cwd, 0o500);
          try {
            const finalized = await input.tools.finalize({
              commitPaths: [`${first.id}.txt`],
              summary:
                "Committed the task while reporting failed tracked cleanup.",
            });
            assert.equal(finalized.validated, true);
            assert.ok(finalized.residualPaths.includes("shared.txt"));
          } finally {
            fs.chmodSync(input.cwd, 0o700);
            fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o600);
          }
          return { status: "settled", sessionId: first.id };
        }
        if (input.task!.id === second.id) {
          const evidence = await input.tools.diff();
          observedInheritedResidual =
            evidence.knownResidualPaths.includes("shared.txt");
          const finalized = await input.tools.finalize({
            commitPaths: [],
            summary: "Accepted the unchanged recorded cleanup residual.",
          });
          assert.equal(finalized.status, "satisfied_without_changes");
          return { status: "settled", sessionId: second.id };
        }
        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), "done\n");
        await input.tools.finalize({
          commitPaths: [filePath],
          summary: `Implemented ${input.task!.id} on its isolated branch.`,
        });
        return { status: "settled", sessionId: input.task!.id };
      },
    });

    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.equal(observedInheritedResidual, true);
    assert.ok(result.rootResidualPaths?.includes("shared.txt"));
    assert.equal(result.rootTrackedResiduals?.[0]?.path, "shared.txt");
    assert.ok(result.warnings.some((warning) => warning.includes("restore")));
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "shared.txt"), "utf8"),
      "retained\n",
    );
  } finally {
    fs.chmodSync(repo.workingDir, 0o700);
    repo.cleanup();
  }
});

test("same-path drift after a recorded cleanup residual fails closed", async () => {
  const repo = fixture();
  try {
    const first = graphTask("residual-before-drift");
    const second = graphTask("must-not-run", [first.id]);
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([first, second]),
      tree: {
        kind: "sequence",
        steps: [
          { kind: "task", taskId: first.id },
          { kind: "task", taskId: second.id },
        ],
      },
      runCheck: passingCheck,
      async runSession(input) {
        assert.equal(input.task!.id, first.id);
        fs.writeFileSync(path.join(input.cwd, "shared.txt"), "retained\n");
        fs.writeFileSync(path.join(input.cwd, `${first.id}.txt`), "done\n");
        fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o400);
        fs.chmodSync(input.cwd, 0o500);
        try {
          const finalized = await input.tools.finalize({
            commitPaths: [`${first.id}.txt`],
            summary: "Created the recorded tracked cleanup residual.",
          });
          assert.equal(finalized.validated, true);
        } finally {
          fs.chmodSync(input.cwd, 0o700);
          fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o600);
        }
        fs.appendFileSync(
          path.join(input.cwd, "shared.txt"),
          "external drift\n",
        );
        return { status: "settled", sessionId: first.id };
      },
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /recorded cleanup residual changed/i);
    assert.equal(
      result.tasks.find(({ id }) => id === second.id)?.status,
      "waiting",
    );
  } finally {
    fs.chmodSync(repo.workingDir, 0o700);
    repo.cleanup();
  }
});

test("restoring a recorded tracked residual to HEAD permits no-change finalization", async () => {
  const repo = fixture();
  try {
    const first = graphTask("residual-to-restore");
    const restore = graphTask("restore-residual", [first.id]);
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([first, restore]),
      tree: {
        kind: "sequence",
        steps: [
          { kind: "task", taskId: first.id },
          { kind: "task", taskId: restore.id },
        ],
      },
      runCheck: passingCheck,
      async runSession(input) {
        if (input.task!.id === first.id) {
          fs.writeFileSync(path.join(input.cwd, "shared.txt"), "retained\n");
          fs.writeFileSync(path.join(input.cwd, `${first.id}.txt`), "done\n");
          fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o400);
          fs.chmodSync(input.cwd, 0o500);
          try {
            await input.tools.finalize({
              commitPaths: [`${first.id}.txt`],
              summary: "Left one controller-recorded tracked cleanup residual.",
            });
          } finally {
            fs.chmodSync(input.cwd, 0o700);
            fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o600);
          }
          return { status: "settled", sessionId: first.id };
        }
        fs.writeFileSync(path.join(input.cwd, "shared.txt"), "base\n");
        const finalized = await input.tools.finalize({
          commitPaths: [],
          summary: "Restored the inherited residual exactly to HEAD.",
        });
        assert.equal(finalized.status, "satisfied_without_changes");
        return { status: "settled", sessionId: restore.id };
      },
    });

    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.deepEqual(result.rootResidualPaths, []);
    assert.deepEqual(result.rootTrackedResiduals, []);
    assert.ok(result.residualPaths.includes("shared.txt"));
    assert.ok(result.warnings.some((warning) => warning.includes("restore")));
    assert.equal(git(repo.workingDir, ["status", "--porcelain"]), "");
  } finally {
    fs.chmodSync(repo.workingDir, 0o700);
    repo.cleanup();
  }
});

test("a later task may explicitly commit a recorded residual path", async () => {
  const repo = fixture();
  try {
    const first = graphTask("residual-to-repair");
    const repair = graphTask("explicit-residual-repair", [first.id]);
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([first, repair]),
      tree: {
        kind: "sequence",
        steps: [
          { kind: "task", taskId: first.id },
          { kind: "task", taskId: repair.id },
        ],
      },
      runCheck: passingCheck,
      async runSession(input) {
        if (input.task!.id === first.id) {
          fs.writeFileSync(path.join(input.cwd, "shared.txt"), "retained\n");
          fs.writeFileSync(path.join(input.cwd, `${first.id}.txt`), "done\n");
          fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o400);
          fs.chmodSync(input.cwd, 0o500);
          try {
            await input.tools.finalize({
              commitPaths: [`${first.id}.txt`],
              summary: "Left one controller-recorded tracked cleanup residual.",
            });
          } finally {
            fs.chmodSync(input.cwd, 0o700);
            fs.chmodSync(path.join(input.cwd, "shared.txt"), 0o600);
          }
          return { status: "settled", sessionId: first.id };
        }
        fs.writeFileSync(path.join(input.cwd, "shared.txt"), "repaired\n");
        const finalized = await input.tools.finalize({
          commitPaths: ["shared.txt"],
          summary:
            "Explicitly repaired and committed the inherited residual path.",
        });
        assert.equal(finalized.validated, true);
        return { status: "settled", sessionId: repair.id };
      },
    });

    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.deepEqual(result.rootResidualPaths, []);
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "shared.txt"), "utf8"),
      "repaired\n",
    );
  } finally {
    fs.chmodSync(repo.workingDir, 0o700);
    repo.cleanup();
  }
});

test("join conflicts continue the active cherry-pick and preserve source to integrated provenance", async () => {
  const repo = fixture();
  try {
    const left = graphTask("left-task");
    const right = graphTask("right-task");
    const executionGraph = graph([left, right]);
    const tree = {
      kind: "fork",
      branches: [
        { kind: "task", taskId: left.id },
        { kind: "task", taskId: right.id },
      ],
    } satisfies ExecutionTree;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      worktreePrepare: [],
      canonicalPlan,
      graph: executionGraph,
      tree,
      runCheck: passingCheck,
      async runSession(input) {
        if (input.kind === "conflict-resolution") {
          assert.equal(input.model, "openai-codex/gpt-6-astra");
          assert.equal(input.thinkingLevel, "low");
          fs.writeFileSync(path.join(input.cwd, "shared.txt"), "left+right\n");
          const finalized = await input.tools.finalize({
            commitPaths: ["shared.txt"],
            summary: "Resolved the two validated fixture changes together.",
          });
          assert.equal(finalized.validated, true);
          return { status: "settled", sessionId: "conflict-resolver" };
        }
        const value = input.task!.id.startsWith("left") ? "left\n" : "right\n";
        fs.writeFileSync(path.join(input.cwd, "shared.txt"), value);
        await input.tools.finalize({
          commitPaths: ["shared.txt"],
          summary: `Implemented ${input.task!.id}.`,
        });
        return { status: "settled", sessionId: input.role };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "shared.txt"), "utf8"),
      "left+right\n",
    );
    assert.equal(result.joins[0]!.commits.length, 2);
    assert.notEqual(
      result.joins[0]!.commits[1]!.sourceCommit,
      result.joins[0]!.commits[1]!.integratedCommit,
    );
    assert.equal(
      result.tasks.some(
        ({ kind, status }) =>
          kind === "conflict-resolution" && status === "validated",
      ),
      true,
    );
  } finally {
    repo.cleanup();
  }
});

test("nested conflict repair retains remaining range and extra checkpoints exactly once", async () => {
  const repo = fixture();
  const tasks = [graphTask("range-left"), graphTask("range-right")];
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph(tasks),
      tree: {
        kind: "fork",
        branches: [
          {
            kind: "fork",
            branches: tasks.map(({ id }) => ({ kind: "task", taskId: id })),
          },
        ],
      },
      runCheck: async () => passingCheck(),
      async runSession(input) {
        assert.ok(input.tools.stage);
        assert.ok(input.tools.checkpoint);
        if (input.kind === "conflict-resolution") {
          fs.writeFileSync(path.join(input.cwd, "shared.txt"), "resolved\n");
          await input.tools.stage({ paths: ["shared.txt"], action: "stage" });
          await input.tools.checkpoint({ message: "Resolve source" });
          fs.writeFileSync(path.join(input.cwd, "repair-extra.txt"), "extra\n");
          await input.tools.stage({
            paths: ["repair-extra.txt"],
            action: "stage",
          });
          await input.tools.checkpoint({ message: "Extra repair" });
        } else {
          fs.writeFileSync(
            path.join(input.cwd, "shared.txt"),
            `${input.task!.id}\n`,
          );
          await input.tools.stage({ paths: ["shared.txt"], action: "stage" });
          await input.tools.checkpoint({ message: `${input.task!.id} first` });
          const file = `${input.task!.id}.txt`;
          fs.writeFileSync(path.join(input.cwd, file), "remaining\n");
          await input.tools.stage({ paths: [file], action: "stage" });
          await input.tools.checkpoint({
            message: `${input.task!.id} remaining`,
          });
        }
        for (const check of [baselineCheck, ...input.task!.checks])
          await input.tools.check({ checkId: check.id });
        const accepted = await input.tools.finalize({
          summary: "Range accepted",
        });
        assert.equal(
          accepted.validated,
          true,
          accepted.error ?? "acceptance failed",
        );
        return { status: "settled" };
      },
    });
    assert.equal(result.status, "completed", result.error ?? "graph failed");
    assert.equal(git(repo.workingDir, ["rev-list", "--count", "HEAD"]), "6");
    assert.equal(
      result.joins.find(({ id }) => id === "join-1")!.commits.length,
      5,
    );
    for (const task of tasks)
      assert.equal(
        fs.readFileSync(path.join(repo.workingDir, `${task.id}.txt`), "utf8"),
        "remaining\n",
      );
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "repair-extra.txt"), "utf8"),
      "extra\n",
    );
  } finally {
    repo.cleanup();
  }
});

test("compatible duplicate branch changes retain both deterministic source mappings", async () => {
  const repo = fixture();
  try {
    const left = graphTask("duplicate-left");
    const right = graphTask("duplicate-right");
    const executionGraph = graph([left, right]);
    const tree = {
      kind: "fork",
      branches: [
        { kind: "task", taskId: left.id },
        { kind: "task", taskId: right.id },
      ],
    } satisfies ExecutionTree;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      runCheck: passingCheck,
      async runSession(input) {
        fs.writeFileSync(path.join(input.cwd, "shared.txt"), "same-change\n");
        await input.tools.finalize({
          commitPaths: ["shared.txt"],
          summary: `Applied the compatible ${input.task!.id} change.`,
        });
        return { status: "settled", sessionId: input.role };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.joins[0]!.commits.length, 2);
    assert.equal(
      new Set(
        result.joins[0]!.commits.map(
          ({ integratedCommit }) => integratedCommit,
        ),
      ).size,
      2,
    );
    assert.equal(git(repo.workingDir, ["rev-list", "--count", "HEAD"]), "3");
  } finally {
    repo.cleanup();
  }
});

test("post-join semantic failure creates one continuing join-repair task", async () => {
  const repo = fixture();
  try {
    const left = graphTask("left-file");
    const right = graphTask("right-file");
    const downstream = graphTask("after-repair", [left.id, right.id]);
    const executionGraph = graph([left, right, downstream]);
    const tree = {
      kind: "sequence",
      steps: [
        {
          kind: "fork",
          branches: [
            { kind: "task", taskId: left.id },
            { kind: "task", taskId: right.id },
          ],
        },
        { kind: "task", taskId: downstream.id },
      ],
    } satisfies ExecutionTree;
    let repairDependency:
      | {
          readonly taskId: string;
          readonly commit: string;
          readonly summary: string;
        }
      | undefined;
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: executionGraph,
      tree,
      async runCheck(input) {
        const joined =
          fs.existsSync(path.join(input.workspaceRoot, "left-file.txt")) &&
          fs.existsSync(path.join(input.workspaceRoot, "right-file.txt"));
        const repaired = fs.existsSync(
          path.join(input.workspaceRoot, "repair.txt"),
        );
        return {
          exitCode: joined && !repaired ? 1 : 0,
          stdout: joined ? "joined" : "branch",
          stderr: joined && !repaired ? "combined state needs repair" : "",
        };
      },
      async runSession(input) {
        if (input.kind === "join-repair") {
          assert.equal(input.model, "openai-codex/gpt-6-astra");
          assert.equal(input.thinkingLevel, "low");
          fs.writeFileSync(path.join(input.cwd, "repair.txt"), "compatible\n");
          await input.tools.finalize({
            commitPaths: ["repair.txt"],
            summary: "Repaired the combined semantic state.",
          });
          return { status: "settled", sessionId: "join-repair" };
        }
        if (input.task!.id === downstream.id) {
          repairDependency =
            input.capsule.graphContext.completedDependencies.find(
              ({ taskId }) => taskId === "__join-1-repair",
            );
        }
        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), "branch\n");
        await input.tools.finalize({
          commitPaths: [filePath],
          summary: `Implemented ${input.task!.id}.`,
        });
        return { status: "settled", sessionId: input.role };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.joins[0]!.status, "completed");
    assert.equal(result.joins[0]!.repairTaskId, "__join-1-repair");
    assert.equal(
      result.tasks.find(({ id }) => id === "__join-1-repair")?.status,
      "validated",
    );
    assert.equal(repairDependency?.taskId, "__join-1-repair");
    assert.equal(
      repairDependency?.commit,
      result.tasks.find(({ id }) => id === "__join-1-repair")?.validatedCommit,
    );
    assert.equal(
      fs.readFileSync(path.join(repo.workingDir, "repair.txt"), "utf8"),
      "compatible\n",
    );
  } finally {
    repo.cleanup();
  }
});

test("graph evidence records compiled fork membership and monotonic join ordering", async () => {
  const repo = fixture();
  const clock = fakeClock(100);
  const events: FeatureGraphEvidenceEvent[] = [];
  const left = graphTask("evidence-left");
  const right = graphTask("evidence-right");
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([left, right]),
      tree: {
        kind: "fork",
        branches: [
          { kind: "task", taskId: left.id },
          { kind: "task", taskId: right.id },
        ],
      },
      now: clock.now,
      controllerInstanceId: "controller-evidence",
      onEvidence(event) {
        events.push(event);
      },
      async runCheck(input) {
        if (input.workspaceRoot === repo.workingDir) clock.advance(7);
        return passingCheck();
      },
      async runSession(input) {
        const filePath = `${input.task!.id}.txt`;
        fs.writeFileSync(path.join(input.cwd, filePath), `${input.task!.id}\n`);
        await input.tools.finalize({
          commitPaths: [filePath],
          summary: `Finalize ${input.task!.id}.`,
        });
        return { status: "settled", sessionId: input.role };
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(
      events.every(
        ({ controllerInstanceId }) =>
          controllerInstanceId === "controller-evidence",
      ),
      true,
    );
    const eligible = events.filter(({ kind }) => kind === "fork_eligible");
    assert.deepEqual(
      eligible.map(({ branchId }) => branchId),
      ["branch-1-evidence-left", "branch-2-evidence-right"],
    );
    assert.deepEqual(
      eligible.map(({ dependencies }) =>
        dependencies.map(({ taskId }) => taskId),
      ),
      [[left.id], [right.id]],
    );
    const memberships = events.filter(
      ({ kind }) => kind === "branch_task_membership",
    );
    assert.deepEqual(
      memberships.map(({ branchId, taskId }) => ({ branchId, taskId })),
      [
        { branchId: "branch-1-evidence-left", taskId: left.id },
        { branchId: "branch-2-evidence-right", taskId: right.id },
      ],
    );
    const joinStarted = events.find(({ kind }) => kind === "join_started");
    const joinFinished = events.find(({ kind }) => kind === "join_finished");
    assert.ok(joinStarted);
    assert.ok(joinFinished);
    assert.equal(joinStarted.forkId, "fork-1");
    assert.equal(joinStarted.joinId, "join-1");
    assert.equal(joinStarted.status, "joining");
    assert.deepEqual(
      joinStarted.dependencies.map(({ taskId, status }) => ({
        taskId,
        status,
      })),
      [
        { taskId: left.id, status: "validated" },
        { taskId: right.id, status: "validated" },
      ],
    );
    assert.equal(joinFinished.status, "completed");
    assert.equal(joinStarted.atMs, 100);
    assert.equal(joinFinished.atMs, 107);
    assert.equal(joinFinished.atMs >= joinStarted.atMs, true);
  } finally {
    repo.cleanup();
  }
});

test("failed and cancelled forks emit terminal join evidence with required task settlement", async (t) => {
  for (const mode of ["failed", "cancelled"] as const) {
    await t.test(mode, async () => {
      const repo = fixture();
      const clock = fakeClock();
      const events: FeatureGraphEvidenceEvent[] = [];
      const left = graphTask(`${mode}-left`);
      const right = graphTask(`${mode}-right`);
      const controller = new AbortController();
      try {
        const result = await executeFeatureGraph({
          runId: repo.runId,
          workingDir: repo.workingDir,
          worktreeRoot: repo.worktreeRoot,
          canonicalPlan,
          graph: graph([left, right], []),
          tree: {
            kind: "fork",
            branches: [
              { kind: "task", taskId: left.id },
              { kind: "task", taskId: right.id },
            ],
          },
          signal: controller.signal,
          now: clock.now,
          onEvidence(event) {
            events.push(event);
          },
          runCheck: passingCheck,
          async runSession(input) {
            if (mode === "cancelled") {
              controller.abort();
              return { status: "cancelled", sessionId: input.role };
            }
            if (input.task!.id === left.id) {
              return {
                status: "failed",
                sessionId: `${input.role}-${input.attempt}`,
                error: "synthetic branch failure",
              };
            }
            await input.tools.finalize({
              commitPaths: [],
              summary: "No change on the independent branch.",
            });
            return { status: "settled", sessionId: input.role };
          },
        });

        assert.equal(result.status, mode);
        const started = events.filter(({ kind }) => kind === "join_started");
        const finished = events.filter(({ kind }) => kind === "join_finished");
        assert.equal(started.length, 1);
        assert.equal(finished.length, 1);
        assert.equal(finished[0]!.status, mode);
        assert.equal(finished[0]!.atMs >= started[0]!.atMs, true);
        assert.deepEqual(
          finished[0]!.dependencies.map(({ taskId, status }) => ({
            taskId,
            status,
          })),
          mode === "failed"
            ? [
                { taskId: left.id, status: "failed" },
                { taskId: right.id, status: "satisfied_without_changes" },
              ]
            : [
                { taskId: left.id, status: "cancelled" },
                { taskId: right.id, status: "cancelled" },
              ],
        );
      } finally {
        repo.cleanup();
      }
    });
  }
});

test("retained-resource evidence forwards through a graph result without changing cleanup policy", async () => {
  const repo = fixture();
  const cleanupEvidence: CleanupEvidence[] = [];
  const task = graphTask("retained-result");
  try {
    const result = await executeFeatureGraph({
      runId: repo.runId,
      workingDir: repo.workingDir,
      worktreeRoot: repo.worktreeRoot,
      canonicalPlan,
      graph: graph([task], []),
      tree: { kind: "task", taskId: task.id },
      cleanupEvidence: (record) => cleanupEvidence.push(record),
      runCheck: passingCheck,
      async runSession() {
        return { status: "failed", error: "retain diagnostics" };
      },
    });

    assert.equal(result.status, "failed");
    result.recordRetainedResources("graph_failed");
    assert.equal(
      cleanupEvidence.some(
        ({ disposition, reasonCode }) =>
          disposition === "retained" && reasonCode === "graph_failed",
      ),
      true,
    );
    assert.equal(
      git(repo.workingDir, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/pipi-feature/${repo.runId}`,
      ]).length,
      0,
    );
  } finally {
    repo.cleanup();
  }
});
