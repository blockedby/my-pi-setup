import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  PLANNING_READINESS_MAX_EXCERPT_BYTES,
  PLANNING_READINESS_MAX_SOURCE_BYTES,
  PlanningReadinessCheckSchema,
  PlanningReadinessVerifiedCheckSchema,
  type PlanningReadinessCheck,
  verifyPlanningReadinessSource,
} from "./planning-readiness.ts";

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-planning-readiness-"),
  );
  return {
    root,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function digest(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function check(
  source: PlanningReadinessCheck["source"],
  overrides: Partial<Omit<PlanningReadinessCheck, "source">> = {},
) {
  return {
    command: "bun run check",
    cwd: ".",
    purpose: "Verify the repository readiness check.",
    ...overrides,
    source,
  } satisfies PlanningReadinessCheck;
}

test("verifies a package script body and returns an immutable provenance copy", () => {
  const repo = fixture();
  try {
    const contents = '{"scripts":{"check":"bun run check"}}\n';
    const packagePath = path.join(repo.root, "package.json");
    fs.writeFileSync(packagePath, contents);
    const original = check({
      path: "package.json",
      excerpt: '"check":"bun run check"',
    });

    const verified = verifyPlanningReadinessSource(repo.root, original);

    assert.deepEqual(verified, {
      ...original,
      sourceHash: digest(contents),
    });
    assert.deepEqual(original, {
      command: "bun run check",
      cwd: ".",
      purpose: "Verify the repository readiness check.",
      source: {
        path: "package.json",
        excerpt: '"check":"bun run check"',
      },
    });
    assert.equal(
      Value.Check(PlanningReadinessVerifiedCheckSchema, verified),
      true,
    );
    original.source.excerpt = "changed after verification";
    assert.equal(verified.source.excerpt, '"check":"bun run check"');
    assert.throws(
      () =>
        verifyPlanningReadinessSource(
          repo.root,
          check({ path: "package.json", excerpt: " " }, { command: " " }),
        ),
      /must not be blank/,
    );
  } finally {
    repo.cleanup();
  }
});

test("verifies JSON-escaped script bodies without changing the shell command", () => {
  const repo = fixture();
  try {
    const command = 'node -e "process.exit(0)"';
    const contents = JSON.stringify({
      private: true,
      scripts: { check: command },
    });
    fs.writeFileSync(path.join(repo.root, "package.json"), contents);
    const verified = verifyPlanningReadinessSource(
      repo.root,
      check({ path: "package.json", excerpt: contents }, { command }),
    );
    assert.equal(verified.command, command);
    assert.throws(
      () =>
        verifyPlanningReadinessSource(
          repo.root,
          check(
            { path: "package.json", excerpt: contents },
            { command: "true" },
          ),
        ),
      /exact command/,
    );
  } finally {
    repo.cleanup();
  }
});

test("verifies an exact command excerpt from a Markdown source", () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo.root, "docs"));
    fs.writeFileSync(
      path.join(repo.root, "docs", "checks.md"),
      "# Checks\n\nRun `bun run check` before handoff.\n",
    );
    const verified = verifyPlanningReadinessSource(
      repo.root,
      check(
        {
          path: "docs/checks.md",
          excerpt: "Run `bun run check` before handoff.",
        },
        { cwd: "docs", purpose: "Use the documented check command." },
      ),
    );

    assert.equal(verified.cwd, "docs");
    assert.equal(verified.source.path, "docs/checks.md");
    assert.equal(verified.sourceHash.length, 64);
  } finally {
    repo.cleanup();
  }
});

test("rejects source and command mismatches without normalizing either value", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, "checks.md"), "documented body\n");

    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check({ path: "checks.md", excerpt: "documented body" }),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check({ path: "checks.md", excerpt: "missing body" }),
      ),
    );
  } finally {
    repo.cleanup();
  }
});

test("rejects traversal, missing paths, escaping symlinks, and non-directory cwd values", () => {
  const repo = fixture();
  const outside = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, "checks.md"), "bun run check\n");
    fs.writeFileSync(path.join(outside.root, "outside.md"), "bun run check\n");
    fs.symlinkSync(
      path.join(outside.root, "outside.md"),
      path.join(repo.root, "escaping-source.md"),
    );
    fs.symlinkSync(outside.root, path.join(repo.root, "escaping-cwd"), "dir");

    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check({ path: "../outside.md", excerpt: "bun run check" }),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check({ path: "missing.md", excerpt: "bun run check" }),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check({ path: "escaping-source.md", excerpt: "bun run check" }),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check(
          { path: "checks.md", excerpt: "bun run check" },
          {
            cwd: "escaping-cwd",
          },
        ),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check(
          { path: "checks.md", excerpt: "bun run check" },
          {
            cwd: "checks.md",
          },
        ),
      ),
    );
  } finally {
    repo.cleanup();
    outside.cleanup();
  }
});

test("enforces strict field and source byte bounds", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo.root, "checks.md"), "bun run check\n");
    const valid = check({ path: "checks.md", excerpt: "bun run check" });

    assert.equal(
      Value.Check(PlanningReadinessCheckSchema, {
        ...valid,
        source: {
          ...valid.source,
          excerpt: "x".repeat(PLANNING_READINESS_MAX_EXCERPT_BYTES + 1),
        },
      }),
      false,
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(repo.root, {
        ...valid,
        purpose: "x".repeat(2049),
      }),
    );

    fs.writeFileSync(
      path.join(repo.root, "oversized.md"),
      Buffer.alloc(PLANNING_READINESS_MAX_SOURCE_BYTES + 1, 0x78),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(repo.root, {
        ...valid,
        source: { path: "oversized.md", excerpt: "x" },
      }),
    );

    assert.equal(
      Value.Check(PlanningReadinessCheckSchema, {
        ...valid,
        unexpected: true,
      }),
      false,
    );
  } finally {
    repo.cleanup();
  }
});
