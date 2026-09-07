import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createRunArtifactStore,
  RUN_ARTIFACT_MAX_PAGE_BYTES,
} from "./run-artifacts.ts";

function temporaryRoot() {
  return fs.mkdtempSync(path.join(tmpdir(), "pipi-run-artifacts-"));
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runDirectory(rootDir: string, runId: string) {
  return path.join(rootDir, runId);
}

function artifactFile(rootDir: string, runId: string, relativePath: string) {
  return path.join(runDirectory(rootDir, runId), relativePath);
}

test("snapshot writes immutable bytes, manifest metadata, and preserves legacy files", async () => {
  const rootDir = temporaryRoot();
  const runId = "run-snapshot";
  const runDir = runDirectory(rootDir, runId);
  fs.mkdirSync(runDir);
  const legacyPath = path.join(runDir, "run-summary.json");
  fs.writeFileSync(legacyPath, "legacy artifact\n");

  try {
    const store = createRunArtifactStore({ rootDir, runId });
    const entry = await store.writeSnapshot({
      artifactId: "summary",
      schemaVersion: "summary-v1",
      value: { status: "complete", message: "Привет 🌍" },
    });
    const stored = fs.readFileSync(
      artifactFile(rootDir, runId, entry.relativePath),
    );

    assert.equal(entry.revision, 1);
    assert.equal(entry.completeness, "complete");
    assert.equal(entry.bytes, stored.length);
    assert.equal(entry.sha256, digest(stored));
    assert.deepEqual(await store.manifest(), [entry]);
    assert.equal(fs.readFileSync(legacyPath, "utf8"), "legacy artifact\n");

    const page = await store.read({
      artifactId: "summary",
      revision: entry.revision,
      maxBytes: stored.length,
    });
    assert.equal(page.text, stored.toString("utf8"));
    assert.equal(page.revision, entry.revision);
    assert.equal(page.completeness, "complete");
    assert.equal(page.nextCursor, undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("appendEvent creates JSONL revision snapshots and serializes concurrent operations", async () => {
  const rootDir = temporaryRoot();
  const runId = "run-events";
  try {
    const store = createRunArtifactStore({ rootDir, runId });
    const revisions = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.appendEvent({
          artifactId: "timeline",
          schemaVersion: 1,
          event: { sequence: index, text: "событие 🚀" },
        }),
      ),
    );
    assert.deepEqual(
      revisions
        .map((entry) => entry.revision)
        .sort((left, right) => left - right),
      [1, 2, 3, 4, 5, 6],
    );

    const latest = revisions.reduce((left, right) =>
      left.revision > right.revision ? left : right,
    );
    const lines = fs
      .readFileSync(artifactFile(rootDir, runId, latest.relativePath), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number; text: string });
    assert.deepEqual(
      lines.map((event) => event.sequence),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(
      lines.every((event) => event.text === "событие 🚀"),
      true,
    );

    const current = await store.manifest();
    assert.equal(current.length, 1);
    assert.equal(current[0]?.revision, 6);
    assert.notEqual(revisions[0]?.relativePath, current[0]?.relativePath);

    const firstRevision = await store.read({
      artifactId: "timeline",
      revision: 1,
      maxBytes: 1024,
    });
    assert.deepEqual(JSON.parse(firstRevision.text.trim()), {
      sequence: 0,
      text: "событие 🚀",
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("read paginates at UTF-8 boundaries and retains the requested revision", async () => {
  const rootDir = temporaryRoot();
  const runId = "run-utf8";
  try {
    const store = createRunArtifactStore({ rootDir, runId });
    const entry = await store.writeSnapshot({
      artifactId: "unicode",
      schemaVersion: 1,
      value: "Кириллица — Привет — emoji 🌍🚀✨",
    });
    const stored = fs.readFileSync(
      artifactFile(rootDir, runId, entry.relativePath),
    );
    const pages: string[] = [];
    let cursor = 0;
    let pageCount = 0;
    while (true) {
      const page = await store.read({
        artifactId: "unicode",
        revision: entry.revision,
        cursor,
        maxBytes: 5,
      });
      pageCount += 1;
      pages.push(page.text);
      assert.equal(page.revision, entry.revision);
      assert.equal(page.completeness, "complete");
      assert.equal(Buffer.byteLength(page.text, "utf8") <= 5, true);
      if (page.nextCursor === undefined) break;
      assert.ok(page.nextCursor > cursor);
      assert.notEqual(
        (stored[page.nextCursor] ?? 0) & 0xc0,
        0x80,
        `cursor ${page.nextCursor} must point to a UTF-8 code point boundary`,
      );
      cursor = page.nextCursor;
    }

    assert.ok(pageCount > 3);
    assert.equal(pages.join(""), stored.toString("utf8"));
    assert.notEqual(
      (stored[1] ?? 0) & 0xc0,
      0x80,
      "the first byte after the opening JSON quote is a code point boundary",
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("enforces an exact four-byte UTF-8 page budget for Cyrillic and emoji", async () => {
  const rootDir = temporaryRoot();
  const runId = "run-exact-utf8-budget";
  try {
    const store = createRunArtifactStore({ rootDir, runId });
    const value = "Ж🌍";
    const entry = await store.writeSnapshot({
      artifactId: "unicode",
      schemaVersion: 1,
      value,
    });
    const stored = fs.readFileSync(
      artifactFile(rootDir, runId, entry.relativePath),
    );
    const pages: string[] = [];
    const pageBytes: number[] = [];
    let cursor = 0;

    while (true) {
      const page = await store.read({
        artifactId: entry.artifactId,
        revision: entry.revision,
        cursor,
        maxBytes: 4,
      });
      pages.push(page.text);
      const currentPageBytes = Buffer.byteLength(page.text, "utf8");
      pageBytes.push(currentPageBytes);
      assert.ok(currentPageBytes <= 4);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }

    assert.deepEqual(pages, ['"Ж', "🌍", '"\n']);
    assert.deepEqual(pageBytes, [3, 4, 2]);
    assert.equal(pages.join(""), stored.toString("utf8"));
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects traversal IDs, foreign revisions, and invalid byte budgets", async () => {
  assert.equal(RUN_ARTIFACT_MAX_PAGE_BYTES, 64 * 1024);
  const rootDir = temporaryRoot();
  const runId = "run-validation";
  try {
    const store = createRunArtifactStore({ rootDir, runId });
    await assert.rejects(
      store.writeSnapshot({
        artifactId: "../outside",
        schemaVersion: 1,
        value: {},
      }),
      /path separators|traversal/u,
    );
    await assert.rejects(
      store.appendEvent({
        artifactId: "nested\\outside",
        schemaVersion: 1,
        event: {},
      }),
      /path separators|traversal/u,
    );

    const first = await store.writeSnapshot({
      artifactId: "one",
      schemaVersion: 1,
      value: "é",
    });
    await store.appendEvent({
      artifactId: "two",
      schemaVersion: 1,
      event: { n: 1 },
    });
    await store.appendEvent({
      artifactId: "two",
      schemaVersion: 1,
      event: { n: 2 },
    });
    await assert.rejects(
      store.read({ artifactId: "one", revision: 2, maxBytes: 100 }),
      /not registered/u,
    );

    for (const maxBytes of [
      0,
      -1,
      3,
      1.5,
      Number.NaN,
      Infinity,
      RUN_ARTIFACT_MAX_PAGE_BYTES + 1,
    ]) {
      await assert.rejects(
        store.read({ artifactId: "one", revision: first.revision, maxBytes }),
        /maxBytes/u,
      );
    }
    await assert.rejects(
      store.read({
        artifactId: "one",
        revision: first.revision,
        cursor: -1,
        maxBytes: 10,
      }),
      /cursor/u,
    );
    await assert.rejects(
      store.read({
        artifactId: "one",
        revision: first.revision,
        cursor: 1.5,
        maxBytes: 10,
      }),
      /cursor/u,
    );
    await assert.rejects(
      store.read({
        artifactId: "one",
        revision: first.revision,
        cursor: 2,
        maxBytes: 10,
      }),
      /UTF-8 code point boundary/u,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("rejects symlinked artifact paths and detects root replacement", async () => {
  const rootDir = temporaryRoot();
  const runId = "run-links";
  const outside = temporaryRoot();
  try {
    const store = createRunArtifactStore({ rootDir, runId });
    const entry = await store.writeSnapshot({
      artifactId: "safe",
      schemaVersion: 1,
      value: { safe: true },
    });
    const artifactDirectory = path.join(rootDir, runId, "artifacts", "safe");
    const savedDirectory = `${artifactDirectory}.saved`;
    fs.renameSync(artifactDirectory, savedDirectory);
    fs.symlinkSync(outside, artifactDirectory, "dir");
    await assert.rejects(
      store.read({
        artifactId: entry.artifactId,
        revision: entry.revision,
        maxBytes: 1024,
      }),
      /symbolic link|missing/u,
    );
    fs.unlinkSync(artifactDirectory);
    fs.renameSync(savedDirectory, artifactDirectory);

    const replacement = `${rootDir}.replacement`;
    fs.renameSync(rootDir, replacement);
    fs.mkdirSync(rootDir);
    await assert.rejects(store.manifest(), /identity changed|replaced/u);

    const symlinkRoot = `${rootDir}.symlink`;
    fs.symlinkSync(replacement, symlinkRoot, "dir");
    assert.throws(
      () => createRunArtifactStore({ rootDir: symlinkRoot, runId }),
      /symbolic link/u,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(`${rootDir}.replacement`, { recursive: true, force: true });
    fs.rmSync(`${rootDir}.symlink`, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects missing and corrupt registered files instead of returning stale evidence", async () => {
  const missingRoot = temporaryRoot();
  const corruptRoot = temporaryRoot();
  try {
    const missingStore = createRunArtifactStore({
      rootDir: missingRoot,
      runId: "run-missing",
    });
    const missingEntry = await missingStore.writeSnapshot({
      artifactId: "artifact",
      schemaVersion: 1,
      value: { ok: true },
    });
    fs.unlinkSync(
      artifactFile(missingRoot, "run-missing", missingEntry.relativePath),
    );
    await assert.rejects(
      missingStore.read({
        artifactId: missingEntry.artifactId,
        revision: missingEntry.revision,
        maxBytes: 100,
      }),
      /missing/u,
    );

    const corruptStore = createRunArtifactStore({
      rootDir: corruptRoot,
      runId: "run-corrupt",
    });
    const corruptEntry = await corruptStore.writeSnapshot({
      artifactId: "artifact",
      schemaVersion: 1,
      value: { ok: true },
    });
    const corruptPath = artifactFile(
      corruptRoot,
      "run-corrupt",
      corruptEntry.relativePath,
    );
    const corruptBytes = fs.readFileSync(corruptPath);
    corruptBytes[0] = corruptBytes[0] === 0x7b ? 0x7d : 0x7b;
    fs.writeFileSync(corruptPath, corruptBytes);
    await assert.rejects(
      corruptStore.read({
        artifactId: corruptEntry.artifactId,
        revision: corruptEntry.revision,
        maxBytes: 100,
      }),
      /byte length|integrity/u,
    );
  } finally {
    fs.rmSync(missingRoot, { recursive: true, force: true });
    fs.rmSync(corruptRoot, { recursive: true, force: true });
  }
});

test("surfaces manifest disk failures without publishing a broken reference", async () => {
  const rootDir = temporaryRoot();
  const runId = "run-disk-error";
  try {
    const runDir = runDirectory(rootDir, runId);
    fs.mkdirSync(runDir);
    fs.mkdirSync(path.join(runDir, "manifest.json"));
    const store = createRunArtifactStore({ rootDir, runId });

    await assert.rejects(
      store.writeSnapshot({
        artifactId: "artifact",
        schemaVersion: 1,
        value: { should: "fail" },
      }),
      /artifact manifest must be a regular file/u,
    );
    await assert.rejects(store.manifest(), /artifact manifest/u);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
