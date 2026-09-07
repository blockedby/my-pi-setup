import assert from "node:assert/strict";
import test from "node:test";
import {
  createRunEvidenceJournal,
  parseRunEvent,
  type RunEvent,
  type RunEventInput,
} from "./run-evidence.ts";

function fakeClock(start = 10_000) {
  let current = start;
  return {
    now: () => current,
    advance(milliseconds: number) {
      current += milliseconds;
    },
  };
}

function input(kind = "run_started") {
  return {
    kind,
    role: "controller",
  } satisfies RunEventInput;
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("run event schema rejects extra fields and the journal records no event", () => {
  const value: Record<string, unknown> = {
    schemaVersion: 2,
    runId: "run-extra-field",
    controllerInstanceId: "controller-extra-field",
    eventId: "event-extra-field",
    sequence: 1,
    at: 10_000,
    offsetMs: 0,
    kind: "run_started",
  };
  Reflect.set(value, "unexpected", true);

  assert.throws(() => parseRunEvent(value), /Invalid run evidence event/u);

  const clock = fakeClock();
  const journal = createRunEvidenceJournal({
    runId: "run-extra-field",
    controllerInstanceId: "controller-extra-field",
    now: clock.now,
  });
  const accepted = Reflect.apply(journal.append, journal, [value]);

  assert.equal(accepted, undefined);
  assert.deepEqual(journal.snapshot().events, []);
  assert.equal(journal.snapshot().completeness, "incomplete");
});

test("journal keeps run and controller identity authoritative over spoofed input", () => {
  const clock = fakeClock();
  const journal = createRunEvidenceJournal({
    runId: "run-authoritative",
    controllerInstanceId: "controller-authoritative",
    now: clock.now,
  });
  const malicious: Record<string, unknown> = { kind: "run_started" };
  for (const [key, value] of Object.entries({
    runId: "run-spoofed",
    controllerInstanceId: "controller-spoofed",
    eventId: "event-spoofed",
    sequence: 999,
    at: 1,
    offsetMs: 1,
  })) {
    Reflect.set(malicious, key, value);
  }

  const accepted = Reflect.apply(journal.append, journal, [malicious]);
  assert.ok(accepted);
  const event = journal.snapshot().events[0];
  assert.ok(event);
  assert.equal(event.runId, "run-authoritative");
  assert.equal(event.controllerInstanceId, "controller-authoritative");
  assert.notEqual(event.eventId, "event-spoofed");
  assert.equal(event.sequence, 1);
});

test("accepted events receive unique ordered sequences", () => {
  const clock = fakeClock();
  const journal = createRunEvidenceJournal({
    runId: "run-sequences",
    controllerInstanceId: "controller-sequences",
    now: clock.now,
  });

  for (let index = 0; index < 64; index++) {
    const accepted = journal.append({
      ...input("observation"),
      detail: `event-${index}`,
    });
    assert.ok(accepted);
    assert.equal(accepted.offsetMs, index);
    clock.advance(1);
  }

  const events = journal.snapshot().events;
  assert.deepEqual(
    events.map((event) => event.sequence),
    Array.from({ length: 64 }, (_, index) => index + 1),
  );
  assert.equal(new Set(events.map((event) => event.sequence)).size, 64);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 64);
});

test("journal, returned events, snapshots, and persistence receive independent copies", async () => {
  const clock = fakeClock();
  const persisted: RunEvent[] = [];
  const journal = createRunEvidenceJournal({
    runId: "run-copies",
    controllerInstanceId: "controller-copies",
    now: clock.now,
    persist: async (event) => {
      persisted.push(event);
    },
  });
  const original = {
    ...input("copy_check"),
    facts: { state: "original", count: 1 },
  } satisfies RunEventInput;

  const returned = journal.append(original);
  assert.ok(returned);
  assert.ok(original.facts);
  assert.ok(returned.facts);
  Reflect.set(original.facts, "state", "input-mutated");
  Reflect.set(returned.facts, "state", "returned-mutated");

  const snapshot = journal.snapshot();
  const snapshotEvent = snapshot.events[0];
  assert.ok(snapshotEvent);
  assert.ok(snapshotEvent.facts);
  Reflect.set(snapshotEvent.facts, "state", "snapshot-mutated");

  await journal.flush();
  const persistedEvent = persisted[0];
  assert.ok(persistedEvent);
  assert.ok(persistedEvent.facts);
  assert.equal(persistedEvent.facts.state, "original");
  Reflect.set(persistedEvent.facts, "state", "persistence-mutated");

  const current = journal.snapshot().events[0];
  assert.ok(current);
  assert.ok(current.facts);
  assert.equal(current.facts.state, "original");
});

test("persistence writes run one at a time in append order", async () => {
  const clock = fakeClock();
  const started: number[] = [];
  const completed: number[] = [];
  const gates = new Map<number, ReturnType<typeof deferred>>();
  const journal = createRunEvidenceJournal({
    runId: "run-ordered-writes",
    controllerInstanceId: "controller-ordered-writes",
    now: clock.now,
    persist: async (event) => {
      started.push(event.sequence);
      const gate = deferred();
      gates.set(event.sequence, gate);
      await gate.promise;
      completed.push(event.sequence);
    },
  });

  journal.append(input("first"));
  journal.append(input("second"));
  journal.append(input("third"));

  await nextTurn();
  assert.deepEqual(started, [1]);
  assert.deepEqual(completed, []);

  const firstGate = gates.get(1);
  assert.ok(firstGate);
  firstGate.resolve();
  await nextTurn();
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(completed, [1]);

  const secondGate = gates.get(2);
  assert.ok(secondGate);
  secondGate.resolve();
  await nextTurn();
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(completed, [1, 2]);

  const thirdGate = gates.get(3);
  assert.ok(thirdGate);
  thirdGate.resolve();
  await journal.flush();
  assert.deepEqual(completed, [1, 2, 3]);
});

test("a persistence failure remains sticky without turning the journal into a success", async () => {
  const clock = fakeClock();
  let calls = 0;
  const journal = createRunEvidenceJournal({
    runId: "run-persistence-failure",
    controllerInstanceId: "controller-persistence-failure",
    now: clock.now,
    persist: async () => {
      calls++;
      if (calls === 1) throw new Error("evidence storage unavailable");
    },
  });

  assert.ok(journal.append(input("first")));
  await journal.flush();
  const afterFailure = journal.snapshot();
  assert.equal(afterFailure.completeness, "incomplete");
  assert.match(
    afterFailure.failures.join("\n"),
    /evidence storage unavailable/u,
  );

  assert.ok(journal.append(input("after_failure")));
  await journal.flush();
  const afterRecovery = journal.snapshot();
  assert.equal(afterRecovery.completeness, "incomplete");
  assert.equal(afterRecovery.failures.length, 1);
  assert.deepEqual(
    afterRecovery.events.map((event) => event.sequence),
    [1, 2],
  );
});

test("sealing rejects late events and marks the evidence incomplete", async () => {
  const clock = fakeClock();
  const persisted: RunEvent[] = [];
  const journal = createRunEvidenceJournal({
    runId: "run-sealed",
    controllerInstanceId: "controller-sealed",
    now: clock.now,
    persist: async (event) => {
      persisted.push(event);
    },
  });

  assert.ok(journal.append(input("before_seal")));
  await journal.seal();
  const late = journal.append(input("after_seal"));

  assert.equal(late, undefined);
  assert.equal(persisted.length, 1);
  const snapshot = journal.snapshot();
  assert.equal(snapshot.sealed, true);
  assert.equal(snapshot.completeness, "incomplete");
  assert.deepEqual(
    snapshot.events.map((event) => event.kind),
    ["before_seal"],
  );
  assert.match(snapshot.failures.join("\n"), /Late event after evidence seal/u);
});

test("provider startup evidence is valid without a session file or session ID", async () => {
  const clock = fakeClock();
  const journal = createRunEvidenceJournal({
    runId: "run-provider-startup",
    controllerInstanceId: "controller-provider-startup",
    now: clock.now,
  });

  const event = journal.append({
    kind: "provider_startup",
    role: "worker",
    detail: "Provider startup failed before a session was created.",
  });
  assert.ok(event);
  assert.equal(event.sessionId, undefined);
  assert.equal(Reflect.get(event, "sessionFile"), undefined);

  await journal.flush();
  const snapshot = journal.snapshot();
  assert.equal(snapshot.completeness, "complete");
  assert.equal(snapshot.events[0]?.kind, "provider_startup");
  assert.equal(snapshot.events[0]?.sessionId, undefined);
});
