import { randomUUID } from "node:crypto";
import type { EventBus } from "@earendil-works/pi-coding-agent";

export type ActivitySource = "subagents" | "pipelines";

export const HERDR_ACTIVITY_EVENT = "herdr:pipi:activity";
export const HERDR_ACTIVITY_REPLAY_REQUEST_EVENT =
  "herdr:pipi:activity:request";

interface ActivityEnvelopeBase {
  readonly source: ActivitySource;
  readonly publisherId: string;
  readonly generation: string;
  readonly revision: number;
  readonly requestId?: string;
}

type ParsedActivityEnvelopeBase = ActivityEnvelopeBase &
  Record<string, unknown>;

export interface ActivityUpdate extends ActivityEnvelopeBase {
  readonly type: "update";
  readonly ids: readonly string[];
}

export interface ActivityRetirement extends ActivityEnvelopeBase {
  readonly type: "retire";
}

export type ActivityEnvelope = ActivityUpdate | ActivityRetirement;

export interface ActivityReplayRequest {
  readonly type: "replay";
  readonly requestId: string;
}

export interface ActivityPublisher {
  update(ids: readonly string[]): void;
  dispose(): void;
}

export interface ActivityStore {
  requestReplay(): void;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isActivitySource(value: unknown): value is ActivitySource {
  return value === "subagents" || value === "pipelines";
}

function isEnvelopeBase(
  value: Record<string, unknown>,
): value is ParsedActivityEnvelopeBase {
  return (
    isActivitySource(value.source) &&
    typeof value.publisherId === "string" &&
    value.publisherId.length > 0 &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    (value.requestId === undefined || typeof value.requestId === "string")
  );
}

function parseEnvelope(value: unknown): ActivityEnvelope | undefined {
  if (!isRecord(value) || !isEnvelopeBase(value)) return undefined;

  const base = {
    source: value.source,
    publisherId: value.publisherId,
    generation: value.generation,
    revision: value.revision,
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
  } satisfies ActivityEnvelopeBase;

  if (value.type === "retire") {
    return { type: "retire", ...base };
  }

  if (value.type !== "update" || !Array.isArray(value.ids)) return undefined;
  const ids: string[] = [];
  for (const id of value.ids) {
    if (typeof id !== "string") return undefined;
    ids.push(id);
  }

  return { type: "update", ...base, ids };
}

function parseReplayRequest(value: unknown): ActivityReplayRequest | undefined {
  if (
    !isRecord(value) ||
    value.type !== "replay" ||
    typeof value.requestId !== "string" ||
    value.requestId.length === 0
  ) {
    return undefined;
  }
  return { type: "replay", requestId: value.requestId };
}

function normalizeIds(ids: readonly string[]) {
  return [...new Set(ids)];
}

function publisherKey(source: ActivitySource, publisherId: string) {
  return `${source}\u0000${publisherId}`;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

/**
 * Publishes an authoritative running-id snapshot for one activity source.
 * The publisher's identity is scoped to this instance and its event bus.
 */
export function createActivityPublisher(
  events: EventBus,
  source: ActivitySource,
) {
  const publisherId = `${source}:${randomUUID()}`;
  const generation = randomUUID();
  let revision = 0;
  let ids: readonly string[] = [];
  let disposed = false;

  const publish = (requestId?: string) => {
    if (disposed) return;
    revision += 1;
    const envelope: ActivityUpdate = {
      type: "update",
      source,
      publisherId,
      generation,
      revision,
      ids: [...ids],
      ...(requestId ? { requestId } : {}),
    };
    events.emit(HERDR_ACTIVITY_EVENT, envelope);
  };

  const stopReplayListener = events.on(
    HERDR_ACTIVITY_REPLAY_REQUEST_EVENT,
    (value) => {
      if (disposed) return;
      const request = parseReplayRequest(value);
      if (request) publish(request.requestId);
    },
  );

  return {
    update(nextIds: readonly string[]) {
      if (disposed) return;
      ids = normalizeIds(nextIds);
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopReplayListener();
      revision += 1;
      const retirement: ActivityRetirement = {
        type: "retire",
        source,
        publisherId,
        generation,
        revision,
      };
      events.emit(HERDR_ACTIVITY_EVENT, retirement);
    },
  } satisfies ActivityPublisher;
}

interface PublisherRecord {
  readonly source: ActivitySource;
  readonly publisherId: string;
  readonly generation: string;
  readonly revision: number;
  readonly ids: readonly string[];
}

/**
 * Consumes all live publisher snapshots on one event bus and reports their
 * union. A replay request makes the consumer independent of extension load
 * order; retirement and generation checks prevent stale instances reviving.
 */
export function createActivityStore(
  events: EventBus,
  onChange: (ids: readonly string[]) => void,
) {
  const records = new Map<string, PublisherRecord>();
  const retiredGenerations = new Map<string, Set<string>>();
  let currentIds: readonly string[] = [];
  let disposed = false;
  const requestId = randomUUID();

  const notifyIfChanged = () => {
    const nextIds = [
      ...new Set([...records.values()].flatMap((record) => record.ids)),
    ];
    if (sameIds(currentIds, nextIds)) return;
    currentIds = nextIds;
    onChange([...currentIds]);
  };

  const retireGeneration = (key: string, generation: string) => {
    let generations = retiredGenerations.get(key);
    if (!generations) {
      generations = new Set<string>();
      retiredGenerations.set(key, generations);
    }
    generations.add(generation);
  };

  const stopActivityListener = events.on(HERDR_ACTIVITY_EVENT, (value) => {
    if (disposed) return;
    const envelope = parseEnvelope(value);
    if (!envelope) return;

    const key = publisherKey(envelope.source, envelope.publisherId);
    const retired = retiredGenerations.get(key);

    if (envelope.type === "retire") {
      const current = records.get(key);
      if (
        current &&
        current.generation === envelope.generation &&
        envelope.revision < current.revision
      ) {
        return;
      }

      retireGeneration(key, envelope.generation);
      if (current?.generation === envelope.generation) {
        records.delete(key);
        notifyIfChanged();
      }
      return;
    }

    if (retired?.has(envelope.generation)) return;

    const current = records.get(key);
    if (current?.generation === envelope.generation) {
      if (envelope.revision <= current.revision) return;
      records.set(key, envelope);
      notifyIfChanged();
      return;
    }

    if (current) retireGeneration(key, current.generation);
    records.set(key, envelope);
    notifyIfChanged();
  });

  const requestReplay = () => {
    if (disposed) return;
    events.emit(HERDR_ACTIVITY_REPLAY_REQUEST_EVENT, {
      type: "replay",
      requestId,
    } satisfies ActivityReplayRequest);
  };

  // Let all extension factories install their publisher listeners first.
  queueMicrotask(requestReplay);

  return {
    requestReplay,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopActivityListener();
      records.clear();
      retiredGenerations.clear();
      if (currentIds.length > 0) {
        currentIds = [];
        onChange([]);
      }
    },
  } satisfies ActivityStore;
}
