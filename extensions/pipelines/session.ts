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
import { Type, type TSchema } from "typebox";
import {
  AUDIT_SYNTHESIS_REPORT_SCHEMA,
  auditTrackReportSchema,
} from "./audit-segment.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  executorAuditToolPolicy,
  featureIsolatedImplementerToolPolicy,
  githubDiscoveryToolPolicy,
  pipelineRootToolPolicy,
  planPipelineChildToolPolicy,
  planPipelineExternalEvidenceToolPolicy,
  planPipelineRootToolPolicy,
  planPipelineSynthesisToolPolicy,
  readOnlyPipelineChildToolPolicy,
  readOnlyPipelineRootToolPolicy,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  smallFeatureImplementerToolPolicy,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import {
  AUDIT_PIPELINE_ID,
  AUDIT_SEGMENT_LUNA_ROLES,
  AUDIT_SYNTHESIS_ROLE,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_FINALIZER_ROLE,
  FEATURE_PLAN_ROLES,
  FEATURE_PIPELINE_ID,
  LUNA_MODEL,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  PLAN_PIPELINE_ID,
  PLAN_PIPELINE_SYNTHESIS_ROLE,
  type PlanPipelineDiscoveryRole,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_ID,
  type FeaturePipelineDiscoveryRole,
  type PipelineDefinitionId,
  type PipelineLunaAuditRole,
} from "./domain.ts";
import {
  FEATURE_CANDIDATE_PLAN_SUBMISSION,
  FEATURE_CANONICAL_PLAN_SUBMISSION,
  FEATURE_EXECUTION_GRAPH_SUBMISSION,
} from "./feature-planning.ts";
import type { FeatureTaskToolHost } from "./feature-runtime.ts";
import { featureDiscoveryReportSchema } from "./discovery-report.ts";
import { planDiscoveryReportSchema } from "./plan-discovery-report.ts";
import {
  FEATURE_DISCOVERY_SYNTHESIS_ROLE,
  FEATURE_DISCOVERY_SYNTHESIS_SCHEMA,
} from "./feature-best-of-three.ts";
import { createFeatureToolBoundary } from "./feature-sandbox.ts";
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
  readonly agentDir?: string;
  readonly sessionManager?: (cwd: string) => SessionManager;
  readonly sessionCreated?: (session: AgentSession) => void;
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
  readonly discoverySubmit?: (
    runId: string,
    role: string,
    sessionToken: string,
    value: unknown,
  ) => void;
  readonly discoverySessionCreated?: (
    runId: string,
    role: string,
    token: string,
  ) => void;
  readonly discoveryToolAllowed?: (runId: string, role: string) => boolean;
  /** Phase-bound host authority for dynamic feature tasks and final Sol review. */
  readonly featureTaskHost?: (
    runId: string,
    role: string,
  ) => FeatureTaskToolHost | undefined;
  /** Controller-owned, session-bound cooperative partial settlement. */
  readonly executionFinish?: (
    runId: string,
    role: string,
    sessionToken: string,
    value: unknown,
  ) => void;
  readonly executionFinishSessionCreated?: (
    runId: string,
    role: string,
    token: string,
    sessionId: string,
  ) => void;
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

export function pipelineThinkingLevel(
  model: string,
  requested?: AgentNodeSpec["thinkingLevel"],
) {
  return requested ?? (model === LUNA_MODEL ? "medium" : "high");
}

function planDiscoveryRole(role: string) {
  return PLAN_PIPELINE_DISCOVERY_ROLES.find((candidate) => candidate === role);
}

function withoutWebTools(excludeTools: ReadonlyArray<string>) {
  return {
    excludeTools: [...excludeTools, "web_search_codex", "web_fetch_codex"],
  };
}

function auditSubmissionRole(role: string) {
  if (role === AUDIT_SYNTHESIS_ROLE) return role;
  return AUDIT_SEGMENT_LUNA_ROLES.find((candidate) => candidate === role);
}

function createTerminatingSubmissionTool(options: {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly acceptedText: string;
  readonly submit: (value: unknown) => void;
}) {
  return defineTool({
    name: options.name,
    label: options.label,
    description: options.description,
    parameters: options.parameters,
    async execute(_toolCallId, params) {
      options.submit(params);
      return {
        content: [{ type: "text", text: options.acceptedText }],
        details: params,
        terminate: true,
      };
    },
  });
}

export function createPipelineDiscoverySubmitTool(
  role: FeaturePipelineDiscoveryRole,
  submit: (value: unknown) => void,
) {
  return createTerminatingSubmissionTool({
    name: "pipeline_discovery_submit",
    label: "Submit Discovery Report",
    description:
      "Submit this role's complete feature discovery V2 report to the host and stop this turn.",
    parameters: featureDiscoveryReportSchema(role),
    acceptedText: "Discovery report recorded. Stop this turn.",
    submit,
  });
}

export function createPipelinePlanSubmitTool(submit: (value: unknown) => void) {
  return createTerminatingSubmissionTool({
    name: "pipeline_plan_submit",
    label: "Submit Plan",
    description:
      "Submit the complete free-form Markdown implementation plan to the controller and stop this turn.",
    parameters: Type.Object(
      {
        plan: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
      },
      { additionalProperties: false },
    ),
    acceptedText: "Plan recorded. Stop this turn.",
    submit,
  });
}

export function createPipelinePlanDiscoverySubmitTool(
  role: PlanPipelineDiscoveryRole,
  submit: (value: unknown) => void,
) {
  return createTerminatingSubmissionTool({
    name: "pipeline_plan_discovery_submit",
    label: "Submit Plan Discovery Report",
    description:
      "Submit this role's complete strict planning evidence report to the controller and stop this turn.",
    parameters: planDiscoveryReportSchema(role),
    acceptedText: "Plan discovery report recorded. Stop this turn.",
    submit,
  });
}

export function createPipelineDiscoverySynthesisSubmitTool(
  submit: (value: unknown) => void,
) {
  return createTerminatingSubmissionTool({
    name: "pipeline_discovery_synthesis_submit",
    label: "Submit Discovery Synthesis",
    description:
      "Submit the complete feature discovery synthesis report to the host and stop this turn.",
    parameters: FEATURE_DISCOVERY_SYNTHESIS_SCHEMA,
    acceptedText: "Discovery synthesis recorded. Stop this turn.",
    submit,
  });
}

function createFeatureArtifactSubmitTool(
  contract:
    | typeof FEATURE_CANDIDATE_PLAN_SUBMISSION
    | typeof FEATURE_CANONICAL_PLAN_SUBMISSION
    | typeof FEATURE_EXECUTION_GRAPH_SUBMISSION,
  submit: (value: unknown) => void,
) {
  return createTerminatingSubmissionTool({
    name: contract.name,
    label: "Submit Feature Planning Artifact",
    description: contract.description,
    parameters: contract.parameters,
    acceptedText: "Feature planning artifact recorded. Stop this turn.",
    submit,
  });
}

export function createFeatureTaskHostTools(host: FeatureTaskToolHost) {
  return [
    defineTool({
      name: "pipeline_task_diff",
      label: "Inspect Feature Task Diff",
      description:
        "Inspect the current task or final-review diff and Git state. Each response contains a bounded page; use its nextOffset and fingerprint to read subsequent pages of the same diff until nextOffset is absent.",
      parameters: Type.Object(
        {
          offset: Type.Optional(
            Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
          ),
          fingerprint: Type.Optional(
            Type.String({ pattern: "^[0-9a-f]{64}$" }),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const details = await host.diff(params);
        return {
          content: [{ type: "text", text: safeJson(details) }],
          details,
        };
      },
    }),
    defineTool({
      name: "pipeline_task_check",
      label: "Run Feature Task Check",
      description:
        "Run one declared check by its exact ID in the controller-selected worktree and validated relative cwd.",
      parameters: Type.Object(
        { checkId: Type.String({ minLength: 1, maxLength: 256 }) },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const details = await host.check({ checkId: params.checkId });
        return {
          content: [{ type: "text", text: safeJson(details) }],
          details,
        };
      },
    }),
    defineTool({
      name: "pipeline_task_finalize",
      label: "Finalize Feature Task",
      description:
        "Ask the controller to create or amend this task's one logical commit, run all required checks, and validate either the commit or an explicit no-change result.",
      parameters: Type.Object(
        {
          commitPaths: Type.Array(
            Type.String({ minLength: 1, maxLength: 4 * 1024 }),
            { maxItems: 512 },
          ),
          summary: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const details = await host.finalize(params);
        return {
          content: [{ type: "text", text: safeJson(details) }],
          details,
          terminate: details.validated,
        };
      },
    }),
  ];
}

export const PIPELINE_EXECUTION_FINISH_PARAMETERS = Type.Object(
  {
    summary: Type.Optional(Type.String({ minLength: 1, maxLength: 8 * 1024 })),
    output: Type.Optional(Type.String({ minLength: 1, maxLength: 32 * 1024 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export function createPipelineExecutionFinishTool(
  finish: (value: unknown) => void,
) {
  return createTerminatingSubmissionTool({
    name: "pipeline_execution_finish",
    label: "Finish Pipeline Execution",
    description:
      "Record bounded cooperative partial output for the controller before this session stops. This is provenance only and cannot complete, report, retry, replace, or advance a pipeline.",
    parameters: PIPELINE_EXECUTION_FINISH_PARAMETERS,
    acceptedText: "Bounded partial output recorded. Stop this turn.",
    submit: finish,
  });
}

export function createPipelineAuditSubmitTool(
  role: typeof AUDIT_SYNTHESIS_ROLE | PipelineLunaAuditRole,
  submit: (value: unknown) => void,
) {
  return createTerminatingSubmissionTool({
    name: "pipeline_audit_submit",
    label: "Submit Audit Report",
    description:
      "Submit the complete validated audit report to the host and stop this turn.",
    parameters:
      role === AUDIT_SYNTHESIS_ROLE
        ? AUDIT_SYNTHESIS_REPORT_SCHEMA
        : auditTrackReportSchema(role),
    acceptedText: "Audit report recorded. Stop this turn.",
    submit,
  });
}

export function pipelineSessionToolPolicy(
  definition: PipelineDefinitionId,
  isRoot: boolean,
  role: string,
) {
  if (
    FEATURE_PLAN_ROLES.some((candidate) => candidate === role) ||
    role === FEATURE_FINALIZER_ROLE
  ) {
    // Active tool selection and the read-only sandbox phase remove mutation;
    // this policy keeps the sandboxed bash tool available for repository reads.
    return featureIsolatedImplementerToolPolicy();
  }
  if (
    role.startsWith("feature-task-") ||
    role.startsWith("feature-conflict-") ||
    role.startsWith("feature-join-repair-")
  ) {
    return featureIsolatedImplementerToolPolicy();
  }
  if (isRoot) {
    if (definition === AUDIT_PIPELINE_ID)
      return readOnlyPipelineChildToolPolicy();
    if (definition === PLAN_PIPELINE_ID) {
      return role === PLAN_PIPELINE_SYNTHESIS_ROLE
        ? planPipelineSynthesisToolPolicy()
        : planPipelineRootToolPolicy();
    }
    if (definition === SMALL_FEATURE_PIPELINE_ID) {
      return readOnlyPipelineRootToolPolicy();
    }
    return pipelineRootToolPolicy();
  }
  if (role === EXECUTOR_AUDIT_ROLE) return executorAuditToolPolicy();
  if (
    role === AUDIT_SYNTHESIS_ROLE ||
    AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)
  ) {
    return readOnlyPipelineChildToolPolicy();
  }
  if (definition === FEATURE_PIPELINE_ID && role === "discover-problem") {
    return githubDiscoveryToolPolicy();
  }
  if (
    definition === PLAN_PIPELINE_ID &&
    role === "discover-requirements-boundaries"
  ) {
    return withoutWebTools(githubDiscoveryToolPolicy().excludeTools);
  }
  if (
    definition === PLAN_PIPELINE_ID &&
    role === "discover-external-evidence"
  ) {
    return planPipelineExternalEvidenceToolPolicy();
  }
  if (
    definition === FEATURE_PIPELINE_ID &&
    FEATURE_PIPELINE_DISCOVERY_ROLES.some(
      (discoveryRole) => discoveryRole === role,
    )
  ) {
    return readOnlyPipelineChildToolPolicy();
  }
  if (definition === PLAN_PIPELINE_ID) {
    return withoutWebTools(planPipelineChildToolPolicy().excludeTools);
  }
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
        ...(options.agentDir ? { agentDir: options.agentDir } : {}),
      });
      const isRoot = !spec.parentId;
      const definition = options.definitionForRun(spec.scopeId ?? "");
      const featurePlanRole = FEATURE_PLAN_ROLES.find(
        (role) => role === spec.role,
      );
      const isFeatureFinalizer = spec.role === FEATURE_FINALIZER_ROLE;
      const featureTaskHost = options.featureTaskHost?.(
        spec.scopeId ?? "",
        spec.role,
      );
      const featureBoundary =
        definition === FEATURE_PIPELINE_ID &&
        (featurePlanRole || isFeatureFinalizer || featureTaskHost)
          ? createFeatureToolBoundary({
              cwd: spec.cwd,
              mode:
                isFeatureFinalizer || featurePlanRole
                  ? "selection"
                  : "candidate",
            })
          : undefined;
      const submissionRole = auditSubmissionRole(spec.role);
      const discoveryRole = FEATURE_PIPELINE_DISCOVERY_ROLES.find(
        (candidate) => candidate === spec.role,
      );
      const planRole = planDiscoveryRole(spec.role);
      const isPlanSynthesis =
        definition === PLAN_PIPELINE_ID &&
        isRoot &&
        spec.role === PLAN_PIPELINE_SYNTHESIS_ROLE;
      const discoveryToolAllowed =
        (definition === FEATURE_PIPELINE_ID &&
          (discoveryRole || featurePlanRole || isFeatureFinalizer)) ||
        (definition === PLAN_PIPELINE_ID && (planRole || isPlanSynthesis))
          ? Boolean(
              options.discoverySubmit &&
              (featurePlanRole ||
                isFeatureFinalizer ||
                options.discoveryToolAllowed?.(spec.scopeId ?? "", spec.role)),
            )
          : false;
      const discoverySessionToken = discoveryToolAllowed
        ? randomUUID()
        : undefined;
      if (discoverySessionToken)
        options.discoverySessionCreated?.(
          spec.scopeId ?? "",
          spec.role,
          discoverySessionToken,
        );
      const submitDiscoveryValue =
        discoveryToolAllowed && discoverySessionToken
          ? (value: unknown) =>
              options.discoverySubmit!(
                spec.scopeId ?? "",
                spec.role,
                discoverySessionToken,
                value,
              )
          : undefined;
      const discoveryTool =
        submitDiscoveryValue && discoveryRole
          ? createPipelineDiscoverySubmitTool(
              discoveryRole,
              submitDiscoveryValue,
            )
          : submitDiscoveryValue && planRole
            ? createPipelinePlanDiscoverySubmitTool(
                planRole,
                submitDiscoveryValue,
              )
            : submitDiscoveryValue && isPlanSynthesis
              ? createPipelinePlanSubmitTool(submitDiscoveryValue)
              : undefined;
      const featureArtifactTools = submitDiscoveryValue
        ? [
            ...(featurePlanRole
              ? [
                  createFeatureArtifactSubmitTool(
                    FEATURE_CANDIDATE_PLAN_SUBMISSION,
                    submitDiscoveryValue,
                  ),
                ]
              : []),
            ...(isFeatureFinalizer
              ? [
                  createFeatureArtifactSubmitTool(
                    FEATURE_CANONICAL_PLAN_SUBMISSION,
                    submitDiscoveryValue,
                  ),
                  createFeatureArtifactSubmitTool(
                    FEATURE_EXECUTION_GRAPH_SUBMISSION,
                    submitDiscoveryValue,
                  ),
                ]
              : []),
          ]
        : [];
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
      const executionFinishToken = options.executionFinish
        ? randomUUID()
        : undefined;
      if (executionFinishToken)
        options.executionFinishSessionCreated?.(
          spec.scopeId ?? "",
          spec.role,
          executionFinishToken,
          spec.id ?? "",
        );
      const executionFinishTool =
        executionFinishToken && options.executionFinish
          ? createPipelineExecutionFinishTool((value) =>
              options.executionFinish!(
                spec.scopeId ?? "",
                spec.role,
                executionFinishToken,
                value,
              ),
            )
          : undefined;
      const customTools =
        isRoot &&
        spec.role === "pipeline-root" &&
        definition !== AUDIT_PIPELINE_ID
          ? options.rootTools(spec.scopeId ?? "")
          : undefined;
      const featureTaskTools = featureTaskHost
        ? createFeatureTaskHostTools(featureTaskHost)
        : [];
      const sessionTools = [
        ...(customTools ?? []),
        ...(featureBoundary?.tools ?? []),
        ...(discoveryTool ? [discoveryTool] : []),
        ...featureArtifactTools,
        ...featureTaskTools,
        ...(auditTool ? [auditTool] : []),
        ...(executionFinishTool ? [executionFinishTool] : []),
      ];
      const featureActiveTools = isFeatureFinalizer
        ? [
            "read",
            "bash",
            FEATURE_CANONICAL_PLAN_SUBMISSION.name,
            FEATURE_EXECUTION_GRAPH_SUBMISSION.name,
            ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
          ]
        : featurePlanRole
          ? [
              "read",
              "bash",
              FEATURE_CANDIDATE_PLAN_SUBMISSION.name,
              ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
            ]
          : featureTaskHost
            ? [
                "read",
                "bash",
                "edit",
                "write",
                ...featureTaskTools.map(({ name }) => name),
                ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
              ]
            : undefined;
      const planReadTools =
        definition === PLAN_PIPELINE_ID && !isRoot
          ? spec.role === "discover-requirements-boundaries"
            ? [
                "read",
                "fd",
                "rg",
                "bash",
                "pipeline_plan_discovery_submit",
                ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
              ]
            : spec.role === "discover-external-evidence"
              ? [
                  "read",
                  "fd",
                  "rg",
                  "web_search_codex",
                  "web_fetch_codex",
                  "pipeline_plan_discovery_submit",
                  ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
                ]
              : [
                  "read",
                  "fd",
                  "rg",
                  "pipeline_plan_discovery_submit",
                  ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
                ]
          : definition === PLAN_PIPELINE_ID && isPlanSynthesis
            ? [
                "read",
                "fd",
                "rg",
                "pipeline_plan_submit",
                ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
              ]
            : undefined;
      const { session } = await createAgentSession({
        cwd: spec.cwd,
        model,
        thinkingLevel: pipelineThinkingLevel(spec.model, spec.thinkingLevel),
        sessionManager:
          options.sessionManager?.(spec.cwd) ?? SessionManager.create(spec.cwd),
        settingsManager: resources.settingsManager,
        resourceLoader: resources.loader,
        ...(sessionTools.length > 0 ? { customTools: sessionTools } : {}),
        ...(featureBoundary
          ? {
              // Register every phase-bound definition when the persistent
              // session is created. The active set below remains the
              // privilege boundary until enableMutation runs.
              tools: [...new Set(sessionTools.map(({ name }) => name))],
            }
          : planReadTools
            ? { tools: planReadTools }
            : {}),
        ...pipelineSessionToolPolicy(definition, isRoot, spec.role),
      });
      try {
        options.sessionCreated?.(session);
        await bindChildSessionExtensions(session);
        if (featureBoundary) {
          session.setActiveToolsByName(
            featureActiveTools ?? [
              ...featureBoundary.initialActiveTools,
              ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
            ],
          );
        }
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
        enableMutation() {
          if (!featureBoundary || !isFeatureFinalizer) return;
          featureBoundary.enableAugmentation();
          session.setActiveToolsByName([
            "read",
            "bash",
            "edit",
            "write",
            ...featureTaskTools.map(({ name }) => name),
            ...(executionFinishTool ? ["pipeline_execution_finish"] : []),
          ]);
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
