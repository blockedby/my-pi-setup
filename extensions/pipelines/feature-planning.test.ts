import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  FEATURE_CANDIDATE_PLAN_SCHEMA,
  FEATURE_CANONICAL_PLAN_SCHEMA,
  FEATURE_EXECUTION_GRAPH_SCHEMA,
  FEATURE_EXECUTION_GRAPH_MAX_BYTES,
  parseFeatureExecutionGraphText,
  parseFeatureCandidatePlanText,
  parseFeatureCandidatePlan,
  parseFeatureExecutionGraph,
  defaultFeaturePlanningNarrative,
  validateFeatureExecutionCheckReferences,
  type FeatureExecutionCheck,
  validateFeatureCandidatePlanForRole,
  validateFeatureCandidatePlan,
  validateFeatureCanonicalPlan,
} from "./feature-planning.ts";

test("defaults omitted presentation fields without relaxing control data or versions", () => {
  const { summary: _summary, ...input } = candidatePlan();
  const result = parseFeatureCandidatePlan(input);
  assert.equal(typeof result.summary, "string");
  assert.deepEqual(result.changes, input.changes);
  assert.equal("summary" in input, false);
  assert.deepEqual(parseFeatureCandidatePlan(candidatePlan()), candidatePlan());
  assert.throws(() =>
    parseFeatureCandidatePlan({
      ...input,
      reportType: "feature-plan-candidate-v2",
    }),
  );
  assert.throws(() => parseFeatureCandidatePlan({ ...input, summary: null }));
  assert.ok(validateFeatureCandidatePlanForRole("Robust", input).length > 0);
  const invalid = candidatePlan();
  invalid.changes[0]!.acceptanceRefs = ["AC-missing"];
  assert.throws(() => parseFeatureCandidatePlan(invalid));
  assert.throws(() => parseFeatureCandidatePlan({ ...input, decisions: [] }));
  assert.deepEqual(defaultFeaturePlanningNarrative({ reportType: "other" }), {
    reportType: "other",
  });
});

test("normalizes only unordered context facts through parsed submissions", () => {
  const input = executionGraph();
  input.tasks.push(executionTask("another-task", ["implement-feature"]));
  for (const task of input.tasks) {
    task.context.repositoryConventions = ["z", "a", "z", "A"];
    task.context.relevantDiscovery = ["second", "first", "second"];
    task.instructions = ["second step", "first step", "second step"];
    task.context.invariants = ["z", "a", "z"];
  }
  const original = structuredClone(input);
  const expected = structuredClone(input);
  for (const task of expected.tasks) {
    task.context.repositoryConventions = ["A", "a", "z"];
    task.context.relevantDiscovery = ["first", "second"];
  }
  const parsed = parseFeatureExecutionGraph(input);
  assert.deepEqual(parsed, expected);
  assert.deepEqual(parseFeatureExecutionGraph(parsed), expected);
  assert.deepEqual(defaultFeaturePlanningNarrative(parsed), expected);
  assert.deepEqual(
    parseFeatureExecutionGraphText(JSON.stringify(input)),
    expected,
  );
  assert.deepEqual(input, original);
  const reordered = structuredClone(input);
  for (const task of reordered.tasks) {
    task.context.repositoryConventions.reverse();
    task.context.relevantDiscovery.reverse();
  }
  assert.deepEqual(parseFeatureExecutionGraph(reordered), expected);
  reordered.tasks[0]!.instructions = ["first step", "second step"];
  assert.deepEqual(
    parseFeatureExecutionGraph(reordered).tasks[0]!.instructions,
    reordered.tasks[0]!.instructions,
  );
});

test("normalization preserves malformed collections and original size violations", () => {
  for (const field of ["repositoryConventions", "relevantDiscovery"] as const) {
    for (const items of [
      [],
      ["valid", 42, "valid"],
      ["", "valid", ""],
      "not an array",
      Array.from({ length: 513 }, () => "duplicate"),
      ["x".repeat(32 * 1024 + 1), "x".repeat(32 * 1024 + 1)],
      Array.from({ length: 20 }, () => "é".repeat(32 * 1024)),
    ]) {
      const input = executionGraph();
      Object.assign(input.tasks[0]!.context, { [field]: items });
      const original = structuredClone(input);
      assert.deepEqual(defaultFeaturePlanningNarrative(input), original);
      assert.throws(() => parseFeatureExecutionGraph(input));
      assert.throws(() =>
        parseFeatureExecutionGraphText(JSON.stringify(input)),
      );
      assert.deepEqual(input, original);
    }
  }
  const oversized = executionGraph();
  oversized.tasks[0]!.context.relevantDiscovery = Array.from(
    { length: 20 },
    () => "x".repeat(32 * 1024),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(oversized)) >
      FEATURE_EXECUTION_GRAPH_MAX_BYTES,
  );
  assert.throws(() =>
    parseFeatureExecutionGraph(defaultFeaturePlanningNarrative(oversized)),
  );
});

test("normalization does not repair control IDs or unknown references", () => {
  const plan = candidatePlan();
  plan.decisions.push(structuredClone(plan.decisions[0]!));
  assert.deepEqual(defaultFeaturePlanningNarrative(plan), plan);
  assert.throws(() => parseFeatureCandidatePlan(plan));
  const graph = executionGraph();
  graph.tasks[0]!.context.relevantDiscovery = ["z", "a", "z"];
  Object.assign(graph.tasks[0]!.checks[0]!, { acceptanceRefs: ["AC-unknown"] });
  const normalized = defaultFeaturePlanningNarrative(graph);
  assert.throws(() => parseFeatureExecutionGraph(normalized));
  assert.deepEqual(
    (normalized as typeof graph).tasks[0]!.checks,
    graph.tasks[0]!.checks,
  );
});

test("execution checks support optional structured acceptance references and preserve exact commands", () => {
  const graph = executionGraph();
  const legacy = parseFeatureExecutionGraph(graph);
  assert.equal(legacy.reviewChecks[0]?.acceptanceRefs, undefined);
  const readonlyRefs: readonly string[] = ["AC-1"];
  const typedCheck: FeatureExecutionCheck = {
    ...graph.reviewChecks[0]!,
    acceptanceRefs: readonlyRefs,
  };
  assert.deepEqual(
    validateFeatureExecutionCheckReferences([typedCheck], ["AC-1"]),
    [],
  );
  assert.equal(
    validateFeatureExecutionCheckReferences([typedCheck], ["AC-other"]).length,
    1,
  );
  const brokenTask = structuredClone(graph);
  Object.assign(brokenTask.tasks[0]!.checks[0]!, {
    acceptanceRefs: ["AC-other"],
  });
  assert.throws(() => parseFeatureExecutionGraph(brokenTask));
  const input = {
    ...graph,
    reviewChecks: graph.reviewChecks.map((check) => ({
      ...check,
      acceptanceRefs: ["AC-1"],
    })),
  };
  const result = parseFeatureExecutionGraph(input);
  assert.deepEqual(result.reviewChecks[0]?.acceptanceRefs, ["AC-1"]);
  assert.equal(result.reviewChecks[0]?.command, graph.reviewChecks[0]?.command);
  for (const acceptanceRefs of [[], ["free form"], ["AC-1", "AC-1"]]) {
    assert.throws(() =>
      parseFeatureExecutionGraph({
        ...input,
        reviewChecks: [{ ...input.reviewChecks[0], acceptanceRefs }],
      }),
    );
  }
  assert.throws(() =>
    parseFeatureExecutionGraph({
      ...input,
      reviewChecks: [{ ...input.reviewChecks[0], required: undefined }],
    }),
  );
});

export function candidatePlan() {
  return {
    reportType: "feature-plan-candidate-v1" as const,
    role: "Minimal" as const,
    summary: "Use the existing pipeline conventions for one bounded feature.",
    decisions: [
      {
        id: "DEC-1",
        title: "One controller-owned transition",
        body: "Keep state changes behind the existing controller boundary.",
        evidence: [
          {
            reference: "extensions/pipelines/controller.ts:settleLimited",
            finding: "The controller already owns terminal state transitions.",
          },
        ],
        rejectedAlternatives: [],
      },
    ],
    changes: [
      {
        id: "CHANGE-1",
        path: "extensions/pipelines/controller.ts",
        symbols: ["PipelineController"],
        action: "modify" as const,
        body: "Add the planned controller transition.",
        decisionRefs: ["DEC-1"],
        contractRefs: ["INV-1"],
        acceptanceRefs: ["AC-1"],
      },
    ],
    contracts: [
      {
        id: "INV-1",
        title: "Single transition",
        body: "Each run reaches a terminal state once.",
        paths: ["extensions/pipelines/controller.ts"],
      },
    ],
    acceptance: [
      {
        id: "AC-1",
        scenario: "The feature completes.",
        expected: "The controller records one terminal result.",
        verification: "Focused controller state-transition tests.",
      },
    ],
    verification: [
      {
        id: "CHECK-1",
        command: "bun test extensions/pipelines/controller.test.ts",
        cwd: ".",
        purpose: "Verify the feature behavior.",
        proves: ["AC-1", "INV-1"],
        required: true,
      },
    ],
    risks: [
      {
        id: "RISK-1",
        description: "A duplicate transition could regress state.",
        mitigation: "Exercise repeated completion in focused tests.",
      },
    ],
    blockers: [],
    tradeoffs: ["The narrow controller change favors repository fit."],
  };
}

export function canonicalPlan() {
  const { role: _role, tradeoffs: _tradeoffs, ...common } = candidatePlan();
  return {
    ...common,
    reportType: "feature-canonical-plan-v1" as const,
    blockers: [],
    finalRationale: "This design is complete and follows local ownership.",
  };
}

export function executionTask(id: string, dependsOn: string[] = []) {
  return {
    id,
    objective: `Implement ${id}.`,
    branchGoal: `Leave ${id} complete and verified.`,
    dependsOn,
    context: {
      problem: `The repository needs ${id}.`,
      repositoryConventions: ["Use strict TypeBox contracts."],
      relevantDiscovery: ["The controller owns execution state."],
      precedents: [
        {
          path: "extensions/pipelines/controller.ts",
          symbol: "PipelineController",
          lesson: "Keep state controller-owned.",
        },
      ],
      invariants: ["Each task is validated at most once."],
    },
    readPaths: ["extensions/pipelines/controller.ts"],
    writePaths: [`extensions/pipelines/${id}.ts`],
    instructions: [`Implement the bounded ${id} responsibility.`],
    implementationSketch: `Add ${id}, connect it locally, and verify it.`,
    acceptanceRefs: ["AC-1"],
    doneWhen: [`${id} passes its focused check.`],
    checks: [
      {
        id: `${id}-test`,
        command: `bun test extensions/pipelines/${id}.test.ts`,
        cwd: ".",
        purpose: `Verify ${id}.`,
        required: true,
      },
    ],
  };
}

export function executionGraph() {
  return {
    reportType: "feature-execution-graph-v1" as const,
    summary: "Execute one prepared implementation task.",
    baselineChecks: [
      {
        id: "typecheck",
        command: "bun run check",
        cwd: ".",
        purpose: "Keep the project compilable after every task.",
        required: true,
      },
    ],
    reviewChecks: [
      {
        id: "feature-tests",
        command: "bun test extensions/pipelines/feature.test.ts",
        cwd: ".",
        purpose: "Verify the integrated feature.",
        required: true,
      },
    ],
    tasks: [executionTask("implement-feature")],
  };
}

test("strict planning schemas accept complete bounded artifacts", () => {
  assert.equal(Check(FEATURE_CANDIDATE_PLAN_SCHEMA, candidatePlan()), true);
  assert.equal(Check(FEATURE_CANONICAL_PLAN_SCHEMA, canonicalPlan()), true);
  assert.equal(Check(FEATURE_EXECUTION_GRAPH_SCHEMA, executionGraph()), true);
  assert.deepEqual(validateFeatureCandidatePlan(candidatePlan()), []);
  assert.deepEqual(validateFeatureCanonicalPlan(canonicalPlan()), []);
});

test("plan validation rejects extra fields, duplicate IDs, and broken references", () => {
  assert.equal(
    Check(FEATURE_CANDIDATE_PLAN_SCHEMA, {
      ...candidatePlan(),
      untrustedExtra: true,
    }),
    false,
  );
  const plan = candidatePlan();
  const issues = validateFeatureCandidatePlan({
    ...plan,
    decisions: [...plan.decisions, plan.decisions[0]],
    changes: [
      {
        ...plan.changes[0],
        decisionRefs: ["DEC-missing"],
      },
    ],
  });
  assert.ok(issues.includes("Duplicate decision ID: DEC-1."));
  assert.ok(
    issues.includes("CHANGE-1 references unknown decision DEC-missing."),
  );
});

test("canonical plans reject blockers and repository path escapes", () => {
  assert.ok(
    validateFeatureCanonicalPlan({
      ...canonicalPlan(),
      blockers: ["Architecture remains undecided."],
    }).length > 0,
  );
  const plan = canonicalPlan();
  const issues = validateFeatureCanonicalPlan({
    ...plan,
    changes: [{ ...plan.changes[0], path: "../outside.ts" }],
    verification: [{ ...plan.verification[0], cwd: "/tmp" }],
  });
  assert.ok(issues.some((issue) => issue.includes("CHANGE-1.path")));
  assert.ok(issues.some((issue) => issue.includes("CHECK-1.cwd")));
});

test("compact final-text JSON fallback uses the same semantic parser", () => {
  assert.deepEqual(
    parseFeatureCandidatePlanText(JSON.stringify(candidatePlan())),
    candidatePlan(),
  );
  assert.throws(
    () => parseFeatureCandidatePlanText("prefix {}"),
    /exactly one JSON object/,
  );
});

test("candidate parsing binds output to its assigned independent role", () => {
  assert.deepEqual(
    validateFeatureCandidatePlanForRole("Minimal", candidatePlan()),
    [],
  );
  assert.ok(
    validateFeatureCandidatePlanForRole("Robust", candidatePlan()).includes(
      "Candidate plan role Minimal does not match assigned role Robust.",
    ),
  );
});
