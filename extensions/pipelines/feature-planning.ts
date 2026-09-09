import path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const FEATURE_PLAN_CANDIDATE_ROLES = ["Minimal", "Robust"] as const;
export type FeaturePlanCandidateRole =
  (typeof FEATURE_PLAN_CANDIDATE_ROLES)[number];

export const FEATURE_CANDIDATE_PLAN_TYPE = "feature-plan-candidate-v1" as const;
export const FEATURE_CANONICAL_PLAN_TYPE = "feature-canonical-plan-v1" as const;
export const FEATURE_EXECUTION_GRAPH_TYPE =
  "feature-execution-graph-v1" as const;

export const FEATURE_CANDIDATE_PLAN_MAX_BYTES = 128 * 1024;
export const FEATURE_CANONICAL_PLAN_MAX_BYTES = 256 * 1024;
export const FEATURE_EXECUTION_GRAPH_MAX_BYTES = 512 * 1024;
export const FEATURE_PLANNING_CORRECTION_TURNS = 3;

const MAX_PROSE = 32 * 1024;
const MAX_PLAN_ITEMS = 512;
const MAX_TASKS = 256;

const prose = () => Type.String({ minLength: 1, maxLength: MAX_PROSE });
const proseList = (minItems = 0) =>
  Type.Array(prose(), { minItems, maxItems: MAX_PLAN_ITEMS });
const identifier = (prefix: string) =>
  Type.String({ pattern: `^${prefix}-[A-Za-z0-9][A-Za-z0-9._-]*$` });
const taskIdentifier = Type.String({
  pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
  maxLength: 128,
});

const evidenceSchema = Type.Object(
  {
    reference: prose(),
    finding: prose(),
  },
  { additionalProperties: false },
);

const rejectedAlternativeSchema = Type.Object(
  {
    alternative: prose(),
    reason: prose(),
  },
  { additionalProperties: false },
);

const decisionSchema = Type.Object(
  {
    id: identifier("DEC"),
    title: prose(),
    body: prose(),
    evidence: Type.Array(evidenceSchema, {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    rejectedAlternatives: Type.Array(rejectedAlternativeSchema, {
      maxItems: MAX_PLAN_ITEMS,
    }),
  },
  { additionalProperties: false },
);

const changeSchema = Type.Object(
  {
    id: identifier("CHANGE"),
    path: prose(),
    symbols: proseList(),
    action: Type.Union([
      Type.Literal("add"),
      Type.Literal("modify"),
      Type.Literal("delete"),
      Type.Literal("move"),
    ]),
    body: prose(),
    decisionRefs: Type.Array(identifier("DEC"), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    contractRefs: Type.Array(identifier("INV"), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    acceptanceRefs: Type.Array(identifier("AC"), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
  },
  { additionalProperties: false },
);

const contractSchema = Type.Object(
  {
    id: identifier("INV"),
    title: prose(),
    body: prose(),
    paths: Type.Array(prose(), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
  },
  { additionalProperties: false },
);

const acceptanceSchema = Type.Object(
  {
    id: identifier("AC"),
    scenario: prose(),
    expected: prose(),
    verification: prose(),
  },
  { additionalProperties: false },
);

const verificationSchema = Type.Object(
  {
    id: identifier("CHECK"),
    command: prose(),
    cwd: Type.String({
      ...prose(),
      description:
        'Directory relative to the assigned worktree root: "." or "apps/core". Never an absolute path, working_dir/workspaceRoot, "~", or a path containing "..". Preserve existing verified command/cwd pairs exactly.',
    }),
    purpose: prose(),
    proves: Type.Array(Type.Union([identifier("AC"), identifier("INV")]), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

const riskSchema = Type.Object(
  {
    id: identifier("RISK"),
    description: prose(),
    mitigation: prose(),
  },
  { additionalProperties: false },
);

const planFields = {
  summary: prose(),
  decisions: Type.Array(decisionSchema, {
    minItems: 1,
    maxItems: MAX_PLAN_ITEMS,
  }),
  changes: Type.Array(changeSchema, {
    minItems: 1,
    maxItems: MAX_PLAN_ITEMS,
  }),
  contracts: Type.Array(contractSchema, {
    minItems: 1,
    maxItems: MAX_PLAN_ITEMS,
  }),
  acceptance: Type.Array(acceptanceSchema, {
    minItems: 1,
    maxItems: MAX_PLAN_ITEMS,
  }),
  verification: Type.Array(verificationSchema, {
    minItems: 1,
    maxItems: MAX_PLAN_ITEMS,
  }),
  risks: Type.Array(riskSchema, { maxItems: MAX_PLAN_ITEMS }),
};

export const FEATURE_CANDIDATE_PLAN_SCHEMA = Type.Object(
  {
    reportType: Type.Literal(FEATURE_CANDIDATE_PLAN_TYPE),
    role: Type.Union([Type.Literal("Minimal"), Type.Literal("Robust")]),
    ...planFields,
    blockers: proseList(),
    tradeoffs: proseList(1),
  },
  { additionalProperties: false },
);

export const FEATURE_CANONICAL_PLAN_SCHEMA = Type.Object(
  {
    reportType: Type.Literal(FEATURE_CANONICAL_PLAN_TYPE),
    ...planFields,
    blockers: Type.Array(prose(), { maxItems: 0 }),
    finalRationale: prose(),
  },
  { additionalProperties: false },
);

const executionCheckSchema = Type.Object(
  {
    id: Type.String({
      pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
      maxLength: 128,
    }),
    command: prose(),
    cwd: Type.String({
      ...prose(),
      description:
        'Directory relative to the assigned worktree root: "." or "apps/core". Never an absolute path, working_dir/workspaceRoot, "~", or a path containing "..". Preserve existing verified command/cwd pairs exactly.',
    }),
    purpose: prose(),
    required: Type.Boolean(),
  },
  { additionalProperties: false },
);

const precedentSchema = Type.Object(
  {
    path: prose(),
    symbol: prose(),
    lesson: prose(),
  },
  { additionalProperties: false },
);

const taskContextSchema = Type.Object(
  {
    problem: prose(),
    repositoryConventions: proseList(1),
    relevantDiscovery: proseList(1),
    precedents: Type.Array(precedentSchema, {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    invariants: proseList(1),
  },
  { additionalProperties: false },
);

const executionTaskSchema = Type.Object(
  {
    id: taskIdentifier,
    objective: prose(),
    branchGoal: prose(),
    dependsOn: Type.Array(taskIdentifier, { maxItems: MAX_TASKS }),
    context: taskContextSchema,
    readPaths: Type.Array(prose(), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    writePaths: Type.Array(prose(), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    instructions: proseList(1),
    implementationSketch: prose(),
    acceptanceRefs: Type.Array(identifier("AC"), {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    doneWhen: proseList(1),
    checks: Type.Array(executionCheckSchema, {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
  },
  { additionalProperties: false },
);

export const FEATURE_EXECUTION_GRAPH_SCHEMA = Type.Object(
  {
    reportType: Type.Literal(FEATURE_EXECUTION_GRAPH_TYPE),
    summary: prose(),
    baselineChecks: Type.Array(executionCheckSchema, {
      maxItems: MAX_PLAN_ITEMS,
    }),
    reviewChecks: Type.Array(executionCheckSchema, {
      minItems: 1,
      maxItems: MAX_PLAN_ITEMS,
    }),
    tasks: Type.Array(executionTaskSchema, {
      minItems: 1,
      maxItems: MAX_TASKS,
    }),
  },
  { additionalProperties: false },
);

export type FeatureCandidatePlan = Static<typeof FEATURE_CANDIDATE_PLAN_SCHEMA>;
export type FeatureCanonicalPlan = Static<typeof FEATURE_CANONICAL_PLAN_SCHEMA>;
export type FeatureExecutionGraph = Static<
  typeof FEATURE_EXECUTION_GRAPH_SCHEMA
>;
export type FeatureExecutionTask = FeatureExecutionGraph["tasks"][number];
export type FeatureExecutionCheck =
  FeatureExecutionGraph["baselineChecks"][number];

export const FEATURE_CANDIDATE_PLAN_SUBMISSION = {
  name: "pipeline_feature_plan_candidate_submit",
  description: "Submit one complete validated feature plan candidate.",
  parameters: FEATURE_CANDIDATE_PLAN_SCHEMA,
} as const;

export const FEATURE_CANONICAL_PLAN_SUBMISSION = {
  name: "pipeline_feature_canonical_plan_submit",
  description: "Submit the complete authoritative feature plan.",
  parameters: FEATURE_CANONICAL_PLAN_SCHEMA,
} as const;

export const FEATURE_EXECUTION_GRAPH_SUBMISSION = {
  name: "pipeline_feature_execution_graph_submit",
  description: "Submit the small-task execution DAG for the canonical plan.",
  parameters: FEATURE_EXECUTION_GRAPH_SCHEMA,
} as const;

function serializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function duplicates(values: ReadonlyArray<string>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

export function isSafeRepositoryRelativePath(value: string, allowDot = false) {
  if (value === ".") return allowDot;
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function validateSafePaths(
  entries: ReadonlyArray<{ readonly label: string; readonly value: string }>,
  allowDot = false,
) {
  return entries
    .filter(({ value }) => !isSafeRepositoryRelativePath(value, allowDot))
    .map(
      ({ label, value }) =>
        `${label} must be a safe repository-relative path: ${JSON.stringify(value)}.`,
    );
}

function validateUniqueIds(namespace: string, values: ReadonlyArray<string>) {
  return duplicates(values).map(
    (value) => `Duplicate ${namespace} ID: ${value}.`,
  );
}

function validatePlanSemantics(
  plan: FeatureCandidatePlan | FeatureCanonicalPlan,
) {
  const issues: string[] = [];
  const decisionIdList = plan.decisions.map(({ id }) => id);
  const contractIdList = plan.contracts.map(({ id }) => id);
  const acceptanceIdList = plan.acceptance.map(({ id }) => id);
  const decisionIds = new Set(decisionIdList);
  const contractIds = new Set(contractIdList);
  const acceptanceIds = new Set(acceptanceIdList);
  issues.push(
    ...validateUniqueIds("decision", decisionIdList),
    ...validateUniqueIds(
      "change",
      plan.changes.map(({ id }) => id),
    ),
    ...validateUniqueIds("contract", contractIdList),
    ...validateUniqueIds("acceptance", acceptanceIdList),
    ...validateUniqueIds(
      "verification",
      plan.verification.map(({ id }) => id),
    ),
    ...validateUniqueIds(
      "risk",
      plan.risks.map(({ id }) => id),
    ),
  );

  for (const change of plan.changes) {
    for (const reference of change.decisionRefs) {
      if (!decisionIds.has(reference)) {
        issues.push(`${change.id} references unknown decision ${reference}.`);
      }
    }
    for (const reference of change.contractRefs) {
      if (!contractIds.has(reference)) {
        issues.push(`${change.id} references unknown contract ${reference}.`);
      }
    }
    for (const reference of change.acceptanceRefs) {
      if (!acceptanceIds.has(reference)) {
        issues.push(
          `${change.id} references unknown acceptance criterion ${reference}.`,
        );
      }
    }
  }
  for (const check of plan.verification) {
    for (const reference of check.proves) {
      if (!acceptanceIds.has(reference) && !contractIds.has(reference)) {
        issues.push(`${check.id} proves unknown plan reference ${reference}.`);
      }
    }
  }

  issues.push(
    ...validateSafePaths([
      ...plan.changes.map(({ id, path: value }) => ({
        label: `${id}.path`,
        value,
      })),
      ...plan.contracts.flatMap(({ id, paths }) =>
        paths.map((value) => ({ label: `${id}.paths`, value })),
      ),
    ]),
    ...validateSafePaths(
      plan.verification.map(({ id, cwd: value }) => ({
        label: `${id}.cwd`,
        value,
      })),
      true,
    ),
  );
  return issues;
}

function validatePlan<T extends FeatureCandidatePlan | FeatureCanonicalPlan>(
  schema:
    typeof FEATURE_CANDIDATE_PLAN_SCHEMA | typeof FEATURE_CANONICAL_PLAN_SCHEMA,
  maximumBytes: number,
  value: unknown,
) {
  const issues: string[] = [];
  if (serializedBytes(value) > maximumBytes) {
    issues.push(`Plan exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  if (!Value.Check(schema, value)) {
    issues.push("Plan does not match its strict TypeBox schema.");
    return issues;
  }
  issues.push(...validatePlanSemantics(value as T));
  return issues;
}

export function validateFeatureCandidatePlan(value: unknown) {
  return validatePlan<FeatureCandidatePlan>(
    FEATURE_CANDIDATE_PLAN_SCHEMA,
    FEATURE_CANDIDATE_PLAN_MAX_BYTES,
    value,
  );
}

export function validateFeatureCandidatePlanForRole(
  role: FeaturePlanCandidateRole,
  value: unknown,
) {
  const issues = validateFeatureCandidatePlan(value);
  if (
    Value.Check(FEATURE_CANDIDATE_PLAN_SCHEMA, value) &&
    value.role !== role
  ) {
    issues.push(
      `Candidate plan role ${value.role} does not match assigned role ${role}.`,
    );
  }
  return issues;
}

export function validateFeatureCanonicalPlan(value: unknown) {
  return validatePlan<FeatureCanonicalPlan>(
    FEATURE_CANONICAL_PLAN_SCHEMA,
    FEATURE_CANONICAL_PLAN_MAX_BYTES,
    value,
  );
}

function parsePlan<T>(
  value: unknown,
  validate: (candidate: unknown) => ReadonlyArray<string>,
) {
  const issues = validate(value);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return value as T;
}

export function parseFeatureCandidatePlan(value: unknown) {
  return parsePlan<FeatureCandidatePlan>(value, validateFeatureCandidatePlan);
}

export function parseFeatureCandidatePlanForRole(
  role: FeaturePlanCandidateRole,
  value: unknown,
) {
  return parsePlan<FeatureCandidatePlan>(value, (candidate) =>
    validateFeatureCandidatePlanForRole(role, candidate),
  );
}

export function parseFeatureCanonicalPlan(value: unknown) {
  return parsePlan<FeatureCanonicalPlan>(value, validateFeatureCanonicalPlan);
}

export function validateFeatureExecutionGraphSchema(value: unknown) {
  const issues: string[] = [];
  if (serializedBytes(value) > FEATURE_EXECUTION_GRAPH_MAX_BYTES) {
    issues.push(
      `Execution graph exceeds ${FEATURE_EXECUTION_GRAPH_MAX_BYTES} UTF-8 bytes.`,
    );
  }
  if (!Value.Check(FEATURE_EXECUTION_GRAPH_SCHEMA, value)) {
    issues.push("Execution graph does not match its strict TypeBox schema.");
  }
  return issues;
}

export function parseFeatureExecutionGraph(value: unknown) {
  const issues = validateFeatureExecutionGraphSchema(value);
  if (issues.length > 0) throw new Error(issues.join(" "));
  return value as FeatureExecutionGraph;
}

function parseText<T>(
  textValue: string,
  maximumBytes: number,
  label: string,
  parse: (value: unknown) => T,
) {
  if (Buffer.byteLength(textValue, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch {
    throw new Error(`${label} must be exactly one JSON object.`);
  }
  return parse(value);
}

export function parseFeatureCandidatePlanText(textValue: string) {
  return parseText(
    textValue,
    FEATURE_CANDIDATE_PLAN_MAX_BYTES,
    "Candidate plan",
    parseFeatureCandidatePlan,
  );
}

export function parseFeatureCanonicalPlanText(textValue: string) {
  return parseText(
    textValue,
    FEATURE_CANONICAL_PLAN_MAX_BYTES,
    "Canonical plan",
    parseFeatureCanonicalPlan,
  );
}

export function parseFeatureExecutionGraphText(textValue: string) {
  return parseText(
    textValue,
    FEATURE_EXECUTION_GRAPH_MAX_BYTES,
    "Execution graph",
    parseFeatureExecutionGraph,
  );
}
