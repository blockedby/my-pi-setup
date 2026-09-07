import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const CHILD_TOOL_CALL_TIMEOUT_MS = 3 * 60 * 1_000;

interface ToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

function formatTimeout(timeoutMs: number) {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (timeoutMs % 1_000 === 0) {
    const seconds = timeoutMs / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${timeoutMs} ms`;
}

export class ToolCallTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool call "${toolName}" timed out after ${formatTimeout(timeoutMs)}.`,
    );
    this.name = "ToolCallTimeoutError";
  }
}

type ToolCallTimeoutPolicy = (toolName: string) => number | null | undefined;

function abortError(toolName: string, signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`Tool call "${toolName}" was aborted.`);
}

export async function runWithToolCallTimeout<T>(
  toolName: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
) {
  if (signal?.aborted) throw abortError(toolName, signal);

  const timeoutController = new AbortController();
  const executionSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  let removeAbortListener: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(abortError(toolName, signal));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      })
    : undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let timeout: Promise<never> | undefined;
    if (timeoutMs !== undefined) {
      const timeoutError = new ToolCallTimeoutError(toolName, timeoutMs);
      timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError);
          timeoutController.abort(timeoutError);
        }, timeoutMs);
      });
    }

    const execution = execute(executionSignal);
    if (!timeout) {
      return aborted
        ? await Promise.race([execution, aborted])
        : await execution;
    }
    return aborted
      ? await Promise.race([execution, timeout, aborted])
      : await Promise.race([execution, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    removeAbortListener?.();
  }
}

/**
 * Wrap every currently registered child tool with an independent execution
 * timeout. Calling apply() again is safe and picks up tools registered later.
 * A policy result of null explicitly disables the timeout; undefined keeps the
 * guard default.
 */
export function createToolCallTimeoutGuard(
  timeoutMs = CHILD_TOOL_CALL_TIMEOUT_MS,
  timeoutPolicy?: ToolCallTimeoutPolicy,
) {
  const wrapped = new WeakSet<ToolDefinition>();

  const wrap = (definition: ToolDefinition) => {
    if (wrapped.has(definition)) return;
    wrapped.add(definition);

    const execute = definition.execute;
    const policyTimeoutMs = timeoutPolicy?.(definition.name);
    const effectiveTimeoutMs =
      policyTimeoutMs === null ? undefined : (policyTimeoutMs ?? timeoutMs);
    definition.execute = async (toolCallId, params, signal, onUpdate, ctx) =>
      runWithToolCallTimeout(
        definition.name,
        effectiveTimeoutMs,
        signal,
        (signal) =>
          execute.call(definition, toolCallId, params, signal, onUpdate, ctx),
      );
  };

  return {
    apply(session: ToolRegistry) {
      for (const { name } of session.getAllTools()) {
        const definition = session.getToolDefinition(name);
        if (definition) wrap(definition);
      }
    },
  };
}
