import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";

export const RESPONSE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function guardResponseStream(
  start: (signal: AbortSignal) => AssistantMessageEventStream,
  model: Model<Api>,
  signal?: AbortSignal,
  idleMs = RESPONSE_IDLE_TIMEOUT_MS,
) {
  const output = createAssistantMessageEventStream();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const fail = (aborted: boolean, detail: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    // Failed partial tool calls must never become executable or retry context.
    const error: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: aborted ? "aborted" : "error",
      errorMessage: detail,
      timestamp: Date.now(),
    };
    output.push({
      type: "error",
      reason: error.stopReason === "aborted" ? "aborted" : "error",
      error,
    });
    output.end();
  };
  const cancel = () => fail(true, "Request was aborted");
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        fail(
          false,
          `Model response idle timeout after ${idleMs}ms without stream events. Retrying uses the session retry policy.`,
        ),
      idleMs,
    );
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  else {
    arm();
    void (async () => {
      try {
        for await (const event of start(controller.signal)) {
          if (finished) return;
          if (event.type === "done" || event.type === "error") {
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            output.push(event);
            output.end();
            return;
          }
          arm();
          output.push(event);
        }
        if (!finished)
          fail(false, "Model stream ended without a terminal response event");
      } catch (error) {
        fail(
          signal?.aborted === true,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  }
  return output;
}

export function guardProvider(
  provider: Provider,
  idleMs = RESPONSE_IDLE_TIMEOUT_MS,
): Provider {
  return {
    ...provider,
    stream: (model, context, options) =>
      guardResponseStream(
        (signal) =>
          provider.stream(
            model,
            context,
            Object.assign({}, options, { signal }),
          ),
        model,
        options?.signal,
        idleMs,
      ),
    streamSimple: (model, context, options) =>
      guardResponseStream(
        (signal) =>
          provider.streamSimple(model, context, { ...options, signal }),
        model,
        options?.signal,
        idleMs,
      ),
  };
}
