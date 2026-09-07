import assert from "node:assert/strict";
import test from "node:test";
import {
  createCleanupRecorder,
  type CleanupEvidence,
} from "./cleanup-evidence.ts";
import type { FeatureGraphEvidenceEvent } from "./feature-graph-executor.ts";
import {
  assessExecutionEvidence,
  type ExecutionEvidenceAssessmentInput,
} from "./execution-evidence-assessment.ts";
import type { RunEvent } from "./run-evidence.ts";

let eventNumber = 0;

function runEvent(
  kind: string,
  offsetMs: number,
  options: Partial<
    Pick<
      RunEvent,
      | "taskId"
      | "sessionId"
      | "turnId"
      | "attemptId"
      | "operationId"
      | "detail"
      | "facts"
    >
  > = {},
): RunEvent {
  eventNumber++;
  return {
    schemaVersion: 2,
    runId: "run-assessment",
    controllerInstanceId: "controller-assessment",
    eventId: `event-${eventNumber}`,
    sequence: eventNumber,
    at: 1_000 + offsetMs,
    offsetMs,
    kind,
    ...options,
  };
}

function cleanupRunEvents(
  records: ReadonlyArray<CleanupEvidence>,
  sequences?: ReadonlyArray<number>,
) {
  return records.map((record, index) => {
    const event = runEvent(
      record.event === "intent" ? "cleanup_intent" : "cleanup_outcome",
      index + 1,
      {
        operationId: record.operationId,
        facts: {
          resourceId: record.resourceId,
          resourceType: record.resourceType,
          resource: record.resource,
          ownership: record.ownership,
          phase: record.phase,
          expectedIdentity: record.expectedIdentity ?? null,
          ...(record.disposition === undefined
            ? {}
            : { disposition: record.disposition }),
          ...(record.operationStatus === undefined
            ? {}
            : { operationStatus: record.operationStatus }),
          ...(record.reasonCode === undefined
            ? {}
            : { reasonCode: record.reasonCode }),
        },
      },
    );
    const sequence = sequences?.[index];
    return sequence === undefined ? event : { ...event, sequence };
  });
}

function cleanupRecords(
  resource: string,
  action: (recorder: ReturnType<typeof createCleanupRecorder>) => void,
  ownership: CleanupEvidence["ownership"] = "unknown",
) {
  const records: CleanupEvidence[] = [];
  const recorder = createCleanupRecorder((record) => records.push(record), {
    resourceId: resource,
    resourceType: "sandbox",
    resource,
    ownership,
    phase: "execution-evidence-assessment-test",
  });
  action(recorder);
  return records;
}

type CleanupTarget = Pick<
  CleanupEvidence,
  "resourceId" | "resourceType" | "resource" | "ownership" | "expectedIdentity"
>;
type CleanupOutcome = Required<
  Pick<CleanupEvidence, "disposition" | "operationStatus" | "reasonCode">
>;

function addCleanupOperation(
  records: CleanupEvidence[],
  target: CleanupTarget,
  action: (recorder: ReturnType<typeof createCleanupRecorder>) => void,
) {
  const recorder = createCleanupRecorder((record) => records.push(record), {
    ...target,
    phase: "execution-evidence-assessment-test",
  });
  action(recorder);
}

function addCleanupAttempt(
  records: CleanupEvidence[],
  target: CleanupTarget,
  outcome: CleanupOutcome,
) {
  addCleanupOperation(records, target, (recorder) => {
    recorder.intent();
    recorder.outcome(outcome);
  });
}

const runtimeParentTarget = {
  resourceId:
    "/tmp/pipi-pipeline-evidence-QA8WJr/task-worktrees/smoke-pipeline-evidence-a1b2c3d4/.pipi-runtime",
  resourceType: "directory",
  resource:
    "/tmp/pipi-pipeline-evidence-QA8WJr/task-worktrees/smoke-pipeline-evidence-a1b2c3d4/.pipi-runtime",
  ownership: "controller",
  expectedIdentity: "55:1861887",
} satisfies Pick<
  CleanupEvidence,
  "resourceId" | "resourceType" | "resource" | "ownership" | "expectedIdentity"
>;

const deferredSandboxCleanupFacts = {
  resourceId: "/tmp/pipi-pipeline-evidence-9FMFZ1/.pipi-runtime/caller",
  resourceType: "sandbox",
  resource: "/tmp/pipi-pipeline-evidence-9FMFZ1/.pipi-runtime/caller",
  ownership: "controller",
  phase: "feature-sandbox-runtime-cleanup",
  expectedIdentity: "55:2167624",
  disposition: "retained",
  operationStatus: "not_attempted",
  reasonCode: "workspace_still_present",
} satisfies NonNullable<RunEvent["facts"]>;

function dependency(
  branchId: string,
  taskId: string,
  status:
    | "waiting"
    | "validated"
    | "satisfied_without_changes"
    | "failed" = "waiting",
) {
  return { branchId, taskId, status };
}

function graphEvent(
  kind: FeatureGraphEvidenceEvent["kind"],
  forkId: string,
  branchId: string,
  atMs: number,
  options: Partial<
    Pick<
      FeatureGraphEvidenceEvent,
      "taskId" | "joinId" | "status" | "dependencies"
    >
  > = {},
): FeatureGraphEvidenceEvent {
  return {
    runId: "run-assessment",
    controllerInstanceId: "controller-assessment",
    kind,
    forkId,
    branchId,
    joinId: options.joinId ?? "join-1",
    atMs,
    status:
      options.status ??
      (kind === "fork_eligible"
        ? "eligible"
        : kind === "branch_task_membership"
          ? "member"
          : kind === "join_started"
            ? "joining"
            : "completed"),
    dependencies: options.dependencies ?? [],
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
}

function taskTurn(
  taskId: string,
  sessionId: string,
  startedAtMs: number,
  finishedAtMs: number | null,
  options: { readonly attemptId?: string } = {},
) {
  const turnId = `${sessionId}-turn-1`;
  const attemptId = options.attemptId ?? `${sessionId}-attempt-1`;
  return [
    runEvent("run_started", startedAtMs, {
      taskId,
      sessionId,
      turnId,
      attemptId,
    }),
    ...(finishedAtMs === null
      ? []
      : [
          runEvent("settled", finishedAtMs, {
            taskId,
            sessionId,
            turnId,
            attemptId,
            facts: { outcome: "completed" },
          }),
        ]),
  ];
}

function forkEvidence(options: {
  readonly joinStartMs?: number;
  readonly joinFinishMs?: number;
  readonly joinStatus?: "completed" | "failed" | "cancelled";
}) {
  const joinStartMs = options.joinStartMs ?? 600;
  const joinFinishMs = options.joinFinishMs ?? 700;
  const joinStatus = options.joinStatus ?? "completed";
  return [
    graphEvent("fork_eligible", "fork-1", "branch-a", 10, {
      dependencies: [dependency("branch-a", "task-a")],
    }),
    graphEvent("branch_task_membership", "fork-1", "branch-a", 11, {
      taskId: "task-a",
    }),
    graphEvent("fork_eligible", "fork-1", "branch-b", 12, {
      dependencies: [dependency("branch-b", "task-b")],
    }),
    graphEvent("branch_task_membership", "fork-1", "branch-b", 13, {
      taskId: "task-b",
    }),
    graphEvent("join_started", "fork-1", "root", joinStartMs, {
      joinId: "join-1",
      dependencies: [
        dependency("branch-a", "task-a", "validated"),
        dependency("branch-b", "task-b", "validated"),
      ],
    }),
    graphEvent("join_finished", "fork-1", "root", joinFinishMs, {
      joinId: "join-1",
      status: joinStatus,
      dependencies: [
        dependency("branch-a", "task-a", "validated"),
        dependency("branch-b", "task-b", "validated"),
      ],
    }),
  ];
}

function assessment(
  events: ReadonlyArray<RunEvent>,
  graphEvents: ReadonlyArray<FeatureGraphEvidenceEvent>,
  overrides: Partial<ExecutionEvidenceAssessmentInput> = {},
) {
  return assessExecutionEvidence({
    events,
    graphEvents,
    completeness: "complete",
    state: "final",
    featureGraphRequired: true,
    runStartMs: 0,
    ...overrides,
  });
}

function status(
  result: ReturnType<typeof assessExecutionEvidence>,
  id: string,
) {
  return result.criteria.find((criterion) => criterion.id === id)?.status;
}

test("reduces overlapping and serial task turns into per-fork actual intervals", () => {
  eventNumber = 0;
  const overlapping = assessment(
    [
      ...taskTurn("task-a", "session-a", 100, 300),
      ...taskTurn("task-b", "session-b", 200, 500),
    ],
    forkEvidence({}),
  );
  assert.deepEqual(overlapping.concurrency["fork-1"], {
    eligibleBranches: 2,
    startedBranches: 2,
    overlapMs: 100,
    maxConcurrent: 2,
    executionWindowMs: 400,
    status: "observed",
    complete: true,
  });
  assert.equal(status(overlapping, "concurrency"), "passed");

  eventNumber = 0;
  const serial = assessment(
    [
      ...taskTurn("task-a", "session-a", 100, 200),
      ...taskTurn("task-b", "session-b", 200, 300),
    ],
    forkEvidence({}),
  );
  assert.equal(serial.concurrency["fork-1"]?.overlapMs, 0);
  assert.equal(serial.concurrency["fork-1"]?.status, "not_observed");
  assert.equal(serial.concurrency["fork-1"]?.complete, true);
  assert.equal(status(serial, "concurrency"), "unproven");
});

test("converts run offsets through the supplied monotonic origin before reducing", () => {
  eventNumber = 0;
  const result = assessment(
    [
      ...taskTurn("task-a", "session-a", 0, 100),
      ...taskTurn("task-b", "session-b", 50, 150),
    ],
    forkEvidence({ joinStartMs: 1_300, joinFinishMs: 1_400 }),
    { runStartMs: 1_000 },
  );
  assert.equal(result.concurrency["fork-1"]?.overlapMs, 50);
  assert.equal(status(result, "join-ordering"), "passed");
});

test("keeps concurrency unproven when no monotonic origin is supplied", () => {
  eventNumber = 0;
  const result = assessment(
    [
      ...taskTurn("task-a", "session-a", 0, 100),
      ...taskTurn("task-b", "session-b", 50, 150),
    ],
    forkEvidence({}),
    { runStartMs: undefined },
  );
  assert.equal(result.concurrency["fork-1"]?.status, "unknown");
  assert.equal(status(result, "concurrency"), "unproven");
});

test("groups nested branch memberships independently for outer and inner forks", () => {
  eventNumber = 0;
  const graphEvents = [
    graphEvent("fork_eligible", "outer", "outer-a", 1, {
      dependencies: [
        dependency("outer-a", "task-a"),
        dependency("outer-a", "task-b"),
        dependency("outer-a", "task-c"),
      ],
    }),
    ...(["task-a", "task-b", "task-c"] as const).map((taskId, index) =>
      graphEvent("branch_task_membership", "outer", "outer-a", 2 + index, {
        taskId,
      }),
    ),
    graphEvent("fork_eligible", "outer", "outer-b", 5, {
      dependencies: [dependency("outer-b", "task-d")],
    }),
    graphEvent("branch_task_membership", "outer", "outer-b", 6, {
      taskId: "task-d",
    }),
    graphEvent("fork_eligible", "inner", "inner-a", 7, {
      dependencies: [dependency("inner-a", "task-b")],
    }),
    graphEvent("branch_task_membership", "inner", "inner-a", 8, {
      taskId: "task-b",
    }),
    graphEvent("fork_eligible", "inner", "inner-b", 9, {
      dependencies: [dependency("inner-b", "task-c")],
    }),
    graphEvent("branch_task_membership", "inner", "inner-b", 10, {
      taskId: "task-c",
    }),
    graphEvent("join_started", "inner", "root", 500, {
      joinId: "inner-join",
      dependencies: [
        dependency("inner-a", "task-b", "validated"),
        dependency("inner-b", "task-c", "validated"),
      ],
    }),
    graphEvent("join_finished", "inner", "root", 600, {
      joinId: "inner-join",
      dependencies: [
        dependency("inner-a", "task-b", "validated"),
        dependency("inner-b", "task-c", "validated"),
      ],
    }),
    graphEvent("join_started", "outer", "root", 700, {
      joinId: "outer-join",
      dependencies: [
        dependency("outer-a", "task-a", "validated"),
        dependency("outer-a", "task-b", "validated"),
        dependency("outer-a", "task-c", "validated"),
        dependency("outer-b", "task-d", "validated"),
      ],
    }),
    graphEvent("join_finished", "outer", "root", 800, {
      joinId: "outer-join",
      dependencies: [
        dependency("outer-a", "task-a", "validated"),
        dependency("outer-a", "task-b", "validated"),
        dependency("outer-a", "task-c", "validated"),
        dependency("outer-b", "task-d", "validated"),
      ],
    }),
  ];
  const result = assessment(
    [
      ...taskTurn("task-a", "session-a", 100, 150),
      ...taskTurn("task-b", "session-b", 200, 400),
      ...taskTurn("task-c", "session-c", 250, 450),
      ...taskTurn("task-d", "session-d", 300, 450),
    ],
    graphEvents,
  );
  assert.equal(result.concurrency.outer?.status, "observed");
  assert.equal(result.concurrency.inner?.status, "observed");
  assert.equal(status(result, "join-ordering"), "passed");
});

test("marks open turns and incomplete evidence unproven rather than successful", () => {
  eventNumber = 0;
  const result = assessment(
    [
      ...taskTurn("task-a", "session-a", 100, 200),
      ...taskTurn("task-b", "session-b", 200, null),
    ],
    forkEvidence({}),
    { completeness: "incomplete" },
  );
  assert.equal(result.concurrency["fork-1"]?.status, "unknown");
  assert.equal(result.concurrency["fork-1"]?.complete, false);
  assert.equal(status(result, "attempts-closed"), "unproven");
  assert.equal(status(result, "concurrency"), "unproven");
  assert.equal(status(result, "evidence-persistence"), "unproven");
});

test("rejects a join that starts before a dependency turn settles", () => {
  eventNumber = 0;
  const result = assessment(
    [
      ...taskTurn("task-a", "session-a", 100, 300),
      ...taskTurn("task-b", "session-b", 110, 300),
    ],
    forkEvidence({ joinStartMs: 250, joinFinishMs: 400 }),
  );
  assert.equal(status(result, "join-ordering"), "failed");
  assert.equal(result.concurrency["fork-1"]?.status, "observed");
});

test("requires validated dependency statuses for a completed join", () => {
  eventNumber = 0;
  const graphEvents = forkEvidence({});
  const finished = graphEvents.find(({ kind }) => kind === "join_finished");
  assert.ok(finished);
  const invalidFinished = {
    ...finished,
    dependencies: finished.dependencies.map((item, index) =>
      index === 0 ? { ...item, status: "provisional" as const } : item,
    ),
  };
  const result = assessment(
    [
      ...taskTurn("task-a", "session-a", 100, 300),
      ...taskTurn("task-b", "session-b", 200, 500),
    ],
    graphEvents.map((event) =>
      event.kind === "join_finished" ? invalidFinished : event,
    ),
  );
  assert.equal(status(result, "join-ordering"), "failed");
});

test("accepts explicit caller-owned retention and distinguishes it from failed cleanup", () => {
  eventNumber = 0;
  const result = assessment(
    [
      runEvent("cleanup_intent", 10, {
        operationId: "cleanup-1",
        facts: {
          ownership: "caller",
          resourceId: "worktree:/caller",
        },
      }),
      runEvent("cleanup_outcome", 11, {
        operationId: "cleanup-1",
        facts: {
          ownership: "caller",
          disposition: "retained",
          operationStatus: "not_attempted",
          reasonCode: "caller_owned",
        },
      }),
    ],
    [],
  );
  assert.equal(status(result, "cleanup-policy"), "passed");
});

test("accepts outcome-only no-controller guard decisions from cleanup recorder", () => {
  eventNumber = 0;
  const skipped = cleanupRecords("sandbox:/unowned-skipped", (recorder) =>
    recorder.outcome({
      disposition: "skipped",
      operationStatus: "not_attempted",
      reasonCode: "no_controller_ownership",
    }),
  );
  const retained = cleanupRecords("sandbox:/unowned-retained", (recorder) =>
    recorder.outcome({
      disposition: "retained",
      operationStatus: "not_attempted",
      reasonCode: "no_controller_ownership",
    }),
  );
  assert.deepEqual(
    [...skipped, ...retained].map(({ event }) => event),
    ["outcome", "outcome"],
  );
  assert.notEqual(skipped[0]?.operationId, retained[0]?.operationId);

  const result = assessment(cleanupRunEvents([...skipped, ...retained]), []);
  assert.equal(status(result, "cleanup-policy"), "passed");
});

test("accepts controller-owned deferred sandbox retention without intent", () => {
  eventNumber = 0;
  const result = assessment(
    [
      runEvent("cleanup_outcome", 10, {
        operationId: "cleanup-deferred-sandbox",
        facts: deferredSandboxCleanupFacts,
      }),
    ],
    [],
  );
  assert.equal(status(result, "cleanup-policy"), "passed");
});

test("keeps near-miss deferred sandbox retention outcomes unproven", () => {
  const nearMisses = [
    [
      "wrong phase",
      {
        ...deferredSandboxCleanupFacts,
        phase: "feature-worktree-lifecycle-cleanup",
      },
    ],
    [
      "empty expected identity",
      { ...deferredSandboxCleanupFacts, expectedIdentity: "" },
    ],
    [
      "foreign ownership",
      { ...deferredSandboxCleanupFacts, ownership: "foreign" },
    ],
    [
      "unknown ownership",
      { ...deferredSandboxCleanupFacts, ownership: "unknown" },
    ],
    [
      "wrong resource type",
      { ...deferredSandboxCleanupFacts, resourceType: "directory" },
    ],
    [
      "wrong disposition",
      { ...deferredSandboxCleanupFacts, disposition: "skipped" },
    ],
    [
      "wrong reason",
      { ...deferredSandboxCleanupFacts, reasonCode: "caller_owned" },
    ],
  ] as const;

  for (const [index, [label, facts]] of nearMisses.entries()) {
    eventNumber = 0;
    const result = assessment(
      [
        runEvent("cleanup_outcome", 10, {
          operationId: `cleanup-deferred-sandbox-near-miss-${index}`,
          facts,
        }),
      ],
      [],
    );
    assert.equal(status(result, "cleanup-policy"), "unproven", label);
  }
});

test("keeps a succeeded cleanup removal without intent unproven", () => {
  eventNumber = 0;
  const records = cleanupRecords(
    "sandbox:/removed-without-intent",
    (recorder) =>
      recorder.outcome({
        disposition: "removed",
        operationStatus: "succeeded",
        reasonCode: "worktree_removed",
      }),
    "controller",
  );
  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "unproven");
});

test("keeps an outcome failure failed without requiring an intent", () => {
  eventNumber = 0;
  const records = cleanupRecords(
    "sandbox:/failed-without-intent",
    (recorder) =>
      recorder.outcome({
        disposition: "retained",
        operationStatus: "failed",
        reasonCode: "worktree_remove_failed",
      }),
    "controller",
  );
  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("keeps an open cleanup intent unproven", () => {
  eventNumber = 0;
  const records = cleanupRecords(
    "sandbox:/open-intent",
    (recorder) => recorder.intent(),
    "controller",
  );
  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "unproven");
});

test("keeps a missing cleanup outcome unproven", () => {
  eventNumber = 0;
  const result = assessment(
    [
      runEvent("cleanup_intent", 10, {
        operationId: "cleanup-missing-outcome",
        facts: {
          ownership: "controller",
          resourceId: "worktree:/owned",
        },
      }),
    ],
    [],
  );
  assert.equal(status(result, "cleanup-policy"), "unproven");
});

test("marks an explicit cleanup operation failure failed", () => {
  eventNumber = 0;
  const result = assessment(
    [
      runEvent("cleanup_intent", 10, {
        operationId: "cleanup-failed",
        facts: { ownership: "controller" },
      }),
      runEvent("cleanup_outcome", 11, {
        operationId: "cleanup-failed",
        facts: {
          ownership: "controller",
          disposition: "retained",
          operationStatus: "failed",
          reasonCode: "worktree_remove_failed",
        },
      }),
    ],
    [],
  );
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("recovers the actual runtime parent 184-to-188 cleanup sequence", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "failed",
    reasonCode: "runtime_parent_nonempty",
  });
  addCleanupAttempt(
    records,
    {
      resourceId:
        "/tmp/pipi-pipeline-evidence-QA8WJr/task-worktrees/smoke-pipeline-evidence-a1b2c3d4/.pipi-runtime/branch-2-parallel-b",
      resourceType: "sandbox",
      resource:
        "/tmp/pipi-pipeline-evidence-QA8WJr/task-worktrees/smoke-pipeline-evidence-a1b2c3d4/.pipi-runtime/branch-2-parallel-b",
      ownership: "controller",
      expectedIdentity: "55:1861891",
    },
    {
      disposition: "removed",
      operationStatus: "succeeded",
      reasonCode: "runtime_root_removed",
    },
  );
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "removed",
    operationStatus: "succeeded",
    reasonCode: "runtime_parent_removed",
  });

  const result = assessment(
    cleanupRunEvents(records, [183, 184, 185, 186, 187, 188]),
    [],
  );
  assert.equal(status(result, "cleanup-policy"), "passed");
  assert.equal(
    records.some(
      (record) =>
        record.event === "outcome" &&
        record.operationStatus === "failed" &&
        record.reasonCode === "runtime_parent_nonempty",
    ),
    true,
  );
});

test("keeps an unrecovered runtime parent failure failed", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "failed",
    reasonCode: "runtime_parent_nonempty",
  });

  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("does not recover a path when the later cleanup has a foreign identity", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "failed",
    reasonCode: "runtime_parent_nonempty",
  });
  addCleanupAttempt(
    records,
    { ...runtimeParentTarget, expectedIdentity: "55:foreign" },
    {
      disposition: "removed",
      operationStatus: "succeeded",
      reasonCode: "runtime_parent_removed",
    },
  );

  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("does not recover a runtime parent failure with success recorded first", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "removed",
    operationStatus: "succeeded",
    reasonCode: "runtime_parent_removed",
  });
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "failed",
    reasonCode: "runtime_parent_nonempty",
  });

  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("does not suppress an unrelated cleanup failure", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "failed",
    reasonCode: "runtime_parent_nonempty",
  });
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "removed",
    operationStatus: "succeeded",
    reasonCode: "runtime_parent_removed",
  });
  addCleanupAttempt(
    records,
    {
      resourceId: "worktree:/owned",
      resourceType: "worktree",
      resource: "/owned",
      ownership: "controller",
      expectedIdentity: "commit-a",
    },
    {
      disposition: "retained",
      operationStatus: "failed",
      reasonCode: "worktree_remove_failed",
    },
  );

  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("does not suppress unknown cleanup failure", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "failed",
    reasonCode: "runtime_parent_unknown_failure",
  });
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "removed",
    operationStatus: "succeeded",
    reasonCode: "runtime_parent_removed",
  });

  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "failed");
});

test("keeps an unknown cleanup disposition unproven", () => {
  eventNumber = 0;
  const records: CleanupEvidence[] = [];
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "retained",
    operationStatus: "not_attempted",
    reasonCode: "runtime_parent_unknown_disposition",
  });
  addCleanupAttempt(records, runtimeParentTarget, {
    disposition: "removed",
    operationStatus: "succeeded",
    reasonCode: "runtime_parent_removed",
  });

  const result = assessment(cleanupRunEvents(records), []);
  assert.equal(status(result, "cleanup-policy"), "unproven");
});

test("closes a provider startup failure when a later task attempt recovers", () => {
  eventNumber = 0;
  const result = assessment(
    [
      runEvent("spawn_requested", 1, {
        taskId: "task-recovered",
        sessionId: "failed-session",
        attemptId: "failed-attempt",
      }),
      runEvent("spawn_failed", 2, {
        taskId: "task-recovered",
        sessionId: "failed-session",
        attemptId: "failed-attempt",
        detail: "provider unavailable",
      }),
      runEvent("spawn_requested", 3, {
        taskId: "task-recovered",
        sessionId: "working-session",
        attemptId: "working-attempt",
      }),
      runEvent("session_created", 4, {
        taskId: "task-recovered",
        sessionId: "working-session",
        attemptId: "working-attempt",
        facts: {
          requestedModel: "openai-codex/gpt-5.6-luna",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          servingRevision: null,
        },
      }),
      ...taskTurn("task-recovered", "working-session", 10, 20, {
        attemptId: "working-attempt",
      }),
    ],
    [],
  );
  assert.equal(status(result, "attempts-closed"), "passed");
  assert.equal(status(result, "model-provenance"), "passed");
});

test("does not claim model provenance when selected metadata is absent", () => {
  eventNumber = 0;
  const result = assessment(
    [
      runEvent("session_created", 1, {
        sessionId: "metadata-missing",
        attemptId: "metadata-attempt",
        facts: {
          requestedModel: "openai-codex/gpt-5.6-luna",
          provider: "openai-codex",
          servingRevision: null,
        },
      }),
    ],
    [],
  );
  assert.equal(status(result, "model-provenance"), "unproven");
});

test("marks graph and concurrency not applicable when no feature graph is required", () => {
  eventNumber = 0;
  const result = assessment([], [], { featureGraphRequired: false });
  assert.deepEqual(result.concurrency, {});
  assert.equal(status(result, "join-ordering"), "not_applicable");
  assert.equal(status(result, "concurrency"), "not_applicable");
});

test("does not infer a required graph from an empty evidence stream", () => {
  eventNumber = 0;
  const result = assessment([], []);
  assert.deepEqual(result.concurrency, {});
  assert.equal(status(result, "join-ordering"), "unproven");
  assert.equal(status(result, "concurrency"), "unproven");
});
