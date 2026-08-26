import { randomUUID } from "node:crypto";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  AUDIT_SYNTHESIS_REPORT_SCHEMA,
  auditTrackReportSchema,
} from "./audit-segment.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  pipelineRootToolPolicy,
  planPipelineChildToolPolicy,
  planPipelineRootToolPolicy,
  readOnlyPipelineChildToolPolicy,
  readOnlyPipelineRootToolPolicy,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  smallFeatureImplementerToolPolicy,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import {
  AUDIT_PIPELINE_ID,
  AUDIT_SYNTHESIS_ROLE,
  LUNA_MODEL,
  PIPELINE_4_LUNA_AUDIT_ROLES,
  PLAN_PIPELINE_ID,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_ID,
  type PipelineDefinitionId,
  type PipelineLunaAuditRole,
} from "./domain.ts";
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
  readonly auditSubmit?: (
    runId: string,
    role: string,
    sessionToken: string,
    value: unknown,
  ) => void;
  readonly auditSessionCreated?: (
    runId: string,
    role: string,
    token: string,
  ) => void;
  readonly auditToolAllowed?: (runId: string, role: string) => boolean;
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

export function pipelineThinkingLevel(model: string) {
  return model === LUNA_MODEL ? "medium" : "high";
}

function auditSubmissionRole(role: string) {
  if (role === AUDIT_SYNTHESIS_ROLE) return role;
  return PIPELINE_4_LUNA_AUDIT_ROLES.find((candidate) => candidate === role);
}

export function createPipelineAuditSubmitTool(
  role: typeof AUDIT_SYNTHESIS_ROLE | PipelineLunaAuditRole,
  submit: (value: unknown) => void,
) {
  return defineTool({
    name: "pipeline_audit_submit",
    label: "Submit Audit Report",
    description:
      "Submit the complete validated audit report to the host and stop this turn.",
    parameters:
      role === AUDIT_SYNTHESIS_ROLE
        ? AUDIT_SYNTHESIS_REPORT_SCHEMA
        : auditTrackReportSchema(role),
    async execute(_toolCallId, params) {
      submit(params);
      return {
        content: [
          {
            type: "text",
            text: "Audit report recorded. Stop this turn.",
          },
        ],
        details: params,
        terminate: true,
      };
    },
  });
}

export function pipelineSessionToolPolicy(
  definition: PipelineDefinitionId,
  isRoot: boolean,
  role: string,
) {
  if (isRoot) {
    if (definition === AUDIT_PIPELINE_ID)
      return readOnlyPipelineChildToolPolicy();
    if (definition === PLAN_PIPELINE_ID) return planPipelineRootToolPolicy();
    if (definition === SMALL_FEATURE_PIPELINE_ID) {
      return readOnlyPipelineRootToolPolicy();
    }
    return pipelineRootToolPolicy();
  }
  if (
    role === AUDIT_SYNTHESIS_ROLE ||
    PIPELINE_4_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role)
  ) {
    return readOnlyPipelineChildToolPolicy();
  }
  if (definition === PLAN_PIPELINE_ID) return planPipelineChildToolPolicy();
  if (definition === SMALL_FEATURE_PIPELINE_ID) {
    return role === SMALL_FEATURE_IMPLEMENTER_ROLE
      ? smallFeatureImplementerToolPolicy()
      : readOnlyPipelineChildToolPolicy();
  }
  return childToolPolicy();
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
      const submissionRole = auditSubmissionRole(spec.role);
      const auditToolAllowed =
        submissionRole &&
        options.auditSubmit &&
        options.auditToolAllowed?.(spec.scopeId ?? "", spec.role);
      const auditSessionToken = auditToolAllowed ? randomUUID() : undefined;
      if (auditSessionToken)
        options.auditSessionCreated?.(
          spec.scopeId ?? "",
          spec.role,
          auditSessionToken,
        );
      const auditTool =
        auditToolAllowed && auditSessionToken && submissionRole
          ? createPipelineAuditSubmitTool(submissionRole, (value) =>
              options.auditSubmit!(
                spec.scopeId ?? "",
                spec.role,
                auditSessionToken,
                value,
              ),
            )
          : undefined;
      const customTools =
        isRoot && definition !== AUDIT_PIPELINE_ID
          ? options.rootTools(spec.scopeId ?? "")
          : undefined;
      const sessionTools = [
        ...(customTools ?? []),
        ...(auditTool ? [auditTool] : []),
      ];
      const { session } = await createAgentSession({
        cwd: spec.cwd,
        model,
        thinkingLevel: pipelineThinkingLevel(spec.model),
        sessionManager: SessionManager.create(spec.cwd),
        settingsManager: resources.settingsManager,
        resourceLoader: resources.loader,
        ...(sessionTools.length > 0 ? { customTools: sessionTools } : {}),
        ...pipelineSessionToolPolicy(definition, isRoot, spec.role),
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
