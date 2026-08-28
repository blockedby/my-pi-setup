import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FEATURE_PIPELINE_ID,
  SMALL_FEATURE_PIPELINE_ID,
  type PipelineDefinitionId,
} from "./domain.ts";

const GIT_OUTPUT_LIMIT = 256 * 1024;

function gitOutput(workingDir: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd: workingDir,
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r?\n$/, "");
}

function canonicalPath(value: string) {
  return path.resolve(fs.realpathSync(value));
}

function requirementError(
  definition: PipelineDefinitionId,
  workingDir: string,
  reason: string,
) {
  return new Error(
    `${definition} requires working_dir to be the exact root of an existing dedicated linked Git worktree on its own branch: ${workingDir}. ${reason}`,
  );
}

function registeredWorktrees(workingDir: string) {
  const output = gitOutput(workingDir, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\0");
      const worktree = fields
        .find((field) => field.startsWith("worktree "))
        ?.slice("worktree ".length);
      const branch = fields
        .find((field) => field.startsWith("branch "))
        ?.slice("branch ".length);
      return { worktree, branch };
    });
}

export function implementationPipelineRequiresLinkedWorktree(
  definition: PipelineDefinitionId,
) {
  return (
    definition === FEATURE_PIPELINE_ID ||
    definition === SMALL_FEATURE_PIPELINE_ID
  );
}

export function assertImplementationPipelineWorkspace(
  definition: PipelineDefinitionId,
  workingDir: string,
) {
  if (!implementationPipelineRequiresLinkedWorktree(definition)) return;

  let requestedRoot: string;
  try {
    if (!fs.statSync(workingDir).isDirectory())
      throw new Error("not directory");
    requestedRoot = canonicalPath(workingDir);
  } catch {
    throw requirementError(
      definition,
      workingDir,
      "The supplied path is not an existing directory.",
    );
  }

  let topLevel: string;
  let gitDir: string;
  let commonDir: string;
  try {
    if (
      gitOutput(workingDir, ["rev-parse", "--is-inside-work-tree"]) !== "true"
    ) {
      throw new Error("not worktree");
    }
    topLevel = canonicalPath(
      gitOutput(workingDir, ["rev-parse", "--show-toplevel"]),
    );
    gitDir = canonicalPath(
      gitOutput(workingDir, ["rev-parse", "--absolute-git-dir"]),
    );
    commonDir = canonicalPath(
      gitOutput(workingDir, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
  } catch {
    throw requirementError(
      definition,
      workingDir,
      "Git does not identify the supplied path as a non-bare worktree.",
    );
  }

  if (requestedRoot !== topLevel) {
    throw requirementError(
      definition,
      workingDir,
      `Git reports the worktree root as ${topLevel}; pass that exact root instead.`,
    );
  }
  if (gitDir === commonDir) {
    throw requirementError(
      definition,
      workingDir,
      "The repository primary checkout is not a linked worktree.",
    );
  }

  let branchRef: string;
  try {
    branchRef = gitOutput(workingDir, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch {
    throw requirementError(
      definition,
      workingDir,
      "The linked worktree has a detached HEAD instead of its own branch.",
    );
  }
  if (!branchRef.startsWith("refs/heads/")) {
    throw requirementError(
      definition,
      workingDir,
      "The linked worktree HEAD does not name a local branch.",
    );
  }

  let worktrees: ReturnType<typeof registeredWorktrees>;
  try {
    worktrees = registeredWorktrees(workingDir);
  } catch {
    throw requirementError(
      definition,
      workingDir,
      "Git could not confirm the linked worktree registration.",
    );
  }
  const current = worktrees.find(({ worktree }) => {
    if (!worktree) return false;
    try {
      return canonicalPath(worktree) === requestedRoot;
    } catch {
      return false;
    }
  });
  if (!current || current.branch !== branchRef) {
    throw requirementError(
      definition,
      workingDir,
      "Git does not register this exact linked worktree root on its current branch.",
    );
  }
  const branchUses = worktrees.filter(({ branch }) => branch === branchRef);
  if (branchUses.length !== 1) {
    throw requirementError(
      definition,
      workingDir,
      "The current branch is also registered to another worktree.",
    );
  }
}
