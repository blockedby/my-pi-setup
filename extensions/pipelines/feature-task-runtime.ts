import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FeatureCanonicalPlan,
  FeatureExecutionCheck,
  FeatureExecutionGraph,
  FeatureExecutionTask,
} from "./feature-planning.ts";
import { isSafeRepositoryRelativePath } from "./feature-planning.ts";
import { runFeatureSandboxCommand } from "./feature-sandbox.ts";
import {
  createFeatureRootTaskGitTarget,
  type FeatureDiffPageRequest,
  type FeatureTaskGitTarget,
  type FeatureTrackedResidualState,
} from "./feature-task-worktrees.ts";

const TASK_CAPSULE_LIMIT = 192 * 1024;
const TASK_SUMMARY_LIMIT = 64 * 1024;

function boundedText(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const marker = "\n[Truncated]";
  if (maxBytes <= Buffer.byteLength(marker)) return marker.slice(0, maxBytes);
  const available = maxBytes - Buffer.byteLength(marker);
  let prefix = bytes.subarray(0, available).toString("utf8");
  while (Buffer.byteLength(prefix) > available) prefix = prefix.slice(0, -1);
  return prefix + marker;
}

type RetryCheckEvidence = Pick<
  FeatureCheckResult,
  "checkId" | "required" | "status" | "exitCode" | "changedPaths"
> & {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
};

export type FeatureTaskKind =
  "task" | "conflict-resolution" | "join-repair" | "final-review";

export type FeatureTaskStatus =
  | "waiting"
  | "preparing"
  | "running"
  | "retrying"
  | "provisional"
  | "validated"
  | "satisfied_without_changes"
  | "failed"
  | "cancelled";

export interface FeatureTaskAttemptSnapshot {
  readonly attempt: number;
  readonly sessionId?: string;
  readonly status:
    "preparing" | "running" | "failed" | "cancelled" | "completed";
  readonly error?: string;
}

export interface FeatureCheckResult {
  readonly checkId: string;
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly required: boolean;
  readonly status: "passed" | "failed" | "skipped";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly error?: string;
}

export interface FeatureCompletedDependency {
  readonly taskId: string;
  readonly commit: string;
  readonly summary: string;
}

export interface FeatureTaskCapsule {
  readonly kind: FeatureTaskKind;
  readonly taskId: string;
  readonly objective: string;
  readonly branchGoal: string;
  readonly context: FeatureExecutionTask["context"];
  readonly readPaths: ReadonlyArray<string>;
  readonly writePaths: ReadonlyArray<string>;
  readonly instructions: ReadonlyArray<string>;
  readonly implementationSketch: string;
  readonly acceptanceRefs: ReadonlyArray<string>;
  readonly doneWhen: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<FeatureExecutionCheck>;
  readonly graphContext: {
    readonly currentHead: string;
    readonly currentBranch: string;
    readonly worktree: string;
    readonly attempt: number;
    readonly completedDependencies: ReadonlyArray<FeatureCompletedDependency>;
    readonly nextTasks: ReadonlyArray<{
      readonly taskId: string;
      readonly objective: string;
    }>;
    readonly knownResidualPaths: ReadonlyArray<string>;
    readonly preparationBaseline: ReadonlyArray<string>;
    readonly previousFailure: string | null;
    readonly provisionalCommit: string | null;
    readonly previousChecks: ReadonlyArray<RetryCheckEvidence>;
    readonly currentDiff?: {
      readonly text: string;
      readonly truncated: boolean;
      readonly bytes: number;
      readonly offset: number;
      readonly nextOffset?: number;
      readonly fingerprint: string;
    };
  };
}

export interface FeatureTaskDiffResult {
  readonly taskBaseCommit: string;
  readonly currentHead: string;
  readonly currentBranch: string;
  readonly worktree: string;
  readonly baseToHead: ReadonlyArray<string>;
  readonly tracked: ReadonlyArray<string>;
  readonly staged: ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<string>;
  readonly conflictPaths: ReadonlyArray<string>;
  readonly knownResidualPaths: ReadonlyArray<string>;
  readonly preparationBaseline: ReadonlyArray<string>;
  readonly provisionalCommit?: string;
  readonly previousChecks: ReadonlyArray<FeatureCheckResult>;
  readonly diff: {
    readonly text: string;
    readonly truncated: boolean;
    readonly bytes: number;
    readonly offset: number;
    readonly nextOffset?: number;
    readonly fingerprint: string;
  };
}

export interface FeatureTaskFinalizeResult {
  readonly validated: boolean;
  readonly status: FeatureTaskStatus;
  readonly commit?: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<FeatureCheckResult>;
  readonly warnings: ReadonlyArray<string>;
  readonly residualPaths: ReadonlyArray<string>;
  readonly error?: string;
}

export interface FeatureTaskToolHost {
  diff(request?: FeatureDiffPageRequest): Promise<FeatureTaskDiffResult>;
  check(request: { readonly checkId: string }): Promise<FeatureCheckResult>;
  finalize(request: {
    readonly commitPaths: ReadonlyArray<string>;
    readonly summary: string;
  }): Promise<FeatureTaskFinalizeResult>;
}

export interface FeatureTaskSnapshot {
  readonly id: string;
  readonly kind: FeatureTaskKind;
  readonly objective: string;
  readonly status: FeatureTaskStatus;
  readonly attempt: number;
  readonly attempts: ReadonlyArray<FeatureTaskAttemptSnapshot>;
  readonly branchId: string;
  readonly branch: string;
  readonly worktree: string;
  readonly taskBaseCommit?: string;
  readonly provisionalCommit?: string;
  readonly validatedCommit?: string;
  readonly summary?: string;
  readonly error?: string;
  readonly checks: ReadonlyArray<FeatureCheckResult>;
  readonly warnings: ReadonlyArray<string>;
  readonly residualPaths: ReadonlyArray<string>;
  readonly capsule?: FeatureTaskCapsule;
}

export interface FeatureCheckCommandInput {
  readonly kind: "check" | "prepare";
  readonly command: string;
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface FeatureCheckCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type FeatureCheckRunner = (
  input: FeatureCheckCommandInput,
) => Promise<FeatureCheckCommandResult>;

export interface FeatureTaskSessionInput {
  readonly kind: Exclude<FeatureTaskKind, "final-review">;
  readonly role: string;
  readonly model: "openai-codex/gpt-5.6-luna";
  readonly thinkingLevel: "high";
  readonly task?: FeatureExecutionTask;
  readonly capsule: FeatureTaskCapsule;
  readonly cwd: string;
  readonly attempt: number;
  readonly tools: FeatureTaskToolHost;
  readonly signal: AbortSignal;
}

export interface FeatureTaskSessionOutcome {
  readonly status: "settled" | "cancelled" | "failed";
  readonly sessionId?: string;
  readonly error?: string;
}

export interface FeatureTaskRuntime {
  readonly host: FeatureTaskToolHost;
  setPreparationBaseline(paths: ReadonlyArray<string>): void;
  beginAttempt(attempt: number, previousFailure?: string): FeatureTaskCapsule;
  settleAttempt(outcome: FeatureTaskSessionOutcome): FeatureTaskSnapshot;
  fail(error: string): FeatureTaskSnapshot;
  cancel(): FeatureTaskSnapshot;
  snapshot(): FeatureTaskSnapshot;
  isValidated(): boolean;
}

interface MutableTaskState {
  status: FeatureTaskStatus;
  attempt: number;
  attempts: FeatureTaskAttemptSnapshot[];
  checks: FeatureCheckResult[];
  warnings: string[];
  residualPaths: string[];
  taskBaseCommit?: string;
  provisionalCommit?: string;
  validatedCommit?: string;
  summary?: string;
  error?: string;
  capsule?: FeatureTaskCapsule;
  active: boolean;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .slice(0, 16 * 1024);
}

function resolveCheckCwd(worktree: string, relativeCwd: string) {
  if (!isSafeRepositoryRelativePath(relativeCwd, true)) {
    throw new Error(`Check cwd is unsafe: ${JSON.stringify(relativeCwd)}.`);
  }
  const root = fs.realpathSync.native(worktree);
  const candidate = fs.realpathSync.native(
    relativeCwd === "." ? root : path.join(root, relativeCwd),
  );
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Check cwd escapes the assigned worktree: ${relativeCwd}.`);
  }
  return candidate;
}

export async function runFeatureCheckCommand(input: FeatureCheckCommandInput) {
  return runFeatureSandboxCommand({
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    command: input.command,
    signal: input.signal,
  });
}

function currentMeaningfulPaths(
  target: FeatureTaskGitTarget,
  baseCommit: string,
  preparationBaseline: ReadonlySet<string>,
  residualPaths: ReadonlySet<string>,
) {
  target.assertRecordedResidualsUnchanged?.();
  const diff = target.inspect(baseCommit);
  const trackedResidualPaths = new Set(target.trackedResidualPaths?.() ?? []);
  const staged = diff.staged.filter(
    (filePath) => !trackedResidualPaths.has(filePath),
  );
  const tracked = diff.tracked.filter(
    (filePath) => !trackedResidualPaths.has(filePath),
  );
  const untracked = diff.untracked.filter(
    (filePath) =>
      !preparationBaseline.has(filePath) && !residualPaths.has(filePath),
  );
  return [...new Set([...staged, ...tracked, ...untracked])].sort();
}

function internalTask(options: {
  id: string;
  objective: string;
  checks: ReadonlyArray<FeatureExecutionCheck>;
}): FeatureExecutionTask {
  return {
    id: options.id,
    objective: options.objective,
    branchGoal: options.objective,
    dependsOn: [],
    context: {
      problem: options.objective,
      repositoryConventions: [
        "Follow the accepted canonical plan and repository instructions.",
      ],
      relevantDiscovery: [
        "The controller created this internal integration task.",
      ],
      precedents: [
        {
          path: "AGENTS.md",
          symbol: "repository instructions",
          lesson:
            "Preserve repository conventions while making the bounded repair.",
        },
      ],
      invariants: [
        "Leave the assigned branch valid under every required check.",
      ],
    },
    readPaths: ["AGENTS.md"],
    writePaths: ["AGENTS.md"],
    instructions: [options.objective],
    implementationSketch:
      "Inspect the supplied Git evidence, make only the required bounded integration repair, and finalize through the controller tools.",
    acceptanceRefs: ["AC-INTERNAL"],
    doneWhen: ["Every required effective check passes."],
    checks: [...options.checks],
  };
}

export function createFeatureTaskRuntime(options: {
  readonly kind: FeatureTaskKind;
  readonly task?: FeatureExecutionTask;
  readonly id?: string;
  readonly objective?: string;
  readonly canonicalPlan: FeatureCanonicalPlan;
  readonly graph: FeatureExecutionGraph;
  readonly target: FeatureTaskGitTarget;
  readonly taskBaseCommit: string;
  readonly diffBaseCommit?: string;
  readonly completedDependencies?: ReadonlyArray<FeatureCompletedDependency>;
  readonly nextTasks?: ReadonlyArray<{
    readonly taskId: string;
    readonly objective: string;
  }>;
  readonly checks?: ReadonlyArray<FeatureExecutionCheck>;
  readonly preparationBaseline?: ReadonlyArray<string>;
  readonly knownResidualPaths?: ReadonlyArray<string>;
  readonly runCheck?: FeatureCheckRunner;
  readonly signal: AbortSignal;
  readonly conflict?: boolean;
  readonly onSnapshot?: (snapshot: FeatureTaskSnapshot) => void;
}) {
  const task =
    options.task ??
    internalTask({
      id: options.id ?? options.kind,
      objective: options.objective ?? options.kind,
      checks: [],
    });
  const effectiveChecks = options.checks ?? [
    ...options.graph.baselineChecks,
    ...task.checks,
  ];
  const checksById = new Map(effectiveChecks.map((check) => [check.id, check]));
  if (checksById.size !== effectiveChecks.length) {
    throw new Error(`Task ${task.id} has duplicate effective check IDs.`);
  }
  const preparationBaseline = new Set(options.preparationBaseline ?? []);
  const state: MutableTaskState = {
    status: "waiting",
    attempt: 0,
    attempts: [],
    checks: [],
    warnings: [],
    residualPaths: [...new Set(options.knownResidualPaths ?? [])].sort(),
    taskBaseCommit: options.taskBaseCommit,
    active: true,
  };
  const runCheck = options.runCheck ?? runFeatureCheckCommand;
  let busy = false;
  const assertActive = () => {
    if (!state.active)
      throw new Error(`Task ${task.id} tool authority is closed.`);
    if (options.signal.aborted)
      throw new Error(`Task ${task.id} was cancelled.`);
    const expectedHead = state.provisionalCommit ?? options.taskBaseCommit;
    if (options.target.head() !== expectedHead)
      throw new Error(
        `Task ${task.id} HEAD drifted outside controller ownership.`,
      );
  };

  const snapshot = (): FeatureTaskSnapshot => ({
    id: task.id,
    kind: options.kind,
    objective: task.objective,
    status: state.status,
    attempt: state.attempt,
    attempts: state.attempts.map((attempt) => ({ ...attempt })),
    branchId: options.target.branchId,
    branch: options.target.branch,
    worktree: options.target.worktree,
    ...(state.taskBaseCommit ? { taskBaseCommit: state.taskBaseCommit } : {}),
    ...(state.provisionalCommit
      ? { provisionalCommit: state.provisionalCommit }
      : {}),
    ...(state.validatedCommit
      ? { validatedCommit: state.validatedCommit }
      : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    ...(state.error ? { error: state.error } : {}),
    checks: state.checks.map((check) => ({ ...check })),
    warnings: [...state.warnings],
    residualPaths: [...state.residualPaths],
    ...(state.capsule ? { capsule: state.capsule } : {}),
  });

  const publish = () => {
    const value = snapshot();
    options.onSnapshot?.(value);
    return value;
  };

  const diff = async (
    request?: FeatureDiffPageRequest,
  ): Promise<FeatureTaskDiffResult> => {
    assertActive();
    const diffBaseCommit = options.diffBaseCommit ?? options.taskBaseCommit;
    const evidence = options.target.inspect(diffBaseCommit, undefined, request);
    return {
      taskBaseCommit: diffBaseCommit,
      currentHead: options.target.head(),
      currentBranch: options.target.branch,
      worktree: options.target.worktree,
      baseToHead: evidence.baseToHead,
      tracked: evidence.tracked,
      staged: evidence.staged,
      untracked: evidence.untracked,
      ignored: evidence.ignored,
      conflictPaths: evidence.conflictPaths,
      knownResidualPaths: [...state.residualPaths],
      preparationBaseline: [...preparationBaseline].sort(),
      ...(state.provisionalCommit
        ? { provisionalCommit: state.provisionalCommit }
        : {}),
      previousChecks: state.checks.map((check) => ({ ...check })),
      diff: {
        text: evidence.text,
        truncated: evidence.truncated,
        bytes: evidence.bytes,
        offset: evidence.offset,
        ...(evidence.nextOffset === undefined
          ? {}
          : { nextOffset: evidence.nextOffset }),
        fingerprint: evidence.fingerprint,
      },
    };
  };

  const runDeclaredCheck = async (request: {
    readonly checkId: string;
  }): Promise<FeatureCheckResult> => {
    assertActive();
    const definition = checksById.get(request.checkId);
    if (!definition) {
      throw new Error(
        `Unknown declared check ID ${JSON.stringify(request.checkId)}.`,
      );
    }
    const cwd = resolveCheckCwd(options.target.worktree, definition.cwd);
    const before = options.target.inspect(options.taskBaseCommit);
    const beforeTracked = new Set([...before.staged, ...before.tracked]);
    const startedAt = Date.now();
    let commandResult: FeatureCheckCommandResult;
    let commandError: string | undefined;
    try {
      commandResult = await runCheck({
        kind: "check",
        command: definition.command,
        workspaceRoot: options.target.worktree,
        cwd,
        signal: options.signal,
      });
    } catch (error) {
      commandError = boundedError(error);
      commandResult = { exitCode: null, stdout: "", stderr: commandError };
    }
    assertActive();
    const after = options.target.inspect(options.taskBaseCommit);
    const trackedChanged =
      before.fingerprint !== after.fingerprint ||
      before.staged.join("\0") !== after.staged.join("\0") ||
      before.tracked.join("\0") !== after.tracked.join("\0");
    const changedPaths = [
      ...new Set([
        ...after.staged,
        ...after.tracked,
        ...(trackedChanged ? beforeTracked : []),
      ]),
    ]
      .filter((filePath) => trackedChanged || !beforeTracked.has(filePath))
      .sort();
    const result: FeatureCheckResult = {
      checkId: definition.id,
      command: definition.command,
      cwd: definition.cwd,
      purpose: definition.purpose,
      required: definition.required,
      status:
        commandResult.exitCode === 0 && changedPaths.length === 0
          ? "passed"
          : "failed",
      exitCode: commandResult.exitCode,
      stdout: boundedText(commandResult.stdout, 16 * 1024),
      stderr: boundedText(commandResult.stderr, 16 * 1024),
      changedPaths,
      startedAt,
      finishedAt: Date.now(),
      ...(commandError ? { error: commandError } : {}),
    };
    state.checks = state.checks.filter(
      (check) => check.checkId !== result.checkId,
    );
    state.checks.push(result);
    publish();
    return result;
  };

  const check = async (request: { readonly checkId: string }) => {
    assertActive();
    if (busy)
      throw new Error(`Task ${task.id} verification is already running.`);
    busy = true;
    try {
      return await runDeclaredCheck(request);
    } finally {
      busy = false;
    }
  };

  const finalize = async (request: {
    readonly commitPaths: ReadonlyArray<string>;
    readonly summary: string;
  }): Promise<FeatureTaskFinalizeResult> => {
    assertActive();
    if (busy)
      throw new Error(`Task ${task.id} finalization is already running.`);
    if (!request.summary.trim())
      throw new Error("Task summary must not be empty.");
    if (Buffer.byteLength(request.summary, "utf8") > TASK_SUMMARY_LIMIT) {
      throw new Error(
        `Task summary exceeds ${TASK_SUMMARY_LIMIT} UTF-8 bytes.`,
      );
    }
    busy = true;
    try {
      let commitResult: ReturnType<FeatureTaskGitTarget["commit"]> | undefined;
      if (options.conflict && !state.provisionalCommit) {
        commitResult = options.target.continueCherryPick(request.commitPaths);
      } else if (!state.provisionalCommit && request.commitPaths.length > 0) {
        commitResult = options.target.commit(
          options.taskBaseCommit,
          request.commitPaths,
          `${options.kind === "final-review" ? "review" : "feature"}: ${task.id} ${task.objective}`,
        );
      } else if (state.provisionalCommit && request.commitPaths.length > 0) {
        commitResult = options.target.amend(
          state.provisionalCommit,
          request.commitPaths,
        );
      } else {
        const meaningful = currentMeaningfulPaths(
          options.target,
          options.taskBaseCommit,
          preparationBaseline,
          new Set(state.residualPaths),
        );
        if (meaningful.length > 0) {
          throw new Error(
            `Empty commitPaths cannot discard meaningful task changes: ${meaningful.join(", ")}.`,
          );
        }
      }
      if (commitResult) {
        state.provisionalCommit = commitResult.commit;
        state.status = "provisional";
        state.warnings.push(...commitResult.warnings);
        state.residualPaths = [...new Set(commitResult.residualPaths)].sort();
      }
      state.summary = request.summary.trim();
      state.error = undefined;
      state.checks = [];
      publish();
      for (const definition of effectiveChecks) {
        if (options.signal.aborted) {
          state.status = "cancelled";
          state.error = "Feature task was cancelled during final verification.";
          publish();
          return {
            validated: false,
            status: state.status,
            ...(state.provisionalCommit
              ? { commit: state.provisionalCommit }
              : {}),
            changedPaths: commitResult?.changedPaths ?? [],
            checks: [...state.checks],
            warnings: [...state.warnings],
            residualPaths: [...state.residualPaths],
            error: state.error,
          };
        }
        await runDeclaredCheck({ checkId: definition.id });
      }
      const requiredFailure = state.checks.find(
        (result) => result.required && result.status !== "passed",
      );
      const checkMutations = state.checks.flatMap(
        ({ changedPaths }) => changedPaths,
      );
      if (requiredFailure || checkMutations.length > 0) {
        state.status = "provisional";
        state.error = requiredFailure
          ? `Required check ${requiredFailure.checkId} failed.`
          : `Checks changed tracked paths: ${[...new Set(checkMutations)].join(", ")}.`;
        publish();
        return {
          validated: false,
          status: state.status,
          ...(state.provisionalCommit
            ? { commit: state.provisionalCommit }
            : {}),
          changedPaths: commitResult?.changedPaths ?? [],
          checks: [...state.checks],
          warnings: [...state.warnings],
          residualPaths: [...state.residualPaths],
          error: state.error,
        };
      }
      assertActive();
      state.validatedCommit = state.provisionalCommit;
      state.status =
        state.provisionalCommit || options.kind === "final-review"
          ? "validated"
          : "satisfied_without_changes";
      state.active = false;
      publish();
      return {
        validated: true,
        status: state.status,
        ...(state.validatedCommit ? { commit: state.validatedCommit } : {}),
        changedPaths: commitResult?.changedPaths ?? [],
        checks: [...state.checks],
        warnings: [...state.warnings],
        residualPaths: [...state.residualPaths],
      };
    } finally {
      busy = false;
    }
  };

  const runtime: FeatureTaskRuntime = {
    host: { diff, check, finalize },
    setPreparationBaseline(paths) {
      if (state.provisionalCommit || runtime.isValidated()) {
        throw new Error(
          "Preparation baseline is immutable after task finalization.",
        );
      }
      preparationBaseline.clear();
      for (const filePath of paths) preparationBaseline.add(filePath);
      if (state.capsule) {
        state.capsule = {
          ...state.capsule,
          graphContext: {
            ...state.capsule.graphContext,
            preparationBaseline: [...preparationBaseline].sort(),
          },
        };
      }
      publish();
    },
    beginAttempt(attempt, previousFailure) {
      assertActive();
      state.attempt = attempt;
      state.status = attempt === 1 ? "running" : "retrying";
      state.error = previousFailure;
      const capsule: FeatureTaskCapsule = {
        kind: options.kind,
        taskId: task.id,
        objective: task.objective,
        branchGoal: task.branchGoal,
        context: task.context,
        readPaths: task.readPaths,
        writePaths: task.writePaths,
        instructions: task.instructions,
        implementationSketch: task.implementationSketch,
        acceptanceRefs: task.acceptanceRefs,
        doneWhen: task.doneWhen,
        checks: effectiveChecks,
        graphContext: {
          currentHead: options.target.head(),
          currentBranch: options.target.branch,
          worktree: options.target.worktree,
          attempt,
          completedDependencies: (options.completedDependencies ?? []).map(
            (dependency) => ({
              ...dependency,
              summary: boundedText(
                dependency.summary,
                Math.max(
                  64,
                  Math.floor(
                    (24 * 1024) /
                      Math.max(1, options.completedDependencies?.length ?? 0),
                  ),
                ),
              ),
            }),
          ),
          nextTasks: (options.nextTasks ?? []).map((next) => ({
            ...next,
            objective: boundedText(
              next.objective,
              Math.max(
                64,
                Math.floor(
                  (16 * 1024) / Math.max(1, options.nextTasks?.length ?? 0),
                ),
              ),
            ),
          })),
          knownResidualPaths: [...state.residualPaths],
          preparationBaseline: [...preparationBaseline].sort(),
          previousFailure: previousFailure ?? null,
          provisionalCommit: state.provisionalCommit ?? null,
          previousChecks: state.checks.map((result) => ({
            checkId: result.checkId,
            required: result.required,
            status: result.status,
            exitCode: result.exitCode,
            changedPaths: result.changedPaths,
            stdout: boundedText(
              result.stdout,
              Math.max(
                16,
                Math.floor((8 * 1024) / Math.max(1, state.checks.length)),
              ),
            ),
            stderr: boundedText(
              result.stderr,
              Math.max(
                16,
                Math.floor((8 * 1024) / Math.max(1, state.checks.length)),
              ),
            ),
            outputTruncated:
              Buffer.byteLength(result.stdout) +
                Buffer.byteLength(result.stderr) >
              Math.max(
                256,
                Math.floor((16 * 1024) / Math.max(1, state.checks.length)),
              ),
          })),
          ...(attempt > 1
            ? {
                currentDiff: (() => {
                  const diff = options.target.inspect(
                    options.taskBaseCommit,
                    16 * 1024,
                  );
                  return {
                    text: diff.text,
                    truncated: diff.truncated,
                    bytes: diff.bytes,
                    offset: diff.offset,
                    ...(diff.nextOffset === undefined
                      ? {}
                      : { nextOffset: diff.nextOffset }),
                    fingerprint: diff.fingerprint,
                  };
                })(),
              }
            : {}),
        },
      };
      if (
        Buffer.byteLength(JSON.stringify(capsule), "utf8") > TASK_CAPSULE_LIMIT
      ) {
        throw new Error(
          `Task ${task.id} capsule exceeds ${TASK_CAPSULE_LIMIT} UTF-8 bytes.`,
        );
      }
      state.capsule = capsule;
      state.attempts.push({ attempt, status: "running" });
      publish();
      return capsule;
    },
    settleAttempt(outcome) {
      const current = state.attempts.at(-1);
      if (current && current.attempt === state.attempt) {
        state.attempts[state.attempts.length - 1] = {
          attempt: current.attempt,
          ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
          status:
            outcome.status === "cancelled"
              ? "cancelled"
              : outcome.status === "failed"
                ? "failed"
                : "completed",
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      }
      if (outcome.status === "cancelled") {
        state.status = "cancelled";
        state.error = outcome.error ?? "Feature task session was cancelled.";
        state.active = false;
      } else if (!runtime.isValidated()) {
        state.status = state.provisionalCommit ? "provisional" : "retrying";
        state.error =
          outcome.error ??
          (outcome.status === "failed"
            ? "Feature task session failed."
            : "Feature task session ended without validated finalization.");
      }
      return publish();
    },
    fail(error) {
      state.status = "failed";
      state.error = error;
      state.active = false;
      return publish();
    },
    cancel() {
      state.status = "cancelled";
      state.error = "Feature task was cancelled.";
      state.active = false;
      return publish();
    },
    snapshot,
    isValidated() {
      return (
        state.status === "validated" ||
        state.status === "satisfied_without_changes"
      );
    },
  };
  publish();
  return runtime;
}

export interface FeatureReviewRuntime {
  readonly host: FeatureTaskToolHost;
  begin(expectedHead: string): void;
  snapshot(): FeatureTaskSnapshot;
}

export function createFeatureReviewRuntime(options: {
  readonly runId: string;
  readonly workingDir: string;
  readonly checks: ReadonlyArray<FeatureExecutionCheck>;
  readonly runCheck?: FeatureCheckRunner;
  readonly signal?: AbortSignal;
  readonly onSnapshot?: (snapshot: FeatureTaskSnapshot) => void;
  readonly canonicalPlan?: FeatureCanonicalPlan;
  readonly graph?: FeatureExecutionGraph;
  readonly diffBaseCommit?: string;
  readonly knownResidualPaths?: ReadonlyArray<string>;
  readonly knownTrackedResiduals?: ReadonlyArray<FeatureTrackedResidualState>;
}) {
  let runtime: FeatureTaskRuntime | undefined;
  let expected: string | undefined;
  const signal = options.signal ?? new AbortController().signal;
  const unavailable = () => {
    throw new Error("Final Astra review is not active.");
  };
  const host: FeatureTaskToolHost = {
    diff: (request) => runtime?.host.diff(request) ?? unavailable(),
    check: (request) => runtime?.host.check(request) ?? unavailable(),
    finalize: (request) => runtime?.host.finalize(request) ?? unavailable(),
  };
  const review = {
    host,
    begin(expectedHead: string) {
      if (runtime || expected)
        throw new Error("Final Astra review already began.");
      const target = createFeatureRootTaskGitTarget(
        options.workingDir,
        options.knownResidualPaths,
        options.knownTrackedResiduals,
      );
      if (target.head() !== expectedHead) {
        throw new Error(
          `Final review expected HEAD ${expectedHead}, found ${target.head()}.`,
        );
      }
      expected = expectedHead;
      const canonicalPlan =
        options.canonicalPlan ??
        ({
          reportType: "feature-canonical-plan-v1",
          summary: "Final review of the accepted feature implementation.",
          decisions: [],
          changes: [],
          contracts: [],
          acceptance: [],
          verification: [],
          risks: [],
          blockers: [],
          finalRationale: "The persistent finalizer owns final acceptance.",
        } satisfies FeatureCanonicalPlan);
      const graph =
        options.graph ??
        ({
          reportType: "feature-execution-graph-v1",
          summary: "Final review checks",
          baselineChecks: [],
          reviewChecks: [...options.checks],
          tasks: [],
        } satisfies FeatureExecutionGraph);
      runtime = createFeatureTaskRuntime({
        kind: "final-review",
        id: "__final-review",
        objective: "Review and finalize the complete integrated feature.",
        canonicalPlan,
        graph,
        target,
        taskBaseCommit: expectedHead,
        diffBaseCommit: options.diffBaseCommit,
        checks: options.checks,
        runCheck: options.runCheck,
        signal,
        preparationBaseline: target.inspect(expectedHead).untracked,
        knownResidualPaths: options.knownResidualPaths,
        onSnapshot: options.onSnapshot,
      });
      runtime.beginAttempt(1);
    },
    snapshot() {
      return (
        runtime?.snapshot() ?? {
          id: "__final-review",
          kind: "final-review",
          objective: "Review and finalize the complete integrated feature.",
          status: "waiting",
          attempt: 0,
          attempts: [],
          branchId: "root",
          branch: "",
          worktree: options.workingDir,
          checks: [],
          warnings: [],
          residualPaths: [...new Set(options.knownResidualPaths ?? [])].sort(),
        }
      );
    },
  } satisfies FeatureReviewRuntime;
  return review;
}
