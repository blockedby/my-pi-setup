import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  STATIC_LUNA_AUDIT_ROLES,
  type FeaturePipelineDiscoveryRole,
} from "./domain.ts";
import { FEATURE_DISCOVERY_COVERAGE } from "./discovery-report.ts";
import { planDiscoveryCoverage } from "./plan-discovery-report.ts";
import {
  validatePipelineReport,
  resolvePlanOutputPath,
  writePlanOutput,
} from "./plan-contract.ts";

test("free-form plan output is safely contained and atomically overwritten", () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-output-"));
  const content = "# Plan\n\n- café\n";
  const destination = path.join(workingDir, "nested", "arbitrary.plan");
  const first = writePlanOutput(workingDir, "nested/arbitrary.plan", content);
  assert.equal(first.relativePath, "nested/arbitrary.plan");
  assert.deepEqual(fs.readFileSync(destination), Buffer.from(content));
  const second = writePlanOutput(workingDir, destination, "replacement\n");
  assert.equal(second.relativePath, first.relativePath);
  assert.equal(fs.readFileSync(destination, "utf8"), "replacement\n");
  assert.equal(
    resolvePlanOutputPath(workingDir, destination).relativePath,
    first.relativePath,
  );
  assert.throws(
    () => resolvePlanOutputPath(workingDir, "nested/../escape.plan"),
    /traversal/,
  );
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("free-form plan output rejects destination and parent symlink escapes", () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-output-"));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "plan-output-outside-"),
  );
  fs.symlinkSync(outside, path.join(workingDir, "link"));
  assert.throws(
    () => writePlanOutput(workingDir, "link/new.plan", "plan"),
    /outside working_dir/,
  );
  const outsideFile = path.join(outside, "existing.plan");
  fs.writeFileSync(outsideFile, "outside");
  fs.symlinkSync(outsideFile, path.join(workingDir, "escape.plan"));
  assert.throws(
    () => writePlanOutput(workingDir, "escape.plan", "replacement"),
    /symbolic link/,
  );
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside");
  fs.rmSync(workingDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("small-feature reports require exact implementation and four-track Luna audit contracts", () => {
  assert.deepEqual(
    validatePipelineReport(
      "small-feature-pipeline",
      "implement-small-feature",
      JSON.stringify({
        summary: "Implemented the bounded behavior",
        changedPaths: ["src/feature.ts"],
        checks: ["focused test passed"],
        assumptions: [],
        unresolvedItems: [],
      }),
    ),
    [],
  );
  for (const invalidReport of [
    {
      summary: "Missing checks and remediation evidence",
      changedPaths: [],
    },
    {
      summary: "Claims implementation without concrete evidence",
      changedPaths: [],
      checks: [],
      assumptions: [],
      unresolvedItems: [],
    },
  ]) {
    assert.match(
      validatePipelineReport(
        "small-feature-pipeline",
        "implement-small-feature",
        JSON.stringify(invalidReport),
      )[0] ?? "",
      /Implementation report must contain exactly/,
    );
  }
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.deepEqual(
      validatePipelineReport(
        "small-feature-pipeline",
        role,
        JSON.stringify({
          track: role,
          findings: [],
          unprovenChecks: [],
        }),
      ),
      [],
    );
  }
  for (const [role, report] of [
    [STATIC_LUNA_AUDIT_ROLES[0], { findings: [] }],
    [
      "audit-small-feature",
      {
        track: "audit-small-feature",
        findings: [],
        unprovenChecks: [],
      },
    ],
  ] as const) {
    assert.match(
      validatePipelineReport(
        "small-feature-pipeline",
        role,
        JSON.stringify(report),
      )[0] ?? "",
      /Small-feature Luna audit must match/,
    );
  }
});

function featureDiscoveryReport(role: FeaturePipelineDiscoveryRole) {
  const evidence = [
    {
      kind: "code",
      reference: "extensions/pipelines/controller.ts",
      detail: "The controller provides direct behavior evidence",
    },
  ];
  const candidates = [
    {
      scenario: "A discovery report settles",
      expected: "The host validates role-complete evidence",
      verification: "Inspect the parsed fan-in context",
      evidence,
    },
    {
      scenario: "A discovery report is malformed",
      expected: "The same session receives a correction",
      verification: "Observe the controller continuation",
      evidence,
    },
  ];
  return JSON.stringify({
    reportType: "feature-discovery-v2",
    role,
    applicability: "applicable",
    summary: "Repository evidence",
    coverage: FEATURE_DISCOVERY_COVERAGE[role].map((criterion) => ({
      criterion,
      status: "covered",
      conclusion: `${criterion} is supported by repository evidence`,
      evidence,
      implications: [],
    })),
    candidateAcceptanceCriteria:
      role === "discover-outcome" || role === "discover-user-scenarios"
        ? candidates
        : [],
    unknowns: [],
    constraints: [],
  });
}

test("feature child report contracts reject malformed programmatic discovery", () => {
  const valid = featureDiscoveryReport("discover-problem");
  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
    assert.deepEqual(
      validatePipelineReport(
        "feature-pipeline",
        role,
        featureDiscoveryReport(role),
      ),
      [],
    );
  }
  assert.match(
    validatePipelineReport(
      "feature-pipeline",
      "discover-problem",
      "not-json",
    )[0] ?? "",
    /exactly one JSON object/,
  );
  assert.deepEqual(
    validatePipelineReport(
      "feature-pipeline",
      STATIC_LUNA_AUDIT_ROLES[0],
      JSON.stringify({
        track: STATIC_LUNA_AUDIT_ROLES[0],
        findings: [],
        unprovenChecks: [],
      }),
    ),
    [],
  );
});

test("plan child report contracts bind every discovery role and reject legacy reports", () => {
  const evidence = [
    {
      kind: "code",
      reference: "extensions/pipelines/controller.ts",
      detail: "The controller provides direct local evidence.",
    },
  ];
  for (const role of PLAN_PIPELINE_DISCOVERY_ROLES) {
    const report = {
      reportType: "plan-discovery-v1",
      role,
      applicability: "applicable",
      summary: "Repository evidence",
      coverage: planDiscoveryCoverage(role).map((criterion) => ({
        criterion,
        status: "covered",
        conclusion: "The criterion is covered.",
        evidence,
        implications: [],
      })),
      evidence,
      unknowns: [],
      constraints: [],
    };
    assert.deepEqual(
      validatePipelineReport("plan-pipeline", role, JSON.stringify(report)),
      [],
    );
  }
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "discover-requirements-boundaries",
      "not json",
    )[0] ?? "",
    /JSON object/,
  );
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "discover-contracts-invariants",
      JSON.stringify({
        reportType: "plan-discovery-v1",
        role: "discover-contracts-invariants",
        applicability: "applicable",
        summary: "Incomplete evidence",
        coverage: [],
        evidence: [],
        unknowns: [],
        constraints: [],
      }),
    )[0] ?? "",
    /strict.*schema/,
  );
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "audit-decomposition-dag",
      JSON.stringify({ track: "legacy", findings: [], unprovenChecks: [] }),
    )[0] ?? "",
    /Unsupported plan-pipeline report role/,
  );
  assert.match(
    validatePipelineReport(
      "feature-pipeline",
      "discover-problem",
      "feature reports now fail closed",
    )[0] ?? "",
    /exactly one JSON object/,
  );
});
