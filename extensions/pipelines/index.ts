import * as fs from "node:fs";
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
import { showPipelineDashboard } from "./dashboard.ts";
import {
  AUDIT_PIPELINE_ID,
  FEATURE_PIPELINE_ID,
  PIPELINE_DEFINITION_IDS,
  assertPipelineGitCommitSupported,
  type PipelineDefinitionId,
  type PipelineHandoff,
} from "./domain.ts";
import {
  parsePipelineWallclockLimit,
  PIPELINE_WALLCLOCK_LIMIT_PATTERN,
} from "./wallclock.ts";

export {
  DEFAULT_PIPELINE_WALLCLOCK_LIMIT_MS,
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
      "Self-contained feature task, planning goal, or audit scope; include known constraints or acceptance criteria when available. Closure-specific scope belongs in audit.",
    minLength: 1,
    maxLength: 64 * 1024,
  }),
  working_dir: Type.Optional(
    Type.String({
      description:
        "Existing working directory in which the pipeline operates. feature-pipeline and small-feature-pipeline require the exact root of a caller-prepared dedicated linked Git worktree; feature additionally requires Linux bubblewrap, a clean stable HEAD, and rejects the primary checkout. Plan and audit default to the current directory.",
      minLength: 1,
      maxLength: 16 * 1024,
    }),
  ),
  git_commit: Type.Optional(
    Type.Boolean({
      description:
        "feature-pipeline hard-requires explicit true, Linux bubblewrap, and a dedicated clean attached linked worktree; controller-owned candidates/synthesis and the post-promotion remediation root may make scoped ordinary commits. small-feature also requires a caller-prepared linked worktree but keeps commit permission optional for its persistent implementer. Plan/audit reject true. Never permits push, delivery merge, history rewrite, deployment, or arbitrary branch/worktree operations.",
    }),
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
        "Canonical integer stage budget, in seconds, minutes, or hours; omission defaults to 30m and accepted values are 30s through 24h.",
      pattern: PIPELINE_WALLCLOCK_LIMIT_PATTERN,
      maxLength: 32,
    }),
  ),
};

const PLAN_PATH_PARAMETER = Type.Union(
  [Type.String({ minLength: 1, maxLength: 16 * 1024 }), Type.Null()],
  {
    description:
      "Explicit plan-pipeline destination. Use null for terminal-only delivery; relative paths resolve under working_dir and absolute paths must remain inside it.",
  },
);

const NON_PLAN_PIPELINE_PARAMETERS = Type.Object(
  {
    pipeline_name: Type.String({
      description: PIPELINE_NAME_DESCRIPTION,
      minLength: 1,
      maxLength: PIPELINE_NAME_MAX_LENGTH,
      pattern: PIPELINE_NAME_PATTERN,
    }),
    pipeline: Type.Optional(
      StringEnum(
        [FEATURE_PIPELINE_ID, "small-feature-pipeline", AUDIT_PIPELINE_ID],
        {
          description:
            "Known non-plan pipeline definition; defaults to feature-pipeline when omitted.",
        },
      ),
    ),
    ...PIPELINE_RUN_COMMON_PROPERTIES,
    plan_path: Type.Optional(Type.Null()),
  },
  { additionalProperties: false },
);

const PLAN_PIPELINE_PARAMETERS = Type.Object(
  {
    pipeline_name: Type.String({
      description: PIPELINE_NAME_DESCRIPTION,
      minLength: 1,
      maxLength: PIPELINE_NAME_MAX_LENGTH,
      pattern: PIPELINE_NAME_PATTERN,
    }),
    pipeline: Type.Literal("plan-pipeline"),
    ...PIPELINE_RUN_COMMON_PROPERTIES,
    plan_path: PLAN_PATH_PARAMETER,
  },
  { additionalProperties: false },
);

export const PIPELINE_RUN_PARAMETERS = Type.Union([
  NON_PLAN_PIPELINE_PARAMETERS,
  PLAN_PIPELINE_PARAMETERS,
]);

export function resolvePipelineDefinition(requested?: string) {
  if (!requested) return FEATURE_PIPELINE_ID;
  const definition = PIPELINE_DEFINITION_IDS.find((id) => id === requested);
  if (!definition)
    throw new Error(`Unsupported pipeline definition: ${requested}`);
  return definition;
}

export function resolvePipelineWorkingDir(
  currentDirectory: string,
  requestedDirectory?: string,
) {
  return path.resolve(currentDirectory, requestedDirectory ?? currentDirectory);
}

export function handoffText(handoff: PipelineHandoff) {
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

  const updateStatus = () => {
    const ui = sessionContext?.hasUI ? sessionContext.ui : undefined;
    if (!ui || !controller) return;
    const runs = controller.list();
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
      createSessionFactory: (
        rootTools,
        definitionForRun,
        auditSubmit,
        auditSessionCreated,
        auditToolAllowed,
        discoverySubmit,
        discoverySessionCreated,
        discoveryToolAllowed,
        featureCommit,
        executionFinish,
        executionFinishSessionCreated,
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
          featureCommit,
          executionFinish,
          executionFinishSessionCreated,
        }),
      onHandoff: deliver,
    });
    controller = created;
    unsubscribeStatus = created.subscribe(updateStatus);
    updateStatus();
    return created;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    updateStatus();
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    const closing = controller;
    controller = undefined;
    await closing?.dispose();
  });

  pi.registerTool({
    name: "pipeline_run",
    label: "Run Pipeline",
    description:
      "Start one of four known hardcoded pipelines with a required unchanged 3–5-word lowercase kebab-case pipeline_name (maximum 64 characters) and return its canonical name-plus-eight-hex run id immediately. Optionally set wallclock_limit to a canonical 30s–24h stage budget; omission uses 30m. Supported definitions are feature-pipeline, small-feature-pipeline, plan-pipeline, and audit-pipeline. Omit pipeline for feature-pipeline. Feature discovery and synthesis feed three parallel isolated Luna/xHIGH implementation candidates; one Luna/xHIGH synthesis agent selects a primary before writing, performs bounded primary-based augmentation, verifies/commits, promotes the exact result, cleans temporary worktrees, then starts independent audit/remediation. plan-pipeline produces a complete repository-grounded plan through six parallel Luna discoveries and one Luna/xHIGH synthesis; pass plan_path explicitly as a destination or null. feature-pipeline requires git_commit=true, Linux bubblewrap, and a dedicated clean attached linked worktree; small-feature also requires a caller-prepared linked worktree while commit permission remains optional; plan/audit reject true.",
    promptSnippet:
      "Start a background implementation, planning, or Luna audit pipeline",
    promptGuidelines: [
      "Always provide pipeline_name as the unchanged lowercase kebab-case base of 3–5 hyphen-separated words (maximum 64 characters), such as replace-heavy-plan-pipeline. Optionally provide wallclock_limit as an integer duration such as 30s, 5m, or 2h; stages warn at 80% and end as limited at 100% unless an earlier outcome wins. The controller appends the canonical eight-character hexadecimal suffix; use that exact returned id for later inspection or cancellation. Select a pipeline by requested outcome. Honor an explicit feature-pipeline, small-feature-pipeline, plan-pipeline, or audit-pipeline request. Use audit-pipeline for routine repository initial or closure audits that require four independent static Luna tracks, one audit-executor contributor, and incremental Luna synthesis without remediation. Use small-feature-pipeline for a bounded, well-specified implementation that fits one Luna implementation, four parallel independent Luna audit tracks, and one same-session Luna remediation pass. Use feature-pipeline for nontrivial new-feature implementation that needs discovery and multi-concern audit. Use plan-pipeline only when the requested deliverable is planning rather than implementation. Omission remains feature-pipeline.",
      "Automatically use plan-pipeline for a durable audited implementation plan, task breakdown, dependency waves, or test/release plan when at least one complexity signal applies: the goal spans two or more of frontend, backend, data, DevOps, or runtime; it includes migration, rollout, rollback, operational readiness, or cross-team sequencing; or acceptance criteria, scope, and dependencies require repository discovery. An explicit plan-pipeline request does not require a complexity signal.",
      "Do not choose plan-pipeline merely because an implementation request is cross-layer. Do not use implementation or planning pipelines for bugs, refactors, research-only work, or trivial edits; use audit-pipeline only when the requested outcome is a bounded repository audit rather than implementation. A small feature is bounded implementation work that still benefits from independent audit; it is not a synonym for a trivial edit. If the user has not made the desired deliverable—plan versus implementation—clear, ask before launching. Before feature-pipeline or small-feature-pipeline, create and prepare a dedicated linked Git worktree and pass its exact root. git_commit is authoritative and never inferred from task prose. feature-pipeline additionally rejects omission/false and requires Linux bubblewrap plus a clean stable HEAD; its controller alone owns temporary candidate/synthesis branches, worktrees, exact promotion, and cleanup. No pipeline receives push, delivery-merge, history-rewrite, deployment, or external-state authority. After launch, do not duplicate work in the same workspace; use pipeline_check occasionally or /pipelines for live inspection while continuing only unrelated work. Do not poll; completion arrives automatically as a follow-up handoff.",
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
      if (definition === "plan-pipeline" && params.plan_path === undefined) {
        throw new Error(
          "plan-pipeline requires plan_path explicitly as a path or null.",
        );
      }
      if (
        definition !== "plan-pipeline" &&
        params.plan_path !== undefined &&
        params.plan_path !== null
      ) {
        throw new Error(
          `plan_path is only valid for plan-pipeline; received ${definition}.`,
        );
      }
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
        ...(definition === "plan-pipeline"
          ? { planPath: params.plan_path ?? null }
          : {}),
        ...(params.wallclock_limit !== undefined
          ? { wallclockLimit: params.wallclock_limit }
          : {}),
      });
      const admitted = getController(ctx).get(runId);
      return {
        content: [
          {
            type: "text",
            text: `Started ${definition} ${runId} in ${workingDir} with a ${params.wallclock_limit ?? "30m"} per-stage budget. It is running in the background; completion or limitation will arrive as a follow-up handoff.`,
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
