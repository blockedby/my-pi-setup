import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  const backlogSource = join(fixture, "backlog-source");
  const root = join(fixture, "host");
  const submodulePath = "vendor/reviewer";
  const backlogPath = "vendor/backlog";
  const sourceSkill = join(source, "skills", "code-review", "SKILL.md");
  const backlogSkill = join(backlogSource, "SKILL.md");

  mkdirSync(dirname(sourceSkill), { recursive: true });
  writeFileSync(
    sourceSkill,
    "---\nname: code-review\ndescription: Test reviewer.\n---\n",
  );
  writeJson(join(source, "package.json"), { name: "reviewer-tools" });
  initializeRepository(source);
  git(source, ["add", "."]);
  git(source, ["commit", "-qm", "reviewer source"]);

  mkdirSync(dirname(backlogSkill), { recursive: true });
  writeFileSync(
    backlogSkill,
    "---\nname: plan-gh-backlog\ndescription: Test backlog.\n---\n",
  );
  initializeRepository(backlogSource);
  git(backlogSource, ["add", "."]);
  git(backlogSource, ["commit", "-qm", "backlog source"]);

  mkdirSync(root, { recursive: true });
  initializeRepository(root);
  writeJson(join(root, "package.json"), {
    pi: { skills: ["./skills", `./${backlogPath}`] },
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "host"]);
  for (const [name, sourcePath, path] of [
    ["reviewer", source, submodulePath],
    ["backlog", backlogSource, backlogPath],
  ]) {
    git(root, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--name",
      name,
      "-b",
      "main",
      sourcePath,
      path,
    ]);
  }

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
        nonDiscoveredSkillPath: "./vendor/reviewer/skills",
        replacesHostPaths: ["skills/code-review"],
      },
      backlog: {
        path: backlogPath,
        gitmodulesName: "backlog",
        url: backlogSource,
        branch: "main",
        requiredFiles: ["SKILL.md"],
        piSkillPath: `./${backlogPath}`,
        replacesHostPaths: ["skills/plan-gh-backlog"],
      },
    },
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "add reviewer and backlog submodules"]);
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

test("submodule checker accepts a retained non-discovered reviewer without manifest exposure", async (t) => {
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

test("submodule checker accepts a retained non-discovered submodule without a manifest skill path", async (t) => {
  const { root } = await withFixture(t);
  writeJson(join(root, "package.json"), {
    pi: { skills: ["./skills", "./vendor/backlog"] },
  });
  const result = runChecker(root);
  assert.equal(result.status, 0, result.stderr);
});

test("submodule checker rejects reintroduced non-discovered reviewer exposure", async (t) => {
  const { root } = await withFixture(t);
  const packagePath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  manifest.pi.skills.push("./vendor/reviewer/skills");
  writeJson(packagePath, manifest);
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
});

test("submodule checker rejects ancestor and glob exposure of a non-discovered reviewer", async (t) => {
  const { root } = await withFixture(t);
  const packagePath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));

  for (const skillPath of [".", "./vendor/reviewer", "./vendor/*/skills"]) {
    manifest.pi.skills = [skillPath, "./vendor/backlog"];
    writeJson(packagePath, manifest);
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
  }
});

test("submodule checker rejects a symlink alias exposing a non-discovered reviewer", async (t) => {
  const { root } = await withFixture(t);
  const aliasPath = join(root, "reviewer-skills-alias");
  symlinkSync(join(root, "vendor", "reviewer", "skills"), aliasPath, "dir");

  const packagePath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  manifest.pi.skills = ["./reviewer-skills-alias", "./vendor/backlog"];
  writeJson(packagePath, manifest);

  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not expose/);
});

test("submodule checker keeps exactly-one piSkillPath enforcement for backlog entries", async (t) => {
  const { root } = await withFixture(t);
  const configPath = join(root, "config", "submodules.json");
  const packagePath = join(root, "package.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  const backlogPath = config.submodules.backlog.piSkillPath;
  manifest.pi.skills = ["./skills"];
  writeJson(packagePath, manifest);

  let result = runChecker(root);
  assert.notEqual(result.status, 0);

  manifest.pi.skills.push(backlogPath);
  writeJson(packagePath, manifest);
  result = runChecker(root);
  assert.equal(result.status, 0, result.stderr);

  manifest.pi.skills.push(backlogPath);
  writeJson(packagePath, manifest);
  result = runChecker(root);
  assert.notEqual(result.status, 0);
});

test("submodule checker rejects a duplicate host skill", async (t) => {
  const { root } = await withFixture(t);
  mkdirSync(join(root, "skills", "code-review"), { recursive: true });
  const result = runChecker(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /replace duplicate host path/);
});
