import type {
  EditToolInput,
  ReadToolInput,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

const TASK_TOOL_NAMES = {
  prepare: "pipeline_task_prepare",
  stage: "pipeline_task_stage",
  checkpoint: "pipeline_task_checkpoint",
  diff: "pipeline_task_diff",
  check: "pipeline_task_check",
  finalize: "pipeline_task_finalize",
  read: "read",
  write: "write",
  edit: "edit",
} as const;

type TaskToolName = (typeof TASK_TOOL_NAMES)[keyof typeof TASK_TOOL_NAMES];

export type TaskToolPhase = "read-only" | "implementation";

export type TaskToolOperation =
  | "prepare"
  | "stage"
  | "checkpoint"
  | "diff"
  | "check"
  | "finalize"
  | "read"
  | "write"
  | "git-mutation"
  | "outside-workspace";

export interface TaskToolContract {
  readonly activeTools: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly phase: TaskToolPhase;
  readonly checkIds: ReadonlyArray<string>;
  readonly readableRoots: ReadonlyArray<string>;
  readonly writableRoots: ReadonlyArray<string>;
  readonly authority: {
    readonly git: "controller-only";
    readonly commit:
      "pipeline_task_checkpoint" | "pipeline_task_finalize" | null;
    readonly checks: "pipeline_task_check" | null;
  };
  readonly routes: {
    readonly prepare: "pipeline_task_prepare" | null;
    readonly stage: "pipeline_task_stage" | null;
    readonly checkpoint: "pipeline_task_checkpoint" | null;
    readonly diff: "pipeline_task_diff" | null;
    readonly check: "pipeline_task_check" | null;
    readonly finalize: "pipeline_task_finalize" | null;
    readonly read: "read" | null;
    readonly write: "write" | "edit" | null;
    readonly "git-mutation": null;
    readonly "outside-workspace": null;
  };
}

export type TaskToolExampleArgs = Readonly<Record<string, unknown>>;

export interface AllowedTaskToolRoute {
  readonly allowed: true;
  readonly operation: TaskToolOperation;
  readonly tool: TaskToolName;
  readonly exampleArgs: TaskToolExampleArgs;
}

export type TaskToolDenialCode =
  | "tool-unavailable"
  | "unknown-check-id"
  | "check-id-required"
  | "read-only"
  | "no-writable-tool"
  | "controller-finalize-unavailable"
  | "outside-workspace"
  | "unsupported-operation";

export interface BlockedTaskToolRoute {
  readonly allowed: false;
  readonly operation: TaskToolOperation;
  readonly code: TaskToolDenialCode;
  readonly reason: string;
  readonly noBypass: true;
}

export type TaskToolRoute = AllowedTaskToolRoute | BlockedTaskToolRoute;

function hasTool(activeTools: ReadonlyArray<string>, tool: string) {
  return activeTools.includes(tool);
}

function validCheckId(checkId: string) {
  return checkId.length > 0 && checkId.length <= 256;
}

function examplePath(contract: TaskToolContract) {
  return path.join(contract.workspaceRoot, "example.txt");
}

function allowed(
  operation: TaskToolOperation,
  tool: TaskToolName,
  exampleArgs: TaskToolExampleArgs,
) {
  return {
    allowed: true,
    operation,
    tool,
    exampleArgs,
  } satisfies AllowedTaskToolRoute;
}

function blocked(
  operation: TaskToolOperation,
  code: TaskToolDenialCode,
  reason: string,
) {
  return {
    allowed: false,
    operation,
    code,
    reason,
    noBypass: true,
  } satisfies BlockedTaskToolRoute;
}

export function buildTaskToolContract(options: {
  readonly activeTools: ReadonlyArray<string>;
  readonly workspaceRoot: string;
  readonly phase: TaskToolPhase;
  readonly checkIds: ReadonlyArray<string>;
}) {
  const activeTools = [...options.activeTools];
  const checkIds = [...options.checkIds];
  const canFinalize =
    options.phase === "implementation" &&
    hasTool(activeTools, TASK_TOOL_NAMES.finalize);
  const checkTool = hasTool(activeTools, TASK_TOOL_NAMES.check)
    ? TASK_TOOL_NAMES.check
    : null;
  const writeTool =
    options.phase === "implementation"
      ? hasTool(activeTools, TASK_TOOL_NAMES.write)
        ? TASK_TOOL_NAMES.write
        : hasTool(activeTools, TASK_TOOL_NAMES.edit)
          ? TASK_TOOL_NAMES.edit
          : null
      : null;

  return {
    activeTools,
    workspaceRoot: options.workspaceRoot,
    phase: options.phase,
    checkIds,
    readableRoots: [options.workspaceRoot],
    writableRoots:
      options.phase === "implementation" ? [options.workspaceRoot] : [],
    authority: {
      git: "controller-only",
      commit:
        options.phase === "implementation" &&
        hasTool(activeTools, TASK_TOOL_NAMES.checkpoint)
          ? TASK_TOOL_NAMES.checkpoint
          : canFinalize
            ? TASK_TOOL_NAMES.finalize
            : null,
      checks: checkTool,
    },
    routes: {
      prepare:
        options.phase === "implementation" &&
        hasTool(activeTools, TASK_TOOL_NAMES.prepare)
          ? TASK_TOOL_NAMES.prepare
          : null,
      stage:
        options.phase === "implementation" &&
        hasTool(activeTools, TASK_TOOL_NAMES.stage)
          ? TASK_TOOL_NAMES.stage
          : null,
      checkpoint:
        options.phase === "implementation" &&
        hasTool(activeTools, TASK_TOOL_NAMES.checkpoint)
          ? TASK_TOOL_NAMES.checkpoint
          : null,
      diff: hasTool(activeTools, TASK_TOOL_NAMES.diff)
        ? TASK_TOOL_NAMES.diff
        : null,
      check: checkTool,
      finalize: canFinalize ? TASK_TOOL_NAMES.finalize : null,
      read: hasTool(activeTools, TASK_TOOL_NAMES.read)
        ? TASK_TOOL_NAMES.read
        : null,
      write: writeTool,
      "git-mutation": null,
      "outside-workspace": null,
    },
  } satisfies TaskToolContract;
}

export function routeTaskOperation(
  contract: TaskToolContract,
  operation: TaskToolOperation,
  checkId?: string,
): TaskToolRoute {
  switch (operation) {
    case "prepare":
    case "stage":
    case "checkpoint": {
      const tool = contract.routes[operation];
      if (!tool)
        return blocked(
          operation,
          contract.phase === "read-only" ? "read-only" : "tool-unavailable",
          "This scoped controller operation is unavailable; no shell or Git bypass is permitted.",
        );
      const examples = {
        prepare: {
          command: "bun install --frozen-lockfile",
          cwd: ".",
          purpose: "Restore declared dependencies",
        },
        stage: { paths: ["example.txt"], action: "stage" },
        checkpoint: { message: "Record verified task progress" },
      };
      return allowed(operation, tool, examples[operation]);
    }
    case "diff":
      return contract.routes.diff
        ? allowed(operation, contract.routes.diff, {})
        : blocked(
            operation,
            "tool-unavailable",
            "The controller diff tool is not active; no other tool is an approved task-diff route.",
          );
    case "check": {
      if (!contract.routes.check) {
        return blocked(
          operation,
          "tool-unavailable",
          "The controller check tool is not active; arbitrary commands are not an approved check route.",
        );
      }
      // Implementation may propose supplementary checks. The runtime, not the
      // routing hint, validates their recipe, coverage and preserved obligations.
      if (
        contract.phase !== "implementation" &&
        checkId !== undefined &&
        !contract.checkIds.includes(checkId)
      ) {
        return blocked(
          operation,
          "unknown-check-id",
          `Check ID ${JSON.stringify(checkId)} is not declared for this task; only declared checks may be requested.`,
        );
      }
      const selectedCheckId = checkId ?? contract.checkIds.find(validCheckId);
      if (!selectedCheckId || !validCheckId(selectedCheckId)) {
        return blocked(
          operation,
          "check-id-required",
          "A bounded check ID is required. New implementation IDs additionally require a recipe and valid acceptance references at runtime.",
        );
      }
      return allowed(operation, contract.routes.check, {
        checkId: selectedCheckId,
      });
    }
    case "finalize":
      return contract.routes.finalize
        ? allowed(operation, contract.routes.finalize, {
            summary: "Finalize through the controller.",
          })
        : blocked(
            operation,
            contract.phase === "read-only"
              ? "read-only"
              : "controller-finalize-unavailable",
            contract.phase === "read-only"
              ? "The task is read-only; finalization cannot grant write or commit authority."
              : "The controller finalization tool is not active; no other tool may finalize the task.",
          );
    case "read":
      return contract.routes.read
        ? allowed(operation, contract.routes.read, {
            path: examplePath(contract),
          } satisfies ReadToolInput)
        : blocked(
            operation,
            "tool-unavailable",
            "The read tool is not active; no other tool is an approved workspace-read route.",
          );
    case "write":
      if (contract.phase === "read-only") {
        return blocked(
          operation,
          "read-only",
          "The task is read-only; no write or edit tool may be used and there is no bypass.",
        );
      }
      if (!contract.routes.write) {
        return blocked(
          operation,
          "no-writable-tool",
          "No active write-capable tool is available for the assigned workspace.",
        );
      }
      return contract.routes.write === TASK_TOOL_NAMES.write
        ? allowed(operation, contract.routes.write, {
            path: examplePath(contract),
            content: "example content\n",
          } satisfies WriteToolInput)
        : allowed(operation, contract.routes.write, {
            path: examplePath(contract),
            edits: [{ oldText: "existing text", newText: "updated text" }],
          } satisfies EditToolInput);
    case "git-mutation":
      return blocked(
        operation,
        "unsupported-operation",
        "Generic Git mutation is never approved; use scoped stage/checkpoint tools and finalize for controller-owned acceptance.",
      );
    case "outside-workspace":
      return blocked(
        operation,
        "outside-workspace",
        "The task contract has no route outside the assigned workspace and provides no bypass.",
      );
    default:
      return blocked(
        operation,
        "unsupported-operation",
        "This operation is not part of the task tool contract and has no bypass.",
      );
  }
}
