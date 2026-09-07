import type { PipelineRunSnapshot } from "./domain.ts";

type FeatureProgress = NonNullable<PipelineRunSnapshot["featureGraph"]>;
type TaskSnapshot = FeatureProgress["tasks"][number];
type ExecutionTree = FeatureProgress["tree"];

export function featureTaskGlyph(status: TaskSnapshot["status"]) {
  if (status === "validated" || status === "satisfied_without_changes")
    return "done";
  if (status === "failed") return "error";
  if (status === "cancelled") return "cancelled";
  if (status === "waiting") return undefined;
  return "running";
}

export function featureTaskLabel(task: TaskSnapshot) {
  const commit = task.validatedCommit ?? task.provisionalCommit;
  return [
    task.id,
    task.status,
    `attempt ${task.attempt}`,
    ...(task.branch ? [task.branch] : []),
    ...(commit
      ? [
          `${task.validatedCommit ? "commit" : "provisional"} ${commit.slice(0, 12)}`,
        ]
      : []),
  ].join(" · ");
}

export function projectFeatureTasks(progress: FeatureProgress) {
  return {
    artifactDir: progress.artifactDir,
    planning: progress.planning,
    tasks: progress.tasks.map((task) => ({
      id: task.id,
      kind: task.kind,
      status: task.status,
      attempt: task.attempt,
      branch: task.branch,
      worktree: task.worktree,
      ...(task.validatedCommit
        ? { validatedCommit: task.validatedCommit }
        : {}),
      ...(task.provisionalCommit
        ? { provisionalCommit: task.provisionalCommit }
        : {}),
      checks: task.checks,
      warnings: task.warnings,
      residualPaths: task.residualPaths,
      ...(task.error ? { error: task.error } : {}),
    })),
    branches: progress.branches,
    joins: progress.joins,
    warnings: progress.warnings,
    residualPaths: progress.residualPaths,
  };
}

export function featureExecutionRows(progress: FeatureProgress) {
  const rows: Array<{
    key: string;
    kind: "task" | "boundary";
    depth: number;
    label: string;
    taskId?: string;
    status?: TaskSnapshot["status"];
  }> = [];
  const byId = new Map(progress.tasks.map((task) => [task.id, task]));
  const emitted = new Set<string>();
  function taskRow(task: TaskSnapshot, depth: number, prefix = "") {
    emitted.add(task.id);
    rows.push({
      key: task.id,
      kind: "task",
      taskId: task.id,
      depth,
      label: prefix + featureTaskLabel(task),
      status: task.status,
    });
  }
  function complete(tree: ExecutionTree): boolean {
    if (tree.kind === "task") {
      const status = byId.get(tree.taskId)?.status;
      return status === "validated" || status === "satisfied_without_changes";
    }
    const children = tree.kind === "sequence" ? tree.steps : tree.branches;
    return children.length > 0 && children.every(complete);
  }
  // Flatten sequence wrappers without turning parallel branches into serial steps.
  function steps(tree: ExecutionTree): ExecutionTree[] {
    return tree.kind === "sequence" ? tree.steps.flatMap(steps) : [tree];
  }
  function sequence(tree: ExecutionTree, depth: number, scope = "") {
    let previous: string | undefined;
    for (const [index, step] of steps(tree).entries()) {
      const number = scope
        ? `${scope}.${index + 1}`
        : String(index + 1).padStart(2, "0");
      visit(step, depth, number, previous);
      previous = number;
    }
  }
  function visit(
    tree: ExecutionTree,
    depth: number,
    number: string,
    previous?: string,
  ) {
    const prefix = `${number} ${previous ? `after ${previous}: ` : ""}`;
    if (tree.kind === "task") {
      const task = byId.get(tree.taskId);
      if (task) taskRow(task, depth, prefix);
      else
        rows.push({
          key: tree.taskId,
          kind: "task",
          taskId: tree.taskId,
          depth,
          label: `${prefix}${tree.taskId} · waiting`,
          status: "waiting",
        });
      return;
    }
    if (tree.kind === "sequence") {
      sequence(tree, depth, number);
      return;
    }
    rows.push({
      key: `parallel:${number}`,
      kind: "boundary",
      depth,
      label: `${prefix}parallel [${tree.branches.filter(complete).length}/${tree.branches.length} branches]`,
    });
    for (const [index, branch] of tree.branches.entries()) {
      // Alphabetic branch addresses remain unambiguous beyond Z (AA, AB, ...).
      let letter = "";
      for (
        let value = index + 1;
        value > 0;
        value = Math.floor((value - 1) / 26)
      ) {
        letter = String.fromCharCode(65 + ((value - 1) % 26)) + letter;
      }
      const scope = `${number}.${letter}`;
      const branchSteps = steps(branch);
      if (branchSteps.length === 1) {
        visit(branchSteps[0]!, depth + 1, scope);
      } else {
        rows.push({
          key: `sequence:${scope}`,
          kind: "boundary",
          depth: depth + 1,
          label: `${letter}: sequence`,
        });
        sequence(branch, depth + 2, scope);
      }
    }
  }
  sequence(progress.tree, 3);
  for (const task of progress.tasks) {
    if (!emitted.has(task.id) && task.kind !== "final-review") taskRow(task, 3);
  }
  for (const branch of progress.branches) {
    rows.push({
      key: `branch-${branch.id}`,
      kind: "boundary",
      depth: 3,
      label: `${branch.id} · ${branch.status} · preparation ${branch.preparation.complete ? "complete" : `attempt ${branch.preparation.attempts}`} · ${branch.worktree}`,
    });
  }
  for (const join of progress.joins) {
    rows.push({
      key: `integration-${join.id}`,
      kind: "boundary",
      depth: 3,
      label: `${join.id} · ${join.status} · ${join.commits.length} integrated commits`,
    });
  }
  for (const [index, warning] of progress.warnings.entries()) {
    rows.push({
      key: `warning-${index}`,
      kind: "boundary",
      depth: 3,
      label: `Warning: ${warning}`,
    });
  }
  return rows;
}

export function featureTaskDetails(run: PipelineRunSnapshot, taskId: string) {
  const progress = run.featureGraph;
  const task = progress?.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return `Task ${taskId} is waiting for execution context.`;
  return [
    featureTaskLabel(task),
    task.objective,
    `Worktree: ${task.worktree}`,
    `Base: ${task.taskBaseCommit ?? "not started"}`,
    `Artifacts: ${progress?.artifactDir ?? "unavailable"}`,
    "",
    "Task capsule",
    JSON.stringify(task.capsule ?? null, null, 2),
    "",
    "Session attempts",
    JSON.stringify(
      task,
      (key, value: unknown) =>
        ["capsule", "checks", "summary", "warnings", "residualPaths"].includes(
          key,
        )
          ? undefined
          : value,
      2,
    ),
    "",
    "Checks",
    JSON.stringify(task.checks, null, 2),
    "",
    "Summary",
    task.summary ?? task.error ?? "No validated summary yet.",
    "",
    "Warnings and residual paths",
    ...task.warnings,
    ...task.residualPaths,
    ...(task.error ? [task.error] : []),
  ].join("\n");
}
