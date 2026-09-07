import assert from "node:assert/strict";
import test from "node:test";
import type { PlanningReadinessResult } from "./domain.ts";
import {
  buildPlanningReadinessHandoff,
  PLANNING_READINESS_HANDOFF_MAX_BYTES,
} from "./planning-readiness-handoff.ts";

function readinessResult(overrides: Partial<PlanningReadinessResult> = {}) {
  return {
    workspaceRoot: "/repo/worktree",
    command: "bun run check",
    cwd: ".",
    purpose: "Verify the repository before planning.",
    source: {
      path: "package.json",
      excerpt: '"check": "bun run check"',
    },
    sourceHash: "a".repeat(64),
    status: "passed",
    exitCode: 0,
    error: undefined,
    stdout: "check passed",
    stderr: "warning: cache metadata was ignored",
    startedAt: 100,
    finishedAt: 200,
    ...overrides,
  } satisfies PlanningReadinessResult;
}

test("preserves factual check evidence and the immutable artifact reference", () => {
  const input = readinessResult({
    stdout:
      "A complete actionable check result that fits comfortably within the handoff budget.",
  });
  const handoff = buildPlanningReadinessHandoff("run-123", [input], 7);

  assert.deepEqual(handoff.artifactRef, {
    runId: "run-123",
    artifactId: "planning-readiness",
    revision: 7,
  });
  assert.equal(handoff.totalCount, 1);
  assert.equal(handoff.includedCount, 1);
  assert.equal(handoff.omittedCount, 0);
  assert.equal(handoff.truncated, false);
  assert.deepEqual(handoff.checks[0], {
    index: 0,
    workspaceRoot: input.workspaceRoot,
    command: input.command,
    cwd: input.cwd,
    purpose: input.purpose,
    source: input.source,
    sourceHash: input.sourceHash,
    status: input.status,
    exitCode: input.exitCode,
    stdout: input.stdout,
    stderr: input.stderr,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    truncated: false,
    truncatedFields: [],
  });
  assert.match(
    handoff.checks[0]?.stderr ?? "",
    /warning: cache metadata was ignored/,
  );

  const serialized = JSON.stringify(handoff);
  assert.deepEqual(JSON.parse(serialized), handoff);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <=
      PLANNING_READINESS_HANDOFF_MAX_BYTES,
  );
});

test("keeps the result independent from mutable input objects", () => {
  const source = {
    path: "package.json",
    excerpt: '"check": "bun run check"',
  };
  const input = { ...readinessResult({ source }) };
  const handoff = buildPlanningReadinessHandoff("run-123", [input], 1);

  source.excerpt = "changed after construction";
  input.stdout = "changed after construction";

  assert.equal(handoff.checks[0]?.source.excerpt, '"check": "bun run check"');
  assert.equal(handoff.checks[0]?.stdout, "check passed");
  assert.notEqual(handoff.checks[0]?.source, source);
});

test("adapts long unicode evidence while preserving every check identity", () => {
  const longUnicode = "測試🙂 warning ".repeat(2_000);
  const checks = Array.from({ length: 12 }, (_value, index) =>
    readinessResult({
      sourceHash: `${index}`.padStart(64, "0"),
      purpose: `${index} ${longUnicode}`,
      source: { path: `config/${index}.json`, excerpt: longUnicode },
      workspaceRoot: `/repo/${longUnicode}`,
      command: `bun run check-${longUnicode}`,
      stdout: longUnicode,
      stderr: `warning-${index}: ${longUnicode}`,
    }),
  );

  const handoff = buildPlanningReadinessHandoff("run-unicode", checks, 3);
  const serialized = JSON.stringify(handoff);

  assert.equal(handoff.includedCount, 12);
  assert.equal(handoff.omittedCount, 0);
  assert.equal(handoff.checks.length, 12);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <=
      PLANNING_READINESS_HANDOFF_MAX_BYTES,
  );
  assert.ok(handoff.checks.every((check, index) => check.index === index));
  assert.ok(
    handoff.checks.every(
      (check, index) =>
        check.status === "passed" &&
        check.sourceHash === `${index}`.padStart(64, "0"),
    ),
  );
  assert.ok(handoff.checks.some((check) => check.truncated));
  assert.ok(
    handoff.checks.some((check) => check.truncatedFields.includes("stderr")),
  );
  assert.match(
    handoff.checks.find((check) => check.truncated)?.stdout ?? "",
    /\[truncated\]$/u,
  );
  assert.deepEqual(JSON.parse(serialized), handoff);
});

test("retains a failed check when an exceptional input list is bounded", () => {
  const checks = Array.from({ length: 13 }, (_value, index) =>
    readinessResult({
      sourceHash: `${index}`.padStart(64, "0"),
      stderr: `warning-${index}`,
      status: index === 12 ? "failed" : "passed",
      exitCode: index === 12 ? 1 : 0,
      ...(index === 12 ? { error: "check failed" } : {}),
    }),
  );

  const handoff = buildPlanningReadinessHandoff("run-failed", checks, 4);

  assert.equal(handoff.totalCount, 13);
  assert.equal(handoff.includedCount, 12);
  assert.equal(handoff.omittedCount, 1);
  assert.equal(handoff.truncated, true);
  assert.equal(handoff.checks[0]?.index, 12);
  assert.equal(handoff.checks[0]?.status, "failed");
  assert.equal(handoff.checks[0]?.exitCode, 1);
  assert.equal(handoff.checks[0]?.stderr, "warning-12");
  assert.equal(handoff.checks[0]?.sourceHash, "12".padStart(64, "0"));
  assert.deepEqual(JSON.parse(JSON.stringify(handoff)), handoff);
});

test("rejects revisions that cannot identify an immutable stored result", () => {
  const check = [readinessResult()];

  assert.throws(() => buildPlanningReadinessHandoff("run-123", check, 0));
  assert.throws(() => buildPlanningReadinessHandoff("run-123", check, -1));
  assert.throws(() => buildPlanningReadinessHandoff("run-123", check, 1.5));
  assert.throws(() => buildPlanningReadinessHandoff("run-123", check, NaN));
  assert.throws(() =>
    buildPlanningReadinessHandoff("run-123", check, Number.POSITIVE_INFINITY),
  );
});
