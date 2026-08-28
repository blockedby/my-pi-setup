import assert from "node:assert/strict";
import test from "node:test";
import {
  FEATURE_CANDIDATE_ROLES,
  assertBoundedSynthesisInput,
  buildFeatureCandidatePrompt,
  buildFeatureSelectionPrompt,
  parseFeatureCandidateHandoff,
  parseFeatureDiscoverySynthesisValue,
  parseFeatureSelection,
  parseFeatureSynthesisProvenance,
  preparedDiscoveryPackage,
  type FeatureCandidateHandoff,
  type FeatureDiscoverySynthesis,
} from "./feature-best-of-three.ts";

const sha = (value: string) => value.repeat(40);
const synthesis: FeatureDiscoverySynthesis = {
  reportType: "feature-discovery-synthesis-v1",
  summary: "Complete discovery synthesis",
  featureContract: "Implement the contract",
  acceptanceCriteria: [
    {
      scenario: "Valid run",
      expected: "Promoted result",
      verification: "test",
    },
  ],
  constraints: ["Preserve neighbors"],
  nonGoals: ["No delivery"],
  precedents: [
    { reference: "src/a.ts", discoveryDetail: "existing", finding: "reuse" },
  ],
  relevantPaths: ["src/a.ts"],
  contractsInvariants: ["selection before write"],
  risks: ["drift"],
  unknowns: [],
  assumptions: ["clean caller"],
  verificationExpectations: ["npm test"],
};

function handoff(
  role: (typeof FEATURE_CANDIDATE_ROLES)[number],
): FeatureCandidateHandoff {
  return {
    reportType: "feature-implementation-candidate-v2",
    role,
    approachSummary: `${role} implementation`,
    changedPaths: [`src/${role}.ts`],
    provenBehavior: "Main path and critical integration exercised",
    checks: ["test passed"],
    remainingWork: ["Complete secondary acceptance paths"],
    assumptions: [],
    tradeoffs: ["bounded tradeoff"],
    worktreePath: `/tmp/${role}`,
    branchRef: `pipi/candidate-${role}`,
    baseCommit: sha("a"),
    candidateHeadCommit: sha(
      role === "Minimal" ? "b" : role === "Robust" ? "c" : "d",
    ),
  };
}

test("candidate prompts preserve byte-identical common context while role objectives differ", () => {
  const common = preparedDiscoveryPackage("Original task", [], synthesis);
  const serialized = JSON.stringify(common);
  const prompts = FEATURE_CANDIDATE_ROLES.map((role) =>
    buildFeatureCandidatePrompt(
      role,
      `/tmp/${role}`,
      `branch/${role}`,
      sha("a"),
      serialized,
    ),
  );
  const packages = prompts.map(
    (prompt) =>
      prompt
        .split("COMMON_PREPARED_DISCOVERY_PACKAGE:\n")[1]!
        .split("\nEND_COMMON_PREPARED_DISCOVERY_PACKAGE")[0]!,
  );
  assert.equal(new Set(packages).size, 1);
  assert.deepEqual(JSON.parse(packages[0]!), common);
  assert.equal(new Set(prompts).size, FEATURE_CANDIDATE_ROLES.length);
});

test("strict handoff, selection, and synthesis contracts reject incomplete or unusable reports", () => {
  assert.equal(
    parseFeatureCandidateHandoff(JSON.stringify(handoff("Minimal"))).role,
    "Minimal",
  );
  const selection = {
    reportType: "feature-implementation-selection-v2",
    selectionOnlyAcknowledgement:
      "No code was written before primary selection.",
    comparisons: FEATURE_CANDIDATE_ROLES.map((role) => ({
      role,
      criteria: {
        correctness: "correct",
        acceptanceCoverage: "covered",
        regressionRisk: "bounded",
        repositoryFit: "fits",
        simplicity: "simple",
        maintainability: "maintainable",
        verificationQuality: "verified",
      },
      viableCheckpoint: role !== "Robust",
    })),
    primaryCandidate: "Minimal",
    rationale: "Simplest fully reliable solution",
    augmentationCandidates: [],
  };
  assert.equal(
    parseFeatureSelection(JSON.stringify(selection)).primaryCandidate,
    "Minimal",
  );
  assert.throws(
    () =>
      parseFeatureSelection(
        JSON.stringify({ ...selection, primaryCandidate: "Robust" }),
      ),
    /selected primary candidate must be a viable implementation checkpoint/,
  );
  assert.throws(
    () =>
      parseFeatureSelection(
        JSON.stringify({
          ...selection,
          comparisons: selection.comparisons.slice(0, 2),
        }),
      ),
    /feature-implementation-selection-v2 schema validation failed/,
  );
  assert.throws(
    () =>
      parseFeatureSelection(
        JSON.stringify({
          ...selection,
          augmentationCandidates: [
            {
              sourceRole: "Minimal",
              idea: "rewrite primary",
              objectiveBenefit: "none",
              evidence: "primary evidence",
              sourcePaths: ["src/minimal.ts"],
            },
          ],
        }),
      ),
    /losing candidates/,
  );

  assert.equal(
    parseFeatureSynthesisProvenance(
      JSON.stringify({
        reportType: "feature-implementation-synthesis-v2",
        primaryCandidate: "Minimal",
        primaryCommit: sha("b"),
        acceptedAugmentations: [],
        rejectedAugmentations: [],
        augmentationChangedPaths: [],
        augmentationCommit: sha("d"),
        completionChangedPaths: [],
        checks: ["npm test passed"],
        assumptions: [],
        unresolvedIssues: [],
        finalCommit: sha("e"),
      }),
    ).finalCommit,
    sha("e"),
  );
});

test("discovery synthesis schema failures identify exact invalid fields", () => {
  const { acceptanceCriteria: _acceptanceCriteria, ...withoutAcceptance } =
    synthesis;
  assert.throws(
    () =>
      parseFeatureDiscoverySynthesisValue(
        {
          ...withoutAcceptance,
          featureContract: { scope: "wrong type" },
          observableAcceptanceCriteria: synthesis.acceptanceCriteria,
        },
        [],
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /feature-discovery-synthesis-v1/);
      assert.match(error.message, /\/featureContract must be string/);
      assert.match(
        error.message,
        /additional properties: observableAcceptanceCriteria/,
      );
      assert.match(error.message, /\/acceptanceCriteria/);
      return true;
    },
  );
});

test("discovery synthesis evidence diagnostics identify pointers without echoing values", () => {
  const submittedValue = "SECRET_PATH_SHOULD_NOT_BE_ECHOED";
  assert.throws(
    () =>
      parseFeatureDiscoverySynthesisValue(
        {
          ...synthesis,
          precedents: [
            {
              reference: submittedValue,
              discoveryDetail: submittedValue,
              finding: "Unsupported precedent",
            },
          ],
        },
        [],
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /feature-discovery-synthesis-v1 semantic validation failed/,
      );
      assert.match(error.message, /\/precedents\/0\/reference/);
      assert.match(error.message, /\/precedents\/0\/discoveryDetail/);
      assert.doesNotMatch(error.message, new RegExp(submittedValue));
      return true;
    },
  );
});

test("selection input is bounded and contains candidate handoffs rather than session state", () => {
  const common = preparedDiscoveryPackage("Original task", [], synthesis);
  const candidates = FEATURE_CANDIDATE_ROLES.map((role) => ({
    role,
    handoff: handoff(role),
    changedPaths: handoff(role).changedPaths,
    boundedDiff: { text: "bounded diff", truncated: false, bytes: 12 },
    immutableCommit: handoff(role).candidateHeadCommit,
    worktreeReference: handoff(role).worktreePath,
  }));
  buildFeatureSelectionPrompt(common, candidates, "/tmp/selection");
  assert.ok(assertBoundedSynthesisInput({ common, candidates }) > 0);
  assert.throws(
    () => assertBoundedSynthesisInput({ payload: "x".repeat(600 * 1024) }),
    /synthesis input exceeds/,
  );
});
