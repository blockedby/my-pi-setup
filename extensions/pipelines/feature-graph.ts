import type {
  FeatureCanonicalPlan,
  FeatureExecutionGraph,
} from "./feature-planning.ts";
import {
  isSafeRepositoryRelativePath,
  parseFeatureExecutionGraph,
  validateFeatureExecutionGraphSchema,
} from "./feature-planning.ts";

export type ExecutionTree =
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "sequence"; readonly steps: ReadonlyArray<ExecutionTree> }
  | { readonly kind: "fork"; readonly branches: ReadonlyArray<ExecutionTree> };

export type FeatureGraphCompilation =
  | { readonly issues: ReadonlyArray<string>; readonly tree?: never }
  | { readonly issues: readonly []; readonly tree: ExecutionTree };

function duplicates(values: ReadonlyArray<string>) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function uniqueIssues(label: string, values: ReadonlyArray<string>) {
  return duplicates(values).map((value) => `Duplicate ${label} ID: ${value}.`);
}

function validateGraphSemantics(
  canonicalPlan: FeatureCanonicalPlan,
  graph: FeatureExecutionGraph,
) {
  const issues: string[] = [];
  const taskIds = graph.tasks.map(({ id }) => id);
  const duplicateTaskIds = duplicates(taskIds);
  issues.push(...uniqueIssues("task", taskIds));
  const knownTasks = new Set(taskIds);
  const acceptanceIds = new Set(canonicalPlan.acceptance.map(({ id }) => id));

  issues.push(
    ...uniqueIssues(
      "baseline check",
      graph.baselineChecks.map(({ id }) => id),
    ),
    ...uniqueIssues(
      "review check",
      graph.reviewChecks.map(({ id }) => id),
    ),
  );

  for (const task of graph.tasks) {
    for (const dependencyId of duplicates(task.dependsOn)) {
      issues.push(`${task.id} repeats dependency ${dependencyId}.`);
    }
    for (const dependencyId of task.dependsOn) {
      if (!knownTasks.has(dependencyId)) {
        issues.push(`${task.id} depends on unknown task ${dependencyId}.`);
      } else if (dependencyId === task.id) {
        issues.push(`${task.id} cannot depend on itself.`);
      }
    }
    for (const reference of task.acceptanceRefs) {
      if (!acceptanceIds.has(reference)) {
        issues.push(
          `${task.id} references unknown acceptance criterion ${reference}.`,
        );
      }
    }
    const effectiveChecks = [
      ...graph.baselineChecks.map(({ id }) => id),
      ...task.checks.map(({ id }) => id),
    ];
    for (const checkId of duplicates(effectiveChecks)) {
      issues.push(`${task.id} has duplicate effective check ID ${checkId}.`);
    }
    for (const value of [...task.readPaths, ...task.writePaths]) {
      if (!isSafeRepositoryRelativePath(value)) {
        issues.push(
          `${task.id} contains unsafe repository path ${JSON.stringify(value)}.`,
        );
      }
    }
    for (const precedent of task.context.precedents) {
      if (!isSafeRepositoryRelativePath(precedent.path)) {
        issues.push(
          `${task.id} contains unsafe precedent path ${JSON.stringify(precedent.path)}.`,
        );
      }
    }
  }

  const allChecks = [
    ...graph.baselineChecks.map((check) => ({
      owner: "baselineChecks",
      check,
    })),
    ...graph.reviewChecks.map((check) => ({
      owner: "reviewChecks",
      check,
    })),
    ...graph.tasks.flatMap((task) =>
      task.checks.map((check) => ({ owner: `${task.id}.checks`, check })),
    ),
  ];
  for (const { owner, check } of allChecks) {
    if (!isSafeRepositoryRelativePath(check.cwd, true)) {
      issues.push(
        `${owner} check ${check.id} has unsafe cwd ${JSON.stringify(check.cwd)}.`,
      );
    }
  }

  if (duplicateTaskIds.length > 0) return issues;

  const state = new Map<string, "visiting" | "visited">();
  const dependencies = new Map(
    graph.tasks.map((task) => [
      task.id,
      task.dependsOn.filter((id) => knownTasks.has(id)),
    ]),
  );
  const visit = (taskId: string): boolean => {
    if (state.get(taskId) === "visiting") return true;
    if (state.get(taskId) === "visited") return false;
    state.set(taskId, "visiting");
    if ((dependencies.get(taskId) ?? []).some(visit)) return true;
    state.set(taskId, "visited");
    return false;
  };
  if (taskIds.some(visit)) issues.push("Task dependencies contain a cycle.");
  return issues;
}

function sorted(values: Iterable<string>) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sequence(parts: ReadonlyArray<ExecutionTree | undefined>) {
  const steps = parts.flatMap((part) => {
    if (!part) return [];
    return part.kind === "sequence" ? [...part.steps] : [part];
  });
  if (steps.length === 0) return undefined;
  if (steps.length === 1) return steps[0];
  return { kind: "sequence", steps } as const;
}

function compileSeriesParallelGraph(graph: FeatureExecutionGraph) {
  const taskIds = graph.tasks.map(({ id }) => id);
  const successors = new Map(taskIds.map((id) => [id, new Set<string>()]));
  for (const task of graph.tasks) {
    for (const dependencyId of task.dependsOn) {
      successors.get(dependencyId)!.add(task.id);
    }
  }
  const reachableCache = new Map<string, ReadonlySet<string>>();
  const reachableFrom = (start: string) => {
    const cached = reachableCache.get(start);
    if (cached) return cached;
    const reached = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (reached.has(current)) continue;
      reached.add(current);
      pending.push(...(successors.get(current) ?? []));
    }
    reachableCache.set(start, reached);
    return reached;
  };
  const reaches = (from: string, to: string) => reachableFrom(from).has(to);

  const components = (
    ids: ReadonlyArray<string>,
    adjacent: (left: string, right: string) => boolean,
  ) => {
    const remaining = new Set(ids);
    const result: string[][] = [];
    while (remaining.size > 0) {
      const first = sorted(remaining)[0]!;
      const component: string[] = [];
      const pending = [first];
      remaining.delete(first);
      while (pending.length > 0) {
        const current = pending.pop()!;
        component.push(current);
        for (const candidate of sorted(remaining)) {
          if (!adjacent(current, candidate)) continue;
          remaining.delete(candidate);
          pending.push(candidate);
        }
      }
      result.push(component.sort());
    }
    return result;
  };

  const compile = (ids: ReadonlyArray<string>): ExecutionTree => {
    if (ids.length === 1) return { kind: "task", taskId: ids[0]! };

    const comparable = (left: string, right: string) =>
      reaches(left, right) || reaches(right, left);
    const parallelParts = components(ids, comparable);
    if (parallelParts.length > 1) {
      return {
        kind: "fork",
        branches: parallelParts
          .sort(([left], [right]) => left!.localeCompare(right!))
          .map(compile),
      };
    }

    const seriesParts = components(
      ids,
      (left, right) => !comparable(left, right),
    );
    if (seriesParts.length > 1) {
      const ordered = seriesParts.sort((left, right) => {
        const leftFirst = left[0]!;
        const rightFirst = right[0]!;
        if (reaches(leftFirst, rightFirst)) return -1;
        if (reaches(rightFirst, leftFirst)) return 1;
        return leftFirst.localeCompare(rightFirst);
      });
      for (let index = 0; index < ordered.length - 1; index++) {
        const left = ordered[index]!;
        const right = ordered[index + 1]!;
        if (!left.every((from) => right.every((to) => reaches(from, to)))) {
          throw new Error(
            `Task DAG has a cross-branch dependency between ${left.join(", ")} and ${right.join(", ")}.`,
          );
        }
      }
      return sequence(ordered.map(compile))!;
    }

    throw new Error(
      `Task DAG is not series-parallel near ${sorted(ids).join(", ")}; cross-branch dependencies must join before dependent work.`,
    );
  };

  const tree = compile(sorted(taskIds));

  const taskLeaves: string[] = [];
  const collect = (node: ExecutionTree) => {
    if (node.kind === "task") {
      taskLeaves.push(node.taskId);
      return;
    }
    const children = node.kind === "sequence" ? node.steps : node.branches;
    for (const child of children) collect(child);
  };
  collect(tree);
  const expected = graph.tasks.map(({ id }) => id).sort();
  const actual = [...taskLeaves].sort();
  if (
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new Error(
      "Every real task must appear exactly once in the execution tree.",
    );
  }
  return tree;
}

export function validateFeatureExecutionGraph(
  canonicalPlan: FeatureCanonicalPlan,
  value: unknown,
) {
  const issues = validateFeatureExecutionGraphSchema(value);
  if (issues.length > 0) return issues;
  const graph = value as FeatureExecutionGraph;
  issues.push(...validateGraphSemantics(canonicalPlan, graph));
  if (issues.length > 0) return issues;
  try {
    compileSeriesParallelGraph(graph);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

export function validateAndCompileFeatureExecutionGraph(
  canonicalPlan: FeatureCanonicalPlan,
  value: unknown,
): FeatureGraphCompilation {
  const issues = validateFeatureExecutionGraph(canonicalPlan, value);
  if (issues.length > 0) return { issues };
  const graph = parseFeatureExecutionGraph(value);
  return { issues: [], tree: compileSeriesParallelGraph(graph) };
}

export function compileFeatureExecutionGraph(
  canonicalPlan: FeatureCanonicalPlan,
  value: unknown,
) {
  const result = validateAndCompileFeatureExecutionGraph(canonicalPlan, value);
  if (!result.tree) throw new Error(result.issues.join(" "));
  return result.tree;
}
