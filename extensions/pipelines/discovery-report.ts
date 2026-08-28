import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  type FeaturePipelineDiscoveryRole,
} from "./domain.ts";

export const FEATURE_DISCOVERY_REPORT_TYPE = "feature-discovery-v2" as const;
export const FEATURE_DISCOVERY_REPORT_MAX_BYTES = 30 * 1024;
export const FEATURE_DISCOVERY_FAN_IN_MAX_BYTES =
  FEATURE_DISCOVERY_REPORT_MAX_BYTES * FEATURE_PIPELINE_DISCOVERY_ROLES.length;
export const FEATURE_DISCOVERY_MAX_ITEMS = 12;
export const FEATURE_DISCOVERY_TEXT_MAX_LENGTH = 2 * 1024;

export const FEATURE_DISCOVERY_COVERAGE = {
  "discover-problem": [
    "actor-job",
    "current-behavior",
    "problem-or-opportunity",
    "observable-consequence",
    "boundaries",
    "non-goals",
    "neighboring-flows",
  ],
  "discover-outcome": [
    "primary-outcome",
    "alternate-outcome",
    "failure-outcome",
    "candidate-acceptance",
    "observable-verification",
    "non-goals",
  ],
  "discover-context": [
    "current-user-journey",
    "direct-dependencies",
    "contracts-invariants",
    "neighboring-scenarios",
    "repository-conventions",
    "integration-boundaries",
  ],
  "discover-user-scenarios": [
    "primary",
    "alternate",
    "empty",
    "error",
    "permission-auth",
    "retry-recovery",
    "before-after-transition",
  ],
  "discover-product-precedents": [
    "similar-behavior",
    "established-terminology",
    "implementation-precedent",
    "testing-precedent",
    "reusable-pattern",
    "intentional-divergence",
  ],
} as const satisfies Readonly<
  Record<FeaturePipelineDiscoveryRole, ReadonlyArray<string>>
>;

export type FeatureDiscoveryCriterion =
  (typeof FEATURE_DISCOVERY_COVERAGE)[FeaturePipelineDiscoveryRole][number];
export type FeatureDiscoveryApplicability =
  "applicable" | "partial" | "not_applicable";
export type FeatureDiscoveryCoverageStatus =
  "covered" | "partial" | "not_applicable" | "unknown";
export type FeatureDiscoveryEvidenceKind =
  | "task"
  | "product"
  | "documentation"
  | "code"
  | "test"
  | "artifact"
  | "external";

export interface FeatureDiscoveryEvidence {
  readonly kind: FeatureDiscoveryEvidenceKind;
  readonly reference: string;
  readonly detail: string;
}

export interface FeatureDiscoveryCoverageItem {
  readonly criterion: FeatureDiscoveryCriterion;
  readonly status: FeatureDiscoveryCoverageStatus;
  readonly conclusion: string;
  readonly evidence: ReadonlyArray<FeatureDiscoveryEvidence>;
  readonly implications: ReadonlyArray<string>;
}

export interface FeatureDiscoveryCandidateAcceptanceCriterion {
  readonly scenario: string;
  readonly expected: string;
  readonly verification: string;
  readonly evidence: ReadonlyArray<FeatureDiscoveryEvidence>;
}

export interface FeatureDiscoveryUnknown {
  readonly question: string;
  readonly whyItMatters: string;
  readonly safeAssumption: string;
  readonly resolution: string;
}

export interface FeatureDiscoveryConstraint {
  readonly constraint: string;
  readonly source: string;
  readonly effect: string;
}

export interface FeatureDiscoveryReportV2 {
  readonly reportType: typeof FEATURE_DISCOVERY_REPORT_TYPE;
  readonly role: FeaturePipelineDiscoveryRole;
  readonly applicability: FeatureDiscoveryApplicability;
  readonly summary: string;
  readonly coverage: ReadonlyArray<FeatureDiscoveryCoverageItem>;
  readonly candidateAcceptanceCriteria: ReadonlyArray<FeatureDiscoveryCandidateAcceptanceCriterion>;
  readonly unknowns: ReadonlyArray<FeatureDiscoveryUnknown>;
  readonly constraints: ReadonlyArray<FeatureDiscoveryConstraint>;
}

const textSchema = () =>
  Type.String({ minLength: 1, maxLength: FEATURE_DISCOVERY_TEXT_MAX_LENGTH });

const evidenceSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("task"),
      Type.Literal("product"),
      Type.Literal("documentation"),
      Type.Literal("code"),
      Type.Literal("test"),
      Type.Literal("artifact"),
      Type.Literal("external"),
    ]),
    reference: textSchema(),
    detail: textSchema(),
  },
  { additionalProperties: false },
);

const evidenceArraySchema = (minimum = 0) =>
  Type.Array(evidenceSchema, {
    minItems: minimum,
    maxItems: FEATURE_DISCOVERY_MAX_ITEMS,
  });

const implicationsSchema = Type.Array(textSchema(), {
  maxItems: FEATURE_DISCOVERY_MAX_ITEMS,
});

function coverageStatusSchema(
  criterion: string,
  status: string,
  evidence: 0 | 1,
) {
  return Type.Object(
    {
      criterion: Type.Literal(criterion),
      status: Type.Literal(status),
      conclusion: textSchema(),
      evidence: evidenceArraySchema(evidence),
      implications: implicationsSchema,
    },
    { additionalProperties: false },
  );
}

function coverageItemSchema(criterion: string) {
  return Type.Union([
    coverageStatusSchema(criterion, "covered", 1),
    coverageStatusSchema(criterion, "partial", 1),
    coverageStatusSchema(criterion, "not_applicable", 1),
    coverageStatusSchema(criterion, "unknown", 0),
  ]);
}

const candidateSchema = Type.Object(
  {
    scenario: textSchema(),
    expected: textSchema(),
    verification: textSchema(),
    evidence: evidenceArraySchema(1),
  },
  { additionalProperties: false },
);

const unknownSchema = Type.Object(
  {
    question: textSchema(),
    whyItMatters: textSchema(),
    safeAssumption: textSchema(),
    resolution: textSchema(),
  },
  { additionalProperties: false },
);

const constraintSchema = Type.Object(
  {
    constraint: textSchema(),
    source: textSchema(),
    effect: textSchema(),
  },
  { additionalProperties: false },
);

function reportProperties(
  role: FeaturePipelineDiscoveryRole,
  applicability: TSchema,
  candidateMinimum: number,
) {
  return {
    reportType: Type.Literal(FEATURE_DISCOVERY_REPORT_TYPE),
    role: Type.Literal(role),
    applicability,
    summary: textSchema(),
    coverage: Type.Tuple(
      FEATURE_DISCOVERY_COVERAGE[role].map((criterion) =>
        coverageItemSchema(criterion),
      ),
    ),
    candidateAcceptanceCriteria: Type.Array(candidateSchema, {
      minItems: candidateMinimum,
      maxItems: FEATURE_DISCOVERY_MAX_ITEMS,
    }),
    unknowns: Type.Array(unknownSchema, {
      maxItems: FEATURE_DISCOVERY_MAX_ITEMS,
    }),
    constraints: Type.Array(constraintSchema, {
      maxItems: FEATURE_DISCOVERY_MAX_ITEMS,
    }),
  };
}

function candidateMinimumFor(role: FeaturePipelineDiscoveryRole) {
  return role === "discover-outcome" || role === "discover-user-scenarios"
    ? 2
    : 0;
}

export function featureDiscoveryReportSchema(
  role: FeaturePipelineDiscoveryRole,
) {
  const requiredCandidates = candidateMinimumFor(role);
  if (requiredCandidates === 0) {
    return Type.Object(
      reportProperties(
        role,
        Type.Union([
          Type.Literal("applicable"),
          Type.Literal("partial"),
          Type.Literal("not_applicable"),
        ]),
        0,
      ),
      { additionalProperties: false },
    );
  }
  return Type.Union([
    Type.Object(reportProperties(role, Type.Literal("not_applicable"), 0), {
      additionalProperties: false,
    }),
    Type.Object(
      reportProperties(
        role,
        Type.Union([Type.Literal("applicable"), Type.Literal("partial")]),
        requiredCandidates,
      ),
      { additionalProperties: false },
    ),
  ]);
}

export type FeatureDiscoveryReportSchema = Static<
  ReturnType<typeof featureDiscoveryReportSchema>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function serializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function validateFeatureDiscoveryFanIn(value: unknown) {
  const bytes = serializedBytes(value);
  return bytes <= FEATURE_DISCOVERY_FAN_IN_MAX_BYTES
    ? []
    : [
        `Feature discovery fan-in exceeds ${FEATURE_DISCOVERY_FAN_IN_MAX_BYTES} UTF-8 bytes.`,
      ];
}

function evidenceTextFields(value: unknown, path: string) {
  if (!isRecord(value)) return [];
  return [
    { path: `${path}.reference`, value: value.reference },
    { path: `${path}.detail`, value: value.detail },
  ];
}

function reportTextFields(report: Record<string, unknown>) {
  const fields: Array<{ path: string; value: unknown }> = [
    { path: "summary", value: report.summary },
  ];
  const coverage = Array.isArray(report.coverage) ? report.coverage : [];
  for (const [index, item] of coverage.entries()) {
    if (!isRecord(item)) continue;
    fields.push({
      path: `coverage[${index}].conclusion`,
      value: item.conclusion,
    });
    if (Array.isArray(item.implications)) {
      fields.push(
        ...item.implications.map((value, implicationIndex) => ({
          path: `coverage[${index}].implications[${implicationIndex}]`,
          value,
        })),
      );
    }
    if (Array.isArray(item.evidence)) {
      fields.push(
        ...item.evidence.flatMap((evidence, evidenceIndex) =>
          evidenceTextFields(
            evidence,
            `coverage[${index}].evidence[${evidenceIndex}]`,
          ),
        ),
      );
    }
  }
  const candidates = Array.isArray(report.candidateAcceptanceCriteria)
    ? report.candidateAcceptanceCriteria
    : [];
  for (const [index, candidate] of candidates.entries()) {
    if (!isRecord(candidate)) continue;
    for (const key of ["scenario", "expected", "verification"] as const) {
      fields.push({
        path: `candidateAcceptanceCriteria[${index}].${key}`,
        value: candidate[key],
      });
    }
    if (Array.isArray(candidate.evidence)) {
      fields.push(
        ...candidate.evidence.flatMap((evidence, evidenceIndex) =>
          evidenceTextFields(
            evidence,
            `candidateAcceptanceCriteria[${index}].evidence[${evidenceIndex}]`,
          ),
        ),
      );
    }
  }
  const unknowns = Array.isArray(report.unknowns) ? report.unknowns : [];
  for (const [index, unknown] of unknowns.entries()) {
    if (!isRecord(unknown)) continue;
    for (const key of [
      "question",
      "whyItMatters",
      "safeAssumption",
      "resolution",
    ] as const) {
      fields.push({ path: `unknowns[${index}].${key}`, value: unknown[key] });
    }
  }
  const constraints = Array.isArray(report.constraints)
    ? report.constraints
    : [];
  for (const [index, constraint] of constraints.entries()) {
    if (!isRecord(constraint)) continue;
    for (const key of ["constraint", "source", "effect"] as const) {
      fields.push({
        path: `constraints[${index}].${key}`,
        value: constraint[key],
      });
    }
  }
  return fields;
}

export function validateFeatureDiscoveryReport(
  role: FeaturePipelineDiscoveryRole,
  value: unknown,
) {
  const issues: string[] = [];
  if (serializedBytes(value) > FEATURE_DISCOVERY_REPORT_MAX_BYTES) {
    issues.push(
      `Report exceeds ${FEATURE_DISCOVERY_REPORT_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (!Value.Check(featureDiscoveryReportSchema(role), value)) {
    issues.push(`Report does not match the strict ${role} TypeBox schema.`);
  }
  if (!isRecord(value)) return issues;
  for (const field of reportTextFields(value)) {
    if (
      typeof field.value === "string" &&
      Buffer.byteLength(field.value, "utf8") > FEATURE_DISCOVERY_TEXT_MAX_LENGTH
    ) {
      issues.push(
        `${field.path} exceeds ${FEATURE_DISCOVERY_TEXT_MAX_LENGTH} UTF-8 bytes.`,
      );
    }
  }

  const coverage = Array.isArray(value.coverage) ? value.coverage : [];
  const expected = FEATURE_DISCOVERY_COVERAGE[role];
  const actual = coverage.map((item) =>
    isRecord(item) ? String(item.criterion) : "",
  );
  if (actual.length !== expected.length) {
    issues.push(`Coverage must contain exactly ${expected.length} criteria.`);
  }
  const duplicates = actual.filter(
    (criterion, index) => actual.indexOf(criterion) !== index,
  );
  if (duplicates.length > 0) {
    issues.push(
      `Coverage contains duplicate criteria: ${[...new Set(duplicates)].join(", ")}.`,
    );
  }
  const unknownCriteria = actual.filter(
    (criterion) => !expected.includes(criterion as never),
  );
  if (unknownCriteria.length > 0) {
    issues.push(
      `Coverage contains unknown criteria: ${[...new Set(unknownCriteria)].join(", ")}.`,
    );
  }
  if (
    actual.length === expected.length &&
    actual.some((criterion, index) => criterion !== expected[index])
  ) {
    issues.push("Coverage criteria are out of deterministic role order.");
  }

  let unknownCoverageCount = 0;
  for (const item of coverage) {
    if (!isRecord(item)) continue;
    const status = item.status;
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (
      (status === "covered" ||
        status === "partial" ||
        status === "not_applicable") &&
      evidence.length === 0
    ) {
      issues.push(
        `${String(item.criterion)} ${status} coverage requires evidence.`,
      );
    }
    if (status === "unknown") unknownCoverageCount++;
  }
  const unknowns = Array.isArray(value.unknowns) ? value.unknowns : [];
  if (unknowns.length < unknownCoverageCount) {
    issues.push(
      `Unknown coverage requires at least one distinct actionable unknown and safe assumption per criterion; found ${unknownCoverageCount} unknown criteria and ${unknowns.length} unknown records.`,
    );
  } else {
    const pairedUnknowns = unknowns.slice(0, unknownCoverageCount);
    const signatures = pairedUnknowns.map((item) =>
      isRecord(item)
        ? JSON.stringify([
            item.question,
            item.whyItMatters,
            item.safeAssumption,
            item.resolution,
          ])
        : "",
    );
    if (new Set(signatures).size !== signatures.length) {
      issues.push(
        "Unknown coverage must pair in coverage order with distinct actionable unknown records; duplicate paired records are not allowed.",
      );
    }
  }

  const requiredCandidates = candidateMinimumFor(role);
  if (
    requiredCandidates > 0 &&
    value.applicability !== "not_applicable" &&
    (!Array.isArray(value.candidateAcceptanceCriteria) ||
      value.candidateAcceptanceCriteria.length < requiredCandidates)
  ) {
    issues.push(
      `${role} requires at least ${requiredCandidates} candidate acceptance criteria when applicable or partial.`,
    );
  }
  return issues;
}

export function parseFeatureDiscoveryReport(
  role: FeaturePipelineDiscoveryRole,
  value: unknown,
): FeatureDiscoveryReportV2 {
  const issues = validateFeatureDiscoveryReport(role, value);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return value as FeatureDiscoveryReportV2;
}

export function parseFeatureDiscoveryReportText(
  role: FeaturePipelineDiscoveryRole,
  text: string,
) {
  if (Buffer.byteLength(text, "utf8") > FEATURE_DISCOVERY_REPORT_MAX_BYTES) {
    throw new Error(
      `Report exceeds ${FEATURE_DISCOVERY_REPORT_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Report must be exactly one JSON object.");
  }
  return parseFeatureDiscoveryReport(role, value);
}
