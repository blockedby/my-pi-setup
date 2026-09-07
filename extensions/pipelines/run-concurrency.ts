export type ForkConcurrencyStatus =
  "observed" | "not_observed" | "not_applicable" | "unknown";

export interface RunConcurrencyInterval {
  readonly controllerInstanceId: string;
  readonly forkId: string;
  readonly branchId: string;
  readonly attemptId: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

export type ForkExecutionInterval = RunConcurrencyInterval;
export type ConcurrencyInterval = RunConcurrencyInterval;

export interface ForkConcurrencySummary {
  readonly eligibleBranches: number;
  readonly startedBranches: number;
  readonly overlapMs: number;
  readonly maxConcurrent: number;
  readonly executionWindowMs: number;
  readonly status: ForkConcurrencyStatus;
  readonly complete: boolean;
}

type BranchCollection = ReadonlyArray<string> | ReadonlySet<string>;

export type EligibleBranchesByFork =
  | ReadonlyMap<string, BranchCollection>
  | Readonly<Record<string, BranchCollection>>;

interface NormalizedEligibility {
  readonly forkId: string;
  readonly branches: ReadonlySet<string>;
}

interface NormalizedInterval extends RunConcurrencyInterval {
  readonly validTime: boolean;
}

interface ValidInterval {
  readonly branchId: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function normalizeBranches(value: unknown, forkId: string) {
  const values: string[] = [];
  if (Array.isArray(value)) {
    values.push(...value);
  } else if (value instanceof Set) {
    values.push(...value);
  } else {
    throw new TypeError(
      `Eligible branches for fork ${JSON.stringify(forkId)} must be an array or set.`,
    );
  }

  const branches = new Set<string>();
  for (const branchId of values) {
    assertNonEmptyString(
      branchId,
      `Branch ID for fork ${JSON.stringify(forkId)}`,
    );
    if (branches.has(branchId)) {
      throw new TypeError(
        `Eligible branches for fork ${JSON.stringify(forkId)} must be unique.`,
      );
    }
    branches.add(branchId);
  }
  return branches;
}

function normalizeEligibility(value: EligibleBranchesByFork) {
  const entries: NormalizedEligibility[] = [];
  if (value instanceof Map) {
    for (const [forkId, branches] of value) {
      assertNonEmptyString(forkId, "Fork ID");
      entries.push({ forkId, branches: normalizeBranches(branches, forkId) });
    }
    return entries;
  }

  if (!isRecord(value)) {
    throw new TypeError("Eligible branches per fork must be a map or record.");
  }
  for (const [forkId, branches] of Object.entries(value)) {
    assertNonEmptyString(forkId, "Fork ID");
    entries.push({ forkId, branches: normalizeBranches(branches, forkId) });
  }
  return entries;
}

function normalizeIntervals(value: ReadonlyArray<RunConcurrencyInterval>) {
  if (!Array.isArray(value)) {
    throw new TypeError("Concurrency intervals must be an array.");
  }

  return value.map((interval, index) => {
    if (!isRecord(interval)) {
      throw new TypeError(`Concurrency interval ${index} must be an object.`);
    }
    assertNonEmptyString(
      interval.controllerInstanceId,
      `controllerInstanceId for interval ${index}`,
    );
    assertNonEmptyString(interval.forkId, `forkId for interval ${index}`);
    assertNonEmptyString(interval.branchId, `branchId for interval ${index}`);
    assertNonEmptyString(interval.attemptId, `attemptId for interval ${index}`);

    const startedAtMs =
      typeof interval.startedAtMs === "number"
        ? interval.startedAtMs
        : Number.NaN;
    const finishedAtMs =
      interval.finishedAtMs === null
        ? null
        : typeof interval.finishedAtMs === "number"
          ? interval.finishedAtMs
          : Number.NaN;
    const validTime =
      Number.isFinite(startedAtMs) &&
      startedAtMs >= 0 &&
      (finishedAtMs === null ||
        (Number.isFinite(finishedAtMs) &&
          finishedAtMs >= 0 &&
          finishedAtMs >= startedAtMs));

    return {
      controllerInstanceId: interval.controllerInstanceId,
      forkId: interval.forkId,
      branchId: interval.branchId,
      attemptId: interval.attemptId,
      startedAtMs,
      finishedAtMs,
      validTime,
    } satisfies NormalizedInterval;
  });
}

function emptySummary(
  eligibleBranches: number,
  startedBranches: number,
  status: ForkConcurrencyStatus,
  complete: boolean,
): ForkConcurrencySummary {
  return {
    eligibleBranches,
    startedBranches,
    overlapMs: 0,
    maxConcurrent: 0,
    executionWindowMs: 0,
    status,
    complete,
  };
}

function summarizeValidIntervals(
  eligibleBranches: number,
  startedBranches: number,
  intervals: ReadonlyArray<ValidInterval>,
  complete: boolean,
) {
  if (intervals.length === 0) {
    return emptySummary(
      eligibleBranches,
      startedBranches,
      "not_observed",
      complete,
    );
  }

  const byBranch = new Map<string, ValidInterval[]>();
  for (const interval of intervals) {
    const branchIntervals = byBranch.get(interval.branchId) ?? [];
    branchIntervals.push(interval);
    byBranch.set(interval.branchId, branchIntervals);
  }

  const events: Array<{ readonly atMs: number; readonly delta: number }> = [];
  let earliestStartMs = Number.POSITIVE_INFINITY;
  let latestFinishMs = Number.NEGATIVE_INFINITY;

  for (const branchIntervals of byBranch.values()) {
    const sorted = [...branchIntervals].sort(
      (left, right) =>
        left.startedAtMs - right.startedAtMs ||
        left.finishedAtMs - right.finishedAtMs,
    );
    let mergedStartMs = sorted[0]!.startedAtMs;
    let mergedFinishMs = sorted[0]!.finishedAtMs;
    earliestStartMs = Math.min(earliestStartMs, mergedStartMs);
    latestFinishMs = Math.max(latestFinishMs, mergedFinishMs);

    for (const interval of sorted.slice(1)) {
      earliestStartMs = Math.min(earliestStartMs, interval.startedAtMs);
      latestFinishMs = Math.max(latestFinishMs, interval.finishedAtMs);
      if (interval.startedAtMs <= mergedFinishMs) {
        mergedFinishMs = Math.max(mergedFinishMs, interval.finishedAtMs);
        continue;
      }
      events.push(
        { atMs: mergedStartMs, delta: 1 },
        { atMs: mergedFinishMs, delta: -1 },
      );
      mergedStartMs = interval.startedAtMs;
      mergedFinishMs = interval.finishedAtMs;
    }
    events.push(
      { atMs: mergedStartMs, delta: 1 },
      { atMs: mergedFinishMs, delta: -1 },
    );
  }

  events.sort((left, right) => left.atMs - right.atMs);
  let activeBranches = 0;
  let maxConcurrent = 0;
  let overlapMs = 0;
  let previousAtMs = events[0]!.atMs;
  let eventIndex = 0;

  while (eventIndex < events.length) {
    const atMs = events[eventIndex]!.atMs;
    if (activeBranches >= 2) overlapMs += atMs - previousAtMs;

    let delta = 0;
    while (eventIndex < events.length && events[eventIndex]!.atMs === atMs) {
      delta += events[eventIndex]!.delta;
      eventIndex++;
    }
    activeBranches += delta;
    maxConcurrent = Math.max(maxConcurrent, activeBranches);
    previousAtMs = atMs;
  }

  const executionWindowMs = latestFinishMs - earliestStartMs;
  if (
    !Number.isFinite(overlapMs) ||
    !Number.isFinite(executionWindowMs) ||
    overlapMs < 0 ||
    executionWindowMs < 0
  ) {
    return emptySummary(eligibleBranches, startedBranches, "unknown", false);
  }

  return {
    eligibleBranches,
    startedBranches,
    overlapMs,
    maxConcurrent,
    executionWindowMs,
    status:
      overlapMs > 0
        ? ("observed" as const)
        : eligibleBranches < 2
          ? ("not_applicable" as const)
          : ("not_observed" as const),
    complete,
  };
}

function summarizeFork(
  eligibility: NormalizedEligibility,
  intervals: ReadonlyArray<NormalizedInterval>,
) {
  const relevant = intervals.filter(
    (interval) =>
      interval.forkId === eligibility.forkId &&
      eligibility.branches.has(interval.branchId),
  );
  const startedBranches = new Set(
    relevant.map((interval) => interval.branchId),
  );
  const complete =
    relevant.every(
      (interval) => interval.validTime && interval.finishedAtMs !== null,
    ) && startedBranches.size === eligibility.branches.size;

  const controllers = new Set(
    relevant.map((interval) => interval.controllerInstanceId),
  );
  if (controllers.size > 1) {
    return emptySummary(
      eligibility.branches.size,
      startedBranches.size,
      "unknown",
      false,
    );
  }

  if (eligibility.branches.size < 2) {
    if (
      !relevant.every(
        (interval) => interval.validTime && interval.finishedAtMs !== null,
      )
    ) {
      return emptySummary(
        eligibility.branches.size,
        startedBranches.size,
        "not_applicable",
        false,
      );
    }
    const validIntervals = relevant.map((interval) => ({
      branchId: interval.branchId,
      startedAtMs: interval.startedAtMs,
      finishedAtMs: interval.finishedAtMs!,
    }));
    const summary = summarizeValidIntervals(
      eligibility.branches.size,
      startedBranches.size,
      validIntervals,
      complete,
    );
    return { ...summary, status: "not_applicable" as const };
  }

  if (
    relevant.some(
      (interval) => !interval.validTime || interval.finishedAtMs === null,
    )
  ) {
    return emptySummary(
      eligibility.branches.size,
      startedBranches.size,
      "unknown",
      false,
    );
  }

  const validIntervals = relevant.map((interval) => ({
    branchId: interval.branchId,
    startedAtMs: interval.startedAtMs,
    finishedAtMs: interval.finishedAtMs!,
  }));
  if (startedBranches.size < 2) {
    if (validIntervals.length === 0) {
      return emptySummary(
        eligibility.branches.size,
        startedBranches.size,
        "not_observed",
        complete,
      );
    }
    const summary = summarizeValidIntervals(
      eligibility.branches.size,
      startedBranches.size,
      validIntervals,
      complete,
    );
    return { ...summary, status: "not_observed" as const };
  }

  return summarizeValidIntervals(
    eligibility.branches.size,
    startedBranches.size,
    validIntervals,
    complete,
  );
}

export function summarizeForkConcurrency(
  intervals: ReadonlyArray<RunConcurrencyInterval>,
  eligibleBranchesByFork: ReadonlyMap<string, BranchCollection>,
): ReadonlyMap<string, ForkConcurrencySummary>;
export function summarizeForkConcurrency(
  intervals: ReadonlyArray<RunConcurrencyInterval>,
  eligibleBranchesByFork: Readonly<Record<string, BranchCollection>>,
): Readonly<Record<string, ForkConcurrencySummary>>;
export function summarizeForkConcurrency(
  intervals: ReadonlyArray<RunConcurrencyInterval>,
  eligibleBranchesByFork: EligibleBranchesByFork,
):
  | ReadonlyMap<string, ForkConcurrencySummary>
  | Readonly<Record<string, ForkConcurrencySummary>> {
  const normalizedIntervals = normalizeIntervals(intervals);
  const eligibility = normalizeEligibility(eligibleBranchesByFork);
  const summaries = eligibility.map(
    (fork) => [fork.forkId, summarizeFork(fork, normalizedIntervals)] as const,
  );

  if (eligibleBranchesByFork instanceof Map) {
    return new Map(summaries);
  }
  return Object.fromEntries(summaries);
}
