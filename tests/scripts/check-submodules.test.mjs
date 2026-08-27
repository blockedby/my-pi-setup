import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const checkScript = join(repositoryRoot, "scripts", "check-submodules.mjs");

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const initializeRepository = (root) => {
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Pipi Test"]);
  git(root, ["config", "user.email", "pipi-test@example.invalid"]);
};

const createFixture = async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pipi-submodule-check-"));
  const source = join(fixture, "reviewer-source");
  const root = join(fixture, "host");
  const submodulePath = "vendor/reviewer";
  const sourceSkill = join(source, "skills", "code-review", "SKILL.md");

  mkdirSync(dirname(sourceSkill), { recursive: true });
  writeFileSync(
    sourceSkill,
    "---\nname: code-review\ndescription: Test reviewer.\n---\n",
  );
  writeJson(join(source, "package.json"), { name: "reviewer-tools" });
  initializeRepository(source);
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "reviewer source"]);

  mkdirSync(root, { recursive: true });
  initializeRepository(root);
  writeJson(join(root, "package.json"), {
    pi: { skills: ["./skills", "./vendor/reviewer/skills"] },
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "host"]);
  git(root, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    "reviewer",
    "-b",
    "main",
    source,
    submodulePath,
  ]);

  mkdirSync(join(root, "config"), { recursive: true });
  writeJson(join(root, "config", "submodules.json"), {
    submodules: {
      reviewer: {
        path: submodulePath,
        gitmodulesName: "reviewer",
        url: source,
        branch: "main",
        requiredFiles: ["package.json", "skills/code-review/SKILL.md"],
        piPackageName: "reviewer-tools",
        piSkillPath: "./vendor/reviewer/skills",
        replacesHostPaths: ["skills/code-review"],
      },
    },
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "add reviewer submodule"]);
  return {
    fixture,
    root,
    source,
    submodule: join(root, submodulePath),
    sourceSkill,
  };
};

const runChecker = (root) =>
  spawnSync(process.execPath, [checkScript], {
    cwd: root,
    env: { ...process.env, PIPI_SUBMODULE_ROOT: root },
    encoding: "utf8",
  });

const withFixture = async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.fixture, { recursive: true, force: true }));
  return fixture;
};

test("submodule checker accepts an initialized exact gitlink", async (t) => {
  const { root } = await withFixture(t);
  const result = runChecker(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /valid submodule reviewer/);
});

test("submodule checker rejects tracked and untracked child drift", async (t) => {
  const { root, submodule } = await withFixture(t);
  const skill = join(submodule, "skills", "code-review", "SKILL.md");

  writeFileSync(skill, `${readFileSync(skill, "utf8")}drift\n`);
  let result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct worktree changes/);

  git(submodule, ["restore", "."]);
  writeFileSync(join(submodule, "untracked.txt"), "drift\n");
  result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct worktree changes/);
});

test("submodule checker rejects an uninitialized child", async (t) => {
  const { root } = await withFixture(t);
  git(root, ["submodule", "deinit", "-f", "vendor/reviewer"]);
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not initialized/);
});

test("submodule checker rejects worktree and gitlink mismatch", async (t) => {
  const { root, source, submodule, sourceSkill } = await withFixture(t);
  writeFileSync(sourceSkill, `${readFileSync(sourceSkill, "utf8")}next\n`);
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "advance source"]);
  git(submodule, ["fetch", "origin", "main"]);
  git(submodule, ["checkout", "-q", "FETCH_HEAD"]);

  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /worktree is at .* expected/);
});

test("submodule checker rejects .gitmodules metadata mismatch", async (t) => {
  const { root } = await withFixture(t);
  const configPath = join(root, "config", "submodules.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.submodules.reviewer.url = "https://example.invalid/reviewer.git";
  writeJson(configPath, config);

  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /URL does not match \.gitmodules/);
});

test("submodule checker rejects a package name mismatch", async (t) => {
  const { root } = await withFixture(t);
  const configPath = join(root, "config", "submodules.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.submodules.reviewer.piPackageName = "wrong-package";
  writeJson(configPath, config);

  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /package name is reviewer-tools; expected wrong-package/,
  );
});

test("submodule checker rejects a missing manifest skill path", async (t) => {
  const { root } = await withFixture(t);
  writeJson(join(root, "package.json"), { pi: { skills: ["./skills"] } });
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package.json must load/);
});

test("submodule checker rejects a duplicate manifest skill path", async (t) => {
  const { root } = await withFixture(t);
  const packagePath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  manifest.pi.skills.push("./vendor/reviewer/skills");
  writeJson(packagePath, manifest);
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly once; found 2/);
});

test("submodule checker rejects a duplicate host skill", async (t) => {
  const { root } = await withFixture(t);
  mkdirSync(join(root, "skills", "code-review"), { recursive: true });
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /replace duplicate host path/);
});
