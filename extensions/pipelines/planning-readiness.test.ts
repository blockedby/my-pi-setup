import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  cleanupFeatureSandboxRuntime,
  runFeatureSandboxCommand,
} from "./feature-sandbox.ts";
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

test("verifies exact bare package script invocations for supported runners", () => {
  const repo = fixture();
  try {
    const contents = '{\n  "scripts": {\n    "lint": "eslint"\n  }\n}\n';
    fs.writeFileSync(path.join(repo.root, "package.json"), contents);
    const source = {
      path: "package.json",
      excerpt: '    "lint": "eslint"',
    };

    for (const runner of ["bun", "npm", "pnpm", "yarn"]) {
      const verified = verifyPlanningReadinessSource(
        repo.root,
        check(source, { command: `${runner} run lint` }),
      );
      assert.equal(verified.command, `${runner} run lint`);
      assert.equal(verified.sourceHash, digest(contents));
      assert.equal(
        Value.Check(PlanningReadinessVerifiedCheckSchema, verified),
        true,
      );
    }

    const nestedCwd = path.join(repo.root, "packages", "app");
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(path.join(nestedCwd, "package.json"), contents);
    const nestedVerified = verifyPlanningReadinessSource(
      repo.root,
      check(
        {
          path: "packages/app/package.json",
          excerpt: source.excerpt,
        },
        { command: "bun run lint", cwd: "packages/app" },
      ),
    );
    assert.equal(nestedVerified.sourceHash, digest(contents));
  } finally {
    repo.cleanup();
  }
});

test("rejects missing scripts, foreign cwd, and unrelated package excerpts", () => {
  const repo = fixture();
  try {
    const contents =
      '{\n  "description": "bun run lint",\n  "scripts": {\n    "lint": "eslint",\n    "other": "bun run lint"\n  }\n}\n';
    fs.writeFileSync(path.join(repo.root, "package.json"), contents);
    fs.mkdirSync(path.join(repo.root, "other"));

    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check(
          { path: "package.json", excerpt: '    "lint": "eslint"' },
          { command: "bun run missing" },
        ),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check(
          { path: "package.json", excerpt: '    "lint": "eslint"' },
          { command: "bun run lint", cwd: "other" },
        ),
      ),
    );
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check(
          {
            path: "package.json",
            excerpt: '  "description": "bun run lint"',
          },
          { command: "bun run lint" },
        ),
      ),
    );
    // This is a real exact script body, not the new inferred runner route.
    const exactBody = verifyPlanningReadinessSource(
      repo.root,
      check(
        {
          path: "package.json",
          excerpt: '    "other": "bun run lint"',
        },
        { command: "bun run lint" },
      ),
    );
    assert.equal(exactBody.command, "bun run lint");

    const nonStringContents = '{"scripts":{"lint":false}}\n';
    fs.writeFileSync(path.join(repo.root, "package.json"), nonStringContents);
    assert.throws(() =>
      verifyPlanningReadinessSource(
        repo.root,
        check(
          { path: "package.json", excerpt: '"lint":false' },
          { command: "bun run lint" },
        ),
      ),
    );
  } finally {
    repo.cleanup();
  }
});

test("rejects arguments, flags, and shell chains for bare package invocations", () => {
  const repo = fixture();
  try {
    fs.writeFileSync(
      path.join(repo.root, "package.json"),
      '{"scripts":{"lint":"eslint"}}\n',
    );
    const source = {
      path: "package.json",
      excerpt: '"lint":"eslint"',
    };
    for (const command of [
      "bun run lint --watch",
      "bun run --silent lint",
      "bun run lint && echo unexpected",
      "bun run lint; echo unexpected",
    ]) {
      assert.throws(() =>
        verifyPlanningReadinessSource(repo.root, check(source, { command })),
      );
    }
  } finally {
    repo.cleanup();
  }
});

test("preserves exact script bodies that are themselves runner invocations", () => {
  const repo = fixture();
  try {
    const contents = '{"scripts":{"verify":"bun run check"}}\n';
    fs.writeFileSync(path.join(repo.root, "package.json"), contents);
    const verified = verifyPlanningReadinessSource(
      repo.root,
      check({ path: "package.json", excerpt: '"verify":"bun run check"' }),
    );
    assert.equal(verified.command, "bun run check");
    assert.equal(verified.sourceHash, digest(contents));
  } finally {
    repo.cleanup();
  }
});

test("matches escaped script keys and values in pretty JSON", () => {
  const repo = fixture();
  try {
    const escapedValue = JSON.stringify('node -e "process.exit(23)"');
    const contents = `{
  "scripts": {
    "li\\u006et": ${escapedValue}
  }
}\n`;
    fs.writeFileSync(path.join(repo.root, "package.json"), contents);
    const verified = verifyPlanningReadinessSource(
      repo.root,
      check(
        {
          path: "package.json",
          excerpt: `    "li\\u006et": ${escapedValue}`,
        },
        { command: "bun run lint" },
      ),
    );
    assert.equal(verified.sourceHash, digest(contents));
  } finally {
    repo.cleanup();
  }
});

test("executes a verified bun script through its local binary and preserves failure", async () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo.root, "node_modules", ".bin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repo.root, "node_modules", ".bin", "lint"),
      "#!/bin/sh\nexit 37\n",
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(repo.root, "package.json"),
      '{"scripts":{"lint":"lint"}}\n',
    );
    const verified = verifyPlanningReadinessSource(
      repo.root,
      check(
        { path: "package.json", excerpt: '"lint":"lint"' },
        {
          command: "bun run lint",
        },
      ),
    );
    const result = await runFeatureSandboxCommand({
      workspaceRoot: repo.root,
      cwd: verified.cwd,
      command: verified.command,
    });
    assert.equal(result.exitCode, 37, result.stderr);
  } finally {
    cleanupFeatureSandboxRuntime(repo.root);
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
