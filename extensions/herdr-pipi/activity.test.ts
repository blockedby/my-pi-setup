import assert from "node:assert/strict";
import test from "node:test";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  createActivityPublisher,
  createActivityStore,
  HERDR_ACTIVITY_EVENT,
  HERDR_ACTIVITY_REPLAY_REQUEST_EVENT,
  type ActivityEnvelope,
  type ActivityReplayRequest,
  type ActivityRetirement,
  type ActivitySource,
  type ActivityUpdate,
} from "./activity.ts";

interface Emission {
  channel: string;
  data: unknown;
}

// Match Pi's channel-scoped, synchronous, non-replaying event bus. Replay must
// come from the activity handshake, never from the test harness.
class RecordingEventBus implements EventBus {
  readonly emissions: Emission[] = [];
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown) {
    this.emissions.push({ channel, data });
    for (const listener of Array.from(this.listeners.get(channel) ?? [])) {
      listener(data);
    }
  }

  on(channel: string, handler: (data: unknown) => void) {
    const listeners =
      this.listeners.get(channel) ?? new Set<(data: unknown) => void>();
    this.listeners.set(channel, listeners);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
      if (listeners.size === 0) this.listeners.delete(channel);
    };
  }

  listenerCount(channel: string) {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

const activityUpdate = (
  source: ActivitySource,
  publisherId: string,
  generation: string,
  revision: number,
  ids: readonly string[],
) =>
  ({
    type: "update",
    source,
    publisherId,
    generation,
    revision,
    ids: [...ids],
  }) satisfies ActivityUpdate;

const activityRetirement = (
  source: ActivitySource,
  publisherId: string,
  generation: string,
  revision: number,
) =>
  ({
    type: "retire",
    source,
    publisherId,
    generation,
    revision,
  }) satisfies ActivityRetirement;

function emitActivity(events: EventBus, envelope: ActivityEnvelope) {
  events.emit(HERDR_ACTIVITY_EVENT, envelope);
}

function isReplayRequest(value: unknown): value is ActivityReplayRequest {
  return (
    isRecord(value) &&
    value.type === "replay" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0
  );
}

async function flushMicrotasks() {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readEnvelope(data: unknown) {
  assert.ok(isRecord(data));
  if (data.type !== "update" && data.type !== "retire") {
    throw new Error("not an activity envelope");
  }
  if (
    typeof data.source !== "string" ||
    typeof data.publisherId !== "string" ||
    typeof data.generation !== "string" ||
    typeof data.revision !== "number"
  ) {
    throw new Error("invalid activity envelope metadata");
  }
  if (data.type === "update") {
    const ids: string[] = [];
    if (!Array.isArray(data.ids)) throw new Error("missing activity ids");
    for (const id of data.ids) {
      if (typeof id !== "string") throw new Error("invalid activity id");
      ids.push(id);
    }
    return {
      type: data.type,
      source: data.source,
      publisherId: data.publisherId,
      generation: data.generation,
      revision: data.revision,
      ids,
    };
  }
  return {
    type: data.type,
    source: data.source,
    publisherId: data.publisherId,
    generation: data.generation,
    revision: data.revision,
  };
}

test("activity publishers emit immutable snapshots and retire exactly once on dispose", () => {
  const events = new RecordingEventBus();
  const ids = ["subagent-1"];
  const publisher = createActivityPublisher(events, "subagents");

  publisher.update(ids);
  ids.push("mutated-after-update");
  publisher.dispose();
  publisher.dispose();
  publisher.update(["stale-after-dispose"]);

  const [update, retirement] = events.emissions.map(({ data }) =>
    readEnvelope(data),
  );
  assert.ok(update);
  assert.ok(retirement);
  assert.deepEqual(update.ids, ["subagent-1"]);
  assert.equal(update.type, "update");
  assert.equal(retirement.type, "retire");
  assert.equal(retirement.source, "subagents");
  assert.equal(retirement.publisherId, update.publisherId);
  assert.equal(retirement.generation, update.generation);
  assert.equal(retirement.revision, update.revision + 1);
  assert.equal(events.emissions.length, 2);
});

test("subagent and pipeline publishers keep independent snapshots", () => {
  const events = new RecordingEventBus();
  const subagents = createActivityPublisher(events, "subagents");
  const pipelines = createActivityPublisher(events, "pipelines");

  subagents.update(["subagent-1"]);
  pipelines.update(["pipeline-1"]);
  subagents.update([]);

  assert.deepEqual(
    events.emissions.map(({ data }) => {
      const envelope = readEnvelope(data);
      return {
        type: envelope.type,
        source: envelope.source,
        ids: envelope.type === "update" ? envelope.ids : undefined,
      };
    }),
    [
      { type: "update", source: "subagents", ids: ["subagent-1"] },
      { type: "update", source: "pipelines", ids: ["pipeline-1"] },
      { type: "update", source: "subagents", ids: [] },
    ],
  );
});

test("repeated authoritative snapshots advance revisions and normalize duplicate ids", () => {
  const events = new RecordingEventBus();
  const publisher = createActivityPublisher(events, "pipelines");

  publisher.update(["pipeline-1", "pipeline-2", "pipeline-1"]);
  publisher.update(["pipeline-1", "pipeline-2"]);
  publisher.update([]);
  publisher.update([]);

  const envelopes = events.emissions.map(({ data }) => readEnvelope(data));
  assert.deepEqual(
    envelopes.map(({ type, source, ids }) => ({ type, source, ids })),
    [
      {
        type: "update",
        source: "pipelines",
        ids: ["pipeline-1", "pipeline-2"],
      },
      {
        type: "update",
        source: "pipelines",
        ids: ["pipeline-1", "pipeline-2"],
      },
      { type: "update", source: "pipelines", ids: [] },
      { type: "update", source: "pipelines", ids: [] },
    ],
  );
  assert.deepEqual(
    envelopes.map(({ revision }) => revision),
    [1, 2, 3, 4],
  );
});

test("activity store late attachment recovers live state through the replay handshake", async () => {
  const events = new RecordingEventBus();
  const publisher = createActivityPublisher(events, "subagents");
  publisher.update(["live-subagent"]);

  const changes: string[][] = [];
  const store = createActivityStore(events, (ids) => changes.push([...ids]));
  await flushMicrotasks();

  const replayEmission = events.emissions.find(
    ({ channel }) => channel === HERDR_ACTIVITY_REPLAY_REQUEST_EVENT,
  );
  assert.ok(replayEmission);
  const replayRequest = replayEmission.data;
  assert.ok(isReplayRequest(replayRequest));

  const replayedEmission = events.emissions.find(
    ({ channel, data }) =>
      channel === HERDR_ACTIVITY_EVENT &&
      isRecord(data) &&
      data.requestId === replayRequest.requestId,
  );
  assert.ok(replayedEmission);
  const replayedEnvelope = readEnvelope(replayedEmission.data);
  assert.equal(replayedEnvelope.type, "update");
  if (replayedEnvelope.type !== "update") return;
  assert.deepEqual(replayedEnvelope.ids, ["live-subagent"]);
  assert.deepEqual(changes, [["live-subagent"]]);

  store.dispose();
  publisher.dispose();
});

test("activity store keeps the surviving source after an overlapping source retires", () => {
  const events = new RecordingEventBus();
  const changes: string[][] = [];
  const store = createActivityStore(events, (ids) => changes.push([...ids]));
  const subagents = createActivityPublisher(events, "subagents");
  const pipelines = createActivityPublisher(events, "pipelines");

  subagents.update(["shared", "subagent-1"]);
  pipelines.update(["shared", "pipeline-1"]);
  subagents.dispose();

  assert.deepEqual(changes, [
    ["shared", "subagent-1"],
    ["shared", "subagent-1", "pipeline-1"],
    ["shared", "pipeline-1"],
  ]);

  pipelines.dispose();
  store.dispose();
});

test("activity store ignores stale and duplicate revisions", () => {
  const events = new RecordingEventBus();
  const changes: string[][] = [];
  const store = createActivityStore(events, (ids) => changes.push([...ids]));

  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-a", 2, ["fresh"]),
  );
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-a", 2, [
      "duplicate",
    ]),
  );
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-a", 1, ["stale"]),
  );
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-a", 3, ["latest"]),
  );

  assert.deepEqual(changes, [["fresh"], ["latest"]]);
  store.dispose();
});

test("activity store does not revive a retired generation at a higher revision", () => {
  const events = new RecordingEventBus();
  const changes: string[][] = [];
  const store = createActivityStore(events, (ids) => changes.push([...ids]));

  emitActivity(
    events,
    activityUpdate("pipelines", "publisher-a", "generation-retired", 1, [
      "before-retirement",
    ]),
  );
  emitActivity(
    events,
    activityRetirement("pipelines", "publisher-a", "generation-retired", 2),
  );
  emitActivity(
    events,
    activityUpdate("pipelines", "publisher-a", "generation-retired", 3, [
      "revived",
    ]),
  );

  assert.deepEqual(changes, [["before-retirement"], []]);
  store.dispose();
});

test("activity store retires a previous generation when a replacement arrives", () => {
  const events = new RecordingEventBus();
  const changes: string[][] = [];
  const store = createActivityStore(events, (ids) => changes.push([...ids]));

  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-old", 1, ["old"]),
  );
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-new", 1, [
      "replacement",
    ]),
  );
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-old", 2, [
      "stale-old-generation",
    ]),
  );
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-new", 2, [
      "current",
    ]),
  );

  assert.deepEqual(changes, [["old"], ["replacement"], ["current"]]);
  store.dispose();
});

test("activity store disposal removes its listener and blocks post-disposal mutation", () => {
  const events = new RecordingEventBus();
  const changes: string[][] = [];
  const store = createActivityStore(events, (ids) => changes.push([...ids]));

  assert.equal(events.listenerCount(HERDR_ACTIVITY_EVENT), 1);
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-a", 1, ["before"]),
  );
  store.dispose();
  store.dispose();

  assert.equal(events.listenerCount(HERDR_ACTIVITY_EVENT), 0);
  assert.deepEqual(changes, [["before"], []]);
  const emissionsBeforePostDisposal = events.emissions.length;
  store.requestReplay();
  emitActivity(
    events,
    activityUpdate("subagents", "publisher-a", "generation-a", 2, ["after"]),
  );

  assert.equal(events.emissions.length, emissionsBeforePostDisposal + 1);
  assert.deepEqual(changes, [["before"], []]);
});

test("activity stores on independent buses remain isolated", () => {
  const firstEvents = new RecordingEventBus();
  const secondEvents = new RecordingEventBus();
  const firstChanges: string[][] = [];
  const secondChanges: string[][] = [];
  const firstStore = createActivityStore(firstEvents, (ids) =>
    firstChanges.push([...ids]),
  );
  const secondStore = createActivityStore(secondEvents, (ids) =>
    secondChanges.push([...ids]),
  );

  emitActivity(
    firstEvents,
    activityUpdate("subagents", "shared-publisher", "shared-generation", 1, [
      "first-bus",
    ]),
  );
  emitActivity(
    secondEvents,
    activityUpdate("subagents", "shared-publisher", "shared-generation", 1, [
      "second-bus",
    ]),
  );

  assert.deepEqual(firstChanges, [["first-bus"]]);
  assert.deepEqual(secondChanges, [["second-bus"]]);
  firstStore.dispose();
  secondStore.dispose();
});
