import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_EVIDENCE_HANDOFF_MAX_BYTES,
  buildRunEvidenceHandoff,
  createRunEvidenceHandoff,
  type RunEvidenceHandoffInput,
} from "./run-evidence-handoff.ts";
import type {
  AcceptanceCriterion,
  AcceptanceEnvelope,
  AcceptanceSection,
} from "./run-acceptance.ts";
import type { RunArtifactManifestEntry } from "./run-artifacts.ts";

function criterion(
  id: string,
  status: AcceptanceCriterion["status"] = "passed",
  evidenceRefs = [`check://${id}`],
): AcceptanceCriterion {
  return {
    id,
    status,
    evidenceRefs,
    detail: `Evidence for ${id}.`,
  };
}

function section(
  criteria: ReadonlyArray<AcceptanceCriterion>,
  status: AcceptanceSection["status"] = "passed",
): AcceptanceSection {
  return {
    state: "final",
    status,
    criteria,
  };
}

function acceptance(
  implementationCriteria: ReadonlyArray<AcceptanceCriterion> = [
    criterion("implementation-1"),
  ],
  executionCriteria: ReadonlyArray<AcceptanceCriterion> = [
    criterion("execution-1"),
  ],
): AcceptanceEnvelope {
  return {
    schemaVersion: 2,
    implementationAcceptance: section(implementationCriteria),
    pipelineExecutionAcceptance: section(executionCriteria),
    reviewedIdentity: {
      base: "base-reviewed",
      head: "head-reviewed",
      diffDigest: "digest-reviewed",
      revision: 4,
    },
    finalIdentity: {
      base: "base-final",
      head: "head-final",
      diffDigest: "digest-final",
      revision: 7,
    },
  };
}

function manifestEntry(
  artifactId: string,
  revision: number,
): RunArtifactManifestEntry {
  return {
    artifactId,
    relativePath: `artifacts/${artifactId}.json`,
    schemaVersion: "evidence-v1",
    bytes: 123456,
    sha256: "not-inline-evidence",
    revision,
    completeness: "complete",
  };
}

function input(overrides: Partial<RunEvidenceHandoffInput> = {}) {
  return {
    runId: "run-evidence-handoff",
    status: "completed",
    acceptance: acceptance(),
    manifest: [
      manifestEntry("acceptance", 4),
      manifestEntry("artifact-index", 13),
      manifestEntry("blockers", 3),
      manifestEntry("timeline", 12),
    ],
    blockers: [],
    errorCounts: { provider: 2, validation: 1 },
    cleanupCounts: { removed: 4, retained: 1 },
    ...overrides,
  } satisfies RunEvidenceHandoffInput;
}

test("returns a compact object and independently serialized UTF-8 JSON", () => {
  const result = createRunEvidenceHandoff(
    input({
      blockers: [{ id: "B-1", detail: "The retained diagnostic blocker." }],
      concurrencySummary: {
        status: "observed",
        maxConcurrent: 2,
        overlapMs: 17,
      },
    }),
  );

  assert.equal(
    Buffer.byteLength(result.text, "utf8") <= RUN_EVIDENCE_HANDOFF_MAX_BYTES,
    true,
  );
  assert.deepEqual(JSON.parse(result.text), result.handoff);
  assert.equal(result.handoff.status, "completed");
  assert.equal(
    result.handoff.acceptance.implementationAcceptance.status,
    "passed",
  );
  assert.equal(
    result.handoff.acceptance.pipelineExecutionAcceptance.status,
    "passed",
  );
  assert.equal(
    result.handoff.acceptance.implementationAcceptance.criteriaCount,
    1,
  );
  assert.equal(
    result.handoff.acceptance.reviewedIdentity?.head,
    "head-reviewed",
  );
  assert.equal(result.handoff.acceptance.finalIdentity?.head, "head-final");
  assert.deepEqual(result.handoff.manifest.acceptanceRef, {
    artifactId: "acceptance",
    revision: 4,
  });
  assert.deepEqual(result.handoff.acceptance.fullArtifactRef, {
    artifactId: "acceptance",
    revision: 4,
  });
  assert.deepEqual(result.handoff.manifest.blockersRef, {
    artifactId: "blockers",
    revision: 3,
  });
  assert.deepEqual(result.handoff.manifest.artifactIndexRef, {
    artifactId: "artifact-index",
    revision: 13,
  });
  assert.deepEqual(result.handoff.blockers.fullArtifactRef, {
    artifactId: "blockers",
    revision: 3,
  });
  assert.deepEqual(result.handoff.manifest.entries, [
    { artifactId: "acceptance", revision: 4 },
    { artifactId: "artifact-index", revision: 13 },
    { artifactId: "blockers", revision: 3 },
    { artifactId: "timeline", revision: 12 },
  ]);
  assert.equal("relativePath" in result.handoff.manifest.entries[0]!, false);
  assert.equal("sha256" in result.handoff.manifest.entries[0]!, false);
});

test("bounds huge Unicode criteria, blockers, and manifest payloads before serialization", () => {
  const criteria = Array.from({ length: 120 }, (_, index) =>
    criterion(`AC-${index + 1}`, "passed", [`evidence://${index}/Привет 🌍`]),
  );
  const blockers = Array.from({ length: 500 }, (_, index) => ({
    id: `BLOCKER-${index + 1}`,
    detail: `Причина ${index + 1}: Привет 🌍🚀 `.repeat(800),
  }));
  const manifest = [
    manifestEntry("acceptance", 20),
    manifestEntry("blockers", 21),
    manifestEntry("artifact-index", 22),
    ...Array.from({ length: 500 }, (_, index) =>
      manifestEntry(`event-${String(index + 1).padStart(3, "0")}`, index + 1),
    ),
  ];
  const result = createRunEvidenceHandoff(
    input({
      acceptance: acceptance(criteria, criteria),
      manifest,
      blockers,
      errorCounts: Object.fromEntries(
        Array.from({ length: 180 }, (_, index) => [`error-${index}`, index]),
      ),
      cleanupCounts: Object.fromEntries(
        Array.from({ length: 180 }, (_, index) => [`cleanup-${index}`, index]),
      ),
      concurrencySummary: {
        explanation: "Привет 🌍🚀 ".repeat(2_000),
        nested: { values: Array.from({ length: 100 }, (_, index) => index) },
      },
    }),
  );
  const parsed = JSON.parse(result.text) as typeof result.handoff;

  assert.equal(
    Buffer.byteLength(result.text, "utf8") <= RUN_EVIDENCE_HANDOFF_MAX_BYTES,
    true,
  );
  assert.deepEqual(parsed, result.handoff);
  assert.equal(
    result.handoff.acceptance.implementationAcceptance.criteriaCount,
    criteria.length,
  );
  assert.equal(
    result.handoff.acceptance.pipelineExecutionAcceptance.criteriaCount,
    criteria.length,
  );
  assert.equal(
    result.handoff.acceptance.implementationAcceptance.status,
    "passed",
  );
  assert.equal(result.handoff.blockers.totalCount, blockers.length);
  assert.equal(
    result.handoff.blockers.items.length + result.handoff.blockers.omittedCount,
    blockers.length,
  );
  assert.ok(result.handoff.blockers.omittedCount > 0);
  assert.equal(result.handoff.blockers.items[0]?.id, "BLOCKER-1");
  assert.equal(result.handoff.blockers.items[0]?.detailTruncated, true);
  assert.equal(
    result.handoff.manifest.entries.length +
      result.handoff.manifest.omittedCount,
    manifest.length,
  );
  assert.ok(result.handoff.manifest.omittedCount > 0);
  assert.deepEqual(result.handoff.manifest.acceptanceRef, {
    artifactId: "acceptance",
    revision: 20,
  });
  assert.deepEqual(result.handoff.manifest.blockersRef, {
    artifactId: "blockers",
    revision: 21,
  });
  assert.deepEqual(result.handoff.manifest.artifactIndexRef, {
    artifactId: "artifact-index",
    revision: 22,
  });
  assert.equal(
    result.handoff.manifest.entries.some(
      (entry) => entry.artifactId === "artifact-index",
    ),
    true,
  );
  assert.equal("relativePath" in parsed.manifest.entries[0]!, false);
  assert.equal(result.handoff.counts.errors.omittedCount > 0, true);
  assert.equal(result.handoff.counts.cleanup.omittedCount > 0, true);
});

test("missing or invalid acceptance is explicitly unavailable and never passed", () => {
  const missing = createRunEvidenceHandoff(
    input({ acceptance: undefined as unknown as AcceptanceEnvelope }),
  );
  const invalid = createRunEvidenceHandoff(
    input({
      acceptance: { schemaVersion: 2 } as unknown as AcceptanceEnvelope,
    }),
  );

  for (const result of [missing, invalid]) {
    assert.equal(result.handoff.acceptance.state, "unavailable");
    assert.equal(
      result.handoff.acceptance.implementationAcceptance.status,
      "unproven",
    );
    assert.equal(
      result.handoff.acceptance.pipelineExecutionAcceptance.status,
      "unproven",
    );
    assert.notEqual(
      result.handoff.acceptance.implementationAcceptance.status,
      "passed",
    );
    assert.notEqual(
      result.handoff.acceptance.pipelineExecutionAcceptance.status,
      "passed",
    );
    assert.deepEqual(JSON.parse(result.text), result.handoff);
  }
});

test("legacy manifests expose a missing artifact index as explicit null", () => {
  const result = createRunEvidenceHandoff(
    input({
      manifest: [
        manifestEntry("acceptance", 4),
        manifestEntry("blockers", 3),
        manifestEntry("summary", 99),
        manifestEntry("timeline", 12),
      ],
    }),
  );

  assert.equal(result.handoff.manifest.artifactIndexRef, null);
  assert.equal(
    (JSON.parse(result.text) as typeof result.handoff).manifest
      .artifactIndexRef,
    null,
  );
});

test("a passed section with missing criterion evidence is downgraded to unproven", () => {
  const result = createRunEvidenceHandoff(
    input({
      acceptance: acceptance([criterion("without-evidence", "passed", [])]),
    }),
  );

  assert.equal(
    result.handoff.acceptance.implementationAcceptance.status,
    "unproven",
  );
  assert.equal(
    result.handoff.acceptance.implementationAcceptance.statusCounts.unproven,
    1,
  );
});

test("rejects oversized required scalar identifiers rather than cutting JSON", () => {
  assert.throws(
    () => buildRunEvidenceHandoff(input({ runId: "🚀".repeat(200) })),
    /runId exceeds.*UTF-8/u,
  );
  assert.throws(
    () =>
      buildRunEvidenceHandoff(
        input({ blockers: [{ id: "Ж".repeat(200), detail: "detail" }] }),
      ),
    /blocker 0\.id exceeds.*UTF-8/u,
  );
  assert.throws(
    () =>
      buildRunEvidenceHandoff(
        input({ manifest: [manifestEntry("🌍".repeat(100), 1)] }),
      ),
    /manifest entry 0\.artifactId exceeds.*UTF-8/u,
  );
});

test("keeps unknown concurrency summaries serializable and deterministic", () => {
  const cyclic: Record<string, unknown> = {
    status: "unknown",
    unicode: "Привет 🌍",
  };
  cyclic.self = cyclic;
  const first = createRunEvidenceHandoff(input({ concurrencySummary: cyclic }));
  const second = createRunEvidenceHandoff(
    input({ concurrencySummary: cyclic }),
  );

  assert.equal(first.text, second.text);
  assert.equal(
    Buffer.byteLength(first.text, "utf8") <= RUN_EVIDENCE_HANDOFF_MAX_BYTES,
    true,
  );
  assert.deepEqual(JSON.parse(first.text), first.handoff);
  assert.deepEqual(first.handoff.concurrencySummary, {
    self: { state: "unavailable", reason: "circular" },
    status: "unknown",
    unicode: "Привет 🌍",
  });
});
