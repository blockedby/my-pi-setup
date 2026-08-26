import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { PipelineController } from "./controller.ts";
import { showPipelineDashboard } from "./dashboard.ts";
import {
  FEATURE_PIPELINE_ID,
  PIPELINE_DEFINITION_IDS,
  type PipelineDefinitionId,
  type PipelineHandoff,
} from "./domain.ts";
import { createPipelineSessionFactory } from "./session.ts";

const HANDOFF_MAX_BYTES = 32 * 1024;

export const PIPELINE_RUN_PARAMETERS = Type.Object({
  pipeline: Type.Optional(
    StringEnum(PIPELINE_DEFINITION_IDS, {
      description:
        "Known hardcoded pipeline definition; defaults to feature-pipeline when omitted.",
    }),
  ),
  task: Type.String({
    description:
      "Self-contained feature task or planning goal; include known constraints or acceptance criteria when available.",
    minLength: 1,
    maxLength: 64 * 1024,
  }),
  working_dir: Type.Optional(
    Type.String({
      description:
        "Existing working directory in which the pipeline operates; defaults to the current directory.",
      minLength: 1,
      maxLength: 16 * 1024,
    }),
  ),
});

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
    ...(facts.planPath ? [`Plan path: ${facts.planPath}`] : []),
    `Outcome:\n${facts.outcome}`,
    `Changed paths:\n${facts.changedPaths.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Checks and evidence:\n${facts.checks.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Assumptions:\n${facts.assumptions.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Git and commits:\n${facts.git.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Reports:\n${facts.reports.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
    `Unresolved items:\n${facts.unresolvedItems.map((item) => `- ${item}`).join("\n") || "- none reported"}`,
  ];
  if (handoff.error) sections.push(`Pipeline error:\n${handoff.error}`);
  const truncation = truncateHead(sections.join("\n\n"), {
    maxBytes: HANDOFF_MAX_BYTES,
    maxLines: 800,
  });
  return truncation.truncated
    ? `${truncation.content}\n\n[Pipeline handoff truncated to ${HANDOFF_MAX_BYTES} bytes. Full transcripts remain available in /pipelines.]`
    : truncation.content;
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
    const failed = runs.filter(
      (run) => run.status === "failed" || run.status === "cancelled",
    ).length;
    const done = runs.length - running - failed;
    const parts = [
      running ? ui.theme.fg("warning", `■ ${running} running`) : "",
      done ? ui.theme.fg("success", `■ ${done} done`) : "",
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
        },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const getController = (ctx: ExtensionContext) => {
    if (controller) return controller;
    let created: PipelineController;
    created = new PipelineController({
      createSessionFactory: (rootTools, definitionForRun) =>
        createPipelineSessionFactory({
          modelRegistry: ctx.modelRegistry,
          parentCwd: ctx.cwd,
          parentTrusted: ctx.isProjectTrusted(),
          rootTools,
          definitionForRun,
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
      "Start one known hardcoded pipeline in a caller-provided working directory and return its run id immediately. Omit pipeline for feature-pipeline.",
    promptSnippet:
      "Start a background feature implementation or planning-only pipeline",
    promptGuidelines: [
      "Select a pipeline by requested outcome. Honor an explicit feature-pipeline or plan-pipeline request. Use feature-pipeline for nontrivial new-feature implementation; use plan-pipeline only when the requested deliverable is planning rather than implementation. Omission remains feature-pipeline.",
      "Automatically use plan-pipeline for a durable audited implementation plan, task breakdown, dependency waves, or test/release plan when at least one complexity signal applies: the goal spans two or more of frontend, backend, data, DevOps, or runtime; it includes migration, rollout, rollback, operational readiness, or cross-team sequencing; or acceptance criteria, scope, and dependencies require repository discovery. An explicit plan-pipeline request does not require a complexity signal.",
      "Do not choose plan-pipeline merely because an implementation request is cross-layer. Do not use either pipeline for bugs, refactors, research-only work, or trivial edits. If the user has not made the desired deliverable—plan versus implementation—clear, ask before launching. After launch, do not duplicate its work in the same workspace; monitor it through /pipelines while continuing only unrelated work.",
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
      const runId = getController(ctx).start({
        task: params.task,
        workingDir,
        pipeline: definition,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started ${definition} ${runId} in ${workingDir}. It is running in the background; completion will arrive as a follow-up handoff.`,
          },
        ],
        details: { runId, definition, workingDir },
      };
    },
  });

  pi.registerMessageRenderer(
    "pipeline-handoff",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        runId?: string;
        status?: string;
        definition?: PipelineDefinitionId;
        workingDir?: string;
      };
      const failed = details.status !== "completed";
      const header =
        theme.fg(failed ? "error" : "success", "■") +
        " " +
        theme.fg(
          "accent",
          theme.bold(
            `${details.definition ?? FEATURE_PIPELINE_ID} ${details.runId ?? "?"}`,
          ),
        ) +
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
