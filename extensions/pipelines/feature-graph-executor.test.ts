import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExecutionTree } from "./feature-graph.ts";
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

function fixture() {
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
        assert.equal(input.model, "openai-codex/gpt-5.6-luna");
        assert.equal(input.thinkingLevel, "high");
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

test("child preparation failure stops before spending agent attempts", async () => {
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
          return { exitCode: 1, stdout: "", stderr: "preparation unavailable" };
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
    assert.equal(sessionAttempts, 0);
    assert.deepEqual(result.tasks[0]!.attempts, []);
    assert.match(result.error!, /preparation unavailable/);
    assert.equal(result.branches[1]!.preparation.attempts, 1);
    assert.equal(result.branches[1]!.preparation.complete, false);
  } finally {
    repo.cleanup();
  }
});

test("baseline failure is reported before any task session or commit", async () => {
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
    assert.equal(sessions, 0);
    assert.equal(checks, 1);
    assert.equal(result.tasks[0]!.attempt, 0);
    assert.deepEqual(result.tasks[0]!.attempts, []);
    assert.equal(result.tasks[0]!.checks[0]!.exitCode, 1);
    assert.match(result.error!, /dependency unavailable in sandbox/);
    assert.equal(git(repo.workingDir, ["rev-parse", "HEAD"]), head);
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
      assert.equal(sessions, 1);
      const task = result.tasks.find(({ id }) => id === active.id)!;
      assert.equal(task.status, validates ? "validated" : "failed");
      assert.equal(task.attempt, 1);
      assert.deepEqual(
        task.attempts.map(({ status }) => status),
        ["completed"],
      );
      assert.ok(task.provisionalCommit);
      if (!validates)
        assert.equal(
          task.error,
          `Required check ${active.checks[0]!.id} failed.`,
        );
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

test("a fourth failed attempt lets an active sibling settle and retains diagnostic branches", async () => {
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
      4,
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
