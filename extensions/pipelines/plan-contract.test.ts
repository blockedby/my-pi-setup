import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  resolvePlanArtifact,
  validatePipelineReport,
  validatePlanArtifact,
  writePlanArtifact,
} from "./plan-contract.ts";

function validPlan() {
  return `# Durable implementation plan

## Goal and non-goals
Implement the goal without unrelated refactors.

## Evidence and assumptions
Repository evidence and named assumptions.

## Candidate acceptance criteria
- AC1 is observable.

## Frontend tasks
Not applicable based on repository evidence.

## Backend tasks
### TASK-001: Change the service contract
- **Scope:** Add the bounded service behavior.
- **Likely paths/components:** src/service.ts
- **Dependencies:** None.
- **Acceptance/verification evidence:** Unit and contract tests pass.

## DevOps tasks
Not applicable based on repository evidence.

## Cross-cutting tasks
### TASK-002: Update documentation
- **Scope:** Document the public behavior.
- **Likely paths/components:** README.md
- **Dependencies:** TASK-001.
- **Acceptance/verification evidence:** Documentation review matches AC1.

## Test plan
- Unit: service behavior.
- Integration: not applicable because there is one package.
- Contract: public API fixture.
- E2E: not applicable because there is no user interface.
- Operational: package smoke check.

## Implementation waves
- Wave 1: TASK-001
- Wave 2: TASK-002 after TASK-001

## Risks, rollout, and rollback
Revert the service change and documentation together.

## Unresolved questions
- Confirm the release owner.
`;
}

test("plan artifact contract accepts stable tasks, explicit N/A layers, and complete checks", () => {
  assert.deepEqual(validatePlanArtifact(validPlan()), []);
});

test("plan artifact contract reports structural and task evidence gaps", () => {
  const invalid = validPlan()
    .replace("## Candidate acceptance criteria\n", "")
    .replace("- **Dependencies:** None.\n", "")
    .replace("- Operational: package smoke check.\n", "")
    .replace("- Wave 2: TASK-002 after TASK-001\n", "");
  const issues = validatePlanArtifact(invalid);
  assert.ok(
    issues.some((issue) => issue.includes("Candidate acceptance criteria")),
  );
  assert.ok(
    issues.some((issue) => issue.includes("TASK-001 is missing Dependencies")),
  );
  assert.ok(issues.some((issue) => issue.includes("operational checks")));
  assert.ok(issues.some((issue) => issue.includes("TASK-002 is not assigned")));
});

test("plan artifact contract rejects misplaced tasks and dependency-unsafe waves", () => {
  const misplaced = validPlan()
    .replace(
      "## Unresolved questions\n- Confirm the release owner.",
      "## Unresolved questions\n### TASK-003: Misplaced task\n- **Scope:** Wrong section.\n- **Likely paths/components:** src/wrong.ts\n- **Dependencies:** None.\n- **Acceptance/verification evidence:** A check.\n- Confirm the release owner.",
    )
    .replace(
      "- Wave 2: TASK-002 after TASK-001",
      "- Wave 2: TASK-002 after TASK-001\n- Wave 3: TASK-003",
    );
  assert.ok(
    validatePlanArtifact(misplaced).some((issue) =>
      issue.includes("TASK-003 must be located"),
    ),
  );

  const unsafe = validPlan()
    .replace("- Wave 1: TASK-001", "- Wave 2: TASK-001")
    .replace("- Wave 2: TASK-002 after TASK-001", "- Wave 1: TASK-002");
  assert.ok(
    validatePlanArtifact(unsafe).some((issue) =>
      issue.includes("TASK-002 must be in a later wave"),
    ),
  );
});

test("plan artifact path must stay under repository-local docs/plans", () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-contract-"));
  fs.mkdirSync(path.join(workingDir, "docs", "plans"), { recursive: true });
  const artifact = writePlanArtifact(
    workingDir,
    "docs/plans/goal.md",
    validPlan(),
  );
  assert.equal(artifact.relativePath, "docs/plans/goal.md");
  assert.throws(
    () => resolvePlanArtifact(workingDir, "../outside.md"),
    /repository-local docs\/plans/,
  );
  writePlanArtifact(workingDir, "docs/plans/target.md", validPlan());
  fs.rmSync(path.join(workingDir, "docs", "plans", "goal.md"));
  fs.symlinkSync(
    "target.md",
    path.join(workingDir, "docs", "plans", "goal.md"),
  );
  assert.throws(
    () => resolvePlanArtifact(workingDir, "docs/plans/goal.md"),
    /must not be a symbolic link/,
  );
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan writes reject an escaping parent symlink before creating outside directories", () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-contract-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "plan-outside-"));
  fs.symlinkSync(outside, path.join(workingDir, "docs"));
  assert.throws(
    () => writePlanArtifact(workingDir, "docs/plans/goal.md", validPlan()),
    /parent resolves outside working_dir/,
  );
  assert.equal(fs.existsSync(path.join(outside, "plans")), false);
  fs.rmSync(workingDir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("small-feature reports require exact Luna implementation and Terra audit contracts", () => {
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
  assert.deepEqual(
    validatePipelineReport(
      "small-feature-pipeline",
      "audit-small-feature",
      JSON.stringify({
        mode: "initial",
        base_sha: "1234567",
        head_sha: "WORKTREE",
        verdict: "READY",
        findings: [],
        summary: "No actionable findings",
      }),
    ),
    [],
  );
  assert.match(
    validatePipelineReport(
      "small-feature-pipeline",
      "audit-small-feature",
      JSON.stringify({ findings: [] }),
    )[0] ?? "",
    /complete canonical initial-review JSON result schema/,
  );
});

test("plan child report contracts distinguish discovery, Luna audit, and Terra audit", () => {
  assert.deepEqual(
    validatePipelineReport(
      "plan-pipeline",
      "discover-frontend-scope",
      JSON.stringify({
        summary: "Not applicable",
        evidence: ["No browser package exists"],
        unknowns: [],
        constraints: [],
      }),
    ),
    [],
  );
  assert.deepEqual(
    validatePipelineReport(
      "plan-pipeline",
      "audit-decomposition-dag",
      JSON.stringify({
        track: "dag",
        findings: [
          {
            title: "Unsafe dependency wave",
            scenario: "TASK-002 runs before its dependency",
            expected: "Dependencies run first",
            actual: "Both tasks are in wave one",
            affectedPaths: ["docs/plans/goal.md"],
            relationship: "introduced",
            evidenceType: "artifact",
            evidence: "The implementation waves section lists both tasks",
            impact: 2,
            confidence: 90,
            minimalNextAction: "Move TASK-002 to wave two",
          },
        ],
        unprovenChecks: [
          {
            claim: "The release owner exists",
            reason: "No ownership file was found",
            requiredCheck: "Confirm the owner before implementation",
          },
        ],
      }),
    ),
    [],
  );
  assert.deepEqual(
    validatePipelineReport(
      "plan-pipeline",
      "final-audit",
      JSON.stringify({
        mode: "initial",
        base_sha: "1234567",
        head_sha: "WORKTREE",
        verdict: "READY",
        findings: [],
        summary: "No findings",
      }),
    ),
    [],
  );
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "discover-backend-scope",
      "not json",
    )[0] ?? "",
    /JSON object/,
  );
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "discover-backend-scope",
      JSON.stringify({
        summary: "Backend scope",
        evidence: [],
        unknowns: [],
        constraints: [],
        extra: true,
      }),
    )[0] ?? "",
    /exactly/,
  );
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "audit-decomposition-dag",
      JSON.stringify({ track: "dag", findings: [{}], unprovenChecks: [] }),
    )[0] ?? "",
    /complete.*schema/,
  );
  assert.match(
    validatePipelineReport(
      "plan-pipeline",
      "final-audit",
      JSON.stringify({
        mode: "initial",
        verdict: "anything",
        findings: [],
        summary: "Incomplete canonical result",
      }),
    )[0] ?? "",
    /complete canonical initial-review JSON result schema/,
  );
  assert.deepEqual(
    validatePipelineReport(
      "feature-pipeline",
      "discover-problem",
      "legacy feature report handling remains unchanged",
    ),
    [],
  );
});
