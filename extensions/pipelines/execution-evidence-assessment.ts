import type { FeatureGraphEvidenceEvent } from "./feature-graph-executor.ts";
import {
  summarizeForkConcurrency,
  type ForkConcurrencySummary,
  type RunConcurrencyInterval,
} from "./run-concurrency.ts";
import type { AcceptanceCriterion } from "./run-acceptance.ts";
import type { RunEvent } from "./run-evidence.ts";

export interface ExecutionEvidenceAssessmentInput {
  readonly events: ReadonlyArray<RunEvent>;
  readonly graphEvents: ReadonlyArray<FeatureGraphEvidenceEvent>;
  readonly completeness: "complete" | "incomplete";
  readonly state: "provisional" | "final";
  readonly featureGraphRequired: boolean;
  /**
   * Monotonic clock value at the run-evidence offset origin. `RunEvent.offsetMs`
   * is relative to this value, while graph evidence `atMs` is already absolute.
   * Omitting it deliberately prevents a cross-clock concurrency claim.
   */
  readonly runStartMs?: number;
}

/** JSON-safe per-fork output from `summarizeForkConcurrency`.
 *
 * An empty record means that no fork summary is available; the graph and
 * concurrency criteria carry the explicit `not_applicable`/`unproven` status.
 */
export type ExecutionEvidenceConcurrency = Readonly<
  Record<string, ForkConcurrencySummary>
>;

export interface ExecutionEvidenceAssessment {
  readonly concurrency: ExecutionEvidenceConcurrency;
  readonly criteria: AcceptanceCriterion[];
}

type EventWithOrder = {
  readonly event: RunEvent;
  readonly order: number;
};

type TaskTurn = {
  readonly start: RunEvent;
  readonly settled?: RunEvent;
  readonly order: number;
};

type ForkIndex = {
  readonly forkId: string;
  readonly eligibleBranches: Set<string>;
  readonly branchTasks: Map<string, Set<string>>;
};

type JoinIndex = {
  readonly forkId: string;
  readonly joinId: string;
  readonly branchId: string;
  readonly starts: Array<{
    readonly event: FeatureGraphEvidenceEvent;
    readonly order: number;
  }>;
  readonly finishes: Array<{
    readonly event: FeatureGraphEvidenceEvent;
    readonly order: number;
  }>;
  malformed: boolean;
};

type GraphIndex = {
  readonly forks: Map<string, ForkIndex>;
  readonly joins: Map<string, JoinIndex>;
  readonly membershipsByTask: Map<
    string,
    Array<{ readonly forkId: string; readonly branchId: string }>
  >;
  readonly malformed: boolean;
  readonly incomplete: boolean;
  readonly controllerIds: Set<string>;
};

const VALID_DEPENDENCY_STATUSES = new Set([
  "validated",
  "satisfied_without_changes",
]);

const LEGITIMATE_RETENTION_REASONS = new Set([
  "caller_owned",
  "cancelled",
  "cleanup_entry_limit",
  "failed",
  "legacy_cleanup_retains_ref",
  "limited",
  "no_controller_ownership",
  "untracked_cleanup_disabled",
  "untracked_cleanup_limit_exceeded",
  "wallclock_limited",
  "tracked_or_staged_residual",
]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNonnegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fact(event: RunEvent, key: string) {
  return event.facts?.[key];
}

function factString(event: RunEvent, key: string) {
  const value = fact(event, key);
  return nonEmptyString(value) ? value : undefined;
}

function bounded(value: string, limit = 4_096) {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function compareEvents(left: EventWithOrder, right: EventWithOrder) {
  if (left.event.sequence !== right.event.sequence) {
    return left.event.sequence - right.event.sequence;
  }
  if (left.event.offsetMs !== right.event.offsetMs) {
    return left.event.offsetMs - right.event.offsetMs;
  }
  return left.order - right.order;
}

function orderedEvents(events: ReadonlyArray<RunEvent>) {
  return events
    .map((event, order) => ({ event, order }))
    .sort(compareEvents)
    .map((value, order) => ({ ...value, order }));
}

function optionalIdentity(event: RunEvent) {
  return {
    taskId: nonEmptyString(event.taskId) ? event.taskId : undefined,
    sessionId: nonEmptyString(event.sessionId) ? event.sessionId : undefined,
    turnId: nonEmptyString(event.turnId) ? event.turnId : undefined,
    attemptId: nonEmptyString(event.attemptId) ? event.attemptId : undefined,
  };
}

function lifecycleCompatibility(start: RunEvent, settled: RunEvent) {
  const left = optionalIdentity(start);
  const right = optionalIdentity(settled);
  if (left.taskId !== right.taskId) return false;
  if (left.sessionId && right.sessionId && left.sessionId !== right.sessionId)
    return false;
  if (left.turnId && right.turnId && left.turnId !== right.turnId) return false;
  if (left.attemptId && right.attemptId && left.attemptId !== right.attemptId)
    return false;
  return Boolean(
    (left.sessionId && right.sessionId) || (left.turnId && right.turnId),
  );
}

function lifecycleSpecificity(start: RunEvent, settled: RunEvent) {
  const left = optionalIdentity(start);
  const right = optionalIdentity(settled);
  let score = 0;
  if (left.turnId && right.turnId && left.turnId === right.turnId) score += 4;
  if (left.sessionId && right.sessionId && left.sessionId === right.sessionId) {
    score += 2;
  }
  if (left.attemptId && right.attemptId && left.attemptId === right.attemptId)
    score += 1;
  return score;
}

function pairTaskTurns(events: ReadonlyArray<RunEvent>) {
  const ordered = orderedEvents(events);
  const starts = ordered.filter(({ event }) => event.kind === "run_started");
  const settles = ordered.filter(({ event }) => event.kind === "settled");
  const usedStarts = new Set<number>();
  const turns: TaskTurn[] = starts.map(({ event, order }) => ({
    start: event,
    order,
  }));
  const unmatchedSettles: EventWithOrder[] = [];

  for (const settled of settles) {
    const candidates = starts
      .filter(
        (start) =>
          !usedStarts.has(start.order) &&
          start.order < settled.order &&
          lifecycleCompatibility(start.event, settled.event),
      )
      .sort(
        (left, right) =>
          lifecycleSpecificity(right.event, settled.event) -
            lifecycleSpecificity(left.event, settled.event) ||
          left.order - right.order,
      );
    const match = candidates[0];
    if (!match) {
      unmatchedSettles.push(settled);
      continue;
    }
    usedStarts.add(match.order);
    const turn = turns.find(({ order }) => order === match.order);
    if (!turn) continue;
    const index = turns.indexOf(turn);
    turns[index] = {
      ...turn,
      settled: settled.event,
    };
  }

  return {
    turns,
    unmatchedSettles,
    unmatchedStarts: turns.filter(({ settled }) => !settled),
    ordered,
  };
}

function runTime(event: RunEvent, runStartMs: number | undefined) {
  if (
    !finiteNonnegative(event.offsetMs) ||
    !finiteNonnegative(runStartMs) ||
    runStartMs === undefined
  ) {
    return undefined;
  }
  const value = runStartMs + event.offsetMs;
  return finiteNonnegative(value) ? value : undefined;
}

function graphTime(event: FeatureGraphEvidenceEvent) {
  return finiteNonnegative(event.atMs) ? event.atMs : undefined;
}

function forkFor(forks: Map<string, ForkIndex>, forkId: string) {
  const existing = forks.get(forkId);
  if (existing) return existing;
  const created: ForkIndex = {
    forkId,
    eligibleBranches: new Set(),
    branchTasks: new Map(),
  };
  forks.set(forkId, created);
  return created;
}

function branchTasksFor(fork: ForkIndex, branchId: string) {
  const existing = fork.branchTasks.get(branchId);
  if (existing) return existing;
  const created = new Set<string>();
  fork.branchTasks.set(branchId, created);
  return created;
}

function addDependencyMembership(
  fork: ForkIndex,
  branchId: string,
  dependency: FeatureGraphEvidenceEvent["dependencies"][number],
) {
  if (dependency.branchId !== branchId) return false;
  if (!nonEmptyString(dependency.taskId)) return false;
  branchTasksFor(fork, branchId).add(dependency.taskId);
  return true;
}

function buildGraphIndex(
  graphEvents: ReadonlyArray<FeatureGraphEvidenceEvent>,
) {
  const forks = new Map<string, ForkIndex>();
  const joins = new Map<string, JoinIndex>();
  const controllerIds = new Set<string>();
  let malformed = false;

  for (const [order, event] of graphEvents.entries()) {
    if (nonEmptyString(event.controllerInstanceId)) {
      controllerIds.add(event.controllerInstanceId);
    } else {
      malformed = true;
    }
    if (!nonEmptyString(event.forkId) || !nonEmptyString(event.branchId)) {
      malformed = true;
      continue;
    }
    const fork = forkFor(forks, event.forkId);
    if (event.kind === "fork_eligible") {
      if (event.status !== "eligible") malformed = true;
      fork.eligibleBranches.add(event.branchId);
      branchTasksFor(fork, event.branchId);
      for (const dependency of event.dependencies) {
        if (!addDependencyMembership(fork, event.branchId, dependency)) {
          malformed = true;
        }
      }
      continue;
    }
    if (event.kind === "branch_task_membership") {
      if (event.status !== "member") malformed = true;
      if (!nonEmptyString(event.taskId)) {
        malformed = true;
        continue;
      }
      branchTasksFor(fork, event.branchId).add(event.taskId);
      continue;
    }
    if (!nonEmptyString(event.joinId)) {
      malformed = true;
      continue;
    }
    const key = `${event.forkId}\u0000${event.joinId}`;
    let join = joins.get(key);
    if (!join) {
      join = {
        forkId: event.forkId,
        joinId: event.joinId,
        branchId: event.branchId,
        starts: [],
        finishes: [],
        malformed: false,
      };
      joins.set(key, join);
    }
    if (join.branchId !== event.branchId) join.malformed = true;
    if (event.kind === "join_started") {
      join.starts.push({ event, order });
    } else if (event.kind === "join_finished") {
      join.finishes.push({ event, order });
    } else {
      join.malformed = true;
    }
  }

  let incomplete = false;
  for (const fork of forks.values()) {
    if (fork.eligibleBranches.size === 0) {
      incomplete = true;
      continue;
    }
    for (const branchId of fork.eligibleBranches) {
      const tasks = fork.branchTasks.get(branchId);
      if (!tasks || tasks.size === 0) incomplete = true;
    }
    for (const branchId of fork.branchTasks.keys()) {
      if (!fork.eligibleBranches.has(branchId)) malformed = true;
    }
  }

  const membershipsByTask = new Map<
    string,
    Array<{ readonly forkId: string; readonly branchId: string }>
  >();
  for (const fork of forks.values()) {
    const taskBranches = new Map<string, string>();
    for (const [branchId, taskIds] of fork.branchTasks) {
      if (
        fork.eligibleBranches.size > 0 &&
        !fork.eligibleBranches.has(branchId)
      ) {
        continue;
      }
      for (const taskId of taskIds) {
        const previousBranch = taskBranches.get(taskId);
        if (previousBranch && previousBranch !== branchId) malformed = true;
        taskBranches.set(taskId, branchId);
        const memberships = membershipsByTask.get(taskId) ?? [];
        if (
          !memberships.some(
            (membership) =>
              membership.forkId === fork.forkId &&
              membership.branchId === branchId,
          )
        ) {
          memberships.push({ forkId: fork.forkId, branchId });
        }
        membershipsByTask.set(taskId, memberships);
      }
    }
  }

  return {
    forks,
    joins,
    membershipsByTask,
    malformed,
    incomplete,
    controllerIds,
  } satisfies GraphIndex;
}

function locationKey(forkId: string, branchId: string, taskId: string) {
  return `${forkId}\u0000${branchId}\u0000${taskId}`;
}

function buildIntervals(
  turns: ReadonlyArray<TaskTurn>,
  graph: GraphIndex,
  runStartMs: number | undefined,
) {
  const intervals: RunConcurrencyInterval[] = [];
  const turnsByLocation = new Map<string, TaskTurn[]>();
  let malformed = false;
  for (const turn of turns) {
    const taskId = nonEmptyString(turn.start.taskId)
      ? turn.start.taskId
      : undefined;
    if (!taskId) continue;
    const memberships = graph.membershipsByTask.get(taskId);
    if (!memberships || memberships.length === 0) continue;
    const startedAtMs = runTime(turn.start, runStartMs);
    const finishedAtMs = turn.settled
      ? runTime(turn.settled, runStartMs)
      : null;
    const controllerInstanceId = nonEmptyString(turn.start.controllerInstanceId)
      ? turn.start.controllerInstanceId
      : "unknown-controller";
    const attemptId = nonEmptyString(turn.start.attemptId)
      ? turn.start.attemptId
      : `${turn.start.sessionId ?? "session"}:${turn.start.turnId ?? turn.order}`;
    if (!nonEmptyString(turn.start.attemptId)) malformed = true;
    for (const membership of memberships) {
      intervals.push({
        controllerInstanceId,
        forkId: membership.forkId,
        branchId: membership.branchId,
        attemptId,
        startedAtMs: startedAtMs ?? Number.NaN,
        finishedAtMs: finishedAtMs === undefined ? Number.NaN : finishedAtMs,
      });
      const key = locationKey(membership.forkId, membership.branchId, taskId);
      const located = turnsByLocation.get(key) ?? [];
      located.push(turn);
      turnsByLocation.set(key, located);
    }
  }
  return { intervals, turnsByLocation, malformed };
}

function eligibleBranchesFor(fork: ForkIndex) {
  return fork.eligibleBranches.size > 0
    ? fork.eligibleBranches
    : new Set(fork.branchTasks.keys());
}

function buildConcurrency(
  graph: GraphIndex,
  intervals: ReadonlyArray<RunConcurrencyInterval>,
  required: boolean,
) {
  if (!required) return {} satisfies ExecutionEvidenceConcurrency;
  const eligible = new Map<string, ReadonlySet<string>>();
  for (const fork of [...graph.forks.values()].sort((left, right) =>
    left.forkId.localeCompare(right.forkId),
  )) {
    eligible.set(fork.forkId, eligibleBranchesFor(fork));
  }
  const reduced = summarizeForkConcurrency(intervals, eligible);
  const summaries = Object.fromEntries(
    [...reduced.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return summaries satisfies ExecutionEvidenceConcurrency;
}

function criterion(
  id: string,
  status: AcceptanceCriterion["status"],
  detail: string,
  evidenceRefs: ReadonlyArray<string> = [],
) {
  return {
    id,
    status,
    evidenceRefs: [...evidenceRefs],
    detail: bounded(detail, 16 * 1024),
  } satisfies AcceptanceCriterion;
}

function downgradeForIncomplete(
  status: AcceptanceCriterion["status"],
  completeness: ExecutionEvidenceAssessmentInput["completeness"],
) {
  return completeness === "incomplete" && status === "passed"
    ? ("unproven" as const)
    : status;
}

function assessProvenance(
  events: ReadonlyArray<RunEvent>,
  completeness: ExecutionEvidenceAssessmentInput["completeness"],
  state: ExecutionEvidenceAssessmentInput["state"],
) {
  const sessions = orderedEvents(events)
    .filter(({ event }) => event.kind === "session_created")
    .map(({ event }) => event);
  const invalid: string[] = [];
  const selections: string[] = [];
  let servingRevisionCount = 0;
  for (const [index, event] of sessions.entries()) {
    const requested = factString(event, "requestedModel");
    const selected = factString(event, "model");
    const provider = factString(event, "provider");
    const servingRevision = fact(event, "servingRevision");
    if (!requested || !selected || !provider) {
      invalid.push(
        `session_created[${index}] is missing requested/provider/model metadata`,
      );
    } else {
      selections.push(`${requested} -> ${selected}`);
    }
    if (servingRevision !== undefined && servingRevision !== null) {
      if (!nonEmptyString(servingRevision)) {
        invalid.push(
          `session_created[${index}] has an invalid serving revision`,
        );
      } else {
        servingRevisionCount++;
      }
    }
  }
  let status: AcceptanceCriterion["status"];
  if (sessions.length === 0 || invalid.length > 0) {
    status = "unproven";
  } else {
    status = downgradeForIncomplete("passed", completeness);
  }
  const detail =
    sessions.length === 0
      ? `No session_created metadata was observed during the ${state} assessment; requested versus selected provider model is unproven.`
      : invalid.length > 0
        ? `${invalid.length} session metadata record(s) are incomplete. Requested versus selected model provenance is unproven; serving revision is optional.`
        : `Observed ${sessions.length} requested/selected provider model record(s) (${selections.slice(0, 8).join(", ")}). Serving revision was present for ${servingRevisionCount} record(s) and is optional. This records metadata only and makes no provider-compute claim.`;
  return criterion("model-provenance", status, detail, [
    ...(sessions.length > 0 ? ["run-events:session_created"] : []),
  ]);
}

function sameSpawnIdentity(left: RunEvent, right: RunEvent) {
  if (!nonEmptyString(left.sessionId) || !nonEmptyString(right.sessionId))
    return false;
  if (left.sessionId !== right.sessionId) return false;
  if (
    nonEmptyString(left.attemptId) &&
    nonEmptyString(right.attemptId) &&
    left.attemptId !== right.attemptId
  ) {
    return false;
  }
  return true;
}

function assessAttempts(
  events: ReadonlyArray<RunEvent>,
  completeness: ExecutionEvidenceAssessmentInput["completeness"],
) {
  const paired = pairTaskTurns(events);
  const spawnRequests = paired.ordered.filter(
    ({ event }) => event.kind === "spawn_requested",
  );
  const spawnClosures = paired.ordered.filter(({ event }) =>
    ["spawn_failed", "cancelled", "disposed"].includes(event.kind),
  );
  const openSpawns = spawnRequests.filter(({ event: request }) => {
    const hasSessionLifecycle = paired.ordered.some(
      ({ event }) =>
        event.kind === "settled" &&
        sameSpawnIdentity(request, event) &&
        event.sequence >= request.sequence,
    );
    const hasClosure = spawnClosures.some(
      ({ event }) =>
        sameSpawnIdentity(request, event) && event.sequence >= request.sequence,
    );
    return !hasSessionLifecycle && !hasClosure;
  });
  const startupFailures = paired.ordered.filter(({ event }) =>
    ["spawn_failed", "provider_startup"].includes(event.kind),
  );
  const recoveredFailures = startupFailures.filter(({ event: failure }) =>
    paired.turns.some(
      (turn) =>
        nonEmptyString(failure.taskId) &&
        turn.start.taskId === failure.taskId &&
        turn.order >
          (paired.ordered.find(({ event }) => event === failure)?.order ??
            -1) &&
        Boolean(turn.settled),
    ),
  );
  const lifecycleObserved =
    paired.turns.length > 0 ||
    paired.unmatchedSettles.length > 0 ||
    spawnRequests.length > 0 ||
    startupFailures.length > 0;
  const issueCount =
    paired.unmatchedStarts.length +
    paired.unmatchedSettles.length +
    openSpawns.length;
  const status =
    !lifecycleObserved || issueCount > 0
      ? "unproven"
      : downgradeForIncomplete("passed", completeness);
  const detail = !lifecycleObserved
    ? "No task/session attempt lifecycle evidence was observed; completed lifecycle state alone is not proof."
    : issueCount > 0
      ? `${paired.unmatchedStarts.length} run_started turn(s), ${paired.unmatchedSettles.length} settled turn(s), or ${openSpawns.length} spawn request(s) lack a matching closure. Open turns are unproven.`
      : `All observed turns and spawn paths are closed. ${startupFailures.length} provider startup failure(s) were recorded, with ${recoveredFailures.length} recovered task path(s); failure history is not treated as blanket task failure.`;
  return criterion("attempts-closed", status, detail, [
    ...(paired.turns.length > 0 ? ["run-events:turns"] : []),
    ...(spawnRequests.length > 0 || startupFailures.length > 0
      ? ["run-events:spawn"]
      : []),
  ]);
}

function expectedDependencies(fork: ForkIndex, branchIds: ReadonlySet<string>) {
  const expected = new Set<string>();
  for (const branchId of branchIds) {
    for (const taskId of fork.branchTasks.get(branchId) ?? []) {
      expected.add(`${branchId}\u0000${taskId}`);
    }
  }
  return expected;
}

function dependencyState(
  event: FeatureGraphEvidenceEvent,
  fork: ForkIndex | undefined,
  expected: ReadonlySet<string>,
) {
  if (!fork) return "unproven" as const;
  if (event.dependencies.length === 0 && expected.size > 0) {
    return "failed" as const;
  }
  const seen = new Set<string>();
  let failed = false;
  for (const dependency of event.dependencies) {
    const key = `${dependency.branchId}\u0000${dependency.taskId}`;
    if (seen.has(key)) failed = true;
    seen.add(key);
    if (!expected.has(key)) failed = true;
    if (!fork.branchTasks.get(dependency.branchId)?.has(dependency.taskId)) {
      failed = true;
    }
    if (!VALID_DEPENDENCY_STATUSES.has(dependency.status)) failed = true;
  }
  if (seen.size !== expected.size) failed = true;
  return failed ? ("failed" as const) : ("valid" as const);
}

function orderingState(
  dependencies: FeatureGraphEvidenceEvent["dependencies"],
  forkId: string,
  turnsByLocation: ReadonlyMap<string, ReadonlyArray<TaskTurn>>,
  atMs: number | undefined,
  runStartMs: number | undefined,
) {
  if (atMs === undefined || !finiteNonnegative(runStartMs)) {
    return "unproven" as const;
  }
  let unknown = false;
  for (const dependency of dependencies) {
    const turns = turnsByLocation.get(
      locationKey(forkId, dependency.branchId, dependency.taskId),
    );
    if (!turns || turns.length === 0) {
      unknown = true;
      continue;
    }
    let sawValidTurn = false;
    for (const turn of turns) {
      const startAtMs = runTime(turn.start, runStartMs);
      if (startAtMs === undefined) {
        unknown = true;
        continue;
      }
      sawValidTurn = true;
      if (startAtMs > atMs) return "failed" as const;
      if (!turn.settled) return "failed" as const;
      const finishedAtMs = runTime(turn.settled, runStartMs);
      if (finishedAtMs === undefined) {
        unknown = true;
        continue;
      }
      if (finishedAtMs > atMs) return "failed" as const;
    }
    if (!sawValidTurn) unknown = true;
  }
  return unknown ? ("unproven" as const) : ("valid" as const);
}

function assessOneJoin(
  join: JoinIndex,
  graph: GraphIndex,
  turnsByLocation: ReadonlyMap<string, ReadonlyArray<TaskTurn>>,
  runStartMs: number | undefined,
) {
  if (join.malformed || join.starts.length > 1 || join.finishes.length > 1) {
    return "failed" as const;
  }
  const start = join.starts[0];
  const finish = join.finishes[0];
  if (!start) {
    return finish?.event.status === "failed" ||
      finish?.event.status === "cancelled"
      ? ("failed" as const)
      : ("unproven" as const);
  }
  const fork = graph.forks.get(join.forkId);
  const eligibleBranches = fork ? eligibleBranchesFor(fork) : new Set<string>();
  const expected = expectedDependencies(
    fork ?? {
      forkId: join.forkId,
      eligibleBranches: new Set(),
      branchTasks: new Map(),
    },
    eligibleBranches,
  );
  if (start.event.status !== "joining") return "failed" as const;
  const startDependencies = dependencyState(start.event, fork, expected);
  if (startDependencies === "failed") return "failed" as const;
  const startOrder = orderingState(
    start.event.dependencies,
    join.forkId,
    turnsByLocation,
    graphTime(start.event),
    runStartMs,
  );
  if (startOrder === "failed") return "failed" as const;

  if (!finish) return "unproven" as const;
  if (finish.order < start.order) return "failed" as const;
  const startAtMs = graphTime(start.event);
  const finishAtMs = graphTime(finish.event);
  if (startAtMs === undefined || finishAtMs === undefined) {
    return "unproven" as const;
  }
  if (finishAtMs < startAtMs) return "failed" as const;
  const finishDependencies = dependencyState(finish.event, fork, expected);
  if (finish.event.status !== "completed") return "failed" as const;
  if (finishDependencies === "failed") return "failed" as const;
  const finishOrder = orderingState(
    finish.event.dependencies,
    join.forkId,
    turnsByLocation,
    finishAtMs,
    runStartMs,
  );
  if (finishOrder === "failed") return "failed" as const;
  if (
    startDependencies === "unproven" ||
    finishDependencies === "unproven" ||
    startOrder === "unproven" ||
    finishOrder === "unproven"
  ) {
    return "unproven" as const;
  }
  return "valid" as const;
}

function assessJoins(
  graph: GraphIndex,
  turnsByLocation: ReadonlyMap<string, ReadonlyArray<TaskTurn>>,
  input: ExecutionEvidenceAssessmentInput,
) {
  if (!input.featureGraphRequired) {
    return criterion(
      "join-ordering",
      "not_applicable",
      "Feature graph joins are not applicable for this pipeline definition.",
    );
  }
  if (graph.forks.size === 0) {
    return criterion(
      "join-ordering",
      "unproven",
      "Feature graph evidence is absent; join ordering cannot be inferred from lifecycle state.",
    );
  }
  const activeForks = [...graph.forks.values()].filter(
    (fork) => eligibleBranchesFor(fork).size >= 2,
  );
  if (activeForks.length === 0) {
    return criterion(
      "join-ordering",
      graph.malformed || graph.incomplete ? "unproven" : "not_applicable",
      graph.malformed || graph.incomplete
        ? "Feature graph fork evidence is incomplete; join ordering is unproven."
        : "No fork with at least two eligible branches was observed.",
    );
  }
  const outcomes: Array<"valid" | "failed" | "unproven"> = [];
  for (const fork of activeForks) {
    const joins = [...graph.joins.values()].filter(
      (join) => join.forkId === fork.forkId,
    );
    if (joins.length === 0) {
      outcomes.push("unproven");
      continue;
    }
    for (const join of joins) {
      outcomes.push(
        assessOneJoin(join, graph, turnsByLocation, input.runStartMs),
      );
    }
  }
  const status = outcomes.includes("failed")
    ? ("failed" as const)
    : outcomes.includes("unproven") ||
        graph.malformed ||
        graph.incomplete ||
        input.completeness === "incomplete"
      ? ("unproven" as const)
      : ("passed" as const);
  const detail =
    status === "failed"
      ? "Join evidence contains a premature/invalid join or a completed join with non-validated dependency status."
      : status === "unproven"
        ? "Join ordering and validated dependency status are not fully proven; missing graph or turn evidence is not treated as success."
        : `All ${outcomes.length} observed join(s) started after closed task turns and carried validated or satisfied_without_changes dependencies.`;
  return criterion("join-ordering", status, detail, [
    "graph-events:joins",
    ...(turnsByLocation.size > 0 ? ["run-events:task-turns"] : []),
  ]);
}

function assessConcurrency(
  graph: GraphIndex,
  concurrency: ExecutionEvidenceConcurrency,
  input: ExecutionEvidenceAssessmentInput,
) {
  if (!input.featureGraphRequired) {
    return criterion(
      "concurrency",
      "not_applicable",
      "Feature graph concurrency is not applicable for this pipeline definition.",
    );
  }
  if (graph.forks.size === 0) {
    return criterion(
      "concurrency",
      "unproven",
      "Feature graph evidence is absent; concurrency cannot be inferred from lifecycle state.",
    );
  }
  const activeForks = Object.values(concurrency).filter(
    ({ eligibleBranches }) => eligibleBranches >= 2,
  );
  if (activeForks.length === 0) {
    return criterion(
      "concurrency",
      graph.malformed || graph.incomplete ? "unproven" : "not_applicable",
      graph.malformed || graph.incomplete
        ? "Feature graph fork evidence is incomplete; concurrency is unproven."
        : "No fork with at least two eligible branches was observed.",
    );
  }
  const complete = activeForks.every(
    ({ complete, status }) => complete && status !== "unknown",
  );
  const overlapObserved = activeForks.every(
    ({ status }) => status === "observed",
  );
  const status =
    complete && overlapObserved && !graph.malformed && !graph.incomplete
      ? downgradeForIncomplete("passed", input.completeness)
      : ("unproven" as const);
  const summary = activeForks
    .map(
      ({ eligibleBranches, startedBranches, status: forkStatus, overlapMs }) =>
        `${eligibleBranches} eligible/${startedBranches} started, ${forkStatus}, overlap ${overlapMs}ms`,
    )
    .join("; ");
  const detail = `${summary}. Intervals are controller task-turn intervals only; this does not claim provider-side computation.`;
  return criterion("concurrency", status, detail, [
    "graph-events:forks",
    "run-events:task-turns",
  ]);
}

function cleanupFacts(event: RunEvent) {
  return {
    operationId: nonEmptyString(event.operationId)
      ? event.operationId
      : undefined,
    resourceId: factString(event, "resourceId"),
    resourceType: factString(event, "resourceType"),
    resource: factString(event, "resource"),
    ownership: factString(event, "ownership"),
    phase: factString(event, "phase"),
    expectedIdentity: factString(event, "expectedIdentity"),
    disposition: factString(event, "disposition"),
    operationStatus: factString(event, "operationStatus"),
    reasonCode: factString(event, "reasonCode"),
  };
}

function identifiableCleanupTarget(facts: ReturnType<typeof cleanupFacts>) {
  return (
    facts.resourceType !== undefined &&
    facts.resource !== undefined &&
    facts.ownership !== undefined &&
    facts.expectedIdentity !== undefined
  );
}

function sameCleanupTarget(
  left: ReturnType<typeof cleanupFacts>,
  right: ReturnType<typeof cleanupFacts>,
) {
  return (
    identifiableCleanupTarget(left) &&
    identifiableCleanupTarget(right) &&
    left.resourceId === right.resourceId &&
    left.resourceType === right.resourceType &&
    left.resource === right.resource &&
    left.ownership === right.ownership &&
    left.expectedIdentity === right.expectedIdentity
  );
}

function validatedCleanupRemoval(
  intents: ReadonlyArray<EventWithOrder>,
  outcomes: ReadonlyArray<EventWithOrder>,
) {
  if (intents.length !== 1 || outcomes.length !== 1) return undefined;
  const intent = intents[0]!;
  const outcome = outcomes[0]!;
  if (outcome.order < intent.order) return undefined;
  const intentFacts = cleanupFacts(intent.event);
  const outcomeFacts = cleanupFacts(outcome.event);
  if (!sameCleanupTarget(intentFacts, outcomeFacts)) return undefined;
  if (
    outcomeFacts.operationStatus !== "succeeded" ||
    outcomeFacts.disposition !== "removed"
  ) {
    return undefined;
  }
  return { intent, outcome, intentFacts, outcomeFacts };
}

function recoverableRuntimeParentFailure(
  intents: ReadonlyArray<EventWithOrder>,
  outcomes: ReadonlyArray<EventWithOrder>,
) {
  if (intents.length !== 1 || outcomes.length !== 1) return undefined;
  const intent = intents[0]!;
  const outcome = outcomes[0]!;
  if (outcome.order < intent.order) return undefined;
  const intentFacts = cleanupFacts(intent.event);
  const outcomeFacts = cleanupFacts(outcome.event);
  if (
    !sameCleanupTarget(intentFacts, outcomeFacts) ||
    outcomeFacts.resourceType !== "directory" ||
    outcomeFacts.ownership !== "controller" ||
    outcomeFacts.disposition !== "retained" ||
    outcomeFacts.operationStatus !== "failed" ||
    outcomeFacts.reasonCode !== "runtime_parent_nonempty"
  ) {
    return undefined;
  }
  return { outcome, outcomeFacts };
}

function legitimateRetention(
  ownership: string | undefined,
  reasonCode: string | undefined,
) {
  if (!reasonCode) return false;
  if (ownership === "caller" && reasonCode === "caller_owned") return true;
  if (reasonCode === "no_controller_ownership") return true;
  return LEGITIMATE_RETENTION_REASONS.has(reasonCode);
}

function legitimateOutcomeOnlyNoOp(facts: ReturnType<typeof cleanupFacts>) {
  const noControllerOwnership =
    facts.ownership === "unknown" &&
    facts.operationStatus === "not_attempted" &&
    (facts.disposition === "skipped" || facts.disposition === "retained") &&
    facts.reasonCode === "no_controller_ownership";
  const deferredSandboxCleanup =
    facts.ownership === "controller" &&
    facts.resourceType === "sandbox" &&
    facts.resource !== undefined &&
    facts.phase === "feature-sandbox-runtime-cleanup" &&
    facts.expectedIdentity !== undefined &&
    facts.disposition === "retained" &&
    facts.operationStatus === "not_attempted" &&
    facts.reasonCode === "workspace_still_present";
  return noControllerOwnership || deferredSandboxCleanup;
}

function assessCleanup(
  events: ReadonlyArray<RunEvent>,
  completeness: ExecutionEvidenceAssessmentInput["completeness"],
) {
  const ordered = orderedEvents(events);
  const intents = new Map<string, EventWithOrder[]>();
  const outcomes = new Map<string, EventWithOrder[]>();
  let malformed = 0;
  for (const item of ordered) {
    if (
      item.event.kind !== "cleanup_intent" &&
      item.event.kind !== "cleanup_outcome"
    )
      continue;
    const operationId = cleanupFacts(item.event).operationId;
    if (!operationId) {
      malformed++;
      continue;
    }
    const target = item.event.kind === "cleanup_intent" ? intents : outcomes;
    const entries = target.get(operationId) ?? [];
    entries.push(item);
    target.set(operationId, entries);
  }
  const operationIds = new Set([...intents.keys(), ...outcomes.keys()]);
  if (operationIds.size === 0 || malformed > 0) {
    return criterion(
      "cleanup-policy",
      "unproven",
      operationIds.size === 0
        ? "No cleanup intent/outcome evidence was observed; absence is not success."
        : `${malformed} cleanup event(s) lack an operation identity; cleanup completeness is unproven.`,
    );
  }
  let failed = false;
  let unproven = false;
  let retained = 0;
  let completed = 0;
  let recoveredFailures = 0;
  for (const operationId of operationIds) {
    const operationIntents = intents.get(operationId) ?? [];
    const operationOutcomes = outcomes.get(operationId) ?? [];
    const recoverableFailure = recoverableRuntimeParentFailure(
      operationIntents,
      operationOutcomes,
    );
    const explicitFailure = operationOutcomes.some(({ event }) => {
      const operationStatus = cleanupFacts(event).operationStatus;
      return operationStatus === "failed" || operationStatus === "timed_out";
    });
    if (explicitFailure) {
      const recovered =
        recoverableFailure &&
        [...operationIds].some((candidateId) => {
          const removal = validatedCleanupRemoval(
            intents.get(candidateId) ?? [],
            outcomes.get(candidateId) ?? [],
          );
          return (
            removal !== undefined &&
            removal.intent.order > recoverableFailure.outcome.order &&
            sameCleanupTarget(
              recoverableFailure.outcomeFacts,
              removal.intentFacts,
            )
          );
        });
      if (recovered) {
        recoveredFailures++;
        completed++;
        continue;
      }
      failed = true;
      continue;
    }
    const outcomeFacts =
      operationOutcomes.length === 1
        ? cleanupFacts(operationOutcomes[0]!.event)
        : undefined;
    if (
      operationIntents.length === 0 &&
      outcomeFacts &&
      legitimateOutcomeOnlyNoOp(outcomeFacts)
    ) {
      if (outcomeFacts.disposition === "retained") retained++;
      completed++;
      continue;
    }
    if (operationIntents.length !== 1 || operationOutcomes.length !== 1) {
      unproven = true;
      continue;
    }
    const intent = operationIntents[0]!;
    const outcome = operationOutcomes[0]!;
    if (outcome.order < intent.order) {
      unproven = true;
      continue;
    }
    const facts = cleanupFacts(outcome.event);
    if (
      facts.operationStatus === "succeeded" &&
      facts.disposition === "removed"
    ) {
      completed++;
      continue;
    }
    if (
      facts.operationStatus === "not_attempted" &&
      facts.disposition === "skipped" &&
      Boolean(facts.reasonCode)
    ) {
      completed++;
      continue;
    }
    if (
      facts.operationStatus === "not_attempted" &&
      facts.disposition === "retained" &&
      legitimateRetention(facts.ownership, facts.reasonCode)
    ) {
      retained++;
      completed++;
      continue;
    }
    unproven = true;
  }
  const status = failed
    ? ("failed" as const)
    : unproven || completeness === "incomplete"
      ? ("unproven" as const)
      : ("passed" as const);
  const detail = failed
    ? "At least one cleanup outcome explicitly failed or timed out; only a later validated same-identity runtime-parent removal can recover the narrowly recognized nonempty-parent failure."
    : status === "unproven"
      ? "Cleanup intents and outcomes are incomplete or lack a recognized disposition; a missing outcome is unproven."
      : `All ${completed} cleanup operation(s) have explicit outcomes; ${retained} retained resource(s) are documented as legitimate cleanup policy rather than deletion failure. ${recoveredFailures} runtime-parent nonempty failure(s) were later removed with matching identity; raw failure history remains recorded.`;
  return criterion("cleanup-policy", status, detail, ["run-events:cleanup"]);
}

function assessPersistence(
  events: ReadonlyArray<RunEvent>,
  graphEvents: ReadonlyArray<FeatureGraphEvidenceEvent>,
  completeness: ExecutionEvidenceAssessmentInput["completeness"],
) {
  const status =
    completeness === "complete" ? ("passed" as const) : ("unproven" as const);
  return criterion(
    "evidence-persistence",
    status,
    completeness === "complete"
      ? `Controller evidence is marked complete (${events.length} run event(s), ${graphEvents.length} graph event(s)).`
      : "Controller evidence persistence is marked incomplete; missing writes are unproven rather than successful.",
    ["run-evidence:completeness"],
  );
}

function graphControllerMismatch(
  events: ReadonlyArray<RunEvent>,
  graph: GraphIndex,
) {
  const runControllers = new Set(
    events
      .filter(
        (event) => event.kind === "run_started" || event.kind === "settled",
      )
      .map((event) => event.controllerInstanceId),
  );
  if (runControllers.size > 1 || graph.controllerIds.size > 1) return true;
  if (runControllers.size === 1 && graph.controllerIds.size === 1) {
    return [...runControllers][0] !== [...graph.controllerIds][0];
  }
  return false;
}

export function assessExecutionEvidence(
  input: ExecutionEvidenceAssessmentInput,
) {
  const graph = buildGraphIndex(input.graphEvents);
  const paired = pairTaskTurns(input.events);
  const linked = buildIntervals(paired.turns, graph, input.runStartMs);
  const concurrency = buildConcurrency(
    graph,
    linked.intervals,
    input.featureGraphRequired,
  );
  const graphClockMismatch = graphControllerMismatch(input.events, graph);
  const graphCriterion = assessJoins(graph, linked.turnsByLocation, input);
  const concurrencyCriterion = assessConcurrency(graph, concurrency, input);
  const criteria = [
    assessProvenance(input.events, input.completeness, input.state),
    assessAttempts(input.events, input.completeness),
    graphCriterion,
    concurrencyCriterion,
    assessCleanup(input.events, input.completeness),
    assessPersistence(input.events, input.graphEvents, input.completeness),
  ].map((item) =>
    graphClockMismatch || linked.malformed
      ? (item.id === "join-ordering" || item.id === "concurrency") &&
        item.status === "passed"
        ? { ...item, status: "unproven" as const }
        : item
      : item,
  );
  return { concurrency, criteria } satisfies ExecutionEvidenceAssessment;
}
