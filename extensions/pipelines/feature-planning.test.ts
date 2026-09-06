import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  FEATURE_CANDIDATE_PLAN_SCHEMA,
  FEATURE_CANONICAL_PLAN_SCHEMA,
  FEATURE_EXECUTION_GRAPH_SCHEMA,
  parseFeatureCandidatePlanText,
  validateFeatureCandidatePlanForRole,
  validateFeatureCandidatePlan,
  validateFeatureCanonicalPlan,
} from "./feature-planning.ts";

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
