import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  PLAN_PIPELINE_DISCOVERY_ROLES,
  type PlanPipelineDiscoveryRole,
} from "./domain.ts";

export const PLAN_DISCOVERY_REPORT_TYPE = "plan-discovery-v1" as const;
export const PLAN_DISCOVERY_REPORT_MAX_BYTES = 48 * 1024;
const MAX_ITEMS = 24;
const MAX_TEXT = 2 * 1024;

const text = () => Type.String({ minLength: 1, maxLength: MAX_TEXT });
const evidence = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("task"),
      Type.Literal("documentation"),
      Type.Literal("code"),
      Type.Literal("test"),
      Type.Literal("external"),
    ]),
    reference: text(),
    detail: text(),
  },
  { additionalProperties: false },
);

const roleCoverage = {
  "discover-requirements-boundaries": [
    "goal-and-outcomes",
    "non-goals",
    "acceptance-signals",
    "constraints",
    "unknowns",
  ],
  "discover-architecture-responsibilities": [
    "components-and-ownership",
    "flows-and-boundaries",
    "cohesion-and-coupling",
    "responsibilities",
    "design-pressures",
  ],
  "discover-contracts-invariants": [
    "apis-and-schemas",
    "states-and-failures",
    "permissions",
    "compatibility",
    "security-and-data-safety",
  ],
  "discover-reuse-simplicity": [
    "repository-conventions",
    "existing-analogues",
    "duplication",
    "abstraction-pressure",
    "simplicity",
  ],
  "discover-quality-operations": [
    "test-conventions",
    "failure-and-retry",
    "cancellation",
    "observability",
    "release-and-rollback",
  ],
  "discover-external-evidence": [
    "local-version-context",
    "official-documentation",
    "standards",
    "upstream-evidence",
    "compatibility",
  ],
} as const satisfies Readonly<
  Record<PlanPipelineDiscoveryRole, ReadonlyArray<string>>
>;

const coverage = (criterion: string) =>
  Type.Object(
    {
      criterion: Type.Literal(criterion),
      status: Type.Union([
        Type.Literal("covered"),
        Type.Literal("partial"),
        Type.Literal("not_applicable"),
        Type.Literal("unknown"),
      ]),
      conclusion: text(),
      evidence: Type.Array(evidence, { maxItems: MAX_ITEMS }),
      implications: Type.Array(text(), { maxItems: MAX_ITEMS }),
    },
    { additionalProperties: false },
  );

export function planDiscoveryReportSchema(role: PlanPipelineDiscoveryRole) {
  return Type.Object(
    {
      reportType: Type.Literal(PLAN_DISCOVERY_REPORT_TYPE),
      role: Type.Literal(role),
      applicability: Type.Union([
        Type.Literal("applicable"),
        Type.Literal("partial"),
        Type.Literal("not_applicable"),
      ]),
      summary: text(),
      coverage: Type.Tuple(roleCoverage[role].map(coverage)),
      evidence: Type.Array(evidence, { minItems: 1, maxItems: MAX_ITEMS }),
      unknowns: Type.Array(text(), { maxItems: MAX_ITEMS }),
      constraints: Type.Array(text(), { maxItems: MAX_ITEMS }),
    },
    { additionalProperties: false },
  );
}

export type PlanDiscoveryReport = Static<
  ReturnType<typeof planDiscoveryReportSchema>
>;

export interface PlanDiscoveryReportContext {
  readonly role: PlanPipelineDiscoveryRole;
  readonly provenance: {
    readonly sessionId: string;
    readonly attempt: number;
    readonly submission: "tool" | "final-text-json";
  };
  readonly report: PlanDiscoveryReport;
}

function serializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function validatePlanDiscoveryReport(
  role: PlanPipelineDiscoveryRole,
  value: unknown,
) {
  const issues: string[] = [];
  if (serializedBytes(value) > PLAN_DISCOVERY_REPORT_MAX_BYTES) {
    issues.push(
      `Report exceeds ${PLAN_DISCOVERY_REPORT_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (!Value.Check(planDiscoveryReportSchema(role), value)) {
    issues.push(`Report does not match the strict ${role} TypeBox schema.`);
  }
  return issues;
}

export function parsePlanDiscoveryReport(
  role: PlanPipelineDiscoveryRole,
  value: unknown,
) {
  const issues = validatePlanDiscoveryReport(role, value);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return value as PlanDiscoveryReport;
}

export function parsePlanDiscoveryReportText(
  role: PlanPipelineDiscoveryRole,
  textValue: string,
) {
  if (Buffer.byteLength(textValue, "utf8") > PLAN_DISCOVERY_REPORT_MAX_BYTES) {
    throw new Error(
      `Report exceeds ${PLAN_DISCOVERY_REPORT_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch {
    throw new Error("Report must be exactly one JSON object.");
  }
  return parsePlanDiscoveryReport(role, value);
}

export function planDiscoveryCoverage(role: PlanPipelineDiscoveryRole) {
  return roleCoverage[role];
}

export function planDiscoveryRole(value: string) {
  return PLAN_PIPELINE_DISCOVERY_ROLES.find((role) => role === value);
}
