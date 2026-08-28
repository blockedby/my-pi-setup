import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { PLAN_PIPELINE_DISCOVERY_ROLES } from "./domain.ts";
import {
  planDiscoveryCoverage,
  planDiscoveryReportSchema,
  validatePlanDiscoveryReport,
} from "./plan-discovery-report.ts";

function reportFor(role: (typeof PLAN_PIPELINE_DISCOVERY_ROLES)[number]) {
  const evidence = [
    {
      kind: "code" as const,
      reference: "extensions/pipelines/controller.ts",
      detail: "The controller is the relevant local evidence.",
    },
  ];
  return {
    reportType: "plan-discovery-v1" as const,
    role,
    applicability: "applicable" as const,
    summary: "Evidence is available.",
    coverage: planDiscoveryCoverage(role).map((criterion) => ({
      criterion,
      status: "covered" as const,
      conclusion: "The criterion is covered by evidence.",
      evidence,
      implications: [],
    })),
    evidence,
    unknowns: [],
    constraints: [],
  };
}

test("plan discovery schemas bind each report to its concrete role", () => {
  for (const role of PLAN_PIPELINE_DISCOVERY_ROLES) {
    const report = reportFor(role);
    assert.equal(Check(planDiscoveryReportSchema(role), report), true);
    assert.deepEqual(validatePlanDiscoveryReport(role, report), []);
    assert.equal(
      Check(
        planDiscoveryReportSchema(role),
        reportFor(
          PLAN_PIPELINE_DISCOVERY_ROLES.find(
            (candidate) => candidate !== role,
          )!,
        ),
      ),
      false,
    );
  }
});

test("plan discovery schemas reject extra fields and missing evidence", () => {
  const role = PLAN_PIPELINE_DISCOVERY_ROLES[0];
  const report = reportFor(role);
  assert.equal(
    Check(planDiscoveryReportSchema(role), { ...report, extra: true }),
    false,
  );
  assert.ok(
    validatePlanDiscoveryReport(role, {
      ...report,
      evidence: [],
    }).length > 0,
  );
});
