import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  goalIdentity,
  goalDependencyPaths,
  normalizeGoalPackage,
  validateGoalPackage,
} from "../../scripts/goal-package.mjs";
import { readBunLock } from "../../scripts/pipi-version.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
test("unchanged Goal and complete dependencies are pinned and validated in both runtimes", () => {
  for (const directory of [root, join(root, "config/pipi-runtime")]) {
    const manifest = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8"),
    );
    assert.equal(
      (manifest.devDependencies ?? manifest.dependencies)[goalIdentity.name],
      goalIdentity.version,
    );
    const packages = readBunLock(join(directory, "bun.lock")).packages;
    assert.equal(
      packages[goalIdentity.name][0],
      `${goalIdentity.name}@${goalIdentity.version}`,
    );
    assert.equal(packages[goalIdentity.name][3], goalIdentity.integrity);
    for (const [name, version] of Object.entries(goalIdentity.dependencies)) {
      const key =
        name === "highlight.js" ? "@narumitw/pi-tui-kit/highlight.js" : name;
      assert.equal(packages[key][0], `${name}@${version}`);
      assert.ok(packages[key][3].startsWith("sha512-"));
    }
    if (directory === root)
      assert.equal(
        validateGoalPackage(directory),
        join(directory, "node_modules", goalIdentity.name),
      );
  }
});

test("Goal source normalization preserves unrelated packages and monorepo resources", () => {
  const home = mkdtempSync(join(tmpdir(), "pipi-goal-normalize-"));
  try {
    const agentDir = join(home, "agent");
    const desiredPath = join(
      agentDir,
      "runtime/node_modules/@narumitw/pi-goal",
    );
    const old = join(home, "old-copy");
    mkdirSync(old);
    writeFileSync(
      join(old, "package.json"),
      JSON.stringify({ name: goalIdentity.name }),
    );
    symlinkSync(old, join(home, "old-link"));
    const unrelated = {
      source: "npm:@narumitw/pi-plan-mode",
      extensions: ["!private/**"],
      skills: [],
    };
    const monorepo = {
      source:
        "git:git+https://github.com/narumiruna/pi-extensions.git#reviewed",
      extensions: ["packages/pi-plan-mode/**", "packages/pi-goal/**"],
      themes: [],
    };
    const normalize = (packages) =>
      normalizeGoalPackage({
        packages,
        desiredPath,
        settingsBaseDir: agentDir,
        home,
      });
    const normalized = normalize([
      unrelated,
      "npm:@narumitw/pi-goal",
      { source: "npm:@narumitw/pi-goal@0.54.7", extensions: [] },
      old,
      join(old, "dist/index.ts"),
      join(home, "old-link"),
      "npm/node_modules/@narumitw/pi-goal",
      "~/agent/runtime/node_modules/@narumitw/pi-goal",
      { source: desiredPath, extensions: [] },
      monorepo,
    ]);
    assert.deepEqual(normalized, [
      unrelated,
      {
        ...monorepo,
        extensions: [...monorepo.extensions, "!packages/pi-goal/**"],
      },
      desiredPath,
    ]);
    assert.deepEqual(normalize(normalized), normalized);
    const disabled = {
      source: monorepo.source,
      extensions: [],
      skills: ["!private/**"],
    };
    assert.deepEqual(normalize([disabled]), [disabled, desiredPath]);
    assert.deepEqual(
      normalize([
        "git:https://github.com/someone/pi-extensions",
        "npm:@narumitw/pi-goal-other",
      ]),
      [
        "git:https://github.com/someone/pi-extensions",
        "npm:@narumitw/pi-goal-other",
        desiredPath,
      ],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("package integrity refuses corrupt bytes, missing entries and external chunk directories", () => {
  for (const failure of ["corrupt", "missing", "linked-chunks"]) {
    const prefix = mkdtempSync(join(tmpdir(), "pipi-goal-integrity-"));
    const directory = join(prefix, "node_modules", goalIdentity.name);
    try {
      cpSync(join(root, "node_modules", goalIdentity.name), directory, {
        recursive: true,
        dereference: true,
      });
      if (failure === "corrupt")
        writeFileSync(join(directory, "dist/index.ts"), "// corrupt");
      if (failure === "missing") rmSync(join(directory, "dist/index.ts"));
      if (failure === "linked-chunks") {
        rmSync(join(directory, "dist/chunks"), { recursive: true });
        symlinkSync(
          join(root, "node_modules", goalIdentity.name, "dist/chunks"),
          join(directory, "dist/chunks"),
        );
      }
      assert.throws(
        () => validateGoalPackage(prefix),
        /Invalid isolated @narumitw\/pi-goal/,
      );
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  }
});

for (const scenario of [
  "completion",
  "pause",
  "clear",
  "cap",
  "tool-cap",
  "unlimited",
  "unlimited-repeat",
  "long-plan",
  "no-progress",
  "persistence",
  "coexist",
  "production",
  "quota",
  "budget",
  "stale-pause",
  "stale-clear",
]) {
  test(
    `real Pi 1.0.3 autonomous Goal lifecycle: ${scenario}`,
    { timeout: scenario === "long-plan" ? 45000 : 25000 },
    () => {
      const output = execFileSync(
        process.execPath,
        [
          join(root, "tests/scripts/fixtures/goal-sdk-probe.mjs"),
          join(root, "node_modules", goalIdentity.name),
          scenario,
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: scenario === "long-plan" ? 45000 : 25000,
        },
      );
      const result = JSON.parse(output.trim().split("\n").at(-1));
      assert.equal(result.passed, true);
      assert.equal(result.networkRequests, 0);
      assert.equal(result.authUnchanged, true);
      if (["unlimited", "unlimited-repeat"].includes(scenario))
        assert.ok(result.automaticResponses > 25);
      if (scenario === "long-plan") {
        assert.equal(result.automaticResponses, 1125);
        assert.equal(result.workStages, 1125);
        assert.equal(result.humanMessages, 2);
      }
    },
  );
}

test("real Pi filters cannot force-include a duplicate monorepo Goal", () => {
  const output = execFileSync(
    process.execPath,
    [join(root, "tests/scripts/fixtures/goal-filter-probe.mjs")],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  const result = JSON.parse(output.trim());
  assert.equal(result.passed, true);
  assert.equal(result.cases, 4);
  assert.equal(result.canonicalGoalEntries, 1);
  assert.equal(result.unrelatedResourcesPreserved, true);
  assert.equal(result.networkRequests, 0);
});

test("isolated validation refuses externally linked package/dependency graphs", () => {
  const prefix = mkdtempSync(join(tmpdir(), "pipi-goal-dependencies-"));
  try {
    const modules = join(prefix, "node_modules");
    const dependencies = {
      ...goalDependencyPaths(root),
      [goalIdentity.name]: join(root, "node_modules", goalIdentity.name),
    };
    for (const [name, directory] of Object.entries(dependencies)) {
      if (name === "highlight.js") continue; // resolved from the immutable kit dependency graph
      const target = join(modules, name);
      mkdirSync(join(target, ".."), { recursive: true });
      symlinkSync(directory, target);
    }
    assert.throws(() => validateGoalPackage(prefix), /escapes isolated prefix/);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});
