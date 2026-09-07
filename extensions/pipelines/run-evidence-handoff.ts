import {
  assessAcceptance,
  readAcceptanceEnvelope,
  type AcceptanceCriterion,
  type AcceptanceEnvelope,
  type AcceptanceIdentity,
  type AcceptanceSection,
  type AcceptanceState,
  type AcceptanceStatus,
} from "./run-acceptance.ts";
import type { RunArtifactManifestEntry } from "./run-artifacts.ts";

export const RUN_EVIDENCE_HANDOFF_SCHEMA_VERSION = 1 as const;
export const RUN_EVIDENCE_HANDOFF_MAX_BYTES = 16 * 1024;
export const RUN_EVIDENCE_HANDOFF_MAX_IDENTIFIER_BYTES = 256;
export const RUN_EVIDENCE_HANDOFF_MAX_ARTIFACT_ID_BYTES = 128;

const MAX_BLOCKER_ITEMS = 64;
const MAX_BLOCKER_DETAIL_BYTES = 512;
const MAX_COUNT_ENTRIES = 128;
const MAX_MANIFEST_ENTRIES = 512;
const MAX_UNKNOWN_DEPTH = 3;
const MAX_UNKNOWN_ARRAY_ITEMS = 8;
const MAX_UNKNOWN_OBJECT_KEYS = 8;
const MAX_UNKNOWN_STRING_BYTES = 512;
const TRUNCATION_MARKER = "[truncated]";

export interface RunEvidenceHandoffInput {
  readonly runId: string;
  readonly status: string;
  readonly acceptance: AcceptanceEnvelope;
  readonly manifest: readonly RunArtifactManifestEntry[];
  readonly blockers: readonly {
    readonly id: string;
    readonly detail: string;
  }[];
  readonly errorCounts: Record<string, number>;
  readonly cleanupCounts: Record<string, number>;
  readonly concurrencySummary?: unknown;
}

export interface RunEvidenceArtifactReference {
  readonly artifactId: string;
  readonly revision: number;
}

export interface RunEvidenceAcceptanceAggregate {
  readonly state: AcceptanceState | "unavailable";
  readonly status: AcceptanceStatus;
  readonly criteriaCount: number;
  readonly statusCounts: Readonly<Record<AcceptanceStatus, number>>;
}

export interface RunEvidenceHandoff {
  readonly schemaVersion: typeof RUN_EVIDENCE_HANDOFF_SCHEMA_VERSION;
  readonly runId: string;
  readonly status: string;
  readonly acceptance: {
    readonly state: "available" | "unavailable";
    readonly implementationAcceptance: RunEvidenceAcceptanceAggregate;
    readonly pipelineExecutionAcceptance: RunEvidenceAcceptanceAggregate;
    readonly reviewedIdentity: AcceptanceIdentity | null;
    readonly finalIdentity: AcceptanceIdentity | null;
    readonly fullArtifactRef: RunEvidenceArtifactReference | null;
  };
  readonly counts: {
    readonly errors: RunEvidenceCountProjection;
    readonly cleanup: RunEvidenceCountProjection;
    readonly blockers: RunEvidenceListCounts;
    readonly manifest: RunEvidenceListCounts;
  };
  readonly blockers: {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly detail: string;
      readonly detailTruncated?: true;
    }>;
    readonly totalCount: number;
    readonly includedCount: number;
    readonly omittedCount: number;
    readonly fullArtifactRef: RunEvidenceArtifactReference | null;
  };
  /** Only compact artifactId/revision references are in this index. */
  readonly manifest: {
    readonly entries: ReadonlyArray<RunEvidenceArtifactReference>;
    readonly totalCount: number;
    readonly includedCount: number;
    readonly omittedCount: number;
    readonly acceptanceRef: RunEvidenceArtifactReference | null;
    readonly blockersRef: RunEvidenceArtifactReference | null;
    readonly artifactIndexRef: RunEvidenceArtifactReference | null;
  };
  readonly concurrencySummary?: unknown;
}

export interface RunEvidenceCountProjection {
  readonly values: Readonly<Record<string, number>>;
  readonly totalCount: number;
  readonly includedCount: number;
  readonly omittedCount: number;
}

export interface RunEvidenceListCounts {
  readonly totalCount: number;
  readonly includedCount: number;
  readonly omittedCount: number;
}

export interface RunEvidenceHandoffResult {
  readonly handoff: RunEvidenceHandoff;
  readonly text: string;
}

type NormalizedBlocker = {
  readonly id: string;
  readonly detail: string;
};

type NormalizedCount = {
  readonly key: string;
  readonly value: number;
};

type NormalizedAcceptance = {
  readonly implementationAcceptance: AcceptanceSection;
  readonly pipelineExecutionAcceptance: AcceptanceSection;
  readonly reviewedIdentity: AcceptanceIdentity | null;
  readonly finalIdentity: AcceptanceIdentity | null;
};

type HandoffLimits = {
  blockerItems: number;
  blockerDetailBytes: number;
  errorEntries: number;
  cleanupEntries: number;
  manifestEntries: number;
  includeConcurrency: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function requiredString(
  value: unknown,
  label: string,
  maxBytes = RUN_EVIDENCE_HANDOFF_MAX_IDENTIFIER_BYTES,
) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (byteLength(value) > maxBytes) {
    throw new RangeError(
      `${label} exceeds the maximum size of ${maxBytes} UTF-8 bytes.`,
    );
  }
  return value;
}

function optionalText(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value;
}

function positiveRevision(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function normalizeAcceptanceIdentity(
  value: AcceptanceIdentity | undefined,
  label: string,
) {
  if (!value) return null;
  const base = requiredString(value.base, `${label}.base`);
  const head = requiredString(value.head, `${label}.head`);
  const diffDigest = requiredString(value.diffDigest, `${label}.diffDigest`);
  return {
    base,
    head,
    diffDigest,
    revision: value.revision,
  } satisfies AcceptanceIdentity;
}

function normalizeAcceptance(value: unknown) {
  const read = readAcceptanceEnvelope(value);
  if (read.state !== "available") return undefined;
  return {
    implementationAcceptance: read.envelope.implementationAcceptance,
    pipelineExecutionAcceptance: read.envelope.pipelineExecutionAcceptance,
    reviewedIdentity: normalizeAcceptanceIdentity(
      read.envelope.reviewedIdentity,
      "reviewedIdentity",
    ),
    finalIdentity: normalizeAcceptanceIdentity(
      read.envelope.finalIdentity,
      "finalIdentity",
    ),
  } satisfies NormalizedAcceptance;
}

function emptyStatusCounts() {
  return {
    passed: 0,
    failed: 0,
    unproven: 0,
    not_applicable: 0,
  } satisfies Record<AcceptanceStatus, number>;
}

function assessedStatus(criteria: ReadonlyArray<AcceptanceCriterion>) {
  const statusCounts = emptyStatusCounts();
  for (const criterion of criteria) {
    const status =
      criterion.status === "passed" && criterion.evidenceRefs.length === 0
        ? ("unproven" as const)
        : criterion.status;
    statusCounts[status] += 1;
  }

  const status: AcceptanceStatus =
    statusCounts.failed > 0
      ? "failed"
      : statusCounts.unproven > 0
        ? "unproven"
        : criteria.length === 0
          ? "unproven"
          : statusCounts.not_applicable === criteria.length
            ? "not_applicable"
            : "passed";
  return { status, statusCounts };
}

function conservativeAcceptanceStatus(
  reported: AcceptanceStatus,
  assessed: AcceptanceStatus,
) {
  if (reported === "failed" || assessed === "failed") return "failed";
  if (reported === "unproven" || assessed === "unproven") return "unproven";
  if (reported === "not_applicable" || assessed === "not_applicable") {
    return "not_applicable";
  }
  return "passed";
}

function acceptanceAggregate(
  section: AcceptanceSection | undefined,
): RunEvidenceAcceptanceAggregate {
  if (!section) {
    return {
      state: "unavailable",
      status: "unproven",
      criteriaCount: 0,
      statusCounts: emptyStatusCounts(),
    };
  }

  const assessed = assessedStatus(section.criteria);
  return {
    state: section.state,
    status: conservativeAcceptanceStatus(section.status, assessed.status),
    criteriaCount: section.criteria.length,
    statusCounts: assessed.statusCounts,
  };
}

function normalizeBlockers(value: unknown) {
  if (!Array.isArray(value)) {
    throw new TypeError("blockers must be an array.");
  }
  return value.map((blocker, index) => {
    if (!isRecord(blocker)) {
      throw new TypeError(`blocker ${index} must be an object.`);
    }
    const id = requiredString(blocker.id, `blocker ${index}.id`);
    const detail = optionalText(blocker.detail, `blocker ${index}.detail`);
    return { id, detail } satisfies NormalizedBlocker;
  });
}

function normalizeCounts(value: unknown, label: string) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  const normalized: NormalizedCount[] = [];
  for (const [key, count] of Object.entries(value)) {
    const normalizedKey = requiredString(countKey(key, label), `${label} key`);
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw new TypeError(
        `${label}[${JSON.stringify(normalizedKey)}] must be a nonnegative safe integer.`,
      );
    }
    normalized.push({ key: normalizedKey, value: count });
  }
  normalized.sort((left, right) => compareStrings(left.key, right.key));
  return normalized;
}

function countKey(key: string, label: string) {
  if (key.length === 0) {
    throw new TypeError(`${label} contains an empty key.`);
  }
  return key;
}

function normalizeManifest(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError("manifest must be an array.");
  const refs = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`manifest entry ${index} must be an object.`);
    }
    const artifactId = requiredString(
      entry.artifactId,
      `manifest entry ${index}.artifactId`,
      RUN_EVIDENCE_HANDOFF_MAX_ARTIFACT_ID_BYTES,
    );
    const revision = positiveRevision(
      entry.revision,
      `manifest entry ${index}.revision`,
    );
    return { artifactId, revision } satisfies RunEvidenceArtifactReference;
  });
  refs.sort(
    (left, right) =>
      compareStrings(left.artifactId, right.artifactId) ||
      left.revision - right.revision,
  );
  return refs;
}

function selectManifestEntries(
  refs: ReadonlyArray<RunEvidenceArtifactReference>,
  limit: number,
  requiredRefs: ReadonlyArray<RunEvidenceArtifactReference>,
) {
  const selected: RunEvidenceArtifactReference[] = [];
  const add = (candidate: RunEvidenceArtifactReference) => {
    if (
      selected.length >= limit ||
      selected.some(
        (entry) =>
          entry.artifactId === candidate.artifactId &&
          entry.revision === candidate.revision,
      )
    ) {
      return;
    }
    selected.push(candidate);
  };
  for (const requiredRef of requiredRefs) add(requiredRef);
  for (const ref of refs) add(ref);
  selected.sort(
    (left, right) =>
      compareStrings(left.artifactId, right.artifactId) ||
      left.revision - right.revision,
  );
  return selected;
}

function artifactRefFor(
  refs: ReadonlyArray<RunEvidenceArtifactReference>,
  kind: "acceptance" | "blockers",
) {
  const exactNames =
    kind === "acceptance"
      ? ["acceptance", "run-acceptance", "acceptance-envelope"]
      : ["blockers", "run-blockers"];
  const exact = refs.filter((ref) =>
    exactNames.some((name) => ref.artifactId.toLowerCase() === name),
  );
  const named = exact.length
    ? exact
    : refs.filter((ref) => {
        const id = ref.artifactId.toLowerCase();
        return new RegExp(`(?:^|[-_.])${kind}(?:$|[-_.])`, "u").test(id);
      });
  const candidates = named.length
    ? named
    : refs.filter((ref) =>
        ["summary", "run-summary", "terminal-run-summary"].includes(
          ref.artifactId.toLowerCase(),
        ),
      );
  return candidates.reduce<RunEvidenceArtifactReference | undefined>(
    (best, candidate) =>
      !best ||
      candidate.revision > best.revision ||
      (candidate.revision === best.revision &&
        compareStrings(candidate.artifactId, best.artifactId) < 0)
        ? candidate
        : best,
    undefined,
  );
}

function artifactIndexRefFor(
  refs: ReadonlyArray<RunEvidenceArtifactReference>,
) {
  return refs
    .filter((ref) => ref.artifactId.toLowerCase() === "artifact-index")
    .reduce<RunEvidenceArtifactReference | undefined>(
      (best, candidate) =>
        !best ||
        candidate.revision > best.revision ||
        (candidate.revision === best.revision &&
          compareStrings(candidate.artifactId, best.artifactId) < 0)
          ? candidate
          : best,
      undefined,
    );
}

function utf8Prefix(value: string, maxBytes: number) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const markerBytes = byteLength(TRUNCATION_MARKER);
  if (maxBytes <= markerBytes) {
    let end = maxBytes;
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    return bytes.subarray(0, end).toString("utf8");
  }

  let end = maxBytes - markerBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${TRUNCATION_MARKER}`;
}

function compactUnknown(
  value: unknown,
  depth = 0,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return byteLength(value) <= MAX_UNKNOWN_STRING_BYTES
      ? value
      : {
          value: utf8Prefix(value, MAX_UNKNOWN_STRING_BYTES),
          truncated: true,
        };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : { state: "unavailable", reason: "non_finite_number" };
  }
  if (typeof value === "undefined") {
    return { state: "unavailable", reason: "undefined" };
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return { state: "unavailable", reason: `unsupported_${typeof value}` };
  }
  if (depth >= MAX_UNKNOWN_DEPTH) {
    return { state: "omitted", reason: "depth" };
  }
  if (ancestors.has(value)) {
    return { state: "unavailable", reason: "circular" };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, MAX_UNKNOWN_ARRAY_ITEMS)
        .map((item) => compactUnknown(item, depth + 1, ancestors));
      return value.length > items.length
        ? {
            items,
            truncated: true,
            omittedCount: value.length - items.length,
          }
        : items;
    }

    let keys: string[];
    try {
      keys = Object.keys(value).sort(compareStrings);
    } catch {
      return { state: "unavailable", reason: "object_keys" };
    }
    const retainedKeys: string[] = [];
    let omittedCount = 0;
    for (const key of keys) {
      if (byteLength(key) > RUN_EVIDENCE_HANDOFF_MAX_IDENTIFIER_BYTES) {
        omittedCount += 1;
        continue;
      }
      if (retainedKeys.length >= MAX_UNKNOWN_OBJECT_KEYS) {
        omittedCount += 1;
        continue;
      }
      retainedKeys.push(key);
    }
    const fields = Object.fromEntries(
      retainedKeys.map((key) => {
        try {
          return [
            key,
            compactUnknown(Reflect.get(value, key), depth + 1, ancestors),
          ];
        } catch {
          return [key, { state: "unavailable", reason: "property_read" }];
        }
      }),
    );
    return omittedCount > 0
      ? { fields, truncated: true, omittedCount }
      : fields;
  } finally {
    ancestors.delete(value);
  }
}

function boundedCounts(
  entries: ReadonlyArray<NormalizedCount>,
  limit: number,
): RunEvidenceCountProjection {
  const retained = entries.slice(0, limit);
  return {
    values: Object.fromEntries(
      retained.map((entry) => [entry.key, entry.value]),
    ),
    totalCount: entries.length,
    includedCount: retained.length,
    omittedCount: entries.length - retained.length,
  };
}

function boundedBlockers(
  blockers: ReadonlyArray<NormalizedBlocker>,
  limits: HandoffLimits,
) {
  const items = blockers.slice(0, limits.blockerItems).map((blocker) => {
    const truncated = byteLength(blocker.detail) > limits.blockerDetailBytes;
    return {
      id: blocker.id,
      detail: truncated
        ? utf8Prefix(blocker.detail, limits.blockerDetailBytes)
        : blocker.detail,
      ...(truncated ? { detailTruncated: true as const } : {}),
    };
  });
  return {
    items,
    totalCount: blockers.length,
    includedCount: items.length,
    omittedCount: blockers.length - items.length,
  };
}

function reducedLimits(limits: HandoffLimits) {
  if (limits.includeConcurrency) {
    limits.includeConcurrency = false;
    return true;
  }
  // Keep a small index and at least one count category while shrinking. The
  // omittedCount and full-artifact reference remain even when this shrinks.
  if (limits.manifestEntries > 3) {
    limits.manifestEntries = Math.max(
      3,
      Math.floor(limits.manifestEntries / 2),
    );
    return true;
  }
  if (limits.errorEntries > 1) {
    limits.errorEntries = Math.max(1, Math.floor(limits.errorEntries / 2));
    return true;
  }
  if (limits.cleanupEntries > 1) {
    limits.cleanupEntries = Math.max(1, Math.floor(limits.cleanupEntries / 2));
    return true;
  }
  if (limits.blockerDetailBytes > 32) {
    limits.blockerDetailBytes = Math.max(
      32,
      Math.floor(limits.blockerDetailBytes / 2),
    );
    return true;
  }
  if (limits.blockerItems > 1) {
    limits.blockerItems = Math.max(1, Math.floor(limits.blockerItems / 2));
    return true;
  }
  if (limits.blockerItems > 0) {
    limits.blockerItems = 0;
    return true;
  }
  return false;
}

function serialized(value: unknown) {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error("Run evidence handoff is not JSON serializable.", {
      cause: error,
    });
  }
  if (typeof text !== "string") {
    throw new Error("Run evidence handoff is not JSON serializable.");
  }
  return {
    text,
    bytes: byteLength(text),
  };
}

function projection(
  input: RunEvidenceHandoffInput,
  acceptance: NormalizedAcceptance | undefined,
  blockers: ReadonlyArray<NormalizedBlocker>,
  errorCounts: ReadonlyArray<NormalizedCount>,
  cleanupCounts: ReadonlyArray<NormalizedCount>,
  manifestRefs: ReadonlyArray<RunEvidenceArtifactReference>,
  limits: HandoffLimits,
) {
  const implementationAcceptance = acceptanceAggregate(
    acceptance?.implementationAcceptance,
  );
  const pipelineExecutionAcceptance = acceptanceAggregate(
    acceptance?.pipelineExecutionAcceptance,
  );
  const acceptanceRef = artifactRefFor(manifestRefs, "acceptance") ?? null;
  const blockersRef = artifactRefFor(manifestRefs, "blockers") ?? null;
  const artifactIndexRef = artifactIndexRefFor(manifestRefs) ?? null;
  const compactBlockers = boundedBlockers(blockers, limits);
  const manifestEntries = selectManifestEntries(
    manifestRefs,
    limits.manifestEntries,
    [artifactIndexRef, acceptanceRef, blockersRef].filter(
      (ref): ref is RunEvidenceArtifactReference => ref !== null,
    ),
  );

  const result = {
    schemaVersion: RUN_EVIDENCE_HANDOFF_SCHEMA_VERSION,
    runId: input.runId,
    status: input.status,
    acceptance: {
      state: acceptance ? ("available" as const) : ("unavailable" as const),
      implementationAcceptance,
      pipelineExecutionAcceptance,
      reviewedIdentity: acceptance?.reviewedIdentity ?? null,
      finalIdentity: acceptance?.finalIdentity ?? null,
      fullArtifactRef: acceptanceRef,
    },
    counts: {
      errors: boundedCounts(errorCounts, limits.errorEntries),
      cleanup: boundedCounts(cleanupCounts, limits.cleanupEntries),
      blockers: {
        totalCount: blockers.length,
        includedCount: compactBlockers.includedCount,
        omittedCount: compactBlockers.omittedCount,
      },
      manifest: {
        totalCount: manifestRefs.length,
        includedCount: manifestEntries.length,
        omittedCount: manifestRefs.length - manifestEntries.length,
      },
    },
    blockers: {
      ...compactBlockers,
      fullArtifactRef: blockersRef,
    },
    manifest: {
      entries: manifestEntries,
      totalCount: manifestRefs.length,
      includedCount: manifestEntries.length,
      omittedCount: manifestRefs.length - manifestEntries.length,
      acceptanceRef,
      blockersRef,
      artifactIndexRef,
    },
    ...(input.concurrencySummary !== undefined
      ? {
          concurrencySummary: limits.includeConcurrency
            ? compactUnknown(input.concurrencySummary)
            : { state: "omitted", reason: "handoff_byte_budget" },
        }
      : {}),
  } satisfies RunEvidenceHandoff;
  return result;
}

function normalizeInput(input: RunEvidenceHandoffInput) {
  if (!isRecord(input))
    throw new TypeError("Run evidence handoff input must be an object.");
  const runId = requiredString(input.runId, "runId");
  const status = requiredString(input.status, "status");
  const acceptance = normalizeAcceptance(input.acceptance);
  const blockers = normalizeBlockers(input.blockers);
  const errorCounts = normalizeCounts(input.errorCounts, "errorCounts");
  const cleanupCounts = normalizeCounts(input.cleanupCounts, "cleanupCounts");
  const manifestRefs = normalizeManifest(input.manifest);
  return {
    input: { ...input, runId, status },
    acceptance,
    blockers,
    errorCounts,
    cleanupCounts,
    manifestRefs,
  };
}

export function buildRunEvidenceHandoff(input: RunEvidenceHandoffInput) {
  const normalized = normalizeInput(input);
  const limits: HandoffLimits = {
    blockerItems: Math.min(MAX_BLOCKER_ITEMS, normalized.blockers.length),
    blockerDetailBytes: MAX_BLOCKER_DETAIL_BYTES,
    errorEntries: Math.min(MAX_COUNT_ENTRIES, normalized.errorCounts.length),
    cleanupEntries: Math.min(
      MAX_COUNT_ENTRIES,
      normalized.cleanupCounts.length,
    ),
    manifestEntries: Math.min(
      MAX_MANIFEST_ENTRIES,
      normalized.manifestRefs.length,
    ),
    includeConcurrency: input.concurrencySummary !== undefined,
  };

  while (true) {
    const handoff = projection(
      normalized.input,
      normalized.acceptance,
      normalized.blockers,
      normalized.errorCounts,
      normalized.cleanupCounts,
      normalized.manifestRefs,
      limits,
    );
    if (serialized(handoff).bytes <= RUN_EVIDENCE_HANDOFF_MAX_BYTES)
      return handoff;
    if (!reducedLimits(limits)) {
      throw new RangeError(
        `Run evidence handoff required fields exceed ${RUN_EVIDENCE_HANDOFF_MAX_BYTES} UTF-8 bytes.`,
      );
    }
  }
}

export function serializeRunEvidenceHandoff(handoff: RunEvidenceHandoff) {
  const result = serialized(handoff);
  if (result.bytes > RUN_EVIDENCE_HANDOFF_MAX_BYTES) {
    throw new RangeError(
      `Run evidence handoff exceeds ${RUN_EVIDENCE_HANDOFF_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  return result.text;
}

export function createRunEvidenceHandoff(input: RunEvidenceHandoffInput) {
  const handoff = buildRunEvidenceHandoff(input);
  return {
    handoff,
    text: serializeRunEvidenceHandoff(handoff),
  };
}
