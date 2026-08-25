import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  pipelineRootToolPolicy,
  planPipelineChildToolPolicy,
  planPipelineRootToolPolicy,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import { PLAN_PIPELINE_ID, type PipelineDefinitionId } from "./domain.ts";
import type {
  AgentNodeSpec,
  AgentTreeSessionEvent,
  AgentTreeSessionFactory,
} from "../shared/agent-tree/domain.ts";

const INTERRUPT_TIMEOUT_MS = 5_000;

interface PipelineSessionFactoryOptions {
  readonly modelRegistry: Pick<ModelRegistry, "find">;
  readonly parentCwd: string;
  readonly parentTrusted: boolean;
  readonly rootTools: (runId: string) => ReadonlyArray<ToolDefinition>;
  readonly definitionForRun: (runId: string) => PipelineDefinitionId;
}

function textContent(message: Message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function assistantContent(message: AssistantMessage) {
  return {
    text: message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    thinking: message.content
      .flatMap((part) =>
        part.type === "thinking" && !part.redacted ? [part.thinking] : [],
      )
      .join("\n"),
  };
}

async function waitForInterrupt(operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), INTERRUPT_TIMEOUT_MS);
    timer.unref?.();
  });
  const completed = operation.then(
    () => true as const,
    () => true as const,
  );
  const result = await Promise.race([completed, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 64 * 1024);
  } catch {
    return "[unserializable tool arguments]";
  }
}

function resultPreview(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const content = Reflect.get(result, "content");
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        Reflect.get(part, "type") === "text" &&
        typeof Reflect.get(part, "text") === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function lastAssistant(session: AgentSession) {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message.role === "assistant") return message;
  }
  return undefined;
}

function finalText(session: AgentSession) {
  const message = lastAssistant(session);
  return message ? assistantContent(message).text.trim() : "";
}

function normalizeEvent(
  session: AgentSession,
  event: AgentSessionEvent,
): AgentTreeSessionEvent | undefined {
  if (event.type === "agent_start") return { type: "run_started" };
  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      return {
        type: "assistant_delta",
        kind: "text",
        delta: event.assistantMessageEvent.delta,
      };
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      return {
        type: "assistant_delta",
        kind: "thinking",
        delta: event.assistantMessageEvent.delta,
      };
    }
    return undefined;
  }
  if (event.type === "message_end") {
    if (event.message.role === "user") {
      return { type: "user", text: textContent(event.message) };
    }
    if (event.message.role === "assistant") {
      return { type: "assistant", ...assistantContent(event.message) };
    }
    return undefined;
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool",
      phase: "call",
      toolCallId: event.toolCallId,
      name: event.toolName,
      text: safeJson(event.args),
      isError: false,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool",
      phase: "result",
      toolCallId: event.toolCallId,
      name: event.toolName,
      text: resultPreview(event.result),
      isError: event.isError,
    };
  }
  if (event.type !== "agent_settled") return undefined;
  const last = lastAssistant(session);
  const output = finalText(session);
  if (last?.stopReason === "aborted") {
    return {
      type: "settled",
      outcome: { type: "cancelled", finalText: output },
    };
  }
  if (last?.stopReason === "error") {
    return {
      type: "settled",
      outcome: {
        type: "failed",
        error: last.errorMessage ?? "Pipeline agent run failed.",
        finalText: output,
      },
    };
  }
  return {
    type: "settled",
    outcome: { type: "completed", finalText: output },
  };
}

export function createPipelineSessionFactory(
  options: PipelineSessionFactoryOptions,
): AgentTreeSessionFactory {
  return {
    async create(spec: AgentNodeSpec) {
      const [provider, ...idParts] = spec.model.split("/");
      const model = options.modelRegistry.find(provider, idParts.join("/"));
      if (!model)
        throw new Error(
          `Required pipeline model is unavailable: ${spec.model}`,
        );
      const resources = await createChildResources({
        cwd: spec.cwd,
        projectTrusted: resolveStandaloneChildProjectTrust({
          parentCwd: options.parentCwd,
          childCwd: spec.cwd,
          parentTrusted: options.parentTrusted,
        }),
      });
      const isRoot = !spec.parentId;
      const definition = options.definitionForRun(spec.scopeId ?? "");
      const isPlan = definition === PLAN_PIPELINE_ID;
      const customTools = isRoot
        ? options.rootTools(spec.scopeId ?? "")
        : undefined;
      const { session } = await createAgentSession({
        cwd: spec.cwd,
        model,
        thinkingLevel: isRoot
          ? "high"
          : spec.model.includes("terra")
            ? "high"
            : "medium",
        sessionManager: SessionManager.create(spec.cwd),
        settingsManager: resources.settingsManager,
        resourceLoader: resources.loader,
        ...(customTools ? { customTools: [...customTools] } : {}),
        ...(isRoot
          ? isPlan
            ? planPipelineRootToolPolicy()
            : pipelineRootToolPolicy()
          : isPlan
            ? planPipelineChildToolPolicy()
            : childToolPolicy()),
      });
      try {
        await bindChildSessionExtensions(session);
      } catch (error) {
        await shutdownAndDisposeChildSession(session);
        throw error;
      }

      const guard = createToolCallTimeoutGuard();
      guard.apply(session);
      const guardSubscription = session.subscribe((event) => {
        if (event.type === "agent_start") guard.apply(session);
      });
      let disposed = false;

      return {
        get sessionFile() {
          return session.sessionFile;
        },
        get activeTools() {
          return session.getActiveToolNames();
        },
        get isStreaming() {
          return session.isStreaming;
        },
        subscribe(listener) {
          return session.subscribe((event) => {
            const normalized = normalizeEvent(session, event);
            if (normalized) listener(normalized);
          });
        },
        prompt(text) {
          return session.prompt(text);
        },
        send(text) {
          return session.isStreaming
            ? session.steer(text)
            : session.prompt(text);
        },
        async interrupt() {
          if (disposed) return;
          try {
            session.clearQueue();
          } catch {
            // Abort remains authoritative.
          }
          const stopped = await waitForInterrupt(session.abort());
          if (!stopped) {
            disposed = true;
            guardSubscription();
            await shutdownAndDisposeChildSession(session);
          }
        },
        async dispose() {
          if (disposed) return;
          disposed = true;
          guardSubscription();
          await shutdownAndDisposeChildSession(session);
        },
      };
    },
  };
}
