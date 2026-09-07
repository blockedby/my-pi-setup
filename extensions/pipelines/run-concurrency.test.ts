import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeForkConcurrency,
  type RunConcurrencyInterval,
} from "./run-concurrency.ts";

function interval(
  branchId: string,
  startedAtMs: number,
  finishedAtMs: number | null,
  options: Partial<
    Pick<
      RunConcurrencyInterval,
      "controllerInstanceId" | "forkId" | "attemptId"
    >
  > = {},
): RunConcurrencyInterval {
  return {
    controllerInstanceId: options.controllerInstanceId ?? "controller-1",
    forkId: options.forkId ?? "fork-1",
    branchId,
    attemptId: options.attemptId ?? `${branchId}-attempt-1`,
    startedAtMs,
    finishedAtMs,
  };
}

function summary(
  intervals: ReadonlyArray<RunConcurrencyInterval>,
  eligibleBranches = ["branch-a", "branch-b"],
) {
  const summaries = summarizeForkConcurrency(intervals, {
    "fork-1": eligibleBranches,
  });
  return summaries["fork-1"];
}

test("reports observed overlap for two complete half-open intervals", () => {
  assert.deepEqual(
    summary([interval("branch-a", 100, 300), interval("branch-b", 200, 500)]),
    {
      eligibleBranches: 2,
      startedBranches: 2,
      overlapMs: 100,
      maxConcurrent: 2,
      executionWindowMs: 400,
      status: "observed",
      complete: true,
    },
  );
});

test("reports serial execution of an eligible fork as not observed", () => {
  assert.deepEqual(
    summary([interval("branch-a", 0, 10), interval("branch-b", 10, 20)]),
    {
      eligibleBranches: 2,
      startedBranches: 2,
      overlapMs: 0,
      maxConcurrent: 1,
      executionWindowMs: 20,
      status: "not_observed",
      complete: true,
    },
  );
});

test("counts the union of three-way overlap rather than pairwise overlap", () => {
  assert.deepEqual(
    summary(
      [
        interval("branch-a", 0, 100),
        interval("branch-b", 20, 80),
        interval("branch-c", 40, 60),
      ],
      ["branch-a", "branch-b", "branch-c"],
    ),
    {
      eligibleBranches: 3,
      startedBranches: 3,
      overlapMs: 60,
      maxConcurrent: 3,
      executionWindowMs: 100,
      status: "observed",
      complete: true,
    },
  );
});

test("merges retries for one branch before computing concurrency", () => {
  assert.deepEqual(
    summary([
      interval("branch-a", 0, 10, { attemptId: "branch-a-attempt-1" }),
      interval("branch-a", 2, 8, { attemptId: "branch-a-attempt-2" }),
      interval("branch-b", 5, 15),
    ]),
    {
      eligibleBranches: 2,
      startedBranches: 2,
      overlapMs: 5,
      maxConcurrent: 2,
      executionWindowMs: 15,
      status: "observed",
      complete: true,
    },
  );
});

test("distinguishes absent observations from an incomplete observation", () => {
  assert.equal(summary([])?.status, "not_observed");
  assert.equal(summary([])?.complete, false);
  assert.equal(summary([interval("branch-a", 0, 10)])?.status, "not_observed");
  assert.equal(summary([interval("branch-a", 0, 10)])?.complete, false);
});

test("fails closed for a missing endpoint", () => {
  assert.deepEqual(
    summary([interval("branch-a", 0, null), interval("branch-b", 0, 10)]),
    {
      eligibleBranches: 2,
      startedBranches: 2,
      overlapMs: 0,
      maxConcurrent: 0,
      executionWindowMs: 0,
      status: "unknown",
      complete: false,
    },
  );
});

test("fails closed for NaN and negative-duration telemetry", () => {
  assert.equal(
    summary([interval("branch-a", Number.NaN, 10), interval("branch-b", 0, 10)])
      ?.status,
    "unknown",
  );
  assert.equal(
    summary([interval("branch-a", 10, 5), interval("branch-b", 0, 10)])?.status,
    "unknown",
  );
  assert.equal(
    summary([interval("branch-a", -10, -5), interval("branch-b", 0, 10)])
      ?.status,
    "unknown",
  );
});

test("fails closed when a fork mixes controller clock domains", () => {
  assert.deepEqual(
    summary([
      interval("branch-a", 0, 10, { controllerInstanceId: "controller-1" }),
      interval("branch-b", 5, 15, { controllerInstanceId: "controller-2" }),
    ]),
    {
      eligibleBranches: 2,
      startedBranches: 2,
      overlapMs: 0,
      maxConcurrent: 0,
      executionWindowMs: 0,
      status: "unknown",
      complete: false,
    },
  );
});

test("fails closed when a single eligible branch mixes controller clock domains", () => {
  assert.deepEqual(
    summary(
      [
        interval("branch-a", 0, 10, {
          controllerInstanceId: "controller-1",
          attemptId: "branch-a-attempt-1",
        }),
        interval("branch-a", 10, 20, {
          controllerInstanceId: "controller-2",
          attemptId: "branch-a-attempt-2",
        }),
      ],
      ["branch-a"],
    ),
    {
      eligibleBranches: 1,
      startedBranches: 1,
      overlapMs: 0,
      maxConcurrent: 0,
      executionWindowMs: 0,
      status: "unknown",
      complete: false,
    },
  );
});

test("marks a fork with fewer than two eligible branches not applicable", () => {
  const summaries = summarizeForkConcurrency(
    [interval("branch-a", 0, 10)],
    new Map([["fork-1", new Set(["branch-a"])]]) as ReadonlyMap<
      string,
      ReadonlySet<string>
    >,
  );
  assert.deepEqual(summaries.get("fork-1"), {
    eligibleBranches: 1,
    startedBranches: 1,
    overlapMs: 0,
    maxConcurrent: 1,
    executionWindowMs: 10,
    status: "not_applicable",
    complete: true,
  });
});
