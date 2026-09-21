import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
  featurePlannerRecoveryDecisionSchema,
  parseFeaturePlannerRecoveryDecision,
  type FeaturePlannerRecoveryRequest,
} from "./feature-planner-recovery.ts";

function makeRequest() {
  return {
    taskId: "task-2",
    role: "implementer",
    attempt: 2,
    remainingAttempts: 1,
    failure: "Validation failed",
    currentHead: "head-commit",
    commitRange: {
      baseCommit: "base-commit",
      headCommit: "head-commit",
      commits: ["first-commit", "head-commit"],
    },
    completedTaskIds: ["task-1"],
    unstartedTaskIds: ["task-3", "task-4"],
  } satisfies FeaturePlannerRecoveryRequest;
}

function makeDecision() {
  return {
    schemaVersion: 1,
    taskId: "task-2",
    attempt: 2,
    action: "retry",
    message: "Retry with the validation failure addressed.",
  };
}

function assertInvalid(value: unknown) {
  assert.equal(Value.Check(featurePlannerRecoveryDecisionSchema, value), false);
  assert.throws(() =>
    parseFeaturePlannerRecoveryDecision(value, makeRequest()),
  );
}

for (const action of ["retry", "blocked"]) {
  test(`accepts matching ${action} without changing request, arrays, or commit range`, () => {
    const request = makeRequest();
    const before = structuredClone(request);
    const { completedTaskIds, unstartedTaskIds, commitRange } = request;
    const { commits } = commitRange;
    Object.freeze(completedTaskIds);
    Object.freeze(unstartedTaskIds);
    Object.freeze(commits);
    Object.freeze(commitRange);
    Object.freeze(request);
    const decision = Object.freeze({ ...makeDecision(), action });

    assert.equal(
      Value.Check(featurePlannerRecoveryDecisionSchema, decision),
      true,
    );
    assert.deepEqual(
      parseFeaturePlannerRecoveryDecision(decision, request),
      decision,
    );
    assert.deepEqual(request, before);
    assert.equal(request.completedTaskIds, completedTaskIds);
    assert.equal(request.unstartedTaskIds, unstartedTaskIds);
    assert.equal(request.commitRange, commitRange);
    assert.equal(request.commitRange.commits, commits);
  });
}

for (const [index, value] of [
  undefined,
  null,
  false,
  1,
  "retry",
  [],
  [makeDecision()],
  {},
].entries()) {
  test(`rejects non-decision input ${index}`, () => assertInvalid(value));
}

for (const field of [
  "schemaVersion",
  "taskId",
  "attempt",
  "action",
  "message",
]) {
  test(`requires ${field}`, () => {
    const value: Record<string, unknown> = { ...makeDecision() };
    delete value[field];
    assertInvalid(value);
  });
}

for (const [index, [field, value]] of [
  ["schemaVersion", 0],
  ["schemaVersion", 2],
  ["schemaVersion", "1"],
  ["schemaVersion", null],
  ["taskId", ""],
  ["taskId", "x".repeat(257)],
  ["taskId", 2],
  ["attempt", 0],
  ["attempt", 25],
  ["attempt", 1.5],
  ["attempt", "2"],
  ["attempt", NaN],
  ["attempt", Infinity],
  ["action", "continue"],
  ["action", "commit"],
  ["action", "RETRY"],
  ["action", ""],
  ["action", null],
  ["message", ""],
  ["message", "x".repeat(8193)],
  ["message", 123],
  ["message", {}],
].entries()) {
  test(`rejects invalid field case ${index} (${field})`, () => {
    assertInvalid({ ...makeDecision(), [String(field)]: value });
  });
}

for (const [field, value] of [
  ["extra", true],
  ["graph", { tasks: [] }],
  ["tasks", []],
  ["dependencies", []],
  ["commit", "replacement"],
  ["commits", ["replacement"]],
  ["commitRange", makeRequest().commitRange],
  ["currentHead", "replacement"],
  ["checks", []],
  ["requiredChecks", []],
  ["skipChecks", true],
  ["role", "planner"],
  ["owner", "planner"],
  ["completedTaskIds", ["task-2"]],
  ["unstartedTaskIds", []],
  ["remainingAttempts", 99],
]) {
  test(`rejects additional authority field ${field}`, () => {
    assertInvalid({ ...makeDecision(), [String(field)]: value });
  });
}

for (const action of ["retry", "blocked"]) {
  test(`${action} must match the active task and attempt`, () => {
    for (const patch of [{ taskId: "other-task" }, { attempt: 1 }]) {
      const value = { ...makeDecision(), action, ...patch };
      assert.equal(
        Value.Check(featurePlannerRecoveryDecisionSchema, value),
        true,
      );
      assert.throws(() =>
        parseFeaturePlannerRecoveryDecision(value, makeRequest()),
      );
    }
  });
}

for (const [index, message] of [" ", "\t\n\r", "\u00a0\u2003"].entries()) {
  test(`rejects whitespace-only messages ${index}`, () => {
    for (const action of ["retry", "blocked"]) {
      assert.throws(() =>
        parseFeaturePlannerRecoveryDecision(
          { ...makeDecision(), action, message },
          makeRequest(),
        ),
      );
    }
  });
}

for (const remainingAttempts of [0, -1]) {
  test(`remainingAttempts=${remainingAttempts} permits only blocked`, () => {
    const request = { ...makeRequest(), remainingAttempts };
    assert.throws(() =>
      parseFeaturePlannerRecoveryDecision(makeDecision(), request),
    );
    const blocked = { ...makeDecision(), action: "blocked" };
    assert.deepEqual(
      parseFeaturePlannerRecoveryDecision(blocked, request),
      blocked,
    );
  });
}

for (const attempt of [1, 24]) {
  test(`accepts attempt boundary ${attempt}`, () => {
    const value = { ...makeDecision(), attempt };
    assert.deepEqual(
      parseFeaturePlannerRecoveryDecision(value, { ...makeRequest(), attempt }),
      value,
    );
  });
}

for (const length of [1, 256]) {
  test(`accepts task ID length boundary ${length}`, () => {
    const taskId = "t".repeat(length);
    const value = { ...makeDecision(), taskId };
    assert.deepEqual(
      parseFeaturePlannerRecoveryDecision(value, { ...makeRequest(), taskId }),
      value,
    );
  });
}

for (const [index, message] of [
  "x",
  "x".repeat(8192),
  "  Keep this advice unchanged.\n",
].entries()) {
  test(`accepts message boundary/content case ${index} without normalization`, () => {
    const value = { ...makeDecision(), message };
    assert.deepEqual(
      parseFeaturePlannerRecoveryDecision(value, makeRequest()),
      value,
    );
  });
}
