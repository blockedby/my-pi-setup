import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const Id = Type.String({ minLength: 1, maxLength: 256 });
const Text = Type.String({ maxLength: 2048 });
export const RUN_EVENT_SCHEMA = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    runId: Id,
    controllerInstanceId: Id,
    eventId: Id,
    sequence: Type.Integer({ minimum: 1 }),
    at: Type.Number({ minimum: 0 }),
    offsetMs: Type.Number({ minimum: 0 }),
    kind: Type.String({ minLength: 1, maxLength: 80 }),
    role: Type.Optional(Id),
    taskId: Type.Optional(Id),
    attemptId: Type.Optional(Id),
    sessionId: Type.Optional(Id),
    turnId: Type.Optional(Id),
    submissionId: Type.Optional(Id),
    checkInvocationId: Type.Optional(Id),
    operationId: Type.Optional(Id),
    detail: Type.Optional(Text),
    facts: Type.Optional(
      Type.Record(
        Type.String({ maxLength: 80 }),
        Type.Union([Text, Type.Number(), Type.Boolean(), Type.Null()]),
      ),
    ),
  },
  { additionalProperties: false },
);
export type RunEvent = Static<typeof RUN_EVENT_SCHEMA>;
export type RunEventInput = Omit<
  RunEvent,
  | "schemaVersion"
  | "runId"
  | "controllerInstanceId"
  | "eventId"
  | "sequence"
  | "at"
  | "offsetMs"
>;

export function parseRunEvent(value: unknown) {
  if (!Check(RUN_EVENT_SCHEMA, value))
    throw new Error("Invalid run evidence event.");
  return value;
}

/** Controller-only journal. Persistence failures are sticky, never synthetic success. */
export function createRunEvidenceJournal(options: {
  runId: string;
  controllerInstanceId?: string;
  now: () => number;
  persist?: (event: RunEvent) => Promise<unknown>;
}) {
  const controllerInstanceId = options.controllerInstanceId ?? randomUUID();
  const origin = options.now();
  const events: RunEvent[] = [];
  const failures: string[] = [];
  let writes = Promise.resolve();
  let sealed = false;
  const markIncomplete = (error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    if (failures.length < 32) failures.push(detail.slice(0, 2048));
  };
  return {
    controllerInstanceId,
    originMs: origin,
    get sealed() {
      return sealed;
    },
    markIncomplete,
    append(input: RunEventInput) {
      if (sealed) {
        markIncomplete("Late event after evidence seal.");
        return undefined;
      }
      try {
        const event = parseRunEvent({
          ...input,
          schemaVersion: 2,
          runId: options.runId,
          controllerInstanceId,
          eventId: randomUUID(),
          sequence: events.length + 1,
          at: Date.now(),
          offsetMs: Math.max(0, options.now() - origin),
        });
        const copy = structuredClone(event);
        events.push(copy);
        writes = writes
          .then(async () => {
            await options.persist?.(structuredClone(copy));
          })
          .catch(markIncomplete);
        return structuredClone(copy);
      } catch (error) {
        markIncomplete(error);
        return undefined;
      }
    },
    snapshot() {
      return {
        schemaVersion: 2 as const,
        runId: options.runId,
        controllerInstanceId,
        completeness: failures.length
          ? ("incomplete" as const)
          : ("complete" as const),
        events: structuredClone(events),
        failures: [...failures],
        sealed,
      };
    },
    async flush() {
      await writes;
    },
    async seal() {
      sealed = true;
      await writes;
    },
  };
}
