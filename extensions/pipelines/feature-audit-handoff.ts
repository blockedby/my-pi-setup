import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AuditGitIdentity } from "./audit-segment.ts";
import {
  FEATURE_CANONICAL_PLAN_SCHEMA,
  type FeatureCanonicalPlan,
} from "./feature-planning.ts";
import type { FeatureCheckResult } from "./feature-runtime.ts";

export const FEATURE_AUDIT_HANDOFF_TYPE = "feature-audit-handoff-v1" as const;
export const FEATURE_AUDIT_HANDOFF_MAX_BYTES = 2 * 1024 * 1024;

const gitEvidenceSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("available"),
      Type.Literal("unavailable"),
      Type.Literal("truncated"),
    ]),
    value: Type.String({ maxLength: 96 * 1024 }),
  },
  { additionalProperties: false },
);

const verificationResultSchema = Type.Object(
  {
    checkId: Type.String({ minLength: 1, maxLength: 128 }),
    command: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
    cwd: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
    purpose: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
    required: Type.Boolean(),
    status: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    evidence: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const FEATURE_AUDIT_HANDOFF_SCHEMA = Type.Object(
  {
    reportType: Type.Literal(FEATURE_AUDIT_HANDOFF_TYPE),
    acceptance: FEATURE_CANONICAL_PLAN_SCHEMA.properties.acceptance,
    invariants: FEATURE_CANONICAL_PLAN_SCHEMA.properties.contracts,
    assumptions: Type.Array(
      Type.String({ minLength: 1, maxLength: 32 * 1024 }),
      {
        maxItems: 128,
      },
    ),
    risks: FEATURE_CANONICAL_PLAN_SCHEMA.properties.risks,
    currentGit: Type.Object(
      {
        baseSha: Type.String({ minLength: 1, maxLength: 256 }),
        headSha: Type.String({ minLength: 1, maxLength: 256 }),
        branch: Type.String({ minLength: 1, maxLength: 4 * 1024 }),
        status: gitEvidenceSchema,
        baseIsAncestor: Type.Union([
          Type.Literal("yes"),
          Type.Literal("no"),
          Type.Literal("unavailable"),
        ]),
      },
      { additionalProperties: false },
    ),
    baseRelativeDiff: gitEvidenceSchema,
    verification: Type.Object(
      {
        requirements: FEATURE_CANONICAL_PLAN_SCHEMA.properties.verification,
        results: Type.Array(verificationResultSchema, { maxItems: 512 }),
      },
      { additionalProperties: false },
    ),
    finalSolSummary: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
  },
  { additionalProperties: false },
);

export type FeatureAuditHandoff = Static<typeof FEATURE_AUDIT_HANDOFF_SCHEMA>;

function checkEvidence(check: FeatureCheckResult) {
  const raw = [check.error, check.stderr, check.stdout]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  if (!raw) return undefined;
  return truncateHead(raw, { maxBytes: 512, maxLines: 12 }).content;
}

export function buildFeatureAuditHandoff(options: {
  readonly canonicalPlan: FeatureCanonicalPlan;
  readonly git: AuditGitIdentity;
  readonly reviewSummary: string;
  readonly reviewChecks: ReadonlyArray<FeatureCheckResult>;
}) {
  const handoff = {
    reportType: FEATURE_AUDIT_HANDOFF_TYPE,
    acceptance: options.canonicalPlan.acceptance,
    invariants: options.canonicalPlan.contracts,
    // The canonical plan contract has no free-standing assumptions field.
    assumptions: [],
    risks: options.canonicalPlan.risks,
    currentGit: {
      baseSha: options.git.baseSha,
      headSha: options.git.headSha,
      branch: options.git.branch,
      status: options.git.status,
      baseIsAncestor: options.git.baseIsAncestor,
    },
    baseRelativeDiff: options.git.combinedDiff,
    verification: {
      requirements: options.canonicalPlan.verification,
      results: options.reviewChecks.map((check) => {
        const evidence = checkEvidence(check);
        return {
          checkId: check.checkId,
          command: check.command,
          cwd: check.cwd,
          purpose: check.purpose,
          required: check.required,
          status: check.status,
          exitCode: check.exitCode,
          ...(evidence ? { evidence } : {}),
        };
      }),
    },
    finalSolSummary: options.reviewSummary,
  } satisfies FeatureAuditHandoff;
  const issues = validateFeatureAuditHandoff(handoff);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return handoff;
}

export function validateFeatureAuditHandoff(value: unknown) {
  const issues: string[] = [];
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    FEATURE_AUDIT_HANDOFF_MAX_BYTES
  ) {
    issues.push(
      `Feature audit handoff exceeds ${FEATURE_AUDIT_HANDOFF_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (!Value.Check(FEATURE_AUDIT_HANDOFF_SCHEMA, value)) {
    issues.push("Feature audit handoff does not match its strict schema.");
  }
  return issues;
}
