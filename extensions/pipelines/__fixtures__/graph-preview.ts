import type { PipelineRunSnapshot } from "../domain.ts";

type Progress = NonNullable<PipelineRunSnapshot["featureGraph"]>;
const task = (taskId: string) => ({ kind: "task" as const, taskId });
const sequence = (...steps: Progress["tree"][]) => ({
  kind: "sequence" as const,
  steps,
});
const parallel = (...branches: Progress["tree"][]) => ({
  kind: "fork" as const,
  branches,
});

// UI-only execution snapshot: no controller, agents, Git actions, or model calls.
export function graphPreviewRun(): PipelineRunSnapshot {
  const tree = sequence(
    task("record-design"),
    parallel(
      sequence(
        task("add-contracts"),
        parallel(task("implement-context"), task("implement-inference")),
      ),
      sequence(task("add-persistence"), task("migrate-data")),
    ),
    task("implement-generation"),
    task("wire-production"),
    parallel(
      sequence(
        task("desktop-surfaces"),
        parallel(task("accessibility-pass"), task("visual-regression")),
      ),
      sequence(task("mobile-surfaces"), task("device-verification")),
    ),
    task("verify-integration"),
    parallel(task("package-artifacts"), task("write-release-notes")),
    task("final-verification"),
  );
  function ids(node: Progress["tree"]): string[] {
    return node.kind === "task"
      ? [node.taskId]
      : (node.kind === "sequence" ? node.steps : node.branches).flatMap(ids);
  }
  const done = new Set([
    "record-design",
    "add-contracts",
    "implement-context",
    "implement-inference",
    "add-persistence",
  ]);
  return {
    id: "graph-preview-demo-12345678",
    definition: "feature-pipeline",
    workingDir: "/test/graph-preview (simulated execution)",
    stage: "build",
    status: "running",
    startedAt: 1,
    agents: [],
    featureGraph: {
      artifactDir: "/test/artifacts",
      planning: {
        candidates: [],
        canonical: "accepted",
        graph: "accepted",
        review: "waiting",
      },
      tree,
      tasks: ids(tree).map((id) => ({
        id,
        kind: "task",
        objective: id,
        status: done.has(id)
          ? "validated"
          : id === "migrate-data"
            ? "running"
            : "waiting",
        attempt: done.has(id) || id === "migrate-data" ? 1 : 0,
        attempts: [],
        branchId: "preview",
        branch: "",
        worktree: "/test/preview",
        checks: [],
        warnings: [],
        residualPaths: [],
      })),
      branches: [],
      joins: [],
      warnings: [],
      residualPaths: [],
    },
  };
}
