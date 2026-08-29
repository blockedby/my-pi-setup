import type { PipelineDefinitionId, PipelineStage } from "./domain.ts";

/** The default controller-owned budget for each timed pipeline stage. */
export const DEFAULT_PIPELINE_WALLCLOCK_LIMIT_MS = 30 * 60 * 1_000;
export const MIN_PIPELINE_WALLCLOCK_LIMIT_MS = 30 * 1_000;
export const MAX_PIPELINE_WALLCLOCK_LIMIT_MS = 24 * 60 * 60 * 1_000;
export const PIPELINE_WALLCLOCK_WARNING_RATIO = 0.8 as const;
export const PIPELINE_WALLCLOCK_LIMIT_PATTERN =
  "^(?:(?:[3-9][0-9]|[1-9][0-9]{2}|[1-7][0-9]{3}|8[0-5][0-9]{2}|86[0-3][0-9]|86400)s|(?:[1-9]|[1-9][0-9]|[1-9][0-9]{2}|1[0-3][0-9]{2}|14[0-3][0-9]|1440)m|(?:[1-9]|1[0-9]|2[0-4])h)$";

const CANONICAL_WALLCLOCK_LIMIT = new RegExp(PIPELINE_WALLCLOCK_LIMIT_PATTERN);

export interface PipelineMonotonicClock {
  now(): number;
}

export interface PipelineWallclockScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export const systemPipelineMonotonicClock: PipelineMonotonicClock = {
  now: () => performance.now(),
};

export const systemPipelineWallclockScheduler: PipelineWallclockScheduler = {
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * Parse the deliberately small public grammar. Durations are integer seconds,
 * minutes, or hours with no whitespace, sign, decimal, or compound unit.
 */
export function parsePipelineWallclockLimit(value?: string) {
  if (value === undefined) return DEFAULT_PIPELINE_WALLCLOCK_LIMIT_MS;
  if (typeof value !== "string" || !CANONICAL_WALLCLOCK_LIMIT.test(value)) {
    throw new Error(
      "wallclock_limit must be a canonical integer duration such as 30s, 5m, or 2h.",
    );
  }
  const unit = value.at(-1);
  const digits = value.slice(0, -1);
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const amount = Number(digits);
  if (!Number.isSafeInteger(amount)) {
    throw new Error("wallclock_limit is too large.");
  }
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("wallclock_limit is too large.");
  }
  if (
    milliseconds < MIN_PIPELINE_WALLCLOCK_LIMIT_MS ||
    milliseconds > MAX_PIPELINE_WALLCLOCK_LIMIT_MS
  ) {
    throw new Error("wallclock_limit must be between 30s and 24h inclusive.");
  }
  return milliseconds;
}

// Short aliases keep the parser useful to callers that do not need the
// pipeline-specific name while retaining one implementation of the grammar.
export const parseWallclockLimit = parsePipelineWallclockLimit;

export function timedPipelineStage(
  definition: PipelineDefinitionId,
  stage: PipelineStage,
) {
  if (stage === "complete") return false;
  if (definition === "feature-pipeline") {
    return (
      stage === "discover" ||
      stage === "build" ||
      stage === "audit" ||
      stage === "audit-resolve" ||
      stage === "final-audit" ||
      stage === "final-resolve"
    );
  }
  if (definition === "small-feature-pipeline") {
    return (
      stage === "build" || stage === "final-audit" || stage === "final-resolve"
    );
  }
  if (definition === "plan-pipeline") {
    return stage === "discover" || stage === "synthesize";
  }
  return stage === "audit";
}

export interface PipelineStageTiming {
  readonly definition: PipelineDefinitionId;
  readonly stage: PipelineStage;
  readonly epoch: number;
  readonly startedAtMs: number;
  readonly warningAtMs: number;
  readonly deadlineAtMs: number;
  readonly warningReached: boolean;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly limited: boolean;
}

export function stageTimingAt(
  timing: Pick<
    PipelineStageTiming,
    | "startedAtMs"
    | "warningAtMs"
    | "deadlineAtMs"
    | "stage"
    | "epoch"
    | "definition"
    | "warningReached"
    | "limited"
  >,
  now: number,
): PipelineStageTiming {
  const elapsedMs = Math.max(
    0,
    Math.min(
      timing.deadlineAtMs - timing.startedAtMs,
      now - timing.startedAtMs,
    ),
  );
  const remainingMs = Math.max(0, timing.deadlineAtMs - now);
  return {
    ...timing,
    warningReached: timing.warningReached || now >= timing.warningAtMs,
    elapsedMs,
    remainingMs,
  };
}

export interface PipelineWallclockState {
  readonly limitMs: number;
  readonly runStartedAtMs: number;
  readonly runElapsedMs: number;
  readonly stageElapsedMs: number;
  readonly remainingMs: number;
  readonly warningReached: boolean;
  readonly warningAtMs: number;
  readonly deadlineAtMs: number;
  readonly stage: PipelineStage;
  readonly epoch: number;
}
