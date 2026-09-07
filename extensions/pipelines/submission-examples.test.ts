import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  AUDIT_SEGMENT_LUNA_ROLES,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_PLAN_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  type PipelineRunRequest,
} from "./domain.ts";
import {
  parseFeatureDiscoveryReportText,
  featureDiscoveryReportSchema,
} from "./discovery-report.ts";
import {
  parseFeatureCandidatePlanForRole,
  parseFeatureCanonicalPlanText,
  parseFeatureExecutionGraphText,
} from "./feature-planning.ts";
import { validateFeatureExecutionGraph } from "./feature-graph.ts";
import {
  AuditSegment,
  auditTrackReportSchema,
  type AuditSegmentContext,
} from "./audit-segment.ts";
import {
  parsePlanDiscoveryReportText,
  planDiscoveryReportSchema,
} from "./plan-discovery-report.ts";
import { createPipelinePlanSubmitTool } from "./session.ts";
import {
  AUDIT_SUBMISSION_EXAMPLES,
  FEATURE_CANDIDATE_PLAN_EXAMPLES,
  FEATURE_CANONICAL_PLAN_EXAMPLE,
  FEATURE_DISCOVERY_EXAMPLES,
  FEATURE_EXECUTION_GRAPH_EXAMPLE,
  FEATURE_PLAN_EXAMPLES,
  PLAN_DISCOVERY_EXAMPLES,
  PLAN_SUBMISSION_EXAMPLE,
  SUBMISSION_EXAMPLE_ROLES,
  exampleFor,
  renderSubmissionExample,
} from "./submission-examples.ts";
import {
  buildFeatureCandidatePlanPrompt,
  buildFeatureCanonicalPlanPrompt,
  buildFeatureExecutionGraphPrompt,
  buildPipelineChildPrompt,
  buildPlanPipelinePrompt,
} from "./prompt.ts";

const request = {
  pipelineName: "example-submission",
  workingDir: ".",
  task: "Use the compact submission example as illustrative contract data.",
} satisfies PipelineRunRequest;

const auditEvidence = { state: "available" as const, value: "" };
const auditContext = {
  task: "Audit the illustrative submission contract.",
  acceptanceContract: "The submission has the declared shape.",
  assumptions: [],
  checks: [],
  input: { mode: "initial" as const, acceptanceCriteria: [] },
  git: {
    baseSha: "base-example",
    headSha: "head-example",
    worktreeLabel: "WORKTREE" as const,
    workingDir: ".",
    branch: "example",
    status: auditEvidence,
    baseIsAncestor: "yes" as const,
    commits: auditEvidence,
    committedDiff: auditEvidence,
    dirtyDiff: auditEvidence,
    combinedDiff: auditEvidence,
  },
  purpose: "standalone" as const,
} satisfies AuditSegmentContext;

test("feature discovery examples pass strict and semantic parsing for every role", () => {
  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
    const example = FEATURE_DISCOVERY_EXAMPLES[role];
    assert.equal(Check(featureDiscoveryReportSchema(role), example), true);
    assert.deepEqual(
      parseFeatureDiscoveryReportText(role, JSON.stringify(example)),
      example,
    );
    assert.deepEqual(exampleFor(role), example);
  }
});

test("plan discovery examples pass strict and semantic parsing for every role", () => {
  for (const role of PLAN_PIPELINE_DISCOVERY_ROLES) {
    const example = PLAN_DISCOVERY_EXAMPLES[role];
    assert.equal(Check(planDiscoveryReportSchema(role), example), true);
    assert.deepEqual(
      parsePlanDiscoveryReportText(role, JSON.stringify(example)),
      example,
    );
    assert.deepEqual(exampleFor(role), example);
  }
});

test("audit track examples pass the strict schema and the real segment parser", () => {
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    const example = AUDIT_SUBMISSION_EXAMPLES[role];
    assert.equal(Check(auditTrackReportSchema(role), example), true);
    const segment = new AuditSegment(auditContext);
    assert.doesNotThrow(() => segment.acceptSubmitted(role, example, 1));
    assert.deepEqual(exampleFor(role), example);
  }
});

test("feature planning examples pass role, semantic, and graph validation", () => {
  for (const role of FEATURE_PLAN_ROLES) {
    const example = FEATURE_PLAN_EXAMPLES[role];
    const candidateRole =
      role === "feature-plan-minimal" ? "Minimal" : "Robust";
    assert.deepEqual(
      parseFeatureCandidatePlanForRole(candidateRole, example),
      example,
    );
    assert.deepEqual(exampleFor(role), example);
  }

  const canonical = parseFeatureCanonicalPlanText(
    JSON.stringify(FEATURE_CANONICAL_PLAN_EXAMPLE),
  );
  const graph = parseFeatureExecutionGraphText(
    JSON.stringify(FEATURE_EXECUTION_GRAPH_EXAMPLE),
  );
  assert.deepEqual(canonical, FEATURE_CANONICAL_PLAN_EXAMPLE);
  assert.deepEqual(graph, FEATURE_EXECUTION_GRAPH_EXAMPLE);
  assert.deepEqual(validateFeatureExecutionGraph(canonical, graph), []);
  assert.deepEqual(exampleFor("feature-canonical-plan"), canonical);
  assert.deepEqual(exampleFor("feature-execution-graph"), graph);
  assert.deepEqual(
    exampleFor("Minimal"),
    FEATURE_CANDIDATE_PLAN_EXAMPLES.Minimal,
  );
});

test("plan submission example is accepted by the real terminating tool schema", async () => {
  let submitted: unknown;
  const tool = createPipelinePlanSubmitTool((value) => {
    submitted = value;
  });
  assert.equal(Check(tool.parameters, PLAN_SUBMISSION_EXAMPLE), true);
  const result = await tool.execute(
    "submission-example",
    PLAN_SUBMISSION_EXAMPLE,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(submitted, PLAN_SUBMISSION_EXAMPLE);
  assert.deepEqual(exampleFor("plan-synthesis"), PLAN_SUBMISSION_EXAMPLE);
});

test("role prompts contain the serialized example for their applicable submission", () => {
  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
    const prompt = buildPipelineChildPrompt("feature-pipeline", role, request);
    assert.equal(prompt.includes(renderSubmissionExample(role)), true);
  }
  for (const role of PLAN_PIPELINE_DISCOVERY_ROLES) {
    const prompt = buildPipelineChildPrompt("plan-pipeline", role, request);
    assert.equal(prompt.includes(renderSubmissionExample(role)), true);
  }
  for (const role of AUDIT_SEGMENT_LUNA_ROLES) {
    const prompt = buildPipelineChildPrompt("audit-pipeline", role, request);
    assert.equal(prompt.includes(renderSubmissionExample(role)), true);
  }

  assert.equal(
    buildFeatureCandidatePlanPrompt(
      "feature-plan-minimal",
      request,
      "base",
      [],
    ).includes(renderSubmissionExample("feature-plan-minimal")),
    true,
  );
  assert.equal(
    buildFeatureCanonicalPlanPrompt(request, [], []).includes(
      renderSubmissionExample("feature-canonical-plan"),
    ),
    true,
  );
  assert.equal(
    buildFeatureExecutionGraphPrompt(FEATURE_CANONICAL_PLAN_EXAMPLE).includes(
      renderSubmissionExample("feature-execution-graph"),
    ),
    true,
  );
  assert.equal(
    buildPlanPipelinePrompt(request).includes(
      renderSubmissionExample("plan-synthesis"),
    ),
    true,
  );
});

test("example role registry is complete and duplicate-free", () => {
  assert.equal(
    new Set(SUBMISSION_EXAMPLE_ROLES).size,
    SUBMISSION_EXAMPLE_ROLES.length,
  );
  for (const role of SUBMISSION_EXAMPLE_ROLES) {
    assert.equal(renderSubmissionExample(role).length > 0, true);
  }
});
