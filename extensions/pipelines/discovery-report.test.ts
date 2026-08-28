import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  type FeaturePipelineDiscoveryRole,
} from "./domain.ts";
import {
  FEATURE_DISCOVERY_COVERAGE,
  FEATURE_DISCOVERY_FAN_IN_MAX_BYTES,
  FEATURE_DISCOVERY_REPORT_MAX_BYTES,
  featureDiscoveryReportSchema,
  validateFeatureDiscoveryFanIn,
  validateFeatureDiscoveryReport,
  type FeatureDiscoveryApplicability,
  type FeatureDiscoveryCoverageStatus,
  type FeatureDiscoveryUnknown,
} from "./discovery-report.ts";
import { createPipelineDiscoverySubmitTool } from "./session.ts";

function validReport(role: FeaturePipelineDiscoveryRole) {
  const evidence = [
    {
      kind: "code" as const,
      reference: "extensions/pipelines/controller.ts",
      detail: "The controller supplies direct behavior evidence",
    },
  ];
  const candidates = [
    {
      scenario: "A discovery turn settles",
      expected: "Validated evidence is retained",
      verification: "Inspect the parsed fan-in context",
      evidence,
    },
    {
      scenario: "Discovery is incomplete",
      expected: "The gap and safe assumption stay explicit",
      verification: "Inspect coverage and unknown records",
      evidence,
    },
  ];
  return {
    reportType: "feature-discovery-v2" as const,
    role,
    applicability: "applicable" as FeatureDiscoveryApplicability,
    summary: "Bounded role-specific discovery grounded in repository evidence",
    coverage: FEATURE_DISCOVERY_COVERAGE[role].map((criterion) => ({
      criterion,
      status: "covered" as FeatureDiscoveryCoverageStatus,
      conclusion: `${criterion} is supported by the cited controller behavior`,
      evidence,
      implications: ["Sol should preserve this observed contract"],
    })),
    candidateAcceptanceCriteria:
      role === "discover-outcome" || role === "discover-user-scenarios"
        ? candidates
        : [],
    unknowns: [] as FeatureDiscoveryUnknown[],
    constraints: [],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("all five role-fixed TypeBox schemas accept complete ordered V2 reports", () => {
  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
    const report = validReport(role);
    assert.equal(Value.Check(featureDiscoveryReportSchema(role), report), true);
    assert.deepEqual(validateFeatureDiscoveryReport(role, report), []);
  }
});

test("TypeBox and host reject incomplete, duplicate, and out-of-order coverage", () => {
  const role = "discover-problem";
  const schema = featureDiscoveryReportSchema(role);
  const incomplete = clone(validReport(role));
  incomplete.coverage.pop();
  assert.equal(Value.Check(schema, incomplete), false);
  assert.ok(
    validateFeatureDiscoveryReport(role, incomplete).some((issue) =>
      issue.includes("exactly"),
    ),
  );

  const duplicate = clone(validReport(role));
  duplicate.coverage[1] = clone(duplicate.coverage[0]!);
  assert.equal(Value.Check(schema, duplicate), false);
  assert.ok(
    validateFeatureDiscoveryReport(role, duplicate).some((issue) =>
      issue.includes("duplicate"),
    ),
  );

  const reordered = clone(validReport(role));
  [reordered.coverage[0], reordered.coverage[1]] = [
    reordered.coverage[1]!,
    reordered.coverage[0]!,
  ];
  assert.equal(Value.Check(schema, reordered), false);
  assert.ok(
    validateFeatureDiscoveryReport(role, reordered).some((issue) =>
      issue.includes("order"),
    ),
  );
});

test("TypeBox and host reject evidence-free N/A and insufficient required candidates", () => {
  const problem = clone(validReport("discover-problem"));
  problem.coverage[0] = {
    ...problem.coverage[0]!,
    status: "not_applicable",
    conclusion: "This criterion does not apply to the bounded task",
    evidence: [],
  };
  assert.equal(
    Value.Check(featureDiscoveryReportSchema("discover-problem"), problem),
    false,
  );
  assert.ok(
    validateFeatureDiscoveryReport("discover-problem", problem).some((issue) =>
      issue.includes("requires evidence"),
    ),
  );

  for (const role of ["discover-outcome", "discover-user-scenarios"] as const) {
    const report = clone(validReport(role));
    report.candidateAcceptanceCriteria.pop();
    assert.equal(
      Value.Check(featureDiscoveryReportSchema(role), report),
      false,
    );
    assert.ok(
      validateFeatureDiscoveryReport(role, report).some((issue) =>
        issue.includes("at least 2"),
      ),
    );

    report.applicability = "not_applicable";
    report.candidateAcceptanceCriteria = [];
    assert.equal(Value.Check(featureDiscoveryReportSchema(role), report), true);
  }
});

test("unknown coverage requires distinct actionable safe-assumption records", () => {
  const report = clone(validReport("discover-context"));
  for (const index of [0, 1]) {
    report.coverage[index] = {
      ...report.coverage[index]!,
      status: "unknown",
      conclusion: "Repository evidence does not establish this criterion",
      evidence: [],
    };
  }
  assert.ok(
    validateFeatureDiscoveryReport("discover-context", report).some((issue) =>
      issue.includes("safe assumption"),
    ),
  );
  const unknown = {
    question: "What is the current user journey?",
    whyItMatters: "The acceptance boundary depends on it",
    safeAssumption: "Preserve the current journey until evidence changes",
    resolution: "Inspect the product flow before implementation",
  };
  report.unknowns.push(unknown, clone(unknown));
  assert.ok(
    validateFeatureDiscoveryReport("discover-context", report).some((issue) =>
      issue.includes("duplicate paired records"),
    ),
  );
  report.unknowns[1] = {
    question: "Which direct dependencies constrain the journey?",
    whyItMatters: "Integration behavior depends on those contracts",
    safeAssumption: "Preserve existing dependency contracts",
    resolution: "Inspect direct callers and contract tests",
  };
  assert.deepEqual(
    validateFeatureDiscoveryReport("discover-context", report),
    [],
  );
});

test("host measures the 2 KiB ordinary-field bound in UTF-8 bytes", () => {
  const report = clone(validReport("discover-problem"));
  report.summary = "é".repeat(2 * 1024);
  assert.equal(
    Value.Check(featureDiscoveryReportSchema("discover-problem"), report),
    true,
  );
  assert.ok(
    validateFeatureDiscoveryReport("discover-problem", report).some((issue) =>
      issue.includes("summary exceeds 2048 UTF-8 bytes"),
    ),
  );
});

test("host rejects reports over the 30 KiB UTF-8 report bound", () => {
  assert.equal(FEATURE_DISCOVERY_REPORT_MAX_BYTES, 30 * 1024);
  const report = clone(validReport("discover-problem"));
  report.coverage = report.coverage.map((item) => ({
    ...item,
    conclusion: "x".repeat(2 * 1024),
    implications: ["y".repeat(2 * 1024)],
    evidence: item.evidence.map((record) => ({
      ...record,
      reference: "r".repeat(2 * 1024),
      detail: "d".repeat(2 * 1024),
    })),
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(report), "utf8") >
      FEATURE_DISCOVERY_REPORT_MAX_BYTES,
  );
  assert.ok(
    validateFeatureDiscoveryReport("discover-problem", report).some((issue) =>
      issue.includes("exceeds"),
    ),
  );
});

test("host enforces the 150 KiB serialized five-report fan-in bound", () => {
  assert.equal(FEATURE_DISCOVERY_FAN_IN_MAX_BYTES, 150 * 1024);
  assert.deepEqual(
    validateFeatureDiscoveryFanIn({ payload: "x".repeat(1024) }),
    [],
  );
  assert.ok(
    validateFeatureDiscoveryFanIn({
      payload: "x".repeat(FEATURE_DISCOVERY_FAN_IN_MAX_BYTES),
    }).some((issue) => issue.includes("fan-in exceeds")),
  );
});

test("pipeline_discovery_submit uses the concrete role schema and terminates acceptance", async () => {
  const accepted: unknown[] = [];
  const tool = createPipelineDiscoverySubmitTool("discover-problem", (value) =>
    accepted.push(value),
  );
  const report = validReport("discover-problem");
  assert.equal(tool.name, "pipeline_discovery_submit");
  assert.equal(Value.Check(tool.parameters, report), true);
  assert.equal(
    Value.Check(tool.parameters, validReport("discover-context")),
    false,
  );
  const result = await tool.execute(
    "discovery-submit",
    report,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(accepted, [report]);
});
