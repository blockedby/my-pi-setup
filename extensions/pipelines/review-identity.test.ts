import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  captureReviewIdentity,
  REVIEW_IDENTITY_MAX_FILE_BYTES,
  REVIEW_IDENTITY_SCOPE,
} from "./review-identity.ts";

function git(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-review-identity-"));
  fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Pipi Test"]);
  git(root, ["config", "user.email", "pipi@example.invalid"]);
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-qm", "baseline"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  return {
    root,
    base,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function available(value: ReturnType<typeof captureReviewIdentity>) {
  assert.equal(value.state, "available");
  return value.identity;
}

test("dirty tracked content changes the digest without changing HEAD", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, "tracked.txt"), "dirty-a\n");
    const first = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 1,
      }),
    );

    fs.writeFileSync(path.join(repo.root, "tracked.txt"), "dirty-b\n");
    const second = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 1,
      }),
    );

    assert.equal(first.head, second.head);
    assert.notEqual(first.diffDigest, second.diffDigest);
  } finally {
    repo.cleanup();
  }
});

test("editing an untracked file with the same name changes the digest", () => {
  const repo = fixture();
  try {
    const untracked = path.join(repo.root, "new.txt");
    fs.writeFileSync(untracked, "untracked-a\n");
    const first = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 2,
      }),
    );

    fs.writeFileSync(untracked, "untracked-b\n");
    const second = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 2,
      }),
    );

    assert.equal(first.head, second.head);
    assert.notEqual(first.diffDigest, second.diffDigest);
  } finally {
    repo.cleanup();
  }
});

test("a clean worktree has a stable immutable identity", () => {
  const repo = fixture();
  try {
    const firstResult = captureReviewIdentity({
      workingDir: repo.root,
      base: repo.base,
      revision: 3,
    });
    const first = available(firstResult);
    const second = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 3,
      }),
    );

    assert.deepEqual(first, second);
    const sourceSnapshot = { ...first };
    fs.writeFileSync(
      path.join(repo.root, "tracked.txt"),
      "changed-after-capture\n",
    );
    assert.deepEqual(first, sourceSnapshot);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(firstResult), true);
    assert.equal(Reflect.set(first, "head", "changed"), false);
    assert.equal(first.head, repo.base);
  } finally {
    repo.cleanup();
  }
});

test("an invalid repository fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-review-invalid-"));
  try {
    const result = captureReviewIdentity({
      workingDir: root,
      base: "HEAD",
      revision: 0,
    });
    assert.equal(result.state, "unavailable");
    assert.notEqual(result.reason.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignored dependencies stay outside code identity", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, ".gitignore"), "node_modules/\n");
    const dependency = path.join(
      repo.root,
      "node_modules",
      "dependency",
      "index.js",
    );
    fs.mkdirSync(path.dirname(dependency), { recursive: true });
    fs.writeFileSync(dependency, "dependency-a\n");

    const untracked = path.join(repo.root, "new.txt");
    fs.writeFileSync(untracked, "untracked-a\n");
    const firstResult = captureReviewIdentity({
      workingDir: repo.root,
      base: repo.base,
      revision: 0,
    });
    assert.equal(firstResult.state, "available");
    assert.equal(firstResult.scope, REVIEW_IDENTITY_SCOPE);
    const first = available(firstResult);

    fs.writeFileSync(dependency, "dependency-b\n");
    const ignoredMutation = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 0,
      }),
    );
    assert.deepEqual(ignoredMutation, first);

    fs.writeFileSync(untracked, "untracked-b\n");
    const second = available(
      captureReviewIdentity({
        workingDir: repo.root,
        base: repo.base,
        revision: 0,
      }),
    );
    assert.equal(second.head, first.head);
    assert.notEqual(second.diffDigest, first.diffDigest);
  } finally {
    repo.cleanup();
  }
});

test("untracked symlinks fail closed without following their target", () => {
  const repo = fixture();
  const outsideRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-review-identity-outside-"),
  );
  const outside = path.join(outsideRoot, "outside.txt");
  try {
    fs.writeFileSync(outside, "outside\n");
    fs.symlinkSync(outside, path.join(repo.root, "link.txt"));
    const result = captureReviewIdentity({
      workingDir: repo.root,
      base: repo.base,
      revision: 0,
    });
    assert.equal(result.state, "unavailable");
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("oversized untracked content fails closed", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(
      path.join(repo.root, "large.txt"),
      Buffer.alloc(REVIEW_IDENTITY_MAX_FILE_BYTES + 1, 0x61),
    );
    const result = captureReviewIdentity({
      workingDir: repo.root,
      base: repo.base,
      revision: 0,
    });
    assert.equal(result.state, "unavailable");
  } finally {
    repo.cleanup();
  }
});
