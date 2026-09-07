#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const runtimeRoot = path.join(
  os.homedir(),
  ".pipi",
  "agent",
  "runtime",
  "node_modules",
);
const liveRuntimeVersion = "0.85.1";
const timeoutMsDefault = 10 * 60 * 1000;
const maxDiagnosticBytes = 16 * 1024;
const deterministicAdapterProvider = "pipi-deterministic-adapter";
const deterministicAdapterModelId = "deterministic-session-model";
const fixturePaths = Object.freeze({
  input: "fixture-input.txt",
  test: "test/fixture-feature.test.mjs",
  normalize: "src/fixture/normalize.mjs",
  score: "src/fixture/score.mjs",
  summary: "src/fixture/summary.mjs",
});
const fixtureFeaturePaths = [
  fixturePaths.normalize,
  fixturePaths.score,
  fixturePaths.summary,
];
const fixtureInput = "  Alpha  \nBeta\n";
const fixtureExpectedSummary = Object.freeze({
  items: ["alpha", "beta"],
  itemCount: 2,
  characterCount: 9,
});
const fixtureBaselineCommand = `test -f ${fixturePaths.input} && test -f ${fixturePaths.test}`;
const fixtureTestCommand = `node --test ${fixturePaths.test}`;
const normalizeCheckCommand = `node --input-type=module -e 'import { readFileSync } from "node:fs"; import { normalizeFixtureInput } from "./${fixturePaths.normalize}"; const actual = normalizeFixtureInput(readFileSync("${fixturePaths.input}", "utf8")); if (JSON.stringify(actual) !== "[\\"alpha\\",\\"beta\\"]") process.exit(1);'`;
const scoreCheckCommand = `node --input-type=module -e 'import { scoreFixtureItems } from "./${fixturePaths.score}"; const actual = scoreFixtureItems(["alpha", "beta"]); if (actual.itemCount !== 2 || actual.characterCount !== 9) process.exit(1);'`;
const smokeTask = [
  "In the disposable fixture only, implement and verify the small text-summary feature described below. The starting committed files are fixture-input.txt, containing the exact text `  Alpha  \\nBeta\\n`, and test/fixture-feature.test.mjs, which is the unchanged executable contract.",
  `Independent change A: add ${fixturePaths.normalize} and export normalizeFixtureInput(input). Reject non-string input with TypeError; split LF or CRLF lines, trim each line, lowercase each non-blank line, discard blank lines, and preserve input order. Verify it with: ${normalizeCheckCommand}`,
  `Independent change B: add ${fixturePaths.score} and export scoreFixtureItems(items). Reject non-arrays and arrays containing a non-string item with TypeError; return exactly { itemCount, characterCount }, where characterCount is the sum of item lengths. Verify it with: ${scoreCheckCommand}`,
  `Dependent summary change: only after both independent commits have joined, add ${fixturePaths.summary}. Import both independent functions and export buildFixtureSummary(input), returning exactly { items, itemCount, characterCount } for the normalized input. Verify the integrated feature with: ${fixtureTestCommand}`,
  `The two independent changes must be separate graph tasks with no dependency on each other; the summary task must depend on both. Run the declared checks and keep ${fixturePaths.test} and ${fixturePaths.input} unchanged. Edit no pipeline source, pipeline configuration, dependency, external resource, or delivery state; write only the three declared feature modules and finalize through the controller-owned task host.`,
].join("\n\n");

const fixtureTestSource = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeFixtureInput } from "../${fixturePaths.normalize}";
import { scoreFixtureItems } from "../${fixturePaths.score}";
import { buildFixtureSummary } from "../${fixturePaths.summary}";

const input = readFileSync(
  new URL("../${fixturePaths.input}", import.meta.url),
  "utf8",
);

test("normalizeFixtureInput returns ordered normalized lines", () => {
  assert.deepEqual(normalizeFixtureInput(input), ["alpha", "beta"]);
});

test("normalizeFixtureInput rejects non-string input", () => {
  assert.throws(() => normalizeFixtureInput(42), TypeError);
});

test("scoreFixtureItems returns item and character counts", () => {
  assert.deepEqual(scoreFixtureItems(["alpha", "beta"]), {
    itemCount: 2,
    characterCount: 9,
  });
});

test("scoreFixtureItems rejects invalid item arrays", () => {
  assert.throws(() => scoreFixtureItems("alpha"), TypeError);
  assert.throws(() => scoreFixtureItems(["alpha", 42]), TypeError);
});

test("buildFixtureSummary composes both independent modules", () => {
  assert.deepEqual(buildFixtureSummary(input), ${JSON.stringify(fixtureExpectedSummary)});
});

test("the summary rejects non-string input", () => {
  assert.throws(() => buildFixtureSummary(42), TypeError);
});
`;

function commandResolution() {
  return {
    executable: process.argv0,
    executablePath: process.execPath,
    script: path.resolve(
      process.argv[1] ??
        path.join(import.meta.dir, "smoke-pipeline-evidence.mjs"),
    ),
    args: process.argv.slice(2),
    cwd: process.cwd(),
  };
}

function parseArgs(argv) {
  const args = new Set(argv);
  const timeoutIndex = argv.indexOf("--timeout-ms");
  const timeoutValue =
    timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : timeoutMsDefault;
  if (!Number.isFinite(timeoutValue) || timeoutValue < 10_000) {
    throw new Error("--timeout-ms must be at least 10000 milliseconds.");
  }
  const unknown = argv.filter(
    (value, index) =>
      value !== "--live" &&
      value !== "--timeout-ms" &&
      !(index === timeoutIndex + 1 && timeoutIndex >= 0),
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(", ")}`);
  }
  return { live: args.has("--live"), timeoutMs: timeoutValue };
}

function diagnostic(value) {
  let text;
  try {
    text = value instanceof Error ? value.message : String(value);
  } catch {
    text = "Unserializable error";
  }
  return redact(text).replace(/\s+/g, " ").slice(0, maxDiagnosticBytes);
}

function redact(value) {
  return String(value)
    .replace(/Bearer\s+[^\s,;}]+/gi, "Bearer [redacted]")
    .replace(
      /(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|secret)(\s*[:=]\s*)([\"']?)[^\s,;}\"']+\3/gi,
      "$1$2[redacted]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, "[redacted]");
}

function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined;
  if (depth > 5) return "[depth-limited]";
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string"
      ? redact(value).slice(0, maxDiagnosticBytes)
      : value;
  }
  if (Array.isArray(value))
    return value.slice(0, 128).map((item) => jsonSafe(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (/auth|credential|secret|password|token|api.?key/i.test(key)) {
        result[key] = "[redacted]";
      } else {
        result[key] = jsonSafe(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitStatus(cwd) {
  return git(cwd, ["status", "--porcelain=v1", "--branch"]);
}

const deterministicFeatureOutputs = Object.freeze({
  [fixturePaths.normalize]: `export function normalizeFixtureInput(input) {
  if (typeof input !== "string") {
    throw new TypeError("fixture input must be a string");
  }
  return input
    .split(/\\r?\\n/u)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);
}
`,
  [fixturePaths.score]: `export function scoreFixtureItems(items) {
  if (
    !Array.isArray(items) ||
    items.some((item) => typeof item !== "string")
  ) {
    throw new TypeError("fixture items must be an array of strings");
  }
  return {
    itemCount: items.length,
    characterCount: items.reduce((total, item) => total + item.length, 0),
  };
}
`,
  [fixturePaths.summary]: `import { normalizeFixtureInput } from "./normalize.mjs";
import { scoreFixtureItems } from "./score.mjs";

export function buildFixtureSummary(input) {
  const items = normalizeFixtureInput(input);
  return { items, ...scoreFixtureItems(items) };
}
`,
});

function ensureWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`Refusing fixture path outside owned root: ${candidate}`);
  }
  return resolvedCandidate;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(jsonSafe(value), null, 2)}\n`, {
    mode: 0o600,
  });
}

function makeFixture(tempRoot) {
  const primary = path.join(tempRoot, "primary");
  const caller = path.join(tempRoot, "caller");
  const worktreeRoot = path.join(tempRoot, "task-worktrees");
  const agentDir = path.join(tempRoot, "agent");
  const artifactRoot = path.join(tempRoot, "pipeline-artifacts");
  fs.mkdirSync(primary);
  fs.mkdirSync(worktreeRoot);
  fs.mkdirSync(agentDir);
  fs.mkdirSync(artifactRoot);
  git(primary, ["init", "-q"]);
  git(primary, ["config", "user.email", "smoke@example.invalid"]);
  git(primary, ["config", "user.name", "Pipeline Evidence Smoke"]);
  fs.writeFileSync(path.join(primary, ".gitignore"), ".pipeline-prepared\n");
  fs.writeFileSync(path.join(primary, fixturePaths.input), fixtureInput);
  fs.mkdirSync(path.dirname(path.join(primary, fixturePaths.test)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(primary, fixturePaths.test), fixtureTestSource);
  fs.writeFileSync(
    path.join(primary, "README.md"),
    `# Fixture checks\n\nExisting baseline before implementation:\n\n${fixtureBaselineCommand}\n\nThe feature test runs only after implementation: ${fixtureTestCommand}\n`,
  );
  git(primary, [
    "add",
    "README.md",
    ".gitignore",
    fixturePaths.input,
    fixturePaths.test,
  ]);
  git(primary, ["commit", "-qm", "smoke fixture baseline"]);
  git(primary, ["worktree", "add", "-q", "-b", "smoke/caller", caller]);
  const baseSha = git(caller, ["rev-parse", "HEAD"]);
  return {
    root: tempRoot,
    primary,
    caller,
    worktreeRoot,
    agentDir,
    artifactRoot,
    baseSha,
    initialFiles: [
      "README.md",
      ".gitignore",
      fixturePaths.input,
      fixturePaths.test,
    ],
  };
}

function featureDiscoveryReport(role, coverage) {
  const evidence = [
    {
      kind: "task",
      reference: fixturePaths.input,
      detail: `The disposable fixture contains the committed input ${JSON.stringify(fixtureInput)} used by this smoke run.`,
    },
    {
      kind: "test",
      reference: fixturePaths.test,
      detail:
        "The disposable fixture contains a committed node:test contract for both independent functions and their composed summary.",
    },
  ];
  const candidates = [
    {
      scenario: "The prepared feature graph is executed.",
      expected: `The normalizer at ${fixturePaths.normalize} and scorer at ${fixturePaths.score} export their declared functions and pass their task checks.`,
      verification:
        "The controller-owned task checks provide executable function-level evidence rather than relying on model text.",
      evidence,
    },
    {
      scenario: "The dependent summary runs after both parallel tasks.",
      expected: `The summary at ${fixturePaths.summary} imports both independent modules and ${fixtureTestCommand} passes after their commits join.`,
      verification:
        "The dependent task check and post-run sandbox test provide executable integration evidence.",
      evidence,
    },
  ];
  const unknowns = coverage[role].map((criterion) => ({
    question: `What is the ${criterion} behavior outside this disposable fixture?`,
    whyItMatters:
      "The deterministic smoke input cannot establish the broader product behavior for this discovery criterion.",
    safeAssumption:
      "Use only the bounded fixture behavior when interpreting this smoke result.",
    resolution:
      "Run the corresponding discovery track against the target product workspace.",
  }));
  return {
    reportType: "feature-discovery-v2",
    role,
    applicability: "applicable",
    summary:
      "The deterministic session records the fixture baseline; role-specific product discovery remains unknown.",
    coverage: coverage[role].map((criterion) => ({
      criterion,
      status: "unknown",
      conclusion:
        "This deterministic smoke does not inspect the target product for this discovery criterion.",
      evidence: [],
      implications: [],
    })),
    candidateAcceptanceCriteria:
      role === "discover-outcome" || role === "discover-user-scenarios"
        ? candidates
        : [],
    unknowns,
    constraints: [],
  };
}

function planForRole(role) {
  const common = {
    summary:
      "Implement a small text-summary feature in a disposable fixture with two independent modules and one dependent composition module.",
    decisions: [
      {
        id: "DEC-1",
        title: "Keep the smoke change inside the fixture",
        body: "Only the three declared feature modules may be added to the disposable fixture; the caller repository, pipeline source, configuration, dependencies, and external resources are out of scope.",
        evidence: [
          {
            reference: fixturePaths.input,
            finding: `The disposable fixture starts from the committed input ${JSON.stringify(fixtureInput)} and an executable test contract.`,
          },
        ],
        rejectedAlternatives: [],
      },
    ],
    changes: [
      {
        id: "CHANGE-1",
        path: fixturePaths.normalize,
        symbols: ["normalizeFixtureInput"],
        action: "add",
        body: "Export normalizeFixtureInput(input), rejecting non-strings and returning ordered, trimmed, lowercased non-blank lines.",
        decisionRefs: ["DEC-1"],
        contractRefs: ["INV-1"],
        acceptanceRefs: ["AC-1"],
      },
      {
        id: "CHANGE-2",
        path: fixturePaths.score,
        symbols: ["scoreFixtureItems"],
        action: "add",
        body: "Export scoreFixtureItems(items), rejecting invalid arrays and returning itemCount plus the summed characterCount.",
        decisionRefs: ["DEC-1"],
        contractRefs: ["INV-1"],
        acceptanceRefs: ["AC-1"],
      },
      {
        id: "CHANGE-3",
        path: fixturePaths.summary,
        symbols: ["buildFixtureSummary"],
        action: "add",
        body: "Import both independent modules and export buildFixtureSummary(input) with normalized items and their counts after the join.",
        decisionRefs: ["DEC-1"],
        contractRefs: ["INV-1"],
        acceptanceRefs: ["AC-1"],
      },
    ],
    contracts: [
      {
        id: "INV-1",
        title: "Join precedes summary",
        body: `The ${fixturePaths.summary} task must not start until the ${fixturePaths.normalize} and ${fixturePaths.score} task commits have joined; the composed function must use both exports without changing the committed input or test.`,
        paths: fixtureFeaturePaths,
      },
    ],
    acceptance: [
      {
        id: "AC-1",
        scenario:
          "The feature graph implements and verifies the fixture feature.",
        expected: `The two independent modules export their exact functions, ${fixturePaths.summary} composes them, the graph has two parallel tasks followed by one dependent summary task, and ${fixtureTestCommand} passes.`,
        verification:
          "Controller-owned task/review checks and the post-run sandbox test provide executable feature evidence; model text and deterministic metadata are not feature proof.",
      },
    ],
    verification: [
      {
        id: "CHECK-1",
        command: fixtureTestCommand,
        cwd: ".",
        purpose:
          "Execute the committed fixture test contract against the produced modules.",
        proves: ["AC-1", "INV-1"],
        required: true,
      },
    ],
    risks: [
      {
        id: "RISK-1",
        description:
          "A sequential or stubbed implementation could hide a missing join or incorrect module behavior.",
        mitigation: `Keep ${fixturePaths.normalize} and ${fixturePaths.score} as separate no-dependency tasks, require ${fixturePaths.summary} to depend on both, and execute ${fixtureTestCommand} after integration.`,
      },
    ],
  };
  return role === "Minimal"
    ? {
        reportType: "feature-plan-candidate-v1",
        role,
        ...common,
        blockers: [],
        tradeoffs: ["The fixture keeps the smoke path bounded and disposable."],
      }
    : {
        reportType: "feature-plan-candidate-v1",
        role,
        ...common,
        blockers: [],
        tradeoffs: [
          "The fixture favors direct evidence over production source changes.",
        ],
      };
}

function canonicalPlan() {
  const {
    reportType: _candidateType,
    role: _role,
    blockers: _blockers,
    tradeoffs: _tradeoffs,
    ...common
  } = planForRole("Minimal");
  return {
    reportType: "feature-canonical-plan-v1",
    ...common,
    blockers: [],
    finalRationale:
      "The disposable graph is selected to exercise production orchestration, Git joins, and sandboxed checks.",
  };
}

const fixtureTaskSpecs = Object.freeze({
  "parallel-a": Object.freeze({
    output: fixturePaths.normalize,
    dependsOn: [],
    objective: `Add ${fixturePaths.normalize} with the normalizeFixtureInput(input) contract.`,
    branchGoal: `Leave ${fixturePaths.normalize} committed and its function-level check passing.`,
    readPaths: [fixturePaths.input, fixturePaths.test],
    instructions: [
      `Add only ${fixturePaths.normalize}; export normalizeFixtureInput(input), reject non-strings with TypeError, and normalize ordered non-blank trimmed lines to lowercase.`,
      `Run the declared check ${normalizeCheckCommand} and finalize through the controller task host.`,
    ],
    implementationSketch: `Implement normalizeFixtureInput in ${fixturePaths.normalize} with no dependency on the other parallel task.`,
    doneWhen: [
      `${fixturePaths.normalize} exports normalizeFixtureInput with the exact input and output contract.`,
      `The declared normalizer check passes without changing ${fixturePaths.input} or ${fixturePaths.test}.`,
    ],
    check: {
      id: "parallel-a-normalizer",
      command: normalizeCheckCommand,
      purpose:
        "Execute the normalizer against the committed fixture input and verify its exact ordered result.",
    },
  }),
  "parallel-b": Object.freeze({
    output: fixturePaths.score,
    dependsOn: [],
    objective: `Add ${fixturePaths.score} with the scoreFixtureItems(items) contract.`,
    branchGoal: `Leave ${fixturePaths.score} committed and its function-level check passing.`,
    readPaths: [fixturePaths.input, fixturePaths.test],
    instructions: [
      `Add only ${fixturePaths.score}; export scoreFixtureItems(items), reject invalid arrays with TypeError, and return exactly itemCount plus summed characterCount.`,
      `Run the declared check ${scoreCheckCommand} and finalize through the controller task host.`,
    ],
    implementationSketch: `Implement scoreFixtureItems in ${fixturePaths.score} independently from the normalizer task.`,
    doneWhen: [
      `${fixturePaths.score} exports scoreFixtureItems with the exact validation and count contract.`,
      `The declared scorer check passes without changing ${fixturePaths.input} or ${fixturePaths.test}.`,
    ],
    check: {
      id: "parallel-b-scorer",
      command: scoreCheckCommand,
      purpose:
        "Execute the scorer against known normalized items and verify both returned counts.",
    },
  }),
  summary: Object.freeze({
    output: fixturePaths.summary,
    dependsOn: ["parallel-a", "parallel-b"],
    objective: `After both parallel commits join, add ${fixturePaths.summary} with buildFixtureSummary(input).`,
    branchGoal: `Leave ${fixturePaths.summary} committed, composed from both joined modules, and fully tested.`,
    readPaths: [
      fixturePaths.input,
      fixturePaths.test,
      fixturePaths.normalize,
      fixturePaths.score,
    ],
    instructions: [
      `Wait for both dependency commits, then add only ${fixturePaths.summary}; import normalizeFixtureInput and scoreFixtureItems and export buildFixtureSummary(input).`,
      `The result must be exactly { items, itemCount, characterCount }; run ${fixtureTestCommand} and finalize through the controller task host.`,
    ],
    implementationSketch: `Implement ${fixturePaths.summary} as the dependent composition layer and use both joined module exports.`,
    doneWhen: [
      `${fixturePaths.summary} imports both independent modules and exports buildFixtureSummary with the exact composed result.`,
      `${fixtureTestCommand} passes after the two dependency commits are integrated.`,
    ],
    check: {
      id: "summary-feature-test",
      command: fixtureTestCommand,
      purpose:
        "Execute the integrated fixture contract against all three produced modules.",
    },
  }),
});

function executionTask(id) {
  const spec = fixtureTaskSpecs[id];
  if (!spec)
    throw new Error(`Missing deterministic task specification for ${id}.`);
  const dependencyText =
    spec.dependsOn.length > 0
      ? ` after ${spec.dependsOn.join(" and ")}`
      : " independently";
  return {
    id,
    objective: spec.objective,
    branchGoal: `${spec.branchGoal}${dependencyText}.`,
    dependsOn: [...spec.dependsOn],
    context: {
      problem: smokeTask,
      repositoryConventions: [
        "Use only repository-relative fixture paths and controller-owned task finalization.",
        "Keep the committed input and executable test contract unchanged.",
      ],
      relevantDiscovery: [
        `The disposable fixture contract is defined by ${fixturePaths.input} and ${fixturePaths.test}.`,
      ],
      precedents: [
        {
          path: fixturePaths.input,
          symbol: "fixture input",
          lesson: `Read the committed ${fixturePaths.input} value instead of inventing input data.`,
        },
      ],
      invariants: [
        "Only the declared task output may be written by this task.",
        "Each task is finalized once on its assigned branch.",
      ],
    },
    readPaths: [...spec.readPaths],
    writePaths: [spec.output],
    instructions: [...spec.instructions],
    implementationSketch: spec.implementationSketch,
    acceptanceRefs: ["AC-1"],
    doneWhen: [...spec.doneWhen],
    checks: [
      {
        id: spec.check.id,
        command: spec.check.command,
        cwd: ".",
        purpose: spec.check.purpose,
        required: true,
      },
    ],
  };
}

function executionGraph() {
  const integratedFeatureFiles = fixtureFeaturePaths
    .map((filePath) => `test -f ${filePath}`)
    .join(" && ");
  return {
    reportType: "feature-execution-graph-v1",
    summary: `Two independent module tasks fan out, join, and feed the dependent ${fixturePaths.summary} task.`,
    baselineChecks: [
      {
        id: "fixture-baseline",
        command: fixtureBaselineCommand,
        cwd: ".",
        purpose:
          "Verify the committed fixture input and executable test contract before task launch.",
        required: true,
      },
    ],
    reviewChecks: [
      {
        id: "integrated-feature-files",
        command: integratedFeatureFiles,
        cwd: ".",
        purpose:
          "Verify all three declared feature modules are present in the integrated worktree.",
        required: true,
      },
      {
        id: "fixture-feature-test",
        command: fixtureTestCommand,
        cwd: ".",
        purpose:
          "Run the actual fixture test contract against the produced feature, not model output.",
        required: true,
      },
      {
        id: "whitespace",
        command: "git diff --check",
        cwd: ".",
        purpose:
          "Verify the complete committed fixture delta has no whitespace errors.",
        required: true,
      },
    ],
    tasks: [
      executionTask("parallel-a"),
      executionTask("parallel-b"),
      executionTask("summary"),
    ],
  };
}

function auditTrackReport(role) {
  const unprovenChecks = [
    {
      claim: `${role} audit inspection of the completed fixture`,
      reason:
        "The deterministic session supplies a scripted response and does not perform the provider's read-only audit inspection.",
      requiredCheck: `Run the ${role} audit against the completed fixture workspace.`,
    },
  ];
  if (role === "audit-executor") {
    return {
      track: role,
      executedChecks: [],
      workspaceChangesObserved: [],
      findings: [],
      unprovenChecks,
    };
  }
  return { track: role, findings: [], unprovenChecks };
}

function gitObservation(cwd, args, label) {
  try {
    return {
      state: "available",
      value: git(cwd, args).slice(0, 12 * 1024),
    };
  } catch (error) {
    return {
      state: "unavailable",
      value: `${label} unavailable: ${diagnostic(error)}`.slice(0, 12 * 1024),
    };
  }
}

function captureAuditGitState(cwd, baseSha) {
  return {
    status: gitObservation(
      cwd,
      ["status", "--short", "--branch"],
      "Git status",
    ),
    dirtyDiff: gitObservation(
      cwd,
      ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"],
      "Dirty Git diff",
    ),
    combinedDiff: gitObservation(
      cwd,
      ["diff", "--no-ext-diff", "--no-color", baseSha, "--"],
      "Combined Git diff",
    ),
  };
}

function auditHostObservation(cwd, baseSha, before) {
  const baseline = before ?? captureAuditGitState(cwd, baseSha);
  const after = captureAuditGitState(cwd, baseSha);
  const workspaceChanged = JSON.stringify(baseline) !== JSON.stringify(after);
  return {
    capturedAfterExecutor: true,
    workspaceChanged,
    statusBefore: baseline.status,
    statusAfter: after.status,
    dirtyDiffAfter: after.dirtyDiff,
    combinedDiffAfter: after.combinedDiff,
    summary: workspaceChanged
      ? "Host Git observations changed between audit-segment activation and executor settlement."
      : "Host Git observations were unchanged between audit-segment activation and executor settlement.",
  };
}

function reportsUnprovenChecks(reports) {
  return [...reports.values()].flatMap((report) => report.unprovenChecks ?? []);
}

function executorEvidence(reports) {
  const report = reports.get("audit-executor");
  return {
    executedChecks: report?.executedChecks ?? [],
    workspaceChangesObserved: report?.workspaceChangesObserved ?? [],
  };
}

function auditIntermediateReport(roles, reports, hostWorkspaceObservation) {
  const integratedRoles = [...roles];
  const evidence = executorEvidence(reports);
  return {
    reportType: "audit-synthesis-intermediate",
    integratedRoles,
    rootCauseCandidates: [],
    unresolvedConflicts: [],
    unprovenChecks: reportsUnprovenChecks(reports),
    ...evidence,
    hostWorkspaceObservation,
    summary: `Deterministic synthesis integrated ${integratedRoles.length} audit report(s); provider audit inspection remains unproven.`,
  };
}

function auditFinalReport(
  baseSha,
  headSha,
  roles,
  reports,
  hostWorkspaceObservation,
) {
  const evidence = executorEvidence(reports);
  return {
    reportType: "audit-synthesis-final",
    mode: "initial",
    baseSha,
    headSha,
    integratedRoles: [...roles],
    findings: [],
    closureResults: [],
    unresolvedConflicts: [],
    unprovenChecks: reportsUnprovenChecks(reports),
    ...evidence,
    hostWorkspaceObservation,
    summary: `Deterministic synthesis integrated ${roles.length} audit report(s); final acceptance is not established by this deterministic session.`,
  };
}

function existingFixturePaths(cwd) {
  return fixtureFeaturePaths.filter((relativePath) => {
    try {
      return fs.statSync(path.join(cwd, relativePath)).isFile();
    } catch {
      return false;
    }
  });
}

function fixtureChangedPaths(cwd, baseSha) {
  const committed = git(cwd, ["diff", "--name-only", baseSha, "--"]);
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(
      [committed, untracked].flatMap((value) =>
        value.split("\n").filter(Boolean),
      ),
    ),
  ].sort();
}

function completionGitFacts(cwd, baseSha) {
  try {
    return git(cwd, ["log", "--format=%H %s", `${baseSha}..HEAD`, "--"])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function auditUnresolvedItems(report) {
  if (!report)
    return ["No final audit report was captured by the deterministic session."];
  return [
    ...report.findings.map(
      (finding) => `Audit finding remains unresolved: ${finding.title}.`,
    ),
    ...report.unresolvedConflicts.map(
      (conflict) =>
        `Audit conflict remains unresolved: ${conflict.description}.`,
    ),
    ...report.unprovenChecks.map(
      (check) =>
        `Audit check remains unproven: ${check.claim} (${check.reason}).`,
    ),
  ];
}

function toolByName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool)
    throw new Error(`Deterministic session could not find tool ${name}.`);
  return tool;
}

async function executeTool(tools, name, params, cwd) {
  const tool = toolByName(tools, name);
  return tool.execute(`smoke-${name}`, params, undefined, () => {}, { cwd });
}

class DeterministicSession {
  constructor(options) {
    this.spec = options.spec;
    this.realSession = options.realSession;
    this.rootTools = options.rootTools;
    this.discoverySubmit = options.discoverySubmit;
    this.planningReadinessCheck = options.planningReadinessCheck;
    this.auditSubmit = options.auditSubmit;
    this.discoveryTokens = options.discoveryTokens;
    this.auditTokens = options.auditTokens;
    this.featureTaskHost = options.featureTaskHost;
    this.baseSha = options.baseSha;
    this.coverage = options.coverage;
    this.auditRoles = options.auditRoles;
    this.auditState = options.auditState;
    this.listeners = new Set();
    this.prompts = 0;
    this.synthesisIntegratedRoles = [];
    this.synthesisReports = new Map();
    if (this.spec.role === "audit-synthesis" && !this.auditState.before) {
      this.auditState.before = captureAuditGitState(
        this.spec.cwd,
        this.baseSha,
      );
    }
    this.disposed = false;
    this.sessionFile = undefined;
    this.activeTools = [...(this.realSession.activeTools ?? [])];
    this.executionMetadata = this.realSession.executionMetadata;
    this.isStreaming = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    if (event.type === "run_started") this.isStreaming = true;
    if (event.type === "settled") this.isStreaming = false;
    for (const listener of [...this.listeners]) listener(event);
  }

  async prompt(text) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this.dispatch(text);
  }

  async send(text) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await this.dispatch(text);
  }

  enableMutation() {
    this.realSession.enableMutation();
    this.activeTools = [...this.realSession.activeTools];
  }

  async interrupt() {
    if (this.isStreaming) {
      this.emit({ type: "settled", outcome: { type: "cancelled" } });
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.realSession.dispose();
  }

  async dispatch(text) {
    if (this.disposed) throw new Error("Deterministic session is disposed.");
    this.prompts++;
    this.emit({ type: "run_started" });
    try {
      const finalText = await this.dispatchRole(text);
      this.emit({
        type: "settled",
        outcome: {
          type: "completed",
          finalText: finalText ?? "smoke session settled",
        },
      });
    } catch (error) {
      this.emit({
        type: "settled",
        outcome: { type: "failed", error: diagnostic(error) },
      });
      throw error;
    }
  }

  async dispatchRole(text) {
    const role = this.spec.role;
    if (this.coverage[role]) {
      const report = featureDiscoveryReport(role, this.coverage);
      const token = this.discoveryTokens.get(`${this.spec.scopeId}:${role}`);
      if (!token) throw new Error(`Missing discovery token for ${role}.`);
      if (role === "discover-context") {
        const readiness = await this.planningReadinessCheck(
          this.spec.scopeId,
          role,
          token,
          {
            command: fixtureBaselineCommand,
            cwd: ".",
            purpose: "Verify existing fixture inputs before implementation.",
            source: { path: "README.md", excerpt: fixtureBaselineCommand },
          },
        );
        if (readiness.status !== "passed")
          throw new Error(readiness.error ?? "Fixture readiness failed.");
      }
      await executeTool(
        this.rootTools,
        "pipeline_discovery_submit",
        report,
        this.spec.cwd,
      ).catch(async () => {
        this.discoverySubmit(this.spec.scopeId, role, token, report);
      });
      return JSON.stringify(report);
    }
    if (role === "feature-plan-minimal" || role === "feature-plan-robust") {
      const report = planForRole(
        role === "feature-plan-minimal" ? "Minimal" : "Robust",
      );
      const token = this.discoveryTokens.get(`${this.spec.scopeId}:${role}`);
      if (!token) throw new Error(`Missing planning token for ${role}.`);
      this.discoverySubmit(this.spec.scopeId, role, token, report);
      return JSON.stringify(report);
    }
    if (role === "feature-plan-finalizer") {
      const token = this.discoveryTokens.get(`${this.spec.scopeId}:${role}`);
      if (!token) throw new Error("Missing finalizer planning token.");
      if (this.prompts === 1) {
        const plan = canonicalPlan();
        this.discoverySubmit(this.spec.scopeId, role, token, plan);
        return JSON.stringify(plan);
      }
      if (this.prompts === 2) {
        const graph = executionGraph();
        this.discoverySubmit(this.spec.scopeId, role, token, graph);
        return JSON.stringify(graph);
      }
      const host = this.featureTaskHost(this.spec.scopeId, role);
      if (!host) throw new Error("Missing final review host.");
      const result = await host.finalize({
        commitPaths: [],
        summary:
          "The deterministic session submitted an empty final-review change set; controller-owned review checks determine validation.",
      });
      if (!result.validated)
        throw new Error(result.error ?? "Final review did not validate.");
      return JSON.stringify(result);
    }
    if (role.startsWith("feature-task-")) {
      const host = this.featureTaskHost(this.spec.scopeId, role);
      if (!host) throw new Error(`Missing feature task host for ${role}.`);
      const capsule = JSON.parse(text);
      const taskSpec = fixtureTaskSpecs[capsule.taskId];
      const output = capsule.writePaths?.[0];
      if (
        !taskSpec ||
        !Array.isArray(capsule.writePaths) ||
        capsule.writePaths.length !== 1 ||
        output !== taskSpec.output ||
        typeof output !== "string" ||
        output.length === 0 ||
        path.posix.isAbsolute(output) ||
        output.includes("..")
      ) {
        throw new Error(`Unexpected deterministic task output for ${role}.`);
      }
      for (const dependencyId of taskSpec.dependsOn) {
        const dependency = fixtureTaskSpecs[dependencyId];
        if (
          !dependency ||
          !fs.existsSync(path.join(this.spec.cwd, dependency.output))
        ) {
          throw new Error(
            `Task ${capsule.taskId} started before dependency ${dependencyId} was integrated.`,
          );
        }
      }
      const target = ensureWithin(
        this.spec.cwd,
        path.join(this.spec.cwd, output),
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, deterministicFeatureOutputs[output]);
      const result = await host.finalize({
        commitPaths: [output],
        summary: `Deterministic adapter implementation for ${capsule.taskId}; provider behavior remains unproven.`,
      });
      if (!result.validated)
        throw new Error(
          result.error ?? `Task ${capsule.taskId} did not validate.`,
        );
      return JSON.stringify(result);
    }
    if (role.startsWith("audit-") && role !== "audit-synthesis") {
      const token = this.auditTokens.get(`${this.spec.scopeId}:${role}`);
      if (token) {
        const report = auditTrackReport(role);
        this.auditSubmit(this.spec.scopeId, role, token, report);
        return JSON.stringify(report);
      }
      // The pre-final tracks do not have typed submission tools. Keep their
      // bounded report explicit about the audit work the deterministic session
      // did not perform until the controller-owned final-audit segment starts.
      const report = auditTrackReport(role);
      return JSON.stringify(report);
    }
    if (role === "audit-synthesis") {
      const token = this.auditTokens.get(`${this.spec.scopeId}:${role}`);
      if (!token) throw new Error("Missing audit synthesis token.");
      const batchMarker = "Validated report batch:\n";
      const batchStart = text.indexOf(batchMarker);
      if (batchStart >= 0) {
        try {
          const batch = JSON.parse(text.slice(batchStart + batchMarker.length));
          for (const report of batch) {
            if (
              typeof report?.contributorRole === "string" &&
              !this.synthesisIntegratedRoles.includes(report.contributorRole)
            ) {
              this.synthesisIntegratedRoles.push(report.contributorRole);
            }
            if (
              typeof report?.contributorRole === "string" &&
              report.validatedReport &&
              typeof report.validatedReport === "object" &&
              !Array.isArray(report.validatedReport)
            ) {
              this.synthesisReports.set(
                report.contributorRole,
                report.validatedReport,
              );
            }
          }
        } catch {
          throw new Error(
            "Deterministic synthesis prompt omitted its report batch.",
          );
        }
      }
      const final = text.includes('reportType="audit-synthesis-final"');
      const hostWorkspaceObservation = this.synthesisIntegratedRoles.includes(
        "audit-executor",
      )
        ? auditHostObservation(
            this.spec.cwd,
            this.baseSha,
            this.auditState.before,
          )
        : null;
      const report = final
        ? auditFinalReport(
            this.baseSha,
            git(this.spec.cwd, ["rev-parse", "HEAD"]),
            this.synthesisIntegratedRoles,
            this.synthesisReports,
            hostWorkspaceObservation,
          )
        : auditIntermediateReport(
            this.synthesisIntegratedRoles,
            this.synthesisReports,
            hostWorkspaceObservation,
          );
      if (final) this.auditState.finalReport = report;
      this.auditSubmit(this.spec.scopeId, role, token, report);
      return JSON.stringify(report);
    }
    if (role === "pipeline-root") {
      const tools = this.rootTools(this.spec.scopeId);
      const staticRoles = this.auditRoles.filter(
        (candidate) => candidate !== "audit-executor",
      );
      const staticChildren = [];
      for (const staticRole of staticRoles) {
        const started = await executeTool(
          tools,
          "pipeline_child_spawn",
          {
            role: staticRole,
            context: "Deterministic disposable-fixture audit.",
          },
          this.spec.cwd,
        );
        const id = started?.details?.id;
        if (!id)
          throw new Error(
            `The controller did not return a child ID for ${staticRole}.`,
          );
        staticChildren.push(id);
      }
      await executeTool(
        tools,
        "pipeline_child_wait",
        { ids: staticChildren },
        this.spec.cwd,
      );
      await executeTool(
        tools,
        "pipeline_stage",
        { stage: "final-audit" },
        this.spec.cwd,
      );
      const observedOutputPaths = existingFixturePaths(this.spec.cwd);
      const observedStatus = gitStatus(this.spec.cwd);
      const started = await executeTool(
        tools,
        "pipeline_audit_start",
        {
          acceptance_contract:
            "Controller-owned checks evaluate the declared disposable fixture outputs and integrated Git state.",
          assumptions: ["The harness owns the temporary Git fixture."],
          checks_evidence: [
            `Fixture output paths currently present: ${observedOutputPaths.join(", ") || "none"}`,
            `Git status currently observed: ${observedStatus}`,
          ],
        },
        this.spec.cwd,
      );
      const finalAuditChildren =
        started?.details?.agents?.map((agent) => agent.id) ?? [];
      if (finalAuditChildren.length === 0)
        throw new Error("The controller did not return final-audit child IDs.");
      let waited;
      for (let attempt = 0; attempt < 3; attempt++) {
        waited = await executeTool(
          tools,
          "pipeline_child_wait",
          { ids: finalAuditChildren },
          this.spec.cwd,
        );
        if (waited?.details?.finalAuditReportDelivered === true) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const delivered = waited?.details?.finalAuditReportDelivered === true;
      if (!delivered)
        throw new Error(
          "The controller did not deliver the validated final audit report.",
        );
      const changedPaths = fixtureChangedPaths(this.spec.cwd, this.baseSha);
      const observedGitStatus = gitStatus(this.spec.cwd);
      const gitCommits = completionGitFacts(this.spec.cwd, this.baseSha);
      const unresolvedItems = auditUnresolvedItems(this.auditState.finalReport);
      await executeTool(
        tools,
        "pipeline_complete",
        {
          outcome:
            "The deterministic session submitted factual completion data; acceptance is reported separately.",
          changed_paths: changedPaths,
          checks_evidence: [
            `Observed Git status: ${observedGitStatus}`,
            `Observed changed fixture paths: ${changedPaths.join(", ") || "none"}`,
          ],
          assumptions: [
            "The deterministic session supplies model decisions without substituting for provider audit inspection.",
          ],
          git_commits: gitCommits,
          report_summaries_references: [
            this.auditState.finalReport
              ? `Deterministic audit synthesis emitted ${this.auditState.finalReport.unprovenChecks.length} unproven check record(s).`
              : "No final audit report was captured by the deterministic session.",
          ],
          unresolved_items: unresolvedItems,
          working_dir: this.spec.cwd,
        },
        this.spec.cwd,
      );
      return "pipeline completed";
    }
    throw new Error(
      `No deterministic behavior is defined for pipeline role ${role}.`,
    );
  }
}

const controllerCallbackNames = [
  "rootTools",
  "definitionForRun",
  "auditSubmit",
  "auditSessionCreated",
  "auditToolAllowed",
  "discoverySubmit",
  "discoverySessionCreated",
  "discoveryToolAllowed",
  "executionFinish",
  "executionFinishSessionCreated",
  "featureTaskHost",
  "artifactTools",
  "planningReadinessCheck",
];

function controllerCallbackOptions(callbacks) {
  if (callbacks.length !== controllerCallbackNames.length) {
    throw new Error(
      `Controller callback contract changed: expected ${controllerCallbackNames.length}, received ${callbacks.length}.`,
    );
  }
  return Object.fromEntries(
    controllerCallbackNames.map((name, index) => [name, callbacks[index]]),
  );
}

function createDeterministicAdapter() {
  const model = {
    id: deterministicAdapterModelId,
    name: "Pipi deterministic session adapter",
    api: deterministicAdapterProvider,
    provider: deterministicAdapterProvider,
    baseUrl: "offline://pipi-deterministic-adapter",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_000,
  };
  return {
    kind: "deterministic-adapter",
    model,
    lookups: [],
  };
}

function makeDeterministicFactory({
  pipeline,
  fixture,
  deterministicAdapter,
  root,
}) {
  const discoveryTokens = new Map();
  const auditTokens = new Map();
  const auditState = {};

  return (...callbacks) => {
    const callbackOptions = controllerCallbackOptions(callbacks);
    const {
      auditSessionCreated,
      discoverySessionCreated,
      rootTools,
      discoverySubmit,
      auditSubmit,
    } = callbackOptions;
    const captureAuditToken = (runId, role, token) => {
      auditTokens.set(`${runId}:${role}`, token);
      auditSessionCreated?.(runId, role, token);
    };
    const captureDiscoveryToken = (runId, role, token) => {
      discoveryTokens.set(`${runId}:${role}`, token);
      discoverySessionCreated?.(runId, role, token);
    };
    return {
      async create(spec) {
        // Retain the SDK-backed session for resources, tools, and lifecycle
        // coverage. The deterministic adapter below supplies no provider call.
        const realSession = await pipeline
          .createPipelineSessionFactory({
            ...callbackOptions,
            modelRegistry: {
              find(provider, id) {
                deterministicAdapter.lookups.push(`${provider}/${id}`);
                return deterministicAdapter.model;
              },
            },
            parentCwd: fixture.caller,
            parentTrusted: false,
            agentDir: fixture.agentDir,
            sessionManager: (cwd) => root.piAgent.SessionManager.inMemory(cwd),
            auditSessionCreated: captureAuditToken,
            discoverySessionCreated: captureDiscoveryToken,
          })
          .create(spec);
        return new DeterministicSession({
          spec,
          realSession,
          rootTools,
          discoverySubmit,
          auditSubmit,
          discoveryTokens,
          auditTokens,
          featureTaskHost: callbackOptions.featureTaskHost,
          planningReadinessCheck: callbackOptions.planningReadinessCheck,
          baseSha: fixture.baseSha,
          auditState,
          coverage: root.coverage,
          auditRoles: root.auditRoles,
        });
      },
    };
  };
}

function makeLiveFactory({ pipeline, fixture, root, runtime }) {
  return (...callbacks) => {
    const {
      rootTools,
      definitionForRun,
      auditSubmit,
      auditSessionCreated,
      auditToolAllowed,
      discoverySubmit,
      discoverySessionCreated,
      discoveryToolAllowed,
      executionFinish,
      executionFinishSessionCreated,
      featureTaskHost,
      artifactTools,
      planningReadinessCheck,
    } = controllerCallbackOptions(callbacks);
    return pipeline.createPipelineSessionFactory({
      modelRegistry: {
        find(provider, id) {
          return runtime.getModel(provider, id);
        },
      },
      parentCwd: fixture.caller,
      parentTrusted: false,
      agentDir: fixture.agentDir,
      sessionManager: (cwd) => root.piAgent.SessionManager.inMemory(cwd),
      rootTools,
      definitionForRun,
      auditSubmit,
      auditSessionCreated,
      auditToolAllowed,
      discoverySubmit,
      discoverySessionCreated,
      discoveryToolAllowed,
      executionFinish,
      executionFinishSessionCreated,
      featureTaskHost,
      artifactTools,
      planningReadinessCheck,
    });
  };
}

function summarizeAgents(controller, runId) {
  return controller.agentView
    .list()
    .filter((agent) => agent.scopeId === runId)
    .map((agent) => ({
      id: agent.id,
      role: agent.role,
      attempt: agent.attempt,
      requestedModel: agent.model,
      status: agent.status,
      error: agent.error ? diagnostic(agent.error) : undefined,
      finalTextBytes: Buffer.byteLength(agent.finalText ?? "", "utf8"),
      activeTools: agent.activeTools,
    }));
}

function readFeatureArtifacts(artifactRoot, runId) {
  const directory = path.join(artifactRoot, runId);
  const result = {};
  for (const name of [
    "execution-graph.json",
    "task-results.json",
    "run-summary.json",
    "sol-review.json",
  ]) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    try {
      result[name] = jsonSafe(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      result[name] = { readError: diagnostic(error) };
    }
  }
  return result;
}

function hostSnapshot(directory) {
  try {
    return {
      head: git(directory, ["rev-parse", "HEAD"]),
      status: gitStatus(directory),
      commitsFromBase: git(directory, [
        "rev-list",
        "--count",
        `${git(directory, ["rev-list", "--max-parents=0", "HEAD"]).split("\n")[0]}..HEAD`,
      ]),
    };
  } catch (error) {
    return { error: diagnostic(error) };
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Smoke run timed out after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const liveSdkPackages = [
  { name: "pi-coding-agent", relative: "@earendil-works/pi-coding-agent" },
  { name: "pi-ai", relative: "@earendil-works/pi-ai" },
  { name: "pi-tui", relative: "@earendil-works/pi-tui" },
];

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function installedRuntimePackage(relative, label) {
  const runtimeDirectory = fs.realpathSync.native(runtimeRoot);
  const packagePath = path.join(runtimeRoot, relative);
  const realPath = fs.realpathSync.native(packagePath);
  ensureWithin(runtimeDirectory, realPath);
  if (!fs.statSync(realPath).isDirectory()) {
    throw new Error(`Installed runtime ${label} is not a directory.`);
  }
  const packageJsonPath = path.join(realPath, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error(`Installed runtime ${label} has no package version.`);
  }
  return {
    path: packagePath,
    realPath,
    version: packageJson.version,
    packageJsonSha256: sha256File(packageJsonPath),
  };
}

function readInstalledRuntimeResolution() {
  const runtimeDirectory = fs.realpathSync.native(runtimeRoot);
  const packages = liveSdkPackages.map(({ name, relative }) => ({
    name,
    relative,
    ...installedRuntimePackage(relative, name),
  }));
  const typebox = installedRuntimePackage("typebox", "typebox");
  return {
    kind: "installed-sdk",
    root: runtimeDirectory,
    requestedVersion: liveRuntimeVersion,
    packages,
    dependencies: [{ name: "typebox", ...typebox }],
    installedRuntimeWrites: false,
  };
}

function createSafeSdkOverlay(tempRoot, installedRuntime) {
  const sourceRoot = path.join(tempRoot, "live-source");
  const nodeModules = path.join(sourceRoot, "node_modules");
  fs.mkdirSync(path.join(sourceRoot, "extensions"), { recursive: true });
  fs.cpSync(
    path.join(repositoryRoot, "extensions", "pipelines"),
    path.join(sourceRoot, "extensions", "pipelines"),
    { recursive: true },
  );
  fs.cpSync(
    path.join(repositoryRoot, "extensions", "shared"),
    path.join(sourceRoot, "extensions", "shared"),
    { recursive: true },
  );
  const scoped = path.join(nodeModules, "@earendil-works");
  fs.mkdirSync(scoped, { recursive: true });
  const packageLinks = installedRuntime.packages.map((entry) => {
    const destination = path.join(scoped, entry.name);
    fs.symlinkSync(entry.realPath, destination, "dir");
    return {
      name: entry.name,
      source: entry.realPath,
      destination,
    };
  });
  const typeboxSource = installedRuntime.dependencies[0];
  const typeboxDestination = path.join(nodeModules, "typebox");
  fs.symlinkSync(typeboxSource.realPath, typeboxDestination, "dir");
  return {
    sourceRoot,
    sdkNodeModules: nodeModules,
    runtimeResolution: {
      ...installedRuntime,
      overlay: {
        root: sourceRoot,
        packageLinks,
        dependencies: [
          {
            name: "typebox",
            source: typeboxSource.realPath,
            destination: typeboxDestination,
          },
        ],
        writesInstalledRuntime: false,
      },
    },
  };
}

async function loadPipelineModules(live, tempRoot, installedRuntime) {
  const overlay = live
    ? createSafeSdkOverlay(tempRoot, installedRuntime)
    : undefined;
  const sourceRoot = overlay?.sourceRoot ?? repositoryRoot;
  const sdkNodeModules =
    overlay?.sdkNodeModules ?? path.join(repositoryRoot, "node_modules");
  const importModule = (relative) =>
    import(
      pathToFileURL(path.join(sourceRoot, "extensions", "pipelines", relative))
        .href
    );
  const [controller, session, domain, discovery, featureSandbox] =
    await Promise.all([
      importModule("controller.ts"),
      importModule("session.ts"),
      importModule("domain.ts"),
      importModule("discovery-report.ts"),
      importModule("feature-sandbox.ts"),
    ]);
  return {
    controller,
    session,
    domain,
    discovery,
    featureSandbox,
    sourceRoot,
    sdkNodeModules,
    runtimeResolution: overlay?.runtimeResolution ?? {
      kind: "repository-sdk",
      root: sdkNodeModules,
      requestedVersion: undefined,
      installedRuntimeWrites: false,
    },
  };
}

function runtimeFingerprint(resolution) {
  return [
    ...resolution.packages.map(({ name, version, packageJsonSha256 }) => ({
      name,
      version,
      packageJsonSha256,
    })),
    ...resolution.dependencies.map(({ name, version, packageJsonSha256 }) => ({
      name,
      version,
      packageJsonSha256,
    })),
  ];
}

function verifyInstalledRuntimeUnchanged(before) {
  if (!before) {
    return {
      state: "not_applicable",
      detail: "The deterministic adapter does not use the installed live SDK.",
    };
  }
  try {
    const after = readInstalledRuntimeResolution();
    const unchanged =
      JSON.stringify(runtimeFingerprint(before)) ===
      JSON.stringify(runtimeFingerprint(after));
    return {
      state: unchanged ? "unchanged" : "changed",
      before: runtimeFingerprint(before),
      after: runtimeFingerprint(after),
      detail: unchanged
        ? "The temporary SDK overlay left every installed SDK package manifest unchanged."
        : "An installed SDK package manifest changed while the smoke run was active.",
    };
  } catch (error) {
    return {
      state: "unavailable",
      detail: `Unable to verify installed SDK immutability: ${diagnostic(error)}`,
    };
  }
}

async function verifyFixtureFeature(featureSandbox, fixture) {
  const observedPaths = existingFixturePaths(fixture.caller);
  const changedPaths = fixtureChangedPaths(fixture.caller, fixture.baseSha);
  const unexpectedChangedPaths = changedPaths.filter(
    (relativePath) => !fixtureFeaturePaths.includes(relativePath),
  );
  const missingPaths = fixtureFeaturePaths.filter(
    (relativePath) => !observedPaths.includes(relativePath),
  );
  const alteredInitialFiles = [
    [fixturePaths.input, fixtureInput],
    [fixturePaths.test, fixtureTestSource],
  ]
    .filter(([relativePath, expected]) => {
      try {
        return (
          fs.readFileSync(path.join(fixture.caller, relativePath), "utf8") !==
          expected
        );
      } catch {
        return true;
      }
    })
    .map(([relativePath]) => relativePath);
  if (!featureSandbox) {
    return {
      status: "not_run",
      passed: false,
      command: fixtureTestCommand,
      cwd: ".",
      expectedPaths: fixtureFeaturePaths,
      observedPaths,
      changedPaths,
      unexpectedChangedPaths,
      missingPaths,
      alteredInitialFiles,
      detail: "The feature sandbox module was not loaded.",
    };
  }
  try {
    const result = await featureSandbox.runFeatureSandboxCommand({
      workspaceRoot: fixture.caller,
      cwd: ".",
      command: fixtureTestCommand,
    });
    const passed =
      result.exitCode === 0 &&
      missingPaths.length === 0 &&
      alteredInitialFiles.length === 0 &&
      unexpectedChangedPaths.length === 0;
    return {
      status: passed ? "passed" : "failed",
      passed,
      command: fixtureTestCommand,
      cwd: ".",
      expectedPaths: fixtureFeaturePaths,
      observedPaths,
      changedPaths,
      unexpectedChangedPaths,
      missingPaths,
      alteredInitialFiles,
      exitCode: result.exitCode,
      stdout: redact(result.stdout).slice(0, maxDiagnosticBytes),
      stderr: redact(result.stderr).slice(0, maxDiagnosticBytes),
      detail: passed
        ? "The post-run sandbox command executed the committed fixture test contract successfully."
        : "The post-run sandbox command, required feature paths, or immutable fixture inputs did not verify the produced fixture.",
    };
  } catch (error) {
    return {
      status: "failed",
      passed: false,
      command: fixtureTestCommand,
      cwd: ".",
      expectedPaths: fixtureFeaturePaths,
      observedPaths,
      changedPaths,
      unexpectedChangedPaths,
      missingPaths,
      alteredInitialFiles,
      detail: `The post-run sandbox command could not execute: ${diagnostic(error)}`,
    };
  }
}

function acceptanceStatuses(handoff) {
  return {
    implementation:
      handoff?.acceptance?.implementationAcceptance?.status ?? "unavailable",
    execution:
      handoff?.acceptance?.pipelineExecutionAcceptance?.status ?? "unavailable",
  };
}

function acceptancePassed(handoff) {
  const statuses = acceptanceStatuses(handoff);
  return (
    statuses.implementation === "passed" && statuses.execution === "passed"
  );
}

function acceptanceBlockers(handoff) {
  const acceptance = handoff?.acceptance;
  if (!acceptance)
    return ["The controller did not provide a V2 acceptance envelope."];
  const blockers = [];
  for (const [name, section] of [
    ["implementation", acceptance.implementationAcceptance],
    ["execution", acceptance.pipelineExecutionAcceptance],
  ]) {
    if (!section || !Array.isArray(section.criteria)) {
      blockers.push(`${name} acceptance section is unavailable.`);
      continue;
    }
    if (section.status !== "passed") {
      blockers.push(`${name} acceptance is ${section.status}.`);
    }
    for (const criterion of section.criteria) {
      if (criterion.status === "failed" || criterion.status === "unproven") {
        blockers.push(
          `${name}.${criterion.id} is ${criterion.status}: ${diagnostic(criterion.detail)}`,
        );
      }
    }
  }
  return blockers;
}

function modelProvenance({
  live,
  runtimeResolution,
  deterministicAdapter,
  domain,
}) {
  const requestedModels = domain
    ? [domain.ASTRA_MODEL, domain.LUNA_MODEL]
    : ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-luna"];
  if (!live) {
    return {
      mode: "deterministic-adapter",
      requestedRoutingModels: requestedModels,
      selectedRuntimeModel: `${deterministicAdapterProvider}/${deterministicAdapterModelId}`,
      lookupOverride: true,
      lookupCount: deterministicAdapter?.lookups.length ?? 0,
      lookupRequests: deterministicAdapter?.lookups ?? [],
      servesRequestedModels: false,
      providerServing: "not_claimed",
      conclusion: "unproven",
      limitation:
        "The wrapper supplies scripted behavior and the SDK session is retained only for lifecycle/tool coverage; it never serves Astra or Luna and cannot prove provider execution.",
    };
  }
  return {
    mode: "installed-sdk-live",
    requestedRoutingModels: requestedModels,
    installedSdkVersion: runtimeResolution?.requestedVersion,
    selectedRuntimeModel: "recorded in controller session_created evidence",
    lookupOverride: false,
    providerServing:
      "live provider path attempted; provider computation is not inferred from metadata alone",
    conclusion:
      "eligible only when controller acceptance and the post-run fixture test both pass",
  };
}

function readinessBlockers({
  live,
  handoff,
  featureVerification,
  runtimeResolution,
  error,
}) {
  const blockers = [];
  if (error) blockers.push(`Smoke execution error: ${diagnostic(error)}`);
  if (!live) {
    blockers.push(
      "Deterministic adapter mode is unproven for live provider serving and audit inspection; run --live before claiming readiness.",
    );
  }
  blockers.push(...acceptanceBlockers(handoff));
  if (!featureVerification?.passed) {
    blockers.push(
      featureVerification?.detail ??
        "The post-run fixture verification was not completed.",
    );
  }
  const runtimeCheck = runtimeResolution?.installedRuntimeMutationCheck;
  if (live && runtimeCheck?.state !== "unchanged") {
    blockers.push(
      runtimeCheck?.detail ??
        "Installed SDK immutability was not verified for the live overlay.",
    );
  }
  return [...new Set(blockers)];
}

async function runSmoke({ live, timeoutMs }) {
  const tempRoot = await fsp.mkdtemp(
    path.join(os.tmpdir(), "pipi-pipeline-evidence-"),
  );
  const fixture = makeFixture(tempRoot);
  const hostBefore = {
    head: git(repositoryRoot, ["rev-parse", "HEAD"]),
    status: gitStatus(repositoryRoot),
  };
  let controller;
  let runId;
  let handoff;
  let runtime;
  let deterministicAdapter;
  let liveVersion;
  let modules;
  let bubblewrapProbe;
  let featureVerification;
  let runtimeResolution;
  let installedRuntimeBefore;
  const startedAt = new Date().toISOString();
  const reportPath = path.join(tempRoot, "smoke-report.json");
  try {
    if (live) {
      runtimeResolution = {
        kind: "installed-sdk",
        root: path.resolve(runtimeRoot),
        requestedVersion: liveRuntimeVersion,
        installedRuntimeWrites: false,
        resolutionState: "pending",
      };
      installedRuntimeBefore = readInstalledRuntimeResolution();
      runtimeResolution = installedRuntimeBefore;
      const mismatched = installedRuntimeBefore.packages.filter(
        ({ version }) => version !== liveRuntimeVersion,
      );
      if (mismatched.length > 0) {
        throw new Error(
          `--live requires installed Pi SDK ${liveRuntimeVersion}; found ${mismatched
            .map(({ name, version }) => `${name}@${version}`)
            .join(", ")}.`,
        );
      }
      liveVersion = liveRuntimeVersion;
    }
    modules = await loadPipelineModules(live, tempRoot, installedRuntimeBefore);
    runtimeResolution = {
      ...modules.runtimeResolution,
      runtimeWritePolicy: live
        ? "installed auth.json is read through ReadOnlyAuthStorage; refresh writes are rejected"
        : "not used by the deterministic adapter",
    };
    bubblewrapProbe = await modules.featureSandbox.runFeatureSandboxCommand({
      workspaceRoot: fixture.caller,
      cwd: ".",
      command: `test -f ${fixturePaths.input}`,
    });
    if (bubblewrapProbe.exitCode !== 0) {
      throw new Error(
        `The disposable bubblewrap probe failed with exit ${bubblewrapProbe.exitCode}.`,
      );
    }
    const piAgent = await import(
      pathToFileURL(
        path.join(
          modules.sdkNodeModules,
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "index.js",
        ),
      ).href
    );
    const coverage = modules.discovery.FEATURE_DISCOVERY_COVERAGE;
    const auditRoles = modules.domain.AUDIT_SEGMENT_LUNA_ROLES;
    if (live) {
      const authStorage = await import(
        pathToFileURL(
          path.join(
            modules.sdkNodeModules,
            "@earendil-works",
            "pi-coding-agent",
            "dist",
            "core",
            "auth-storage.js",
          ),
        ).href
      );
      runtime = await piAgent.ModelRuntime.create({
        credentials: new authStorage.ReadOnlyAuthStorage(),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      for (const model of [
        modules.domain.ASTRA_MODEL,
        modules.domain.LUNA_MODEL,
      ]) {
        const [provider, ...idParts] = model.split("/");
        if (!runtime.getModel(provider, idParts.join("/"))) {
          throw new Error(
            `--live installed SDK does not expose required model ${model}.`,
          );
        }
      }
    } else {
      deterministicAdapter = createDeterministicAdapter();
    }

    let resolveHandoff;
    const handoffPromise = new Promise((resolve) => {
      resolveHandoff = resolve;
    });
    const makeFactory = live
      ? makeLiveFactory({
          pipeline: modules.session,
          fixture,
          root: { piAgent },
          runtime,
        })
      : makeDeterministicFactory({
          pipeline: modules.session,
          fixture,
          deterministicAdapter,
          root: { piAgent, coverage, auditRoles },
        });
    controller = new modules.controller.PipelineController({
      createSessionFactory: makeFactory,
      onHandoff(value) {
        handoff = value;
        resolveHandoff(value);
      },
      makeRunId: () => "smoke-pipeline-evidence-a1b2c3d4",
      makeAgentId: (() => {
        let sequence = 0;
        return () => `smoke-agent-${++sequence}`;
      })(),
      artifactRoot: fixture.artifactRoot,
    });
    const request = {
      pipelineName: "smoke-pipeline-evidence",
      pipeline: modules.domain.FEATURE_PIPELINE_ID,
      workingDir: fixture.caller,
      task: smokeTask,
      worktreeRoot: fixture.worktreeRoot,
      worktreePrepare: ["printf 'prepared\\n' > .pipeline-prepared"],
      gitCommit: true,
    };
    runId = controller.start(request);
    handoff = await withTimeout(handoffPromise, timeoutMs);
    const terminalAgents = summarizeAgents(controller, runId);
    await controller.dispose();
    controller = undefined;
    const artifacts = readFeatureArtifacts(fixture.artifactRoot, runId);
    featureVerification = await verifyFixtureFeature(
      modules?.featureSandbox,
      fixture,
    );
    if (live && installedRuntimeBefore) {
      runtimeResolution = {
        ...runtimeResolution,
        installedRuntimeMutationCheck: verifyInstalledRuntimeUnchanged(
          installedRuntimeBefore,
        ),
      };
    }
    const acceptance = acceptanceStatuses(handoff);
    const liveAcceptancePassed = acceptancePassed(handoff);
    const fixtureVerified = featureVerification.passed === true;
    const runtimeSafe =
      !live ||
      runtimeResolution?.installedRuntimeMutationCheck?.state === "unchanged";
    const succeeded =
      live &&
      handoff?.status === "completed" &&
      liveAcceptancePassed &&
      fixtureVerified &&
      runtimeSafe;
    const deterministicFixtureComplete =
      !live && handoff?.status === "completed" && fixtureVerified;
    const hostAfter = {
      head: git(repositoryRoot, ["rev-parse", "HEAD"]),
      status: gitStatus(repositoryRoot),
    };
    const report = {
      schemaVersion: 1,
      mode: live ? "live" : "deterministic-session",
      command: [process.argv0, ...process.argv.slice(1)],
      livePiSdkVersion: live ? liveVersion : undefined,
      runtimeResolution: jsonSafe(runtimeResolution),
      modelProvenance: jsonSafe(
        modelProvenance({
          live,
          runtimeResolution,
          deterministicAdapter,
          domain: modules.domain,
        }),
      ),
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      reportPath,
      commandResolution: commandResolution(),
      task: smokeTask,
      status: handoff?.status,
      terminalStatus: handoff?.status ?? "missing",
      scriptStatus: succeeded
        ? "passed"
        : deterministicFixtureComplete
          ? "unproven"
          : "failed",
      acceptanceStatus: acceptance,
      acceptancePassed: liveAcceptancePassed,
      definition: handoff?.definition,
      error: handoff?.error ? diagnostic(handoff.error) : undefined,
      acceptance: jsonSafe(handoff?.acceptance),
      evidence: jsonSafe(handoff?.evidence),
      limitation: jsonSafe(handoff?.limitation),
      verification: {
        acceptanceRequiredForLive: true,
        acceptancePassed: liveAcceptancePassed,
        realFixture: jsonSafe(featureVerification),
        runtimeSafe,
      },
      readinessBlockers: readinessBlockers({
        live,
        handoff,
        featureVerification,
        runtimeResolution,
        error: handoff?.error,
      }),
      agents: terminalAgents,
      artifacts,
      fixture: {
        root: tempRoot,
        caller: fixture.caller,
        worktreeRoot: fixture.worktreeRoot,
        baseSha: fixture.baseSha,
        initialFiles: fixture.initialFiles,
        expectedFeaturePaths: fixtureFeaturePaths,
        final: hostSnapshot(fixture.caller),
      },
      hostRepository: {
        before: hostBefore,
        after: hostAfter,
        unchanged:
          hostBefore.head === hostAfter.head &&
          hostBefore.status === hostAfter.status,
      },
      safety: {
        usedPipelineRunTool: false,
        installedDependencies: false,
        hostCommitsOrDelivery: false,
        externalMutations: false,
        globalRuntimeWrites: false,
        liveRuntimeWritePolicy:
          "ReadOnlyAuthStorage prevents provider credential refreshes from writing installed auth.json",
        liveAcceptance:
          "live requires completed handoff, both acceptance sections passed, unchanged installed SDK, and real fixture verification",
        bubblewrapProbe: jsonSafe(bubblewrapProbe),
      },
      retainedForDiagnostics: !succeeded,
    };
    writeJson(reportPath, report);
    console.log(
      JSON.stringify(
        {
          ...report,
          fixture: {
            ...report.fixture,
            root: succeeded ? "[cleaned on success]" : report.fixture.root,
          },
        },
        null,
        2,
      ),
    );
    if (succeeded) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.error(
        report.scriptStatus === "unproven"
          ? "Deterministic smoke completed the fixture test, but live readiness remains unproven."
          : `Smoke readiness failed: terminal=${report.terminalStatus}, implementation=${report.acceptanceStatus.implementation}, execution=${report.acceptanceStatus.execution}.`,
      );
      for (const blocker of report.readinessBlockers) {
        console.error(`Readiness blocker: ${blocker}`);
      }
      console.error(`Failure diagnostics retained at ${tempRoot}`);
      console.error(`Smoke report retained at ${reportPath}`);
    }
    return succeeded ? 0 : 1;
  } catch (error) {
    const snapshots =
      controller && runId ? summarizeAgents(controller, runId) : [];
    if (controller) await controller.dispose().catch(() => {});
    if (modules?.featureSandbox) {
      featureVerification = await verifyFixtureFeature(
        modules.featureSandbox,
        fixture,
      ).catch((verificationError) => ({
        status: "failed",
        passed: false,
        command: fixtureTestCommand,
        cwd: ".",
        expectedPaths: fixtureFeaturePaths,
        observedPaths: existingFixturePaths(fixture.caller),
        missingPaths: fixtureFeaturePaths.filter(
          (relativePath) =>
            !fs.existsSync(path.join(fixture.caller, relativePath)),
        ),
        detail: `The post-run fixture verification failed while handling the smoke error: ${diagnostic(verificationError)}`,
      }));
    }
    if (live && installedRuntimeBefore) {
      runtimeResolution = {
        ...runtimeResolution,
        installedRuntimeMutationCheck: verifyInstalledRuntimeUnchanged(
          installedRuntimeBefore,
        ),
      };
    }
    const acceptance = acceptanceStatuses(handoff);
    const report = {
      schemaVersion: 1,
      mode: live ? "live" : "deterministic-session",
      command: [process.argv0, ...process.argv.slice(1)],
      livePiSdkVersion: live ? liveVersion : undefined,
      runtimeResolution: jsonSafe(runtimeResolution),
      modelProvenance: jsonSafe(
        modelProvenance({
          live,
          runtimeResolution,
          deterministicAdapter,
          domain: modules?.domain,
        }),
      ),
      startedAt,
      finishedAt: new Date().toISOString(),
      runId,
      reportPath,
      commandResolution: commandResolution(),
      task: smokeTask,
      status: handoff?.status ?? "failed-before-handoff",
      terminalStatus: handoff?.status ?? "failed-before-handoff",
      scriptStatus: "failed",
      acceptanceStatus: acceptance,
      acceptancePassed: acceptancePassed(handoff),
      error: diagnostic(error),
      handoff: jsonSafe(handoff),
      verification: {
        acceptanceRequiredForLive: true,
        acceptancePassed: acceptancePassed(handoff),
        realFixture: jsonSafe(featureVerification),
        runtimeSafe:
          !live ||
          runtimeResolution?.installedRuntimeMutationCheck?.state ===
            "unchanged",
      },
      readinessBlockers: readinessBlockers({
        live,
        handoff,
        featureVerification,
        runtimeResolution,
        error,
      }),
      agents: snapshots,
      artifacts: runId ? readFeatureArtifacts(fixture.artifactRoot, runId) : {},
      fixture: {
        root: tempRoot,
        caller: fixture.caller,
        worktreeRoot: fixture.worktreeRoot,
        baseSha: fixture.baseSha,
        initialFiles: fixture.initialFiles,
        expectedFeaturePaths: fixtureFeaturePaths,
        final: hostSnapshot(fixture.caller),
      },
      safety: {
        usedPipelineRunTool: false,
        installedDependencies: false,
        hostCommitsOrDelivery: false,
        externalMutations: false,
        globalRuntimeWrites: false,
        liveRuntimeWritePolicy:
          "ReadOnlyAuthStorage prevents provider credential refreshes from writing installed auth.json",
        liveAcceptance:
          "live requires completed handoff, both acceptance sections passed, unchanged installed SDK, and real fixture verification",
        bubblewrapProbe: jsonSafe(bubblewrapProbe),
      },
      hostRepository: {
        before: hostBefore,
        after: hostSnapshot(repositoryRoot),
      },
      retainedForDiagnostics: true,
    };
    writeJson(reportPath, report);
    console.error(JSON.stringify(report, null, 2));
    console.error(`Smoke run failed: ${report.error}`);
    for (const blocker of report.readinessBlockers) {
      console.error(`Readiness blocker: ${blocker}`);
    }
    console.error(`Failure diagnostics retained at ${tempRoot}`);
    console.error(`Smoke report retained at ${reportPath}`);
    return 1;
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Invocation rejected: ${diagnostic(error)}`);
    process.exitCode = 2;
    return;
  }
  console.log(
    JSON.stringify(
      {
        invocation: "scripts/smoke-pipeline-evidence.mjs",
        command: [process.argv0, ...process.argv.slice(1)],
        commandResolution: commandResolution(),
        mode: options.live ? "live" : "deterministic-session",
        runtimeResolution: {
          installedSdkRoot: runtimeRoot,
          requiredLiveVersion: liveRuntimeVersion,
          resolution: options.live
            ? "installed SDK is resolved and overlaid into a disposable temp source root before the run"
            : "repository SDK is used only to host the deterministic adapter session",
          installedRuntimeWrites: false,
        },
        readiness: {
          liveSuccessRequires: [
            "completed controller handoff",
            "implementation acceptance passed",
            "pipeline execution acceptance passed",
            "post-run node:test fixture verification passed",
          ],
          deterministicConclusion:
            "unproven: the deterministic adapter never serves the requested provider models or performs provider audit inspection",
        },
        safetyBoundary: [
          "Disposable temporary Git linked-worktree and Linux bubblewrap fixture only.",
          "No pipeline_run tool, production edits, pushes, PRs, or external delivery mutations.",
          "No dependency installation or authentication contents are printed; --live reads installed Pi SDK 0.85.1 through a disposable overlay and uses read-only credential storage.",
          "Temporary paths are removed only after live acceptance and real fixture verification pass; failures retain diagnostics.",
        ],
      },
      null,
      2,
    ),
  );
  process.exitCode = await runSmoke(options);
}

await main();
