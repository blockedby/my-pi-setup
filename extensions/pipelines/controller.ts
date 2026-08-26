import { execFileSync } from "node:child_process";
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
  AUDIT_PIPELINE_ID,
  AUDIT_SYNTHESIS_ROLE,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_PIPELINE_ID,
  PIPELINE_4_LUNA_AUDIT_ROLES,
  PIPELINE_STAGES,
  PLAN_PIPELINE_AUDIT_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  PLAN_PIPELINE_ID,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  SMALL_FEATURE_PIPELINE_ID,
  childContextPolicyFor,
  definitionFor,
  initialStageForDefinition,
  modelForRole,
  roleBelongsToDefinition,
  rolesForDefinition,
  stagesForDefinition,
  titleForRole,
  type AuditPipelineInput,
  type FeaturePipelineDiscoveryRole,
  type PipelineChildRole,
  type PipelineCompletionFacts,
  type PipelineDefinitionId,
  type PipelineHandoff,
  type PipelineRunRequest,
  type PipelineRunSnapshot,
  type PipelineStage,
} from "./domain.ts";
import {
  resolvePlanArtifact,
  validatePipelineReport,
  writePlanArtifact,
} from "./plan-contract.ts";
import {
  buildPipelineChildPrompt,
  buildPipelinePrompt,
  type FeatureDiscoveryReportContext,
} from "./prompt.ts";
import {
  AuditSegment,
  buildAuditTrackPrompt,
  type AuditGitIdentity,
  type AuditSegmentContext,
} from "./audit-segment.ts";

const FEATURE_DISCOVERY_REPORT_MAX_BYTES = 32 * 1024;

function isFeatureDiscoveryRole(
  role: string,
): role is FeaturePipelineDiscoveryRole {
  return (FEATURE_PIPELINE_DISCOVERY_ROLES as ReadonlyArray<string>).includes(
    role,
  );
}

interface MutableRun {
  id: string;
  definition: PipelineDefinitionId;
  request: PipelineRunRequest;
  baseSha: string;
  stage: PipelineStage;
  status: PipelineRunSnapshot["status"];
  startedAt: number;
  finishedAt?: number;
  error?: string;
  rootId?: string;
  featureDiscoveryBootstrapped: boolean;
  auditSegment?: AuditSegment;
  auditSegmentStarting?: Promise<ReadonlyArray<AgentNodeSnapshot>>;
  completion?: PipelineCompletionFacts;
  planArtifactsWritten: Map<
    string,
    { digest: string; device: number; inode: number }
  >;
}

function gitHead(workingDir: string) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workingDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "UNAVAILABLE";
  }
}

export interface PipelineControllerOptions {
  readonly createSessionFactory: (
    rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
    definitionForRun: (runId: string) => PipelineDefinitionId,
  ) => AgentTreeSessionFactory;
  readonly onHandoff: (handoff: PipelineHandoff) => void | Promise<void>;
  readonly makeRunId?: () => string;
  readonly makeAgentId?: () => string;
}

function completionSchema() {
  return Type.Object({
    outcome: Type.String({ maxLength: 32_768 }),
    plan_path: Type.Optional(Type.String({ maxLength: 16_384 })),
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
  private readonly childContinuations = new Map<string, number>();
  private readonly auditPumps = new Set<string>();
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
      factory: options.createSessionFactory(
        (runId) => this.createRootTools(runId),
        (runId) => this.requireRun(runId).definition,
      ),
      // Pipeline graphs predeclare their model fan-out. Direct-subagent quotas
      // intentionally do not apply to pipeline roots or children.
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
      ...(run.auditSegment
        ? { auditSegment: run.auditSegment.progress() }
        : {}),
      agents: this.agentsFor(run.id),
    };
  }

  start(request: PipelineRunRequest) {
    if (this.shuttingDown)
      throw new Error("Pipeline controller is shutting down.");
    const definition = request.pipeline ?? FEATURE_PIPELINE_ID;
    if (request.audit && definition !== AUDIT_PIPELINE_ID) {
      throw new Error("Audit input is only valid for audit-pipeline.");
    }
    const audit: AuditPipelineInput = request.audit ?? {
      mode: "initial",
      acceptanceCriteria: [],
    };
    if (
      definition === AUDIT_PIPELINE_ID &&
      audit.mode === "closure" &&
      (!audit.priorBlockers?.length ||
        !audit.remediationDiff ||
        !audit.touchedInvariants?.length)
    ) {
      throw new Error(
        "Closure audit requires prior blockers, closure conditions, a remediation diff, and at least one directly touched invariant.",
      );
    }
    const normalizedRequest =
      definition === AUDIT_PIPELINE_ID ? { ...request, audit } : request;
    const id = this.makeRunId();
    const run: MutableRun = {
      id,
      definition,
      request: normalizedRequest,
      baseSha: gitHead(request.workingDir),
      stage: initialStageForDefinition(definition),
      status: "starting",
      startedAt: Date.now(),
      featureDiscoveryBootstrapped: false,
      planArtifactsWritten: new Map(),
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
        role:
          run.definition === AUDIT_PIPELINE_ID
            ? AUDIT_SYNTHESIS_ROLE
            : "pipeline-root",
        attempt: 1,
        title: definitionFor(run.definition).rootTitle,
        model: definitionFor(run.definition).rootModel,
        cwd: run.request.workingDir,
        prompt: buildPipelinePrompt(run.definition, run.request),
        persistent: true,
        deferPrompt:
          run.definition === FEATURE_PIPELINE_ID ||
          run.definition === AUDIT_PIPELINE_ID,
        shouldStart: () => run.status === "starting",
      });
      run.rootId = root.id;
      if (run.status !== "starting") {
        this.notify();
        return;
      }
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
        if (run.definition === FEATURE_PIPELINE_ID) {
          const discoveryReports = await this.bootstrapFeatureDiscovery(run);
          if (run.status !== "running") return;
          await this.tree.startDeferred(
            root.id,
            buildPipelinePrompt(run.definition, run.request, discoveryReports),
          );
        } else if (run.definition === AUDIT_PIPELINE_ID) {
          run.auditSegmentStarting = this.startAuditSegment(run, {
            acceptanceContract:
              run.request.audit?.acceptanceCriteria.join("\n") ||
              "Use the task statement as the bounded acceptance contract.",
            assumptions: [],
            checks: [],
            standalone: true,
          });
          await run.auditSegmentStarting;
        }
      }
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        Boolean(run.rootId),
      );
    }
  }

  private async spawnFeatureDiscoveryAttempt(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
  ) {
    try {
      return await this.spawnChildForRun(run, role, "", true);
    } catch (error) {
      if (run.status !== "running") throw error;
      const attempts = this.agentsFor(run.id).filter(
        (agent) => agent.role === role,
      );
      const failedBeforeSession =
        attempts.length === 1 &&
        attempts[0]?.status === "error" &&
        !attempts[0].sessionFile;
      if (!failedBeforeSession) throw error;
      return this.spawnChildForRun(run, role, "", true);
    }
  }

  private featureDiscoveryReportAgent(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
  ) {
    return this.agentsFor(run.id)
      .filter(
        (agent) =>
          agent.role === role &&
          (agent.status === "done" || agent.status === "idle") &&
          Buffer.byteLength(agent.finalText, "utf8") <=
            FEATURE_DISCOVERY_REPORT_MAX_BYTES &&
          validatePipelineReport(run.definition, role, agent.finalText)
            .length === 0,
      )
      .at(-1);
  }

  private featureDiscoveryReports(run: MutableRun) {
    return FEATURE_PIPELINE_DISCOVERY_ROLES.map((role) => {
      const agent = this.featureDiscoveryReportAgent(run, role);
      if (!agent) {
        throw new Error(
          `feature-pipeline programmatic discovery has no valid ${role} report.`,
        );
      }
      return {
        role,
        report: agent.finalText,
      } satisfies FeatureDiscoveryReportContext;
    });
  }

  private async bootstrapFeatureDiscovery(run: MutableRun) {
    const initial = await Promise.all(
      FEATURE_PIPELINE_DISCOVERY_ROLES.map((role) =>
        this.spawnFeatureDiscoveryAttempt(run, role),
      ),
    );
    await this.waitForChildren(
      run.id,
      initial.map((agent) => agent.id),
    );
    if (run.status !== "running") return [];

    const retryIds: string[] = [];
    for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES) {
      if (this.featureDiscoveryReportAgent(run, role)) continue;
      const attempts = this.agentsFor(run.id).filter(
        (agent) => agent.role === role,
      );
      const latest = attempts.at(-1);
      if (!latest || latest.status === "cancelled" || attempts.length >= 2) {
        throw new Error(
          `feature-pipeline programmatic discovery failed for ${role}.`,
        );
      }
      await this.tree.send(
        latest.id,
        `Your discovery report was missing, malformed, failed, or exceeded ${FEATURE_DISCOVERY_REPORT_MAX_BYTES} UTF-8 bytes. Retry this same role once. Return only one corrected compact JSON object matching the original report contract.`,
      );
      retryIds.push(latest.id);
    }

    if (retryIds.length > 0) {
      await this.waitForChildren(run.id, retryIds);
    }
    if (run.status !== "running") return [];
    const reports = this.featureDiscoveryReports(run);
    if (run.stage !== "build") {
      throw new Error(
        "feature-pipeline programmatic discovery did not advance to build.",
      );
    }
    run.featureDiscoveryBootstrapped = true;
    return reports;
  }

  private auditGitIdentity(run: MutableRun): AuditGitIdentity {
    let branch = "UNAVAILABLE";
    try {
      branch =
        execFileSync("git", ["branch", "--show-current"], {
          cwd: run.request.workingDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "DETACHED";
    } catch {
      // Explicit unavailable evidence is safer than guessing repository state.
    }
    return {
      baseSha: run.baseSha,
      headSha: gitHead(run.request.workingDir),
      worktreeLabel: "WORKTREE",
      workingDir: run.request.workingDir,
      branch,
      status: this.gitStatus(run.id).slice(0, 64 * 1024),
      diff: this.gitDiff(run.id).slice(0, 64 * 1024),
    };
  }

  private async startAuditSegment(
    run: MutableRun,
    options: {
      acceptanceContract: string;
      assumptions: ReadonlyArray<string>;
      checks: ReadonlyArray<string>;
      standalone: boolean;
    },
  ) {
    if (run.auditSegment) {
      throw new Error("This pipeline run already has an audit segment.");
    }
    if (!run.rootId) throw new Error(`Pipeline run "${run.id}" has no root.`);
    const input = run.request.audit ?? {
      mode: "initial" as const,
      acceptanceCriteria: [],
    };
    const context: AuditSegmentContext = {
      task: run.request.task,
      acceptanceContract: options.acceptanceContract.slice(0, 64 * 1024),
      assumptions: options.assumptions.slice(0, 128),
      checks: options.checks.slice(0, 128),
      input,
      git: this.auditGitIdentity(run),
    };
    const segment = new AuditSegment(context);
    run.auditSegment = segment;
    this.notify();

    if (options.standalone) {
      segment.registerSynthesis(run.rootId);
    } else {
      const synthesis = await this.tree.spawn({
        scopeId: run.id,
        parentId: run.rootId,
        role: AUDIT_SYNTHESIS_ROLE,
        attempt: 1,
        title: titleForRole(AUDIT_SYNTHESIS_ROLE),
        model: modelForRole(AUDIT_SYNTHESIS_ROLE),
        cwd: run.request.workingDir,
        prompt: "Controller-deferred audit synthesis.",
        persistent: true,
        deferPrompt: true,
        shouldStart: () => run.status === "running",
      });
      segment.registerSynthesis(synthesis.id);
    }

    const tracks = await Promise.all(
      PIPELINE_4_LUNA_AUDIT_ROLES.map(async (role) => {
        const attempt =
          this.agentsFor(run.id).filter((agent) => agent.role === role).length +
          1;
        const child = await this.tree.spawn({
          scopeId: run.id,
          parentId: run.rootId,
          role,
          attempt,
          title: titleForRole(role),
          model: modelForRole(role),
          cwd: run.request.workingDir,
          prompt: buildAuditTrackPrompt(role, context),
          shouldStart: () => run.status === "running",
        });
        segment.registerTrack(role, child.id);
        return child;
      }),
    );
    await this.pumpAuditSegment(run);
    const synthesis = this.tree.view.get(segment.synthesizerId!);
    return synthesis ? [...tracks, synthesis] : tracks;
  }

  async startFinalAudit(
    runId: string,
    context: {
      acceptanceContract: string;
      assumptions: ReadonlyArray<string>;
      checks: ReadonlyArray<string>;
    },
  ) {
    const run = this.requireActiveRun(runId);
    if (
      run.definition !== FEATURE_PIPELINE_ID &&
      run.definition !== PLAN_PIPELINE_ID
    ) {
      throw new Error(
        "Embedded audit segments are available only to feature-pipeline and plan-pipeline.",
      );
    }
    if (run.stage !== "final-audit") {
      throw new Error(
        "The pipeline must enter final-audit before starting its audit segment.",
      );
    }
    if (run.auditSegmentStarting || run.auditSegment) {
      throw new Error(
        "This pipeline run already started its final audit segment.",
      );
    }
    const starting = this.startAuditSegment(run, {
      ...context,
      standalone: false,
    });
    run.auditSegmentStarting = starting;
    try {
      return await starting;
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
      throw error;
    }
  }

  private async pumpAuditSegment(run: MutableRun) {
    const segment = run.auditSegment;
    if (
      !segment ||
      this.auditPumps.has(run.id) ||
      (run.status !== "starting" && run.status !== "running")
    ) {
      return;
    }
    this.auditPumps.add(run.id);
    try {
      for (const [role, id] of segment.tracks) {
        const child = this.tree.view.get(id);
        if (
          !child ||
          child.status === "starting" ||
          child.status === "running"
        ) {
          continue;
        }
        if (child.status === "error" || child.status === "cancelled") {
          throw new Error(`Audit track ${role} failed before a valid report.`);
        }
        segment.accept(role, child.finalText, child.attempt);
      }

      const synthesisId = segment.synthesizerId;
      if (!synthesisId) return;
      let synthesizer = this.tree.view.get(synthesisId);
      if (!synthesizer)
        throw new Error("Audit synthesis session is unavailable.");

      if (
        segment.progress().reducerStatus === "busy" &&
        synthesizer.status === "idle"
      ) {
        segment.settle(synthesizer.finalText);
      } else if (
        segment.progress().reducerStatus === "busy" &&
        (synthesizer.status === "error" || synthesizer.status === "cancelled")
      ) {
        throw new Error(
          "Audit synthesis failed before returning a valid report.",
        );
      }

      const finalReport = segment.finalReport;
      if (finalReport) {
        if (run.definition === AUDIT_PIPELINE_ID) {
          this.completeStandaloneAudit(run, finalReport);
        } else if (run.stage === "final-audit") {
          run.stage = "final-resolve";
          this.notify();
        }
        return;
      }

      synthesizer = this.tree.view.get(synthesisId)!;
      if (synthesizer.status !== "idle") return;
      const next = segment.nextPrompt();
      if (!next) return;
      if (synthesizer.finalText || synthesizer.transcript.length > 0) {
        await this.tree.send(synthesisId, next.prompt);
      } else {
        await this.tree.startDeferred(synthesisId, next.prompt);
      }
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
    } finally {
      this.auditPumps.delete(run.id);
      this.notify();
      const synthesisId = segment.synthesizerId;
      const synthesizer = synthesisId
        ? this.tree.view.get(synthesisId)
        : undefined;
      if (
        (run.status === "starting" || run.status === "running") &&
        segment.progress().reducerStatus === "busy" &&
        synthesizer?.status === "idle"
      ) {
        void this.pumpAuditSegment(run);
      }
    }
  }

  private completeStandaloneAudit(
    run: MutableRun,
    report: NonNullable<PipelineCompletionFacts["auditReport"]>,
  ) {
    if (run.status !== "running") return;
    const progress = run.auditSegment?.progress();
    run.stage = "complete";
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = {
      outcome: report.summary,
      changedPaths: [],
      checks: [
        `${progress?.integratedReportCount ?? 0} validated Luna audit reports integrated exactly once.`,
        `${progress?.revision ?? 0} serialized synthesis revision(s) completed.`,
        `Captured review identity: ${report.baseSha}..${report.headSha} (WORKTREE).`,
      ],
      assumptions: [],
      git: [
        `Review base ${report.baseSha}`,
        `Review head ${report.headSha} with WORKTREE evidence`,
      ],
      reports: [
        `Validated ${report.mode} audit synthesis: ${report.findings.length} finding(s), ${report.unresolvedConflicts.length} unresolved conflict(s), ${report.unprovenChecks.length} unproven check(s).`,
      ],
      unresolvedItems: [
        ...report.unresolvedConflicts.map((item) => item.description),
        ...report.unprovenChecks.map((item) => item.claim),
      ],
      workingDir: run.request.workingDir,
      auditReport: report,
    };
    this.notify();
    this.deliver(run);
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
      if (run.status === "starting" || run.status === "running") {
        void this.pumpAuditSegment(run);
      }
    }
    this.notify();
  }

  private failRun(run: MutableRun, error: string, cancelRoot = false) {
    if (run.status !== "starting" && run.status !== "running") return;
    run.status = "failed";
    run.finishedAt = Date.now();
    run.error = error.slice(0, 16 * 1024);
    void this.cancelActiveChildren(run);
    if (cancelRoot && run.rootId) {
      void this.tree.cancel(run.rootId).catch(() => {});
    }
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

  private roleHasValidReport(run: MutableRun, role: PipelineChildRole) {
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(role)
    ) {
      return Boolean(this.featureDiscoveryReportAgent(run, role));
    }
    return this.agentsFor(run.id).some(
      (agent) =>
        agent.role === role &&
        (agent.status === "done" || agent.status === "idle") &&
        validatePipelineReport(run.definition, agent.role, agent.finalText)
          .length === 0,
    );
  }

  private requireValidReports(
    run: MutableRun,
    roles: ReadonlyArray<PipelineChildRole>,
    transition: PipelineStage,
  ) {
    const missing = roles.filter((role) => !this.roleHasValidReport(run, role));
    if (missing.length > 0) {
      throw new Error(
        `Cannot enter ${transition}; missing valid reports: ${missing.join(", ")}.`,
      );
    }
  }

  private advanceStageAfterFanIn(
    run: MutableRun,
    waitedChildren: ReadonlyArray<AgentNodeSnapshot>,
  ) {
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      const boundary =
        run.stage === "build"
          ? {
              roles: [SMALL_FEATURE_IMPLEMENTER_ROLE] as const,
              nextStage: "final-audit" as const,
            }
          : run.stage === "final-audit"
            ? {
                roles: PIPELINE_4_LUNA_AUDIT_ROLES,
                nextStage: "final-resolve" as const,
              }
            : run.stage === "final-resolve"
              ? {
                  roles: [SMALL_FEATURE_IMPLEMENTER_ROLE] as const,
                  nextStage: "complete" as const,
                }
              : undefined;
      const waitedAtBoundary = boundary?.roles.some((role) =>
        waitedChildren.some((child) => child.role === role),
      );
      const implementer = waitedChildren.find(
        (child) => child.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
      );
      const remediationComplete =
        run.stage !== "final-resolve" ||
        (implementer !== undefined &&
          this.childContinuations.get(implementer.id) === 1);
      if (
        boundary &&
        waitedAtBoundary &&
        remediationComplete &&
        boundary.roles.every((role) => this.roleHasValidReport(run, role))
      ) {
        run.stage = boundary.nextStage;
        this.notify();
      }
      return;
    }
    const roles =
      run.stage === "discover"
        ? run.definition === FEATURE_PIPELINE_ID
          ? FEATURE_PIPELINE_DISCOVERY_ROLES
          : PLAN_PIPELINE_DISCOVERY_ROLES
        : run.stage === "audit"
          ? run.definition === FEATURE_PIPELINE_ID
            ? PIPELINE_4_LUNA_AUDIT_ROLES
            : run.definition === PLAN_PIPELINE_ID
              ? PLAN_PIPELINE_AUDIT_ROLES
              : []
          : [];
    const nextStage =
      run.stage === "discover"
        ? "build"
        : run.stage === "audit"
          ? "audit-resolve"
          : undefined;
    if (
      !nextStage ||
      !waitedChildren.some((child) =>
        roles.some((role) => role === child.role),
      ) ||
      roles.some((role) => !this.roleHasValidReport(run, role))
    ) {
      return;
    }
    run.stage = nextStage;
    this.notify();
  }

  setStage(runId: string, stage: PipelineStage) {
    const run = this.requireActiveRun(runId);
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      const stages = stagesForDefinition(run.definition);
      const currentIndex = stages.indexOf(run.stage);
      const nextIndex = stages.indexOf(stage);
      if (
        nextIndex < 0 ||
        nextIndex < currentIndex ||
        nextIndex > currentIndex + 1
      ) {
        throw new Error(
          `Invalid small-feature-pipeline stage transition: ${run.stage} to ${stage}.`,
        );
      }
      if (stage === "final-audit") {
        this.requireValidReports(run, [SMALL_FEATURE_IMPLEMENTER_ROLE], stage);
      } else if (stage === "final-resolve") {
        this.requireValidReports(run, PIPELINE_4_LUNA_AUDIT_ROLES, stage);
      } else if (stage === "complete") {
        if (
          this.childContinuations.get(
            this.agentsFor(runId).find(
              (agent) => agent.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
            )?.id ?? "",
          ) !== 1
        ) {
          throw new Error(
            "small-feature-pipeline completion requires one same-session Luna remediation pass.",
          );
        }
        this.requireValidReports(
          run,
          SMALL_FEATURE_PIPELINE_CHILD_ROLES,
          stage,
        );
      }
    } else if (run.definition === AUDIT_PIPELINE_ID) {
      throw new Error("audit-pipeline stages are controller-owned.");
    } else if (
      run.definition === FEATURE_PIPELINE_ID &&
      stage === "discover" &&
      run.featureDiscoveryBootstrapped
    ) {
      throw new Error(
        "feature-pipeline cannot return to controller-owned discovery after bootstrap.",
      );
    } else if (
      run.definition === FEATURE_PIPELINE_ID &&
      stage === "final-resolve" &&
      !run.auditSegment?.finalReport
    ) {
      throw new Error(
        "feature-pipeline final-resolve requires a validated Luna audit synthesis.",
      );
    } else if (run.definition === PLAN_PIPELINE_ID) {
      const currentIndex = PIPELINE_STAGES.indexOf(run.stage);
      const nextIndex = PIPELINE_STAGES.indexOf(stage);
      if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
        throw new Error(
          `Invalid plan-pipeline stage transition: ${run.stage} to ${stage}.`,
        );
      }
      if (stage === "build") {
        this.requireValidReports(run, PLAN_PIPELINE_DISCOVERY_ROLES, stage);
      } else if (stage === "audit" && run.planArtifactsWritten.size === 0) {
        throw new Error("Cannot enter audit before writing a plan artifact.");
      } else if (stage === "audit-resolve") {
        this.requireValidReports(run, PLAN_PIPELINE_AUDIT_ROLES, stage);
      } else if (
        stage === "final-audit" &&
        run.planArtifactsWritten.size === 0
      ) {
        throw new Error(
          "Cannot enter final-audit before writing a plan artifact.",
        );
      } else if (stage === "final-resolve" && !run.auditSegment?.finalReport) {
        throw new Error(
          "plan-pipeline final-resolve requires a validated Luna audit synthesis.",
        );
      }
    }
    run.stage = stage;
    this.notify();
    return this.snapshot(run);
  }

  async spawnChild(
    runId: string,
    role: PipelineChildRole,
    additionalContext = "",
  ) {
    return this.spawnChildForRun(
      this.requireActiveRun(runId),
      role,
      additionalContext,
      false,
    );
  }

  private spawnChildForRun(
    run: MutableRun,
    role: PipelineChildRole,
    additionalContext: string,
    controllerOwnedDiscovery: boolean,
  ) {
    const runId = run.id;
    if (!roleBelongsToDefinition(run.definition, role)) {
      throw new Error(`Unsupported ${run.definition} child role "${role}".`);
    }
    if (
      run.definition === AUDIT_PIPELINE_ID ||
      role === AUDIT_SYNTHESIS_ROLE ||
      ((run.definition === FEATURE_PIPELINE_ID ||
        run.definition === PLAN_PIPELINE_ID) &&
        PIPELINE_4_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role) &&
        run.stage === "final-audit")
    ) {
      throw new Error(`${role} is controller-owned by the Luna audit segment.`);
    }
    if (!run.rootId)
      throw new Error(`Pipeline run "${runId}" has no root yet.`);
    const priorAttempts = this.agentsFor(runId).filter(
      (agent) => agent.role === role,
    );
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(role)
    ) {
      if (!controllerOwnedDiscovery) {
        throw new Error(
          `${role} is controller-owned and unavailable to feature-pipeline Sol.`,
        );
      }
      if (run.stage !== "discover" || run.featureDiscoveryBootstrapped) {
        throw new Error(
          `${role} can only start during controller-owned feature discovery bootstrap.`,
        );
      }
    }
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      PIPELINE_4_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role) &&
      run.stage !== "audit"
    ) {
      throw new Error(
        `${role} can only start during feature-pipeline stage audit.`,
      );
    }
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      const requiredStage =
        role === SMALL_FEATURE_IMPLEMENTER_ROLE ? "build" : "final-audit";
      if (run.stage !== requiredStage) {
        throw new Error(
          `${role} can only start during small-feature-pipeline stage ${requiredStage}.`,
        );
      }
      if (priorAttempts.length > 0) {
        throw new Error(
          `small-feature-pipeline role ${role} already has its allowed child session.`,
        );
      }
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (PIPELINE_4_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role)) {
        throw new Error(
          `${role} is controller-owned by the Luna audit segment.`,
        );
      }
      const requiredStage = role.startsWith("discover-") ? "discover" : "audit";
      if (run.stage !== requiredStage) {
        throw new Error(
          `${role} can only start during plan-pipeline stage ${requiredStage}.`,
        );
      }
      const latest = priorAttempts.at(-1);
      const replacementAllowed =
        priorAttempts.length === 1 &&
        latest?.status === "error" &&
        !latest.sessionFile;
      if (priorAttempts.length > 0 && !replacementAllowed) {
        throw new Error(
          `plan-pipeline role ${role} already has its allowed child session.`,
        );
      }
    }
    const attempt = priorAttempts.length + 1;
    const contextPolicy = childContextPolicyFor(run.definition, role);
    const priorReportRole = contextPolicy.priorReportRole;
    const priorReport = priorReportRole
      ? this.agentsFor(runId).find((agent) => agent.role === priorReportRole)
      : undefined;
    const promptContext = [
      ...(priorReport && priorReportRole
        ? [`${titleForRole(priorReportRole)} report:`, priorReport.finalText]
        : []),
      ...(contextPolicy.gitEvidence ? [this.gitEvidence(runId)] : []),
      additionalContext,
    ]
      .filter((item) => item.trim())
      .join("\n");
    const spec = {
      scopeId: runId,
      parentId: run.rootId,
      role,
      attempt,
      title: titleForRole(role),
      model: modelForRole(role),
      cwd: run.request.workingDir,
      prompt: buildPipelineChildPrompt(
        run.definition,
        role,
        run.request,
        promptContext,
      ),
      persistent:
        run.definition === SMALL_FEATURE_PIPELINE_ID &&
        role === SMALL_FEATURE_IMPLEMENTER_ROLE,
      shouldStart: () => run.status === "starting" || run.status === "running",
    };
    return this.tree.spawn(spec);
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
    const children = await this.tree.wait(ids, signal);
    const run = this.requireRun(runId);
    if (
      run.definition === SMALL_FEATURE_PIPELINE_ID &&
      (run.status === "starting" || run.status === "running")
    ) {
      const invalid = children.find((child) => {
        if (child.status === "error" || child.status === "cancelled") {
          return true;
        }
        return (
          validatePipelineReport(run.definition, child.role, child.finalText)
            .length > 0
        );
      });
      if (invalid) {
        this.failRun(
          run,
          `small-feature-pipeline child ${invalid.role} did not complete with a valid report.`,
          true,
        );
        return children;
      }
    }
    if (run.status === "starting" || run.status === "running") {
      this.advanceStageAfterFanIn(run, children);
    }
    return children;
  }

  async sendChild(runId: string, id: string, text: string) {
    const run = this.requireActiveRun(runId);
    const agent = this.getAgent(runId, id);
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    if (
      agent.role === AUDIT_SYNTHESIS_ROLE ||
      [...(run.auditSegment?.tracks.values() ?? [])].includes(id)
    ) {
      throw new Error(
        "Controller-owned audit segment sessions cannot be retried or continued.",
      );
    }
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(agent.role)
    ) {
      throw new Error(
        "feature-pipeline discovery retries are controller-owned and unavailable to Sol.",
      );
    }
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      if (agent.role !== SMALL_FEATURE_IMPLEMENTER_ROLE) {
        throw new Error(
          "small-feature-pipeline audit children cannot be retried or continued.",
        );
      }
      if (run.stage !== "final-resolve") {
        throw new Error(
          "small-feature-pipeline Luna remediation can only run during final-resolve.",
        );
      }
      this.requireValidReports(run, PIPELINE_4_LUNA_AUDIT_ROLES, run.stage);
      if (agent.status !== "idle") {
        throw new Error(
          "small-feature-pipeline Luna must be idle before remediation.",
        );
      }
      if ((this.childContinuations.get(id) ?? 0) >= 1) {
        throw new Error(
          "small-feature-pipeline Luna already completed its remediation pass.",
        );
      }
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (agent.role === "final-audit") {
        throw new Error("plan-pipeline final-audit cannot be retried.");
      }
      if ((this.childContinuations.get(id) ?? 0) >= 1) {
        throw new Error(`plan-pipeline child "${id}" already used its retry.`);
      }
      const issues = validatePipelineReport(
        run.definition,
        agent.role,
        agent.finalText,
      );
      const retryable =
        agent.status === "error" ||
        ((agent.status === "done" || agent.status === "idle") &&
          issues.length > 0);
      if (!retryable) {
        throw new Error(
          `plan-pipeline child "${id}" has no failed or malformed report to retry.`,
        );
      }
    }
    const continuationText =
      run.definition === SMALL_FEATURE_PIPELINE_ID
        ? [
            "Independent Luna audit reports to resolve:",
            ...PIPELINE_4_LUNA_AUDIT_ROLES.flatMap((role) => [
              `${titleForRole(role)}:`,
              this.agentsFor(runId).find((candidate) => candidate.role === role)
                ?.finalText ?? "",
            ]),
            "Sol remediation instruction:",
            text,
          ].join("\n")
        : text;
    await this.tree.send(id, continuationText);
    if (
      run.definition === PLAN_PIPELINE_ID ||
      run.definition === SMALL_FEATURE_PIPELINE_ID
    ) {
      this.childContinuations.set(
        id,
        (this.childContinuations.get(id) ?? 0) + 1,
      );
    }
    return this.getAgent(runId, id);
  }

  async cancelChild(runId: string, id: string) {
    const run = this.requireRun(runId);
    const agent = this.getAgent(runId, id);
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    if (
      agent.role === AUDIT_SYNTHESIS_ROLE ||
      [...(run.auditSegment?.tracks.values() ?? [])].includes(id)
    ) {
      throw new Error(
        "Controller-owned audit segment sessions can only be cancelled with the whole pipeline run.",
      );
    }
    return this.tree.cancel(id);
  }

  writePlan(runId: string, planPath: string, content: string) {
    const run = this.requireActiveRun(runId);
    if (run.definition !== PLAN_PIPELINE_ID) {
      throw new Error("Plan artifacts can only be written by plan-pipeline.");
    }
    const artifact = writePlanArtifact(
      run.request.workingDir,
      planPath,
      content,
    );
    run.planArtifactsWritten.set(artifact.relativePath, {
      digest: artifact.digest,
      device: artifact.device,
      inode: artifact.inode,
    });
    return artifact;
  }

  validatePlan(runId: string, planPath: string) {
    const run = this.requireActiveRun(runId);
    if (run.definition !== PLAN_PIPELINE_ID) {
      throw new Error("Plan artifacts can only be validated by plan-pipeline.");
    }
    return resolvePlanArtifact(run.request.workingDir, planPath);
  }

  gitStatus(runId: string) {
    const run = this.requireActiveRun(runId);
    try {
      return execFileSync("git", ["status", "--short", "--branch"], {
        cwd: run.request.workingDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      return `Git status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private gitEvidence(runId: string) {
    const run = this.requireActiveRun(runId);
    return [
      "Workspace review base:",
      run.baseSha,
      "Workspace review head:",
      "WORKTREE",
      "Workspace Git status:",
      this.gitStatus(runId),
      "Workspace Git diff:",
      this.gitDiff(runId),
    ].join("\n");
  }

  private gitDiff(runId: string) {
    const run = this.requireActiveRun(runId);
    try {
      const revision = run.baseSha === "UNAVAILABLE" ? [] : [run.baseSha];
      return execFileSync(
        "git",
        ["diff", "--no-ext-diff", "--no-color", ...revision, "--"],
        {
          cwd: run.request.workingDir,
          encoding: "utf8",
          maxBuffer: 128 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
        .trim()
        .slice(0, 64 * 1024);
    } catch (error) {
      return `Git diff unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
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
    let completion = facts;
    if (run.definition === AUDIT_PIPELINE_ID) {
      throw new Error(
        "audit-pipeline completion is controller-owned and requires a validated final synthesis report.",
      );
    }
    if (run.definition === SMALL_FEATURE_PIPELINE_ID) {
      if (run.stage !== "complete") {
        throw new Error(
          "small-feature-pipeline must finish same-session Luna remediation before completion.",
        );
      }
      this.requireValidReports(
        run,
        SMALL_FEATURE_PIPELINE_CHILD_ROLES,
        "complete",
      );
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (run.stage !== "complete") {
        throw new Error("plan-pipeline must enter complete before completion.");
      }
      this.requireValidReports(
        run,
        [...PLAN_PIPELINE_DISCOVERY_ROLES, ...PLAN_PIPELINE_AUDIT_ROLES],
        "complete",
      );
      if (!run.auditSegment?.finalReport) {
        throw new Error(
          "plan-pipeline completion requires a validated Luna audit synthesis.",
        );
      }
      if (!facts.planPath) {
        throw new Error("plan-pipeline completion requires plan_path.");
      }
      const artifact = resolvePlanArtifact(
        run.request.workingDir,
        facts.planPath,
      );
      const written = run.planArtifactsWritten.get(artifact.relativePath);
      if (!written) {
        throw new Error(
          "plan_path must identify an artifact written by this plan-pipeline run.",
        );
      }
      if (
        written.digest !== artifact.digest ||
        written.device !== artifact.device ||
        written.inode !== artifact.inode
      ) {
        throw new Error(
          "plan_path changed after this plan-pipeline run wrote it.",
        );
      }
      completion = {
        ...facts,
        planPath: artifact.relativePath,
        changedPaths: [
          ...new Set([...facts.changedPaths, artifact.relativePath]),
        ],
      };
    } else if (
      run.definition === FEATURE_PIPELINE_ID &&
      !run.auditSegment?.finalReport
    ) {
      throw new Error(
        "feature-pipeline completion requires a validated Luna audit synthesis.",
      );
    }
    run.stage = "complete";
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = completion;
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
    run.status = "cancelled";
    run.finishedAt = Date.now();
    this.notify();
    await this.cancelActiveChildren(run);
    if (run.rootId) await this.tree.cancel(run.rootId);
    this.deliver(run);
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
    const run = this.requireRun(runId);
    const roles = rolesForDefinition(run.definition).filter(
      (role) =>
        role !== AUDIT_SYNTHESIS_ROLE &&
        !(
          run.definition === PLAN_PIPELINE_ID &&
          PIPELINE_4_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role)
        ),
    );
    const tools: ToolDefinition[] = [
      defineTool({
        name: "pipeline_stage",
        label: "Pipeline Stage",
        description: `Record the current ${run.definition} stage.`,
        parameters: Type.Object({
          stage: StringEnum(stagesForDefinition(run.definition)),
        }),
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
        description: `Start one allowed agent-driven ${run.definition} Luna role.`,
        parameters: Type.Object({
          role: StringEnum(roles),
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
          const issues =
            child.role === AUDIT_SYNTHESIS_ROLE
              ? []
              : validatePipelineReport(
                  run.definition,
                  child.role,
                  child.finalText,
                );
          const warning = issues.length
            ? `\n\n[Report contract violation: ${issues.join(" ")}]`
            : "";
          return {
            content: [
              {
                type: "text",
                text: `${child.id} [${child.status}] ${child.role} attempt ${child.attempt}\n\n${child.error ?? (child.finalText || "(no report yet)")}${warning}`.slice(
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
          "Wait for known children, return their reports in this Sol context, and atomically enter the next stage when the full current-stage fan-in is valid.",
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
                  .map((child) => {
                    const issues =
                      child.role === AUDIT_SYNTHESIS_ROLE
                        ? []
                        : validatePipelineReport(
                            run.definition,
                            child.role,
                            child.finalText,
                          );
                    const warning = issues.length
                      ? `\n\n[Report contract violation: ${issues.join(" ")}]`
                      : "";
                    return `## ${child.id} · ${child.role} · attempt ${child.attempt} · ${child.status}\n\n${child.error ?? (child.finalText || "(no report)")}${warning}`;
                  })
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
            ...(params.plan_path ? { planPath: params.plan_path } : {}),
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
    if (
      run.definition === FEATURE_PIPELINE_ID ||
      run.definition === PLAN_PIPELINE_ID
    ) {
      tools.splice(
        tools.length - 1,
        0,
        defineTool({
          name: "pipeline_audit_start",
          label: "Start Luna Audit Segment",
          description:
            "Start this hardcoded pipeline's controller-owned four-track Luna final audit and persistent incremental synthesizer.",
          parameters: Type.Object(
            {
              acceptance_contract: Type.String({
                minLength: 1,
                maxLength: 64 * 1024,
              }),
              assumptions: Type.Array(
                Type.String({ minLength: 1, maxLength: 8 * 1024 }),
                { maxItems: 128 },
              ),
              checks_evidence: Type.Array(
                Type.String({ minLength: 1, maxLength: 8 * 1024 }),
                { maxItems: 128 },
              ),
            },
            { additionalProperties: false },
          ),
          async execute(_toolId, params) {
            const agents = await controller.startFinalAudit(runId, {
              acceptanceContract: params.acceptance_contract,
              assumptions: params.assumptions,
              checks: params.checks_evidence,
            });
            return {
              content: [
                {
                  type: "text",
                  text: `Started controller-owned Luna audit segment: ${agents
                    .map((agent) => agent.id)
                    .join(", ")}.`,
                },
              ],
              details: {
                runId,
                agents: agents.map((agent) => ({
                  id: agent.id,
                  role: agent.role,
                  model: agent.model,
                })),
              },
            };
          },
        }),
      );
    }
    if (run.definition === PLAN_PIPELINE_ID) {
      tools.splice(
        1,
        0,
        defineTool({
          name: "pipeline_plan_write",
          label: "Write Pipeline Plan",
          description:
            "Write or replace this run's validated repository-local docs/plans Markdown artifact.",
          parameters: Type.Object({
            path: Type.String({ minLength: 1, maxLength: 16_384 }),
            content: Type.String({ minLength: 1, maxLength: 1024 * 1024 }),
          }),
          async execute(_toolId, params) {
            const artifact = controller.writePlan(
              runId,
              params.path,
              params.content,
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Validated plan written: ${artifact.relativePath}`,
                },
              ],
              details: {
                runId,
                path: artifact.relativePath,
                bytes: Buffer.byteLength(artifact.content, "utf8"),
              },
            };
          },
        }),
        defineTool({
          name: "pipeline_plan_validate",
          label: "Validate Pipeline Plan",
          description:
            "Freshly validate one repository-local docs/plans Markdown artifact without modifying it.",
          parameters: Type.Object({
            path: Type.String({ minLength: 1, maxLength: 16_384 }),
          }),
          async execute(_toolId, params) {
            const artifact = controller.validatePlan(runId, params.path);
            return {
              content: [
                {
                  type: "text",
                  text: `Plan contract passed: ${artifact.relativePath} (${Buffer.byteLength(artifact.content, "utf8")} bytes).`,
                },
              ],
              details: { runId, path: artifact.relativePath },
            };
          },
        }),
        defineTool({
          name: "pipeline_git_status",
          label: "Pipeline Git Status",
          description:
            "Read the planning workspace Git branch and changed-path state without modifying it.",
          parameters: Type.Object({}),
          async execute() {
            const status = controller.gitStatus(runId);
            return {
              content: [
                { type: "text", text: status || "Working tree clean." },
              ],
              details: { runId },
            };
          },
        }),
      );
    }
    return tools;
  }

  async dispose() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.tree.dispose();
    this.listeners.clear();
  }
}
