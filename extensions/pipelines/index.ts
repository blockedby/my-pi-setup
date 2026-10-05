import * as fs from "node:fs";
import { serializeRunEvidenceHandoff } from "./run-evidence-handoff.ts";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  PIPELINE_NAME_DESCRIPTION,
  PIPELINE_NAME_MAX_LENGTH,
  PIPELINE_NAME_PATTERN,
} from "./pipeline-identity.ts";
import {
  createPipelineCancellationTool,
  PIPELINE_CANCEL_PARAMETERS,
} from "./cancellation.ts";
import { PipelineController } from "./controller.ts";
import { registerPipelineCommands } from "./commands.ts";
import { showPipelineDashboard } from "./dashboard.ts";
import {
  AUDIT_PIPELINE_ID,
  IMPLEMENTING_PIPELINE_ID,
  PUBLIC_PIPELINE_IDS,
  PIPELINE_DEFINITION_IDS,
  PIPELINE_MODELS,
  assertPipelineGitCommitSupported,
  type PipelineHandoff,
  type PipelineDefinitionId,
} from "./domain.ts";
import {
  parsePipelineWallclockLimit,
  PIPELINE_WALLCLOCK_LIMIT_PATTERN,
} from "./wallclock.ts";

export {
  MAX_PIPELINE_WALLCLOCK_LIMIT_MS,
  MIN_PIPELINE_WALLCLOCK_LIMIT_MS,
  parsePipelineWallclockLimit,
  parseWallclockLimit,
  PIPELINE_WALLCLOCK_WARNING_RATIO,
  PIPELINE_WALLCLOCK_LIMIT_PATTERN,
} from "./wallclock.ts";
import { createPipelineSessionFactory } from "./session.ts";
import {
  createPipelineInspectionTools,
  PIPELINE_CHECK_PARAMETERS,
  PIPELINE_LIST_PARAMETERS,
} from "./inspection.ts";
import { createActivityPublisher } from "../herdr-pipi/activity.ts";

export {
  PIPELINE_CANCEL_PARAMETERS,
  PIPELINE_CHECK_PARAMETERS,
  PIPELINE_LIST_PARAMETERS,
};

const AUDIT_INITIAL_PARAMETERS = Type.Object(
  {
    mode: Type.Literal("initial"),
    acceptance_criteria: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 8 * 1024 }), {
        maxItems: 128,
      }),
    ),
  },
  { additionalProperties: false },
);

const AUDIT_CLOSURE_PARAMETERS = Type.Object(
  {
    mode: Type.Literal("closure"),
    acceptance_criteria: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 8 * 1024 }), {
        maxItems: 128,
      }),
    ),
    prior_blockers: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 256 }),
          closure_condition: Type.String({ minLength: 1, maxLength: 8 * 1024 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
    remediation_diff: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
    touched_invariants: Type.Array(
      Type.String({ minLength: 1, maxLength: 8 * 1024 }),
      { minItems: 1, maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);

const PIPELINE_RUN_COMMON_PROPERTIES = {
  task: Type.String({
    description:
      "Self-contained implementation task or audit scope, with constraints and acceptance criteria. Closure-specific scope belongs in audit.",
    minLength: 1,
    maxLength: 64 * 1024,
  }),
  working_dir: Type.Optional(
    Type.String({
      description:
        "Existing working directory. implementing-pipeline requires the exact root of a dedicated linked Git worktree on its own branch. Audit defaults to the current directory. Environment preparation is caller-owned; no feature graph, bootstrap commands, or network sandbox is required.",
      minLength: 1,
      maxLength: 16 * 1024,
    }),
  ),
  git_commit: Type.Optional(
    Type.Boolean({
      description:
        "Optional ordinary commit permission for the persistent implementer, limited to the supplied worktree/current branch; defaults off. Audit rejects true. Never permits push, delivery merge, history rewrite, deployment, or external-state changes.",
    }),
  ),
  role_models: Type.Optional(
    Type.Object(
      {
        "pipeline-root": Type.Optional(StringEnum(PIPELINE_MODELS)),
        "implement-small-feature": Type.Optional(StringEnum(PIPELINE_MODELS)),
        "audit-feature-outcome": Type.Optional(StringEnum(PIPELINE_MODELS)),
        "audit-logic-invariants": Type.Optional(StringEnum(PIPELINE_MODELS)),
        "audit-functional-correctness": Type.Optional(
          StringEnum(PIPELINE_MODELS),
        ),
        "audit-reliability-regressions": Type.Optional(
          StringEnum(PIPELINE_MODELS),
        ),
        "audit-executor": Type.Optional(StringEnum(PIPELINE_MODELS)),
        "audit-synthesis": Type.Optional(StringEnum(PIPELINE_MODELS)),
      },
      {
        additionalProperties: false,
        description:
          "Explicit per-role models, validated against the actual registry. Sol defaults for implementation/root/synthesis; Luna for exploration/small scoped tasks; Astra rarely. Sessions may adapt with pipeline_model_select without changing role or losing context.",
      },
    ),
  ),
  audit: Type.Optional(
    Type.Union([AUDIT_INITIAL_PARAMETERS, AUDIT_CLOSURE_PARAMETERS], {
      description:
        "Typed initial or closure audit scope for audit-pipeline. No commands or refs are accepted.",
    }),
  ),
  wallclock_limit: Type.Optional(
    Type.String({
      description:
        "Caller-selected canonical integer stage budget in seconds, minutes, or hours; omission disables per-stage timing, and accepted values are 30s through 24h.",
      pattern: PIPELINE_WALLCLOCK_LIMIT_PATTERN,
      maxLength: 32,
    }),
  ),
};

const PIPELINE_NAME_PARAMETER = Type.String({
  description: PIPELINE_NAME_DESCRIPTION,
  minLength: 1,
  maxLength: PIPELINE_NAME_MAX_LENGTH,
  pattern: PIPELINE_NAME_PATTERN,
});

export const PIPELINE_RUN_PARAMETERS = Type.Object(
  {
    pipeline_name: PIPELINE_NAME_PARAMETER,
    pipeline: Type.Optional(StringEnum(PUBLIC_PIPELINE_IDS)),
    ...PIPELINE_RUN_COMMON_PROPERTIES,
  },
  { additionalProperties: false },
);

export function resolvePipelineDefinition(requested?: string) {
  if (requested === undefined) return IMPLEMENTING_PIPELINE_ID;
  const definition = PUBLIC_PIPELINE_IDS.find((id) => id === requested);
  if (!definition)
    throw new Error(
      `Unsupported pipeline definition: ${requested}. Legacy definitions are inspection-only.`,
    );
  return definition;
}

export function resolvePipelineWorkingDir(
  currentDirectory: string,
  requestedDirectory?: string,
) {
  return path.resolve(currentDirectory, requestedDirectory ?? currentDirectory);
}

export function handoffText(handoff: PipelineHandoff) {
  if (handoff.evidenceIncomplete)
    return JSON.stringify({
      runId: handoff.runId,
      status: handoff.status,
      evidence: "incomplete",
      error: handoff.error?.slice(0, 2048),
      detail:
        "Full evidence could not be sealed; no complete artifact index is claimed.",
    });
  if (handoff.evidence) return serializeRunEvidenceHandoff(handoff.evidence);
  const facts = handoff.facts;
  const sections = [
    `Pipeline ${handoff.runId} ${handoff.status}.`,
    `Selected pipeline: ${handoff.definition}`,
    `Working directory: ${facts.workingDir}`,
    ...(handoff.wallclock
      ? [
          `Wallclock: stage ${handoff.wallclock.stage} · elapsed ${handoff.wallclock.stageElapsedMs}ms · remaining ${handoff.wallclock.remainingMs}ms · warning ${handoff.wallclock.warningReached ? "reached" : "not reached"}`,
        ]
      : []),
    ...(facts.planPath ? [`Plan path: ${facts.planPath}`] : []),
    ...(facts.plan !== undefined ? [`Plan:\n${facts.plan}`] : []),
    `Outcome:\n${facts.outcome}`,
    ...(facts.auditReport
      ? [
          `Structured audit report:\n${JSON.stringify(facts.auditReport, null, 2)}`,
        ]
      : []),
    `Changed paths:\n${facts.changedPaths.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Checks and evidence:\n${facts.checks.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Assumptions:\n${facts.assumptions.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Git and commits:\n${facts.git.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Reports:\n${facts.reports.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Unresolved items:\n${facts.unresolvedItems.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    ...(handoff.limitation
      ? [
          `Wallclock limitation: stage ${handoff.limitation.stage} reached its deadline after ${handoff.limitation.elapsedMs}ms.`,
          `Validated progress:\n${handoff.limitation.validatedProgress.map((item) => `- ${item}`).join("\n") || "- none"}`,
          `Bounded cooperative partials:\n${handoff.limitation.partials.map((partial) => `- ${partial.role}: ${[partial.summary, partial.output].filter(Boolean).join(" — ") || "(no output)"}`).join("\n") || "- none"}`,
        ]
      : []),
  ];
  if (handoff.error) sections.push(`Pipeline error:\n${handoff.error}`);
  return sections.join("\n\n");
}

export default function pipelines(pi: ExtensionAPI) {
  let controller: PipelineController | undefined;
  let sessionContext: ExtensionContext | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let activityPublisher: ReturnType<typeof createActivityPublisher> | undefined;

  const updateStatus = () => {
    const runs = controller?.list() ?? [];
    activityPublisher?.update(
      runs
        .filter((run) => run.status === "starting" || run.status === "running")
        .map((run) => run.id),
    );
    const ui = sessionContext?.hasUI ? sessionContext.ui : undefined;
    if (!ui) return;
    if (runs.length === 0) {
      ui.setStatus("pipelines", undefined);
      return;
    }
    const running = runs.filter(
      (run) => run.status === "starting" || run.status === "running",
    ).length;
    const limited = runs.filter((run) => run.status === "limited").length;
    const failed = runs.filter(
      (run) => run.status === "failed" || run.status === "cancelled",
    ).length;
    const done = runs.length - running - failed - limited;
    const parts = [
      running ? ui.theme.fg("warning", `■ ${running} running`) : "",
      done ? ui.theme.fg("success", `■ ${done} done`) : "",
      limited ? ui.theme.fg("warning", `■ ${limited} limited`) : "",
      failed ? ui.theme.fg("error", `■ ${failed} failed`) : "",
      ui.theme.fg("accent", "/pipelines") + ui.theme.fg("dim", " to view"),
    ].filter(Boolean);
    ui.setStatus(
      "pipelines",
      `${ui.theme.fg("muted", "pipelines:")} ${parts.join(ui.theme.fg("dim", " · "))}`,
    );
  };

  const deliver = (handoff: PipelineHandoff) => {
    if (!sessionContext) return;
    pi.sendMessage(
      {
        customType: "pipeline-handoff",
        content: handoffText(handoff),
        display: true,
        details: {
          runId: handoff.runId,
          status: handoff.status,
          definition: handoff.definition,
          workingDir: handoff.facts.workingDir,
          ...(handoff.wallclock ? { wallclock: handoff.wallclock } : {}),
          ...(handoff.limitation ? { limitation: handoff.limitation } : {}),
          ...(handoff.partials ? { partials: handoff.partials } : {}),
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const getController = (ctx: ExtensionContext) => {
    if (controller) return controller;
    let created: PipelineController;
    created = new PipelineController({
      modelAvailable: (name) => {
        const [provider, ...id] = name.split("/");
        return Boolean(ctx.modelRegistry.find(provider, id.join("/")));
      },
      createSessionFactory: (
        rootTools,
        definitionForRun,
        auditSubmit,
        auditSessionCreated,
        auditToolAllowed,
        discoverySubmit,
        discoverySessionCreated,
        discoveryToolAllowed,
        executionFinish,
        executionFinishSessionCreated,
        featureTaskHost,
        artifactTools,
        planningReadinessCheck,
      ) =>
        createPipelineSessionFactory({
          modelRegistry: ctx.modelRegistry,
          parentCwd: ctx.cwd,
          parentTrusted: ctx.isProjectTrusted(),
          rootTools,
          definitionForRun,
          auditSubmit,
          auditSessionCreated,
          auditToolAllowed,
          discoverySubmit,
          discoverySessionCreated,
          discoveryToolAllowed,
          executionFinish,
          executionFinishSessionCreated,
          featureTaskHost,
          artifactTools,
          planningReadinessCheck,
        }),
      onHandoff: deliver,
    });
    controller = created;
    unsubscribeStatus = created.subscribe(updateStatus);
    updateStatus();
    return created;
  };

  pi.on("session_start", (_event, ctx) => {
    activityPublisher?.dispose();
    activityPublisher =
      ctx.mode === "tui"
        ? createActivityPublisher(pi.events, "pipelines")
        : undefined;
    sessionContext = ctx;
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    activityPublisher?.dispose();
    activityPublisher = undefined;
    const closing = controller;
    controller = undefined;
    await closing?.dispose();
  });

  pi.registerTool({
    name: "pipeline_run",
    label: "Run Pipeline",
    description:
      "Start implementing-pipeline (default) or audit-pipeline in the background. Implementation uses one persistent implementer, four independent audit tracks, and same-session remediation. Legacy pipelines are inspection-only.",
    promptSnippet: "Start a background implementation or independent audit",
    promptGuidelines: [
      "Provide an unchanged 3–5-word lowercase kebab-case pipeline_name. Implementation requires a dedicated linked worktree; audit defaults to the current directory. Include scope and acceptance criteria.",
      "Use role_models for explicit role choices: Sol for implementation/root/synthesis by default, Luna for exploration or small scoped tasks, Astra rarely for complex work. No pipeline has recursive orchestration or external delivery authority; git_commit optionally permits only scoped implementer commits.",
      "After launch, continue only unrelated work. Completion arrives automatically; use pipeline_check or /pipelines for occasional inspection, not polling. wallclock_limit optionally bounds each stage.",
    ],
    parameters: PIPELINE_RUN_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workingDir = resolvePipelineWorkingDir(ctx.cwd, params.working_dir);
      if (
        !fs.existsSync(workingDir) ||
        !fs.statSync(workingDir).isDirectory()
      ) {
        throw new Error(`working_dir is not a directory: ${workingDir}`);
      }
      const definition = resolvePipelineDefinition(params.pipeline);
      // Keep range validation in the public admission path as well as the
      // controller so rejected requests do not even construct controller state.
      parsePipelineWallclockLimit(params.wallclock_limit);
      assertPipelineGitCommitSupported(definition, params.git_commit === true);
      if (params.audit && definition !== AUDIT_PIPELINE_ID) {
        throw new Error(
          "The audit input contract is only valid for audit-pipeline.",
        );
      }
      const audit = params.audit
        ? {
            mode: params.audit.mode,
            acceptanceCriteria: params.audit.acceptance_criteria ?? [],
            ...(params.audit.mode === "closure"
              ? {
                  priorBlockers: params.audit.prior_blockers.map((blocker) => ({
                    id: blocker.id,
                    closureCondition: blocker.closure_condition,
                  })),
                  remediationDiff: params.audit.remediation_diff,
                  touchedInvariants: params.audit.touched_invariants,
                }
              : {}),
          }
        : undefined;
      const runId = getController(ctx).start({
        pipelineName: params.pipeline_name,
        task: params.task,
        workingDir,
        pipeline: definition,
        ...(params.git_commit !== undefined
          ? { gitCommit: params.git_commit }
          : {}),
        ...(audit ? { audit } : {}),
        ...(params.role_models ? { roleModels: params.role_models } : {}),
        ...(params.wallclock_limit !== undefined
          ? { wallclockLimit: params.wallclock_limit }
          : {}),
      });
      const admitted = getController(ctx).get(runId);
      return {
        content: [
          {
            type: "text",
            text: params.wallclock_limit
              ? `Started ${definition} ${runId} in ${workingDir} with a caller-selected ${params.wallclock_limit} per-stage budget. It is running in the background; completion or limitation will arrive as a follow-up handoff.`
              : `Started ${definition} ${runId} in ${workingDir} without a wallclock limit. It is running in the background; completion will arrive as a follow-up handoff.`,
          },
        ],
        details: {
          runId,
          definition,
          workingDir,
          wallclockLimitMs: admitted?.wallclockLimitMs,
        },
      };
    },
  });

  pi.registerTool({
    name: "pipeline_artifact_read",
    label: "Read Pipeline Artifact",
    description:
      "Read evidence for a known session-scoped pipeline run. Omit artifactId to obtain the compact index. Reads accept manifest IDs, never filesystem paths.",
    parameters: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        artifactId: Type.Optional(
          Type.String({ minLength: 1, maxLength: 128 }),
        ),
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(
          Type.Integer({ minimum: 4, maximum: 64 * 1024 }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const active = getController(ctx);
      if (!params.artifactId) {
        const entries = await active.readArtifact(params.runId);
        if (!Array.isArray(entries))
          throw new Error("Artifact manifest unavailable.");
        const selected = entries
          .filter((entry) => !entry.artifactId.startsWith("event-"))
          .slice(0, 64);
        const details = {
          entries: selected,
          totalCount: entries.length,
          omittedCount: entries.length - selected.length,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      }
      if (!params.revision)
        throw new Error("revision is required for artifact reads.");
      const details = await active.readArtifact(params.runId, {
        artifactId: params.artifactId,
        revision: params.revision,
        cursor: params.cursor,
        maxBytes: params.maxBytes ?? 16 * 1024,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  });

  pi.registerTool(createPipelineCancellationTool(getController));

  for (const tool of createPipelineInspectionTools(getController)) {
    pi.registerTool(tool);
  }

  pi.registerMessageRenderer(
    "pipeline-handoff",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        runId?: string;
        status?: string;
        definition?: PipelineDefinitionId;
        workingDir?: string;
      };
      const failed =
        details.status === "failed" ||
        details.status === "cancelled" ||
        details.status === "limited";
      const header =
        theme.fg(
          details.status === "limited"
            ? "warning"
            : failed
              ? "error"
              : "success",
          "■",
        ) +
        " " +
        theme.fg("accent", theme.bold(details.runId ?? "?")) +
        theme.fg("muted", ` · ${details.status ?? "unknown"}`);
      const content =
        typeof message.content === "string" ? message.content : "";
      if (expanded) {
        const markdown = new Markdown(content, 0, 0, getMarkdownTheme());
        return {
          render: (width: number) => [
            ...new Text(header, 0, 0).render(width),
            ...markdown.render(width),
          ],
          invalidate: () => markdown.invalidate(),
        };
      }
      const preview = content.split("\n").slice(0, 8).join("\n");
      return new Text(`${header}\n${theme.fg("toolOutput", preview)}`, 0, 0);
    },
  );

  registerPipelineCommands(pi);

  pi.registerCommand("pipelines", {
    description: "Inspect and take over pipeline runs and agents",
    handler: async (_args, ctx) => {
      const current = getController(ctx);
      if (ctx.mode !== "tui") {
        const runs = current.list();
        ctx.ui.notify(
          PIPELINE_DEFINITION_IDS.flatMap((definition) => [
            definition,
            ...runs
              .filter((run) => run.definition === definition)
              .map(
                (run) =>
                  `  ${run.id} [${run.status}] ${run.stage} ${run.workingDir}`,
              ),
          ]).join("\n"),
          "info",
        );
        return;
      }
      await showPipelineDashboard(ctx, current);
    },
  });
}
