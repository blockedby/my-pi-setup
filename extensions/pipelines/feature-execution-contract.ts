/** Shared recovery contracts. Controller-observed facts, never model-granted authority. */

/**
 * Trusted lifecycle classification for an isolated operation failure. Emit only
 * after checking that shared ownership/integrity remains intact. Unknown errors,
 * evidence persistence failures and ownership drift remain run-fatal by default.
 * Never infer this capability from model text, stderr, or a serialized payload.
 */
export class FeatureSubtreeOperationError extends Error {
  constructor(
    message: string,
    readonly operation: "worktree-allocation",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FeatureSubtreeOperationError";
  }
}

export interface FeatureCommitRange {
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly commits: ReadonlyArray<string>;
}

export interface FeatureExecutionDiagnostic {
  readonly kind:
    | "preparation"
    | "command"
    | "validation"
    | "report"
    | "boundary"
    | "ownership"
    | "persistence"
    | "session";
  readonly disposition: "recoverable" | "blocked" | "fatal";
  readonly scope: "task" | "run";
  readonly message: string;
}

export interface FeatureCheckRecipe {
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly reason: string;
}

export interface FeatureCheckRequest {
  readonly checkId: string;
  readonly recipe?: FeatureCheckRecipe;
  readonly acceptanceRefs?: ReadonlyArray<string>;
}

export interface FeaturePreparationRequest {
  /** Explicit replacement of one inherited preparation step, after task acceptance. */
  readonly replacesCommand?: string;
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
}

export interface FeaturePreparationResult {
  readonly replacesCommand?: string;
  readonly command: string;
  readonly cwd: string;
  readonly purpose: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: "passed" | "failed";
}

export interface FeatureStageRequest {
  readonly paths: ReadonlyArray<string>;
  readonly action: "stage" | "unstage";
}

export interface FeatureStageResult {
  readonly staged: ReadonlyArray<string>;
}

export interface FeatureCheckpointRequest {
  readonly message: string;
}

export interface FeatureCheckpointResult {
  readonly commit: string;
  readonly changedPaths: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  readonly residualPaths: ReadonlyArray<string>;
}

export interface FeatureAcceptanceRequest {
  readonly summary: string;
  /** Legacy adapter only; new callers use stage/checkpoint before acceptance. */
  readonly commitPaths?: ReadonlyArray<string>;
  /** Legacy adapter only; new callers resolve workspace contents explicitly. */
  readonly discardPaths?: ReadonlyArray<string>;
}
