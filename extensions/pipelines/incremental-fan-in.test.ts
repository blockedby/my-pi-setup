import assert from "node:assert/strict";
import test from "node:test";
import { IncrementalFanInReducer } from "./incremental-fan-in.ts";

function reducer(expected = ["one", "two", "three", "four"] as const) {
  return new IncrementalFanInReducer({
    expectedContributors: expected,
    validateReport: (contributor, value) => {
      if (value !== `report:${contributor}`)
        throw new Error("invalid contributor");
      return value;
    },
    validateIntermediate: (value, integrated) => {
      assert.deepEqual(value, { kind: "intermediate", integrated });
      return value;
    },
    validateFinal: (value, integrated) => {
      assert.deepEqual(value, { kind: "final", integrated });
      return value;
    },
  });
}

test("incremental reducer activates on the first report and serializes turns", () => {
  const fanIn = reducer();
  assert.equal(fanIn.accept("one", "report:one"), true);
  const first = fanIn.nextTurn();
  assert.deepEqual(first?.contributors, ["one"]);
  assert.equal(first?.final, false);
  assert.equal(fanIn.snapshot().reducerStatus, "busy");
  assert.equal(fanIn.nextTurn(), undefined);

  assert.equal(fanIn.accept("two", "report:two"), true);
  assert.equal(fanIn.accept("three", "report:three"), true);
  assert.deepEqual(fanIn.snapshot().pendingContributors, ["two", "three"]);
  assert.equal(fanIn.nextTurn(), undefined);

  fanIn.settle({ kind: "intermediate", integrated: ["one"] });
  const second = fanIn.nextTurn();
  assert.deepEqual(second?.contributors, ["two", "three"]);
  assert.equal(second?.final, false);
  fanIn.settle({
    kind: "intermediate",
    integrated: ["one", "two", "three"],
  });

  fanIn.accept("four", "report:four");
  const final = fanIn.nextTurn();
  assert.equal(final?.final, true);
  fanIn.settle({
    kind: "final",
    integrated: ["one", "two", "three", "four"],
  });
  assert.equal(fanIn.snapshot().finalReportValidated, true);
  assert.equal(fanIn.snapshot().revision, 3);
});

test("incremental reducer accepts each contributor exactly once and fails closed", () => {
  const fanIn = reducer();
  assert.throws(() => fanIn.accept("one", "wrong"), /invalid contributor/);
  assert.equal(fanIn.snapshot().acceptedContributors.length, 0);
  assert.equal(fanIn.accept("one", "report:one"), true);
  assert.equal(fanIn.accept("one", "report:one"), false);
  assert.throws(
    () => fanIn.accept("other" as "one", "report:other"),
    /Unexpected incremental fan-in contributor/,
  );
  assert.throws(() => fanIn.settle({}), /no active turn/);
});

test("incremental reducer batches a large bounded contributor set without history growth", () => {
  const expected = Array.from({ length: 512 }, (_, index) => `role-${index}`);
  const fanIn = new IncrementalFanInReducer({
    expectedContributors: expected,
    validateReport: (_contributor, value) => String(value),
    validateIntermediate: (value) => value,
    validateFinal: (value) => value,
  });
  for (const contributor of expected) fanIn.accept(contributor, contributor);
  const turn = fanIn.nextTurn();
  assert.equal(turn?.contributors.length, 512);
  assert.equal(turn?.final, true);
  fanIn.settle({ bounded: true });
  const snapshot = fanIn.snapshot();
  assert.equal(snapshot.integratedContributors.length, 512);
  assert.equal(snapshot.pendingContributors.length, 0);
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.reducerStatus, "finalized");
});
