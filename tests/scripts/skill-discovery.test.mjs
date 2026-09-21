import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertSelectedSkillIdentities,
  discoverInstalledSkills,
} from "../../scripts/skill-discovery.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

const writeSkill = (path, name) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n\n# ${name}\n`,
  );
};

const writePackage = (path, skills = ["./skills"]) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "package.json"),
    `${JSON.stringify({ name: "fixture-package", pi: { skills } }, null, 2)}\n`,
  );
};

test("reports real discovery collisions separately from same-realpath aliases", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipi-skill-discovery-"));
  try {
    const home = join(root, "home");
    const agentDir = join(home, ".pipi", "agent");
    const shared = join(home, ".agents", "skills", "browser-chrome");
    const collisionPackage = join(root, "collision-package");
    const aliasPackage = join(root, "alias-package");
    const cwd = join(root, "project");

    writeSkill(shared, "browser-chrome");
    writePackage(collisionPackage);
    writeSkill(
      join(collisionPackage, "skills", "browser-chrome"),
      "browser-chrome",
    );
    writePackage(aliasPackage, ["./browser-alias"]);
    symlinkSync(shared, join(aliasPackage, "browser-alias"));
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const collision = await discoverInstalledSkills({
      home,
      agentDir,
      cwd,
      settings: { packages: [collisionPackage] },
      repositoryRoot,
    });
    assert.equal(collision.collisions.length, 1);
    assert.equal(collision.collisions[0].name, "browser-chrome");
    assert.notEqual(
      collision.collisions[0].winnerRealPath,
      collision.collisions[0].loserRealPath,
    );
    assert.throws(
      () =>
        assertSelectedSkillIdentities({
          discovery: collision,
          expected: { "browser-chrome": shared },
        }),
      /implementations collide/,
    );

    const alias = await discoverInstalledSkills({
      home,
      agentDir,
      cwd,
      settings: { packages: [aliasPackage] },
      repositoryRoot,
    });
    assert.deepEqual(alias.collisions, []);
    const aliases = alias.aliases.find(({ name }) => name === "browser-chrome");
    assert.ok(aliases);
    assert.equal(aliases.paths.length, 2);
    assertSelectedSkillIdentities({
      discovery: alias,
      expected: { "browser-chrome": shared },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses Pi package filters, settings paths, and trusted ancestor discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "pipi-skill-sources-"));
  try {
    const home = join(root, "home");
    const agentDir = join(home, ".pipi", "agent");
    const project = join(root, "project");
    const cwd = join(project, "nested", "work");
    const packageRoot = join(root, "filtered-package");
    const explicit = join(root, "explicit-skill");

    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeSkill(
      join(project, ".agents", "skills", "ancestor-skill"),
      "ancestor-skill",
    );
    writeSkill(explicit, "settings-skill");
    writePackage(packageRoot);
    writeSkill(join(packageRoot, "skills", "included"), "included-skill");
    writeSkill(join(packageRoot, "skills", "excluded"), "excluded-skill");

    const discovery = await discoverInstalledSkills({
      home,
      agentDir,
      cwd,
      settings: {
        skills: [explicit],
        packages: [
          {
            source: packageRoot,
            skills: ["skills/included/SKILL.md"],
          },
        ],
      },
      repositoryRoot,
    });
    const selectedNames = discovery.selected.map(({ name }) => name);
    assert.equal(selectedNames.includes("included-skill"), true);
    assert.equal(selectedNames.includes("excluded-skill"), false);
    assert.equal(selectedNames.includes("settings-skill"), true);
    assert.equal(selectedNames.includes("ancestor-skill"), true);
    assert.equal(
      discovery.identities.some(({ paths }) =>
        paths.includes(join(explicit, "SKILL.md")),
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
