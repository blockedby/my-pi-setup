import type { PlanningReadinessResult } from "./domain.ts";

export const PLANNING_READINESS_HANDOFF_MAX_BYTES = 15 * 1024;
export const PLANNING_READINESS_HANDOFF_ARTIFACT_ID =
  "planning-readiness" as const;

const MAX_INCLUDED_CHECKS = 12;
const MIN_TEXT_BYTES = 16;
const TRUNCATION_MARKER = "[truncated]";
const TEXT_FIELDS = [
  "workspaceRoot",
  "command",
  "cwd",
  "purpose",
  "sourcePath",
  "sourceExcerpt",
  "error",
  "stdout",
  "stderr",
] as const;
type TextField = (typeof TEXT_FIELDS)[number];

const TEXT_WEIGHTS: Record<TextField, number> = {
  workspaceRoot: 1,
  command: 1,
  cwd: 1,
  purpose: 1.1,
  sourcePath: 1,
  sourceExcerpt: 1.1,
  error: 1.4,
  stdout: 0.8,
  stderr: 1.5,
};

export interface PlanningReadinessArtifactReference {
  readonly runId: string;
  readonly artifactId: typeof PLANNING_READINESS_HANDOFF_ARTIFACT_ID;
  readonly revision: number;
}

export interface PlanningReadinessHandoffCheck {
  readonly index: number;
  readonly workspaceRoot: string;
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly source: {
    readonly path: string;
    readonly excerpt: string;
  };
  readonly sourceHash: string | null;
  readonly status: PlanningReadinessResult["status"];
  readonly exitCode: number | null;
  readonly error?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly truncated: boolean;
  readonly truncatedFields: ReadonlyArray<TextField>;
}

export interface PlanningReadinessHandoff {
  readonly artifactRef: PlanningReadinessArtifactReference;
  readonly checks: ReadonlyArray<PlanningReadinessHandoffCheck>;
  readonly totalCount: number;
  readonly includedCount: number;
  readonly omittedCount: number;
  readonly truncated: boolean;
}

type NormalizedCheck = Omit<
  PlanningReadinessHandoffCheck,
  "index" | "truncated" | "truncatedFields"
>;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function positiveRevision(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("revision must be a positive safe integer.");
  }
  return value;
}

function normalizeCheck(check: PlanningReadinessResult, index: number) {
  if (check === null || typeof check !== "object") {
    throw new TypeError(`check ${index} must be an object.`);
  }
  const source = check.source;
  if (source === null || typeof source !== "object") {
    throw new TypeError(`check ${index}.source must be an object.`);
  }
  if (check.status !== "passed" && check.status !== "failed") {
    throw new TypeError(`check ${index}.status is invalid.`);
  }
  if (check.exitCode !== null && typeof check.exitCode !== "number") {
    throw new TypeError(`check ${index}.exitCode must be a number or null.`);
  }
  if (check.error !== undefined && typeof check.error !== "string") {
    throw new TypeError(`check ${index}.error must be a string.`);
  }
  if (check.sourceHash !== undefined && typeof check.sourceHash !== "string") {
    throw new TypeError(`check ${index}.sourceHash must be a string.`);
  }

  return {
    workspaceRoot: requiredString(
      check.workspaceRoot,
      `check ${index}.workspaceRoot`,
    ),
    command: requiredString(check.command, `check ${index}.command`),
    cwd: requiredString(check.cwd, `check ${index}.cwd`),
    purpose: requiredString(check.purpose, `check ${index}.purpose`),
    source: {
      path: requiredString(source.path, `check ${index}.source.path`),
      excerpt: requiredString(source.excerpt, `check ${index}.source.excerpt`),
    },
    sourceHash: check.sourceHash ?? null,
    status: check.status,
    exitCode:
      check.exitCode === null
        ? null
        : finiteNumber(check.exitCode, `check ${index}.exitCode`),
    ...(check.error !== undefined ? { error: check.error } : {}),
    stdout: requiredString(check.stdout, `check ${index}.stdout`),
    stderr: requiredString(check.stderr, `check ${index}.stderr`),
    startedAt: finiteNumber(check.startedAt, `check ${index}.startedAt`),
    finishedAt: finiteNumber(check.finishedAt, `check ${index}.finishedAt`),
  } satisfies NormalizedCheck;
}

function utf8Prefix(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const markerBytes = byteLength(TRUNCATION_MARKER);
  if (maxBytes <= markerBytes) return TRUNCATION_MARKER;

  let end = maxBytes - markerBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${TRUNCATION_MARKER}`;
}

function textBudget(value: string, factor: number, weight: number) {
  const fullBytes = byteLength(value);
  if (factor >= 1 || fullBytes <= MIN_TEXT_BYTES) return fullBytes;
  const weightedFactor = Math.min(1, factor * weight);
  return Math.max(
    MIN_TEXT_BYTES,
    Math.floor(MIN_TEXT_BYTES + (fullBytes - MIN_TEXT_BYTES) * weightedFactor),
  );
}

function boundedText(value: string, factor: number, weight: number) {
  return utf8Prefix(value, textBudget(value, factor, weight));
}

function boundedCheck(check: NormalizedCheck, index: number, factor: number) {
  const raw = {
    workspaceRoot: check.workspaceRoot,
    command: check.command,
    cwd: check.cwd,
    purpose: check.purpose,
    sourcePath: check.source.path,
    sourceExcerpt: check.source.excerpt,
    error: check.error ?? "",
    stdout: check.stdout,
    stderr: check.stderr,
  };
  const bounded = {
    workspaceRoot: boundedText(
      raw.workspaceRoot,
      factor,
      TEXT_WEIGHTS.workspaceRoot,
    ),
    command: boundedText(raw.command, factor, TEXT_WEIGHTS.command),
    cwd: boundedText(raw.cwd, factor, TEXT_WEIGHTS.cwd),
    purpose: boundedText(raw.purpose, factor, TEXT_WEIGHTS.purpose),
    sourcePath: boundedText(raw.sourcePath, factor, TEXT_WEIGHTS.sourcePath),
    sourceExcerpt: boundedText(
      raw.sourceExcerpt,
      factor,
      TEXT_WEIGHTS.sourceExcerpt,
    ),
    error: boundedText(raw.error, factor, TEXT_WEIGHTS.error),
    stdout: boundedText(raw.stdout, factor, TEXT_WEIGHTS.stdout),
    stderr: boundedText(raw.stderr, factor, TEXT_WEIGHTS.stderr),
  };
  const truncatedFields = TEXT_FIELDS.filter(
    (field) =>
      (field !== "error" || check.error !== undefined) &&
      bounded[field] !== raw[field],
  );

  return {
    index,
    workspaceRoot: bounded.workspaceRoot,
    command: bounded.command,
    cwd: bounded.cwd,
    purpose: bounded.purpose,
    source: {
      path: bounded.sourcePath,
      excerpt: bounded.sourceExcerpt,
    },
    sourceHash: check.sourceHash,
    status: check.status,
    exitCode: check.exitCode,
    ...(check.error !== undefined ? { error: bounded.error } : {}),
    stdout: bounded.stdout,
    stderr: bounded.stderr,
    startedAt: check.startedAt,
    finishedAt: check.finishedAt,
    truncated: truncatedFields.length > 0,
    truncatedFields,
  } satisfies PlanningReadinessHandoffCheck;
}

function projection(
  runId: string,
  revision: number,
  checks: ReadonlyArray<NormalizedCheck>,
  indexes: ReadonlyArray<number>,
  factor: number,
) {
  const projectedChecks = indexes.map((index) =>
    boundedCheck(checks[index]!, index, factor),
  );
  const omittedCount = checks.length - projectedChecks.length;
  return {
    artifactRef: {
      runId,
      artifactId: PLANNING_READINESS_HANDOFF_ARTIFACT_ID,
      revision,
    },
    checks: projectedChecks,
    totalCount: checks.length,
    includedCount: projectedChecks.length,
    omittedCount,
    truncated:
      omittedCount > 0 || projectedChecks.some((check) => check.truncated),
  } satisfies PlanningReadinessHandoff;
}

function serializedBytes(value: PlanningReadinessHandoff) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Planning readiness handoff is not JSON serializable.");
  }
  return byteLength(serialized);
}

function initialIndexes(checks: ReadonlyArray<NormalizedCheck>) {
  const indexes = checks.map((_check, index) => index);
  if (indexes.length <= MAX_INCLUDED_CHECKS) return indexes;
  const failures = indexes.filter(
    (index) => checks[index]!.status === "failed",
  );
  const passed = indexes.filter((index) => checks[index]!.status === "passed");
  return [...failures, ...passed].slice(0, MAX_INCLUDED_CHECKS);
}

function dropLowestPriorityIndex(
  indexes: ReadonlyArray<number>,
  checks: ReadonlyArray<NormalizedCheck>,
) {
  let position = indexes.length - 1;
  for (let candidate = indexes.length - 1; candidate >= 0; candidate -= 1) {
    if (checks[indexes[candidate]!]!.status !== "failed") {
      position = candidate;
      break;
    }
  }
  return indexes.filter((_index, candidate) => candidate !== position);
}

function fitProjection(
  runId: string,
  revision: number,
  checks: ReadonlyArray<NormalizedCheck>,
  indexes: ReadonlyArray<number>,
) {
  const full = projection(runId, revision, checks, indexes, 1);
  if (serializedBytes(full) <= PLANNING_READINESS_HANDOFF_MAX_BYTES) {
    return full;
  }

  const minimum = projection(runId, revision, checks, indexes, 0);
  if (serializedBytes(minimum) > PLANNING_READINESS_HANDOFF_MAX_BYTES) {
    return undefined;
  }

  let best = minimum;
  let low = 0;
  let high = 1;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const factor = (low + high) / 2;
    const candidate = projection(runId, revision, checks, indexes, factor);
    if (serializedBytes(candidate) <= PLANNING_READINESS_HANDOFF_MAX_BYTES) {
      best = candidate;
      low = factor;
    } else {
      high = factor;
    }
  }
  return best;
}

export function buildPlanningReadinessHandoff(
  runId: string,
  checks: ReadonlyArray<PlanningReadinessResult>,
  revision: number,
) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("runId must be a non-empty string.");
  }
  const normalizedRevision = positiveRevision(revision);
  if (!Array.isArray(checks)) {
    throw new TypeError("checks must be an array.");
  }
  const normalizedChecks = checks.map(normalizeCheck);
  let indexes = initialIndexes(normalizedChecks);

  while (true) {
    const handoff = fitProjection(
      runId,
      normalizedRevision,
      normalizedChecks,
      indexes,
    );
    if (handoff) return handoff;
    if (
      normalizedChecks.length <= MAX_INCLUDED_CHECKS ||
      indexes.length === 0
    ) {
      throw new RangeError(
        `Planning readiness handoff required fields exceed ${PLANNING_READINESS_HANDOFF_MAX_BYTES} UTF-8 bytes.`,
      );
    }
    indexes = dropLowestPriorityIndex(indexes, normalizedChecks);
  }
}
