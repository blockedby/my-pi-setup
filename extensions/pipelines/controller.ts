import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentTreeController } from "../shared/agent-tree/control.ts";
import type {
  AgentNodeSnapshot,
  AgentTreeSessionFactory,
} from "../shared/agent-tree/domain.ts";
import {
  FEATURE_PIPELINE_ID,
  LUNA_MODEL,
  PIPELINE_CHILD_ROLES,
  PIPELINE_STAGES,
  SOL_MODEL,
  TERRA_MODEL,
  modelForRole,
  titleForRole,
  type PipelineChildRole,
  type PipelineCompletionFacts,
  type PipelineHandoff,
  type PipelineRunRequest,
  type PipelineRunSnapshot,
  type PipelineStage,
} from "./domain.ts";
import {
  buildFeaturePipelinePrompt,
  buildPipelineChildPrompt,
} from "./prompt.ts";

interface MutableRun {
  id: string;
  definition: typeof FEATURE_PIPELINE_ID;
  request: PipelineRunRequest;
  stage: PipelineStage;
  status: PipelineRunSnapshot["status"];
  startedAt: number;
  finishedAt?: number;
  error?: string;
  rootId?: string;
  completion?: PipelineCompletionFacts;
}

export interface PipelineControllerOptions {
  readonly createSessionFactory: (
    rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
  ) => AgentTreeSessionFactory;
  readonly onHandoff: (handoff: PipelineHandoff) => void | Promise<void>;
  readonly makeRunId?: () => string;
  readonly makeAgentId?: () => string;
}

function completionSchema() {
  return Type.Object({
    outcome: Type.String({ maxLength: 32_768 }),
    changed_paths: Type.Array(Type.String({ maxLength: 4_096 }), {
      maxItems: 512,
    }),
    checks_evidence: Type.Array(Type.String({ maxLength: 8_192 }), {
      maxItems: 512,
    }),
    assumptions: Type.Array(Type.String({ maxLength: 8_192 }), {
      maxItems: 256,
    }),
    git_commits: Type.Array(Type.String({ maxLength: 8_192 }), {
      maxItems: 256,
    }),
    report_summaries_references: Type.Array(
      Type.String({ maxLength: 16_384 }),
      { maxItems: 256 },
    ),
    unresolved_items: Type.Array(Type.String({ maxLength: 16_384 }), {
      maxItems: 256,
    }),
    working_dir: Type.String({ maxLength: 16_384 }),
  });
}

export class PipelineController {
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<() => void>();
  private readonly handoffs = new Set<string>();
  private readonly tree: AgentTreeController;
  private readonly onHandoff: PipelineControllerOptions["onHandoff"];
  private readonly makeRunId: () => string;
  private runSequence = 0;
  private shuttingDown = false;

  constructor(options: PipelineControllerOptions) {
    this.onHandoff = options.onHandoff;
    this.makeRunId =
      options.makeRunId ?? (() => `pipeline-${++this.runSequence}`);
    this.tree = new AgentTreeController({
      factory: options.createSessionFactory((runId) =>
        this.createRootTools(runId),
      ),
      capacity: {
        [SOL_MODEL]: 4,
        [TERRA_MODEL]: 8,
        [LUNA_MODEL]: 16,
      },
      makeId: options.makeAgentId,
    });
    this.tree.view.subscribe(() => this.onTreeChange());
  }

  get agentView() {
    return this.tree.view;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Dashboard listeners cannot alter run state.
      }
    }
  }

  private agentsFor(runId: string) {
    return this.tree.view
      .list()
      .filter((agent) => agent.scopeId === runId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  list() {
    return [...this.runs.values()]
      .map((run) => this.snapshot(run))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  get(runId: string) {
    const run = this.runs.get(runId);
    return run ? this.snapshot(run) : undefined;
  }

  private snapshot(run: MutableRun): PipelineRunSnapshot {
    return {
      id: run.id,
      definition: run.definition,
      workingDir: run.request.workingDir,
      stage: run.stage,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.rootId ? { rootId: run.rootId } : {}),
      ...(run.completion ? { completion: run.completion } : {}),
      agents: this.agentsFor(run.id),
    };
  }

  start(request: PipelineRunRequest) {
    if (this.shuttingDown)
      throw new Error("Pipeline controller is shutting down.");
    const id = this.makeRunId();
    const run: MutableRun = {
      id,
      definition: FEATURE_PIPELINE_ID,
      request,
      stage: "discover",
      status: "starting",
      startedAt: Date.now(),
    };
    this.runs.set(id, run);
    this.notify();
    void this.initialize(run);
    return id;
  }

  private async initialize(run: MutableRun) {
    try {
      const root = await this.tree.spawn({
        scopeId: run.id,
        role: "pipeline-root",
        attempt: 1,
        title: "Feature pipeline Sol",
        model: SOL_MODEL,
        cwd: run.request.workingDir,
        prompt: buildFeaturePipelinePrompt(run.request),
        persistent: true,
      });
      if (run.status !== "starting") return;
      run.rootId = root.id;
      if (root.status === "error") {
        this.failRun(run, root.error ?? "Pipeline root failed.");
      } else if (root.status === "cancelled") {
        run.status = "cancelled";
        run.finishedAt = Date.now();
        run.error = root.error;
        this.notify();
        this.deliver(run);
      } else {
        run.status = "running";
        this.notify();
      }
    } catch (error) {
      this.failRun(run, error instanceof Error ? error.message : String(error));
    }
  }

  private onTreeChange() {
    if (this.shuttingDown) return;
    for (const run of this.runs.values()) {
      if (run.status !== "starting" && run.status !== "running") continue;
      const root = run.rootId ? this.tree.view.get(run.rootId) : undefined;
      if (!root) continue;
      if (root.status === "cancelled") {
        run.status = "cancelled";
        run.finishedAt = Date.now();
        run.error = root.error;
        void this.cancelActiveChildren(run);
        this.deliver(run);
      } else if (root.status === "error") {
        this.failRun(run, root.error ?? "Pipeline root failed.");
      }
    }
    this.notify();
  }

  private failRun(run: MutableRun, error: string) {
    if (run.status !== "starting" && run.status !== "running") return;
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = error.slice(0, 16 * 1024);
    void this.cancelActiveChildren(run);
    this.notify();
    this.deliver(run);
  }

  private factsForFailure(run: MutableRun): PipelineCompletionFacts {
    return {
      outcome: "The pipeline did not produce a structured completion.",
      changedPaths: [],
      checks: [],
      assumptions: [],
      git: [],
      reports: [],
      unresolvedItems: [run.error ?? "Pipeline ended before completion."],
      workingDir: run.request.workingDir,
    };
  }

  private deliver(run: MutableRun) {
    if (this.shuttingDown || this.handoffs.has(run.id)) return;
    if (run.status === "starting" || run.status === "running") return;
    this.handoffs.add(run.id);
    const handoff: PipelineHandoff = {
      runId: run.id,
      definition: run.definition,
      status: run.status,
      facts: run.completion ?? this.factsForFailure(run),
      ...(run.error ? { error: run.error } : {}),
    };
    void Promise.resolve(this.onHandoff(handoff)).catch(() => {});
  }

  setStage(runId: string, stage: PipelineStage) {
    const run = this.requireActiveRun(runId);
    run.stage = stage;
    this.notify();
    return this.snapshot(run);
  }

  async spawnChild(
    runId: string,
    role: PipelineChildRole,
    additionalContext = "",
  ) {
    const run = this.requireActiveRun(runId);
    if (!PIPELINE_CHILD_ROLES.includes(role)) {
      throw new Error(`Unsupported feature-pipeline child role "${role}".`);
    }
    if (!run.rootId)
      throw new Error(`Pipeline run "${runId}" has no root yet.`);
    const attempt =
      this.agentsFor(runId).filter((agent) => agent.role === role).length + 1;
    return this.tree.spawn({
      scopeId: runId,
      parentId: run.rootId,
      role,
      attempt,
      title: titleForRole(role),
      model: modelForRole(role),
      cwd: run.request.workingDir,
      prompt: buildPipelineChildPrompt(role, run.request, additionalContext),
    });
  }

  listChildren(runId: string) {
    const run = this.requireRun(runId);
    return run.rootId ? this.tree.view.childrenOf(run.rootId) : [];
  }

  getAgent(runId: string, id: string) {
    this.requireRun(runId);
    const agent = this.tree.view.get(id);
    if (!agent || agent.scopeId !== runId) {
      throw new Error(`Unknown agent id "${id}" for pipeline run "${runId}".`);
    }
    return agent;
  }

  async waitForChildren(
    runId: string,
    ids: ReadonlyArray<string>,
    signal?: AbortSignal,
  ) {
    for (const id of ids) {
      const agent = this.getAgent(runId, id);
      if (!agent.parentId)
        throw new Error(`Agent "${id}" is the pipeline root.`);
    }
    return this.tree.wait(ids, signal);
  }

  async sendChild(runId: string, id: string, text: string) {
    const agent = this.getAgent(runId, id);
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    await this.tree.send(id, text);
    return this.getAgent(runId, id);
  }

  async cancelChild(runId: string, id: string) {
    const agent = this.getAgent(runId, id);
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    return this.tree.cancel(id);
  }

  complete(runId: string, facts: PipelineCompletionFacts) {
    const run = this.requireActiveRun(runId);
    const activeChildren = this.agentsFor(runId).filter(
      (agent) =>
        agent.parentId &&
        (agent.status === "starting" || agent.status === "running"),
    );
    if (activeChildren.length > 0) {
      throw new Error(
        `Cannot complete pipeline run "${runId}" while children are active: ${activeChildren.map((agent) => agent.id).join(", ")}.`,
      );
    }
    if (facts.workingDir !== run.request.workingDir) {
      throw new Error(
        `pipeline_complete working_dir must be ${run.request.workingDir}.`,
      );
    }
    run.stage = "complete";
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = facts;
    this.notify();
    this.deliver(run);
    return this.snapshot(run);
  }

  private async cancelActiveChildren(run: MutableRun) {
    const active = this.agentsFor(run.id).filter(
      (agent) =>
        agent.parentId &&
        (agent.status === "starting" || agent.status === "running"),
    );
    await Promise.allSettled(active.map((agent) => this.tree.cancel(agent.id)));
  }

  async cancelRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.status !== "starting" && run.status !== "running")
      return this.snapshot(run);
    await this.cancelActiveChildren(run);
    if (run.rootId) await this.tree.cancel(run.rootId);
    if (run.status === "starting" || run.status === "running") {
      run.status = "cancelled";
      run.finishedAt = Date.now();
      this.notify();
      this.deliver(run);
    }
    return this.snapshot(run);
  }

  private requireRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown pipeline run id "${runId}".`);
    return run;
  }

  private requireActiveRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.status !== "starting" && run.status !== "running") {
      throw new Error(`Pipeline run "${runId}" is ${run.status}.`);
    }
    return run;
  }

  createRootTools(runId: string): ToolDefinition[] {
    const controller = this;
    return [
      defineTool({
        name: "pipeline_stage",
        label: "Pipeline Stage",
        description: "Record the current feature-pipeline stage.",
        parameters: Type.Object({ stage: StringEnum(PIPELINE_STAGES) }),
        async execute(_id, params) {
          const run = controller.setStage(runId, params.stage);
          return {
            content: [{ type: "text", text: `Pipeline stage: ${run.stage}` }],
            details: { runId, stage: run.stage },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_spawn",
        label: "Spawn Pipeline Child",
        description: "Start one allowed feature-pipeline Luna or Terra role.",
        parameters: Type.Object({
          role: StringEnum(PIPELINE_CHILD_ROLES),
          context: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
        }),
        async execute(_id, params) {
          const child = await controller.spawnChild(
            runId,
            params.role,
            params.context,
          );
          return {
            content: [
              {
                type: "text",
                text: `Started ${child.id}: ${child.role} attempt ${child.attempt} (${child.model}).`,
              },
            ],
            details: {
              runId,
              id: child.id,
              role: child.role,
              attempt: child.attempt,
              model: child.model,
            },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_list",
        label: "List Pipeline Children",
        description: "List children and attempts in this pipeline run.",
        parameters: Type.Object({}),
        async execute() {
          const children = controller.listChildren(runId);
          return {
            content: [
              {
                type: "text",
                text:
                  children.length === 0
                    ? "No pipeline children."
                    : children
                        .map(
                          (child) =>
                            `${child.id} [${child.status}] ${child.role} attempt ${child.attempt} (${child.model})`,
                        )
                        .join("\n"),
              },
            ],
            details: { runId, children },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_check",
        label: "Check Pipeline Child",
        description: "Inspect one child status and latest report.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolId, params) {
          const child = controller.getAgent(runId, params.id);
          if (!child.parentId)
            throw new Error(`Agent "${params.id}" is the pipeline root.`);
          return {
            content: [
              {
                type: "text",
                text: `${child.id} [${child.status}] ${child.role} attempt ${child.attempt}\n\n${child.error ?? (child.finalText || "(no report yet)")}`.slice(
                  0,
                  24 * 1024,
                ),
              },
            ],
            details: { runId, id: child.id, status: child.status },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_wait",
        label: "Wait for Pipeline Children",
        description:
          "Wait for known children and return their reports in this Sol context.",
        parameters: Type.Object({
          ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32 }),
        }),
        async execute(_toolId, params, signal, onUpdate) {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${params.ids.join(", ")}...` },
            ],
            details: { runId, pending: params.ids },
          });
          const children = await controller.waitForChildren(
            runId,
            params.ids,
            signal,
          );
          return {
            content: [
              {
                type: "text",
                text: children
                  .map(
                    (child) =>
                      `## ${child.id} · ${child.role} · attempt ${child.attempt} · ${child.status}\n\n${child.error ?? (child.finalText || "(no report)")}`,
                  )
                  .join("\n\n---\n\n")
                  .slice(0, 48 * 1024),
              },
            ],
            details: {
              runId,
              results: children.map((child) => ({
                id: child.id,
                role: child.role,
                attempt: child.attempt,
                status: child.status,
              })),
            },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_send",
        label: "Send to Pipeline Child",
        description:
          "Continue or retry one known child in its existing session context.",
        parameters: Type.Object({
          id: Type.String(),
          message: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
        }),
        async execute(_toolId, params) {
          const child = await controller.sendChild(
            runId,
            params.id,
            params.message,
          );
          return {
            content: [
              {
                type: "text",
                text: `Sent a continuation to ${child.id} (${child.role}).`,
              },
            ],
            details: { runId, id: child.id, status: child.status },
          };
        },
      }),
      defineTool({
        name: "pipeline_child_cancel",
        label: "Cancel Pipeline Child",
        description: "Cancel one known child in this pipeline run.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_toolId, params) {
          const child = await controller.cancelChild(runId, params.id);
          return {
            content: [{ type: "text", text: `Cancelled ${child.id}.` }],
            details: { runId, id: child.id, status: child.status },
          };
        },
      }),
      defineTool({
        name: "pipeline_complete",
        label: "Complete Pipeline",
        description:
          "Finish this run with factual handoff data and no readiness label.",
        parameters: completionSchema(),
        async execute(_toolId, params) {
          controller.complete(runId, {
            outcome: params.outcome,
            changedPaths: params.changed_paths,
            checks: params.checks_evidence,
            assumptions: params.assumptions,
            git: params.git_commits,
            reports: params.report_summaries_references,
            unresolvedItems: params.unresolved_items,
            workingDir: params.working_dir,
          });
          return {
            content: [{ type: "text", text: `Pipeline ${runId} completed.` }],
            details: { runId },
            terminate: true,
          };
        },
      }),
    ];
  }

  async dispose() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.tree.dispose();
    this.listeners.clear();
  }
}
