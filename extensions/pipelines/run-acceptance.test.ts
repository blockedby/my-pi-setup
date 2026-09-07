import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import {
  ACCEPTANCE_ENVELOPE_SCHEMA,
  RUN_ACCEPTANCE_ENVELOPE_SCHEMA,
  assessAcceptance,
  readAcceptanceEnvelope,
  type AcceptanceCriterion,
  type AcceptanceEnvelope,
} from "./run-acceptance.ts";

function criterion(
  id: string,
  status: AcceptanceCriterion["status"],
  evidenceRefs: string[] = [`evidence://${id}`],
): AcceptanceCriterion {
  return {
    id,
    status,
    evidenceRefs,
    detail: `Detail for ${id}.`,
  };
}

function envelope(
  implementationAcceptance: AcceptanceEnvelope["implementationAcceptance"],
  pipelineExecutionAcceptance: AcceptanceEnvelope["pipelineExecutionAcceptance"],
  identities: Pick<
    AcceptanceEnvelope,
    "reviewedIdentity" | "finalIdentity"
  > = {},
): AcceptanceEnvelope {
  return {
    schemaVersion: 2,
    implementationAcceptance,
    pipelineExecutionAcceptance,
    ...identities,
  };
}

test("independent implementation and execution statuses preserve all four combinations", () => {
  const combinations = [
    ["passed", "failed"],
    ["failed", "passed"],
    ["unproven", "passed"],
    ["passed", "unproven"],
  ] as const;

  for (const [implementationStatus, executionStatus] of combinations) {
    const value = envelope(
      assessAcceptance(
        [criterion("implementation", implementationStatus)],
        "final",
      ),
      assessAcceptance([criterion("execution", executionStatus)], "final"),
    );
    assert.equal(Value.Check(RUN_ACCEPTANCE_ENVELOPE_SCHEMA, value), true);
    assert.equal(Value.Check(ACCEPTANCE_ENVELOPE_SCHEMA, value), true);

    const read = readAcceptanceEnvelope(value);
    assert.equal(read.state, "available");
    if (read.state === "available") {
      assert.equal(
        read.envelope.implementationAcceptance.status,
        implementationStatus,
      );
      assert.equal(
        read.envelope.pipelineExecutionAcceptance.status,
        executionStatus,
      );
    }
  }
});

test("assessment never turns missing evidence into a pass", () => {
  const passedWithoutEvidence = [criterion("missing-evidence", "passed", [])];
  const assessed = assessAcceptance(passedWithoutEvidence, "provisional");

  assert.equal(assessed.status, "unproven");
  assert.equal(assessed.criteria[0]?.status, "unproven");
  assert.equal(passedWithoutEvidence[0]?.status, "passed");
  assert.deepEqual(passedWithoutEvidence[0]?.evidenceRefs, []);

  assert.equal(assessAcceptance([], "final").status, "unproven");
  assert.equal(
    assessAcceptance(
      [criterion("not-applicable", "not_applicable", [])],
      "final",
    ).status,
    "not_applicable",
  );
  assert.equal(
    assessAcceptance(
      [criterion("unknown", "unproven"), criterion("broken", "failed")],
      "final",
    ).status,
    "failed",
  );
});

test("strict V2 schema rejects unknown fields at every envelope level", () => {
  const value = envelope(
    assessAcceptance([criterion("implementation", "passed")], "final"),
    assessAcceptance([criterion("execution", "passed")], "final"),
  );

  const envelopeWithUnknown = structuredClone(value) as Record<string, unknown>;
  envelopeWithUnknown.unexpected = true;
  assert.equal(
    Value.Check(RUN_ACCEPTANCE_ENVELOPE_SCHEMA, envelopeWithUnknown),
    false,
  );

  const sectionWithUnknown = structuredClone(value);
  Reflect.set(sectionWithUnknown.implementationAcceptance, "unexpected", true);
  assert.equal(
    Value.Check(RUN_ACCEPTANCE_ENVELOPE_SCHEMA, sectionWithUnknown),
    false,
  );

  const criterionWithUnknown = structuredClone(value);
  Reflect.set(
    criterionWithUnknown.implementationAcceptance.criteria[0],
    "unexpected",
    true,
  );
  assert.equal(
    Value.Check(RUN_ACCEPTANCE_ENVELOPE_SCHEMA, criterionWithUnknown),
    false,
  );

  const withIdentities = envelope(
    value.implementationAcceptance,
    value.pipelineExecutionAcceptance,
    {
      reviewedIdentity: {
        base: "base",
        head: "head",
        diffDigest: "digest",
        revision: 1,
      },
    },
  );
  Reflect.set(withIdentities.reviewedIdentity!, "unexpected", true);
  assert.equal(
    Value.Check(RUN_ACCEPTANCE_ENVELOPE_SCHEMA, withIdentities),
    false,
  );

  const read = readAcceptanceEnvelope(envelopeWithUnknown);
  assert.deepEqual(read, { state: "unavailable", reason: "invalid_v2" });
});

test("legacy audit payloads remain explicitly unavailable", () => {
  const legacy = {
    reportType: "audit-synthesis-final",
    mode: "initial",
    findings: [],
    unprovenChecks: [],
  };

  assert.deepEqual(readAcceptanceEnvelope(legacy), {
    state: "unavailable",
    reason: "legacy_missing_sections",
  });
});

test("reviewed and final identities remain separate immutable snapshots", () => {
  const source = envelope(
    assessAcceptance([criterion("implementation", "passed")], "final"),
    assessAcceptance([criterion("execution", "passed")], "final"),
    {
      reviewedIdentity: {
        base: "base-reviewed",
        head: "head-reviewed",
        diffDigest: "digest-reviewed",
        revision: 3,
      },
      finalIdentity: {
        base: "base-final",
        head: "head-final",
        diffDigest: "digest-final",
        revision: 4,
      },
    },
  );

  const read = readAcceptanceEnvelope(source);
  assert.equal(read.state, "available");
  if (read.state !== "available") return;

  assert.notStrictEqual(
    read.envelope.reviewedIdentity,
    read.envelope.finalIdentity,
  );
  assert.notStrictEqual(
    read.envelope.reviewedIdentity,
    source.reviewedIdentity,
  );
  assert.notStrictEqual(read.envelope.finalIdentity, source.finalIdentity);
  assert.equal(read.envelope.reviewedIdentity?.head, "head-reviewed");
  assert.equal(read.envelope.finalIdentity?.head, "head-final");

  const reviewedIdentity = source.reviewedIdentity;
  const finalIdentity = source.finalIdentity;
  assert.ok(reviewedIdentity);
  assert.ok(finalIdentity);
  Reflect.set(reviewedIdentity, "head", "source-mutated");
  Reflect.set(finalIdentity, "head", "source-mutated");
  assert.equal(read.envelope.reviewedIdentity?.head, "head-reviewed");
  assert.equal(read.envelope.finalIdentity?.head, "head-final");
});
