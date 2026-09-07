import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
  buildTaskToolContract,
  routeTaskOperation,
} from "./task-tool-contract.ts";

test("builds phase and authority metadata from the actual active tools", () => {
  const workspaceRoot = "/workspace/task";
  const activeTools = [
    "read",
    "pipeline_task_diff",
    "pipeline_task_check",
    "pipeline_task_finalize",
    "write",
  ];
  const contract = buildTaskToolContract({
    activeTools,
    workspaceRoot,
    phase: "implementation",
    checkIds: ["check-types", "check-tests"],
  });

  assert.deepEqual(contract.activeTools, activeTools);
  assert.deepEqual(contract.readableRoots, [workspaceRoot]);
  assert.deepEqual(contract.writableRoots, [workspaceRoot]);
  assert.deepEqual(contract.authority, {
    git: "controller-only",
    commit: "pipeline_task_finalize",
    checks: "pipeline_task_check",
  });
  assert.deepEqual(contract.routes, {
    diff: "pipeline_task_diff",
    check: "pipeline_task_check",
    finalize: "pipeline_task_finalize",
    read: "read",
    write: "write",
    "git-mutation": null,
    "outside-workspace": null,
  });
});

test("never suggests a tool that is absent from the active tool set", () => {
  const contract = buildTaskToolContract({
    activeTools: ["read", "bash"],
    workspaceRoot: "/workspace/task",
    phase: "implementation",
    checkIds: ["check-tests"],
  });

  for (const operation of [
    "diff",
    "check",
    "finalize",
    "write",
    "git-mutation",
  ] as const) {
    const route = routeTaskOperation(contract, operation, "check-tests");
    assert.equal(route.allowed, false);
    if (!route.allowed) assert.equal(route.noBypass, true);
  }

  const read = routeTaskOperation(contract, "read");
  assert.equal(read.allowed, true);
  if (read.allowed) assert.equal(read.tool, "read");
});

test("blocks writes and finalization in the read-only phase", () => {
  const contract = buildTaskToolContract({
    activeTools: [
      "read",
      "write",
      "edit",
      "pipeline_task_finalize",
      "pipeline_task_check",
    ],
    workspaceRoot: "/workspace/task",
    phase: "read-only",
    checkIds: ["check-tests"],
  });

  assert.deepEqual(contract.writableRoots, []);
  assert.equal(contract.authority.commit, null);
  assert.equal(contract.routes.write, null);
  assert.equal(contract.routes.finalize, null);
  assert.equal(contract.routes["git-mutation"], null);

  for (const operation of ["write", "finalize"] as const) {
    const route = routeTaskOperation(contract, operation);
    assert.equal(route.allowed, false);
    if (!route.allowed) {
      assert.equal(route.code, "read-only");
      assert.equal(route.noBypass, true);
    }
  }

  const gitMutation = routeTaskOperation(contract, "git-mutation");
  assert.equal(gitMutation.allowed, false);
  if (!gitMutation.allowed) {
    assert.equal(gitMutation.code, "unsupported-operation");
    assert.equal(gitMutation.noBypass, true);
  }
});

test("routes declared checks only and supplies a valid known check ID", () => {
  const contract = buildTaskToolContract({
    activeTools: ["pipeline_task_check"],
    workspaceRoot: "/workspace/task",
    phase: "read-only",
    checkIds: ["check-types", "check-tests"],
  });

  const first = routeTaskOperation(contract, "check");
  assert.equal(first.allowed, true);
  if (first.allowed) {
    assert.equal(first.tool, "pipeline_task_check");
    assert.deepEqual(first.exampleArgs, { checkId: "check-types" });
  }

  const declared = routeTaskOperation(contract, "check", "check-tests");
  assert.equal(declared.allowed, true);
  if (declared.allowed)
    assert.deepEqual(declared.exampleArgs, { checkId: "check-tests" });

  for (const checkId of ["bun run check", "not-declared"]) {
    const route = routeTaskOperation(contract, "check", checkId);
    assert.equal(route.allowed, false);
    if (!route.allowed) {
      assert.equal(route.code, "unknown-check-id");
      assert.equal(route.noBypass, true);
    }
  }

  const noChecks = buildTaskToolContract({
    activeTools: ["pipeline_task_check"],
    workspaceRoot: "/workspace/task",
    phase: "read-only",
    checkIds: [],
  });
  const missingId = routeTaskOperation(noChecks, "check");
  assert.equal(missingId.allowed, false);
  if (!missingId.allowed) assert.equal(missingId.code, "check-id-required");
});

test("blocks generic Git mutation while allowing distinct controller finalization", () => {
  const withoutController = buildTaskToolContract({
    activeTools: ["bash", "read"],
    workspaceRoot: "/workspace/task",
    phase: "implementation",
    checkIds: [],
  });
  const withoutControllerMutation = routeTaskOperation(
    withoutController,
    "git-mutation",
  );
  assert.equal(withoutControllerMutation.allowed, false);
  if (!withoutControllerMutation.allowed) {
    assert.equal(withoutControllerMutation.code, "unsupported-operation");
    assert.equal(withoutControllerMutation.noBypass, true);
  }

  const withController = buildTaskToolContract({
    activeTools: ["bash", "pipeline_task_finalize"],
    workspaceRoot: "/workspace/task",
    phase: "implementation",
    checkIds: [],
  });
  assert.equal(withController.routes["git-mutation"], null);

  const mutation = routeTaskOperation(withController, "git-mutation");
  assert.equal(mutation.allowed, false);
  if (!mutation.allowed) {
    assert.equal(mutation.code, "unsupported-operation");
    assert.equal(mutation.noBypass, true);
  }

  const finalize = routeTaskOperation(withController, "finalize");
  assert.equal(finalize.allowed, true);
  if (finalize.allowed) {
    assert.equal(finalize.tool, "pipeline_task_finalize");
    assert.notEqual(finalize.tool, "bash");
    assert.deepEqual(finalize.exampleArgs, {
      commitPaths: [],
      summary: "Finalize through the controller.",
    });
  }
});

test("uses actual Pi read, write, and edit examples inside the assigned workspace", () => {
  const workspaceRoot = "/workspace/task";
  const contract = buildTaskToolContract({
    activeTools: ["read", "edit", "write"],
    workspaceRoot,
    phase: "implementation",
    checkIds: [],
  });

  const read = routeTaskOperation(contract, "read");
  assert.equal(read.allowed, true);
  if (read.allowed) {
    assert.deepEqual(read.exampleArgs, {
      path: path.join(workspaceRoot, "example.txt"),
    });
    assert.equal(
      path.dirname(path.resolve(String(read.exampleArgs.path))),
      path.resolve(workspaceRoot),
    );
  }

  const write = routeTaskOperation(contract, "write");
  assert.equal(write.allowed, true);
  if (write.allowed) {
    assert.equal(write.tool, "write");
    assert.deepEqual(write.exampleArgs, {
      path: path.join(workspaceRoot, "example.txt"),
      content: "example content\n",
    });
    assert.equal(
      path.dirname(path.resolve(String(write.exampleArgs.path))),
      path.resolve(workspaceRoot),
    );
  }

  const editContract = buildTaskToolContract({
    activeTools: ["edit"],
    workspaceRoot,
    phase: "implementation",
    checkIds: [],
  });
  const edit = routeTaskOperation(editContract, "write");
  assert.equal(edit.allowed, true);
  if (edit.allowed) {
    assert.equal(edit.tool, "edit");
    assert.deepEqual(edit.exampleArgs, {
      path: path.join(workspaceRoot, "example.txt"),
      edits: [{ oldText: "existing text", newText: "updated text" }],
    });
  }

  const outside = routeTaskOperation(contract, "outside-workspace");
  assert.equal(outside.allowed, false);
  if (!outside.allowed) {
    assert.equal(outside.code, "outside-workspace");
    assert.equal(outside.noBypass, true);
  }
});
