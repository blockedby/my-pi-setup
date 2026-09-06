import assert from "node:assert/strict";
import test from "node:test";
import {
  compileFeatureExecutionGraph,
  validateAndCompileFeatureExecutionGraph,
  validateFeatureExecutionGraph,
} from "./feature-graph.ts";
import {
  canonicalPlan,
  executionGraph,
  executionTask,
} from "./feature-planning.test.ts";

function graphWith(tasks: ReturnType<typeof executionTask>[]) {
  return { ...executionGraph(), tasks };
}

function taskIdsIn(
  tree: ReturnType<typeof compileFeatureExecutionGraph>,
): string[] {
  if (tree.kind === "task") return [tree.taskId];
  const children = tree.kind === "sequence" ? tree.steps : tree.branches;
  return children.flatMap(taskIdsIn);
}

test("compiler preserves a linear task chain", () => {
  const tree = compileFeatureExecutionGraph(
    canonicalPlan(),
    graphWith([
      executionTask("define-contract"),
      executionTask("connect-runtime", ["define-contract"]),
      executionTask("add-tests", ["connect-runtime"]),
    ]),
  );
  assert.deepEqual(tree, {
    kind: "sequence",
    steps: [
      { kind: "task", taskId: "define-contract" },
      { kind: "task", taskId: "connect-runtime" },
      { kind: "task", taskId: "add-tests" },
    ],
  });
});

test("compiler ignores redundant transitive dependency edges", () => {
  const tree = compileFeatureExecutionGraph(
    canonicalPlan(),
    graphWith([
      executionTask("first"),
      executionTask("second", ["first"]),
      executionTask("third", ["first", "second"]),
    ]),
  );
  assert.deepEqual(taskIdsIn(tree), ["first", "second", "third"]);
});

test("compiler deterministically decomposes a fork and common join", () => {
  const tasks = [
    executionTask("finish", ["left-two", "right-two"]),
    executionTask("right-two", ["right-one"]),
    executionTask("left-one", ["start"]),
    executionTask("start"),
    executionTask("left-two", ["left-one"]),
    executionTask("right-one", ["start"]),
  ];
  const expected = {
    kind: "sequence",
    steps: [
      { kind: "task", taskId: "start" },
      {
        kind: "fork",
        branches: [
          {
            kind: "sequence",
            steps: [
              { kind: "task", taskId: "left-one" },
              { kind: "task", taskId: "left-two" },
            ],
          },
          {
            kind: "sequence",
            steps: [
              { kind: "task", taskId: "right-one" },
              { kind: "task", taskId: "right-two" },
            ],
          },
        ],
      },
      { kind: "task", taskId: "finish" },
    ],
  };
  assert.deepEqual(
    compileFeatureExecutionGraph(canonicalPlan(), graphWith(tasks)),
    expected,
  );
  assert.deepEqual(
    compileFeatureExecutionGraph(
      canonicalPlan(),
      graphWith([...tasks].reverse()),
    ),
    expected,
  );
});

test("multiple roots and sinks compile through virtual boundaries", () => {
  assert.deepEqual(
    compileFeatureExecutionGraph(
      canonicalPlan(),
      graphWith([
        executionTask("right-finish", ["right-start"]),
        executionTask("left-start"),
        executionTask("right-start"),
        executionTask("left-finish", ["left-start"]),
      ]),
    ),
    {
      kind: "fork",
      branches: [
        {
          kind: "sequence",
          steps: [
            { kind: "task", taskId: "left-start" },
            { kind: "task", taskId: "left-finish" },
          ],
        },
        {
          kind: "sequence",
          steps: [
            { kind: "task", taskId: "right-start" },
            { kind: "task", taskId: "right-finish" },
          ],
        },
      ],
    },
  );
});

test("validator rejects cross-branch dependencies before execution", () => {
  const issues = validateFeatureExecutionGraph(
    canonicalPlan(),
    graphWith([
      executionTask("start"),
      executionTask("left", ["start"]),
      executionTask("right", ["start"]),
      executionTask("left-later", ["left", "right"]),
      executionTask("right-later", ["right"]),
      executionTask("finish", ["left-later", "right-later"]),
    ]),
  );
  assert.ok(
    issues.some(
      (issue) => issue.includes("escapes") || issue.includes("cross-branch"),
    ),
  );
});

test("validator rejects bad references, cycles, unsafe cwd, and duplicate effective checks", () => {
  const first = executionTask("first", ["second", "missing"]);
  const second = executionTask("second", ["first"]);
  const issues = validateFeatureExecutionGraph(
    canonicalPlan(),
    graphWith([
      {
        ...first,
        acceptanceRefs: ["AC-missing"],
        checks: [
          {
            id: "typecheck",
            command: "bun run check",
            cwd: "../outside",
            purpose: "Attempt an invalid check.",
            required: true,
          },
        ],
      },
      second,
    ]),
  );
  assert.ok(issues.includes("first depends on unknown task missing."));
  assert.ok(issues.includes("Task dependencies contain a cycle."));
  assert.ok(
    issues.includes(
      "first references unknown acceptance criterion AC-missing.",
    ),
  );
  assert.ok(
    issues.includes("first has duplicate effective check ID typecheck."),
  );
  assert.ok(issues.some((issue) => issue.includes("unsafe cwd")));
});

test("validation result never exposes a tree for an invalid DAG", () => {
  const result = validateAndCompileFeatureExecutionGraph(canonicalPlan(), {
    ...executionGraph(),
    tasks: [],
  });
  assert.ok(result.issues.length > 0);
  assert.equal("tree" in result, false);
});

interface GeneratedGraph {
  readonly ids: ReadonlyArray<string>;
  readonly roots: ReadonlyArray<string>;
  readonly sinks: ReadonlyArray<string>;
  readonly edges: ReadonlySet<string>;
}

function generatedSeriesParallel(ids: ReadonlyArray<string>): GeneratedGraph[] {
  if (ids.length === 1) {
    return [{ ids, roots: ids, sinks: ids, edges: new Set() }];
  }
  const generated: GeneratedGraph[] = [];
  for (let split = 1; split < ids.length; split++) {
    const leftGraphs = generatedSeriesParallel(ids.slice(0, split));
    const rightGraphs = generatedSeriesParallel(ids.slice(split));
    for (const left of leftGraphs) {
      for (const right of rightGraphs) {
        const commonEdges = new Set([...left.edges, ...right.edges]);
        generated.push({
          ids,
          roots: left.roots,
          sinks: right.sinks,
          edges: new Set([
            ...commonEdges,
            ...left.sinks.flatMap((from) =>
              right.roots.map((to) => `${from}>${to}`),
            ),
          ]),
        });
        generated.push({
          ids,
          roots: [...left.roots, ...right.roots],
          sinks: [...left.sinks, ...right.sinks],
          edges: commonEdges,
        });
      }
    }
  }
  return generated;
}

test("all generated small series-parallel DAGs compile deterministically with one leaf per task", () => {
  const ids = ["task-a", "task-b", "task-c", "task-d"];
  const generated = generatedSeriesParallel(ids);
  assert.equal(generated.length, 40);
  for (const [index, candidate] of generated.entries()) {
    const tasks = candidate.ids.map((id) =>
      executionTask(
        id,
        [...candidate.edges]
          .filter((edge) => edge.endsWith(`>${id}`))
          .map((edge) => edge.slice(0, edge.indexOf(">")))
          .reverse(),
      ),
    );
    let forward: ReturnType<typeof compileFeatureExecutionGraph>;
    try {
      forward = compileFeatureExecutionGraph(canonicalPlan(), graphWith(tasks));
    } catch (error) {
      throw new Error(
        `generated graph ${index} (${[...candidate.edges].join(", ")}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const reversed = compileFeatureExecutionGraph(
      canonicalPlan(),
      graphWith([...tasks].reverse()),
    );
    assert.deepEqual(reversed, forward, `generated graph ${index}`);
    assert.deepEqual(
      [...taskIdsIn(forward)].sort(),
      ids,
      `generated graph ${index}`,
    );
  }
});

test("N-shaped perturbation of parallel branches is rejected", () => {
  const issues = validateFeatureExecutionGraph(
    canonicalPlan(),
    graphWith([
      executionTask("task-a"),
      executionTask("task-b"),
      executionTask("task-c", ["task-a", "task-b"]),
      executionTask("task-d", ["task-b"]),
    ]),
  );
  assert.ok(
    issues.some(
      (issue) =>
        issue.includes("series-parallel") || issue.includes("cross-branch"),
    ),
  );
});
