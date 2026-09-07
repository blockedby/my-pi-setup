import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

export const RUN_ACCEPTANCE_SCHEMA_VERSION = 2 as const;

export const RUN_ACCEPTANCE_MAX_CRITERIA = 128;
export const RUN_ACCEPTANCE_MAX_EVIDENCE_REFS = 64;
export const RUN_ACCEPTANCE_MAX_IDENTIFIER_LENGTH = 256;
export const RUN_ACCEPTANCE_MAX_EVIDENCE_REF_LENGTH = 2 * 1024;
export const RUN_ACCEPTANCE_MAX_DETAIL_LENGTH = 16 * 1024;
export const RUN_ACCEPTANCE_MAX_REVISION = 1_000_000_000;

export const ACCEPTANCE_STATE_SCHEMA = Type.Union([
  Type.Literal("provisional"),
  Type.Literal("final"),
]);

export const ACCEPTANCE_STATUS_SCHEMA = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("unproven"),
  Type.Literal("not_applicable"),
]);

export const ACCEPTANCE_CRITERION_SCHEMA = Type.ReadonlyObject(
  Type.Object(
    {
      id: Type.String({
        minLength: 1,
        maxLength: RUN_ACCEPTANCE_MAX_IDENTIFIER_LENGTH,
      }),
      status: ACCEPTANCE_STATUS_SCHEMA,
      evidenceRefs: Type.Immutable(
        Type.Array(
          Type.String({
            minLength: 1,
            maxLength: RUN_ACCEPTANCE_MAX_EVIDENCE_REF_LENGTH,
          }),
          { maxItems: RUN_ACCEPTANCE_MAX_EVIDENCE_REFS },
        ),
      ),
      detail: Type.String({
        minLength: 1,
        maxLength: RUN_ACCEPTANCE_MAX_DETAIL_LENGTH,
      }),
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);

const acceptanceIdentityFields = {
  base: Type.String({
    minLength: 1,
    maxLength: RUN_ACCEPTANCE_MAX_IDENTIFIER_LENGTH,
  }),
  head: Type.String({
    minLength: 1,
    maxLength: RUN_ACCEPTANCE_MAX_IDENTIFIER_LENGTH,
  }),
  diffDigest: Type.String({
    minLength: 1,
    maxLength: RUN_ACCEPTANCE_MAX_IDENTIFIER_LENGTH,
  }),
  revision: Type.Integer({
    minimum: 0,
    maximum: RUN_ACCEPTANCE_MAX_REVISION,
  }),
};

function acceptanceIdentitySchema() {
  return Type.ReadonlyObject(
    Type.Object(acceptanceIdentityFields, { additionalProperties: false }),
    { additionalProperties: false },
  );
}

/** The review snapshot and terminal snapshot intentionally have separate schemas. */
export const REVIEWED_IDENTITY_SCHEMA = acceptanceIdentitySchema();
export const FINAL_IDENTITY_SCHEMA = acceptanceIdentitySchema();

export const ACCEPTANCE_SECTION_SCHEMA = Type.ReadonlyObject(
  Type.Object(
    {
      state: ACCEPTANCE_STATE_SCHEMA,
      status: ACCEPTANCE_STATUS_SCHEMA,
      criteria: Type.Immutable(
        Type.Array(ACCEPTANCE_CRITERION_SCHEMA, {
          maxItems: RUN_ACCEPTANCE_MAX_CRITERIA,
        }),
      ),
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);

export const RUN_ACCEPTANCE_ENVELOPE_SCHEMA = Type.ReadonlyObject(
  Type.Object(
    {
      schemaVersion: Type.Literal(RUN_ACCEPTANCE_SCHEMA_VERSION),
      implementationAcceptance: ACCEPTANCE_SECTION_SCHEMA,
      pipelineExecutionAcceptance: ACCEPTANCE_SECTION_SCHEMA,
      reviewedIdentity: Type.Optional(REVIEWED_IDENTITY_SCHEMA),
      finalIdentity: Type.Optional(FINAL_IDENTITY_SCHEMA),
    },
    { additionalProperties: false },
  ),
  { additionalProperties: false },
);

// Short alias for consumers that do not need the run-specific name.
export const ACCEPTANCE_ENVELOPE_SCHEMA = RUN_ACCEPTANCE_ENVELOPE_SCHEMA;

export type AcceptanceState = Static<typeof ACCEPTANCE_STATE_SCHEMA>;
export type AcceptanceStatus = Static<typeof ACCEPTANCE_STATUS_SCHEMA>;
export type AcceptanceCriterion = Static<typeof ACCEPTANCE_CRITERION_SCHEMA>;
export type AcceptanceIdentity = Static<typeof REVIEWED_IDENTITY_SCHEMA>;
export type AcceptanceSection = Static<typeof ACCEPTANCE_SECTION_SCHEMA>;
export type AcceptanceEnvelope = Static<typeof RUN_ACCEPTANCE_ENVELOPE_SCHEMA>;

export type AcceptanceEnvelopeReadResult =
  | {
      readonly state: "available";
      readonly envelope: AcceptanceEnvelope;
    }
  | {
      readonly state: "unavailable";
      readonly reason: "legacy_missing_sections" | "invalid_v2";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAcceptanceEnvelope(value: unknown): value is AcceptanceEnvelope {
  return Check(RUN_ACCEPTANCE_ENVELOPE_SCHEMA, value);
}

function cloneAcceptanceCriterion(criterion: AcceptanceCriterion) {
  return {
    ...criterion,
    evidenceRefs: [...criterion.evidenceRefs],
  };
}

function cloneAcceptanceSection(section: AcceptanceSection) {
  return {
    state: section.state,
    status: section.status,
    criteria: section.criteria.map(cloneAcceptanceCriterion),
  } satisfies AcceptanceSection;
}

function cloneAcceptanceEnvelope(envelope: AcceptanceEnvelope) {
  return {
    schemaVersion: envelope.schemaVersion,
    implementationAcceptance: cloneAcceptanceSection(
      envelope.implementationAcceptance,
    ),
    pipelineExecutionAcceptance: cloneAcceptanceSection(
      envelope.pipelineExecutionAcceptance,
    ),
    ...(envelope.reviewedIdentity
      ? { reviewedIdentity: { ...envelope.reviewedIdentity } }
      : {}),
    ...(envelope.finalIdentity
      ? { finalIdentity: { ...envelope.finalIdentity } }
      : {}),
  } satisfies AcceptanceEnvelope;
}

/**
 * Calculate one acceptance section without consulting lifecycle or model state.
 * A passed criterion without evidence is deliberately downgraded to unproven.
 */
export function assessAcceptance(
  criteria: AcceptanceSection["criteria"],
  state: AcceptanceState,
) {
  const assessedCriteria = criteria.map((criterion) => {
    const status =
      criterion.status === "passed" && criterion.evidenceRefs.length === 0
        ? ("unproven" as const)
        : criterion.status;
    return {
      ...criterion,
      status,
      evidenceRefs: [...criterion.evidenceRefs],
    };
  });

  const status: AcceptanceStatus = assessedCriteria.some(
    (criterion) => criterion.status === "failed",
  )
    ? "failed"
    : assessedCriteria.some((criterion) => criterion.status === "unproven")
      ? "unproven"
      : assessedCriteria.length === 0
        ? "unproven"
        : assessedCriteria.every(
              (criterion) => criterion.status === "not_applicable",
            )
          ? "not_applicable"
          : "passed";

  return {
    state,
    status,
    criteria: assessedCriteria,
  } satisfies AcceptanceSection;
}

/**
 * Read only this module's strict V2 envelope. Older audit payloads are not
 * normalized into acceptance and therefore remain explicitly unavailable.
 */
export function readAcceptanceEnvelope(
  value: unknown,
): AcceptanceEnvelopeReadResult {
  if (isAcceptanceEnvelope(value)) {
    return {
      state: "available",
      envelope: cloneAcceptanceEnvelope(value),
    };
  }

  const legacy =
    isRecord(value) &&
    value.schemaVersion !== RUN_ACCEPTANCE_SCHEMA_VERSION &&
    !("implementationAcceptance" in value) &&
    !("pipelineExecutionAcceptance" in value);
  return {
    state: "unavailable",
    reason: legacy ? "legacy_missing_sections" : "invalid_v2",
  };
}
