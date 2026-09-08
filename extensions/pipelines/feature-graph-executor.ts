import { randomUUID } from "node:crypto";
import type { ExecutionTree } from "./feature-graph.ts";
import type {
  FeatureCanonicalPlan,
  FeatureExecutionCheck,
  FeatureExecutionGraph,
  FeatureExecutionTask,
} from "./feature-planning.ts";
import {
  createFeatureTaskRuntime,
  runFeatureCheckCommand,
  type FeatureCheckResult,
  type FeatureCheckRunner,
  type FeatureCompletedDependency,
  type FeatureTaskRuntime,
  type FeatureTaskSessionInput,
  type FeatureTaskSessionOutcome,
  type FeatureTaskSnapshot,
} from "./feature-task-runtime.ts";
import {
  createFeatureTaskWorktreeLifecycle,
  type FeatureTaskBranch,
  type FeatureTrackedResidualState,
} from "./feature-task-worktrees.ts";
import type { CleanupEvidenceSink } from "./cleanup-evidence.ts";

const MAX_TASK_ATTEMPTS = 4;
const LUNA_MODEL = "openai-codex/gpt-5.6-luna" as const;

export type FeatureBranchStatus =
  | "waiting"
  | "preparing"
  | "running"
  | "paused"
  | "joining"
  | "completed"
  | "failed"
  | "cancelled";

export type FeaturePreparationCommandResult = Pick<
  FeatureCheckResult,
  "command" | "cwd" | "exitCode" | "stdout" | "stderr" | "error"
>;

export interface FeatureBranchSnapshot {
  readonly id: string;
  readonly parentId?: string;
  readonly number: number;
  readonly firstTaskId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly baseCommit: string;
  readonly head: string;
  readonly status: FeatureBranchStatus;
  readonly preparation: {
    readonly attempts: number;
    readonly complete: boolean;
    readonly baselinePaths: ReadonlyArray<string>;
    readonly commands?: ReadonlyArray<FeaturePreparationCommandResult>;
    readonly error?: string;
  };
  readonly taskIds: ReadonlyArray<string>;
}

export type FeatureJoinStatus =
  | "waiting"
  | "joining"
  | "conflict"
  | "resolving"
  | "checking"
  | "repairing"
  | "completed"
  | "failed"
  | "cancelled";

export interface FeatureIntegratedCommit {
  readonly taskId: string;
  readonly sourceCommit: string;
  readonly integratedCommit: string;
  readonly childBranchId: string;
}

export interface FeatureJoinSnapshot {
  readonly id: string;
  readonly parentBranchId: string;
  readonly childBranchIds: ReadonlyArray<string>;
  readonly status: FeatureJoinStatus;
  readonly commits: ReadonlyArray<FeatureIntegratedCommit>;
  readonly checks: ReadonlyArray<FeatureCheckResult>;
  readonly repairTaskId?: string;
  readonly error?: string;
  readonly warnings: ReadonlyArray<string>;
}

export interface FeatureGraphExecutionSnapshot {
  readonly tree: ExecutionTree;
  readonly tasks: ReadonlyArray<FeatureTaskSnapshot>;
  readonly branches: ReadonlyArray<FeatureBranchSnapshot>;
  readonly joins: ReadonlyArray<FeatureJoinSnapshot>;
  readonly warnings: ReadonlyArray<string>;
  readonly residualPaths: ReadonlyArray<string>;
}

export interface FeatureGraphExecutionResult extends FeatureGraphExecutionSnapshot {
  readonly status: "completed" | "failed" | "cancelled";
  readonly head: string;
  readonly rootResidualPaths?: ReadonlyArray<string>;
  readonly rootTrackedResiduals?: ReadonlyArray<FeatureTrackedResidualState>;
  readonly error?: string;
  /** Call only after the entire feature pipeline, including review/audit, succeeds. */
  cleanupCompleted(): ReadonlyArray<string>;
  /** Record controller-owned resources retained for a failed or cancelled run. */
  recordRetainedResources(reason: string): void;
}

export interface FeatureGraphExecutionOptions {
  readonly runId: string;
  readonly workingDir: string;
  readonly worktreeRoot: string;
  readonly worktreePrepare?: ReadonlyArray<string>;
  readonly canonicalPlan: FeatureCanonicalPlan;
  readonly graph: FeatureExecutionGraph;
  readonly tree: ExecutionTree;
  readonly runSession: (
    input: FeatureTaskSessionInput,
  ) => Promise<FeatureTaskSessionOutcome>;
  readonly runCheck?: FeatureCheckRunner;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly controllerInstanceId?: string;
  readonly cleanupEvidence?: CleanupEvidenceSink;
  readonly onSnapshot?: (snapshot: FeatureGraphExecutionSnapshot) => void;
  readonly onEvidence?: (event: FeatureGraphEvidenceEvent) => void;
}

export type FeatureGraphEvidenceKind =
  "fork_eligible" | "branch_task_membership" | "join_started" | "join_finished";

export type FeatureGraphEvidenceStatus =
  "eligible" | "member" | "joining" | "completed" | "failed" | "cancelled";

export type FeatureGraphEvidenceTaskStatus = FeatureTaskSnapshot["status"];

export interface FeatureGraphEvidenceDependency {
  readonly branchId: string;
  readonly taskId: string;
  readonly status: FeatureGraphEvidenceTaskStatus;
}

function createFeatureGraphEvidence(input: {
  readonly runId: string;
  readonly controllerInstanceId: string;
  readonly kind: FeatureGraphEvidenceKind;
  readonly forkId: string;
  readonly branchId: string;
  readonly taskId?: string;
  readonly joinId: string;
  readonly atMs: number;
  readonly status: FeatureGraphEvidenceStatus;
  readonly dependencies: ReadonlyArray<FeatureGraphEvidenceDependency>;
}) {
  return {
    ...input,
    dependencies: input.dependencies.map((dependency) => ({ ...dependency })),
  } as const;
}

export type FeatureGraphEvidenceEvent = ReturnType<
  typeof createFeatureGraphEvidence
>;
export type FeatureGraphEvidence = FeatureGraphEvidenceEvent;

export type FeatureGraphExecutor = typeof executeFeatureGraph;

interface MutableBranchSnapshot {
  id: string;
  parentId?: string;
  number: number;
  firstTaskId: string;
  branch: string;
  worktree: string;
  baseCommit: string;
  head: string;
  status: FeatureBranchStatus;
  preparation: {
    attempts: number;
    complete: boolean;
    baselinePaths: string[];
    commands: FeaturePreparationCommandResult[];
    error?: string;
  };
  taskIds: string[];
}

interface MutableJoinSnapshot {
  id: string;
  parentBranchId: string;
  childBranchIds: string[];
  status: FeatureJoinStatus;
  commits: FeatureIntegratedCommit[];
  checks: FeatureCheckResult[];
  repairTaskId?: string;
  error?: string;
  warnings: string[];
}

interface BranchCommit {
  taskId: string;
  commit: string;
  summary: string;
}

interface BranchExecution {
  branchId: string;
  taskIds: ReadonlyArray<string>;
  commits: BranchCommit[];
  visibleCommits: Map<string, string>;
  repairs: FeatureCompletedDependency[];
}

interface ForkPlan {
  forkId: string;
  joinId: string;
  branches: ReadonlyArray<{
    tree: ExecutionTree;
    number: number;
    firstTaskId: string;
  }>;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 16 * 1024);
}

function firstTaskId(tree: ExecutionTree): string {
  if (tree.kind === "task") return tree.taskId;
  if (tree.kind === "sequence") {
    return tree.steps[0] ? firstTaskId(tree.steps[0]) : "task";
  }
  return tree.branches.map(firstTaskId).sort()[0] ?? "task";
}

function taskIds(tree: ExecutionTree): ReadonlyArray<string> {
  if (tree.kind === "task") return [tree.taskId];
  const children = tree.kind === "sequence" ? tree.steps : tree.branches;
  return children.flatMap(taskIds);
}

function planForks(tree: ExecutionTree) {
  const plans = new Map<ExecutionTree, ForkPlan>();
  let branchNumber = 0;
  let forkNumber = 0;
  let joinNumber = 0;
  const visit = (node: ExecutionTree) => {
    if (node.kind === "task") return;
    if (node.kind === "sequence") {
      for (const step of node.steps) visit(step);
      return;
    }
    const branches = [...node.branches]
      .map((branch) => ({ tree: branch, firstTaskId: firstTaskId(branch) }))
      .sort((left, right) => left.firstTaskId.localeCompare(right.firstTaskId))
      .map((branch) => ({ ...branch, number: ++branchNumber }));
    plans.set(node, {
      forkId: `fork-${++forkNumber}`,
      joinId: `join-${++joinNumber}`,
      branches,
    });
    for (const branch of branches) visit(branch.tree);
  };
  visit(tree);
  return plans;
}

function branchSnapshot(
  branch: FeatureTaskBranch,
  status: FeatureBranchStatus,
): MutableBranchSnapshot {
  return {
    id: branch.id,
    ...(branch.parentId ? { parentId: branch.parentId } : {}),
    number: branch.number,
    firstTaskId: branch.firstTaskId,
    branch: branch.branch,
    worktree: branch.worktree,
    baseCommit: branch.baseCommit,
    head: branch.head,
    status,
    preparation: {
      attempts: branch.preparationAttempts,
      complete: branch.prepared,
      baselinePaths: [...branch.preparationBaseline],
      commands: [],
    },
    taskIds: [],
  };
}

function copyBranch(branch: MutableBranchSnapshot): FeatureBranchSnapshot {
  return {
    ...branch,
    preparation: {
      ...branch.preparation,
      baselinePaths: [...branch.preparation.baselinePaths],
      commands: branch.preparation.commands.map((command) => ({ ...command })),
    },
    taskIds: [...branch.taskIds],
  };
}

function copyJoin(join: MutableJoinSnapshot): FeatureJoinSnapshot {
  return {
    ...join,
    childBranchIds: [...join.childBranchIds],
    commits: join.commits.map((commit) => ({ ...commit })),
    checks: join.checks.map((check) => ({ ...check })),
    warnings: [...join.warnings],
  };
}

function initialTask(task: FeatureExecutionTask): FeatureTaskSnapshot {
  return {
    id: task.id,
    kind: "task",
    objective: task.objective,
    status: "waiting",
    attempt: 0,
    attempts: [],
    branchId: "",
    branch: "",
    worktree: "",
    checks: [],
    warnings: [],
    residualPaths: [],
  };
}

function internalTask(options: {
  id: string;
  objective: string;
  plan: FeatureCanonicalPlan;
  checks: ReadonlyArray<FeatureExecutionCheck>;
  instructions: ReadonlyArray<string>;
  evidence: ReadonlyArray<string>;
}) {
  const acceptanceRefs = options.plan.acceptance.map(({ id }) => id);
  return {
    id: options.id,
    objective: options.objective,
    branchGoal: options.objective,
    dependsOn: [],
    context: {
      problem: options.objective,
      repositoryConventions: [
        "Follow the accepted canonical plan and every repository AGENTS.md instruction.",
      ],
      relevantDiscovery: [options.plan.summary, ...options.evidence],
      precedents: options.plan.changes.slice(0, 64).map((change) => ({
        path: change.path,
        symbol: change.symbols.join(", ") || change.id,
        lesson: change.body,
      })),
      invariants: options.plan.contracts.map(({ body }) => body),
    },
    readPaths: [
      ...new Set([
        "AGENTS.md",
        ...options.plan.changes.map(({ path }) => path),
      ]),
    ],
    writePaths: [...new Set(options.plan.changes.map(({ path }) => path))],
    instructions: [...options.instructions],
    implementationSketch:
      "Inspect the current controller-owned integration state, make the smallest repair consistent with the canonical plan, and finalize through the supplied controller tools.",
    acceptanceRefs:
      acceptanceRefs.length > 0 ? acceptanceRefs : ["AC-INTERNAL"],
    doneWhen: ["Every required effective baseline check passes."],
    checks: [],
  } satisfies FeatureExecutionTask;
}

export async function executeFeatureGraph(
  options: FeatureGraphExecutionOptions,
) {
  const ownedAbort = new AbortController();
  const signal = options.signal ?? ownedAbort.signal;
  const runCheck = options.runCheck ?? runFeatureCheckCommand;
  const now = options.now ?? (() => performance.now());
  const controllerInstanceId = options.controllerInstanceId ?? randomUUID();
  const lifecycle = createFeatureTaskWorktreeLifecycle({
    runId: options.runId,
    workingDir: options.workingDir,
    worktreeRoot: options.worktreeRoot,
    cleanupEvidence: options.cleanupEvidence,
  });
  const tasksById = new Map(options.graph.tasks.map((task) => [task.id, task]));
  const taskOrder = new Map(
    options.graph.tasks.map((task, index) => [task.id, index]),
  );
  const taskSnapshots = new Map(
    options.graph.tasks.map((task) => [task.id, initialTask(task)]),
  );
  const branchSnapshots = new Map<string, MutableBranchSnapshot>();
  const joinSnapshots = new Map<string, MutableJoinSnapshot>();
  const warnings: string[] = [];
  const residualPaths = new Set<string>();
  const branchResidualPaths = new Map<string, Set<string>>([
    ["root", new Set()],
  ]);
  const results = new Map<string, FeatureTaskSnapshot>();
  const branchCommits = new Map<string, BranchCommit[]>([["root", []]]);
  const forkPlans = planForks(options.tree);
  const finishedJoins = new Set<string>();
  let launchingStopped = false;
  let terminalError: string | undefined;

  const emitEvidence = (
    input: Omit<
      Parameters<typeof createFeatureGraphEvidence>[0],
      "runId" | "controllerInstanceId" | "atMs"
    >,
  ) => {
    if (!options.onEvidence) return;
    const event = createFeatureGraphEvidence({
      ...input,
      runId: options.runId,
      controllerInstanceId,
      atMs: now(),
    });
    try {
      options.onEvidence(event);
    } catch {
      // Evidence observation must not change graph execution authority.
    }
  };

  branchSnapshots.set("root", branchSnapshot(lifecycle.root, "waiting"));

  const snapshot = (): FeatureGraphExecutionSnapshot => ({
    tree: options.tree,
    tasks: [...taskSnapshots.values()]
      .sort((left, right) => {
        const leftOrder = taskOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = taskOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.id.localeCompare(right.id);
      })
      .map((task) => ({
        ...task,
        attempts: task.attempts.map((attempt) => ({ ...attempt })),
        checks: task.checks.map((check) => ({ ...check })),
        warnings: [...task.warnings],
        residualPaths: [...task.residualPaths],
      })),
    branches: [...branchSnapshots.values()]
      .sort((left, right) => left.number - right.number)
      .map(copyBranch),
    joins: [...joinSnapshots.values()]
      .sort((left, right) =>
        left.id.localeCompare(right.id, undefined, { numeric: true }),
      )
      .map(copyJoin),
    warnings: [...warnings].sort(),
    residualPaths: [...residualPaths].sort(),
  });

  const publish = () => {
    const value = snapshot();
    options.onSnapshot?.(value);
    return value;
  };

  const updateBranch = (branchId: string, value?: FeatureTaskBranch) => {
    const mutable = branchSnapshots.get(branchId);
    if (!mutable) throw new Error(`Missing branch snapshot ${branchId}.`);
    const current = value ?? lifecycle.branch(branchId);
    mutable.head = current.head;
    mutable.preparation.attempts = current.preparationAttempts;
    mutable.preparation.complete = current.prepared;
    mutable.preparation.baselinePaths = [...current.preparationBaseline];
    publish();
  };

  const branchTaskDependencies = (
    branchId: string,
    ids: ReadonlyArray<string>,
  ) =>
    ids.map((taskId) => ({
      branchId,
      taskId,
      status: taskSnapshots.get(taskId)?.status ?? "waiting",
    }));

  const emitForkMembership = (
    plan: ForkPlan,
    branchId: string,
    ids: ReadonlyArray<string>,
  ) => {
    emitEvidence({
      kind: "fork_eligible",
      forkId: plan.forkId,
      branchId,
      joinId: plan.joinId,
      status: "eligible",
      dependencies: branchTaskDependencies(branchId, ids),
    });
    for (const taskId of ids) {
      emitEvidence({
        kind: "branch_task_membership",
        forkId: plan.forkId,
        branchId,
        taskId,
        joinId: plan.joinId,
        status: "member",
        dependencies: [],
      });
    }
  };

  const joinDependencies = (children: ReadonlyArray<BranchExecution>) =>
    children.flatMap(({ branchId, taskIds: ids }) =>
      branchTaskDependencies(branchId, ids),
    );

  const emitJoinFinished = (
    plan: ForkPlan,
    parentBranchId: string,
    children: ReadonlyArray<BranchExecution>,
    status: "completed" | "failed" | "cancelled",
  ) => {
    if (finishedJoins.has(plan.joinId)) return;
    finishedJoins.add(plan.joinId);
    emitEvidence({
      kind: "join_finished",
      forkId: plan.forkId,
      branchId: parentBranchId,
      joinId: plan.joinId,
      status,
      dependencies: joinDependencies(children),
    });
  };

  const emitJoinStarted = (
    plan: ForkPlan,
    parentBranchId: string,
    children: ReadonlyArray<BranchExecution>,
  ) => {
    emitEvidence({
      kind: "join_started",
      forkId: plan.forkId,
      branchId: parentBranchId,
      joinId: plan.joinId,
      status: "joining",
      dependencies: joinDependencies(children),
    });
  };

  const taskDependencies = (
    task: FeatureExecutionTask,
    branch: BranchExecution,
  ) => [
    ...task.dependsOn.flatMap(
      (dependencyId): ReadonlyArray<FeatureCompletedDependency> => {
        const dependency = results.get(dependencyId);
        if (!dependency) return [];
        return [
          {
            taskId: dependency.id,
            commit:
              branch.visibleCommits.get(dependencyId) ??
              dependency.validatedCommit ??
              lifecycle.branch(branch.branchId).head,
            summary: dependency.summary ?? dependency.objective,
          },
        ];
      },
    ),
    ...branch.repairs,
  ];

  const nextTasks = (taskId: string) =>
    options.graph.tasks
      .filter(({ dependsOn }) => dependsOn.includes(taskId))
      .map(({ id, objective }) => ({ taskId: id, objective }));

  const prepareBranch = async (branchId: string) => {
    const branch = lifecycle.branch(branchId);
    if (branch.prepared) return undefined;
    const mutable = branchSnapshots.get(branchId)!;
    mutable.status = "preparing";
    mutable.preparation.error = undefined;
    const attempted = lifecycle.notePreparationAttempt(branchId);
    updateBranch(branchId, attempted);
    for (const command of options.worktreePrepare ?? []) {
      if (signal.aborted) return "Feature branch preparation was cancelled.";
      let recorded = false;
      try {
        const result = await runCheck({
          kind: "prepare",
          command,
          workspaceRoot: branch.worktree,
          cwd: branch.worktree,
          signal,
        });
        mutable.preparation.commands.push({
          command,
          cwd: branch.worktree,
          ...result,
        });
        recorded = true;
        if (result.exitCode !== 0) {
          const detail = (result.stderr || result.stdout).slice(0, 16 * 1024);
          throw new Error(
            `Preparation command exited ${result.exitCode}: ${detail}`,
          );
        }
      } catch (error) {
        const message = boundedError(error);
        if (!recorded) {
          mutable.preparation.commands.push({
            command,
            cwd: branch.worktree,
            exitCode: null,
            stdout: "",
            stderr: "",
            ...(message ? { error: message } : {}),
          });
        }
        mutable.preparation.error = message;
        publish();
        return message;
      }
    }
    try {
      const prepared = lifecycle.recordPreparationBaseline(branchId);
      updateBranch(branchId, prepared);
      return undefined;
    } catch (error) {
      const message = boundedError(error);
      mutable.preparation.error = message;
      publish();
      return message;
    }
  };

  const verifiedBranches = new Set<string>();

  const executeRuntime = async (input: {
    runtime: FeatureTaskRuntime;
    branchId: string;
    task: FeatureExecutionTask;
    kind: FeatureTaskSessionInput["kind"];
    role: string;
    prepare: boolean;
  }) => {
    const block = (message: string) => {
      launchingStopped = true;
      terminalError ??= message;
      return input.runtime.fail(message);
    };
    if (signal.aborted || launchingStopped) return input.runtime.cancel();
    if (input.prepare && !lifecycle.branch(input.branchId).prepared) {
      const preparationFailure = await prepareBranch(input.branchId);
      if (signal.aborted) return input.runtime.cancel();
      if (preparationFailure) {
        return block(
          `Worktree preparation failed before agent launch: ${preparationFailure}`,
        );
      }
      input.runtime.setPreparationBaseline(
        lifecycle.branch(input.branchId).preparationBaseline,
      );
    }
    // Preparation on the host is not proof that checks work in the execution
    // sandbox. Prove each branch before spending a model session on it.
    if (input.kind === "task" && !verifiedBranches.has(input.branchId)) {
      for (const check of options.graph.baselineChecks) {
        if (signal.aborted) return input.runtime.cancel();
        const result = await input.runtime.host.check({ checkId: check.id });
        if (signal.aborted) return input.runtime.cancel();
        if (
          (result.required && result.status !== "passed") ||
          result.changedPaths.length > 0
        ) {
          const detail = (result.error || result.stderr || result.stdout)
            .trim()
            .slice(0, 4096);
          return block(
            `Baseline check ${check.id} failed before agent launch (exit ${result.exitCode})${result.changedPaths.length ? `; changed tracked paths: ${result.changedPaths.join(", ")}` : ""}${detail ? `: ${detail}` : "."}`,
          );
        }
      }
      verifiedBranches.add(input.branchId);
    }
    let previousFailure: string | undefined;
    for (let attempt = 1; attempt <= MAX_TASK_ATTEMPTS; attempt++) {
      if (signal.aborted) return input.runtime.cancel();
      if (launchingStopped && attempt === 1) {
        return input.runtime.cancel();
      }
      const capsule = input.runtime.beginAttempt(attempt, previousFailure);
      const branch = branchSnapshots.get(input.branchId)!;
      branch.status = "running";
      publish();
      let outcome: FeatureTaskSessionOutcome;
      try {
        outcome = await options.runSession({
          kind: input.kind,
          role: input.role,
          model: LUNA_MODEL,
          thinkingLevel: "high",
          task: input.task,
          capsule,
          cwd: branch.worktree,
          attempt,
          tools: input.runtime.host,
          signal,
        });
      } catch (error) {
        outcome = {
          status: signal.aborted ? "cancelled" : "failed",
          error: boundedError(error),
        };
      }
      const settled = input.runtime.settleAttempt(outcome);
      if (input.runtime.isValidated()) return settled;
      if (outcome.status === "cancelled" || signal.aborted) return settled;
      // A terminal sibling failure stops new sessions, not the session that
      // was already running. Keep its checks/provisional commit and factual
      // settled attempt, close its authority, and do not spend another retry.
      if (launchingStopped) {
        return input.runtime.fail(
          settled.error ??
            "Task could not validate before a sibling stopped the graph.",
        );
      }
      previousFailure = settled.error;
    }
    const failed = input.runtime.fail(
      previousFailure ?? `Task failed after ${MAX_TASK_ATTEMPTS} attempts.`,
    );
    launchingStopped = true;
    terminalError ??= failed.error;
    return failed;
  };

  const runGraphTask = async (taskId: string, branch: BranchExecution) => {
    const task = tasksById.get(taskId);
    if (!task)
      throw new Error(`Execution tree references unknown task ${taskId}.`);
    if (signal.aborted || launchingStopped) return false;
    lifecycle.verify(branch.branchId);
    const branchState = lifecycle.branch(branch.branchId);
    const mutableBranch = branchSnapshots.get(branch.branchId)!;
    if (!mutableBranch.taskIds.includes(task.id))
      mutableBranch.taskIds.push(task.id);
    const runtime = createFeatureTaskRuntime({
      kind: "task",
      task,
      canonicalPlan: options.canonicalPlan,
      graph: options.graph,
      target: lifecycle.target(branch.branchId),
      taskBaseCommit: branchState.head,
      completedDependencies: taskDependencies(task, branch),
      nextTasks: nextTasks(task.id),
      preparationBaseline: branchState.preparationBaseline,
      knownResidualPaths: [...(branchResidualPaths.get(branch.branchId) ?? [])],
      runCheck,
      signal,
      onSnapshot(value) {
        taskSnapshots.set(task.id, value);
        for (const warning of value.warnings) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
        for (const filePath of value.residualPaths) residualPaths.add(filePath);
        const branchResiduals = branchResidualPaths.get(branch.branchId)!;
        branchResiduals.clear();
        for (const filePath of value.residualPaths)
          branchResiduals.add(filePath);
        publish();
      },
    });
    const result = await executeRuntime({
      runtime,
      branchId: branch.branchId,
      task,
      kind: "task",
      role: `feature-task-${task.id}`,
      prepare: branchState.owned,
    });
    taskSnapshots.set(task.id, result);
    results.set(task.id, result);
    if (
      result.status !== "validated" &&
      result.status !== "satisfied_without_changes"
    ) {
      mutableBranch.status =
        result.status === "cancelled" ? "cancelled" : "failed";
      terminalError ??= result.error;
      publish();
      return false;
    }
    if (result.validatedCommit) {
      branch.commits.push({
        taskId: task.id,
        commit: result.validatedCommit,
        summary: result.summary ?? task.objective,
      });
    }
    branch.visibleCommits.set(
      task.id,
      result.validatedCommit ?? lifecycle.branch(branch.branchId).head,
    );
    updateBranch(branch.branchId);
    return true;
  };

  const runInternalRuntime = async (input: {
    branch: BranchExecution;
    join: MutableJoinSnapshot;
    task: FeatureExecutionTask;
    kind: "conflict-resolution" | "join-repair";
    baseCommit: string;
    conflict?: boolean;
  }) => {
    const branchState = lifecycle.branch(input.branch.branchId);
    const runtime = createFeatureTaskRuntime({
      kind: input.kind,
      task: input.task,
      canonicalPlan: options.canonicalPlan,
      graph: options.graph,
      target: lifecycle.target(input.branch.branchId),
      taskBaseCommit: input.baseCommit,
      checks: options.graph.baselineChecks,
      preparationBaseline: branchState.preparationBaseline,
      knownResidualPaths: [
        ...(branchResidualPaths.get(input.branch.branchId) ?? []),
      ],
      runCheck,
      signal,
      conflict: input.conflict,
      onSnapshot(value) {
        taskSnapshots.set(input.task.id, value);
        for (const warning of value.warnings) {
          if (!warnings.includes(warning)) warnings.push(warning);
        }
        for (const filePath of value.residualPaths) residualPaths.add(filePath);
        const branchResiduals = branchResidualPaths.get(input.branch.branchId)!;
        branchResiduals.clear();
        for (const filePath of value.residualPaths)
          branchResiduals.add(filePath);
        publish();
      },
    });
    const result = await executeRuntime({
      runtime,
      branchId: input.branch.branchId,
      task: input.task,
      kind: input.kind,
      role: `feature-${input.kind}-${input.task.id}`,
      prepare: false,
    });
    taskSnapshots.set(input.task.id, result);
    if (result.validatedCommit) {
      input.branch.commits.push({
        taskId: input.task.id,
        commit: result.validatedCommit,
        summary: result.summary ?? input.task.objective,
      });
    }
    return result;
  };

  const runJoinChecks = async (
    join: MutableJoinSnapshot,
    branch: BranchExecution,
  ) => {
    join.status = "checking";
    join.checks = [];
    publish();
    const baseCommit = lifecycle.branch(branch.branchId).head;
    const probeTask = internalTask({
      id: `__${join.id}-check-probe`,
      objective: `Verify semantic integration for ${join.id}.`,
      plan: options.canonicalPlan,
      checks: options.graph.baselineChecks,
      instructions: ["Run the controller-selected baseline checks."],
      evidence: join.commits.map(
        ({ taskId, sourceCommit, integratedCommit }) =>
          `${taskId}: source ${sourceCommit}, integrated ${integratedCommit}`,
      ),
    });
    const runtime = createFeatureTaskRuntime({
      kind: "join-repair",
      task: probeTask,
      canonicalPlan: options.canonicalPlan,
      graph: options.graph,
      target: lifecycle.target(branch.branchId),
      taskBaseCommit: baseCommit,
      checks: options.graph.baselineChecks,
      preparationBaseline: lifecycle.branch(branch.branchId)
        .preparationBaseline,
      knownResidualPaths: [...(branchResidualPaths.get(branch.branchId) ?? [])],
      runCheck,
      signal,
    });
    try {
      for (const check of options.graph.baselineChecks) {
        if (signal.aborted) throw new Error("Join verification was cancelled.");
        join.checks.push(await runtime.host.check({ checkId: check.id }));
      }
    } catch (error) {
      join.status = signal.aborted ? "cancelled" : "failed";
      join.error = boundedError(error);
      terminalError ??= join.error;
      publish();
      throw error;
    }
    const passed = join.checks.every(
      (result) =>
        (!result.required || result.status === "passed") &&
        result.changedPaths.length === 0,
    );
    return { passed, runtime, baseCommit };
  };

  const joinBranches = async (
    node: ExecutionTree,
    parent: BranchExecution,
    children: ReadonlyArray<BranchExecution>,
  ) => {
    const plan = forkPlans.get(node);
    if (!plan) throw new Error("Missing deterministic fork execution plan.");
    const join: MutableJoinSnapshot = {
      id: plan.joinId,
      parentBranchId: parent.branchId,
      childBranchIds: children.map(({ branchId }) => branchId),
      status: "joining",
      commits: [],
      checks: [],
      warnings: [],
    };
    joinSnapshots.set(join.id, join);
    const parentSnapshot = branchSnapshots.get(parent.branchId)!;
    parentSnapshot.status = "joining";
    emitJoinStarted(plan, parent.branchId, children);
    publish();
    try {
      const orderedChildren = [...children].sort((left, right) => {
        const leftId = branchSnapshots.get(left.branchId)!.firstTaskId;
        const rightId = branchSnapshots.get(right.branchId)!.firstTaskId;
        return leftId.localeCompare(rightId);
      });
      for (const child of orderedChildren) {
        for (const source of child.commits) {
          if (signal.aborted) {
            join.status = "cancelled";
            publish();
            emitJoinFinished(plan, parent.branchId, children, "cancelled");
            return false;
          }
          const parentBefore = lifecycle.branch(parent.branchId).head;
          const cherryPick = lifecycle.cherryPick(
            parent.branchId,
            source.commit,
          );
          let integratedCommit: string;
          if (cherryPick.status === "conflict") {
            join.status = "conflict";
            publish();
            const conflictTask = internalTask({
              id: `__${join.id}-conflict-${join.commits.length + 1}`,
              objective: `Resolve the active cherry-pick conflict for task ${source.taskId}.`,
              plan: options.canonicalPlan,
              checks: options.graph.baselineChecks,
              instructions: [
                "Resolve every active conflict without aborting or restarting the controller-owned cherry-pick.",
                "Use pipeline_task_finalize to stage selected resolution paths and continue the existing cherry-pick.",
              ],
              evidence: [
                `Conflicting source commit: ${source.commit}`,
                `Conflicting task summary: ${source.summary}`,
                `Already integrated commits: ${join.commits.map(({ integratedCommit: commit }) => commit).join(", ") || "none"}`,
                `Already integrated summaries: ${parent.commits.map(({ taskId, summary }) => `${taskId}: ${summary}`).join(" | ") || "none"}`,
                `Conflict paths: ${cherryPick.conflictPaths.join(", ")}`,
              ],
            });
            join.status = "resolving";
            publish();
            const resolved = await runInternalRuntime({
              branch: parent,
              join,
              task: conflictTask,
              kind: "conflict-resolution",
              baseCommit: parentBefore,
              conflict: true,
            });
            if (resolved.status !== "validated" || !resolved.validatedCommit) {
              join.status = signal.aborted ? "cancelled" : "failed";
              join.error =
                resolved.error ?? "Conflict resolution did not validate.";
              terminalError ??= join.error;
              publish();
              emitJoinFinished(
                plan,
                parent.branchId,
                children,
                signal.aborted ? "cancelled" : "failed",
              );
              return false;
            }
            integratedCommit = resolved.validatedCommit;
            // The source task owns the cherry-picked commit; the resolver is provenance only.
            const repairIndex = parent.commits.findIndex(
              ({ taskId }) => taskId === conflictTask.id,
            );
            if (repairIndex >= 0) parent.commits.splice(repairIndex, 1);
          } else {
            integratedCommit = cherryPick.integratedCommit;
          }
          const mapping: FeatureIntegratedCommit = {
            taskId: source.taskId,
            sourceCommit: source.commit,
            integratedCommit,
            childBranchId: child.branchId,
          };
          join.commits.push(mapping);
          parent.commits.push({ ...source, commit: integratedCommit });
          parent.visibleCommits.set(source.taskId, integratedCommit);
          if (
            source.taskId.startsWith("__join-") &&
            source.taskId.endsWith("-repair")
          ) {
            parent.repairs.push({
              taskId: source.taskId,
              commit: integratedCommit,
              summary: source.summary,
            });
          }
          updateBranch(parent.branchId);
        }
      }
      const verification = await runJoinChecks(join, parent);
      if (!verification.passed) {
        if (signal.aborted) {
          join.status = "cancelled";
          publish();
          emitJoinFinished(plan, parent.branchId, children, "cancelled");
          return false;
        }
        join.status = "repairing";
        const repairTask = internalTask({
          id: `__${join.id}-repair`,
          objective: `Repair semantic integration failures after ${join.id}.`,
          plan: options.canonicalPlan,
          checks: options.graph.baselineChecks,
          instructions: [
            "Repair the combined child histories without rewriting any source task commit.",
            "Use the failed join-check evidence and finalize one controller-owned repair commit.",
          ],
          evidence: [
            ...join.commits.map(
              ({ taskId, sourceCommit, integratedCommit }) =>
                `${taskId}: source ${sourceCommit}, integrated ${integratedCommit}`,
            ),
            ...join.checks.map(
              ({ checkId, status, stderr }) =>
                `${checkId}: ${status}; ${stderr.slice(0, 4 * 1024)}`,
            ),
          ],
        });
        join.repairTaskId = repairTask.id;
        publish();
        const repaired = await runInternalRuntime({
          branch: parent,
          join,
          task: repairTask,
          kind: "join-repair",
          baseCommit: verification.baseCommit,
        });
        if (repaired.status !== "validated" || !repaired.validatedCommit) {
          join.status = signal.aborted ? "cancelled" : "failed";
          join.error = repaired.error ?? "Join repair did not validate.";
          terminalError ??= join.error;
          publish();
          emitJoinFinished(
            plan,
            parent.branchId,
            children,
            signal.aborted ? "cancelled" : "failed",
          );
          return false;
        }
        join.checks = repaired.checks.map((check) => ({ ...check }));
        parent.visibleCommits.set(repairTask.id, repaired.validatedCommit);
        parent.repairs.push({
          taskId: repairTask.id,
          commit: repaired.validatedCommit,
          summary: repaired.summary ?? repairTask.objective,
        });
        updateBranch(parent.branchId);
      }
      for (const child of children) {
        const cleanupWarnings = lifecycle.removeJoinedWorktree(child.branchId);
        join.warnings.push(...cleanupWarnings);
        warnings.push(...cleanupWarnings);
      }
      join.status = "completed";
      parentSnapshot.status = "running";
      publish();
      emitJoinFinished(plan, parent.branchId, children, "completed");
      return true;
    } catch (error) {
      const status = signal.aborted ? "cancelled" : "failed";
      join.status = status;
      join.error ??= boundedError(error);
      terminalError ??= join.error;
      publish();
      emitJoinFinished(plan, parent.branchId, children, status);
      throw error;
    }
  };

  const executeNode = async (
    node: ExecutionTree,
    branch: BranchExecution,
  ): Promise<boolean> => {
    if (signal.aborted || launchingStopped) return false;
    if (node.kind === "task") return runGraphTask(node.taskId, branch);
    if (node.kind === "sequence") {
      for (const step of node.steps) {
        if (!(await executeNode(step, branch))) return false;
      }
      return true;
    }
    const plan = forkPlans.get(node);
    if (!plan) throw new Error("Missing deterministic fork plan.");
    lifecycle.verify(branch.branchId);
    branchSnapshots.get(branch.branchId)!.status = "paused";
    const children = plan.branches.map((child) => {
      const worktree = lifecycle.createChild(
        branch.branchId,
        child.number,
        child.firstTaskId,
      );
      branchSnapshots.set(worktree.id, branchSnapshot(worktree, "waiting"));
      branchCommits.set(worktree.id, []);
      branchResidualPaths.set(worktree.id, new Set());
      const execution = {
        branchId: worktree.id,
        taskIds: taskIds(child.tree),
        commits: branchCommits.get(worktree.id)!,
        visibleCommits: new Map(branch.visibleCommits),
        repairs: [...branch.repairs],
      } satisfies BranchExecution;
      return { plan: child, execution };
    });
    for (const { execution } of children)
      emitForkMembership(plan, execution.branchId, execution.taskIds);
    publish();
    const outcomes = await Promise.all(
      children.map(async ({ plan: child, execution }) => {
        let ok = false;
        try {
          ok = await executeNode(child.tree, execution);
        } catch (error) {
          launchingStopped = true;
          terminalError ??= boundedError(error);
        }
        const childSnapshot = branchSnapshots.get(execution.branchId)!;
        childSnapshot.status = ok
          ? "completed"
          : signal.aborted
            ? "cancelled"
            : "failed";
        publish();
        return { ok, execution };
      }),
    );
    const childExecutions = outcomes.map(({ execution }) => execution);
    if (outcomes.some(({ ok }) => !ok)) {
      emitJoinStarted(plan, branch.branchId, childExecutions);
      emitJoinFinished(
        plan,
        branch.branchId,
        childExecutions,
        signal.aborted ? "cancelled" : "failed",
      );
      return false;
    }
    return joinBranches(node, branch, childExecutions);
  };

  publish();
  let status: FeatureGraphExecutionResult["status"];
  try {
    const root = {
      branchId: "root",
      taskIds: taskIds(options.tree),
      commits: branchCommits.get("root")!,
      visibleCommits: new Map<string, string>(),
      repairs: [],
    } satisfies BranchExecution;
    const completed = await executeNode(options.tree, root);
    status = completed ? "completed" : signal.aborted ? "cancelled" : "failed";
  } catch (error) {
    terminalError = boundedError(error);
    launchingStopped = true;
    status = signal.aborted ? "cancelled" : "failed";
  }
  const rootSnapshot = branchSnapshots.get("root")!;
  rootSnapshot.status =
    status === "completed"
      ? "completed"
      : status === "cancelled"
        ? "cancelled"
        : "failed";
  updateBranch("root", lifecycle.branch("root"));
  const finalSnapshot = snapshot();
  const rootBranch = lifecycle.branch("root");
  const rootEvidence = lifecycle.inspect("root", rootBranch.head, 1);
  const recordedRootResiduals = branchResidualPaths.get("root") ?? new Set();
  const rootResidualPaths = [
    ...new Set([
      ...rootBranch.trackedResidualPaths,
      ...rootEvidence.untracked.filter((filePath) =>
        recordedRootResiduals.has(filePath),
      ),
    ]),
  ].sort();
  return {
    status,
    head: lifecycle.branch("root").head,
    rootResidualPaths,
    rootTrackedResiduals: rootBranch.trackedResiduals,
    ...finalSnapshot,
    ...(terminalError ? { error: terminalError } : {}),
    cleanupCompleted() {
      const cleanupWarnings = lifecycle.cleanupCompleted();
      warnings.push(...cleanupWarnings);
      return cleanupWarnings;
    },
    recordRetainedResources(reason: string) {
      lifecycle.recordRetainedResources(reason);
    },
  } satisfies FeatureGraphExecutionResult;
}
