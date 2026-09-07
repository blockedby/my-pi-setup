import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  captureCheckInputRevision,
  type CheckInputRevisionEvidence,
} from "./check-input-revision.ts";

function evidence({
  tracked = [],
  staged = [],
  untracked = [],
  baseToHead = [],
  conflictPaths = [],
}: {
  readonly tracked?: ReadonlyArray<string>;
  readonly staged?: ReadonlyArray<string>;
  readonly untracked?: ReadonlyArray<string>;
  readonly baseToHead?: ReadonlyArray<string>;
  readonly conflictPaths?: ReadonlyArray<string>;
} = {}) {
  return {
    baseToHead,
    tracked,
    staged,
    untracked,
    conflictPaths,
    fingerprint: "a".repeat(64),
  } satisfies CheckInputRevisionEvidence;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-check-input-"));
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("content digest distinguishes dirty tracked and untracked inputs", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, "tracked.txt"), "tracked\n");
    fs.writeFileSync(path.join(repo.root, "untracked.txt"), "untracked\n");
    const first = captureCheckInputRevision({
      workspaceRoot: repo.root,
      head: "head-a",
      evidence: evidence({
        tracked: ["tracked.txt"],
        untracked: ["untracked.txt"],
      }),
    });

    fs.writeFileSync(path.join(repo.root, "untracked.txt"), "changed\n");
    const untrackedChanged = captureCheckInputRevision({
      workspaceRoot: repo.root,
      head: "head-a",
      evidence: evidence({
        tracked: ["tracked.txt"],
        untracked: ["untracked.txt"],
      }),
    });
    assert.notEqual(untrackedChanged.fingerprint, first.fingerprint);

    fs.writeFileSync(path.join(repo.root, "tracked.txt"), "tracked changed\n");
    const trackedChanged = captureCheckInputRevision({
      workspaceRoot: repo.root,
      head: "head-a",
      evidence: evidence({
        tracked: ["tracked.txt"],
        untracked: ["untracked.txt"],
      }),
    });
    assert.notEqual(trackedChanged.fingerprint, untrackedChanged.fingerprint);
  } finally {
    repo.cleanup();
  }
});

test("revision proof fails closed for unsafe, symlinked, unreadable, and oversized inputs", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, "input.txt"), "safe\n");
    assert.throws(
      () =>
        captureCheckInputRevision({
          workspaceRoot: repo.root,
          head: "head-a",
          evidence: evidence({ tracked: ["../outside.txt"] }),
        }),
      /unsafe|oversized/i,
    );

    const target = path.join(repo.root, "target.txt");
    const link = path.join(repo.root, "link.txt");
    fs.writeFileSync(target, "target\n");
    fs.symlinkSync(target, link);
    assert.throws(
      () =>
        captureCheckInputRevision({
          workspaceRoot: repo.root,
          head: "head-a",
          evidence: evidence({ tracked: ["link.txt"] }),
        }),
      /symlink/i,
    );

    const unreadable = path.join(repo.root, "unreadable.txt");
    fs.writeFileSync(unreadable, "unreadable\n");
    fs.chmodSync(unreadable, 0o000);
    try {
      assert.throws(
        () =>
          captureCheckInputRevision({
            workspaceRoot: repo.root,
            head: "head-a",
            evidence: evidence({ tracked: ["unreadable.txt"] }),
          }),
        /not readable/i,
      );
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }

    fs.writeFileSync(path.join(repo.root, "large.txt"), "0123456789");
    assert.throws(
      () =>
        captureCheckInputRevision({
          workspaceRoot: repo.root,
          head: "head-a",
          evidence: evidence({ tracked: ["large.txt"] }),
          maxFileBytes: 4,
        }),
      /exceeds/i,
    );
  } finally {
    repo.cleanup();
  }
});

test("Git metadata and node_modules are excluded from the bounded input digest", () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo.root, ".git"));
    fs.mkdirSync(path.join(repo.root, "node_modules"));
    fs.writeFileSync(path.join(repo.root, ".git", "index"), "metadata-a");
    fs.writeFileSync(
      path.join(repo.root, "node_modules", "large-package.js"),
      "dependency-a",
    );
    const paths = [".git/index", "node_modules/large-package.js"];
    const first = captureCheckInputRevision({
      workspaceRoot: repo.root,
      head: "head-a",
      evidence: evidence({ tracked: paths }),
    });
    fs.writeFileSync(path.join(repo.root, ".git", "index"), "metadata-b");
    fs.writeFileSync(
      path.join(repo.root, "node_modules", "large-package.js"),
      "dependency-b",
    );
    const second = captureCheckInputRevision({
      workspaceRoot: repo.root,
      head: "head-a",
      evidence: evidence({ tracked: paths }),
    });

    assert.deepEqual(first.paths, []);
    assert.equal(first.bytes, 0);
    assert.equal(second.fingerprint, first.fingerprint);
  } finally {
    repo.cleanup();
  }
});
