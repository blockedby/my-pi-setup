import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createActivityStore, type ActivityStore } from "./activity.ts";

const HERDR_SOURCE = "herdr:pi";
const HERDR_AGENT = "pi";
const HERDR_ACTIVITY_BLOCKED_EVENT = "herdr:blocked";
const REPORT_ATTEMPT_TIMEOUTS_MS = [500, 1_500] as const;

type AgentState = "working" | "blocked" | "idle";

type SessionReference =
  | { readonly agent_session_path: string }
  | { readonly agent_session_id: string }
  | undefined;

type WireRequest = Readonly<Record<string, unknown>>;

interface QueuedRequest {
  readonly line: string;
  readonly sequence: number;
}

interface LegacyBlockedEvent {
  readonly active: boolean;
  readonly label?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLegacyBlockedEvent(
  value: unknown,
): LegacyBlockedEvent | undefined {
  if (!isRecord(value) || typeof value.active !== "boolean") return undefined;
  return {
    active: value.active,
    ...(typeof value.label === "string" ? { label: value.label } : {}),
  };
}

function snapshotSessionReference(ctx: ExtensionContext) {
  try {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (typeof sessionFile === "string" && isAbsolute(sessionFile)) {
      return { agent_session_path: sessionFile };
    }
  } catch {
    // Fall back to the session id below.
  }

  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return { agent_session_id: sessionId };
    }
  } catch {
    // An unavailable session reference should not break reporting.
  }

  return undefined;
}

function createRequestQueue(
  endpoint: string | undefined,
  enabled: boolean,
  onUnsupported: () => void,
) {
  let disposed = false;
  let queuedState: QueuedRequest | undefined;
  const queuedSessions: QueuedRequest[] = [];
  let cancelInFlight: (() => void) | undefined;
  let activeRequest: QueuedRequest | undefined;
  let drainPromise: Promise<void> | undefined;
  let drainGeneration = 0;
  let flushing = false;

  const sendRequestAttempt = (line: string, timeoutMs: number) => {
    if (disposed || !enabled || !endpoint) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let socket: Socket | undefined;

      const finish = (delivered: boolean) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        if (cancelInFlight === cancel) cancelInFlight = undefined;
        socket?.destroy();
        resolve(delivered);
      };
      const cancel = () => finish(false);

      cancelInFlight = cancel;
      const probeId = `${HERDR_SOURCE}:capability:${randomUUID()}`;
      let probing = true;
      let reportId: unknown;
      let input = "";
      const onData = (chunk: string) => {
        input += chunk;
        if (input.length > 65_536) return finish(false);
        for (;;) {
          const newline = input.indexOf("\n");
          if (newline < 0 || finished) return;
          const responseLine = input.slice(0, newline);
          input = input.slice(newline + 1);
          try {
            const response: unknown = JSON.parse(responseLine);
            if (!isRecord(response)) return finish(false);
            if (probing) {
              if (
                response.id !== probeId ||
                !isRecord(response.result) ||
                response.result.type !== "pong"
              )
                return finish(false);
              const capabilities = response.result.capabilities;
              const supported =
                isRecord(capabilities) &&
                capabilities.pipi_resume_launcher === true;
              const request: unknown = JSON.parse(line);
              if (!isRecord(request) || !isRecord(request.params))
                return finish(false);
              if (
                supported &&
                (request.params.agent_session_path ||
                  request.params.agent_session_id)
              ) {
                request.params.resume_launcher = "pipi";
              } else if (!supported) {
                onUnsupported();
              }
              reportId = request.id;
              probing = false;
              // Herdr serves exactly one request per socket connection.
              connect(`${JSON.stringify(request)}\n`);
              return;
            } else {
              finish(
                response.id === reportId &&
                  isRecord(response.result) &&
                  response.result.type === "ok",
              );
            }
          } catch {
            finish(false);
          }
        }
      };
      const connect = (payload: string) => {
        if (finished) return;
        socket?.removeAllListeners();
        socket?.on("error", () => {});
        socket?.destroy();
        input = "";
        try {
          socket = createConnection(endpoint);
          socket.setEncoding("utf8");
          socket.once("error", () => finish(false));
          socket.once("end", () => finish(false));
          socket.once("close", () => finish(false));
          socket.on("data", onData);
          socket.once("connect", () => {
            try {
              socket?.write(payload);
            } catch {
              finish(false);
            }
          });
        } catch {
          finish(false);
        }
      };
      // No cross-connection capability cache: reprobe before each report.
      // Probe and report share a single bounded attempt timeout.
      timeout = setTimeout(() => finish(false), timeoutMs);
      timeout.unref?.();
      connect(
        `${JSON.stringify({ id: probeId, method: "ping", params: {} })}\n`,
      );
    });
  };

  const sendRequest = async (line: string, generation = drainGeneration) => {
    if (await sendRequestAttempt(line, REPORT_ATTEMPT_TIMEOUTS_MS[0])) {
      return true;
    }
    if (disposed || generation !== drainGeneration) return false;
    return sendRequestAttempt(line, REPORT_ATTEMPT_TIMEOUTS_MS[1]);
  };

  // State reports may be coalesced, but the surviving request still shares
  // the same ordered sequence stream as session reports.
  const nextRequest = () => {
    const sessionRequest = queuedSessions[0];
    if (!sessionRequest) {
      const stateRequest = queuedState;
      queuedState = undefined;
      return stateRequest;
    }

    if (!queuedState || sessionRequest.sequence < queuedState.sequence) {
      return queuedSessions.shift();
    }

    const stateRequest = queuedState;
    queuedState = undefined;
    return stateRequest;
  };

  const drain = () => {
    if (drainPromise || disposed || flushing || !enabled || !endpoint) {
      return;
    }

    const generation = drainGeneration;
    let resolveDrain = () => {};
    const currentDrain = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    drainPromise = currentDrain;

    void (async () => {
      try {
        while (!disposed && !flushing && generation === drainGeneration) {
          const next = nextRequest();
          if (!next) break;
          activeRequest = next;
          try {
            await sendRequest(next.line, generation);
          } finally {
            if (activeRequest === next) activeRequest = undefined;
          }
        }
      } catch {
        // Herdr is optional; a malformed or unavailable socket must be harmless.
      } finally {
        if (drainPromise === currentDrain) drainPromise = undefined;
        resolveDrain();
        if (
          !disposed &&
          !flushing &&
          generation === drainGeneration &&
          (queuedSessions.length > 0 || queuedState)
        ) {
          drain();
        }
      }
    })();
  };

  const enqueue = (request: WireRequest, state: boolean, sequence: number) => {
    if (disposed || flushing || !enabled || !endpoint) return;
    let line: string;
    try {
      line = `${JSON.stringify(request)}\n`;
    } catch {
      return;
    }

    const queued: QueuedRequest = { line, sequence };
    if (state) queuedState = queued;
    else queuedSessions.push(queued);
    drain();
    return queued;
  };

  // Shutdown drops stale session history and waits only for the final state.
  // Cancelling the active attempt prevents a stalled history request from
  // delaying the final idle report; each final attempt is independently timed.
  const flush = async (finalRequest?: QueuedRequest) => {
    if (disposed || flushing || !enabled || !endpoint) return;
    flushing = true;
    const finalState = finalRequest ?? queuedState;
    queuedState = undefined;
    queuedSessions.length = 0;
    const keepActiveFinal = activeRequest === finalState;
    const generation = keepActiveFinal ? drainGeneration : ++drainGeneration;
    if (!keepActiveFinal) cancelInFlight?.();

    try {
      await drainPromise;
      if (!disposed && finalState && !keepActiveFinal) {
        await sendRequest(finalState.line, generation);
      }
    } catch {
      // Shutdown must remain best-effort if the socket fails unexpectedly.
    } finally {
      flushing = false;
      if (
        !disposed &&
        generation === drainGeneration &&
        (queuedSessions.length > 0 || queuedState)
      ) {
        drain();
      }
    }
  };

  return {
    enqueueState(request: WireRequest, sequence: number) {
      return enqueue(request, true, sequence);
    },
    enqueueSession(request: WireRequest, sequence: number) {
      return enqueue(request, false, sequence);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      drainGeneration += 1;
      queuedState = undefined;
      queuedSessions.length = 0;
      activeRequest = undefined;
      cancelInFlight?.();
      cancelInFlight = undefined;
    },
  };
}

function withSessionReference(
  params: Record<string, unknown>,
  sessionReference: SessionReference,
) {
  return sessionReference ? { ...params, ...sessionReference } : params;
}

export default function herdrPipi(pi: ExtensionAPI) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  const enabled =
    process.env.HERDR_ENV === "1" && Boolean(socketPath) && Boolean(paneId);
  const socketEndpoint =
    process.platform === "win32" && socketPath
      ? `\\\\.\\pipe\\${socketPath}`
      : socketPath;
  let warnUnsupported = () => {};
  let warnedUnsupported = false;
  const queue = createRequestQueue(socketEndpoint, enabled, () => {
    if (warnedUnsupported) return;
    warnedUnsupported = true;
    warnUnsupported();
  });

  let activityStore: ActivityStore | undefined;
  let sessionReference: SessionReference;
  let rootSession = false;
  let rootWorking = false;
  let backgroundIds: readonly string[] = [];
  let uiPromptDepth = 0;
  let uiPromptMessage: string | undefined;
  let legacyBlockedCount = 0;
  let legacyBlockedMessage: string | undefined;
  let reportSeq = Date.now() * 1_000;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;

  const nextReportSeq = () => {
    reportSeq += 1;
    return reportSeq;
  };

  const desiredState = () => {
    if (uiPromptDepth > 0 || legacyBlockedCount > 0) {
      return {
        state: "blocked" as const,
        message: legacyBlockedMessage ?? uiPromptMessage,
      };
    }
    if (rootWorking || backgroundIds.length > 0) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  };

  const publishState = (force = false) => {
    if (!rootSession || !enabled || !paneId) return;
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    const sequence = nextReportSeq();
    const params = withSessionReference(
      {
        pane_id: paneId,
        source: HERDR_SOURCE,
        agent: HERDR_AGENT,
        state: next.state,
        ...(next.message !== undefined ? { message: next.message } : {}),
        seq: sequence,
      },
      sessionReference,
    );
    return queue.enqueueState(
      {
        id: `${HERDR_SOURCE}:${randomUUID()}`,
        method: "pane.report_agent",
        params,
      },
      sequence,
    );
  };

  const publishSession = (sessionStartSource?: string) => {
    if (!rootSession || !enabled || !paneId || !sessionReference) return;
    const sequence = nextReportSeq();
    const params = withSessionReference(
      {
        pane_id: paneId,
        source: HERDR_SOURCE,
        agent: HERDR_AGENT,
        seq: sequence,
        ...(sessionStartSource !== undefined
          ? { session_start_source: sessionStartSource }
          : {}),
      },
      sessionReference,
    );
    queue.enqueueSession(
      {
        id: `${HERDR_SOURCE}:session:${randomUUID()}`,
        method: "pane.report_agent_session",
        params,
      },
      sequence,
    );
  };

  const resetLocalState = () => {
    rootWorking = false;
    backgroundIds = [];
    uiPromptDepth = 0;
    uiPromptMessage = undefined;
    legacyBlockedCount = 0;
    legacyBlockedMessage = undefined;
    lastState = undefined;
    lastMessage = undefined;
  };

  const stopLegacyBlockedListener = pi.events.on(
    HERDR_ACTIVITY_BLOCKED_EVENT,
    (value) => {
      if (!rootSession) return;
      const blocked = parseLegacyBlockedEvent(value);
      if (!blocked) return;

      if (blocked.active) {
        legacyBlockedCount += 1;
        legacyBlockedMessage = blocked.label;
      } else {
        legacyBlockedCount = Math.max(0, legacyBlockedCount - 1);
        if (legacyBlockedCount === 0) legacyBlockedMessage = undefined;
      }
      publishState();
    },
  );

  pi.on("session_start", (event, ctx) => {
    rootSession = false;
    activityStore?.dispose();
    activityStore = undefined;
    resetLocalState();
    sessionReference = undefined;

    // Only a real interactive TUI has a Herdr pane to update. In particular,
    // RPC reports hasUI=true but is still headless from Herdr's perspective.
    if (!enabled || ctx.mode !== "tui" || !paneId) return;

    rootSession = true;
    warnUnsupported = () =>
      ctx.ui.notify(
        "This Herdr server does not preserve the Pipi launcher when restoring sessions. Activity reporting remains enabled.",
        "warning",
      );
    // Establish identity and root activity before installing the replaying
    // consumer. Its queued replay can notify synchronously in a later turn.
    sessionReference = snapshotSessionReference(ctx);
    rootWorking = ctx.isIdle() === false;
    // Establish the session at Herdr before publishing initial or replayed
    // state reports.
    publishSession(event.reason);
    publishState(true);
    activityStore = createActivityStore(pi.events, (ids) => {
      if (!rootSession) return;
      backgroundIds = [...ids];
      publishState();
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    sessionReference = snapshotSessionReference(ctx);
    publishSession();
    rootWorking = true;
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || !ctx.isIdle()) return;
    rootWorking = false;
    publishState();
  });

  pi.on("ui_prompt_start", (event) => {
    if (!rootSession) return;
    if (uiPromptDepth === 0) uiPromptMessage = event.title;
    uiPromptDepth += 1;
    publishState();
  });

  pi.on("ui_prompt_end", () => {
    if (!rootSession) return;
    uiPromptDepth = Math.max(0, uiPromptDepth - 1);
    if (uiPromptDepth === 0) uiPromptMessage = undefined;
    publishState();
  });

  pi.on("session_shutdown", async () => {
    stopLegacyBlockedListener();
    activityStore?.dispose();
    activityStore = undefined;

    if (rootSession) {
      // Clear all live activity before constructing the final report, while
      // keeping the session identity for that report.
      resetLocalState();
      const finalState = publishState(true);
      // Prevent any late bus activity from publishing into the closing
      // session while the bounded flush is in progress.
      rootSession = false;
      await queue.flush(finalState);
    }

    queue.dispose();
    sessionReference = undefined;
  });
}
