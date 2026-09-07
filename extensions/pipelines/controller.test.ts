import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  AgentTreeSession,
  AgentTreeSessionEvent,
} from "../shared/agent-tree/domain.ts";
import {
  PipelineController,
  pipelineDiscoverySubmissionAllowed,
} from "./controller.ts";
import { inspectPipeline, PIPELINE_CHECK_MAX_BYTES } from "./inspection.ts";
import { executeFeatureGraph } from "./feature-graph-executor.ts";
import { createFeatureReviewRuntime } from "./feature-task-runtime.ts";
import { pipelineSessionToolPolicy, pipelineThinkingLevel } from "./session.ts";
import { buildPipelineRows, cancelPipelineRow } from "./dashboard.ts";
import {
  AUDIT_SEGMENT_LUNA_ROLES,
  EXECUTOR_AUDIT_ROLE,
  FEATURE_FINALIZER_ROLE,
  FEATURE_PLAN_ROLES,
  FEATURE_PIPELINE_DISCOVERY_ROLES,
  STATIC_LUNA_AUDIT_ROLES,
  FINAL_AUDIT_ROLE,
  LUNA_MODEL,
  PIPELINE_CHILD_ROLES,
  PLAN_PIPELINE_DISCOVERY_ROLES,
  PLAN_PIPELINE_SYNTHESIS_ROLE,
  SMALL_FEATURE_IMPLEMENTER_ROLE,
  SMALL_FEATURE_PIPELINE_CHILD_ROLES,
  ASTRA_MODEL,
  SOL_MODEL,
  TERRA_MODEL,
  childContextPolicyFor,
  type PipelineChildRole,
  type PipelineHandoff,
} from "./domain.ts";
import { FEATURE_DISCOVERY_COVERAGE } from "./discovery-report.ts";
import {
  buildFeatureAuditHandoff,
  validateFeatureAuditHandoff,
} from "./feature-audit-handoff.ts";
import { planDiscoveryCoverage } from "./plan-discovery-report.ts";
import {
  FEATURE_CANDIDATE_ROLES,
  FEATURE_CANDIDATE_STEERING_LIMIT_MS,
  FEATURE_CANDIDATE_STEERING_WARNING_MS,
  FEATURE_DISCOVERY_SYNTHESIS_ROLE,
  FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
  type FeatureCandidateHandoff,
  type FeatureCandidateRole,
  type FeatureSelection,
  type FeatureSynthesisProvenance,
} from "./feature-best-of-three.ts";
import type {
  FeatureCallerWorktree,
  FeatureGitOperations,
  FeatureTemporaryWorktree,
  FeatureWorktreeLifecycle,
  FrozenFeatureCandidate,
  FeatureSynthesisWorktree,
  ValidatedFeatureSynthesis,
} from "./feature-worktrees.ts";
import type { PipelineWallclockScheduler } from "./wallclock.ts";

interface LinkedWorktreeFixture {
  root: string;
  primary: string;
  linked: string;
}

function createLinkedWorktreeFixture(
  prefix: string,
  files: Readonly<Record<string, string>> = { "baseline.txt": "baseline\n" },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const primary = path.join(root, "primary");
  const linked = path.join(root, "linked");
  fs.mkdirSync(primary);
  execFileSync("git", ["init", "-q"], { cwd: primary });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
    cwd: primary,
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: primary,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: primary });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(primary, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  execFileSync("git", ["add", "."], { cwd: primary });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: primary });
  execFileSync("git", ["worktree", "add", "-q", "-b", "feature/test", linked], {
    cwd: primary,
  });
  return { root, primary, linked };
}

let sharedImplementationFixture: LinkedWorktreeFixture | undefined;

function implementationWorkingDir() {
  sharedImplementationFixture ??= createLinkedWorktreeFixture(
    "pipeline-implementation-",
  );
  return sharedImplementationFixture.linked;
}

test.after(() => {
  if (sharedImplementationFixture) {
    fs.rmSync(sharedImplementationFixture.root, {
      recursive: true,
      force: true,
    });
  }
});

class FakePipelineSession implements AgentTreeSession {
  readonly listeners = new Set<(event: AgentTreeSessionEvent) => void>();
  readonly prompts: string[] = [];
  readonly sends: string[] = [];
  readonly sessionFile: string;
  isStreaming = false;
  interrupted = 0;
  disposed = 0;
  mutationEnabled = 0;
  interruptError: Error | undefined;

  readonly activeTools: ReadonlyArray<string>;
  readonly spec: AgentNodeSpec;
  readonly autoReport?: string | ((turn: number) => string);
  readonly discoverySubmit?: (value: unknown) => void;
  private turn = 0;

  constructor(
    activeTools: ReadonlyArray<string>,
    spec: AgentNodeSpec,
    autoReport?: string | ((turn: number) => string),
    discoverySubmit?: (value: unknown) => void,
    private readonly synchronousAutoComplete = false,
  ) {
    this.activeTools = activeTools;
    this.spec = spec;
    this.autoReport = autoReport;
    this.discoverySubmit = discoverySubmit;
    this.sessionFile = `/tmp/${spec.scopeId}-${spec.role}-${spec.attempt}.jsonl`;
  }

  subscribe(listener: (event: AgentTreeSessionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentTreeSessionEvent) {
    if (event.type === "run_started") this.isStreaming = true;
    if (event.type === "settled") this.isStreaming = false;
    for (const listener of this.listeners) listener(event);
  }

  private autoComplete() {
    if (!this.autoReport) return;
    const report =
      typeof this.autoReport === "function"
        ? this.autoReport(this.turn++)
        : this.autoReport;
    const settle = () =>
      this.emit({
        type: "settled",
        outcome: { type: "completed", finalText: report },
      });
    if (this.synchronousAutoComplete) settle();
    else queueMicrotask(settle);
  }

  async prompt(text: string) {
    this.prompts.push(text);
    this.isStreaming = true;
    this.autoComplete();
  }

  async send(text: string) {
    this.sends.push(text);
    this.emit({ type: "run_started" });
    this.emit({ type: "user", text });
    this.autoComplete();
  }

  enableMutation() {
    this.mutationEnabled++;
  }

  async interrupt() {
    this.interrupted++;
    if (this.interruptError) throw this.interruptError;
    this.emit({ type: "settled", outcome: { type: "cancelled" } });
  }

  dispose() {
    this.disposed++;
  }
}

const BASE_COMMIT = "a".repeat(40);
const CANDIDATE_COMMITS: Readonly<Record<FeatureCandidateRole, string>> = {
  Minimal: "b".repeat(40),
  Robust: "c".repeat(40),
  Architectural: "d".repeat(40),
};
const FINAL_SYNTHESIS_COMMIT = "e".repeat(40);

class ManualScheduler implements PipelineWallclockScheduler {
  readonly scheduled: Array<{
    delayMs: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];

  schedule(delayMs: number, callback: () => void) {
    const entry = { delayMs, callback, cancelled: false };
    this.scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  fire(delayMs: number) {
    for (const entry of this.scheduled) {
      if (!entry.cancelled && entry.delayMs === delayMs) entry.callback();
    }
  }

  invokeQueued(delayMs: number) {
    for (const entry of this.scheduled) {
      if (entry.delayMs === delayMs) entry.callback();
    }
  }
}

class FakeFeatureLifecycle implements FeatureWorktreeLifecycle {
  readonly temporaryRoot: string;
  readonly caller: FeatureCallerWorktree;
  cleaned = 0;
  promoted = 0;
  selectionReadOnlyChecks = 0;
  synthesisCreated = 0;

  constructor(
    runId: string,
    caller: FeatureCallerWorktree,
    private readonly failCandidateReservation = false,
  ) {
    this.temporaryRoot = `/tmp/${runId}-best-of-three`;
    this.caller = caller;
  }

  createCandidateWorktrees() {
    if (this.failCandidateReservation) {
      throw new Error("Injected candidate reservation race");
    }
    return FEATURE_CANDIDATE_ROLES.map((role) => ({
      role,
      path: `${this.temporaryRoot}/candidate-${role.toLowerCase()}`,
      branchRef: `pipi-feature/test/candidate-${role.toLowerCase()}`,
      baseCommit: this.caller.baseCommit,
    }));
  }

  freezeCandidate(
    worktree: FeatureTemporaryWorktree,
    handoff: FeatureCandidateHandoff,
  ): FrozenFeatureCandidate {
    assert.equal(handoff.role, worktree.role);
    assert.equal(handoff.worktreePath, worktree.path);
    assert.equal(handoff.branchRef, worktree.branchRef);
    assert.equal(handoff.baseCommit, worktree.baseCommit);
    assert.equal(handoff.candidateHeadCommit, CANDIDATE_COMMITS[worktree.role]);
    return {
      ...worktree,
      headCommit: handoff.candidateHeadCommit,
      changedPaths: handoff.changedPaths,
      warnings: [],
      boundedDiff: {
        text: `diff --git a/${handoff.changedPaths[0]} b/${handoff.changedPaths[0]}`,
        truncated: false,
        bytes: 64,
      },
      frozen: true,
    };
  }

  prepareSelectionDirectory() {
    return `${this.temporaryRoot}/selection`;
  }

  assertSelectionReadOnly(_candidates: ReadonlyArray<FrozenFeatureCandidate>) {
    this.selectionReadOnlyChecks++;
  }

  validateSelection(
    selection: FeatureSelection,
    _candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ) {
    if (
      selection.augmentationCandidates.some(
        ({ sourceRole }) => sourceRole === selection.primaryCandidate,
      )
    ) {
      throw new Error(
        "Selection augmentation must originate from a losing candidate before synthesis mutation.",
      );
    }
  }

  createSynthesisWorktree(
    primary: FrozenFeatureCandidate,
  ): FeatureSynthesisWorktree {
    this.synthesisCreated++;
    return {
      path: `${this.temporaryRoot}/selection`,
      branchRef: "pipi-feature/test/synthesis",
      primaryRole: primary.role,
      primaryCommit: primary.headCommit,
    };
  }

  commitAssignedWorktree(
    role: string,
    _workingDir: string,
    _paths: ReadonlyArray<string>,
  ) {
    const candidate = candidateRoleFromSpec(role);
    const head = candidate
      ? CANDIDATE_COMMITS[candidate]
      : FINAL_SYNTHESIS_COMMIT;
    return { head, changedPaths: [] };
  }

  validateSynthesis(
    worktree: FeatureSynthesisWorktree,
    provenance: FeatureSynthesisProvenance,
    _selection: FeatureSelection,
    _candidates: ReadonlyArray<FrozenFeatureCandidate>,
  ): ValidatedFeatureSynthesis {
    assert.equal(provenance.primaryCandidate, worktree.primaryRole);
    assert.equal(provenance.primaryCommit, worktree.primaryCommit);
    assert.equal(provenance.finalCommit, FINAL_SYNTHESIS_COMMIT);
    return {
      ...worktree,
      finalCommit: FINAL_SYNTHESIS_COMMIT,
      changedPaths: provenance.changedPaths,
    };
  }

  promote(synthesis: ValidatedFeatureSynthesis) {
    assert.equal(synthesis.finalCommit, FINAL_SYNTHESIS_COMMIT);
    this.promoted++;
  }

  cleanup() {
    this.cleaned++;
    return [];
  }
}

function candidateRoleFromSpec(role: string) {
  return FEATURE_CANDIDATE_ROLES.find(
    (candidate) => `candidate-${candidate.toLowerCase()}` === role,
  );
}

function featureGitHarness(
  lifecycles: FakeFeatureLifecycle[],
  namespaceAvailable: (runId: string) => boolean = () => true,
  failCandidateReservation = false,
  driftBeforeBuild = false,
): FeatureGitOperations {
  const preflightCalls = new Map<string, number>();
  return {
    preflight(workingDir) {
      const call = (preflightCalls.get(workingDir) ?? 0) + 1;
      preflightCalls.set(workingDir, call);
      let baseCommit = BASE_COMMIT;
      try {
        baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: workingDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        // Most controller fixtures intentionally use a synthetic workspace.
      }
      if (driftBeforeBuild && call > 1) baseCommit = "f".repeat(40);
      return {
        workingDir,
        repositoryRoot: workingDir,
        commonGitDir: "/tmp/repo/.git",
        branch: "feat/test",
        branchRef: "refs/heads/feat/test",
        baseCommit,
      };
    },
    namespaceAvailable(_caller, runId) {
      return namespaceAvailable(runId);
    },
    createLifecycle(caller, runId) {
      const lifecycle = new FakeFeatureLifecycle(
        runId,
        caller,
        failCandidateReservation,
      );
      lifecycles.push(lifecycle);
      return lifecycle;
    },
  };
}

function harness(
  options: {
    rootGate?: Promise<void>;
    autoCompletePlan?: boolean;
    sessionGate?: (spec: AgentNodeSpec) => Promise<void> | undefined;
    autoCompleteFeatureDiscovery?: boolean;
    autoCompleteFeaturePlanning?: boolean;
    realFeatureExecution?: boolean;
    malformedFeatureCandidateOnce?: boolean;
    malformedFeatureGraphOnce?: boolean;
    autoCompleteDiscoverySynthesis?: boolean;
    autoCompleteCandidates?: boolean;
    synchronousCandidateFirstTurn?: boolean;
    autoCompleteSelectionAndSynthesis?: boolean;
    rejectRootCancellation?: boolean;
    runIds?: ReadonlyArray<string>;
    namespaceAvailable?: (runId: string) => boolean;
    makeRunToken?: () => string;
    useDefaultRunId?: boolean;
    failCandidateReservation?: boolean;
    driftFeatureBaseBeforeBuild?: boolean;
    scheduler?: PipelineWallclockScheduler;
  } = {},
) {
  const sessions: FakePipelineSession[] = [];
  const handoffs: PipelineHandoff[] = [];
  const lifecycles: FakeFeatureLifecycle[] = [];
  const featureExecutionSignals: AbortSignal[] = [];
  const featureReviewSignals: AbortSignal[] = [];
  const featureReviewDiffBases: Array<string | undefined> = [];
  const featureReviewKnownResidualPaths: ReadonlyArray<string>[] = [];
  let agentSequence = 0;
  let runSequence = 0;
  let featureCleanupCompleted = 0;
  const injectedRunIds = [...(options.runIds ?? [])];
  let rootToolNames: string[] = [];
  const rootToolsByRun = new Map<string, ReadonlyArray<ToolDefinition>>();
  let discoverySubmitCallback:
    | ((
        runId: string,
        role: string,
        sessionToken: string,
        value: unknown,
      ) => void)
    | undefined;
  const artifactRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-artifacts-"),
  );
  const controller = new PipelineController({
    artifactRoot,
    ...(options.useDefaultRunId
      ? {}
      : {
          makeRunId: (pipelineName: string) =>
            injectedRunIds.shift() ??
            `${pipelineName}-${(++runSequence).toString(16).padStart(8, "0")}`,
        }),
    ...(options.makeRunToken ? { makeRunToken: options.makeRunToken } : {}),
    makeAgentId: () => `node-${++agentSequence}`,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
    createSessionFactory: (
      rootTools: (runId: string) => ReadonlyArray<ToolDefinition>,
      definitionForRun,
      _auditSubmit,
      _auditSessionCreated,
      _auditToolAllowed,
      discoverySubmit,
      discoverySessionCreated,
      discoveryToolAllowed,
      _executionFinish,
      _executionFinishSessionCreated,
      featureTaskHost,
    ) => {
      discoverySubmitCallback = discoverySubmit;
      return {
        async create(spec) {
          if (!spec.parentId && options.rootGate) await options.rootGate;
          await options.sessionGate?.(spec);
          const isImplementationRoot =
            !spec.parentId && spec.role === "pipeline-root";
          const configuredRootTools = isImplementationRoot
            ? rootTools(spec.scopeId ?? "")
            : [];
          const orchestration = configuredRootTools.map((tool) => tool.name);
          if (isImplementationRoot) {
            rootToolNames = orchestration;
            rootToolsByRun.set(spec.scopeId ?? "", configuredRootTools);
          }
          const candidateRole = candidateRoleFromSpec(spec.role);
          const featurePlanRole = FEATURE_PLAN_ROLES.find(
            (role) => role === spec.role,
          );
          const planRole = PLAN_PIPELINE_DISCOVERY_ROLES.find(
            (role) => role === spec.role,
          );
          const autoReport =
            featurePlanRole && options.autoCompleteFeaturePlanning !== false
              ? (turn: number) =>
                  options.malformedFeatureCandidateOnce &&
                  featurePlanRole === "feature-plan-minimal" &&
                  turn === 0
                    ? "{}"
                    : JSON.stringify(
                        featureCandidatePlan(
                          featurePlanRole === "feature-plan-minimal"
                            ? "Minimal"
                            : "Robust",
                        ),
                      )
              : spec.role === FEATURE_FINALIZER_ROLE &&
                  options.autoCompleteFeaturePlanning !== false
                ? (turn: number) =>
                    turn === 0
                      ? JSON.stringify(featureCanonicalPlan())
                      : turn === 1
                        ? options.malformedFeatureGraphOnce
                          ? "{}"
                          : JSON.stringify(
                              options.realFeatureExecution
                                ? realControllerGraph()
                                : featureExecutionGraph(),
                            )
                        : turn === 2 && options.malformedFeatureGraphOnce
                          ? JSON.stringify(
                              options.realFeatureExecution
                                ? realControllerGraph()
                                : featureExecutionGraph(),
                            )
                          : "Final review settled after validated finalization."
                : planRole && options.autoCompletePlan
                  ? planReportForRole(planRole)
                  : spec.role === PLAN_PIPELINE_SYNTHESIS_ROLE &&
                      options.autoCompletePlan
                    ? "# Controller test plan\n\nA free-form plan."
                    : spec.role === FEATURE_DISCOVERY_SYNTHESIS_ROLE &&
                        options.autoCompleteDiscoverySynthesis !== false
                      ? JSON.stringify(discoverySynthesisResult())
                      : candidateRole &&
                          options.autoCompleteCandidates !== false
                        ? options.synchronousCandidateFirstTurn
                          ? (turn: number) =>
                              turn === 0
                                ? "{}"
                                : JSON.stringify(
                                    candidateHandoff(
                                      candidateRole,
                                      spec,
                                      lifecycles.find((lifecycle) =>
                                        spec.cwd.startsWith(
                                          lifecycle.temporaryRoot,
                                        ),
                                      )?.caller.baseCommit ?? BASE_COMMIT,
                                    ),
                                  )
                          : JSON.stringify(
                              candidateHandoff(
                                candidateRole,
                                spec,
                                lifecycles.find((lifecycle) =>
                                  spec.cwd.startsWith(lifecycle.temporaryRoot),
                                )?.caller.baseCommit ?? BASE_COMMIT,
                              ),
                            )
                        : spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE &&
                            options.autoCompleteSelectionAndSynthesis !== false
                          ? (turn: number) =>
                              JSON.stringify(
                                turn === 0
                                  ? selectionResult()
                                  : implementationSynthesisResult(),
                              )
                          : options.autoCompleteFeatureDiscovery !== false &&
                              spec.parentId &&
                              definitionForRun(spec.scopeId ?? "") ===
                                "feature-pipeline" &&
                              spec.role.startsWith("discover-")
                            ? reportForRole(spec.role)
                            : undefined;
          const discoveryAllowed =
            Boolean(discoverySubmit) &&
            Boolean(discoveryToolAllowed?.(spec.scopeId ?? "", spec.role));
          const discoveryToken = discoveryAllowed
            ? `token-${spec.scopeId}-${spec.role}-${spec.attempt}`
            : undefined;
          if (discoveryToken) {
            discoverySessionCreated?.(
              spec.scopeId ?? "",
              spec.role,
              discoveryToken,
            );
          }
          const session = new FakePipelineSession(
            !isImplementationRoot
              ? [
                  "read",
                  "fd",
                  "rg",
                  "web_search_codex",
                  "web_fetch_codex",
                  ...(discoveryAllowed
                    ? [
                        spec.role === FEATURE_DISCOVERY_SYNTHESIS_ROLE
                          ? "pipeline_discovery_synthesis_submit"
                          : "pipeline_discovery_submit",
                      ]
                    : []),
                ]
              : ["read", "bash", "edit", "write", ...orchestration],
            spec,
            autoReport,
            discoveryToken
              ? (value) =>
                  discoverySubmit?.(
                    spec.scopeId ?? "",
                    spec.role,
                    discoveryToken,
                    value,
                  )
              : undefined,
            Boolean(candidateRole && options.synchronousCandidateFirstTurn),
          );
          if (!spec.parentId && options.rejectRootCancellation) {
            session.interruptError = new Error("root cancellation rejected");
          }
          if (options.realFeatureExecution) {
            const originalPrompt = session.prompt.bind(session);
            const originalSend = session.send.bind(session);
            const finishRealTask = async () => {
              session.isStreaming = true;
              try {
                const host = featureTaskHost?.(spec.scopeId!, spec.role);
                assert.ok(host);
                const worker = spec.role.startsWith("feature-task-");
                const file = `output-${spec.role.slice("feature-task-".length)}.txt`;
                if (worker)
                  fs.writeFileSync(
                    path.join(spec.cwd, file),
                    "verified output\n",
                  );
                const result = await host.finalize({
                  commitPaths: worker ? [file] : [],
                  summary:
                    "Synthetic session finalized through real controller task tools.",
                });
                assert.equal(
                  result.validated,
                  true,
                  JSON.stringify(result.checks),
                );
                session.emit({
                  type: "settled",
                  outcome: {
                    type: "completed",
                    finalText: "Validated through controller tools.",
                  },
                });
              } catch (error) {
                session.emit({
                  type: "settled",
                  outcome: { type: "failed", error: String(error) },
                });
              }
            };
            session.prompt = async (text) => {
              if (spec.role.startsWith("feature-task-")) {
                session.prompts.push(text);
                await finishRealTask();
              } else await originalPrompt(text);
            };
            session.send = async (text) => {
              if (
                spec.role === FEATURE_FINALIZER_ROLE &&
                session.mutationEnabled > 0
              ) {
                session.sends.push(text);
                session.emit({ type: "run_started" });
                await finishRealTask();
              } else await originalSend(text);
            };
          }
          sessions.push(session);
          return session;
        },
      };
    },
    onHandoff: (handoff) => {
      handoffs.push(handoff);
    },
    async executeFeatureGraph(input) {
      if (options.realFeatureExecution) return executeFeatureGraph(input);
      if (input.signal) featureExecutionSignals.push(input.signal);
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: input.workingDir,
        encoding: "utf8",
      }).trim();
      const task = input.graph.tasks[0]!;
      const tasks = [
        {
          id: task.id,
          kind: "task" as const,
          objective: task.objective,
          status: "validated" as const,
          attempt: 1,
          attempts: [
            {
              attempt: 1,
              sessionId: `feature-task-${task.id}`,
              status: "completed" as const,
            },
          ],
          branchId: "root",
          branch: "feature/test",
          worktree: input.workingDir,
          taskBaseCommit: head,
          validatedCommit: head,
          summary: "The injected executor validated the feature task.",
          checks: [],
          warnings: [],
          residualPaths: [],
        },
      ];
      const snapshot = {
        tree: input.tree,
        tasks,
        branches: [],
        joins: [],
        warnings: [],
        residualPaths: ["child-only-residual.log"],
      };
      input.onSnapshot?.(snapshot);
      return {
        status: "completed" as const,
        head,
        tree: input.tree,
        tasks,
        branches: [],
        joins: [],
        warnings: [],
        residualPaths: ["child-only-residual.log"],
        rootResidualPaths: ["root-review-residual.log"],
        rootTrackedResiduals: [
          {
            path: "root-review-residual.log",
            fingerprint: "a".repeat(64),
          },
        ],
        cleanupCompleted() {
          featureCleanupCompleted++;
          return [];
        },
        recordRetainedResources() {
          // The controller calls this for terminal non-success runs; the
          // deterministic graph fixture has no resources to retain.
        },
      };
    },
    createFeatureReviewRuntime(input) {
      if (options.realFeatureExecution)
        return createFeatureReviewRuntime(input);
      if (input.signal) featureReviewSignals.push(input.signal);
      featureReviewDiffBases.push(input.diffBaseCommit);
      featureReviewKnownResidualPaths.push([
        ...(input.knownResidualPaths ?? []),
      ]);
      assert.deepEqual(input.knownTrackedResiduals, [
        {
          path: "root-review-residual.log",
          fingerprint: "a".repeat(64),
        },
      ]);
      let began = false;
      const snapshot = () => ({
        id: "final-review",
        kind: "final-review" as const,
        objective: "Review and finalize the integrated feature.",
        status: began ? ("validated" as const) : ("waiting" as const),
        attempt: began ? 1 : 0,
        attempts: began ? [{ attempt: 1, status: "completed" as const }] : [],
        branchId: "root",
        branch: "feature/test",
        worktree: input.workingDir,
        summary: began ? "The final review accepted the feature." : undefined,
        checks: began
          ? input.checks.map((check) => ({
              checkId: check.id,
              command: check.command,
              cwd: check.cwd,
              purpose: check.purpose,
              required: check.required,
              status: "passed" as const,
              exitCode: 0,
              stdout: "",
              stderr: "",
              changedPaths: [],
              startedAt: 1,
              finishedAt: 2,
            }))
          : [],
        warnings: [],
        residualPaths: [],
      });
      return {
        host: {
          async diff() {
            throw new Error(
              "The deterministic controller fixture does not call review diff.",
            );
          },
          async check() {
            throw new Error(
              "The deterministic controller fixture does not call review check.",
            );
          },
          async finalize() {
            throw new Error(
              "The deterministic controller fixture does not call review finalize.",
            );
          },
        },
        begin() {
          began = true;
          input.onSnapshot?.(snapshot());
        },
        snapshot,
      };
    },
    featureGit: options.realFeatureExecution
      ? undefined
      : featureGitHarness(
          lifecycles,
          options.namespaceAvailable,
          options.failCandidateReservation,
          options.driftFeatureBaseBeforeBuild,
        ),
  });
  return {
    controller,
    sessions,
    handoffs,
    lifecycles,
    artifactRoot,
    featureExecutionSignals,
    featureReviewSignals,
    featureReviewDiffBases,
    featureReviewKnownResidualPaths,
    get featureCleanupCompleted() {
      return featureCleanupCompleted;
    },
    get rootToolNames() {
      return rootToolNames;
    },
    rootTool(runId: string, name: string) {
      return rootToolsByRun.get(runId)?.find((tool) => tool.name === name);
    },
    submitUnauthorized(role: string, value: unknown) {
      assert.ok(discoverySubmitCallback);
      discoverySubmitCallback(
        "approved-feature-run-00000001",
        role,
        "unauthorized-token",
        value,
      );
    },
  };
}

const request = (workingDir = implementationWorkingDir()) => ({
  pipelineName: "approved-feature-run",
  task: "Implement the approved feature",
  workingDir,
  gitCommit: true,
  worktreeRoot: fs.mkdtempSync(
    path.join(os.tmpdir(), "pipeline-graph-worktrees-"),
  ),
  worktreePrepare: [],
});

function nonFeatureRequest(
  pipeline: "small-feature-pipeline" | "plan-pipeline" | "audit-pipeline",
  workingDir = implementationWorkingDir(),
) {
  const {
    worktreeRoot: _worktreeRoot,
    worktreePrepare: _worktreePrepare,
    ...base
  } = request(workingDir);
  return { ...base, pipeline };
}

test("feature invocation rejects git_commit false or omission before Git lifecycle or sessions", async () => {
  const run = harness();
  assert.throws(
    () =>
      run.controller.start({
        pipelineName: "approved-feature-run",
        task: "Implement the approved feature",
        workingDir: "/tmp/work",
        pipeline: "feature-pipeline",
        gitCommit: false,
      }),
    /requires explicit git_commit: true/,
  );
  assert.throws(
    () =>
      run.controller.start({
        pipelineName: "approved-feature-run",
        task: "Implement the approved feature",
        workingDir: "/tmp/work",
        pipeline: "feature-pipeline",
      }),
    /requires explicit git_commit: true/,
  );
  assert.equal(run.sessions.length, 0);
  assert.equal(run.lifecycles.length, 0);
  await run.controller.dispose();
});

test("plan and audit reject commit authority, while small-feature retains it", async () => {
  const run = harness();
  for (const pipeline of ["plan-pipeline", "audit-pipeline"] as const) {
    assert.throws(
      () =>
        run.controller.start({
          ...nonFeatureRequest(pipeline),
          gitCommit: true,
          ...(pipeline === "plan-pipeline" ? { planPath: null } : {}),
        }),
      new RegExp(
        `git_commit is only supported for feature-pipeline and small-feature-pipeline.*${pipeline}`,
      ),
    );
  }
  const smallFeatureId = run.controller.start({
    ...nonFeatureRequest("small-feature-pipeline"),
    gitCommit: true,
  });
  await settleInitialization();
  assert.equal(run.controller.get(smallFeatureId)?.status, "running");
  await run.controller.dispose();
});

async function settleInitialization() {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForHandoff(
  run: ReturnType<typeof harness>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handoff = run.handoffs.find((candidate) => candidate.runId === runId);
    if (handoff) return handoff;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for terminal handoff for ${runId}.`);
}

function requireArtifactPage(
  value: Awaited<ReturnType<PipelineController["readArtifact"]>>,
) {
  if (!("text" in value)) throw new Error("Expected an artifact read page.");
  return value;
}

function discoverySynthesisResult() {
  return {
    reportType: "feature-discovery-synthesis-v1" as const,
    summary: "Synthesized all validated discovery tracks",
    featureContract:
      "Implement the approved feature without changing neighboring pipelines.",
    acceptanceCriteria: [
      {
        scenario: "Best-of-3 implementation completes",
        expected: "The exact verified synthesized state is promoted",
        verification: "Inspect controller lifecycle evidence",
      },
    ],
    constraints: ["Preserve the hardcoded feature-pipeline graph"],
    nonGoals: ["Do not repeat discovery"],
    precedents: [
      {
        reference: "extensions/pipelines/controller.ts",
        discoveryDetail:
          "Controller behavior provides direct repository evidence",
        finding: "Controller-owned fan-in is the established precedent",
      },
    ],
    relevantPaths: ["extensions/pipelines/controller.ts"],
    contractsInvariants: ["Selection happens before synthesis writes"],
    risks: ["Caller worktree drift must prevent promotion"],
    unknowns: ["Live provider availability is not exercised by this fixture"],
    assumptions: ["Validated discovery reports are complete"],
    verificationExpectations: ["Run deterministic repository checks"],
  };
}

function candidateHandoff(
  role: FeatureCandidateRole,
  spec: AgentNodeSpec,
  baseCommit = BASE_COMMIT,
) {
  const changedPath = `src/${role.toLowerCase()}.ts`;
  return {
    reportType: "feature-implementation-candidate-v1" as const,
    role,
    approachSummary: `${role} complete implementation`,
    changedPaths: [changedPath],
    checks: ["focused test passed"],
    assumptions: [],
    tradeoffs: ["Role objective was applied without sacrificing correctness"],
    unresolvedIssues: [],
    worktreePath: spec.cwd,
    branchRef: `pipi-feature/test/candidate-${role.toLowerCase()}`,
    baseCommit,
    candidateHeadCommit: CANDIDATE_COMMITS[role],
  };
}

function comparison(role: FeatureCandidateRole) {
  return {
    role,
    criteria: {
      correctness: "Meets the feature contract",
      acceptanceCoverage: "Covers the observable criterion",
      regressionRisk: "Focused and verified",
      repositoryFit: "Uses repository patterns",
      simplicity:
        role === "Minimal" ? "Simplest reliable candidate" : "More involved",
      maintainability: "Maintainable within scope",
      verificationQuality: "Focused check passed",
    },
    usableBase: true,
  };
}

function selectionResult() {
  return {
    reportType: "feature-implementation-selection-v1" as const,
    selectionOnlyAcknowledgement:
      "No code was written before primary selection." as const,
    comparisons: FEATURE_CANDIDATE_ROLES.map(comparison),
    primaryCandidate: "Minimal" as const,
    rationale:
      "Minimal is the simplest candidate that fully and reliably solves the task.",
    augmentationCandidates: [],
  };
}

function implementationSynthesisResult() {
  return {
    reportType: "feature-implementation-synthesis-v1" as const,
    primaryCandidate: "Minimal" as const,
    primaryCommit: CANDIDATE_COMMITS.Minimal,
    acceptedAugmentations: [],
    rejectedAugmentations: [],
    changedPaths: [],
    checks: [
      `npm test passed; WINNER_MARKER Minimal borrowed idea ${FINAL_SYNTHESIS_COMMIT}`,
    ],
    assumptions: [],
    unresolvedIssues: [],
    finalCommit: FINAL_SYNTHESIS_COMMIT,
  };
}

function planReportForRole(
  role: (typeof PLAN_PIPELINE_DISCOVERY_ROLES)[number],
) {
  return JSON.stringify({
    reportType: "plan-discovery-v1",
    role,
    applicability: "applicable",
    summary: `${role} repository evidence`,
    coverage: planDiscoveryCoverage(role).map((criterion) => ({
      criterion,
      status: "covered",
      conclusion: `${criterion} is covered by evidence`,
      evidence: [
        {
          kind: "code",
          reference: "extensions/pipelines/controller.ts",
          detail: "The controller provides direct repository evidence.",
        },
      ],
      implications: [],
    })),
    evidence: [
      {
        kind: "code",
        reference: "extensions/pipelines/controller.ts",
        detail: "The controller provides direct repository evidence.",
      },
    ],
    unknowns: [],
    constraints: [],
  });
}

function featureCandidatePlan(role: "Minimal" | "Robust") {
  return {
    reportType: "feature-plan-candidate-v1" as const,
    role,
    summary: `${role} repository-native feature plan.`,
    decisions: [
      {
        id: "DEC-1",
        title: "Keep the controller authoritative",
        body: "Route the feature through the existing controller boundary.",
        evidence: [
          {
            reference: "extensions/pipelines/controller.ts:PipelineController",
            finding: "The controller owns pipeline stage transitions.",
          },
        ],
        rejectedAlternatives: [],
      },
    ],
    changes: [
      {
        id: "CHANGE-1",
        path: "extensions/pipelines/controller.ts",
        symbols: ["PipelineController"],
        action: "modify" as const,
        body: "Implement the accepted bounded feature transition.",
        decisionRefs: ["DEC-1"],
        contractRefs: ["INV-1"],
        acceptanceRefs: ["AC-1"],
      },
    ],
    contracts: [
      {
        id: "INV-1",
        title: "One terminal transition",
        body: "Each pipeline run settles once.",
        paths: ["extensions/pipelines/controller.ts"],
      },
    ],
    acceptance: [
      {
        id: "AC-1",
        scenario: "The feature pipeline runs.",
        expected: "The controller records one validated result.",
        verification: "Exercise the controller state transition.",
      },
    ],
    verification: [
      {
        id: "CHECK-1",
        command: "bun test extensions/pipelines/controller.test.ts",
        cwd: ".",
        purpose: "Verify the controller behavior.",
        proves: ["AC-1", "INV-1"],
        required: true,
      },
    ],
    risks: [],
    blockers: [],
    tradeoffs: [`${role} keeps the proposal bounded.`],
  };
}

function featureCanonicalPlan() {
  const {
    role: _role,
    tradeoffs: _tradeoffs,
    ...candidate
  } = featureCandidatePlan("Minimal");
  return {
    ...candidate,
    reportType: "feature-canonical-plan-v1" as const,
    blockers: [],
    finalRationale: "The accepted plan is complete and repository-native.",
  };
}

function featureExecutionGraph() {
  return {
    reportType: "feature-execution-graph-v1" as const,
    summary: "Execute one bounded feature task.",
    baselineChecks: [],
    reviewChecks: [
      {
        id: "review-test",
        command: "bun test extensions/pipelines/controller.test.ts",
        cwd: ".",
        purpose: "Verify the integrated feature.",
        required: true,
      },
    ],
    tasks: [
      {
        id: "implement-feature",
        objective: "Implement the accepted feature.",
        branchGoal: "Leave the feature complete and verified.",
        dependsOn: [],
        context: {
          problem: "The approved feature is missing.",
          repositoryConventions: ["Keep state controller-owned."],
          relevantDiscovery: ["All five discovery roles were accepted."],
          precedents: [
            {
              path: "extensions/pipelines/controller.ts",
              symbol: "PipelineController",
              lesson: "Use controller-owned transitions.",
            },
          ],
          invariants: ["Each run settles once."],
        },
        readPaths: ["extensions/pipelines/controller.ts"],
        writePaths: ["extensions/pipelines/controller.ts"],
        instructions: ["Implement the bounded accepted change."],
        implementationSketch:
          "Update the controller and verify the transition.",
        acceptanceRefs: ["AC-1"],
        doneWhen: ["The focused controller behavior passes."],
        checks: [
          {
            id: "task-test",
            command: "bun test extensions/pipelines/controller.test.ts",
            cwd: ".",
            purpose: "Verify the task behavior.",
            required: true,
          },
        ],
      },
    ],
  };
}

function realControllerGraph() {
  const template = featureExecutionGraph();
  return {
    ...template,
    reviewChecks: [
      {
        id: "real-review",
        command: "test -f output-left.txt && test -f output-right.txt",
        cwd: ".",
        purpose: "Verify real joined task outputs.",
        required: true,
      },
    ],
    tasks: ["left", "right"].map((id) => ({
      ...template.tasks[0]!,
      id,
      readPaths: ["baseline.txt"],
      writePaths: [`output-${id}.txt`],
      checks: [
        {
          id: `${id}-output`,
          command: `test -f output-${id}.txt`,
          cwd: ".",
          purpose: "Verify real task output in sandbox.",
          required: true,
        },
      ],
    })),
  };
}

function reportForRole(role: string) {
  if (role === "implement-small-feature") {
    return JSON.stringify({
      summary: "Implemented and verified the bounded feature",
      changedPaths: ["src/feature.ts"],
      checks: ["focused tests passed"],
      assumptions: [],
      unresolvedItems: [],
    });
  }
  const featureDiscoveryRole = FEATURE_PIPELINE_DISCOVERY_ROLES.find(
    (candidate) => candidate === role,
  );
  if (featureDiscoveryRole) {
    const evidence = [
      {
        kind: "code",
        reference: "extensions/pipelines/controller.ts",
        detail: "Controller behavior provides direct repository evidence",
      },
    ];
    const candidateAcceptanceCriteria = [
      {
        scenario: "A feature discovery report settles",
        expected: "The host receives observable bounded evidence",
        verification: "Validate the parsed report before build activation",
        evidence,
      },
      {
        scenario: "Discovery evidence is incomplete",
        expected: "The report remains explicit and actionable",
        verification: "Inspect the validated report status and evidence",
        evidence,
      },
    ];
    return JSON.stringify({
      reportType: "feature-discovery-v2",
      role: featureDiscoveryRole,
      applicability: "applicable",
      summary: `${role} repository evidence`,
      coverage: FEATURE_DISCOVERY_COVERAGE[featureDiscoveryRole].map(
        (criterion) => ({
          criterion,
          status: "covered",
          conclusion: `${criterion} is covered by repository evidence`,
          evidence,
          implications: [],
        }),
      ),
      candidateAcceptanceCriteria:
        featureDiscoveryRole === "discover-outcome" ||
        featureDiscoveryRole === "discover-user-scenarios"
          ? candidateAcceptanceCriteria
          : [],
      unknowns: [],
      constraints: [],
    });
  }
  if (role.startsWith("discover-")) {
    return JSON.stringify({
      summary: role,
      evidence: ["repository evidence"],
      unknowns: [],
      constraints: [],
    });
  }
  if (role === EXECUTOR_AUDIT_ROLE) {
    return JSON.stringify({
      track: role,
      executedChecks: [
        {
          command: "npm run check",
          status: "passed",
          exitCode: 0,
          evidence: "Type check passed.",
        },
      ],
      workspaceChangesObserved: [],
      findings: [],
      unprovenChecks: [],
    });
  }
  if (role === "final-audit") {
    return JSON.stringify({
      mode: "initial",
      base_sha: "1234567",
      head_sha: "WORKTREE",
      verdict: "READY",
      findings: [],
      summary: "No actionable findings",
    });
  }
  return JSON.stringify({ track: role, findings: [], unprovenChecks: [] });
}

function featureDiscoveryValue(
  role: (typeof FEATURE_PIPELINE_DISCOVERY_ROLES)[number],
) {
  return JSON.parse(reportForRole(role)) as unknown;
}

function settleRole(run: ReturnType<typeof harness>, role: string) {
  const session = run.sessions.find(
    (candidate) => candidate.spec.role === role,
  );
  assert.ok(session);
  session.emit({
    type: "settled",
    outcome: { type: "completed", finalText: reportForRole(role) },
  });
}

function synthesisReport(
  reportType: "audit-synthesis-intermediate" | "audit-synthesis-final",
  integratedRoles: ReadonlyArray<string>,
  gitIdentity: { baseSha: string; headSha: string } = {
    baseSha: "UNAVAILABLE",
    headSha: "UNAVAILABLE",
  },
  findings: ReadonlyArray<Record<string, unknown>> = [],
) {
  if (reportType === "audit-synthesis-intermediate") {
    return JSON.stringify({
      reportType,
      integratedRoles,
      rootCauseCandidates: [],
      unresolvedConflicts: [],
      unprovenChecks: [],
      executedChecks: [],
      workspaceChangesObserved: [],
      hostWorkspaceObservation: null,
      summary: "Incremental synthesis retained validated evidence",
    });
  }
  return JSON.stringify({
    reportType,
    mode: "initial",
    baseSha: gitIdentity.baseSha,
    headSha: gitIdentity.headSha,
    integratedRoles,
    findings: findings.map(({ id: _id, ...finding }) => finding),
    closureResults: [],
    unresolvedConflicts: [],
    unprovenChecks: [],
    executedChecks: [],
    workspaceChangesObserved: [],
    hostWorkspaceObservation: {
      capturedAfterExecutor: true,
      workspaceChanged: false,
      statusBefore: { state: "available", value: "" },
      statusAfter: { state: "available", value: "" },
      dirtyDiffAfter: { state: "available", value: "" },
      combinedDiffAfter: { state: "available", value: "" },
      summary: "Fresh host observation completed.",
    },
    summary: "No supported findings",
  });
}

function finalAuditFinding(id = "AUD-001") {
  return {
    id,
    title: "Concrete final blocker",
    scenario: "The affected path is exercised",
    expected: "The required invariant holds",
    actual: "The invariant is violated",
    affectedPaths: ["extensions/pipelines/controller.ts"],
    relationship: "introduced",
    evidenceType: "static",
    evidence: "The validated audit found a concrete reachable defect.",
    impact: 3,
    confidence: 99,
    minimalNextAction: "Fix the defect and rerun its focused check.",
    sourceRoles: [AUDIT_SEGMENT_LUNA_ROLES[0]],
    scope: "initial",
    scopeReference: "task",
  };
}

async function finishEmbeddedAudit(
  run: ReturnType<typeof harness>,
  runId: string,
  deliverFinalReport = true,
  findings: ReadonlyArray<Record<string, unknown>> = [],
  baseSha?: string,
) {
  run.controller.setStage(runId, "final-audit");
  const agents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "The approved feature contract",
    assumptions: [],
    checks: ["focused checks passed"],
  });
  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  const first =
    run.sessions.find(
      (session) => session.spec.role === firstRole && session.spec.attempt > 1,
    ) ?? run.sessions.find((session) => session.spec.role === firstRole);
  assert.ok(first);
  const firstReport = JSON.parse(reportForRole(firstRole)) as Record<
    string,
    unknown
  >;
  first.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: JSON.stringify({
        ...firstReport,
        findings: findings.map(
          ({
            id: _id,
            sourceRoles: _roles,
            scope: _scope,
            scopeReference: _reference,
            ...finding
          }) => finding,
        ),
      }),
    },
  });
  await settleInitialization();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) {
    const session = [...run.sessions]
      .reverse()
      .find((candidate) => candidate.spec.role === role);
    assert.ok(session);
    session.emit({
      type: "settled",
      outcome: { type: "completed", finalText: reportForRole(role) },
    });
  }
  const synthesizer = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesizer);
  synthesizer.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport("audit-synthesis-intermediate", [firstRole]),
    },
  });
  await settleInitialization();
  let headSha = "UNAVAILABLE";
  try {
    headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: synthesizer.spec.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    // Non-Git fixtures intentionally use unavailable identity.
  }
  synthesizer.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport(
        "audit-synthesis-final",
        AUDIT_SEGMENT_LUNA_ROLES,
        {
          baseSha: baseSha ?? headSha,
          headSha,
        },
        findings,
      ),
    },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.equal(agents.length, 6);
  if (deliverFinalReport) {
    const waitTool = run.rootTool(runId, "pipeline_child_wait");
    assert.ok(waitTool);
    const synthesisNode = run.controller.agentView
      .list()
      .find((agent) => agent.role === "audit-synthesis");
    assert.ok(synthesisNode);
    await waitTool.execute(
      "final-audit-wait",
      { ids: [synthesisNode.id] },
      undefined,
      undefined,
      {} as ExtensionContext,
    );
  }
}

async function prepareFeatureCompletion(run: ReturnType<typeof harness>) {
  const runId = run.controller.start(request());
  await settleInitialization();
  await finishEmbeddedAudit(run, runId);
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions.find(
    (session) => session.spec.id === rootId,
  );
  assert.ok(rootSession);
  assert.equal(rootSession.spec.role, "pipeline-root");
  assert.equal(run.controller.getAgent(runId, rootId).status, "running");
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "Awaiting completion tool." },
  });
  assert.equal(run.controller.getAgent(runId, rootId).status, "idle");
  return { runId, rootSession };
}

function completionParams(rootSession: FakePipelineSession) {
  return {
    outcome: "Completed through the registered pipeline completion tool.",
    changed_paths: [],
    checks_evidence: [],
    assumptions: [],
    git_commits: [],
    report_summaries_references: [],
    unresolved_items: [],
    working_dir: rootSession.spec.cwd,
  };
}

async function invokeRegisteredCompletion(
  run: ReturnType<typeof harness>,
  runId: string,
  rootSession: FakePipelineSession,
  toolCallId: string,
) {
  const completeTool = run.rootTool(runId, "pipeline_complete");
  assert.ok(completeTool);
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  assert.equal(run.controller.getAgent(runId, rootId).status, "idle");
  rootSession.emit({ type: "run_started" });
  assert.equal(run.controller.getAgent(runId, rootId).status, "running");
  rootSession.emit({
    type: "tool",
    phase: "call",
    toolCallId,
    name: "pipeline_complete",
    text: "",
    isError: false,
  });
  const result = await Promise.race([
    completeTool.execute(
      toolCallId,
      completionParams(rootSession),
      undefined,
      undefined,
      {} as ExtensionContext,
    ),
    new Promise<never>((_, reject) =>
      setImmediate(() =>
        reject(
          new Error("pipeline_complete did not return before settlement."),
        ),
      ),
    ),
  ]);
  assert.equal(result.terminate, true);
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.equal(run.handoffs.length, 0);
  return result;
}

function emitCompletionResult(
  rootSession: FakePipelineSession,
  toolCallId: string,
) {
  rootSession.emit({
    type: "tool",
    phase: "result",
    toolCallId,
    name: "pipeline_complete",
    text: "Pipeline completion returned.",
    isError: false,
  });
}

function emitCompletionSettlement(rootSession: FakePipelineSession) {
  rootSession.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: "Pipeline completion returned.",
    },
  });
}

function completeSyntheticRoot(
  run: ReturnType<typeof harness>,
  runId: string,
  facts: Parameters<PipelineController["complete"]>[1],
  toolCallId: string,
) {
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions.find(
    (session) => session.spec.id === rootId,
  );
  assert.ok(rootSession);
  assert.equal(run.controller.getAgent(runId, rootId).status, "running");
  rootSession.emit({
    type: "tool",
    phase: "call",
    toolCallId,
    name: "pipeline_complete",
    text: "",
    isError: false,
  });
  run.controller.complete(runId, facts);
  assert.equal(run.handoffs.length, 0);
  emitCompletionResult(rootSession, toolCallId);
  emitCompletionSettlement(rootSession);
}

test("controller rejects a trailing-newline pipeline name before creating state", async () => {
  const run = harness();
  assert.throws(
    () =>
      run.controller.start({
        ...request(),
        pipelineName: "invalid-trailing-newline\n",
      }),
    /pipeline_name/,
  );
  assert.deepEqual(run.controller.list(), []);
  assert.equal(run.sessions.length, 0);
  assert.equal(run.lifecycles.length, 0);
  await run.controller.dispose();
});

test("canonical ID admission retries live and namespace collisions before discovery", async () => {
  const base = "collision-safe-feature";
  const occupiedId = `${base}-aaaaaaaa`;
  const firstId = `${base}-bbbbbbbb`;
  const secondId = `${base}-cccccccc`;
  let discoveryObservedDuringNamespaceCheck = false;
  const run = harness({
    runIds: [occupiedId, firstId, firstId, secondId],
    namespaceAvailable: (runId) => {
      discoveryObservedDuringNamespaceCheck ||= run.sessions.some((session) =>
        session.spec.role.startsWith("discover-"),
      );
      return runId !== occupiedId;
    },
  });
  const first = run.controller.start({ ...request(), pipelineName: base });
  const second = run.controller.start({
    ...request("/tmp/collision-safe-feature-second"),
    pipelineName: base,
  });
  assert.equal(first, firstId);
  assert.equal(second, secondId);
  assert.equal(discoveryObservedDuringNamespaceCheck, false);
  assert.deepEqual(
    run.controller
      .list()
      .map((item) => item.id)
      .sort(),
    [firstId, secondId].sort(),
  );
  await run.controller.dispose();

  const exhausted = harness({
    runIds: Array.from({ length: 9 }, () => firstId),
  });
  exhausted.controller.start({ ...request(), pipelineName: base });
  assert.throws(
    () =>
      exhausted.controller.start({
        ...request("/tmp/collision-safe-feature-exhausted"),
        pipelineName: base,
      }),
    /after 8 attempts.*No pipeline state was created/,
  );
  assert.equal(exhausted.controller.list().length, 1);
  await exhausted.controller.dispose();

  const namespaceExhausted = harness({
    runIds: Array.from(
      { length: 8 },
      (_, index) => `${base}-${(index + 1).toString(16).padStart(8, "0")}`,
    ),
    namespaceAvailable: () => false,
  });
  assert.throws(
    () =>
      namespaceExhausted.controller.start({ ...request(), pipelineName: base }),
    /after 8 attempts.*No pipeline state was created/,
  );
  assert.equal(namespaceExhausted.controller.list().length, 0);
  assert.equal(namespaceExhausted.sessions.length, 0);
  assert.equal(namespaceExhausted.lifecycles.length, 0);
  await namespaceExhausted.controller.dispose();

  const tokenInjected = harness({
    useDefaultRunId: true,
    makeRunToken: () => "deadbeef",
  });
  const tokenId = tokenInjected.controller.start({
    ...nonFeatureRequest("plan-pipeline"),
    pipelineName: "token-injected-plan",
    gitCommit: false,
    planPath: null,
  });
  assert.equal(tokenId, "token-injected-plan-deadbeef");
  await tokenInjected.controller.dispose();
});

test("feature admission requires explicit worktree root and preparation before sessions", async () => {
  const run = harness();
  const base = request();
  const { worktreeRoot: _root, ...withoutRoot } = base;
  assert.throws(
    () => run.controller.start(withoutRoot),
    /requires worktreeRoot/,
  );
  const { worktreePrepare: _prepare, ...withoutPrepare } = base;
  assert.throws(
    () => run.controller.start(withoutPrepare),
    /requires worktreePrepare.*explicit ordered array/,
  );
  assert.equal(run.sessions.length, 0);
  assert.deepEqual(run.controller.list(), []);
  await run.controller.dispose();
});

test("feature audit handoff admits only canonical requirements and final implementation evidence", () => {
  const evidence = { state: "available" as const, value: "captured evidence" };
  const handoff = buildFeatureAuditHandoff({
    canonicalPlan: featureCanonicalPlan(),
    git: {
      baseSha: BASE_COMMIT,
      headSha: FINAL_SYNTHESIS_COMMIT,
      worktreeLabel: "WORKTREE",
      workingDir: implementationWorkingDir(),
      branch: "feature/test",
      status: evidence,
      baseIsAncestor: "yes",
      commits: evidence,
      committedDiff: evidence,
      dirtyDiff: evidence,
      combinedDiff: { state: "available", value: "final base-relative diff" },
    },
    reviewSummary: "The final implementation passed Sol review.",
    reviewChecks: [
      {
        checkId: "review-check",
        command: "bun test",
        cwd: ".",
        purpose: "Validate the feature",
        required: true,
        status: "passed",
        exitCode: 0,
        stdout: "tests passed",
        stderr: "",
        changedPaths: [],
        startedAt: 1,
        finishedAt: 2,
      },
    ],
  });

  assert.deepEqual(validateFeatureAuditHandoff(handoff), []);
  assert.deepEqual(Object.keys(handoff).sort(), [
    "acceptance",
    "assumptions",
    "baseRelativeDiff",
    "currentGit",
    "finalSolSummary",
    "invariants",
    "reportType",
    "risks",
    "verification",
  ]);
  assert.equal(handoff.baseRelativeDiff.value, "final base-relative diff");
  assert.equal(handoff.verification.results[0]?.status, "passed");

  for (const forbidden of [
    "candidatePlans",
    "discoveryReports",
    "executionGraph",
    "tasks",
    "taskSummaries",
    "branches",
    "joins",
    "artifactDir",
    "retryHistory",
    "conflictResolutionDiscussions",
    "plannerAttribution",
    "solReviewSnapshot",
  ]) {
    assert.notDeepEqual(
      validateFeatureAuditHandoff({ ...handoff, [forbidden]: {} }),
      [],
      forbidden,
    );
  }
  assert.notDeepEqual(
    validateFeatureAuditHandoff({
      ...handoff,
      verification: {
        ...handoff.verification,
        results: [
          {
            ...handoff.verification.results[0],
            attempts: [{ sessionId: "x" }],
          },
        ],
      },
    }),
    [],
  );
  assert.notDeepEqual(
    validateFeatureAuditHandoff({
      ...handoff,
      currentGit: { ...handoff.currentGit, commits: ["process commit"] },
    }),
    [],
  );
});

async function waitForRealAudit(
  run: ReturnType<typeof harness>,
  runId: string,
) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Real feature fixture did not reach audit"));
    }, 15000);
    const unsubscribe = run.controller.subscribe(() => {
      const snapshot = run.controller.get(runId);
      if (
        snapshot?.stage === "audit" ||
        (snapshot && !["starting", "running"].includes(snapshot.status))
      ) {
        clearTimeout(timeout);
        unsubscribe();
        if (snapshot?.stage === "audit") resolve();
        else reject(new Error(JSON.stringify(snapshot)));
      }
    });
  });
}

test("cancelled production runs preserve diagnostic refs and completed implementation instead of deleting them", async () => {
  const fixture = createLinkedWorktreeFixture(
    "controller-cancel-real-feature-",
  );
  const worktreeRoot = path.join(fixture.root, "task-worktrees");
  fs.mkdirSync(worktreeRoot);
  const run = harness({ realFeatureExecution: true });
  try {
    const runId = run.controller.start({
      ...request(fixture.linked),
      worktreeRoot,
    });
    await waitForRealAudit(run, runId);
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.linked,
      encoding: "utf8",
    });
    await run.controller.cancelRun(runId);
    await waitForHandoff(run, runId);
    assert.equal(run.controller.get(runId)?.status, "cancelled");
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.linked,
        encoding: "utf8",
      }),
      head,
    );
    const refs = execFileSync(
      "git",
      [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/pipi-feature/${runId}`,
      ],
      { cwd: fixture.linked, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    assert.equal(refs.length, 2);
    assert.equal(fs.existsSync(path.join(worktreeRoot, runId)), true);
    for (const id of ["left", "right"])
      assert.equal(
        fs.readFileSync(path.join(fixture.linked, `output-${id}.txt`), "utf8"),
        "verified output\n",
      );
    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(run.artifactRoot, runId, "run-summary.json"),
        "utf8",
      ),
    );
    assert.equal(artifact.status, "cancelled");
  } finally {
    await run.controller.dispose();
    fs.rmSync(run.artifactRoot, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("production controller completes real Git and sandbox execution through review, audit handoff and cleanup", async () => {
  const fixture = createLinkedWorktreeFixture("controller-real-feature-");
  const worktreeRoot = path.join(fixture.root, "task-worktrees");
  fs.mkdirSync(worktreeRoot);
  const run = harness({ realFeatureExecution: true });
  try {
    const runId = run.controller.start({
      ...request(fixture.linked),
      worktreeRoot,
    });
    await waitForRealAudit(run, runId);
    const reviewed = run.controller.get(runId)!;
    assert.equal(reviewed.featureGraph?.planning.review, "accepted");
    assert.equal(
      reviewed.featureGraph?.tasks.filter(({ kind }) => kind === "task").length,
      2,
    );
    assert.ok(
      reviewed.featureGraph?.tasks.every(
        ({ status }) => status === "validated",
      ),
    );
    assert.equal(
      run.sessions.filter(({ spec }) => spec.role === FEATURE_FINALIZER_ROLE)
        .length,
      1,
    );
    assert.equal(
      run.sessions.find(({ spec }) => spec.role === FEATURE_FINALIZER_ROLE)!
        .mutationEnabled,
      1,
    );
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.primary,
      encoding: "utf8",
    }).trim();
    await finishEmbeddedAudit(run, runId, true, [], base);
    completeSyntheticRoot(
      run,
      runId,
      {
        outcome: "Real offline execution verified",
        changedPaths: ["output-left.txt", "output-right.txt"],
        checks: ["Real sandbox task and review checks passed"],
        assumptions: ["Model decisions are synthetic fixture responses"],
        git: [],
        reports: [],
        unresolvedItems: [],
        workingDir: fixture.linked,
      },
      "pipeline-complete-real",
    );
    await settleInitialization();
    await waitForHandoff(run, runId);
    assert.equal(run.controller.get(runId)?.status, "completed");
    assert.equal(run.handoffs.length, 1);
    assert.equal(fs.existsSync(path.join(worktreeRoot, runId)), false);
    const registered = execFileSync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: fixture.linked, encoding: "utf8" },
    );
    assert.equal(registered.includes(worktreeRoot), false);
    for (const id of ["left", "right"])
      assert.equal(
        fs.readFileSync(path.join(fixture.linked, `output-${id}.txt`), "utf8"),
        "verified output\n",
      );
    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(run.artifactRoot, runId, "run-summary.json"),
        "utf8",
      ),
    );
    assert.equal(artifact.status, "completed");
  } finally {
    await run.controller.dispose();
    fs.rmSync(run.artifactRoot, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("feature controller accepts corrected Astra plans, persists artifacts, executes the graph, and reuses the finalizer for review", async () => {
  const expectedDiffBase = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: implementationWorkingDir(),
    encoding: "utf8",
  }).trim();
  const run = harness({
    malformedFeatureCandidateOnce: true,
    malformedFeatureGraphOnce: true,
  });
  const runId = run.controller.start(request());
  await settleInitialization();

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.status, "running");
  assert.equal(snapshot?.stage, "audit");
  assert.deepEqual(
    snapshot?.featureGraph?.planning.candidates.map(({ role, status }) => ({
      role,
      status,
    })),
    [
      { role: "feature-plan-minimal", status: "accepted" },
      { role: "feature-plan-robust", status: "accepted" },
    ],
  );
  assert.equal(
    snapshot?.featureGraph?.planning.candidates.every(
      ({ sessionId }) => typeof sessionId === "string",
    ),
    true,
  );
  assert.equal(snapshot?.featureGraph?.planning.canonical, "accepted");
  assert.equal(snapshot?.featureGraph?.planning.graph, "accepted");
  assert.equal(snapshot?.featureGraph?.planning.review, "accepted");
  assert.deepEqual(snapshot?.featureGraph?.tree, {
    kind: "task",
    taskId: "implement-feature",
  });
  assert.equal(snapshot?.featureGraph?.tasks[0]?.status, "validated");
  assert.equal(run.featureExecutionSignals.length, 1);
  assert.equal(run.featureReviewSignals.length, 1);
  assert.strictEqual(
    run.featureExecutionSignals[0],
    run.featureReviewSignals[0],
  );
  assert.equal(run.featureExecutionSignals[0]?.aborted, false);
  assert.deepEqual(run.featureReviewDiffBases, [expectedDiffBase]);
  assert.deepEqual(run.featureReviewKnownResidualPaths, [
    ["root-review-residual.log"],
  ]);
  assert.deepEqual(snapshot?.featureGraph?.residualPaths, [
    "child-only-residual.log",
  ]);

  const finalizers = run.sessions.filter(
    (session) => session.spec.role === FEATURE_FINALIZER_ROLE,
  );
  assert.equal(finalizers.length, 1);
  assert.equal(finalizers[0]?.spec.model, ASTRA_MODEL);
  assert.equal(finalizers[0]?.spec.thinkingLevel, "low");
  assert.equal(finalizers[0]?.mutationEnabled, 1);
  const reviewTask = snapshot?.featureGraph?.tasks.find(
    (task) => task.kind === "final-review",
  );
  assert.equal(reviewTask?.status, "validated");
  assert.equal(reviewTask?.attempts[0]?.sessionId, finalizers[0]?.spec.id);
  assert.equal(reviewTask?.attempts[0]?.status, "completed");
  const minimalPlanner = run.sessions.find(
    (session) => session.spec.role === "feature-plan-minimal",
  );
  const robustPlanner = run.sessions.find(
    (session) => session.spec.role === "feature-plan-robust",
  );
  assert.equal(minimalPlanner?.spec.model, ASTRA_MODEL);
  assert.equal(minimalPlanner?.spec.thinkingLevel, "low");
  assert.equal(robustPlanner?.spec.model, ASTRA_MODEL);
  assert.equal(robustPlanner?.spec.thinkingLevel, "low");
  assert.equal(minimalPlanner?.sends.length, 1);
  assert.equal(robustPlanner?.sends.length, 0);
  assert.equal(finalizers[0]?.sends.length, 4);
  assert.equal(
    run.sessions.some(
      (session) =>
        session.spec.role === FEATURE_DISCOVERY_SYNTHESIS_ROLE ||
        session.spec.role.startsWith("candidate-") ||
        session.spec.role === FEATURE_IMPLEMENTATION_SYNTHESIS_ROLE,
    ),
    false,
  );

  const artifactDir = path.join(run.artifactRoot, runId);
  const featureArtifacts = fs
    .readdirSync(artifactDir)
    .filter((name) => name !== "artifacts" && name !== "manifest.json")
    .sort();
  assert.deepEqual(featureArtifacts, [
    "candidate-minimal.json",
    "candidate-robust.json",
    "canonical-plan.json",
    "execution-graph.json",
    "sol-review.json",
    "task-results.json",
  ]);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(artifactDir, "candidate-minimal.json"), "utf8"),
    ).role,
    "Minimal",
  );
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(artifactDir, "execution-graph.json"), "utf8"),
    ).tasks[0].id,
    "implement-feature",
  );

  await run.controller.dispose();
  fs.rmSync(run.artifactRoot, { recursive: true, force: true });
});

test("feature build rejects caller branch identity drift after planning", async () => {
  const run = harness({ driftFeatureBaseBeforeBuild: true });
  const runId = run.controller.start(request());
  await settleInitialization();

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.status, "failed");
  assert.match(snapshot?.error ?? "", /caller identity drifted before build/);
  assert.equal(run.featureExecutionSignals.length, 0);
  await waitForHandoff(run, runId);
  const artifacts = fs.readdirSync(path.join(run.artifactRoot, runId)).sort();
  assert.deepEqual(artifacts, [
    "artifacts",
    "candidate-minimal.json",
    "candidate-robust.json",
    "canonical-plan.json",
    "execution-graph.json",
    "manifest.json",
    "run-summary.json",
  ]);

  await run.controller.dispose();
  fs.rmSync(run.artifactRoot, { recursive: true, force: true });
});

test("feature working directories are exclusively leased until terminal handoff", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const gated = harness({ rootGate });
  const firstId = gated.controller.start(request());
  assert.throws(
    () => gated.controller.start(request()),
    /working_dir is already leased.*terminal handoff/,
  );

  assert.equal(firstId, "approved-feature-run-00000001");
  assert.equal(gated.controller.get(firstId)?.status, "starting");
  releaseRoot();
  await settleInitialization();
  assert.equal(gated.controller.get(firstId)?.status, "running");
  assert.equal(gated.sessions.length, 9);
  assert.equal(
    gated.sessions
      .filter((session) => session.spec.role === "pipeline-root")
      .every(
        (session) => session.prompts.length === 0 && session.sends.length === 1,
      ),
    true,
  );

  await gated.controller.dispose();
});

test("delayed discovery session creation cannot restore terminal run authority or affect a concurrent run", async () => {
  let releaseDelayedSession!: () => void;
  const delayedSession = new Promise<void>((resolve) => {
    releaseDelayedSession = resolve;
  });
  const run = harness({
    autoCompleteFeatureDiscovery: false,
    autoCompleteFeaturePlanning: false,
    sessionGate: (spec) =>
      spec.scopeId === "approved-feature-run-00000001" &&
      spec.role === "discover-problem"
        ? delayedSession
        : undefined,
  });
  const failedRunId = run.controller.start(request());
  const survivingRunId = run.controller.start(
    request("/tmp/surviving-feature-worktree"),
  );
  await settleInitialization();

  const failedRoot = run.sessions.find(
    (session) =>
      session.spec.scopeId === failedRunId &&
      session.spec.role === FEATURE_FINALIZER_ROLE,
  );
  assert.ok(failedRoot);
  failedRoot.emit({
    type: "settled",
    outcome: { type: "failed", error: "root failed during child creation" },
  });
  assert.equal(run.controller.get(failedRunId)?.status, "failed");

  releaseDelayedSession();
  await settleInitialization();
  const submissions = Reflect.get(run.controller, "discoverySubmissions");
  const tokens = Reflect.get(run.controller, "discoverySessionTokens");
  assert.ok(submissions instanceof Map);
  assert.ok(tokens instanceof Map);
  assert.equal(submissions.size, 0);
  for (const sessionId of tokens.values()) {
    assert.equal(
      run.controller.agentView.get(sessionId)?.scopeId,
      survivingRunId,
    );
  }
  assert.ok(tokens.size > 0);
  const delayedFailedSession = run.sessions.find(
    (session) =>
      session.spec.scopeId === failedRunId &&
      session.spec.role === "discover-problem",
  );
  assert.ok(delayedFailedSession);
  assert.equal(
    delayedFailedSession.activeTools.includes("pipeline_discovery_submit"),
    false,
  );
  assert.equal(run.controller.get(survivingRunId)?.status, "running");

  await run.controller.cancelRun(survivingRunId);
  assert.equal(tokens.size, 0);
  await run.controller.dispose();
});

test("concurrent feature cancellation is coalesced and isolates another run", async () => {
  const run = harness({ autoCompleteFeatureDiscovery: false });
  const runId = run.controller.start(request());
  const unrelatedId = run.controller.start(
    request("/tmp/unrelated-feature-worktree"),
  );
  await settleInitialization();
  const unrelatedBefore = run.controller
    .get(unrelatedId)!
    .agents.map(({ id, status }) => ({ id, status }));

  const results = await Promise.all([
    run.controller.cancelRun(runId),
    run.controller.cancelRun(runId),
  ]);
  await waitForHandoff(run, runId);

  assert.deepEqual(
    results.map((result) => result.status),
    ["cancelled", "cancelled"],
  );
  const rootSession = run.sessions.find(
    (session) => session.spec.scopeId === runId && !session.spec.parentId,
  );
  assert.equal(rootSession?.interrupted, 0);
  assert.equal(rootSession?.disposed, 1);
  assert.equal(run.handoffs.length, 1);
  assert.equal(run.controller.get(unrelatedId)?.status, "running");
  assert.deepEqual(
    run.controller
      .get(unrelatedId)!
      .agents.map(({ id, status }) => ({ id, status })),
    unrelatedBefore,
  );
  await run.controller.dispose();
});

test("root cancellation rejection still cleans and hands off exactly once", async () => {
  const run = harness({
    rejectRootCancellation: true,
  });
  const runId = run.controller.start(request());
  await settleInitialization();

  await assert.rejects(
    run.controller.cancelRun(runId),
    /root cancellation rejected/,
  );
  await waitForHandoff(run, runId);

  assert.equal(run.controller.get(runId)?.status, "cancelled");
  const rootId = run.controller.get(runId)?.rootId;
  const rootSession = run.sessions.find(
    (session) => session.spec.scopeId === runId && session.spec.id === rootId,
  );
  assert.equal(rootSession?.interrupted, 1);
  assert.equal(rootSession?.disposed, 1);
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some(
        (agent) => agent.status === "starting" || agent.status === "running",
      ),
    false,
  );
  assert.equal(run.handoffs.length, 1);
  assert.equal(
    run.handoffs[0]?.error,
    "Pipeline root cancellation failed: root cancellation rejected",
  );
  assert.deepEqual(run.handoffs[0]?.facts.unresolvedItems, [
    "Pipeline root cancellation failed: root cancellation rejected",
  ]);
});

test("feature discovery tool payload is bound to its session and consumed only after settlement", async () => {
  const run = harness({
    autoCompleteFeatureDiscovery: false,
    autoCompleteFeaturePlanning: false,
  });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of FEATURE_PIPELINE_DISCOVERY_ROLES.slice(1)) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.ok(problem?.discoverySubmit);
  assert.throws(
    () =>
      run.submitUnauthorized(
        "discover-problem",
        featureDiscoveryValue("discover-problem"),
      ),
    /session is not registered/,
  );
  problem.discoverySubmit(featureDiscoveryValue("discover-problem"));
  assert.throws(
    () => problem.discoverySubmit?.(featureDiscoveryValue("discover-problem")),
    /already recorded a submission/,
  );
  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(
    run.sessions.some((session) => session.spec.role === "pipeline-root"),
    false,
  );

  problem.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: "Tool result text is not the compatibility report",
    },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "plan");
  const planners = run.sessions.filter((session) =>
    FEATURE_PLAN_ROLES.some((role) => role === session.spec.role),
  );
  assert.equal(planners.length, 2);
  assert.equal(
    planners.every(
      (planner) =>
        planner.spec.model === ASTRA_MODEL &&
        planner.spec.thinkingLevel === "low",
    ),
    true,
  );
  await run.controller.dispose();
});

test("feature discovery submission scope is fixed to active feature discovery roles", () => {
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      "discover-problem",
      "discover",
      false,
    ),
    true,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "plan-pipeline",
      "discover-goal-outcomes",
      "discover",
      false,
    ),
    false,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "plan-pipeline",
      "discover-requirements-boundaries",
      "discover",
      false,
    ),
    true,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "plan-pipeline",
      PLAN_PIPELINE_SYNTHESIS_ROLE,
      "synthesize",
      false,
    ),
    true,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      "discover-problem",
      "build",
      false,
    ),
    false,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      "discover-problem",
      "discover",
      true,
    ),
    false,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      FEATURE_DISCOVERY_SYNTHESIS_ROLE,
      "discover",
      false,
    ),
    false,
  );
  assert.equal(
    pipelineDiscoverySubmissionAllowed(
      "feature-pipeline",
      FEATURE_DISCOVERY_SYNTHESIS_ROLE,
      "discover",
      true,
    ),
    false,
  );
  for (const role of [...FEATURE_PLAN_ROLES, FEATURE_FINALIZER_ROLE]) {
    assert.equal(
      pipelineDiscoverySubmissionAllowed(
        "feature-pipeline",
        role,
        "plan",
        true,
      ),
      true,
    );
  }
});

test("programmatic feature discovery retries one malformed report in the same session", async () => {
  const run = harness({
    autoCompleteFeatureDiscovery: false,
    autoCompleteFeaturePlanning: false,
  });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of [
    "discover-outcome",
    "discover-context",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.ok(problem);
  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not-json" },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(problem.sends.length, 1);
  problem.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: reportForRole("discover-problem"),
    },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.stage, "plan");
  assert.equal(
    run.sessions.filter((session) =>
      FEATURE_PLAN_ROLES.some((role) => role === session.spec.role),
    ).length,
    2,
  );
  await run.controller.dispose();
});

test("feature discovery uses independent correction counters and fails on rejection four", async () => {
  const run = harness({
    autoCompleteFeatureDiscovery: false,
    autoCompleteFeaturePlanning: false,
  });
  const runId = run.controller.start(request());
  await settleInitialization();

  for (const role of [
    "discover-outcome",
    "discover-user-scenarios",
    "discover-product-precedents",
  ]) {
    settleRole(run, role);
  }
  const problem = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  const context = run.sessions.find(
    (session) => session.spec.role === "discover-context",
  );
  assert.ok(problem);
  assert.ok(context);

  for (let rejection = 1; rejection <= 3; rejection++) {
    problem.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: `not-json-${rejection}`,
      },
    });
    await settleInitialization();
    assert.equal(run.controller.get(runId)?.status, "running");
    assert.equal(run.controller.get(runId)?.stage, "discover");
    assert.equal(problem.sends.length, rejection);
    assert.equal(context.interrupted, 0);
  }

  problem.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "fourth-invalid-report" },
  });
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.match(
    run.controller.get(runId)?.error ?? "",
    /rejected settled turn 4/,
  );
  assert.equal(context.interrupted, 1);
  assert.equal(
    run.sessions.some((session) => session.spec.role === "pipeline-root"),
    false,
  );
  await run.controller.dispose();
});

test("dashboard cancellation of a starting run prevents its root prompt", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const runId = run.controller.start(request());
  const runRow = buildPipelineRows([run.controller.get(runId)!]).find(
    (row) => row.kind === "run" && row.runId === runId,
  );
  assert.ok(runRow);

  const cancellation = cancelPipelineRow(run.controller, runRow);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 0);

  releaseRoot();
  await cancellation;
  await settleInitialization();
  await waitForHandoff(run, runId);

  assert.equal(run.sessions.length, 1);
  assert.equal(run.sessions[0]?.prompts.length, 0);
  assert.equal(run.sessions[0]?.disposed, 1);
  assert.equal(run.controller.get(runId)?.rootId, "node-1");
  assert.equal(run.controller.get(runId)?.agents[0]?.status, "cancelled");
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some(
        (agent) => agent.status === "starting" || agent.status === "running",
      ),
    false,
  );
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
});

test("root tools are run-scoped and feature discovery children are read-only", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();

  assert.equal(run.controller.get(runId)?.agents.length, 9);
  assert.deepEqual(run.rootToolNames, [
    "pipeline_artifact_read",
    "pipeline_stage",
    "pipeline_child_spawn",
    "pipeline_child_list",
    "pipeline_child_check",
    "pipeline_child_wait",
    "pipeline_child_send",
    "pipeline_child_cancel",
    "pipeline_audit_start",
    "pipeline_complete",
  ]);
  const childSession = run.sessions.find(
    (session) => session.spec.role === "discover-problem",
  );
  assert.deepEqual(childSession?.activeTools, [
    "read",
    "fd",
    "rg",
    "web_search_codex",
    "web_fetch_codex",
    "pipeline_discovery_submit",
  ]);
  for (const mutator of [
    "bash",
    "edit",
    "write",
    "apply_patch_codex",
    "codex_task",
    "mcp",
    "bg_start",
    "ask_user",
  ]) {
    assert.equal(childSession?.activeTools.includes(mutator), false);
  }
  for (const forbidden of [
    "pipeline_run",
    "pipeline_cancel",
    "pipeline_check",
    "pipeline_list",
    "pipeline_child_spawn",
    "workflow",
    "subagent_spawn",
  ]) {
    assert.equal(childSession?.activeTools.includes(forbidden), false);
  }

  await run.controller.dispose();
});

test("terminal evidence is durable, bounded, and ignores late terminal events", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "controller-evidence-plan-"),
  );
  const run = harness({ autoCompletePlan: true });
  const runId = run.controller.start({
    ...nonFeatureRequest("plan-pipeline", workingDir),
    gitCommit: false,
    planPath: null,
  });

  try {
    await settleInitialization();
    const handoff = await waitForHandoff(run, runId);
    assert.equal(handoff.evidenceIncomplete, false);
    assert.ok(handoff.evidence);
    assert.ok(handoff.evidenceManifest);

    const runDir = path.join(run.artifactRoot, runId);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.runId, runId);
    const manifestEntry = (artifactId: string) => {
      const entry = manifest.entries.find(
        (candidate: { artifactId: string }) =>
          candidate.artifactId === artifactId,
      );
      assert.ok(entry, `Missing ${artifactId} artifact manifest entry.`);
      return entry;
    };
    const evidenceEntry = manifestEntry("run-evidence");
    const acceptanceEntry = manifestEntry("acceptance");
    assert.equal(evidenceEntry.completeness, "complete");
    assert.equal(acceptanceEntry.completeness, "complete");

    const evidence = JSON.parse(
      fs.readFileSync(path.join(runDir, evidenceEntry.relativePath), "utf8"),
    );
    const acceptance = JSON.parse(
      fs.readFileSync(path.join(runDir, acceptanceEntry.relativePath), "utf8"),
    );
    assert.equal(evidence.completeness, "complete");
    assert.equal(acceptance.schemaVersion, 2);
    const startupEvents = evidence.events.filter(
      (event: { kind: string }) => event.kind === "session_created",
    );
    assert.ok(startupEvents.length > 0);
    for (const event of startupEvents) {
      assert.equal("sessionFile" in event, false);
      assert.equal("sessionFile" in (event.facts ?? {}), false);
    }

    assert.equal(
      handoff.evidence.manifest.acceptanceRef?.artifactId,
      "acceptance",
    );
    assert.equal(
      handoff.evidence.manifest.acceptanceRef?.revision,
      acceptanceEntry.revision,
    );
    assert.equal(
      handoff.evidence.acceptance.fullArtifactRef?.artifactId,
      "acceptance",
    );
    assert.equal(
      handoff.evidenceManifest.some(
        (entry) => entry.artifactId === "run-evidence",
      ),
      true,
    );
    assert.equal(
      handoff.evidenceManifest.some(
        (entry) => entry.artifactId === "acceptance",
      ),
      true,
    );

    const handoffCount = run.handoffs.length;
    const rootSession = run.sessions.find(
      (session) => session.spec.role === PLAN_PIPELINE_SYNTHESIS_ROLE,
    );
    assert.ok(rootSession);
    rootSession.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: "late duplicate terminal event",
      },
    });
    await settleInitialization();
    assert.equal(run.handoffs.length, handoffCount);
  } finally {
    await run.controller.dispose();
    fs.rmSync(run.artifactRoot, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test("REV-001 waits for root pipeline_complete settlement before immutable evidence handoff", async () => {
  const run = harness();
  try {
    const { runId, rootSession } = await prepareFeatureCompletion(run);
    await invokeRegisteredCompletion(
      run,
      runId,
      rootSession,
      "pipeline-complete-1",
    );

    emitCompletionResult(rootSession, "pipeline-complete-1");
    emitCompletionSettlement(rootSession);

    const handoff = await waitForHandoff(run, runId);
    assert.equal(handoff.evidenceIncomplete, false);
    assert.equal(run.handoffs.length, 1);
    const manifest = handoff.evidenceManifest;
    assert.ok(manifest);
    const evidenceEntry = manifest.find(
      (entry) => entry.artifactId === "run-evidence",
    );
    const acceptanceEntry = manifest.find(
      (entry) => entry.artifactId === "acceptance",
    );
    assert.ok(evidenceEntry);
    assert.ok(acceptanceEntry);

    const evidencePage = requireArtifactPage(
      await run.controller.readArtifact(runId, {
        artifactId: evidenceEntry.artifactId,
        revision: evidenceEntry.revision,
        maxBytes: 64 * 1024,
      }),
    );
    const evidence = JSON.parse(evidencePage.text) as {
      events: ReadonlyArray<{
        kind: string;
        sequence: number;
        sessionId?: string;
        facts?: Readonly<Record<string, unknown>>;
      }>;
    };
    const rootEvents = evidence.events.filter(
      (event) => event.sessionId === rootSession.spec.id,
    );
    const toolResultEvent = rootEvents.find(
      (event) =>
        event.kind === "tool_observed" &&
        event.facts?.toolName === "pipeline_complete" &&
        event.facts?.phase === "result",
    );
    assert.ok(toolResultEvent);
    const settledEvent = rootEvents.find(
      (event) =>
        event.kind === "settled" &&
        event.facts?.outcome === "completed" &&
        event.sequence > toolResultEvent.sequence,
    );
    assert.ok(settledEvent);

    const acceptancePage = requireArtifactPage(
      await run.controller.readArtifact(runId, {
        artifactId: acceptanceEntry.artifactId,
        revision: acceptanceEntry.revision,
        maxBytes: 64 * 1024,
      }),
    );
    const acceptance = JSON.parse(acceptancePage.text) as {
      pipelineExecutionAcceptance: {
        criteria: ReadonlyArray<{ id: string; status: string }>;
      };
    };
    assert.equal(
      acceptance.pipelineExecutionAcceptance.criteria.find(
        (criterion) => criterion.id === "attempts-closed",
      )?.status,
      "passed",
    );

    const sealedEvidenceText = evidencePage.text;
    const handoffBeforeLateEvents = structuredClone(handoff);
    emitCompletionResult(rootSession, "pipeline-complete-1");
    emitCompletionSettlement(rootSession);
    await settleInitialization();
    assert.equal(run.handoffs.length, 1);
    assert.deepEqual(run.handoffs[0], handoffBeforeLateEvents);
    const rereadEvidence = requireArtifactPage(
      await run.controller.readArtifact(runId, {
        artifactId: evidenceEntry.artifactId,
        revision: evidenceEntry.revision,
        maxBytes: 64 * 1024,
      }),
    );
    assert.equal(rereadEvidence.text, sealedEvidenceText);
  } finally {
    await run.controller.dispose();
    fs.rmSync(run.artifactRoot, { recursive: true, force: true });
  }
});

test("REV-001 marks stalled terminal observation incomplete at the cleanup bound", async () => {
  const scheduler = new ManualScheduler();
  const run = harness({ scheduler });
  try {
    const { runId, rootSession } = await prepareFeatureCompletion(run);
    await invokeRegisteredCompletion(
      run,
      runId,
      rootSession,
      "pipeline-complete-stalled",
    );
    emitCompletionResult(rootSession, "pipeline-complete-stalled");
    assert.equal(
      scheduler.scheduled.some(({ delayMs }) => delayMs === 5_000),
      true,
    );

    scheduler.fire(5_000);
    const handoff = await waitForHandoff(run, runId);
    assert.equal(handoff.evidenceIncomplete, true);
    assert.equal(run.handoffs.length, 1);
    const executionAcceptance = handoff.acceptance?.pipelineExecutionAcceptance;
    assert.ok(executionAcceptance);
    assert.equal(executionAcceptance.status, "unproven");
    const manifest = handoff.evidenceManifest;
    assert.ok(manifest);
    const evidenceEntry = manifest.find(
      (entry) => entry.artifactId === "run-evidence",
    );
    assert.ok(evidenceEntry);
    const evidencePage = requireArtifactPage(
      await run.controller.readArtifact(runId, {
        artifactId: evidenceEntry.artifactId,
        revision: evidenceEntry.revision,
        maxBytes: 64 * 1024,
      }),
    );
    const evidence = JSON.parse(evidencePage.text) as {
      completeness: string;
      events: ReadonlyArray<{ kind: string; sessionId?: string }>;
    };
    assert.equal(evidence.completeness, "incomplete");
    assert.equal(
      run.handoffs[0]?.evidence?.acceptance.pipelineExecutionAcceptance.status,
      "unproven",
    );

    emitCompletionSettlement(rootSession);
    await settleInitialization();
    assert.equal(run.handoffs.length, 1);
  } finally {
    await run.controller.dispose();
    fs.rmSync(run.artifactRoot, { recursive: true, force: true });
  }
});

test("definition role policies centralize child context requirements", () => {
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.deepEqual(childContextPolicyFor("feature-pipeline", role), {
      gitEvidence: true,
    });
    assert.deepEqual(childContextPolicyFor("audit-pipeline", role), {
      gitEvidence: true,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", FINAL_AUDIT_ROLE),
    {},
  );
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.deepEqual(childContextPolicyFor("small-feature-pipeline", role), {
      gitEvidence: true,
      priorReportRole: SMALL_FEATURE_IMPLEMENTER_ROLE,
    });
  }
  assert.deepEqual(
    childContextPolicyFor("feature-pipeline", "discover-problem"),
    {},
  );
  assert.deepEqual(
    childContextPolicyFor("plan-pipeline", "discover-contracts-invariants"),
    {},
  );
});

test("feature planning and dynamic task policies exclude orchestration while phase tools control mutation", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("feature-pipeline", true, "pipeline-root")
      .excludeTools,
  );
  for (const rootTool of ["bash", "edit", "write"]) {
    assert.equal(rootDenied.has(rootTool), false);
  }

  for (const role of [
    FEATURE_FINALIZER_ROLE,
    ...FEATURE_PLAN_ROLES,
    "feature-task-domain-contract",
  ]) {
    const denied = new Set<string>(
      pipelineSessionToolPolicy("feature-pipeline", false, role).excludeTools,
    );
    for (const codingTool of ["bash", "edit", "write"]) {
      assert.equal(denied.has(codingTool), false, role);
    }
    assert.equal(denied.has("pipeline_child_spawn"), true, role);
    assert.equal(denied.has("codex_task"), true, role);
  }

  const discoveryDenied = new Set<string>(
    pipelineSessionToolPolicy("feature-pipeline", false, "discover-problem")
      .excludeTools,
  );
  const ordinaryAuditDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "feature-pipeline",
      false,
      "audit-feature-outcome",
    ).excludeTools,
  );
  for (const allowed of [
    "read",
    "fd",
    "rg",
    "web_search_codex",
    "web_fetch_codex",
  ]) {
    assert.equal(discoveryDenied.has(allowed), false);
  }
  assert.equal(discoveryDenied.has("bash"), false);
  for (const denied of [
    "edit",
    "write",
    "apply_patch_codex",
    "codex_task",
    "mcp",
    "bg_start",
    "bg_kill",
    "ask_user",
    "pipeline_child_spawn",
    "workflow",
    "subagent_spawn",
  ]) {
    assert.equal(discoveryDenied.has(denied), true);
  }
  assert.equal(ordinaryAuditDenied.has("bash"), true);
  for (const role of PIPELINE_CHILD_ROLES.filter(
    (role) => !FEATURE_PLAN_ROLES.some((planRole) => planRole === role),
  )) {
    const denied = new Set<string>(
      pipelineSessionToolPolicy("feature-pipeline", false, role).excludeTools,
    );
    assert.equal(denied.has("edit"), true, role);
    assert.equal(denied.has("write"), true, role);
    if (role !== EXECUTOR_AUDIT_ROLE && role !== "discover-problem") {
      assert.equal(denied.has("bash"), true, role);
    }
  }

  const planGoalDiscoveryDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "plan-pipeline",
      false,
      "discover-requirements-boundaries",
    ).excludeTools,
  );
  assert.equal(planGoalDiscoveryDenied.has("bash"), false);
  for (const role of PLAN_PIPELINE_DISCOVERY_ROLES) {
    const denied = new Set<string>(
      pipelineSessionToolPolicy("plan-pipeline", false, role).excludeTools,
    );
    assert.equal(denied.has("edit"), true, role);
    assert.equal(denied.has("write"), true, role);
    assert.equal(
      denied.has("web_search_codex"),
      role !== "discover-external-evidence",
      role,
    );
    if (role !== "discover-requirements-boundaries") {
      assert.equal(denied.has("bash"), true, role);
    }
  }
  const synthesisDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "plan-pipeline",
      true,
      PLAN_PIPELINE_SYNTHESIS_ROLE,
    ).excludeTools,
  );
  for (const denied of [
    "bash",
    "edit",
    "write",
    "web_search_codex",
    "pipeline_complete",
    "pipeline_child_spawn",
    "pipeline_run",
  ]) {
    assert.equal(synthesisDenied.has(denied), true, denied);
  }
});

test("small-feature Luna root and audit Lunas are read-only while the implementer keeps coding tools", () => {
  const rootDenied = new Set<string>(
    pipelineSessionToolPolicy("small-feature-pipeline", true, "pipeline-root")
      .excludeTools,
  );
  const implementerDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "small-feature-pipeline",
      false,
      "implement-small-feature",
    ).excludeTools,
  );
  const auditorDenied = new Set<string>(
    pipelineSessionToolPolicy(
      "small-feature-pipeline",
      false,
      STATIC_LUNA_AUDIT_ROLES[0],
    ).excludeTools,
  );
  for (const workspaceMutator of ["bash", "edit", "write"]) {
    assert.equal(rootDenied.has(workspaceMutator), true);
    assert.equal(auditorDenied.has(workspaceMutator), true);
    assert.equal(implementerDenied.has(workspaceMutator), false);
  }
  for (const delegatedOrExternalMutator of [
    "apply_patch_codex",
    "bg_start",
    "bg_kill",
    "codex_task",
    "mcp",
  ]) {
    assert.equal(rootDenied.has(delegatedOrExternalMutator), true);
    assert.equal(auditorDenied.has(delegatedOrExternalMutator), true);
    assert.equal(implementerDenied.has(delegatedOrExternalMutator), true);
  }
  assert.equal(rootDenied.has("pipeline_child_spawn"), false);
  assert.equal(implementerDenied.has("pipeline_child_spawn"), true);
  assert.equal(auditorDenied.has("pipeline_child_spawn"), true);
  for (const mainOnlyTool of [
    "pipeline_cancel",
    "pipeline_check",
    "pipeline_list",
  ]) {
    assert.equal(rootDenied.has(mainOnlyTool), true);
    assert.equal(implementerDenied.has(mainOnlyTool), true);
    assert.equal(auditorDenied.has(mainOnlyTool), true);
  }
});

test("roles select fixed models, remain direct root children, and record attempts", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);

  run.controller.setStage(runId, "audit");
  const first = await run.controller.spawnChild(runId, "audit-feature-outcome");
  const retry = await run.controller.spawnChild(runId, "audit-feature-outcome");
  run.controller.setStage(runId, "final-audit");
  const finalAgents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved contract",
    assumptions: [],
    checks: [],
  });
  assert.equal(first.model, LUNA_MODEL);
  assert.equal(retry.model, LUNA_MODEL);
  assert.equal(
    finalAgents.every((agent) => agent.model === LUNA_MODEL),
    true,
  );
  assert.equal(first.parentId, rootId);
  assert.equal(retry.parentId, rootId);
  assert.equal(
    finalAgents.every((agent) => agent.parentId === rootId),
    true,
  );
  assert.equal(first.attempt, 1);
  assert.equal(retry.attempt, 2);
  assert.equal(run.controller.getAgent(runId, rootId).model, LUNA_MODEL);
  assert.equal(run.controller.getAgent(runId, rootId).thinkingLevel, "xhigh");
  assert.equal(pipelineThinkingLevel(SOL_MODEL), "high");
  assert.equal(pipelineThinkingLevel(TERRA_MODEL), "high");
  assert.equal(pipelineThinkingLevel(LUNA_MODEL, "xhigh"), "xhigh");
  assert.equal(pipelineThinkingLevel(SOL_MODEL, "medium"), "medium");
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.some((agent) => agent.model === TERRA_MODEL),
    false,
  );
  await assert.rejects(
    run.controller.spawnChild(runId, "not-a-role" as PipelineChildRole),
    /Unsupported feature-pipeline child role/,
  );

  await run.controller.dispose();
});

test("small-feature-pipeline fans four Luna audits into one same-session remediation", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...nonFeatureRequest("small-feature-pipeline"),
    gitCommit: false,
  });
  await settleInitialization();

  const initial = run.controller.get(runId);
  assert.equal(initial?.stage, "build");
  assert.equal(initial?.agents[0]?.title, "approved-feature-run-00000001");
  assert.equal(initial?.agents[0]?.model, LUNA_MODEL);
  assert.equal(
    pipelineThinkingLevel(initial?.agents[0]?.model ?? ""),
    "medium",
  );
  assert.deepEqual(SMALL_FEATURE_PIPELINE_CHILD_ROLES, [
    SMALL_FEATURE_IMPLEMENTER_ROLE,
    ...STATIC_LUNA_AUDIT_ROLES,
  ]);

  const implementer = await run.controller.spawnChild(
    runId,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  assert.equal(implementer.model, LUNA_MODEL);
  assert.equal(implementer.persistent, true);
  await assert.rejects(
    run.controller.spawnChild(runId, SMALL_FEATURE_IMPLEMENTER_ROLE),
    /already has its allowed child session/,
  );
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  assert.equal(run.controller.getAgent(runId, implementer.id).status, "idle");
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");

  const auditors = await Promise.all(
    STATIC_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  await assert.rejects(
    run.controller.spawnChild(runId, STATIC_LUNA_AUDIT_ROLES[0]),
    /already has its allowed child session/,
  );
  for (const [index, role] of STATIC_LUNA_AUDIT_ROLES.entries()) {
    const auditor = auditors[index];
    assert.ok(auditor);
    assert.equal(auditor.model, LUNA_MODEL);
    assert.equal(auditor.persistent, false);
    const auditorSession = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(auditorSession);
    assert.equal(
      auditorSession.prompts[0]?.includes(
        reportForRole(SMALL_FEATURE_IMPLEMENTER_ROLE),
      ),
      true,
    );
  }
  const firstAuditor = auditors[0];
  assert.ok(firstAuditor);
  settleRole(run, STATIC_LUNA_AUDIT_ROLES[0]);
  await run.controller.waitForChildren(runId, [firstAuditor.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-audit");
  for (const role of STATIC_LUNA_AUDIT_ROLES.slice(1)) settleRole(run, role);
  await run.controller.waitForChildren(
    runId,
    auditors.slice(1).map((auditor) => auditor.id),
  );
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  await assert.rejects(
    run.controller.sendChild(runId, firstAuditor.id, "Audit again"),
    /cannot be retried or continued/,
  );
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.throws(
    () => run.controller.setStage(runId, "complete"),
    /requires one same-session Luna remediation pass/,
  );

  const remediationMessage = "Resolve all audit reports";
  await run.controller.sendChild(runId, implementer.id, remediationMessage);
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  assert.ok(implementerSession);
  assert.equal(implementerSession.sends.length, 1);
  assert.match(
    implementerSession.sends[0] ?? "",
    /Independent Luna audit reports to resolve/,
  );
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    assert.equal(
      implementerSession.sends[0]?.includes(reportForRole(role)),
      true,
    );
  }
  assert.equal(implementerSession.sends[0]?.includes(remediationMessage), true);
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  await run.controller.waitForChildren(runId, [implementer.id]);
  assert.equal(run.controller.get(runId)?.stage, "complete");
  await assert.rejects(
    run.controller.sendChild(runId, implementer.id, "Fix twice"),
    /only run during final-resolve/,
  );

  const facts = {
    outcome: "Small feature implemented and remediated",
    changedPaths: ["src/feature.ts"],
    checks: ["focused tests passed"],
    assumptions: [],
    git: ["working tree inspected"],
    reports: ["Luna implementation", "Four Luna audits", "Luna remediation"],
    unresolvedItems: [],
    workingDir: implementationWorkingDir(),
  };
  run.controller.complete(runId, facts);
  await waitForHandoff(run, runId);
  const finalFacts = run.controller.get(runId)?.completion;
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.ok(finalFacts?.git.some((item) => item.startsWith("Final Git HEAD:")));
  assert.ok(
    finalFacts?.git.some((item) =>
      item.includes("Final dirty HEAD..WORKTREE diff"),
    ),
  );
  assert.equal(run.handoffs[0]?.definition, "small-feature-pipeline");
  assert.deepEqual(
    run.controller
      .get(runId)
      ?.agents.filter((agent) => agent.parentId)
      .map((agent) => agent.role),
    [...SMALL_FEATURE_PIPELINE_CHILD_ROLES],
  );

  await run.controller.dispose();
});

test("feature audits and the embedded Luna segment receive captured fresh Git evidence", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-audit-evidence-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.mkdirSync(path.join(workingDir, "src"));
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "before\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();

  const run = harness();
  const runId = run.controller.start(request(workingDir));
  await settleInitialization();
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "after\n");
  run.controller.setStage(runId, "audit");
  await Promise.all(
    STATIC_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );
  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    const lunaAudit = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(lunaAudit);
    assert.equal(lunaAudit.prompts[0]?.includes(baseSha), true);
    assert.equal(lunaAudit.prompts[0]?.includes("-before"), true);
    assert.equal(lunaAudit.prompts[0]?.includes("+after"), true);
    settleRole(run, role);
  }

  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "final\n");
  run.controller.setStage(runId, "final-audit");
  await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved feature contract",
    assumptions: [],
    checks: ["focused tests passed"],
  });
  const finalAudits = STATIC_LUNA_AUDIT_ROLES.map((role) =>
    [...run.sessions].reverse().find((session) => session.spec.role === role),
  );
  assert.equal(finalAudits.every(Boolean), true);
  for (const lunaAudit of finalAudits) {
    assert.equal(lunaAudit?.prompts[0]?.includes(baseSha), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("-before"), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("+final"), true);
    assert.equal(lunaAudit?.prompts[0]?.includes("+after"), false);
  }
  assert.equal(
    run.sessions.some((session) => session.spec.model === TERRA_MODEL),
    false,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("small-feature Luna audits receive the captured base, implementation report, and actual diff", async () => {
  const fixture = createLinkedWorktreeFixture("small-feature-audit-", {
    "src/feature.ts": "before\n",
  });
  const workingDir = fixture.linked;
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workingDir,
    encoding: "utf8",
  }).trim();

  const run = harness();
  const runId = run.controller.start({
    ...nonFeatureRequest("small-feature-pipeline", workingDir),
    gitCommit: false,
  });
  await settleInitialization();
  fs.writeFileSync(path.join(workingDir, "src", "feature.ts"), "committed\n");
  execFileSync("git", ["add", "src/feature.ts"], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "implementation commit"], {
    cwd: workingDir,
  });
  fs.writeFileSync(
    path.join(workingDir, "src", "feature.ts"),
    `after\n${"x".repeat(300 * 1024)}`,
  );
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  settleRole(run, "implement-small-feature");
  await run.controller.waitForChildren(runId, [implementer.id]);
  await Promise.all(
    STATIC_LUNA_AUDIT_ROLES.map((role) =>
      run.controller.spawnChild(runId, role),
    ),
  );

  for (const role of STATIC_LUNA_AUDIT_ROLES) {
    const auditorSession = run.sessions.find(
      (session) => session.spec.role === role,
    );
    assert.ok(auditorSession);
    assert.equal(auditorSession.prompts[0]?.includes(baseSha), true);
    assert.equal(
      auditorSession.prompts[0]?.includes("implementation commit"),
      true,
    );
    assert.equal(auditorSession.prompts[0]?.includes("-before"), true);
    assert.equal(auditorSession.prompts[0]?.includes("+committed"), true);
    assert.equal(auditorSession.prompts[0]?.includes("-committed"), true);
    assert.equal(auditorSession.prompts[0]?.includes("+after"), true);
    assert.equal(
      auditorSession.prompts[0]?.includes('"baseIsAncestor": "yes"'),
      true,
    );
    assert.equal(
      auditorSession.prompts[0]?.includes('"state": "truncated"'),
      true,
    );
    assert.equal(
      auditorSession.prompts[0]?.includes(
        reportForRole(SMALL_FEATURE_IMPLEMENTER_ROLE),
      ),
      true,
    );
  }

  await run.controller.dispose();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("small-feature-pipeline fails closed on a malformed implementation report", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...nonFeatureRequest("small-feature-pipeline"),
    gitCommit: false,
  });
  await settleInitialization();
  const implementer = await run.controller.spawnChild(
    runId,
    "implement-small-feature",
  );
  const implementerSession = run.sessions.find(
    (session) => session.spec.role === "implement-small-feature",
  );
  assert.ok(implementerSession);
  implementerSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not structured JSON" },
  });

  await run.controller.waitForChildren(runId, [implementer.id]);
  await new Promise((resolve) => setImmediate(resolve));
  await waitForHandoff(run, runId);

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.controller.get(runId)?.stage, "build");
  assert.equal(run.handoffs[0]?.status, "failed");
  assert.match(run.handoffs[0]?.error ?? "", /valid report/);
  assert.equal(
    run.controller.getAgent(runId, run.controller.get(runId)?.rootId ?? "")
      .status,
    "cancelled",
  );
  await run.controller.dispose();
});

test("small-feature-pipeline fails closed on a malformed Luna audit report", async () => {
  const run = harness();
  const runId = run.controller.start({
    ...nonFeatureRequest("small-feature-pipeline"),
    gitCommit: false,
  });
  await settleInitialization();
  const implementer = await run.controller.spawnChild(
    runId,
    SMALL_FEATURE_IMPLEMENTER_ROLE,
  );
  settleRole(run, SMALL_FEATURE_IMPLEMENTER_ROLE);
  await run.controller.waitForChildren(runId, [implementer.id]);

  const auditRole = STATIC_LUNA_AUDIT_ROLES[0];
  const auditor = await run.controller.spawnChild(runId, auditRole);
  const auditorSession = run.sessions.find(
    (session) => session.spec.role === auditRole,
  );
  assert.ok(auditorSession);
  auditorSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "not structured JSON" },
  });

  await run.controller.waitForChildren(runId, [auditor.id]);
  await new Promise((resolve) => setImmediate(resolve));
  await waitForHandoff(run, runId);

  assert.equal(run.controller.get(runId)?.status, "failed");
  assert.equal(run.controller.get(runId)?.stage, "final-audit");
  assert.equal(run.handoffs[0]?.status, "failed");
  assert.match(run.handoffs[0]?.error ?? "", /valid report/);
  await run.controller.dispose();
});

test("successful audit fan-in atomically enters audit-resolve", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const auditRoles = STATIC_LUNA_AUDIT_ROLES;
  const children = await Promise.all(
    auditRoles.map((role) => run.controller.spawnChild(runId, role)),
  );
  auditRoles.forEach((role) => settleRole(run, role));

  await run.controller.waitForChildren(
    runId,
    children.map((child) => child.id),
  );

  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.stage, "audit-resolve");
  const rows = buildPipelineRows(
    snapshot ? [snapshot] : [],
    new Set(snapshot ? [snapshot.id] : []),
  );
  assert.equal(
    rows.find((row) => row.kind === "stage" && row.stage === "audit-resolve")
      ?.label,
    "audit-resolve · running",
  );

  await finishEmbeddedAudit(run, runId);

  await run.controller.dispose();
});

test("child wait delivers the validated final audit report even when synthesis finalText is empty", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  await finishEmbeddedAudit(run, runId, false);

  const synthesizer = run.controller.agentView
    .list()
    .find((agent) => agent.role === "audit-synthesis");
  assert.ok(synthesizer);
  Reflect.set(synthesizer, "finalText", "");
  const waitTool = run.rootTool(runId, "pipeline_child_wait");
  assert.ok(waitTool);
  const result = await waitTool.execute(
    "final-audit-wait",
    { ids: [synthesizer.id] },
    undefined,
    undefined,
    {} as ExtensionContext,
  );
  const rendered = JSON.stringify(result);
  assert.match(
    rendered,
    /VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION/,
  );
  assert.match(rendered, /audit-synthesis-final/);
  assert.match(rendered, /resolve every concrete finding/i);
  assert.match(rendered, /"finalAuditReportDelivered":true/);
  await run.controller.dispose();
});

test("child wait joins the active audit pump before delivering final synthesis", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "final-audit");
  await run.controller.startFinalAudit(runId, {
    acceptanceContract: "The approved feature contract",
    assumptions: [],
    checks: ["focused checks passed"],
  });

  const firstRole = AUDIT_SEGMENT_LUNA_ROLES[0];
  settleRole(run, firstRole);
  await settleInitialization();
  for (const role of AUDIT_SEGMENT_LUNA_ROLES.slice(1)) settleRole(run, role);

  const synthesisSession = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesisSession);
  synthesisSession.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport("audit-synthesis-intermediate", [firstRole]),
    },
  });
  await settleInitialization();

  const synthesisNode = run.controller.agentView
    .list()
    .find((agent) => agent.role === "audit-synthesis");
  assert.ok(synthesisNode);
  assert.equal(synthesisNode.status, "running");
  const waitTool = run.rootTool(runId, "pipeline_child_wait");
  assert.ok(waitTool);
  const waiting = waitTool.execute(
    "final-audit-race",
    { ids: [synthesisNode.id] },
    undefined,
    undefined,
    {} as ExtensionContext,
  );

  synthesisSession.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: synthesisReport(
        "audit-synthesis-final",
        AUDIT_SEGMENT_LUNA_ROLES,
        {
          baseSha: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: synthesisSession.spec.cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim(),
          headSha: execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: synthesisSession.spec.cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim(),
        },
      ),
    },
  });

  const rendered = JSON.stringify(await waiting);
  assert.equal(run.controller.get(runId)?.stage, "final-resolve");
  assert.match(
    rendered,
    /VALIDATED_FINAL_AUDIT_REPORT_FOR_REQUIRED_RESOLUTION/,
  );
  assert.match(rendered, /"finalAuditReportDelivered":true/);
  await run.controller.dispose();
});

test("controller-owned audit tracks do not report false finalText contract violations", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  await finishEmbeddedAudit(run, runId, false);

  const track = [...run.controller.agentView.list()]
    .reverse()
    .find((agent) => agent.role === AUDIT_SEGMENT_LUNA_ROLES[0]);
  assert.ok(track);
  Reflect.set(track, "finalText", "");
  const waitTool = run.rootTool(runId, "pipeline_child_wait");
  assert.ok(waitTool);
  const rendered = JSON.stringify(
    await waitTool.execute(
      "audit-track-wait",
      { ids: [track.id] },
      undefined,
      undefined,
      {} as ExtensionContext,
    ),
  );
  assert.doesNotMatch(rendered, /Report contract violation/);
  await run.controller.dispose();
});

test("embedded roots cannot cancel a busy controller-owned audit synthesizer", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "final-audit");
  const agents = await run.controller.startFinalAudit(runId, {
    acceptanceContract: "approved contract",
    assumptions: [],
    checks: [],
  });
  const firstRole = STATIC_LUNA_AUDIT_ROLES[0];
  settleRole(run, firstRole);
  await settleInitialization();
  const synthesizer = agents.find((agent) => agent.role === "audit-synthesis");
  assert.ok(synthesizer);
  const synthesisSession = run.sessions.find(
    (session) => session.spec.role === "audit-synthesis",
  );
  assert.ok(synthesisSession);
  assert.equal(synthesisSession.sends.length, 1);

  settleRole(run, STATIC_LUNA_AUDIT_ROLES[1]);
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.auditSegment?.pendingReportCount, 1);
  await assert.rejects(
    run.controller.cancelChild(runId, synthesizer.id),
    /only be cancelled with the whole pipeline run/,
  );
  assert.equal(synthesisSession.interrupted, 0);
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.controller.get(runId)?.auditSegment?.reducerStatus, "busy");

  await run.controller.cancelRun(runId);
  assert.equal(synthesisSession.interrupted, 1);
  await run.controller.dispose();
});

test("a settled child can be retried in its existing session", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-logic-invariants",
  );
  const childSession = run.sessions.find(
    (session) => session.spec.role === child.role,
  );
  assert.ok(childSession);
  childSession.emit({
    type: "settled",
    outcome: { type: "failed", error: "transient provider failure" },
  });

  await run.controller.sendChild(
    runId,
    child.id,
    "Retry the same report once.",
  );

  assert.deepEqual(childSession.sends, ["Retry the same report once."]);
  assert.equal(
    run.controller
      .get(runId)
      ?.agents.filter((agent) => agent.role === "audit-logic-invariants")
      .length,
    1,
  );
  assert.equal(run.controller.getAgent(runId, child.id).status, "running");
  await run.controller.dispose();
});

test("persistent Luna session survives idle remediation turns", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions.find(
    (session) => session.spec.role === "pipeline-root",
  )!;
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "implementation turn" },
  });
  assert.equal(run.controller.agentView.get(rootId)?.status, "idle");

  run.controller.agentView.requestSend(rootId, "Resolve the audit reports");
  await settleInitialization();
  assert.equal(rootSession.sends.length, 2);
  assert.equal(rootSession.sends.at(-1), "Resolve the audit reports");
  assert.equal(
    run.sessions.filter((session) => session.spec.role === "pipeline-root")
      .length,
    1,
  );
  assert.equal(run.controller.agentView.get(rootId)?.status, "running");

  await run.controller.dispose();
});

test("completion is rejected while a child is still active", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  await run.controller.spawnChild(runId, "audit-feature-outcome");
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: [],
    checks: [],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: "/tmp/work",
  };

  assert.throws(
    () => run.controller.complete(runId, facts),
    /while children are active/,
  );
  assert.equal(run.controller.get(runId)?.status, "running");
  assert.equal(run.handoffs.length, 0);
  await run.controller.dispose();
});

test("dashboard cancellation of an idle root cancels the run and active children", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const rootId = run.controller.get(runId)?.rootId;
  assert.ok(rootId);
  const rootSession = run.sessions.find(
    (session) => session.spec.role === "pipeline-root",
  )!;
  rootSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "waiting for next stage" },
  });
  assert.equal(run.controller.agentView.get(rootId)?.status, "idle");
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-reliability-regressions",
  );
  const rootRow = buildPipelineRows(
    [run.controller.get(runId)!],
    new Set([runId]),
  ).find((row) => row.kind === "agent" && row.agentId === rootId);
  assert.ok(rootRow);

  await cancelPipelineRow(run.controller, rootRow);
  await waitForHandoff(run, runId);

  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.controller.getAgent(runId, rootId).status, "cancelled");
  assert.equal(run.controller.getAgent(runId, child.id).status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  assert.equal(run.handoffs[0]?.status, "cancelled");
  await run.controller.dispose();
});

test("feature completion appends committed and dirty Git facts without readiness status", async () => {
  const workingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-completion-git-"),
  );
  execFileSync("git", ["init", "-q"], { cwd: workingDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: workingDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], {
    cwd: workingDir,
  });
  fs.writeFileSync(path.join(workingDir, "feature.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: workingDir });

  const run = harness();
  const runId = run.controller.start(request(workingDir));
  await settleInitialization();
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: ["feature.txt"],
    checks: ["npm test passed"],
    assumptions: ["Existing authenticated users are the target audience"],
    git: ["Sol reported implementation Git state"],
    reports: ["discover-problem: user need verified"],
    unresolvedItems: ["manual browser check pending"],
    workingDir,
  };
  assert.throws(
    () => run.controller.complete(runId, { ...facts, workingDir: "/other" }),
    /working_dir must be/,
  );
  await finishEmbeddedAudit(run, runId, true, [finalAuditFinding()]);
  fs.writeFileSync(path.join(workingDir, "feature.txt"), "committed\n");
  execFileSync("git", ["add", "feature.txt"], { cwd: workingDir });
  execFileSync("git", ["commit", "-qm", "feature implementation"], {
    cwd: workingDir,
  });
  fs.writeFileSync(path.join(workingDir, "feature.txt"), "dirty follow-up\n");
  assert.throws(
    () =>
      run.controller.complete(runId, {
        ...facts,
        reports: [...facts.reports, "Incidental AUD-001 mention only"],
      }),
    /final_finding_resolutions.*AUD-001/,
  );
  assert.throws(
    () =>
      run.controller.complete(runId, {
        ...facts,
        finalFindingResolutions: [
          {
            findingId: "AUD-001",
            disposition: "fixed",
            evidence: "",
            verification: ["Focused check passed"],
          },
        ],
      }),
    /non-empty evidence and verification/,
  );
  const resolvedFacts = {
    ...facts,
    reports: [...facts.reports, "Final audit resolutions recorded"],
    finalFindingResolutions: [
      {
        findingId: "AUD-001",
        disposition: "fixed" as const,
        evidence:
          "Enforced direct final-report delivery and completion gating.",
        verification: ["Focused final-resolve regression passed"],
      },
    ],
  };
  completeSyntheticRoot(run, runId, resolvedFacts, "pipeline-complete-git");
  await settleInitialization();
  await waitForHandoff(run, runId);

  assert.equal(run.handoffs.length, 1);
  const handoff = run.handoffs[0];
  assert.ok(handoff);
  const { auditReport, ...completedFacts } = handoff.facts;
  assert.equal(completedFacts.git[0], facts.git[0]);
  assert.ok(
    completedFacts.git.some(
      (item) =>
        item.startsWith("Final base..HEAD commits") &&
        item.includes("feature implementation"),
    ),
  );
  assert.ok(
    completedFacts.git.some(
      (item) =>
        item.startsWith("Final committed diff") && item.includes("+committed"),
    ),
  );
  assert.ok(
    completedFacts.git.some(
      (item) =>
        item.startsWith("Final dirty HEAD..WORKTREE diff") &&
        item.includes("+dirty follow-up"),
    ),
  );
  assert.deepEqual(
    { ...completedFacts, git: resolvedFacts.git },
    resolvedFacts,
  );
  assert.deepEqual(auditReport?.integratedRoles, AUDIT_SEGMENT_LUNA_ROLES);
  assert.equal(auditReport?.executedChecks[0]?.status, "passed");
  assert.equal(
    auditReport?.hostWorkspaceObservation.capturedAfterExecutor,
    true,
  );
  assert.equal("readiness" in handoff, false);
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.equal(run.featureCleanupCompleted, 1);
  await assert.rejects(
    Promise.resolve().then(() =>
      run.controller.complete(runId, { ...facts, workingDir: "/other" }),
    ),
    /is completed/,
  );

  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan-pipeline uses six Luna discoveries and one xhigh synthesis for terminal-only output", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-new-"));
  const run = harness({ autoCompletePlan: true });
  const runId = run.controller.start({
    ...nonFeatureRequest("plan-pipeline", workingDir),
    gitCommit: false,
    planPath: null,
  });
  await settleInitialization();
  await waitForHandoff(run, runId);
  const snapshot = run.controller.get(runId);
  assert.equal(snapshot?.status, "completed");
  assert.equal(snapshot?.stage, "complete");
  assert.equal(snapshot?.agents.length, 7);
  assert.equal(snapshot?.agents[0]?.role, PLAN_PIPELINE_SYNTHESIS_ROLE);
  assert.equal(snapshot?.agents[0]?.model, LUNA_MODEL);
  assert.equal(snapshot?.agents[0]?.thinkingLevel, "xhigh");
  assert.deepEqual(
    snapshot?.agents.slice(1).map((agent) => agent.role),
    [...PLAN_PIPELINE_DISCOVERY_ROLES],
  );
  assert.equal(
    snapshot?.agents
      .slice(1)
      .every(
        (agent) =>
          agent.model === LUNA_MODEL && agent.thinkingLevel === "medium",
      ),
    true,
  );
  assert.equal(
    snapshot?.completion?.plan,
    "# Controller test plan\n\nA free-form plan.",
  );
  assert.equal(snapshot?.completion?.planPath, undefined);
  assert.equal(run.handoffs[0]?.facts.plan, snapshot?.completion?.plan);
  assert.equal(fs.readdirSync(workingDir).length, 0);
  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan-pipeline freezes accepted typed discovery sessions while whole-run cancellation remains available", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-freeze-"));
  const run = harness({ autoCompletePlan: false });
  const runId = run.controller.start({
    ...nonFeatureRequest("plan-pipeline", workingDir),
    gitCommit: false,
    planPath: null,
  });
  await settleInitialization();

  const acceptedSession = run.sessions.find(
    (session) => session.spec.role === PLAN_PIPELINE_DISCOVERY_ROLES[0],
  );
  assert.ok(acceptedSession?.discoverySubmit);
  acceptedSession.discoverySubmit(
    JSON.parse(planReportForRole(PLAN_PIPELINE_DISCOVERY_ROLES[0])),
  );
  acceptedSession.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "" },
  });
  await settleInitialization();

  const acceptedNode = run.controller
    .get(runId)
    ?.agents.find((agent) => agent.role === acceptedSession.spec.role);
  assert.ok(acceptedNode);
  assert.equal(run.controller.get(runId)?.stage, "discover");
  await assert.rejects(
    run.controller.sendChild(
      runId,
      acceptedNode.id,
      "Continue after acceptance",
    ),
    /already submitted an accepted report/,
  );

  const sendsBefore = acceptedSession.sends.length;
  const interruptsBefore = acceptedSession.interrupted;
  run.controller.agentView.requestSend(
    acceptedNode.id,
    "Restart accepted discovery",
  );
  run.controller.agentView.requestCancel(acceptedNode.id);
  await settleInitialization();
  assert.equal(acceptedSession.sends.length, sendsBefore);
  assert.equal(acceptedSession.interrupted, interruptsBefore);

  const cancelled = await run.controller.cancelRun(runId);
  assert.equal(cancelled.status, "cancelled");
  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan-pipeline corrects malformed discovery and synthesis turns in place", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-correct-"));
  const run = harness({ autoCompletePlan: false });
  const runId = run.controller.start({
    ...nonFeatureRequest("plan-pipeline", workingDir),
    gitCommit: false,
    planPath: null,
  });
  await settleInitialization();
  const discovery = PLAN_PIPELINE_DISCOVERY_ROLES.map((role) => {
    const child = run.controller
      .get(runId)
      ?.agents.find((agent) => agent.role === role);
    assert.ok(child);
    return child;
  });
  const malformed = discovery[0];
  assert.ok(malformed);
  run.sessions
    .find((session) => session.spec.role === malformed.role)
    ?.emit({
      type: "settled",
      outcome: { type: "completed", finalText: "malformed" },
    });
  for (const child of discovery.slice(1)) {
    run.sessions
      .find((session) => session.spec.role === child.role)
      ?.emit({
        type: "settled",
        outcome: {
          type: "completed",
          finalText: planReportForRole(
            child.role as (typeof PLAN_PIPELINE_DISCOVERY_ROLES)[number],
          ),
        },
      });
  }
  await settleInitialization();
  const malformedSession = run.sessions.find(
    (session) => session.spec.role === malformed.role,
  );
  assert.ok(malformedSession);
  assert.equal(run.controller.get(runId)?.stage, "discover");
  assert.equal(malformedSession.sends.length, 1);
  malformedSession.emit({
    type: "settled",
    outcome: {
      type: "completed",
      finalText: planReportForRole(
        malformed.role as (typeof PLAN_PIPELINE_DISCOVERY_ROLES)[number],
      ),
    },
  });
  await settleInitialization();
  assert.equal(run.controller.get(runId)?.stage, "synthesize");

  const synthesis = run.sessions.find(
    (session) => session.spec.role === PLAN_PIPELINE_SYNTHESIS_ROLE,
  );
  assert.ok(synthesis);
  synthesis.emit({
    type: "settled",
    outcome: { type: "completed", finalText: " " },
  });
  await settleInitialization();
  assert.equal(synthesis.sends.length, 2);
  synthesis.emit({
    type: "settled",
    outcome: { type: "completed", finalText: "# Corrected plan" },
  });
  await settleInitialization();
  await waitForHandoff(run, runId);
  assert.equal(run.controller.get(runId)?.status, "completed");
  assert.equal(run.handoffs[0]?.facts.plan, "# Corrected plan");
  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan-pipeline writes exact accepted bytes to arbitrary safe destinations", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-output-"));
  const relativePath = "nested/plan.output";
  const run = harness({ autoCompletePlan: true });
  const runId = run.controller.start({
    ...nonFeatureRequest("plan-pipeline", workingDir),
    gitCommit: false,
    planPath: relativePath,
  });
  await settleInitialization();
  await waitForHandoff(run, runId);
  const snapshot = run.controller.get(runId);
  const outputPath = path.join(workingDir, relativePath);
  assert.equal(snapshot?.status, "completed");
  assert.equal(snapshot?.completion?.planPath, relativePath);
  assert.equal(fs.readFileSync(outputPath, "utf8"), snapshot?.completion?.plan);
  assert.equal(
    run.handoffs[0]?.facts.plan,
    fs.readFileSync(outputPath, "utf8"),
  );

  const absolutePath = path.join(workingDir, "absolute.plan");
  const absoluteRunId = run.controller.start({
    ...nonFeatureRequest("plan-pipeline", workingDir),
    gitCommit: false,
    planPath: absolutePath,
  });
  await settleInitialization();
  const absoluteSnapshot = run.controller.get(absoluteRunId);
  assert.equal(absoluteSnapshot?.completion?.planPath, "absolute.plan");
  assert.equal(
    fs.readFileSync(absolutePath, "utf8"),
    absoluteSnapshot?.completion?.plan,
  );
  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("plan-pipeline rejects omitted and escaping output paths before a run", async () => {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-path-"));
  const run = harness();
  assert.throws(
    () =>
      run.controller.start({
        ...nonFeatureRequest("plan-pipeline", workingDir),
        gitCommit: false,
      }),
    /requires an explicit planPath/,
  );
  for (const planPath of [
    "../outside.plan",
    path.join(os.tmpdir(), "outside.plan"),
  ]) {
    assert.throws(
      () =>
        run.controller.start({
          ...nonFeatureRequest("plan-pipeline", workingDir),
          gitCommit: false,
          planPath,
        }),
      /inside working_dir|traversal/,
    );
  }
  await run.controller.dispose();
  fs.rmSync(workingDir, { recursive: true, force: true });
});

test("pipeline inspection does not mutate lifecycle state or consume the automatic handoff", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  const facts = {
    outcome: "Feature behavior implemented",
    changedPaths: ["src/feature.ts"],
    checks: ["focused test passed"],
    assumptions: [],
    git: [],
    reports: [],
    unresolvedItems: [],
    workingDir: implementationWorkingDir(),
  };
  await finishEmbeddedAudit(run, runId);
  completeSyntheticRoot(run, runId, facts, "pipeline-complete-inspection");
  await settleInitialization();
  await waitForHandoff(run, runId);
  const before = structuredClone(run.controller.get(runId));
  assert.equal(run.handoffs.length, 1);

  const inspected = inspectPipeline(run.controller, runId, 123_456);

  assert.equal(inspected.details.pipeline.id, runId);
  assert.deepEqual(run.controller.get(runId), before);
  assert.equal(run.handoffs.length, 1);
  const { auditReport: _auditReport, ...handoffFacts } =
    run.handoffs[0]?.facts ?? {};
  assert.deepEqual(
    { ...handoffFacts, git: handoffFacts.git?.slice(0, facts.git.length) },
    facts,
  );
  assert.ok(
    handoffFacts.git?.some((item) => item.startsWith("Final Git HEAD:")),
  );
  await run.controller.dispose();
});

test("pipeline inspection compactly represents every controller-reachable settled attempt", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();

  run.controller.setStage(runId, "audit");
  for (let attempt = 1; attempt <= 300; attempt++) {
    await run.controller.spawnChild(runId, "audit-feature-outcome");
    const session = run.sessions.at(-1);
    assert.ok(session);
    session.emit({
      type: "settled",
      outcome: {
        type: "completed",
        finalText: reportForRole("audit-feature-outcome"),
      },
    });
  }

  const inspected = inspectPipeline(run.controller, runId, 123_456);
  const text = inspected.content[0]?.text ?? "";
  assert.equal(inspected.details.pipeline.agents.length, 309);
  assert.equal(inspected.details.pipeline.agents[0]?.id, "node-9");
  assert.equal(inspected.details.pipeline.agents.at(-1)?.id, "node-309");
  assert.ok(Buffer.byteLength(text, "utf8") <= PIPELINE_CHECK_MAX_BYTES);
  assert.match(
    text,
    /audit-feature-outcome · attempts 1–300 .* · done · 300 agents/,
  );
  assert.match(text, /- node-9 · pipeline-root/);
  await run.controller.dispose();
});

test("unknown IDs fail closed and cancellation/disposal stop active sessions", async () => {
  const run = harness();
  const runId = run.controller.start(request());
  await settleInitialization();
  run.controller.setStage(runId, "audit");
  const child = await run.controller.spawnChild(
    runId,
    "audit-logic-invariants",
  );
  await assert.rejects(
    run.controller.waitForChildren(runId, ["unknown"]),
    /Unknown agent id/,
  );
  await assert.rejects(
    run.controller.cancelChild(runId, "unknown"),
    /Unknown agent id/,
  );

  await run.controller.cancelChild(runId, child.id);
  assert.equal(run.controller.getAgent(runId, child.id).status, "cancelled");
  await run.controller.cancelRun(runId);
  await waitForHandoff(run, runId);
  assert.equal(run.controller.get(runId)?.status, "cancelled");
  assert.equal(run.handoffs.length, 1);
  await run.controller.dispose();
  assert.equal(
    run.sessions.every((session) => session.disposed === 1),
    true,
  );
});

test("pipeline roots and children do not apply direct-subagent capacity limits", async () => {
  let releaseRoot = () => {};
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve;
  });
  const run = harness({ rootGate });
  const ids = Array.from({ length: 5 }, () =>
    run.controller.start({
      ...nonFeatureRequest("plan-pipeline"),
      gitCommit: false,
      planPath: null,
    }),
  );
  await settleInitialization();
  assert.equal(
    ids.every((id) => run.controller.get(id)?.status === "starting"),
    true,
  );
  releaseRoot();
  await settleInitialization();
  assert.equal(
    ids.every((id) => run.controller.get(id)?.status === "running"),
    true,
  );
  assert.equal(run.sessions.length, 35);

  await run.controller.dispose();
});
