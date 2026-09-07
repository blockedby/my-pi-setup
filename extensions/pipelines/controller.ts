import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { captureReviewIdentity } from "./review-identity.ts";
import { createRunEvidenceHandoff } from "./run-evidence-handoff.ts";
import { assessExecutionEvidence } from "./execution-evidence-assessment.ts";
import { assessImplementationEvidence } from "./implementation-evidence-assessment.ts";
import {
  assessAcceptance,
  type AcceptanceEnvelope,
  type AcceptanceIdentity,
} from "./run-acceptance.ts";
import {
  createRunEvidenceJournal,
  type RunEventInput,
} from "./run-evidence.ts";
import {
  createRunArtifactStore,
  type RunArtifactStore,
} from "./run-artifacts.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  defineTool,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AgentTreeController } from "../shared/agent-tree/control.ts";
import type {
  AgentNodeSnapshot,
  TreeEvidenceEvent,
  AgentTreeSessionFactory,
} from "../shared/agent-tree/domain.ts";
import {
  AUDIT_PIPELINE_ID,
  AUDIT_SEGMENT_LUNA_ROLES,
  AUDIT_SYNTHESIS_ROLE,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_FINALIZER_ROLE,
  FEATURE_PLAN_ROLES,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  FEATURE_PIPELINE_ID,
  LUNA_MODEL,
  STATIC_LUNA_AUDIT_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  PLAN_PIPELINE_ID,
  PLAN_PIPELINE_SYNTHESIS_ROLE,
  ASTRA_MODEL,
  type PlanPipelineDiscoveryRole,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  SMALL_FEATURE_PIPELINE_ID,
  assertPipelineGitCommitSupported,
  assertPipelineName,
  isCanonicalPipelineRunId,
  PIPELINE_ID_ATTEMPTS,
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
  type FeaturePipelineGraphSnapshot,
  type FeaturePipelinePlanningSnapshot,
  type FeaturePlanRole,
  type PipelineChildRole,
  type PipelineCompletionFacts,
  type PipelineDefinitionId,
  type PipelineHandoff,
  type PipelineRunRequest,
  type PipelineRunSnapshot,
  type PipelineStage,
  type PipelineExecutionPartial,
  type PipelineWallclockLimitation,
} from "./domain.ts";
import {
  resolvePlanOutputPath,
  validatePipelineReport,
  writePlanOutput,
} from "./plan-contract.ts";
import {
  parseFeatureDiscoveryReport,
  parseFeatureDiscoveryReportText,
  validateFeatureDiscoveryFanIn,
  type FeatureDiscoveryReportV2,
} from "./discovery-report.ts";
import {
  parsePlanDiscoveryReport,
  parsePlanDiscoveryReportText,
  type PlanDiscoveryReport,
  type PlanDiscoveryReportContext,
} from "./plan-discovery-report.ts";
import {
  buildFeatureCandidatePlanPrompt,
  buildFeatureCanonicalPlanPrompt,
  buildFeatureExecutionGraphPrompt,
  buildFeatureFinalReviewPrompt,
  buildFeaturePipelinePrompt,
  buildPipelineChildPrompt,
  buildPipelinePrompt,
  type FeatureDiscoveryReportContext,
} from "./prompt.ts";
import {
  FEATURE_PLANNING_CORRECTION_TURNS,
  parseFeatureCandidatePlanForRole,
  parseFeatureCandidatePlanText,
  parseFeatureCanonicalPlan,
  parseFeatureCanonicalPlanText,
  parseFeatureExecutionGraph,
  parseFeatureExecutionGraphText,
  type FeatureCandidatePlan,
  type FeatureCanonicalPlan,
  type FeatureExecutionGraph,
  type FeaturePlanCandidateRole,
} from "./feature-planning.ts";
import { validateAndCompileFeatureExecutionGraph } from "./feature-graph.ts";
import { buildFeatureAuditHandoff } from "./feature-audit-handoff.ts";
import {
  verifyPlanningReadinessSource,
  type PlanningReadinessCheck,
} from "./planning-readiness.ts";
import type { PlanningReadinessResult } from "./domain.ts";
import {
  runFeatureSandboxCommand,
  cleanupFeatureSandboxRuntime,
} from "./feature-sandbox.ts";
import {
  createFeatureReviewRuntime,
  executeFeatureGraph,
  type FeatureGraphExecutionResult,
  type FeatureReviewRuntime,
  type FeatureTaskSessionInput,
  type FeatureTaskSessionOutcome,
  type FeatureTaskToolHost,
} from "./feature-runtime.ts";
import {
  defaultFeatureGitOperations,
  type FeatureCallerWorktree,
  type FeatureGitOperations,
} from "./feature-worktrees.ts";
import {
  AuditSegment,
  buildAuditTrackPrompt,
  type AuditGitIdentity,
  type AuditSegmentContext,
} from "./audit-segment.ts";
import { assertImplementationPipelineWorkspace } from "./worktree-preflight.ts";
import {
  canonicalPipelineId,
  securePipelineToken,
} from "./pipeline-identity.ts";
import {
  parsePipelineWallclockLimit,
  stageTimingAt,
  systemPipelineMonotonicClock,
  systemPipelineWallclockScheduler,
  timedPipelineStage,
  type PipelineMonotonicClock,
  type PipelineStageTiming,
  type PipelineWallclockScheduler,
  type PipelineWallclockState,
} from "./wallclock.ts";

const CLEANUP_TIMEOUT_MS = 5_000;

export function pipelineDiscoveryToolAllowed(
  definition: PipelineDefinitionId,
  role: string,
  stage: PipelineStage,
  bootstrapped: boolean,
) {
  if (definition === PLAN_PIPELINE_ID) {
    return (
      (stage === "discover" &&
        PLAN_PIPELINE_DISCOVERY_ROLES.some(
          (discoveryRole) => discoveryRole === role,
        )) ||
      (stage === "synthesize" && role === PLAN_PIPELINE_SYNTHESIS_ROLE)
    );
  }
  if (definition !== FEATURE_PIPELINE_ID) return false;
  if (
    stage === "plan" &&
    (role === FEATURE_FINALIZER_ROLE ||
      FEATURE_PLAN_ROLES.some((planRole) => planRole === role))
  ) {
    return bootstrapped;
  }
  if (stage !== "discover") return false;
  return (
    !bootstrapped &&
    FEATURE_PIPELINE_DISCOVERY_ROLES.some(
      (discoveryRole) => discoveryRole === role,
    )
  );
}

export function pipelineDiscoverySubmissionAllowed(
  definition: PipelineDefinitionId,
  role: string,
  stage: PipelineStage,
  bootstrapped: boolean,
) {
  if (definition === PLAN_PIPELINE_ID) {
    return pipelineDiscoveryToolAllowed(definition, role, stage, bootstrapped);
  }
  if (!pipelineDiscoveryToolAllowed(definition, role, stage, bootstrapped)) {
    return false;
  }
  return stage === "plan" ? bootstrapped : !bootstrapped;
}

export function pipelineAuditSubmissionAllowed(
  definition: PipelineDefinitionId,
  role: string,
  segmentActive: boolean,
) {
  const definitionUsesSegment =
    definition === AUDIT_PIPELINE_ID || definition === FEATURE_PIPELINE_ID;
  if (!definitionUsesSegment) return false;
  if (role === AUDIT_SYNTHESIS_ROLE) {
    return definition === AUDIT_PIPELINE_ID || segmentActive;
  }
  return (
    segmentActive &&
    AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)
  );
}

function isFeatureDiscoveryRole(
  role: string,
): role is FeaturePipelineDiscoveryRole {
  return (FEATURE_PIPELINE_DISCOVERY_ROLES as ReadonlyArray<string>).includes(
    role,
  );
}

function isFeatureInternalImplementationRole(role: string) {
  return (
    role === FEATURE_FINALIZER_ROLE ||
    FEATURE_PLAN_ROLES.some((planRole) => planRole === role) ||
    role.startsWith("feature-task-") ||
    role.startsWith("feature-conflict-") ||
    role.startsWith("feature-join-repair-")
  );
}

function deferredSignal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scopedSessionTitle(runId: string, title: string) {
  return `${title} · ${runId}`;
}

function boundedPipelineError(error: unknown) {
  return truncateHead(error instanceof Error ? error.message : String(error), {
    maxBytes: 16 * 1024,
    maxLines: 200,
  }).content;
}

interface MutableRun {
  evidenceHandoff?: ReturnType<typeof createRunEvidenceHandoff>;
  evidenceManifest?: Awaited<ReturnType<RunArtifactStore["manifest"]>>;
  graphEvidence?: Array<
    import("./feature-graph-executor.ts").FeatureGraphEvidenceEvent
  >;
  acceptance?: AcceptanceEnvelope;
  reviewedIdentity?: AcceptanceIdentity;
  finalIdentity?: AcceptanceIdentity;
  evidence?: ReturnType<typeof createRunEvidenceJournal>;
  evidenceStore?: RunArtifactStore;
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
  rootReady: Promise<void>;
  resolveRootReady: () => void;
  wallclockLimitMs?: number;
  wallclockStartedAtMs: number;
  stageTiming?: PipelineStageTiming;
  wallclockProjection?: PipelineWallclockState;
  wallclockTimerCancel?: () => void;
  warningTimerCancel?: () => void;
  warnedSessions: Set<string>;
  pendingWarnings: Set<string>;
  executionPartials: Map<string, PipelineExecutionPartial>;
  executionSessionTokens: Map<string, string>;
  executionSessionEpochs: Map<string, number>;
  limitation?: PipelineWallclockLimitation;
  limiting?: boolean;
  cleanup?: Promise<void>;
  lastMonotonicNow?: number;
  cancellation?: Promise<PipelineRunSnapshot>;
  featureDiscoveryBootstrapped: boolean;
  featureDiscoveryReports: Map<
    FeaturePipelineDiscoveryRole,
    FeatureDiscoveryReportContext
  >;
  planDiscoveryReports: Map<
    PlanPipelineDiscoveryRole,
    PlanDiscoveryReportContext
  >;
  planText?: string;
  planWrittenPath?: string;
  featureCaller?: FeatureCallerWorktree;
  planningReadiness?: PlanningReadinessResult[];
  readinessQueue?: Promise<void>;
  readinessRuntimeUsed?: boolean;
  featureSynthesisChecks: ReadonlyArray<string>;
  featurePlanning?: FeaturePipelinePlanningSnapshot;
  featureCandidatePlans?: ReadonlyArray<FeatureCandidatePlan>;
  featureCanonicalPlan?: FeatureCanonicalPlan;
  featureExecutionGraph?: FeatureExecutionGraph;
  featureGraph?: FeaturePipelineGraphSnapshot;
  featureExecution?: FeatureGraphExecutionResult;
  featureExecutionPromise?: Promise<FeatureGraphExecutionResult>;
  featureReviewRuntime?: FeatureReviewRuntime;
  featureTaskHosts: Map<string, FeatureTaskToolHost>;
  featureAbortController?: AbortController;
  featureArtifactDir?: string;
  auditSegment?: AuditSegment;
  auditSegmentStarting?: Promise<ReadonlyArray<AgentNodeSnapshot>>;
  finalAuditReportDelivered: boolean;
  completion?: PipelineCompletionFacts;
}

function finalAuditResolutionHandoff(run: MutableRun) {
  const report = run.auditSegment?.finalReport;
  if (run.stage !== "final-resolve" || !report) return undefined;
  return `VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION
The controller received and validated the structured final audit report below. Its findings are authoritative input for this final-resolve turn even when the synthesis session has empty finalText. Evaluate and resolve every concrete finding now; fix it or reject it with specific evidence, run appropriate checks, and do not start another audit.
${JSON.stringify(report)}
END_VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION`;
}

function requireFinalFindingResolutionEvidence(
  run: MutableRun,
  facts: PipelineCompletionFacts,
) {
  const expectedIds = (run.auditSegment?.finalReport?.findings ?? []).map(
    ({ id }) => id,
  );
  const resolutions = facts.finalFindingResolutions ?? [];
  const actualIds = resolutions.map(({ findingId }) => findingId);
  const invalid = resolutions.some(
    ({ disposition, evidence, verification }) =>
      (disposition !== "fixed" && disposition !== "rejected") ||
      !evidence.trim() ||
      verification.length === 0 ||
      verification.some((item) => !item.trim()),
  );
  if (
    invalid ||
    new Set(actualIds).size !== actualIds.length ||
    actualIds.length !== expectedIds.length ||
    expectedIds.some((id) => !actualIds.includes(id)) ||
    actualIds.some((id) => !expectedIds.includes(id))
  ) {
    throw new Error(
      `pipeline_complete final_finding_resolutions must contain exactly one structured fixed/rejected record with non-empty evidence and verification for every delivered final-audit finding ID: ${expectedIds.join(", ") || "(none)"}.`,
    );
  }
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
    auditSubmit?: (
      runId: string,
      role: string,
      sessionToken: string,
      value: unknown,
    ) => void,
    auditSessionCreated?: (runId: string, role: string, token: string) => void,
    auditToolAllowed?: (runId: string, role: string) => boolean,
    discoverySubmit?: (
      runId: string,
      role: string,
      sessionToken: string,
      value: unknown,
    ) => void,
    discoverySessionCreated?: (
      runId: string,
      role: string,
      token: string,
    ) => void,
    discoveryToolAllowed?: (runId: string, role: string) => boolean,
    executionFinish?: (
      runId: string,
      role: string,
      sessionToken: string,
      value: unknown,
    ) => void,
    executionFinishSessionCreated?: (
      runId: string,
      role: string,
      token: string,
      sessionId: string,
    ) => void,
    featureTaskHost?: (
      runId: string,
      role: string,
    ) => FeatureTaskToolHost | undefined,
    artifactTools?: (
      runId: string,
      role: string,
    ) => ReadonlyArray<ToolDefinition>,
    planningReadinessCheck?: (
      runId: string,
      role: string,
      token: string,
      input: PlanningReadinessCheck,
      signal?: AbortSignal,
    ) => Promise<PlanningReadinessResult>,
  ) => AgentTreeSessionFactory;
  readonly onHandoff: (handoff: PipelineHandoff) => void | Promise<void>;
  readonly makeRunId?: (pipelineName: string) => string;
  readonly makeRunToken?: () => string;
  readonly makeAgentId?: () => string;
  readonly featureGit?: FeatureGitOperations;
  readonly monotonicClock?: PipelineMonotonicClock;
  readonly wallclockScheduler?: PipelineWallclockScheduler;
  readonly executeFeatureGraph?: typeof executeFeatureGraph;
  readonly createFeatureReviewRuntime?: typeof createFeatureReviewRuntime;
  readonly artifactRoot?: string;
  readonly runPlanningReadinessCommand?: typeof runFeatureSandboxCommand;
  /** Concise aliases used by deterministic controller fixtures. */
  readonly clock?: PipelineMonotonicClock;
  readonly scheduler?: PipelineWallclockScheduler;
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
    final_finding_resolutions: Type.Optional(
      Type.Array(
        Type.Object(
          {
            finding_id: Type.String({ minLength: 1, maxLength: 256 }),
            disposition: Type.Union([
              Type.Literal("fixed"),
              Type.Literal("rejected"),
            ]),
            evidence: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
            verification: Type.Array(
              Type.String({ minLength: 1, maxLength: 8 * 1024 }),
              { minItems: 1, maxItems: 64 },
            ),
          },
          { additionalProperties: false },
        ),
        { maxItems: 128 },
      ),
    ),
    working_dir: Type.String({ maxLength: 16_384 }),
  });
}

export class PipelineController {
  private readonly runs = new Map<string, MutableRun>();
  private readonly listeners = new Set<() => void>();
  private readonly handoffs = new Set<string>();
  private readonly childContinuations = new Map<string, number>();
  private readonly auditPumps = new Map<string, Promise<void>>();
  private readonly auditCorrections = new Map<string, number>();
  private readonly auditSessionTokens = new Map<string, string>();
  private readonly discoveryCorrections = new Map<string, number>();
  private readonly featureSynthesisCorrections = new Map<string, number>();
  private readonly discoverySessionTokens = new Map<string, string>();
  private readonly discoverySubmissions = new Map<string, unknown>();
  private readonly clock: PipelineMonotonicClock;
  private readonly scheduler: PipelineWallclockScheduler;
  private readonly executionSessionTokens = new Map<string, string>();
  private readonly executionSessionEpochs = new Map<string, number>();
  private readonly executionPartials = new Map<
    string,
    PipelineExecutionPartial
  >();
  private readonly tree: AgentTreeController;
  private readonly onHandoff: PipelineControllerOptions["onHandoff"];
  private readonly featureGit: FeatureGitOperations;
  private readonly featureGraphExecutor: typeof executeFeatureGraph;
  private readonly featureReviewRuntimeFactory: typeof createFeatureReviewRuntime;
  private readonly artifactRoot: string;
  private readonly makeRunId: (pipelineName: string) => string;
  private shuttingDown = false;

  constructor(options: PipelineControllerOptions) {
    this.onHandoff = options.onHandoff;
    this.readinessCommand =
      options.runPlanningReadinessCommand ?? runFeatureSandboxCommand;
    this.clock =
      options.monotonicClock ?? options.clock ?? systemPipelineMonotonicClock;
    this.scheduler =
      options.wallclockScheduler ??
      options.scheduler ??
      systemPipelineWallclockScheduler;
    this.makeRunId =
      options.makeRunId ??
      ((pipelineName) =>
        canonicalPipelineId(
          pipelineName,
          (options.makeRunToken ?? securePipelineToken)(),
        ));
    this.featureGit = options.featureGit ?? defaultFeatureGitOperations;
    this.featureGraphExecutor =
      options.executeFeatureGraph ?? executeFeatureGraph;
    this.featureReviewRuntimeFactory =
      options.createFeatureReviewRuntime ?? createFeatureReviewRuntime;
    this.artifactRoot =
      options.artifactRoot ??
      path.join(os.homedir(), ".pipi", "agent", "pipelines");
    this.tree = new AgentTreeController({
      observer: (event) => this.recordTreeEvidence(event),
      onEvidenceError: (error, event) =>
        this.runs.get(event.scopeId ?? "")?.evidence?.markIncomplete(error),
      factory: options.createSessionFactory(
        (runId) => this.createRootTools(runId),
        (runId) => this.requireRun(runId).definition,
        (runId, role, token, value) =>
          this.submitAuditReport(runId, role, token, value),
        (runId, role, token) =>
          this.registerAuditSessionToken(runId, role, token),
        (runId, role) => {
          const run = this.requireRun(runId);
          return pipelineAuditSubmissionAllowed(
            run.definition,
            role,
            Boolean(run.auditSegment),
          );
        },
        (runId, role, token, value) =>
          this.submitDiscoveryReport(runId, role, token, value),
        (runId, role, token) =>
          this.registerDiscoverySessionToken(runId, role, token),
        (runId, role) => {
          const run = this.requireRun(runId);
          if (run.status !== "starting" && run.status !== "running") {
            return false;
          }
          if (
            run.definition === PLAN_PIPELINE_ID &&
            role === PLAN_PIPELINE_SYNTHESIS_ROLE
          ) {
            // The deferred synthesis session is created before discovery so it
            // can own the six children; its typed tool settles only in synthesize.
            return true;
          }
          return pipelineDiscoveryToolAllowed(
            run.definition,
            role,
            run.stage,
            run.featureDiscoveryBootstrapped,
          );
        },
        (runId, role, token, value) =>
          this.submitExecutionFinish(runId, role, token, value),
        (runId, role, token, sessionId) =>
          this.registerExecutionSessionToken(runId, role, token, sessionId),
        (runId, role) => this.runs.get(runId)?.featureTaskHosts.get(role),
        (runId, role) =>
          role === AUDIT_SYNTHESIS_ROLE
            ? this.createRootTools(runId).filter(
                (tool) => tool.name === "pipeline_artifact_read",
              )
            : [],
        (runId, role, token, input, signal) =>
          this.checkPlanningReadiness(runId, role, token, input, signal),
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

  private monotonicNow(run?: MutableRun) {
    const observed = this.clock.now();
    const safe = Number.isFinite(observed) && observed >= 0 ? observed : 0;
    if (!run) return safe;
    const previous = run.lastMonotonicNow ?? safe;
    run.lastMonotonicNow = Math.max(previous, safe);
    return run.lastMonotonicNow;
  }

  private stageTimingFor(run: MutableRun, now = this.monotonicNow(run)) {
    if (!run.stageTiming) return undefined;
    if (run.status !== "starting" && run.status !== "running") {
      return run.stageTiming;
    }
    const projected = stageTimingAt(run.stageTiming, now);
    if (projected.warningReached && !run.stageTiming.warningReached) {
      run.stageTiming = projected;
    }
    return projected;
  }

  private wallclockStateFor(run: MutableRun, now = this.monotonicNow(run)) {
    const timing = this.stageTimingFor(run, now);
    const limitMs = run.wallclockLimitMs;
    if (!timing || limitMs === undefined) return run.wallclockProjection;
    return {
      limitMs,
      runStartedAtMs: run.wallclockStartedAtMs,
      runElapsedMs: Math.max(0, now - run.wallclockStartedAtMs),
      stageElapsedMs: timing.elapsedMs,
      remainingMs: timing.remainingMs,
      warningReached: timing.warningReached,
      warningAtMs: timing.warningAtMs,
      deadlineAtMs: timing.deadlineAtMs,
      stage: timing.stage,
      epoch: timing.epoch,
    } satisfies PipelineWallclockState;
  }

  private cancelStageTimers(run: MutableRun) {
    run.warningTimerCancel?.();
    run.wallclockTimerCancel?.();
    run.warningTimerCancel = undefined;
    run.wallclockTimerCancel = undefined;
  }

  private scheduleStageTimers(run: MutableRun) {
    this.cancelStageTimers(run);
    const timing = run.stageTiming;
    if (!timing) return;
    const schedule = (atMs: number, callback: (epoch: number) => void) => {
      const delay = Math.max(0, atMs - this.monotonicNow(run));
      return this.scheduler.schedule(delay, () => {
        if (run.stageTiming?.epoch !== timing.epoch) return;
        const now = this.monotonicNow(run);
        if (now < atMs) {
          const retry = schedule(atMs, callback);
          if (atMs === timing.warningAtMs) run.warningTimerCancel = retry;
          else run.wallclockTimerCancel = retry;
          return;
        }
        callback(timing.epoch);
      });
    };
    run.warningTimerCancel = schedule(timing.warningAtMs, (epoch) =>
      this.handleStageWarning(run, epoch),
    );
    run.wallclockTimerCancel = schedule(timing.deadlineAtMs, (epoch) =>
      this.handleStageDeadline(run, epoch),
    );
  }

  private enterStage(
    run: MutableRun,
    stage: PipelineStage,
    startedAtMs?: number,
  ) {
    if (
      run.stage === stage &&
      (run.wallclockLimitMs === undefined ||
        run.stageTiming ||
        stage === "complete")
    ) {
      this.syncWarnings(run);
      return;
    }
    this.cancelStageTimers(run);
    const previousStage = run.stage;
    run.stage = stage;
    this.recordEvidence(run, {
      kind: "stage_entered",
      facts: { previousStage, stage },
    });
    const limitMs = run.wallclockLimitMs;
    if (limitMs !== undefined && timedPipelineStage(run.definition, stage)) {
      const stageStartedAtMs = startedAtMs ?? this.monotonicNow(run);
      const epoch = (run.stageTiming?.epoch ?? 0) + 1;
      const warningOffset = Math.floor((limitMs * 4) / 5);
      run.stageTiming = {
        definition: run.definition,
        stage,
        epoch,
        startedAtMs: stageStartedAtMs,
        warningAtMs: stageStartedAtMs + warningOffset,
        deadlineAtMs: stageStartedAtMs + limitMs,
        warningReached: false,
        elapsedMs: 0,
        remainingMs: limitMs,
        limited: false,
      };
      run.warnedSessions.clear();
      run.pendingWarnings.clear();
      for (const [token, sessionId] of run.executionSessionTokens) {
        const agent = this.tree.view.get(sessionId);
        if (agent && this.sessionStage(run, agent.role) === stage) {
          this.executionSessionEpochs.set(token, epoch);
          run.executionSessionEpochs.set(token, epoch);
        }
      }
      this.scheduleStageTimers(run);
    } else {
      const now = this.monotonicNow(run);
      const prior = run.stageTiming;
      run.stageTiming = undefined;
      run.wallclockProjection = prior
        ? {
            limitMs: prior.deadlineAtMs - prior.startedAtMs,
            runStartedAtMs: run.wallclockStartedAtMs,
            runElapsedMs: Math.max(0, now - run.wallclockStartedAtMs),
            stageElapsedMs: Math.max(0, now - prior.startedAtMs),
            remainingMs: 0,
            warningReached: prior.warningReached || now >= prior.warningAtMs,
            warningAtMs: prior.warningAtMs,
            deadlineAtMs: prior.deadlineAtMs,
            stage,
            epoch: prior.epoch,
          }
        : run.wallclockProjection;
    }
    this.notify();
  }

  private sessionStage(
    run: MutableRun,
    role: string,
  ): PipelineStage | undefined {
    if (role === FEATURE_FINALIZER_ROLE) {
      return run.stage === "plan" || run.stage === "review"
        ? run.stage
        : undefined;
    }
    if (FEATURE_PLAN_ROLES.some((planRole) => planRole === role)) return "plan";
    if (
      role.startsWith("feature-task-") ||
      role.startsWith("feature-conflict-") ||
      role.startsWith("feature-join-repair-")
    ) {
      return "build";
    }
    if (role === PLAN_PIPELINE_SYNTHESIS_ROLE) return "synthesize";
    if (role === AUDIT_SYNTHESIS_ROLE) {
      if (run.definition === AUDIT_PIPELINE_ID) return "audit";
      return run.stage === "audit" || run.stage === "audit-resolve"
        ? run.stage
        : "final-audit";
    }
    if (role.startsWith("discover-")) return "discover";
    if (role === SMALL_FEATURE_IMPLEMENTER_ROLE)
      return run.stage === "final-resolve" ? "final-resolve" : "build";
    if (role.startsWith("audit-")) {
      if (run.definition === AUDIT_PIPELINE_ID) return "audit";
      if (run.definition === SMALL_FEATURE_PIPELINE_ID) return "final-audit";
      return run.stage === "final-audit" || run.stage === "final-resolve"
        ? "final-audit"
        : "audit";
    }
    if (role === "pipeline-root") return run.stage;
    return undefined;
  }

  private warningText(run: MutableRun) {
    return `Controller warning: stage ${run.stage} has reached 80% of its shared wallclock budget. Finish cooperatively with pipeline_execution_finish if useful, then stop; the controller will not treat partial output as a report.`;
  }

  private applyWarningToAgent(run: MutableRun, agent: AgentNodeSnapshot) {
    const timing = run.stageTiming;
    if (!timing || !timing.warningReached) return;
    if (this.sessionStage(run, agent.role) !== run.stage) return;
    const key = `${timing.epoch}:${agent.id}`;
    if (run.warnedSessions.has(key) || run.pendingWarnings.has(key)) return;
    if (agent.status === "running") {
      run.warnedSessions.add(key);
      void this.tree.send(agent.id, this.warningText(run)).catch(() => {});
    } else if (agent.status === "starting" || agent.status === "idle") {
      run.pendingWarnings.add(key);
    }
  }

  private syncWarnings(run: MutableRun) {
    const timing = this.stageTimingFor(run);
    if (!timing?.warningReached) return;
    for (const agent of this.agentsFor(run.id))
      this.applyWarningToAgent(run, agent);
  }

  private handleStageWarning(run: MutableRun, epoch: number) {
    if (run.status !== "starting" && run.status !== "running") return;
    if (run.stageTiming?.epoch !== epoch) return;
    const now = this.monotonicNow(run);
    if (now < run.stageTiming.warningAtMs) {
      this.scheduleStageTimers(run);
      return;
    }
    run.stageTiming = stageTimingAt(run.stageTiming, now);
    this.syncWarnings(run);
    this.notify();
  }

  private handleStageDeadline(run: MutableRun, epoch: number) {
    if (run.status !== "starting" && run.status !== "running") return;
    if (run.stageTiming?.epoch !== epoch) return;
    const now = this.monotonicNow(run);
    if (now < run.stageTiming.deadlineAtMs) {
      this.scheduleStageTimers(run);
      return;
    }
    this.settleLimited(run, epoch, now);
  }

  private registerExecutionSessionToken(
    runId: string,
    role: string,
    token: string,
    sessionId: string,
  ) {
    const run = this.requireRun(runId);
    if (run.status !== "starting" && run.status !== "running") return;
    const node = this.tree.view.get(sessionId);
    const epoch = run.stageTiming?.epoch;
    if (
      node?.scopeId === runId &&
      node.role === role &&
      node.status === "starting" &&
      epoch !== undefined
    ) {
      this.executionSessionTokens.set(token, node.id);
      this.executionSessionEpochs.set(token, epoch);
      run.executionSessionTokens.set(token, node.id);
      run.executionSessionEpochs.set(token, epoch);
    }
  }

  private clearExecutionRunState(run: MutableRun) {
    for (const [token, sessionId] of run.executionSessionTokens) {
      this.executionSessionTokens.delete(token);
      this.executionSessionEpochs.delete(token);
      run.executionSessionTokens.delete(token);
      run.executionSessionEpochs.delete(token);
      this.executionPartials.delete(sessionId);
    }
  }

  private submitExecutionFinish(
    runId: string,
    role: string,
    token: string,
    value: unknown,
  ) {
    const run = this.requireActiveRun(runId);
    const sessionId = this.executionSessionTokens.get(token);
    const registeredEpoch = this.executionSessionEpochs.get(token);
    const node = sessionId ? this.tree.view.get(sessionId) : undefined;
    const timing = run.stageTiming;
    if (
      !sessionId ||
      !node ||
      node.scopeId !== runId ||
      node.role !== role ||
      node.status !== "running" ||
      !timing ||
      registeredEpoch !== timing.epoch ||
      this.sessionStage(run, role) !== run.stage
    ) {
      throw new Error("Pipeline execution finish session is not active.");
    }
    const key = `${timing.epoch}:${sessionId}`;
    if (run.executionPartials.has(key)) {
      throw new Error(
        "This pipeline session already recorded a partial finish.",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Pipeline execution finish must be an object.");
    }
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "summary" && key !== "output")) {
      throw new Error("Pipeline execution finish contains unsupported fields.");
    }
    const summary = Reflect.get(value, "summary");
    const output = Reflect.get(value, "output");
    if (
      (summary !== undefined && typeof summary !== "string") ||
      (output !== undefined && typeof output !== "string") ||
      (summary === undefined && output === undefined) ||
      (typeof summary === "string" &&
        !summary.trim() &&
        typeof output === "string" &&
        !output.trim())
    ) {
      throw new Error(
        "Pipeline execution finish needs non-empty bounded output.",
      );
    }
    const bound = (candidate: unknown, maxBytes: number) => {
      if (typeof candidate !== "string" || !candidate.trim()) return undefined;
      const bounded = truncateHead(candidate, {
        maxBytes,
        maxLines: 200,
      });
      return { value: bounded.content, truncated: bounded.truncated };
    };
    const boundedSummary = bound(summary, 8 * 1024);
    const boundedOutput = bound(output, 32 * 1024);
    if (!boundedSummary && !boundedOutput)
      throw new Error(
        "Pipeline execution finish needs non-empty bounded output.",
      );
    const partial: PipelineExecutionPartial = {
      sessionId,
      role,
      stage: run.stage,
      epoch: timing.epoch,
      ...(boundedSummary ? { summary: boundedSummary.value } : {}),
      ...(boundedOutput ? { output: boundedOutput.value } : {}),
      truncated: Boolean(boundedSummary?.truncated || boundedOutput?.truncated),
      atMs: this.monotonicNow(run),
    };
    run.executionPartials.set(key, partial);
    this.executionPartials.set(sessionId, partial);
  }

  private hasExecutionPartial(run: MutableRun, sessionId: string) {
    const epoch = run.stageTiming?.epoch;
    return (
      epoch !== undefined && run.executionPartials.has(`${epoch}:${sessionId}`)
    );
  }

  private async waitUntilRunStops(run: MutableRun) {
    if (run.status !== "starting" && run.status !== "running") return;
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (run.status !== "starting" && run.status !== "running") {
          unsubscribe();
          resolve();
        }
      });
      if (run.status !== "starting" && run.status !== "running") {
        unsubscribe();
        resolve();
      }
    });
  }

  private validatedProgress(run: MutableRun) {
    const progress: string[] = [];
    for (const role of [...run.featureDiscoveryReports.keys()])
      progress.push(`Validated discovery report: ${role}.`);
    for (const role of [...run.planDiscoveryReports.keys()])
      progress.push(`Validated plan discovery report: ${role}.`);
    const audit = run.auditSegment?.progress();
    if (audit) {
      progress.push(
        `Validated audit progress: ${audit.integratedReportCount} report(s) integrated across revision ${audit.revision}.`,
      );
    }
    return progress.slice(0, 64);
  }

  private fallbackPartials(run: MutableRun, timing: PipelineStageTiming) {
    const eligible = (agent: AgentNodeSnapshot | undefined) =>
      agent && agent.status !== "error" && agent.status !== "cancelled";
    const known = [...run.executionPartials.values()].filter((partial) =>
      eligible(this.tree.view.get(partial.sessionId)),
    );
    const knownSessions = new Set(known.map((partial) => partial.sessionId));
    for (const agent of this.agentsFor(run.id)) {
      if (!eligible(agent)) continue;
      if (knownSessions.has(agent.id)) continue;
      if (this.sessionStage(run, agent.role) !== timing.stage) continue;
      const output = agent.liveAssistant?.text.trim() || agent.finalText.trim();
      if (!output) continue;
      const bounded = truncateHead(output, {
        maxBytes: 32 * 1024,
        maxLines: 200,
      });
      known.push({
        sessionId: agent.id,
        role: agent.role,
        stage: timing.stage,
        epoch: timing.epoch,
        output: bounded.content,
        truncated: bounded.truncated,
        atMs: this.monotonicNow(run),
      });
    }
    // Keep the limitation record small even when a graph has many attempts.
    return known.slice(0, 16);
  }

  private settleLimited(run: MutableRun, epoch: number, now: number) {
    if (run.status !== "starting" && run.status !== "running") return false;
    if (run.limiting) return false;
    const timing = run.stageTiming;
    const limitMs = run.wallclockLimitMs;
    if (
      !timing ||
      limitMs === undefined ||
      timing.epoch !== epoch ||
      now < timing.deadlineAtMs
    )
      return false;
    run.limiting = true;
    const finalTiming = stageTimingAt(timing, now);
    // A reordered scheduler may deliver the deadline callback first. The
    // warning boundary is still authoritative and must not be skipped.
    run.stageTiming = finalTiming;
    this.syncWarnings(run);
    const partials = this.fallbackPartials(run, finalTiming);
    const validatedProgress = this.validatedProgress(run);
    const unresolvedItems = [
      `Stage ${finalTiming.stage} exhausted its ${limitMs}ms wallclock budget before the pipeline completed.`,
      ...partials.map(
        (partial) =>
          `Partial output from ${partial.role} is provenance only and was not accepted as a report.`,
      ),
    ].slice(0, 64);
    const limitation: PipelineWallclockLimitation = {
      reason: "stage-deadline",
      stage: finalTiming.stage,
      epoch: finalTiming.epoch,
      limitMs,
      warningAtMs: finalTiming.warningAtMs,
      deadlineAtMs: finalTiming.deadlineAtMs,
      elapsedMs: finalTiming.elapsedMs,
      validatedProgress,
      unresolvedItems,
      partials,
    };
    this.cancelStageTimers(run);
    run.stageTiming = { ...finalTiming, limited: true };
    run.wallclockProjection = this.wallclockStateFor(run, now);
    run.limitation = limitation;
    run.status = "limited";
    run.featureAbortController?.abort();
    run.finishedAt = Date.now();
    run.error = "Pipeline stage wallclock limit reached.";
    run.resolveRootReady();
    this.clearDiscoveryRunState(run.id);
    this.clearExecutionRunState(run);
    this.notify();
    void this.cleanupTerminal(run, true).then(
      () => this.deliver(run),
      () => this.deliver(run),
    );
    return true;
  }

  private startDeferred(run: MutableRun, id: string, text: string) {
    this.settleDue(run);
    if (run.status !== "starting" && run.status !== "running") {
      return Promise.reject(
        new Error(`Pipeline run "${run.id}" is ${run.status}.`),
      );
    }
    const timing = run.stageTiming;
    if (timing) {
      for (const [token, sessionId] of run.executionSessionTokens) {
        if (sessionId !== id) continue;
        this.executionSessionEpochs.set(token, timing.epoch);
        run.executionSessionEpochs.set(token, timing.epoch);
      }
    }
    const key = timing ? `${timing.epoch}:${id}` : undefined;
    const warned = key ? run.pendingWarnings.delete(key) : false;
    if (warned) {
      run.warnedSessions.add(key!);
      return this.tree
        .startDeferred(id, `${this.warningText(run)}\n\n${text}`)
        .catch((error) => {
          run.warnedSessions.delete(key!);
          run.pendingWarnings.add(key!);
          throw error;
        });
    }
    return this.tree.startDeferred(id, text);
  }

  private registerDiscoverySessionToken(
    runId: string,
    role: string,
    token: string,
  ) {
    const run = this.requireRun(runId);
    if (run.status !== "starting" && run.status !== "running") return;
    const allowed =
      run.definition === PLAN_PIPELINE_ID &&
      role === PLAN_PIPELINE_SYNTHESIS_ROLE
        ? true
        : run.definition === FEATURE_PIPELINE_ID &&
            role === FEATURE_FINALIZER_ROLE
          ? true
          : pipelineDiscoveryToolAllowed(
              run.definition,
              role,
              run.stage,
              run.featureDiscoveryBootstrapped,
            );
    if (!allowed) return;
    const node = this.agentsFor(runId)
      .filter((agent) => agent.role === role && agent.status === "starting")
      .at(-1);
    if (node) this.discoverySessionTokens.set(token, node.id);
  }

  private clearDiscoverySessionTokens(sessionId: string) {
    for (const [token, registeredSessionId] of this.discoverySessionTokens) {
      if (registeredSessionId === sessionId) {
        this.discoverySessionTokens.delete(token);
      }
    }
  }

  private clearDiscoveryRunState(runId: string) {
    const sessionIds = new Set(this.agentsFor(runId).map((agent) => agent.id));
    for (const sessionId of sessionIds) {
      this.discoverySubmissions.delete(sessionId);
      this.discoveryCorrections.delete(sessionId);
      this.featureSynthesisCorrections.delete(sessionId);
      this.clearDiscoverySessionTokens(sessionId);
    }
    this.requireRun(runId).planDiscoveryReports.clear();
  }

  private async checkPlanningReadiness(
    runId: string,
    role: string,
    token: string,
    input: PlanningReadinessCheck,
    signal?: AbortSignal,
  ) {
    input = structuredClone(input);
    const run = this.requireActiveRun(runId);
    const authorize = () => {
      const sessionId = this.discoverySessionTokens.get(token);
      const node = sessionId ? this.tree.view.get(sessionId) : undefined;
      if (
        run.definition !== FEATURE_PIPELINE_ID ||
        role !== "discover-context" ||
        run.status !== "running" ||
        !pipelineDiscoverySubmissionAllowed(
          run.definition,
          role,
          run.stage,
          run.featureDiscoveryBootstrapped,
        ) ||
        !node ||
        node.scopeId !== runId ||
        node.role !== role ||
        node.status !== "running" ||
        this.discoverySubmissions.has(node.id)
      ) {
        throw new Error(
          "Planning readiness is not active for this discovery session.",
        );
      }
      if (signal?.aborted || run.featureAbortController?.signal.aborted)
        throw new Error("Planning readiness cancelled.");
      return node.id;
    };
    authorize();
    const operation = (run.readinessQueue ?? Promise.resolve()).then(
      async () => {
        const sessionId = authorize();
        const startedAt = Date.now();
        let sourceHash: string | undefined;
        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;
        let error: string | undefined;
        try {
          if ((run.planningReadiness?.length ?? 0) >= 12)
            throw new Error("Planning readiness check limit reached.");
          const verified = await verifyPlanningReadinessSource(
            run.request.workingDir,
            input,
          );
          sourceHash = verified.sourceHash;
          if (
            /\b(?:bun|npm|pnpm|yarn|vp)\s+(?:run\s+)?(?:install(?::[\w-]+)?|add|bootstrap|setup)(?:\s|$)/i.test(
              input.command,
            )
          ) {
            throw new Error(
              "Readiness checks cannot install dependencies or bootstrap the repository.",
            );
          }
          const assertCaller = () => {
            const observed = this.featureGit.preflight(run.request.workingDir);
            const expected = run.featureCaller;
            if (
              !expected ||
              observed.workingDir !== expected.workingDir ||
              observed.repositoryRoot !== expected.repositoryRoot ||
              observed.commonGitDir !== expected.commonGitDir ||
              observed.branchRef !== expected.branchRef ||
              observed.baseCommit !== expected.baseCommit
            ) {
              throw new Error(
                "Implementation worktree identity changed during planning readiness.",
              );
            }
          };
          assertCaller();
          run.readinessRuntimeUsed = true;
          this.recordEvidence(run, {
            kind: "planning_readiness_started",
            sessionId,
            role,
            detail: input.command.slice(0, 2048),
            facts: {
              cwd: input.cwd.slice(0, 2048),
              source: input.source.path.slice(0, 2048),
            },
          });
          const abortSignals = [
            signal,
            run.featureAbortController?.signal,
          ].filter((value): value is AbortSignal => Boolean(value));
          const result = await this.readinessCommand({
            workspaceRoot: run.request.workingDir,
            cwd: input.cwd,
            command: input.command,
            signal: AbortSignal.any(abortSignals),
          });
          ({ stdout, stderr, exitCode } = result);
          assertCaller();
          if (signal?.aborted || run.featureAbortController?.signal.aborted)
            throw new Error("Planning readiness cancelled.");
          if (exitCode !== 0)
            error = `Command exited with code ${exitCode ?? "unknown"}.`;
        } catch (failure) {
          error =
            boundedPipelineError(failure) ||
            "Planning readiness command failed.";
        }
        const result: PlanningReadinessResult = {
          ...structuredClone(input),
          sourceHash,
          workspaceRoot: run.request.workingDir,
          status: error ? "failed" : "passed",
          exitCode,
          stdout,
          stderr,
          startedAt,
          finishedAt: Date.now(),
          ...(error ? { error } : {}),
        };
        (run.planningReadiness ??= []).push(result);
        this.recordEvidence(run, {
          kind: "planning_readiness_finished",
          sessionId,
          role,
          detail: error?.slice(0, 2048),
          facts: {
            command: input.command.slice(0, 2048),
            status: result.status,
            exitCode,
          },
        });
        try {
          if (!run.evidenceStore)
            throw new Error(
              "Planning readiness artifact store is unavailable.",
            );
          await run.evidenceStore.writeSnapshot({
            artifactId: "planning-readiness",
            schemaVersion: 1,
            value: run.planningReadiness,
          });
        } catch (failure) {
          run.evidence?.markIncomplete(boundedPipelineError(failure));
          this.failRun(
            run,
            `Planning readiness evidence could not be persisted: ${boundedPipelineError(failure)}`,
            true,
          );
        }
        this.notify();
        if (result.status === "failed") {
          this.failRun(
            run,
            [
              "Repository readiness failed during discovery; implementation was not started.",
              `Worktree: ${result.workspaceRoot}`,
              `Command: ${result.command}`,
              `Source: ${result.source.path}`,
              `Exit code: ${result.exitCode ?? "unknown"}`,
              result.error,
              result.stderr.slice(0, 4096),
              "Captured stdout/stderr: pipeline_artifact_read, artifactId planning-readiness.",
            ]
              .filter(Boolean)
              .join("\n"),
            true,
          );
        }
        const clip = (text: string) =>
          text.length > 4096
            ? `${text.slice(0, 4096)}\n[Display truncated; read planning-readiness artifact for captured output.]`
            : text;
        return {
          ...result,
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
        };
      },
    );
    run.readinessQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private submitDiscoveryReport(
    runId: string,
    role: string,
    token: string,
    value: unknown,
  ) {
    const run = this.requireActiveRun(runId);
    if (
      !pipelineDiscoverySubmissionAllowed(
        run.definition,
        role,
        run.stage,
        run.featureDiscoveryBootstrapped,
      )
    ) {
      throw new Error("Pipeline discovery submission is not active.");
    }
    const sessionId = this.discoverySessionTokens.get(token);
    const node = sessionId ? this.tree.view.get(sessionId) : undefined;
    if (
      !sessionId ||
      !node ||
      node.scopeId !== runId ||
      node.role !== role ||
      node.status !== "running"
    ) {
      throw new Error("Discovery submission session is not registered.");
    }
    if (this.discoverySubmissions.has(sessionId)) {
      throw new Error("This discovery turn already recorded a submission.");
    }
    this.discoverySubmissions.set(sessionId, value);
    this.recordEvidence(run, { kind: "submission_received", sessionId, role });
  }

  private registerAuditSessionToken(
    runId: string,
    role: string,
    token: string,
  ) {
    const node = this.agentsFor(runId)
      .filter((agent) => agent.role === role && agent.status === "starting")
      .at(-1);
    if (node) this.auditSessionTokens.set(token, node.id);
  }

  private submitAuditReport(
    runId: string,
    role: string,
    token: string,
    value: unknown,
  ) {
    const run = this.requireActiveRun(runId);
    const segment = run.auditSegment;
    if (!segment) throw new Error("No audit segment is active.");
    const sessionId = this.auditSessionTokens.get(token);
    const registeredRole = sessionId
      ? segment.roleForSession(sessionId)
      : undefined;
    if (!sessionId || registeredRole !== role) {
      throw new Error("Audit submission session is not registered.");
    }
    segment.submit(sessionId, value);
    this.recordEvidence(run, { kind: "submission_received", sessionId, role });
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

  private settleDue(run: MutableRun) {
    if (run.status !== "starting" && run.status !== "running") return;
    const timing = run.stageTiming;
    if (!timing) return;
    const now = this.monotonicNow(run);
    if (now >= timing.deadlineAtMs) this.settleLimited(run, timing.epoch, now);
  }

  list() {
    for (const run of this.runs.values()) this.settleDue(run);
    return [...this.runs.values()]
      .map((run) => this.snapshot(run))
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  get(runId: string) {
    const run = this.runs.get(runId);
    if (run) this.settleDue(run);
    return run ? this.snapshot(run) : undefined;
  }

  private snapshot(run: MutableRun): PipelineRunSnapshot {
    const wallclock = this.wallclockStateFor(run);
    const stageTiming = this.stageTimingFor(run);
    const partials = run.limitation?.partials ?? [
      ...run.executionPartials.values(),
    ];
    return {
      ...(run.acceptance
        ? { acceptance: structuredClone(run.acceptance) }
        : {}),
      id: run.id,
      definition: run.definition,
      workingDir: run.request.workingDir,
      stage: run.stage,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      ...(run.wallclockLimitMs !== undefined
        ? { wallclockLimitMs: run.wallclockLimitMs }
        : {}),
      ...(wallclock
        ? {
            runElapsedMs: wallclock.runElapsedMs,
            stageElapsedMs: wallclock.stageElapsedMs,
            remainingMs: wallclock.remainingMs,
            warningReached: wallclock.warningReached,
            warningAtMs: wallclock.warningAtMs,
            deadlineAtMs: wallclock.deadlineAtMs,
            wallclock,
          }
        : {}),
      ...(stageTiming ? { stageTiming } : {}),
      ...(run.limitation ? { limitation: run.limitation } : {}),
      ...(partials.length > 0 ? { partials } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.rootId ? { rootId: run.rootId } : {}),
      ...(run.completion ? { completion: run.completion } : {}),
      ...(run.auditSegment
        ? { auditSegment: run.auditSegment.progress() }
        : {}),
      ...(run.featureGraph ? { featureGraph: run.featureGraph } : {}),
      ...(run.planningReadiness
        ? { planningReadiness: structuredClone(run.planningReadiness) }
        : {}),
      agents: this.agentsFor(run.id),
    };
  }

  async readArtifact(
    runId: string,
    request?: import("./run-artifacts.ts").ReadRunArtifactRequest,
  ) {
    const run = this.requireRun(runId);
    if (!run.evidenceStore)
      throw new Error("Evidence storage unavailable for this run.");
    return request
      ? run.evidenceStore.read(request)
      : run.evidenceStore.manifest();
  }

  private readonly evidenceControllerInstanceId = randomUUID();
  private readonly evidenceAcceptedSubmissions = new Set<string>();
  private readonly evidenceChecks = new Set<string>();
  private readonly evidenceSubmissions = new Map<string, string>();
  private readonly evidenceTurns = new Map<string, number>();
  private readonly evidenceRoleTasks = new Map<string, string>();

  private recordTreeEvidence(event: TreeEvidenceEvent) {
    const run = this.runs.get(event.scopeId ?? "");
    if (!run?.evidence) return;
    if (run.evidence.sealed) return;
    if (event.type === "session_event" && event.event.type === "run_started") {
      this.evidenceTurns.set(
        event.nodeId,
        (this.evidenceTurns.get(event.nodeId) ?? 0) + 1,
      );
    }
    const turn = this.evidenceTurns.get(event.nodeId);
    const facts: NonNullable<RunEventInput["facts"]> = {
      requestedModel: event.requestedModel,
      attempt: event.attempt,
      thinkingLevel: event.thinkingLevel ?? null,
    };
    let kind: string = event.type;
    let detail: string | undefined;
    if (event.type === "session_created") {
      facts.provider = event.executionMetadata?.provider ?? null;
      facts.model = event.executionMetadata?.model ?? null;
      facts.selectedThinkingLevel =
        event.executionMetadata?.thinkingLevel ?? null;
      facts.servingRevision = event.executionMetadata?.servingRevision ?? null;
    }
    if (event.type === "spawn_failed") detail = event.error;
    if (event.type === "session_event") {
      kind = event.event.type;
      if (event.event.type === "tool") {
        facts.toolName = event.event.name;
        facts.toolCallId = event.event.toolCallId;
        facts.phase = event.event.phase;
        facts.isError = event.event.isError;
        kind = event.event.isError ? "tool_failed" : "tool_observed";
      }
      if (event.event.type === "settled") {
        facts.outcome = event.event.outcome.type;
        if (event.event.outcome.type === "failed")
          detail = event.event.outcome.error;
      }
    }
    this.recordEvidence(run, {
      kind,
      sessionId: event.nodeId,
      role: event.role,
      taskId: this.evidenceRoleTasks.get(`${run.id}:${event.role}`),
      attemptId: `${event.nodeId}:attempt-${event.attempt}`,
      ...(turn ? { turnId: `${event.nodeId}:turn-${turn}` } : {}),
      facts,
      ...(detail ? { detail: detail.slice(0, 2048) } : {}),
    });
  }

  private recordEvidence(run: MutableRun, event: RunEventInput) {
    const turn = event.sessionId
      ? this.evidenceTurns.get(event.sessionId)
      : undefined;
    const submissionKey = `${run.id}:${event.sessionId}:${turn ?? 0}`;
    if (event.kind === "submission_accepted") {
      if (this.evidenceAcceptedSubmissions.has(submissionKey)) return undefined;
      this.evidenceAcceptedSubmissions.add(submissionKey);
    }
    let submissionId: string | undefined;
    if (event.kind.startsWith("submission_")) {
      submissionId =
        this.evidenceSubmissions.get(submissionKey) ?? randomUUID();
      if (event.kind === "submission_received")
        this.evidenceSubmissions.set(submissionKey, submissionId);
      else this.evidenceSubmissions.delete(submissionKey);
    }
    return run.evidence?.append({
      ...(event.sessionId
        ? {
            attemptId: `${event.sessionId}:attempt-${this.tree?.view.get(event.sessionId)?.attempt ?? 1}`,
          }
        : {}),
      ...(turn && event.sessionId
        ? { turnId: `${event.sessionId}:turn-${turn}` }
        : {}),
      ...(submissionId ? { submissionId } : {}),
      ...event,
    });
  }

  private persistFeatureArtifact(
    run: MutableRun,
    name: string,
    value: unknown,
  ) {
    if (!run.featureArtifactDir) {
      throw new Error("Feature artifact directory is unavailable.");
    }
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    fs.writeFileSync(path.join(run.featureArtifactDir, name), serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  }

  private updateFeaturePlanning(
    run: MutableRun,
    update: Partial<
      Pick<FeaturePipelinePlanningSnapshot, "canonical" | "graph" | "review">
    > & {
      readonly candidates?: FeaturePipelinePlanningSnapshot["candidates"];
    },
  ) {
    if (!run.featurePlanning) return;
    run.featurePlanning = { ...run.featurePlanning, ...update };
    if (run.featureGraph) {
      run.featureGraph = { ...run.featureGraph, planning: run.featurePlanning };
    }
    this.notify();
  }

  private allocateRunId(
    pipelineName: string,
    featureCaller?: FeatureCallerWorktree,
    worktreeRoot?: string,
  ) {
    for (let attempt = 0; attempt < PIPELINE_ID_ATTEMPTS; attempt++) {
      const id = this.makeRunId(pipelineName);
      if (!isCanonicalPipelineRunId(id, pipelineName)) {
        throw new Error(
          `Pipeline run ID generator returned an invalid ID; expected ${pipelineName}- followed by exactly eight lowercase hexadecimal characters.`,
        );
      }
      if (this.runs.has(id)) continue;
      if (
        featureCaller &&
        !this.featureGit.namespaceAvailable(featureCaller, id)
      ) {
        continue;
      }
      if (
        worktreeRoot &&
        (fs.existsSync(path.join(worktreeRoot, id)) ||
          fs.existsSync(path.join(this.artifactRoot, id)))
      ) {
        continue;
      }
      return id;
    }
    throw new Error(
      `Unable to allocate a unique pipeline run ID and feature namespace after ${PIPELINE_ID_ATTEMPTS} attempts. No pipeline state was created.`,
    );
  }

  start(request: PipelineRunRequest) {
    assertPipelineName(request.pipelineName);
    // Parse before any Git preflight, namespace probe, run insertion, session
    // creation, or feature worktree mutation. This ordering is part of the
    // admission contract, not merely a schema convenience.
    const wallclockLimitMs = parsePipelineWallclockLimit(
      request.wallclockLimit,
    );
    if (this.shuttingDown)
      throw new Error("Pipeline controller is shutting down.");
    const definition = request.pipeline ?? FEATURE_PIPELINE_ID;
    if (definition === PLAN_PIPELINE_ID) {
      if (
        !Object.prototype.hasOwnProperty.call(request, "planPath") ||
        (request.planPath !== null && typeof request.planPath !== "string")
      ) {
        throw new Error(
          "plan-pipeline requires an explicit planPath string or null.",
        );
      }
      if (request.planPath !== null) {
        resolvePlanOutputPath(request.workingDir, request.planPath);
      }
    } else if (request.planPath !== undefined && request.planPath !== null) {
      throw new Error(
        `planPath is only valid for plan-pipeline; received ${definition}.`,
      );
    }
    assertPipelineGitCommitSupported(definition, request.gitCommit === true);
    let worktreeRoot: string | undefined;
    if (definition === FEATURE_PIPELINE_ID) {
      if (!Object.prototype.hasOwnProperty.call(request, "worktreeRoot")) {
        throw new Error("feature-pipeline requires worktreeRoot.");
      }
      if (!request.worktreeRoot || !path.isAbsolute(request.worktreeRoot)) {
        throw new Error(
          "feature-pipeline worktreeRoot must be an absolute path to an existing directory.",
        );
      }
      if (
        !fs.existsSync(request.worktreeRoot) ||
        !fs.statSync(request.worktreeRoot).isDirectory()
      ) {
        throw new Error(
          `feature-pipeline worktreeRoot is not an existing directory: ${request.worktreeRoot}`,
        );
      }
      if (!Array.isArray(request.worktreePrepare)) {
        throw new Error(
          "feature-pipeline requires worktreePrepare as an explicit ordered array (empty is allowed).",
        );
      }
      if (
        request.worktreePrepare.length > 64 ||
        request.worktreePrepare.some(
          (command) =>
            typeof command !== "string" ||
            !command.trim() ||
            Buffer.byteLength(command, "utf8") > 32 * 1024,
        )
      ) {
        throw new Error(
          "feature-pipeline worktreePrepare must contain at most 64 non-empty commands of at most 32 KiB each.",
        );
      }
      worktreeRoot = fs.realpathSync.native(request.worktreeRoot);
    } else if (
      request.worktreeRoot !== undefined ||
      request.worktreePrepare !== undefined
    ) {
      throw new Error(
        `worktreeRoot and worktreePrepare are only valid for feature-pipeline; received ${definition}.`,
      );
    }
    const featureCaller =
      definition === FEATURE_PIPELINE_ID
        ? this.featureGit.preflight(request.workingDir)
        : undefined;
    if (featureCaller) {
      const occupyingRun = [...this.runs.values()].find(
        (candidate) =>
          candidate.definition === FEATURE_PIPELINE_ID &&
          candidate.featureCaller?.workingDir === featureCaller.workingDir &&
          !this.handoffs.has(candidate.id),
      );
      if (occupyingRun) {
        throw new Error(
          `feature-pipeline working_dir is already leased by run "${occupyingRun.id}" until its terminal handoff completes.`,
        );
      }
    }
    const effectiveRequest = featureCaller
      ? {
          ...request,
          workingDir: featureCaller.workingDir,
          worktreeRoot,
          worktreePrepare: [...(request.worktreePrepare ?? [])],
        }
      : request;
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
    if (definition === SMALL_FEATURE_PIPELINE_ID) {
      assertImplementationPipelineWorkspace(definition, request.workingDir);
    }
    const normalizedRequest =
      definition === AUDIT_PIPELINE_ID
        ? { ...effectiveRequest, audit }
        : effectiveRequest;
    const id = this.allocateRunId(
      request.pipelineName,
      featureCaller,
      worktreeRoot,
    );
    const featureArtifactDir = featureCaller
      ? path.join(this.artifactRoot, id)
      : undefined;
    if (featureCaller && worktreeRoot && featureArtifactDir) {
      fs.mkdirSync(this.artifactRoot, { recursive: true });
      fs.mkdirSync(path.join(worktreeRoot, id));
      try {
        fs.mkdirSync(featureArtifactDir);
      } catch (error) {
        fs.rmdirSync(path.join(worktreeRoot, id));
        throw error;
      }
    }
    const rootReady = deferredSignal();
    const wallclockStartedAtMs = this.monotonicNow();
    const run: MutableRun = {
      id,
      definition,
      request: {
        ...normalizedRequest,
        gitCommit: normalizedRequest.gitCommit === true,
      },
      baseSha:
        featureCaller?.baseCommit ?? gitHead(effectiveRequest.workingDir),
      stage: initialStageForDefinition(definition),
      status: "starting",
      startedAt: Date.now(),
      rootReady: rootReady.promise,
      resolveRootReady: rootReady.resolve,
      featureDiscoveryBootstrapped: false,
      featureDiscoveryReports: new Map(),
      planDiscoveryReports: new Map(),
      ...(featureCaller ? { featureCaller } : {}),
      ...(featureArtifactDir ? { featureArtifactDir } : {}),
      featureSynthesisChecks: [],
      featureTaskHosts: new Map(),
      ...(featureCaller
        ? { featureAbortController: new AbortController() }
        : {}),
      ...(featureCaller
        ? {
            featurePlanning: {
              candidates: FEATURE_PLAN_ROLES.map((role) => ({
                role,
                status: "waiting" as const,
              })),
              canonical: "waiting" as const,
              graph: "waiting" as const,
              review: "waiting" as const,
            },
          }
        : {}),
      finalAuditReportDelivered: false,
      ...(wallclockLimitMs !== undefined ? { wallclockLimitMs } : {}),
      wallclockStartedAtMs,
      warnedSessions: new Set(),
      pendingWarnings: new Set(),
      executionPartials: new Map(),
      executionSessionTokens: new Map(),
      executionSessionEpochs: new Map(),
      lastMonotonicNow: wallclockStartedAtMs,
    };
    this.runs.set(id, run);
    let evidenceSequence = 0;
    let evidenceStoreError: unknown;
    try {
      run.evidenceStore = createRunArtifactStore({
        rootDir: this.artifactRoot,
        runId: id,
      });
    } catch (error) {
      evidenceStoreError = error;
    }
    run.evidence = createRunEvidenceJournal({
      controllerInstanceId: this.evidenceControllerInstanceId,
      runId: id,
      now: () => this.clock.now(),
      persist: async (event) => {
        if (!run.evidenceStore)
          throw new Error("Run artifact storage is unavailable.");
        // Immutable single-event chunks avoid rewriting the cumulative history.
        await run.evidenceStore.writeSnapshot({
          artifactId: `event-${++evidenceSequence}`,
          schemaVersion: 2,
          value: event,
        });
      },
    });
    if (evidenceStoreError) run.evidence.markIncomplete(evidenceStoreError);
    this.recordEvidence(run, {
      kind: "run_admitted",
      facts: { definition: run.definition, baseSha: run.baseSha },
    });
    // The initial stage budget starts at admitted run insertion, before the
    // asynchronous root/session initialization below.
    this.enterStage(run, run.stage, wallclockStartedAtMs);
    this.notify();
    void this.initialize(run);
    return id;
  }

  private async initialize(run: MutableRun) {
    try {
      if (run.definition === FEATURE_PIPELINE_ID) {
        await this.initializeFeaturePipeline(run);
        return;
      }
      const root = await this.tree.spawn({
        scopeId: run.id,
        role:
          run.definition === AUDIT_PIPELINE_ID
            ? AUDIT_SYNTHESIS_ROLE
            : run.definition === PLAN_PIPELINE_ID
              ? PLAN_PIPELINE_SYNTHESIS_ROLE
              : "pipeline-root",
        attempt: 1,
        title: run.id,
        model: definitionFor(run.definition).rootModel,
        thinkingLevel:
          run.definition === PLAN_PIPELINE_ID ? "xhigh" : undefined,
        cwd: run.request.workingDir,
        prompt: buildPipelinePrompt(run.definition, run.request),
        persistent: true,
        deferPrompt:
          run.definition === AUDIT_PIPELINE_ID ||
          run.definition === PLAN_PIPELINE_ID,
        shouldStart: () => run.status === "starting",
      });
      run.rootId = root.id;
      run.resolveRootReady();
      this.settleDue(run);
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
        if (run.definition === AUDIT_PIPELINE_ID) {
          run.auditSegmentStarting = this.startAuditSegment(run, {
            acceptanceContract:
              run.request.audit?.acceptanceCriteria.join("\n") ||
              "Use the task statement as the bounded acceptance contract.",
            assumptions: [],
            checks: [],
            standalone: true,
          });
          await run.auditSegmentStarting;
        } else if (run.definition === PLAN_PIPELINE_ID) {
          await this.initializePlanPipeline(run);
        }
      }
    } catch (error) {
      run.resolveRootReady();
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        Boolean(run.rootId),
      );
    }
  }

  private planDiscoveryReports(run: MutableRun) {
    return PLAN_PIPELINE_DISCOVERY_ROLES.map((role) => {
      const context = run.planDiscoveryReports.get(role);
      if (!context) {
        throw new Error(
          `plan-pipeline has no validated ${role} discovery report.`,
        );
      }
      return context;
    });
  }

  private async settlePlanDiscoveryRole(
    run: MutableRun,
    role: PlanPipelineDiscoveryRole,
    sessionId: string,
  ) {
    while (run.status === "running") {
      const [settled] = await this.tree.wait([sessionId]);
      if (!settled) {
        throw new Error(`Plan discovery session ${sessionId} disappeared.`);
      }
      if (settled.status === "error" || settled.status === "cancelled") {
        throw new Error(
          `Plan discovery ${role} session ${settled.status}: ${settled.error ?? "provider failure or cancellation"}.`,
        );
      }
      if (this.hasExecutionPartial(run, sessionId)) {
        await this.waitUntilRunStops(run);
        throw new Error(
          `Plan discovery ${role} ended after a cooperative partial.`,
        );
      }
      const hasSubmission = this.discoverySubmissions.has(sessionId);
      const submitted = this.discoverySubmissions.get(sessionId);
      this.discoverySubmissions.delete(sessionId);
      try {
        const report = hasSubmission
          ? parsePlanDiscoveryReport(role, submitted)
          : parsePlanDiscoveryReportText(role, settled.finalText);
        this.recordEvidence(run, {
          kind: "submission_accepted",
          sessionId,
          role,
        });
        run.planDiscoveryReports.set(role, {
          role,
          provenance: {
            sessionId,
            attempt: settled.attempt,
            submission: hasSubmission ? "tool" : "final-text-json",
          },
          report,
        });
        this.clearDiscoverySessionTokens(sessionId);
        this.tree.disableViewMutations(sessionId);
        return;
      } catch (error) {
        const count = (this.discoveryCorrections.get(sessionId) ?? 0) + 1;
        this.discoveryCorrections.set(sessionId, count);
        const detail = error instanceof Error ? error.message : String(error);
        this.recordEvidence(run, {
          kind: "submission_rejected",
          sessionId,
          facts: { correction: count, source: "plan-discovery" },
          detail: detail.slice(0, 2048),
        });
        if (count >= 4) {
          throw new Error(
            `Plan discovery ${role} rejected settled turn ${count}: ${detail}`,
          );
        }
        await this.tree.send(
          sessionId,
          `Plan discovery ${role} was rejected (correction ${count}/3): ${detail} Submit the complete strict role-bound evidence report through the typed submission tool, then stop. Do not choose an implementation or disturb other discovery tracks.`,
        );
      }
    }
    throw new Error(`Plan discovery ${role} ended because the run stopped.`);
  }

  private async bootstrapPlanDiscovery(run: MutableRun) {
    const children = await Promise.all(
      PLAN_PIPELINE_DISCOVERY_ROLES.map((role) =>
        this.spawnChildForRun(run, role, "", false),
      ),
    );
    await Promise.all(
      PLAN_PIPELINE_DISCOVERY_ROLES.map((role, index) => {
        const child = children[index];
        if (!child) {
          throw new Error(`Plan discovery ${role} session was not created.`);
        }
        return this.settlePlanDiscoveryRole(run, role, child.id);
      }),
    );
    if (run.status !== "running") return;
    this.planDiscoveryReports(run);
    this.enterStage(run, "synthesize");
  }

  private parsePlanSubmission(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof Reflect.get(value, "plan") !== "string"
    ) {
      throw new Error(
        "Plan submission must contain exactly one non-empty plan string.",
      );
    }
    const plan = Reflect.get(value, "plan") as string;
    if (!plan.trim()) throw new Error("Plan submission must not be empty.");
    if (Buffer.byteLength(plan, "utf8") > 1024 * 1024) {
      throw new Error("Plan submission exceeds 1 MiB.");
    }
    return plan;
  }

  private async settlePlanSynthesis(run: MutableRun) {
    const sessionId = run.rootId;
    if (!sessionId) throw new Error("Plan synthesis session is unavailable.");
    while (run.status === "running") {
      const [settled] = await this.tree.wait([sessionId]);
      if (!settled) throw new Error("Plan synthesis session disappeared.");
      if (settled.status === "error" || settled.status === "cancelled") {
        throw new Error(
          `Plan synthesis session ${settled.status}: ${settled.error ?? "provider failure or cancellation"}.`,
        );
      }
      if (this.hasExecutionPartial(run, sessionId)) {
        await this.waitUntilRunStops(run);
        throw new Error("Plan synthesis ended after a cooperative partial.");
      }
      const hasSubmission = this.discoverySubmissions.has(sessionId);
      const submitted = this.discoverySubmissions.get(sessionId);
      this.discoverySubmissions.delete(sessionId);
      try {
        const plan = hasSubmission
          ? this.parsePlanSubmission(submitted)
          : (() => {
              if (!settled.finalText.trim())
                throw new Error("Plan synthesis returned no plan text.");
              if (Buffer.byteLength(settled.finalText, "utf8") > 1024 * 1024)
                throw new Error("Plan synthesis exceeds 1 MiB.");
              return settled.finalText;
            })();
        this.clearDiscoverySessionTokens(sessionId);
        return plan;
      } catch (error) {
        const count = (this.discoveryCorrections.get(sessionId) ?? 0) + 1;
        this.discoveryCorrections.set(sessionId, count);
        const detail = error instanceof Error ? error.message : String(error);
        this.recordEvidence(run, {
          kind: "submission_rejected",
          sessionId,
          facts: { correction: count, source: "plan-synthesis" },
          detail: detail.slice(0, 2048),
        });
        if (count >= 4) {
          throw new Error(`Plan synthesis rejected turn ${count}: ${detail}`);
        }
        await this.tree.send(
          sessionId,
          `Plan synthesis was rejected (correction ${count}/3): ${detail} Submit the complete free-form Markdown plan through pipeline_plan_submit. Keep the plan text opaque; do not call generic orchestration or write tools.`,
        );
      }
    }
    throw new Error("Plan synthesis ended because the run stopped.");
  }

  private finishPlan(run: MutableRun, plan: string) {
    this.settleDue(run);
    if (run.status !== "running") return;
    let writtenPath: string | undefined;
    if (run.request.planPath !== null && run.request.planPath !== undefined) {
      writtenPath = writePlanOutput(
        run.request.workingDir,
        run.request.planPath,
        plan,
      ).relativePath;
    }
    run.planText = plan;
    run.planWrittenPath = writtenPath;
    this.clearExecutionRunState(run);
    this.enterStage(run, "complete");
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = {
      outcome: "Plan synthesis completed from six validated discovery reports.",
      plan,
      ...(writtenPath ? { planPath: writtenPath } : {}),
      changedPaths: writtenPath ? [writtenPath] : [],
      checks: [
        "Six role-bound planning discovery reports passed host validation.",
        "One Luna/xhigh synthesis session accepted the plan.",
      ],
      assumptions: [],
      git: [],
      reports: PLAN_PIPELINE_DISCOVERY_ROLES.map(
        (role) => `${role} report accepted by the controller.`,
      ),
      unresolvedItems: [],
      workingDir: run.request.workingDir,
    };
    this.clearDiscoveryRunState(run.id);
    this.notify();
    this.deliver(run);
  }

  private async initializePlanPipeline(run: MutableRun) {
    await this.bootstrapPlanDiscovery(run);
    if (run.status !== "running") return;
    this.settleDue(run);
    if (run.status !== "running") return;
    const reports = this.planDiscoveryReports(run);
    if (!run.rootId) throw new Error("Plan synthesis session is unavailable.");
    await this.startDeferred(
      run,
      run.rootId,
      buildPipelinePrompt(run.definition, run.request, reports),
    );
    const plan = await this.settlePlanSynthesis(run);
    if (run.status === "running") this.finishPlan(run, plan);
  }

  private async settleFeaturePlanningArtifact<T>(options: {
    readonly run: MutableRun;
    readonly sessionId: string;
    readonly label: string;
    readonly correctionKey: string;
    readonly parseText: (text: string) => T;
    readonly parseValue: (value: unknown) => T;
  }) {
    const { run, sessionId } = options;
    while (run.status === "running") {
      const [settled] = await this.tree.wait([sessionId]);
      if (!settled) {
        throw new Error(`${options.label} session ${sessionId} disappeared.`);
      }
      if (settled.status === "error" || settled.status === "cancelled") {
        throw new Error(
          `${options.label} session ${settled.status}: ${settled.error ?? "provider failure or cancellation"}.`,
        );
      }
      const hasSubmission = this.discoverySubmissions.has(sessionId);
      const submitted = this.discoverySubmissions.get(sessionId);
      this.discoverySubmissions.delete(sessionId);
      try {
        const parsed = hasSubmission
          ? options.parseValue(submitted)
          : options.parseText(settled.finalText);
        this.recordEvidence(run, {
          kind: "submission_accepted",
          sessionId,
          facts: { source: options.correctionKey },
        });
        return parsed;
      } catch (error) {
        const key = `${sessionId}:${options.correctionKey}`;
        const rejected = (this.featureSynthesisCorrections.get(key) ?? 0) + 1;
        this.featureSynthesisCorrections.set(key, rejected);
        const detail = boundedPipelineError(error);
        this.recordEvidence(run, {
          kind: "submission_rejected",
          sessionId,
          facts: { correction: rejected, source: options.correctionKey },
          detail: detail.slice(0, 2048),
        });
        if (rejected > FEATURE_PLANNING_CORRECTION_TURNS) {
          throw new Error(
            `${options.label} rejected settled turn ${rejected}: ${detail}`,
          );
        }
        await this.tree.send(
          sessionId,
          `${options.label} was rejected (correction ${rejected}/${FEATURE_PLANNING_CORRECTION_TURNS}): ${detail} Submit the complete corrected typed artifact in this same session, then stop.`,
        );
      }
    }
    throw new Error(`${options.label} ended because the run stopped.`);
  }

  private featurePlanArtifactRole(
    role: FeaturePlanRole,
  ): FeaturePlanCandidateRole {
    return role === "feature-plan-minimal" ? "Minimal" : "Robust";
  }

  private async runFeatureTaskSession(
    run: MutableRun,
    parentId: string,
    input: FeatureTaskSessionInput,
  ): Promise<FeatureTaskSessionOutcome> {
    run.featureTaskHosts.set(input.role, input.tools);
    if (typeof input.capsule !== "string")
      this.evidenceRoleTasks.set(
        `${run.id}:${input.role}`,
        input.capsule.taskId,
      );
    try {
      const agent = await this.tree.spawn({
        scopeId: run.id,
        parentId,
        role: input.role,
        attempt: input.attempt,
        title: scopedSessionTitle(run.id, input.role),
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        cwd: input.cwd,
        prompt:
          typeof input.capsule === "string"
            ? input.capsule
            : JSON.stringify(input.capsule),
        shouldStart: () => run.status === "running" && !input.signal.aborted,
      });
      const [settled] = await this.tree.wait([agent.id], input.signal);
      if (!settled || settled.status === "error") {
        return {
          status: "failed",
          sessionId: agent.id,
          error: settled?.error ?? "Feature task session disappeared.",
        };
      }
      if (settled.status === "cancelled") {
        return { status: "cancelled", sessionId: agent.id };
      }
      return { status: "settled", sessionId: agent.id };
    } catch (error) {
      if (input.signal.aborted || run.status === "cancelled") {
        return { status: "cancelled" };
      }
      return { status: "failed", error: boundedPipelineError(error) };
    } finally {
      run.featureTaskHosts.delete(input.role);
    }
  }

  private cleanupReadinessRuntime(run: MutableRun) {
    if (!run.readinessRuntimeUsed) return [];
    run.readinessRuntimeUsed = false;
    return cleanupFeatureSandboxRuntime(run.request.workingDir, (record) => {
      this.recordEvidence(run, {
        kind: `cleanup_${record.event}`,
        operationId: record.operationId,
        detail: record.detail,
        facts: {
          resourceId: record.resourceId,
          resourceType: record.resourceType,
          resource: record.resource,
          ownership: record.ownership,
          phase: record.phase,
          disposition: record.disposition ?? null,
          operationStatus: record.operationStatus ?? null,
          reasonCode: record.reasonCode ?? null,
          expectedIdentity: record.expectedIdentity ?? null,
        },
      });
    });
  }

  private planningReadinessHandoff(run: MutableRun) {
    return `\n\nController-observed repository readiness (existing checks only; future task checks are separate):\n${JSON.stringify((run.planningReadiness ?? []).map(({ command, cwd, source, sourceHash, status, exitCode }) => ({ command, cwd, source: source.path, sourceHash, status, exitCode })))}`;
  }

  private assertPlanningBaselineChecks(
    run: MutableRun,
    graph: FeatureExecutionGraph,
  ) {
    for (const check of graph.baselineChecks) {
      if (
        !run.planningReadiness?.some(
          (observed) =>
            observed.status === "passed" &&
            observed.command === check.command &&
            path.normalize(observed.cwd) === path.normalize(check.cwd),
        )
      ) {
        throw new Error(
          `Baseline ${check.id} was not successfully executed from a confirmed repository source during discovery. Use the exact observed command/cwd; future checks belong after the task that creates them.`,
        );
      }
    }
  }

  private async initializeFeaturePipeline(run: MutableRun) {
    if (
      !run.featureCaller ||
      !run.request.worktreeRoot ||
      !run.request.worktreePrepare ||
      !run.featureArtifactDir ||
      !run.featureAbortController
    ) {
      throw new Error(
        "feature-pipeline dynamic graph admission was not initialized.",
      );
    }

    const reviewHostProxy = {
      describe: () => run.featureReviewRuntime?.host.describe?.(),
      diff: (request?: Parameters<FeatureTaskToolHost["diff"]>[0]) => {
        if (!run.featureReviewRuntime) {
          throw new Error("Final Astra review is not active.");
        }
        return run.featureReviewRuntime.host.diff(request);
      },
      check: (request: Parameters<FeatureTaskToolHost["check"]>[0]) => {
        if (!run.featureReviewRuntime) {
          throw new Error("Final Astra review is not active.");
        }
        return run.featureReviewRuntime.host.check(request);
      },
      finalize: (request: Parameters<FeatureTaskToolHost["finalize"]>[0]) => {
        if (!run.featureReviewRuntime) {
          throw new Error("Final Astra review is not active.");
        }
        return run.featureReviewRuntime.host.finalize(request);
      },
    } satisfies FeatureTaskToolHost;
    run.featureTaskHosts.set(FEATURE_FINALIZER_ROLE, reviewHostProxy);

    const finalizer = await this.tree.spawn({
      scopeId: run.id,
      role: FEATURE_FINALIZER_ROLE,
      attempt: 1,
      title: scopedSessionTitle(
        run.id,
        "Canonical plan, graph, and final review",
      ),
      model: ASTRA_MODEL,
      thinkingLevel: "low",
      cwd: run.request.workingDir,
      prompt: "Controller-deferred feature canonical planning.",
      persistent: true,
      deferPrompt: true,
      shouldStart: () => run.status === "starting",
    });
    run.rootId = finalizer.id;
    run.featureGraph = {
      tree: { kind: "sequence", steps: [] },
      tasks: [],
      branches: [],
      joins: [],
      warnings: [],
      residualPaths: [],
      artifactDir: run.featureArtifactDir,
      canonicalSessionId: finalizer.id,
      planning: run.featurePlanning!,
    };
    run.resolveRootReady();
    if (run.status !== "starting") return;
    run.status = "running";
    this.notify();

    const discoveryReports = await this.bootstrapFeatureDiscovery(run);
    if (run.status !== "running") return;
    this.enterStage(run, "plan");

    const planners = await Promise.all(
      FEATURE_PLAN_ROLES.map(async (role) => {
        const planner = await this.tree.spawn({
          scopeId: run.id,
          parentId: finalizer.id,
          role,
          attempt: 1,
          title: scopedSessionTitle(run.id, titleForRole(role)),
          model: ASTRA_MODEL,
          thinkingLevel: "low",
          cwd: run.request.workingDir,
          prompt:
            buildFeatureCandidatePlanPrompt(
              role,
              run.request,
              run.baseSha,
              discoveryReports,
            ) + this.planningReadinessHandoff(run),
          persistent: true,
          shouldStart: () => run.status === "running" && run.stage === "plan",
        });
        this.updateFeaturePlanning(run, {
          candidates: run.featurePlanning!.candidates.map((candidate) =>
            candidate.role === role
              ? { ...candidate, status: "running", sessionId: planner.id }
              : candidate,
          ),
        });
        return { role, planner };
      }),
    );
    const candidatePlans = await Promise.all(
      planners.map(async ({ role, planner }) => {
        const artifactRole = this.featurePlanArtifactRole(role);
        try {
          const plan = await this.settleFeaturePlanningArtifact({
            run,
            sessionId: planner.id,
            label: `${artifactRole} candidate plan`,
            correctionKey: artifactRole,
            parseText: (text) =>
              parseFeatureCandidatePlanForRole(
                artifactRole,
                parseFeatureCandidatePlanText(text),
              ),
            parseValue: (value) =>
              parseFeatureCandidatePlanForRole(artifactRole, value),
          });
          this.updateFeaturePlanning(run, {
            candidates: run.featurePlanning!.candidates.map((candidate) =>
              candidate.role === role
                ? { ...candidate, status: "accepted" }
                : candidate,
            ),
          });
          this.persistFeatureArtifact(
            run,
            `candidate-${artifactRole.toLowerCase()}.json`,
            plan,
          );
          this.clearDiscoverySessionTokens(planner.id);
          this.tree.disableViewMutations(planner.id);
          return plan;
        } catch (error) {
          this.updateFeaturePlanning(run, {
            candidates: run.featurePlanning!.candidates.map((candidate) =>
              candidate.role === role
                ? { ...candidate, status: "failed" }
                : candidate,
            ),
          });
          throw error;
        }
      }),
    );
    run.featureCandidatePlans = candidatePlans;
    if (run.status !== "running") return;

    this.updateFeaturePlanning(run, { canonical: "running" });
    await this.startDeferred(
      run,
      finalizer.id,
      buildFeatureCanonicalPlanPrompt(
        run.request,
        discoveryReports,
        candidatePlans,
      ) + this.planningReadinessHandoff(run),
    );
    const canonicalPlan = await this.settleFeaturePlanningArtifact({
      run,
      sessionId: finalizer.id,
      label: "Canonical feature plan",
      correctionKey: "canonical",
      parseText: parseFeatureCanonicalPlanText,
      parseValue: parseFeatureCanonicalPlan,
    });
    run.featureCanonicalPlan = canonicalPlan;
    this.persistFeatureArtifact(run, "canonical-plan.json", canonicalPlan);
    this.updateFeaturePlanning(run, {
      canonical: "accepted",
      graph: "running",
    });

    await this.tree.send(
      finalizer.id,
      buildFeatureExecutionGraphPrompt(canonicalPlan) +
        this.planningReadinessHandoff(run),
    );
    const executionGraph = await this.settleFeaturePlanningArtifact({
      run,
      sessionId: finalizer.id,
      label: "Feature execution graph",
      correctionKey: "graph",
      parseText: (text) => {
        const graph = parseFeatureExecutionGraphText(text);
        this.assertPlanningBaselineChecks(run, graph);
        const compiled = validateAndCompileFeatureExecutionGraph(
          canonicalPlan,
          graph,
        );
        if (compiled.issues.length > 0)
          throw new Error(compiled.issues.join(" "));
        return graph;
      },
      parseValue: (value) => {
        const graph = parseFeatureExecutionGraph(value);
        this.assertPlanningBaselineChecks(run, graph);
        const compiled = validateAndCompileFeatureExecutionGraph(
          canonicalPlan,
          graph,
        );
        if (compiled.issues.length > 0)
          throw new Error(compiled.issues.join(" "));
        return graph;
      },
    });
    const compilation = validateAndCompileFeatureExecutionGraph(
      canonicalPlan,
      executionGraph,
    );
    if (compilation.issues.length > 0 || !compilation.tree) {
      throw new Error(
        compilation.issues.join(" ") || "Execution tree is unavailable.",
      );
    }
    run.featureExecutionGraph = executionGraph;
    this.persistFeatureArtifact(run, "execution-graph.json", executionGraph);
    this.updateFeaturePlanning(run, { graph: "accepted" });

    const currentCaller = this.featureGit.preflight(run.request.workingDir);
    const expectedCaller = run.featureCaller;
    if (
      currentCaller.workingDir !== expectedCaller.workingDir ||
      currentCaller.repositoryRoot !== expectedCaller.repositoryRoot ||
      currentCaller.commonGitDir !== expectedCaller.commonGitDir ||
      currentCaller.branchRef !== expectedCaller.branchRef ||
      currentCaller.baseCommit !== expectedCaller.baseCommit
    ) {
      throw new Error(
        `feature-pipeline caller identity drifted before build; expected ${expectedCaller.branchRef} at ${expectedCaller.baseCommit}, observed ${currentCaller.branchRef} at ${currentCaller.baseCommit}.`,
      );
    }

    this.enterStage(run, "build");
    const executionPromise = this.featureGraphExecutor({
      runId: run.id,
      workingDir: run.request.workingDir,
      worktreeRoot: run.request.worktreeRoot,
      worktreePrepare: run.request.worktreePrepare,
      canonicalPlan,
      graph: executionGraph,
      tree: compilation.tree,
      now: () => this.clock.now(),
      controllerInstanceId: run.evidence?.controllerInstanceId,
      onEvidence: (event) => {
        (run.graphEvidence ??= []).push(structuredClone(event));
        this.recordEvidence(run, {
          kind: event.kind,
          taskId: event.taskId,
          facts: {
            forkId: event.forkId,
            branchId: event.branchId,
            joinId: event.joinId,
            status: event.status,
            atMs: event.atMs,
            dependencies: JSON.stringify(event.dependencies).slice(0, 2048),
          },
        });
      },
      cleanupEvidence: (record) => {
        this.recordEvidence(run, {
          kind: `cleanup_${record.event}`,
          operationId: record.operationId,
          detail: record.detail,
          facts: {
            resourceId: record.resourceId,
            resourceType: record.resourceType,
            resource: record.resource,
            ownership: record.ownership,
            phase: record.phase,
            disposition: record.disposition ?? null,
            operationStatus: record.operationStatus ?? null,
            reasonCode: record.reasonCode ?? null,
            expectedIdentity: record.expectedIdentity ?? null,
          },
        });
      },
      signal: run.featureAbortController.signal,
      runSession: (input) =>
        this.runFeatureTaskSession(run, finalizer.id, input),
      onSnapshot: (snapshot) => {
        for (const task of snapshot.tasks) {
          for (const check of task.checkHistory ?? task.checks) {
            const checkInvocationId =
              check.checkInvocationId ??
              `${task.id}:${check.checkId}:${check.startedAt}`;
            const key = `${run.id}:${checkInvocationId}`;
            if (this.evidenceChecks.has(key)) continue;
            this.evidenceChecks.add(key);
            this.recordEvidence(run, {
              kind: "check_finished",
              taskId: task.id,
              checkInvocationId,
              facts: {
                checkId: check.checkId,
                status: check.status,
                exitCode: check.exitCode,
                startedAt: check.startedAt,
                finishedAt: check.finishedAt,
              },
              ...(check.error ? { detail: check.error.slice(0, 2048) } : {}),
            });
          }
        }
        run.featureGraph = {
          ...snapshot,
          artifactDir: run.featureArtifactDir!,
          canonicalSessionId: finalizer.id,
          planning: run.featurePlanning!,
        };
        this.notify();
      },
    });
    run.featureExecutionPromise = executionPromise;
    const execution = await executionPromise;
    run.featureExecution = execution;
    this.persistFeatureArtifact(run, "task-results.json", execution);
    if (execution.status !== "completed") {
      throw new Error(
        execution.status === "cancelled"
          ? "Feature execution graph was cancelled."
          : (execution.error ?? "Feature execution graph failed."),
      );
    }

    this.enterStage(run, "review");
    this.updateFeaturePlanning(run, { review: "running" });
    run.featureReviewRuntime = this.featureReviewRuntimeFactory({
      runId: run.id,
      workingDir: run.request.workingDir,
      checks: executionGraph.reviewChecks,
      signal: run.featureAbortController.signal,
      canonicalPlan,
      graph: executionGraph,
      diffBaseCommit: run.baseSha,
      knownResidualPaths: execution.rootResidualPaths,
      knownTrackedResiduals: execution.rootTrackedResiduals,
      onSnapshot: (reviewSnapshot) => {
        if (!run.featureGraph) return;
        const projectedReview = {
          ...reviewSnapshot,
          attempts: reviewSnapshot.attempts.map((attempt) => ({
            ...attempt,
            sessionId: finalizer.id,
            ...(reviewSnapshot.status === "validated" ||
            reviewSnapshot.status === "satisfied_without_changes"
              ? { status: "completed" as const }
              : {}),
          })),
        };
        run.featureGraph = {
          ...run.featureGraph,
          tasks: [
            ...run.featureGraph.tasks.filter(
              (task) => task.kind !== "final-review",
            ),
            projectedReview,
          ],
        };
        this.notify();
      },
    });
    run.featureReviewRuntime.begin(execution.head);
    this.tree.enableMutation(finalizer.id);
    const taskManifest = execution.tasks.map((task) => ({
      taskId: task.id,
      kind: task.kind,
      status: task.status,
      attempt: task.attempt,
      branchId: task.branchId,
      branch: task.branch,
      worktree: task.worktree,
      taskBaseCommit: task.taskBaseCommit,
      provisionalCommit: task.provisionalCommit,
      validatedCommit: task.validatedCommit,
      attempts: task.attempts.map(({ attempt, sessionId, status }) => ({
        attempt,
        sessionId,
        status,
      })),
      checks: task.checks.map(({ checkId, status, exitCode }) => ({
        checkId,
        status,
        exitCode,
      })),
    }));
    const branchManifest = execution.branches.map((branch) => ({
      branchId: branch.id,
      parentId: branch.parentId,
      branch: branch.branch,
      worktree: branch.worktree,
      baseCommit: branch.baseCommit,
      head: branch.head,
      status: branch.status,
      taskIds: branch.taskIds,
    }));
    const joinManifest = execution.joins.map((join) => ({
      joinId: join.id,
      parentBranchId: join.parentBranchId,
      childBranchIds: join.childBranchIds,
      status: join.status,
      commits: join.commits,
      repairTaskId: join.repairTaskId,
      checks: join.checks.map(({ checkId, status, exitCode }) => ({
        checkId,
        status,
        exitCode,
      })),
    }));
    const boundedExecution = truncateHead(
      JSON.stringify({
        tasks: execution.tasks.map(({ capsule: _capsule, ...task }) => ({
          ...task,
          summary: task.summary?.slice(0, 8 * 1024),
          checks: task.checks.map(
            ({ stdout: _stdout, stderr: _stderr, ...check }) => check,
          ),
        })),
        branches: execution.branches,
        joins: execution.joins.map((join) => ({
          ...join,
          checks: join.checks.map(
            ({ stdout: _stdout, stderr: _stderr, ...check }) => check,
          ),
        })),
        warnings: execution.warnings,
        residualPaths: execution.residualPaths,
      }),
      {
        maxBytes: 384 * 1024,
        maxLines: 8_000,
      },
    );
    await this.tree.send(
      finalizer.id,
      buildFeatureFinalReviewPrompt({
        request: run.request,
        canonicalPlan,
        graph: executionGraph,
        executionSummary: JSON.stringify({
          taskManifest,
          branchManifest,
          joinManifest,
          details: boundedExecution.content,
          detailsTruncated: boundedExecution.truncated,
        }),
        gitEvidence: JSON.stringify(this.auditGitIdentity(run)),
        artifactDir: run.featureArtifactDir,
      }),
    );
    const [reviewer] = await this.tree.wait([finalizer.id]);
    if (
      !reviewer ||
      reviewer.status === "error" ||
      reviewer.status === "cancelled"
    ) {
      throw new Error(
        reviewer?.error ??
          "Final Astra review session failed before finalization.",
      );
    }
    const reviewSnapshot = run.featureReviewRuntime.snapshot();
    const review = {
      ...reviewSnapshot,
      attempts: reviewSnapshot.attempts.map((attempt) => ({
        ...attempt,
        sessionId: finalizer.id,
        ...(reviewSnapshot.status === "validated" ||
        reviewSnapshot.status === "satisfied_without_changes"
          ? { status: "completed" as const }
          : {}),
      })),
    };
    if (
      review.status !== "validated" &&
      review.status !== "satisfied_without_changes"
    ) {
      throw new Error(
        "Final Astra review ended without validated finalization.",
      );
    }
    this.persistFeatureArtifact(run, "sol-review.json", review);
    this.updateFeaturePlanning(run, { review: "accepted" });
    run.featureSynthesisChecks = review.checks.map(
      (check) => `${check.checkId}: ${check.status}`,
    );

    const auditRoot = await this.tree.spawn({
      scopeId: run.id,
      role: "pipeline-root",
      attempt: 1,
      title: run.id,
      model: LUNA_MODEL,
      thinkingLevel: "xhigh",
      cwd: run.request.workingDir,
      prompt: "Controller-deferred post-review audit and remediation root.",
      persistent: true,
      deferPrompt: true,
      shouldStart: () => run.status === "running",
    });
    this.tree.reparent(finalizer.id, auditRoot.id);
    run.rootId = auditRoot.id;
    this.enterStage(run, "audit");
    this.notify();
    await this.startDeferred(
      run,
      auditRoot.id,
      buildFeaturePipelinePrompt(run.request, this.featureAuditHandoff(run)),
    );
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

  private featureDiscoveryReports(run: MutableRun) {
    return FEATURE_PIPELINE_DISCOVERY_ROLES.map((role) => {
      const report = run.featureDiscoveryReports.get(role);
      if (!report) {
        throw new Error(
          `feature-pipeline programmatic discovery has no valid ${role} report.`,
        );
      }
      return report;
    });
  }

  private acceptFeatureDiscoveryTurn(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
    agent: AgentNodeSnapshot,
  ) {
    const hasSubmission = this.discoverySubmissions.has(agent.id);
    const submitted = this.discoverySubmissions.get(agent.id);
    this.discoverySubmissions.delete(agent.id);
    const report: FeatureDiscoveryReportV2 = hasSubmission
      ? parseFeatureDiscoveryReport(role, submitted)
      : parseFeatureDiscoveryReportText(role, agent.finalText);
    this.recordEvidence(run, {
      kind: "submission_accepted",
      sessionId: agent.id,
      role,
    });
    run.featureDiscoveryReports.set(role, {
      role,
      provenance: {
        sessionId: agent.id,
        attempt: agent.attempt,
        submission: hasSubmission ? "tool" : "final-text-json",
      },
      report,
    });
  }

  private async settleFeatureDiscoveryRole(
    run: MutableRun,
    role: FeaturePipelineDiscoveryRole,
    initial: AgentNodeSnapshot,
  ) {
    const sessionId = initial.id;
    while (run.status === "running") {
      const [settled] = await this.waitForChildren(run.id, [sessionId]);
      if (!settled) {
        throw new Error(`Feature discovery session ${sessionId} disappeared.`);
      }
      if (settled.status === "error" || settled.status === "cancelled") {
        throw new Error(
          `Feature discovery ${role} session ${settled.status}: ${settled.error ?? "provider failure or cancellation"}.`,
        );
      }
      if (this.hasExecutionPartial(run, sessionId)) {
        await this.waitUntilRunStops(run);
        throw new Error(
          `Feature discovery ${role} ended after a cooperative partial.`,
        );
      }
      try {
        this.acceptFeatureDiscoveryTurn(run, role, settled);
        this.clearDiscoverySessionTokens(sessionId);
        return;
      } catch (error) {
        const count = (this.discoveryCorrections.get(sessionId) ?? 0) + 1;
        this.discoveryCorrections.set(sessionId, count);
        const detail = error instanceof Error ? error.message : String(error);
        this.recordEvidence(run, {
          kind: "submission_rejected",
          sessionId,
          facts: { correction: count, source: "feature-discovery" },
          detail: detail.slice(0, 2048),
        });
        if (count >= 4) {
          throw new Error(
            `Feature discovery ${role} rejected settled turn ${count}: ${detail}`,
          );
        }
        await this.tree.send(
          sessionId,
          `Your feature discovery V2 submission was rejected (correction ${count}/3): ${detail} Use pipeline_discovery_submit with the complete strict ${role} report, correcting the reported fields, then stop. If the tool is unavailable, return the same object as compact final-text JSON. Do not rerun or disturb other discovery tracks.`,
        );
      }
    }
    throw new Error(`Feature discovery ${role} ended because the run stopped.`);
  }

  private async bootstrapFeatureDiscovery(run: MutableRun) {
    const initial = await Promise.all(
      FEATURE_PIPELINE_DISCOVERY_ROLES.map((role) =>
        this.spawnFeatureDiscoveryAttempt(run, role),
      ),
    );
    await Promise.all(
      FEATURE_PIPELINE_DISCOVERY_ROLES.map((role, index) => {
        const child = initial[index];
        if (!child) {
          throw new Error(`Feature discovery ${role} session was not created.`);
        }
        return this.settleFeatureDiscoveryRole(run, role, child);
      }),
    );
    if (run.status !== "running") return [];
    this.settleDue(run);
    if (run.status !== "running") return [];
    const reports = this.featureDiscoveryReports(run);
    const fanInIssues = validateFeatureDiscoveryFanIn(reports);
    if (fanInIssues.length > 0) throw new Error(fanInIssues.join(" "));
    await run.readinessQueue;
    if (run.status !== "running") return [];
    const cleanupWarnings = this.cleanupReadinessRuntime(run);
    if (cleanupWarnings.length)
      throw new Error(
        `Planning readiness cleanup: ${cleanupWarnings.join(" ")}`,
      );
    if (!run.planningReadiness?.some((check) => check.status === "passed")) {
      throw new Error(
        "Repository readiness was not verified during discovery. No controller-observed source-confirmed check passed; implementation was not started. Inspect repository instructions and report missing or conflicting checks rather than inventing commands.",
      );
    }
    run.featureDiscoveryBootstrapped = true;
    this.notify();
    return reports;
  }

  private auditGitIdentity(run: MutableRun): AuditGitIdentity {
    const workingDir = run.request.workingDir;
    const headSha = gitHead(workingDir);
    const bounded = (args: ReadonlyArray<string>, label: string) => {
      try {
        const value = execFileSync("git", [...args], {
          cwd: workingDir,
          encoding: "utf8",
          maxBuffer: 256 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        const maxBytes = 64 * 1024;
        if (Buffer.byteLength(value, "utf8") > maxBytes) {
          const marker = `\n[${label} truncated at ${maxBytes} bytes.]`;
          const payload = Buffer.from(value, "utf8")
            .subarray(0, maxBytes - Buffer.byteLength(marker, "utf8"))
            .toString("utf8");
          return {
            state: "truncated" as const,
            value: `${payload}${marker}`,
          };
        }
        return { state: "available" as const, value };
      } catch (error) {
        const partial =
          error && typeof error === "object"
            ? Reflect.get(error, "stdout")
            : undefined;
        if (typeof partial === "string" && partial.length > 0) {
          const marker = `\n[${label} truncated after the Git output limit.]`;
          const payload = Buffer.from(partial, "utf8")
            .subarray(0, 64 * 1024 - Buffer.byteLength(marker, "utf8"))
            .toString("utf8");
          return { state: "truncated" as const, value: `${payload}${marker}` };
        }
        return {
          state: "unavailable" as const,
          value: `${label} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    let branch = "UNAVAILABLE";
    try {
      branch =
        execFileSync("git", ["branch", "--show-current"], {
          cwd: workingDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "DETACHED";
    } catch {
      // Explicit unavailable evidence is safer than guessing repository state.
    }
    const status = bounded(["status", "--short", "--branch"], "Git status");
    const baseAvailable =
      run.baseSha !== "UNAVAILABLE" && headSha !== "UNAVAILABLE";
    let baseIsAncestor: AuditGitIdentity["baseIsAncestor"] = "unavailable";
    if (baseAvailable) {
      try {
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", run.baseSha, headSha],
          {
            cwd: workingDir,
            stdio: "ignore",
          },
        );
        baseIsAncestor = "yes";
      } catch (error) {
        const status =
          error && typeof error === "object"
            ? Reflect.get(error, "status")
            : undefined;
        baseIsAncestor = status === 1 ? "no" : "unavailable";
      }
    }
    const rawCommits = baseAvailable
      ? bounded(
          [
            "log",
            "--oneline",
            "--no-decorate",
            "--max-count=201",
            `${run.baseSha}..${headSha}`,
          ],
          "Commit list",
        )
      : {
          state: "unavailable" as const,
          value:
            "Commit list unavailable: captured base or current HEAD is unavailable.",
        };
    const commitLines = rawCommits.value
      .split("\n")
      .filter((line) => line.length > 0);
    const commits =
      rawCommits.state === "available" && commitLines.length > 200
        ? {
            state: "truncated" as const,
            value: `${commitLines.slice(0, 200).join("\n")}\n[Commit list truncated at 200 entries.]`,
          }
        : rawCommits;
    const committedDiff = baseAvailable
      ? bounded(
          [
            "diff",
            "--no-ext-diff",
            "--no-color",
            `${run.baseSha}..${headSha}`,
            "--",
          ],
          "Committed diff",
        )
      : {
          state: "unavailable" as const,
          value:
            "Committed diff unavailable: captured base or current HEAD is unavailable.",
        };
    const dirtyDiff =
      headSha !== "UNAVAILABLE"
        ? bounded(
            ["diff", "--no-ext-diff", "--no-color", headSha, "--"],
            "Dirty working-tree diff",
          )
        : {
            state: "unavailable" as const,
            value:
              "Dirty working-tree diff unavailable: current HEAD is unavailable.",
          };
    const combinedDiff = baseAvailable
      ? bounded(
          ["diff", "--no-ext-diff", "--no-color", run.baseSha, "--"],
          "Combined base-to-worktree diff",
        )
      : {
          state: "unavailable" as const,
          value:
            "Combined base-to-worktree diff unavailable: captured base or current HEAD is unavailable.",
        };
    return {
      baseSha: run.baseSha,
      headSha,
      worktreeLabel: "WORKTREE",
      workingDir,
      branch,
      status,
      baseIsAncestor,
      commits,
      committedDiff,
      dirtyDiff,
      combinedDiff,
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
    this.settleDue(run);
    if (run.status !== "starting" && run.status !== "running") {
      throw new Error(`Pipeline run "${run.id}" is ${run.status}.`);
    }
    if (run.auditSegment) {
      throw new Error("This pipeline run already has an audit segment.");
    }
    if (!run.rootId) throw new Error(`Pipeline run "${run.id}" has no root.`);
    const input = run.request.audit ?? {
      mode: "initial" as const,
      acceptanceCriteria: [],
    };
    const identityBefore = this.reviewIdentity(run);
    const git = this.auditGitIdentity(run);
    const identityAfter = this.reviewIdentity(run);
    run.reviewedIdentity =
      identityBefore &&
      identityAfter &&
      identityBefore.head === identityAfter.head &&
      identityBefore.diffDigest === identityAfter.diffDigest &&
      identityAfter.head === git.headSha
        ? identityAfter
        : undefined;
    const featureHandoff =
      run.definition === FEATURE_PIPELINE_ID
        ? this.featureAuditHandoff(run, git)
        : undefined;
    const acceptanceContract = featureHandoff
      ? JSON.stringify({
          acceptance: featureHandoff.acceptance,
          invariants: featureHandoff.invariants,
        })
      : options.acceptanceContract;
    const assumptions = featureHandoff?.assumptions ?? options.assumptions;
    const checks =
      run.definition === FEATURE_PIPELINE_ID
        ? run.featureSynthesisChecks
        : options.checks;
    let controllerEvidence: AuditSegmentContext["controllerEvidence"];
    try {
      await run.evidence?.flush();
      if (run.evidence && run.evidenceStore) {
        const snapshot = run.evidence.snapshot();
        const assessment = assessExecutionEvidence({
          events: snapshot.events,
          graphEvents: run.graphEvidence ?? [],
          completeness: snapshot.completeness,
          state: "provisional",
          featureGraphRequired: run.definition === FEATURE_PIPELINE_ID,
          runStartMs: run.evidence.originMs,
        });
        const entry = await run.evidenceStore.writeSnapshot({
          artifactId: "pre-audit-evidence",
          schemaVersion: 2,
          value: {
            ...snapshot,
            executionAssessment: assessment,
            state: "provisional",
          },
        });
        controllerEvidence = {
          schemaVersion: 2,
          artifactId: entry.artifactId,
          revision: entry.revision,
        };
      }
    } catch (error) {
      run.evidence?.markIncomplete(error);
    }
    if (run.status !== "running" && run.status !== "starting")
      throw new Error(
        "Pipeline stopped before audit evidence preparation completed.",
      );
    const context: AuditSegmentContext = {
      ...(controllerEvidence ? { controllerEvidence } : {}),
      task: run.request.task,
      acceptanceContract: acceptanceContract.slice(0, 64 * 1024),
      assumptions: assumptions.slice(0, 128),
      checks: checks.slice(0, 128),
      input,
      git,
      purpose:
        run.definition === AUDIT_PIPELINE_ID ? "standalone" : "feature-final",
      ...(featureHandoff ? { featureHandoff } : {}),
    };
    this.recordEvidence(run, {
      kind: "review_identity",
      facts: {
        head: run.reviewedIdentity?.head ?? null,
        diffDigest: run.reviewedIdentity?.diffDigest ?? null,
      },
    });
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
        title: scopedSessionTitle(run.id, titleForRole(AUDIT_SYNTHESIS_ROLE)),
        model: modelForRole(AUDIT_SYNTHESIS_ROLE),
        cwd: run.request.workingDir,
        prompt: "Controller-deferred audit synthesis.",
        persistent: true,
        deferPrompt: true,
        shouldStart: () => run.status === "running",
      });
      this.settleDue(run);
      if (run.status !== "starting" && run.status !== "running") return [];
      segment.registerSynthesis(synthesis.id);
    }

    const tracks = (
      await Promise.all(
        AUDIT_SEGMENT_LUNA_ROLES.map(async (role) => {
          this.settleDue(run);
          if (run.status !== "starting" && run.status !== "running") {
            return undefined;
          }
          const attempt =
            this.agentsFor(run.id).filter((agent) => agent.role === role)
              .length + 1;
          const child = await this.tree.spawn({
            scopeId: run.id,
            parentId: run.rootId,
            role,
            attempt,
            title: scopedSessionTitle(run.id, titleForRole(role)),
            model: modelForRole(role),
            cwd: run.request.workingDir,
            prompt: buildAuditTrackPrompt(role, context),
            shouldStart: () => run.status === "running",
          });
          if (run.status !== "starting" && run.status !== "running") {
            return undefined;
          }
          segment.registerTrack(role, child.id);
          return child;
        }),
      )
    ).filter((child): child is AgentNodeSnapshot => child !== undefined);
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
    if (run.definition !== FEATURE_PIPELINE_ID) {
      throw new Error(
        "Embedded audit segments are available only to feature-pipeline.",
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

  private async auditCorrection(
    run: MutableRun,
    sessionId: string,
    error: unknown,
  ) {
    const count = (this.auditCorrections.get(sessionId) ?? 0) + 1;
    this.auditCorrections.set(sessionId, count);
    this.recordEvidence(run, {
      kind: "submission_rejected",
      sessionId,
      facts: { correction: count, source: "audit" },
      detail: boundedPipelineError(error).slice(0, 2048),
    });
    if (count >= 4) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await this.tree.send(
      sessionId,
      `Your audit submission was rejected (correction ${count}/3): ${detail} Use pipeline_audit_submit with the complete strict report object, correcting the reported fields, then stop. Do not rerun other tracks.`,
    );
  }

  private pumpAuditSegment(run: MutableRun) {
    const active = this.auditPumps.get(run.id);
    if (active) return active;
    if (
      !run.auditSegment ||
      (run.status !== "starting" && run.status !== "running")
    ) {
      return Promise.resolve();
    }

    const pump = Promise.resolve().then(() => this.runAuditSegmentPump(run));
    this.auditPumps.set(run.id, pump);
    void pump.finally(() => {
      if (this.auditPumps.get(run.id) === pump) {
        this.auditPumps.delete(run.id);
      }
      const segment = run.auditSegment;
      this.notify();
      const synthesisId = segment?.synthesizerId;
      const synthesizer = synthesisId
        ? this.tree.view.get(synthesisId)
        : undefined;
      if (
        segment &&
        (run.status === "starting" || run.status === "running") &&
        segment.progress().reducerStatus === "busy" &&
        synthesizer?.status === "idle"
      ) {
        void this.pumpAuditSegment(run);
      }
    });
    return pump;
  }

  private async runAuditSegmentPump(run: MutableRun) {
    this.settleDue(run);
    if (run.status !== "starting" && run.status !== "running") return;
    const segment = run.auditSegment;
    if (!segment) return;
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
        if (this.hasExecutionPartial(run, id)) {
          continue;
        }
        if (child.status === "error" || child.status === "cancelled") {
          throw new Error(`Audit track ${role} failed before a valid report.`);
        }
        try {
          const submitted = segment.takeSubmission(id);
          if (submitted !== undefined)
            segment.acceptSubmitted(role, submitted, child.attempt);
          else segment.accept(role, child.finalText, child.attempt);
          this.recordEvidence(run, {
            kind: "submission_accepted",
            sessionId: id,
            role,
          });
          if (role === EXECUTOR_AUDIT_ROLE) {
            segment.captureExecutorHostObservation(this.auditGitIdentity(run));
          }
        } catch (error) {
          await this.auditCorrection(run, id, error);
          if (run.status !== "running" && run.status !== "starting") return;
        }
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
        if (this.hasExecutionPartial(run, synthesisId)) return;
        try {
          const submitted = segment.takeSubmission(synthesisId);
          if (submitted !== undefined) segment.settleSubmitted(submitted);
          else segment.settle(synthesizer.finalText);
        } catch (error) {
          await this.auditCorrection(run, synthesisId, error);
          if (run.status !== "running" && run.status !== "starting") return;
        }
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
          this.enterStage(run, "final-resolve");
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
        await this.startDeferred(run, synthesisId, next.prompt);
      }
    } catch (error) {
      this.failRun(
        run,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  private completeStandaloneAudit(
    run: MutableRun,
    report: NonNullable<PipelineCompletionFacts["auditReport"]>,
  ) {
    this.settleDue(run);
    if (run.status !== "running") return;
    const progress = run.auditSegment?.progress();
    this.clearExecutionRunState(run);
    this.enterStage(run, "complete");
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = {
      outcome: report.summary,
      changedPaths: report.workspaceChangesObserved.map((item) => item.path),
      checks: [
        `${progress?.integratedReportCount ?? 0} validated Luna audit reports integrated exactly once.`,
        `${progress?.revision ?? 0} serialized synthesis revision(s) completed.`,
        `Captured review identity: ${report.baseSha}..${report.headSha} (WORKTREE).`,
        ...report.executedChecks.map(
          (item) =>
            `${item.command}: ${item.status}${item.exitCode === null ? "" : ` (exit ${item.exitCode})`} — ${item.evidence}`,
        ),
      ],
      assumptions: [],
      git: [
        `Review base ${report.baseSha}`,
        `Review head ${report.headSha} with WORKTREE evidence`,
        report.hostWorkspaceObservation.summary,
      ],
      reports: [
        `Validated ${report.mode} audit synthesis: ${report.findings.length} finding(s), ${report.unresolvedConflicts.length} unresolved conflict(s), ${report.unprovenChecks.length} unproven check(s), ${report.executedChecks.length} executor check record(s), ${report.workspaceChangesObserved.length} executor-observed workspace change(s).`,
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

  private captureTerminalTiming(run: MutableRun) {
    const now = this.monotonicNow(run);
    if (run.stageTiming) run.stageTiming = stageTimingAt(run.stageTiming, now);
    const state = this.wallclockStateFor(run, now);
    if (state) run.wallclockProjection = state;
    this.cancelStageTimers(run);
  }

  private boundedCleanupOperation(operation: () => Promise<unknown> | unknown) {
    return new Promise<{ timedOut?: boolean; error?: unknown }>((resolve) => {
      let settled = false;
      let cancelTimer = () => {};
      const finish = (result: { timedOut?: boolean; error?: unknown }) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        resolve(result);
      };
      try {
        cancelTimer = this.scheduler.schedule(CLEANUP_TIMEOUT_MS, () =>
          finish({ timedOut: true }),
        );
      } catch {
        finish({ timedOut: true });
      }
      try {
        void Promise.resolve(operation()).then(
          () => finish({}),
          (error) => finish({ error }),
        );
      } catch (error) {
        finish({ error });
      }
    });
  }

  private cleanupTerminal(run: MutableRun, cancelRoot: boolean) {
    if (run.cleanup) return run.cleanup;
    run.cleanup = (async () => {
      const failures: string[] = [];
      const active = this.agentsFor(run.id).filter(
        (agent) =>
          agent.parentId &&
          (agent.status === "starting" || agent.status === "running"),
      );
      const childResults = await Promise.all(
        active.map((agent) =>
          this.boundedCleanupOperation(() => this.tree.cancel(agent.id)),
        ),
      );
      for (const result of childResults) {
        if (result.timedOut) {
          failures.push("Pipeline child cleanup timed out.");
        } else if (result.error !== undefined) {
          failures.push(
            `Pipeline child cleanup failed: ${boundedPipelineError(result.error)}`,
          );
        }
      }
      if (run.readinessQueue) {
        const result = await this.boundedCleanupOperation(
          () => run.readinessQueue!,
        );
        if (result.timedOut)
          failures.push(
            "Planning readiness command cleanup timed out; runtime retained.",
          );
        else failures.push(...this.cleanupReadinessRuntime(run));
      }
      if (run.featureExecutionPromise) {
        const result = await this.boundedCleanupOperation(() =>
          run.featureExecutionPromise!.then(() => undefined),
        );
        if (result.timedOut) {
          failures.push("Feature graph cleanup timed out.");
        } else if (result.error !== undefined) {
          failures.push(
            `Feature graph cleanup failed: ${boundedPipelineError(result.error)}`,
          );
        }
      }
      if (cancelRoot && run.rootId) {
        const result = await this.boundedCleanupOperation(() =>
          this.tree.cancel(run.rootId!),
        );
        if (result.timedOut) {
          failures.push("Pipeline root cancellation timed out.");
        } else if (result.error !== undefined) {
          failures.push(
            `Pipeline root cancellation failed: ${boundedPipelineError(result.error)}`,
          );
        }
      }
      if (failures.length > 0) {
        run.error = [run.error, ...failures]
          .filter(Boolean)
          .join(" ")
          .slice(0, 16 * 1024);
        this.notify();
        if (run.status === "cancelled") throw new Error(failures.join(" "));
      }
    })();
    return run.cleanup;
  }

  private onTreeChange() {
    if (this.shuttingDown) return;
    for (const run of this.runs.values()) {
      if (run.status !== "starting" && run.status !== "running") continue;
      const timing = run.stageTiming;
      this.syncWarnings(run);
      const root = run.rootId ? this.tree.view.get(run.rootId) : undefined;
      if (!root) {
        if (timing && this.monotonicNow(run) >= timing.deadlineAtMs) {
          this.settleLimited(run, timing.epoch, this.monotonicNow(run));
        }
        continue;
      }
      if (root.status === "cancelled") {
        this.clearDiscoveryRunState(run.id);
        this.clearExecutionRunState(run);
        this.captureTerminalTiming(run);
        run.status = "cancelled";
        run.finishedAt = Date.now();
        run.error = root.error;
        void this.cleanupTerminal(run, false)
          .catch(() => {})
          .finally(() => this.deliver(run));
      } else if (root.status === "error") {
        this.clearDiscoveryRunState(run.id);
        this.failRun(run, root.error ?? "Pipeline root failed.");
      } else if (
        timing &&
        this.monotonicNow(run) >= timing.deadlineAtMs &&
        (run.status === "starting" || run.status === "running")
      ) {
        this.settleLimited(run, timing.epoch, this.monotonicNow(run));
      }
      if (run.status === "starting" || run.status === "running") {
        void this.pumpAuditSegment(run);
      }
    }
    this.notify();
  }

  private failRun(run: MutableRun, error: string, cancelRoot = false) {
    if (run.status !== "starting" && run.status !== "running") return;
    this.clearDiscoveryRunState(run.id);
    this.clearExecutionRunState(run);
    this.captureTerminalTiming(run);
    run.status = "failed";
    run.featureAbortController?.abort();
    run.finishedAt = Date.now();
    run.error = error.slice(0, 16 * 1024);
    void this.cleanupTerminal(run, cancelRoot).then(
      () => this.deliver(run),
      () => this.deliver(run),
    );
    this.notify();
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

  private factsForLimited(run: MutableRun): PipelineCompletionFacts {
    const limitation = run.limitation;
    return {
      outcome:
        "The pipeline was limited before completion. No success or readiness claim was made.",
      changedPaths: [],
      checks: limitation?.validatedProgress ?? [],
      assumptions: [],
      git: [],
      reports: [],
      unresolvedItems: limitation?.unresolvedItems ?? [
        "The pipeline ended at its wallclock stage deadline.",
      ],
      workingDir: run.request.workingDir,
    };
  }

  private readonly evidenceDeliveries = new Set<string>();
  private readonly readinessCommand: typeof runFeatureSandboxCommand;

  private deliver(run: MutableRun) {
    if (
      this.shuttingDown ||
      this.handoffs.has(run.id) ||
      this.evidenceDeliveries.has(run.id)
    )
      return;
    if (run.status === "starting" || run.status === "running") return;
    this.evidenceDeliveries.add(run.id);
    if (run.status !== "completed")
      run.featureExecution?.recordRetainedResources(run.status);
    this.recordEvidence(run, {
      kind: "final_status",
      facts: { status: run.status, stage: run.stage },
    });
    void this.sealRunEvidence(run).finally(() => this.deliverSealed(run));
  }

  private reviewIdentity(run: MutableRun) {
    const captured = captureReviewIdentity({
      workingDir: run.request.workingDir,
      base: run.baseSha,
      revision: run.evidence?.snapshot().events.length ?? 0,
    });
    if (captured.state === "available") return captured.identity;
    this.recordEvidence(run, {
      kind: "identity_unavailable",
      detail: captured.reason,
    });
    return undefined;
  }

  private async sealRunEvidence(run: MutableRun) {
    try {
      // Completion tools return before their SDK turn settles. Observe that
      // settlement out-of-band so sealing cannot deadlock the completing tool.
      const openSessions = new Set<string>();
      for (const event of run.evidence?.snapshot().events ?? []) {
        if (!event.sessionId) continue;
        if (event.kind === "run_started") openSessions.add(event.sessionId);
        if (event.kind === "settled" || event.kind === "spawn_failed")
          openSessions.delete(event.sessionId);
      }
      if (openSessions.size) {
        const observation = new AbortController();
        try {
          const outcome = await this.boundedCleanupOperation(() =>
            this.tree.wait([...openSessions], observation.signal),
          );
          if (outcome.timedOut || outcome.error)
            run.evidence?.markIncomplete(
              outcome.error ?? "Terminal session settlement timed out.",
            );
        } finally {
          observation.abort();
        }
      }
      run.finalIdentity = this.reviewIdentity(run);
      await run.evidence?.seal();
      if (!run.evidence) return;
      const snapshot = run.evidence.snapshot();
      const executionAssessment = assessExecutionEvidence({
        events: snapshot.events,
        graphEvents: run.graphEvidence ?? [],
        completeness: snapshot.completeness,
        state: "final",
        featureGraphRequired: run.definition === FEATURE_PIPELINE_ID,
        runStartMs: run.evidence.originMs,
      });
      const report = run.auditSegment?.finalReport;
      run.acceptance = {
        schemaVersion: 2,
        ...(run.reviewedIdentity
          ? { reviewedIdentity: run.reviewedIdentity }
          : {}),
        ...(run.finalIdentity ? { finalIdentity: run.finalIdentity } : {}),
        implementationAcceptance: assessAcceptance(
          assessImplementationEvidence({
            canonicalPlan: run.featureCanonicalPlan,
            taskResults: run.featureGraph?.tasks,
            auditReport: report,
            reviewedIdentity: run.reviewedIdentity,
            finalIdentity: run.finalIdentity,
            state: "final",
            definition: run.definition,
          }),
          "final",
        ),
        pipelineExecutionAcceptance: assessAcceptance(
          executionAssessment.criteria,
          "final",
        ),
      };
      if (!run.evidenceStore) {
        run.evidence.markIncomplete("Artifact store unavailable at seal.");
        return;
      }
      await run.evidenceStore.writeSnapshot({
        artifactId: "run-evidence",
        schemaVersion: 2,
        value: snapshot,
      });
      await run.evidenceStore.writeSnapshot({
        artifactId: "concurrency",
        schemaVersion: 2,
        value: executionAssessment.concurrency,
      });
      await run.evidenceStore.writeSnapshot({
        artifactId: "graph-timeline",
        schemaVersion: 2,
        value: run.graphEvidence ?? [],
      });
      if (run.planningReadiness)
        await run.evidenceStore.writeSnapshot({
          artifactId: "planning-readiness",
          schemaVersion: 1,
          value: run.planningReadiness,
        });
      if (run.featureGraph)
        await run.evidenceStore.writeSnapshot({
          artifactId: "task-results",
          schemaVersion: 2,
          value: run.featureGraph.tasks,
        });
      if (run.featureGraph)
        await run.evidenceStore.writeSnapshot({
          artifactId: "worktree-preparation",
          schemaVersion: 1,
          value: run.featureGraph.branches,
        });
      if (run.featureReviewRuntime)
        await run.evidenceStore.writeSnapshot({
          artifactId: "sol-review",
          schemaVersion: 2,
          value: run.featureReviewRuntime.snapshot(),
        });
      if (report)
        await run.evidenceStore.writeSnapshot({
          artifactId: "audit-report",
          schemaVersion: 1,
          value: report,
        });
      await run.evidenceStore.writeSnapshot({
        artifactId: "acceptance",
        schemaVersion: 2,
        value: run.acceptance,
      });
      const blockers = [
        ...run.acceptance.implementationAcceptance.criteria,
        ...run.acceptance.pipelineExecutionAcceptance.criteria,
      ]
        .filter(
          (criterion) =>
            criterion.status === "failed" || criterion.status === "unproven",
        )
        .map((criterion) => ({ id: criterion.id, detail: criterion.detail }));
      await run.evidenceStore.writeSnapshot({
        artifactId: "blockers",
        schemaVersion: 2,
        value: blockers,
      });
      await run.evidenceStore.writeSnapshot({
        artifactId: "completion",
        schemaVersion: 1,
        value:
          run.completion ??
          (run.status === "limited"
            ? this.factsForLimited(run)
            : this.factsForFailure(run)),
      });
      const manifest = await run.evidenceStore.manifest();
      await run.evidenceStore.writeSnapshot({
        artifactId: "artifact-index",
        schemaVersion: 2,
        value: manifest,
      });
      run.evidenceManifest = await run.evidenceStore.manifest();
      const errorCounts: Record<string, number> = {};
      const cleanupCounts: Record<string, number> = {};
      for (const event of snapshot.events) {
        if (
          ["spawn_failed", "tool_failed", "submission_rejected"].includes(
            event.kind,
          )
        )
          errorCounts[event.kind] = (errorCounts[event.kind] ?? 0) + 1;
        if (event.kind === "cleanup_outcome") {
          const disposition = String(event.facts?.disposition);
          cleanupCounts[disposition] = (cleanupCounts[disposition] ?? 0) + 1;
        }
      }
      run.evidenceHandoff = createRunEvidenceHandoff({
        runId: run.id,
        status: run.status,
        acceptance: run.acceptance,
        manifest: run.evidenceManifest,
        blockers,
        errorCounts,
        cleanupCounts,
        concurrencySummary: executionAssessment.concurrency,
      });
    } catch (error) {
      run.evidence?.markIncomplete(error);
      if (run.acceptance)
        run.acceptance = {
          ...run.acceptance,
          pipelineExecutionAcceptance: assessAcceptance(
            [
              ...run.acceptance.pipelineExecutionAcceptance.criteria,
              {
                id: "terminal-artifact-persistence",
                status: "unproven",
                evidenceRefs: [],
                detail: boundedPipelineError(error).slice(0, 2048),
              },
            ],
            "final",
          ),
        };
    }
  }

  private deliverSealed(run: MutableRun) {
    if (this.shuttingDown || this.handoffs.has(run.id)) return;
    if (run.status === "starting" || run.status === "running") return;
    if (run.featureArtifactDir) {
      const summaryPath = path.join(run.featureArtifactDir, "run-summary.json");
      if (!fs.existsSync(summaryPath)) {
        try {
          this.persistFeatureArtifact(run, "run-summary.json", {
            runId: run.id,
            status: run.status,
            stage: run.stage,
            baseSha: run.baseSha,
            head: gitHead(run.request.workingDir),
            planning: run.featurePlanning,
            warnings: run.featureGraph?.warnings ?? [],
            error: run.error,
            completion: run.completion,
          });
        } catch (error) {
          run.error = [
            run.error,
            `Unable to persist feature run summary: ${boundedPipelineError(error)}`,
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 16 * 1024);
        }
      }
    }
    this.handoffs.add(run.id);
    this.notify();
    const handoff: PipelineHandoff = {
      ...(run.acceptance ? { acceptance: run.acceptance } : {}),
      ...(run.evidenceHandoff ? { evidence: run.evidenceHandoff.handoff } : {}),
      ...(run.evidenceManifest
        ? { evidenceManifest: run.evidenceManifest }
        : {}),
      evidenceIncomplete: run.evidence?.snapshot().completeness !== "complete",
      runId: run.id,
      definition: run.definition,
      status: run.status,
      facts:
        run.completion ??
        (run.status === "limited"
          ? this.factsForLimited(run)
          : this.factsForFailure(run)),
      ...(run.error ? { error: run.error } : {}),
      ...(run.wallclockProjection
        ? { wallclock: run.wallclockProjection }
        : run.stageTiming
          ? { wallclock: this.wallclockStateFor(run) }
          : {}),
      ...(run.limitation ? { limitation: run.limitation } : {}),
      ...(run.limitation ? { partials: run.limitation.partials } : {}),
    };
    void Promise.resolve(this.onHandoff(handoff)).catch(() => {});
  }

  private roleHasValidReport(run: MutableRun, role: PipelineChildRole) {
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(role)
    ) {
      return run.featureDiscoveryReports.has(role);
    }
    if (
      run.definition === PLAN_PIPELINE_ID &&
      PLAN_PIPELINE_DISCOVERY_ROLES.some((candidate) => candidate === role)
    ) {
      return run.planDiscoveryReports.has(role as PlanPipelineDiscoveryRole);
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
                roles: STATIC_LUNA_AUDIT_ROLES,
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
        this.enterStage(run, boundary.nextStage);
      }
      return;
    }
    if (run.definition === PLAN_PIPELINE_ID) {
      if (
        run.stage === "discover" &&
        PLAN_PIPELINE_DISCOVERY_ROLES.every((role) =>
          this.roleHasValidReport(run, role),
        ) &&
        PLAN_PIPELINE_DISCOVERY_ROLES.every((role) =>
          waitedChildren.some((child) => child.role === role),
        )
      ) {
        this.enterStage(run, "synthesize");
      }
      return;
    }
    const roles =
      run.stage === "discover"
        ? FEATURE_PIPELINE_DISCOVERY_ROLES
        : run.stage === "audit"
          ? run.definition === FEATURE_PIPELINE_ID
            ? STATIC_LUNA_AUDIT_ROLES
            : []
          : [];
    const nextStage =
      run.stage === "discover"
        ? run.definition === FEATURE_PIPELINE_ID
          ? "plan"
          : "build"
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
    this.enterStage(run, nextStage);
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
        this.requireValidReports(run, STATIC_LUNA_AUDIT_ROLES, stage);
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
      const stages = stagesForDefinition(run.definition);
      const currentIndex = stages.indexOf(run.stage);
      const nextIndex = stages.indexOf(stage);
      if (
        nextIndex < 0 ||
        nextIndex < currentIndex ||
        nextIndex > currentIndex + 1
      ) {
        throw new Error(
          `Invalid plan-pipeline stage transition: ${run.stage} to ${stage}.`,
        );
      }
      if (stage === "synthesize") {
        this.requireValidReports(run, PLAN_PIPELINE_DISCOVERY_ROLES, stage);
      } else if (stage === "complete" && !run.planText) {
        throw new Error(
          "plan-pipeline completion requires an accepted plan submission.",
        );
      }
    }
    this.enterStage(run, stage);
    return this.snapshot(run);
  }

  private featureAuditHandoff(
    run: MutableRun,
    git = this.auditGitIdentity(run),
  ) {
    const canonicalPlan = run.featureCanonicalPlan;
    if (!canonicalPlan) {
      throw new Error(
        "Feature audit context is unavailable before canonical planning.",
      );
    }
    const review = run.featureReviewRuntime?.snapshot();
    if (!review) {
      throw new Error(
        "Feature audit context is unavailable before final review.",
      );
    }
    return buildFeatureAuditHandoff({
      canonicalPlan,
      git,
      reviewSummary:
        review.summary ?? "Final review validated without a summary.",
      reviewChecks: review.checks,
    });
  }

  private featureAuditAdditionalContext(run: MutableRun) {
    return JSON.stringify(this.featureAuditHandoff(run));
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
    this.settleDue(run);
    if (run.status !== "starting" && run.status !== "running") {
      throw new Error(`Pipeline run "${run.id}" is ${run.status}.`);
    }
    const runId = run.id;
    if (!roleBelongsToDefinition(run.definition, role)) {
      throw new Error(`Unsupported ${run.definition} child role "${role}".`);
    }
    if (
      run.definition === AUDIT_PIPELINE_ID ||
      role === AUDIT_SYNTHESIS_ROLE ||
      ((run.definition === FEATURE_PIPELINE_ID ||
        run.definition === PLAN_PIPELINE_ID) &&
        AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role) &&
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
      FEATURE_PLAN_ROLES.some((planRole) => planRole === role)
    ) {
      throw new Error(
        `${role} is controller-owned by feature planning and cannot be spawned by the audit root.`,
      );
    }
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(role)
    ) {
      if (!controllerOwnedDiscovery) {
        throw new Error(
          `${role} is controller-owned and unavailable to the selected feature-pipeline implementation root.`,
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
      AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role) &&
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
      if (
        !PLAN_PIPELINE_DISCOVERY_ROLES.some((candidate) => candidate === role)
      ) {
        throw new Error(`Unsupported plan-pipeline child role "${role}".`);
      }
      if (run.stage !== "discover") {
        throw new Error(
          `${role} can only start during plan-pipeline stage discover.`,
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
    const sanitizedFeatureAudit =
      run.definition === FEATURE_PIPELINE_ID &&
      STATIC_LUNA_AUDIT_ROLES.some((auditRole) => auditRole === role);
    const hostContext = sanitizedFeatureAudit
      ? this.featureAuditAdditionalContext(run)
      : additionalContext;
    const promptContext = [
      ...(priorReport && priorReportRole
        ? [`${titleForRole(priorReportRole)} report:`, priorReport.finalText]
        : []),
      ...(contextPolicy.gitEvidence && !sanitizedFeatureAudit
        ? [this.gitEvidence(runId)]
        : []),
      hostContext,
    ]
      .filter((item) => item.trim())
      .join("\n");
    const spec = {
      scopeId: runId,
      parentId: run.rootId,
      role,
      attempt,
      title: scopedSessionTitle(run.id, titleForRole(role)),
      model: modelForRole(role),
      thinkingLevel:
        run.definition === PLAN_PIPELINE_ID ? ("medium" as const) : undefined,
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
    this.settleDue(run);
    if (run.status !== "starting" && run.status !== "running") return children;
    await this.pumpAuditSegment(run);
    if (
      run.definition === SMALL_FEATURE_PIPELINE_ID &&
      (run.status === "starting" || run.status === "running")
    ) {
      const invalid = children.find((child) => {
        if (this.hasExecutionPartial(run, child.id)) return false;
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
    if (
      run.definition === PLAN_PIPELINE_ID &&
      run.stage === "discover" &&
      (run.status === "starting" || run.status === "running")
    ) {
      for (const child of children) {
        const role = PLAN_PIPELINE_DISCOVERY_ROLES.find(
          (candidate) => candidate === child.role,
        );
        if (!role || child.status === "error" || child.status === "cancelled")
          continue;
        const submitted = this.discoverySubmissions.get(child.id);
        try {
          const report =
            submitted === undefined
              ? parsePlanDiscoveryReportText(role, child.finalText)
              : parsePlanDiscoveryReport(role, submitted);
          run.planDiscoveryReports.set(role, {
            role,
            provenance: {
              sessionId: child.id,
              attempt: child.attempt,
              submission: submitted === undefined ? "final-text-json" : "tool",
            },
            report,
          });
          this.discoverySubmissions.delete(child.id);
          this.clearDiscoverySessionTokens(child.id);
        } catch {
          // The caller may use the existing same-session correction path.
        }
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
    if (this.hasExecutionPartial(run, id)) {
      throw new Error(
        "A cooperative partial cannot be retried or continued and does not trigger replacement.",
      );
    }
    if (!agent.parentId) throw new Error(`Agent "${id}" is the pipeline root.`);
    if (
      agent.role === AUDIT_SYNTHESIS_ROLE ||
      isFeatureInternalImplementationRole(agent.role) ||
      [...(run.auditSegment?.tracks.values() ?? [])].includes(id)
    ) {
      throw new Error(
        "Controller-owned synthesis and candidate sessions cannot be retried or continued.",
      );
    }
    if (
      run.definition === FEATURE_PIPELINE_ID &&
      isFeatureDiscoveryRole(agent.role)
    ) {
      throw new Error(
        "feature-pipeline discovery retries are controller-owned and unavailable to the selected implementation root.",
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
      this.requireValidReports(run, STATIC_LUNA_AUDIT_ROLES, run.stage);
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
      const role = PLAN_PIPELINE_DISCOVERY_ROLES.find(
        (candidate) => candidate === agent.role,
      );
      if (!role) {
        throw new Error(`plan-pipeline child "${id}" cannot be retried.`);
      }
      if (run.stage !== "discover") {
        throw new Error(
          "plan-pipeline discovery sessions cannot continue after discovery.",
        );
      }
      if (
        run.planDiscoveryReports.has(role) ||
        this.discoverySubmissions.has(id)
      ) {
        throw new Error(
          `plan-pipeline discovery ${role} already submitted an accepted report.`,
        );
      }
      if ((this.childContinuations.get(id) ?? 0) >= 1) {
        throw new Error(`plan-pipeline child "${id}" already used its retry.`);
      }
      const issues = (() => {
        try {
          parsePlanDiscoveryReportText(role, agent.finalText);
          return [];
        } catch (error) {
          return [error];
        }
      })();
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
            ...STATIC_LUNA_AUDIT_ROLES.flatMap((role) => [
              `${titleForRole(role)}:`,
              this.agentsFor(runId).find((candidate) => candidate.role === role)
                ?.finalText ?? "",
            ]),
            "Remediation instruction:",
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
      isFeatureInternalImplementationRole(agent.role) ||
      [...(run.auditSegment?.tracks.values() ?? [])].includes(id)
    ) {
      throw new Error(
        "Controller-owned synthesis and candidate sessions can only be cancelled with the whole pipeline run.",
      );
    }
    return this.tree.cancel(id);
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
    return `Captured host-side Git evidence (read-only):\n${JSON.stringify(this.auditGitIdentity(this.requireActiveRun(runId)), null, 2)}`;
  }

  private finalGitFacts(run: MutableRun) {
    const evidence = this.auditGitIdentity(run);
    const compact = (value: string) => value.slice(0, 2_048);
    return [
      `Final captured Git base: ${evidence.baseSha}`,
      `Final Git HEAD: ${evidence.headSha}`,
      `Final Git branch: ${evidence.branch}`,
      `Final base ancestry: ${evidence.baseIsAncestor}`,
      `Final Git status (${evidence.status.state}): ${compact(evidence.status.value)}`,
      `Final base..HEAD commits (${evidence.commits.state}): ${compact(evidence.commits.value)}`,
      `Final committed diff (${evidence.committedDiff.state}): ${compact(evidence.committedDiff.value)}`,
      `Final dirty HEAD..WORKTREE diff (${evidence.dirtyDiff.state}): ${compact(evidence.dirtyDiff.value)}`,
      `Final combined base..WORKTREE diff (${evidence.combinedDiff.state}): ${compact(evidence.combinedDiff.value)}`,
    ];
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
      completion = {
        ...facts,
        git: [...facts.git, ...this.finalGitFacts(run)],
      };
    } else if (run.definition === PLAN_PIPELINE_ID) {
      if (run.stage !== "complete" || !run.planText) {
        throw new Error(
          "plan-pipeline completion requires an accepted plan submission.",
        );
      }
      if (facts.plan !== undefined && facts.plan !== run.planText) {
        throw new Error("pipeline_complete plan must match the accepted plan.");
      }
      completion = {
        ...facts,
        plan: run.planText,
        ...(run.planWrittenPath ? { planPath: run.planWrittenPath } : {}),
      };
    } else if (run.definition === FEATURE_PIPELINE_ID) {
      if (!run.auditSegment?.finalReport) {
        throw new Error(
          "feature-pipeline completion requires a validated Luna audit synthesis.",
        );
      }
      if (!run.finalAuditReportDelivered) {
        throw new Error(
          "feature-pipeline completion requires delivering the validated final audit report to final-resolve.",
        );
      }
      requireFinalFindingResolutionEvidence(run, facts);
      const cleanupWarnings = run.featureExecution?.cleanupCompleted() ?? [];
      if (cleanupWarnings.length > 0 && run.featureGraph) {
        run.featureGraph = {
          ...run.featureGraph,
          warnings: [
            ...new Set([...run.featureGraph.warnings, ...cleanupWarnings]),
          ],
        };
      }
      completion = {
        ...facts,
        git: [...facts.git, ...this.finalGitFacts(run)],
        auditReport: run.auditSegment.finalReport,
      };
    }
    this.clearDiscoveryRunState(run.id);
    this.clearExecutionRunState(run);
    this.enterStage(run, "complete");
    run.status = "completed";
    run.finishedAt = Date.now();
    run.completion = completion;
    this.notify();
    this.deliver(run);
    return this.snapshot(run);
  }

  private async cancelRunOnce(run: MutableRun) {
    this.clearDiscoveryRunState(run.id);
    this.clearExecutionRunState(run);
    this.captureTerminalTiming(run);
    run.status = "cancelled";
    run.featureAbortController?.abort();
    run.finishedAt = Date.now();
    run.resolveRootReady();
    this.notify();
    try {
      await this.cleanupTerminal(run, true);
    } finally {
      this.deliver(run);
    }
    return this.snapshot(run);
  }

  async cancelRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.cancellation) return run.cancellation;
    if (
      (run.status === "starting" || run.status === "running") &&
      run.stageTiming
    ) {
      const now = this.monotonicNow(run);
      if (now >= run.stageTiming.deadlineAtMs) {
        this.settleLimited(run, run.stageTiming.epoch, now);
        return this.snapshot(run);
      }
    }
    if (run.status !== "starting" && run.status !== "running")
      return this.snapshot(run);
    const cancellation = this.cancelRunOnce(run);
    run.cancellation = cancellation;
    return cancellation;
  }

  private requireRun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown pipeline run id "${runId}".`);
    return run;
  }

  private requireActiveRun(runId: string) {
    const run = this.requireRun(runId);
    if (run.status === "starting" || run.status === "running") {
      const timing = run.stageTiming;
      const now = this.monotonicNow(run);
      if (timing && now >= timing.deadlineAtMs) {
        this.settleLimited(run, timing.epoch, now);
      }
    }
    if (run.status !== "starting" && run.status !== "running") {
      throw new Error(`Pipeline run "${runId}" is ${run.status}.`);
    }
    return run;
  }

  createRootTools(runId: string): ToolDefinition[] {
    const controller = this;
    const run = this.requireRun(runId);
    if (run.definition === PLAN_PIPELINE_ID) return [];
    const roles = rolesForDefinition(run.definition).filter(
      (role) =>
        role !== AUDIT_SYNTHESIS_ROLE &&
        role !== EXECUTOR_AUDIT_ROLE &&
        !FEATURE_PLAN_ROLES.some((planRole) => planRole === role) &&
        !(
          run.definition === PLAN_PIPELINE_ID &&
          AUDIT_SEGMENT_LUNA_ROLES.some((auditRole) => auditRole === role)
        ),
    );
    const tools: ToolDefinition[] = [
      defineTool({
        name: "pipeline_artifact_read",
        label: "Read Pipeline Evidence",
        description:
          "Read a revisioned evidence artifact from this run only. Use artifact IDs from its manifest; no filesystem paths are accepted.",
        parameters: Type.Object(
          {
            artifactId: Type.String({ minLength: 1, maxLength: 128 }),
            revision: Type.Integer({ minimum: 1 }),
            cursor: Type.Optional(Type.Integer({ minimum: 0 })),
            maxBytes: Type.Integer({ minimum: 4, maximum: 64 * 1024 }),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params) {
          if (!run.evidenceStore)
            throw new Error("Evidence storage unavailable for this run.");
          const page = await run.evidenceStore.read(params);
          return {
            content: [{ type: "text", text: page.text }],
            details: page,
          };
        },
      }),
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
            child.role === AUDIT_SYNTHESIS_ROLE ||
            isFeatureInternalImplementationRole(child.role) ||
            [...(run.auditSegment?.tracks.values() ?? [])].includes(child.id)
              ? []
              : validatePipelineReport(
                  run.definition,
                  child.role,
                  child.finalText,
                );
          const warning = issues.length
            ? `\n\n[Report contract violation: ${issues.join(" ")}]`
            : "";
          const resolutionHandoff =
            child.role === AUDIT_SYNTHESIS_ROLE
              ? finalAuditResolutionHandoff(run)
              : undefined;
          if (resolutionHandoff) run.finalAuditReportDelivered = true;
          return {
            content: [
              {
                type: "text",
                text:
                  resolutionHandoff ??
                  `${child.id} [${child.status}] ${child.role} attempt ${child.attempt}\n\n${child.error ?? (child.finalText || "(no report yet)")}${warning}`.slice(
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
          "Wait for known children, return their reports in this coordinator context, and atomically enter the next stage when the full current-stage fan-in is valid.",
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
          const resolutionHandoff = children.some(
            ({ role }) => role === AUDIT_SYNTHESIS_ROLE,
          )
            ? finalAuditResolutionHandoff(run)
            : undefined;
          const ordinaryReports = children
            .map((child) => {
              const issues =
                child.role === AUDIT_SYNTHESIS_ROLE ||
                isFeatureInternalImplementationRole(child.role) ||
                [...(run.auditSegment?.tracks.values() ?? [])].includes(
                  child.id,
                )
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
            .slice(0, 48 * 1024);
          if (resolutionHandoff) run.finalAuditReportDelivered = true;
          const childStatuses = children
            .map(
              (child) =>
                `${child.id} · ${child.role} · attempt ${child.attempt} · ${child.status}`,
            )
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: resolutionHandoff
                  ? `${resolutionHandoff}\n\nSettled child statuses:\n${childStatuses}`
                  : ordinaryReports,
              },
            ],
            details: {
              runId,
              finalAuditReportDelivered: Boolean(resolutionHandoff),
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
            ...(params.final_finding_resolutions
              ? {
                  finalFindingResolutions: params.final_finding_resolutions.map(
                    (resolution) => ({
                      findingId: resolution.finding_id,
                      disposition: resolution.disposition,
                      evidence: resolution.evidence,
                      verification: resolution.verification,
                    }),
                  ),
                }
              : {}),
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
    if (run.definition === FEATURE_PIPELINE_ID) {
      tools.splice(
        tools.length - 1,
        0,
        defineTool({
          name: "pipeline_audit_start",
          label: "Start Luna Audit Segment",
          description:
            "Start this hardcoded pipeline's controller-owned five-contributor Luna final audit and persistent incremental synthesizer.",
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
    return tools;
  }

  async dispose() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const run of this.runs.values()) {
      this.cancelStageTimers(run);
      if (run.status === "starting" || run.status === "running") {
        this.captureTerminalTiming(run);
        run.status = "cancelled";
        run.featureAbortController?.abort();
        run.finishedAt = Date.now();
        run.resolveRootReady();
        this.clearDiscoveryRunState(run.id);
        this.clearExecutionRunState(run);
      }
    }
    await this.tree.dispose();
    await Promise.allSettled(
      [...this.runs.values()].flatMap((run) =>
        run.featureExecutionPromise ? [run.featureExecutionPromise] : [],
      ),
    );
    this.listeners.clear();
  }
}
