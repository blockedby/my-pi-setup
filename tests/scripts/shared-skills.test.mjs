import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  readlinkSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateLegacySharedSkills,
  reportStaleExplicitSkillSettings,
} from "../../scripts/shared-skills.mjs";

test("adoption preserves configuration bytes, absence, and skill link without following it", () => {
  const home = mkdtempSync(join(tmpdir(), "pipi-shared-backup-"));
  try {
    const agent = join(home, ".pipi", "agent");
    mkdirSync(join(agent, "skills"), { recursive: true });
    const shared = join(home, "developer skill");
    mkdirSync(shared);
    writeFileSync(join(shared, "SKILL.md"), "user-owned content\n");
    symlinkSync(shared, join(agent, "skills", "frontend-quality"));
    const settings = '{ "unrelated": true }\n';
    writeFileSync(join(agent, "settings.json"), settings);
    const result = migrateLegacySharedSkills({
      stagedAgentDir: agent,
      adopt: true,
    });
    assert.deepEqual(result.adopted, ["frontend-quality"]);
    assert.equal(
      readlinkSync(join(result.backupRoot, "frontend-quality")),
      shared,
    );
    assert.equal(
      readFileSync(join(shared, "SKILL.md"), "utf8"),
      "user-owned content\n",
    );
    assert.equal(
      readFileSync(
        join(result.backupRoot, "configuration", "settings.json"),
        "utf8",
      ),
      settings,
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(result.backupRoot, "configuration", "absence.json"),
          "utf8",
        ),
      ),
      ["mcp.json"],
    );
    assert.equal(existsSync(join(agent, "skills", "frontend-quality")), false);
    assert.deepEqual(
      migrateLegacySharedSkills({ stagedAgentDir: agent, adopt: true }).adopted,
      [],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing explicit paths are reported independently without mutating settings", () => {
  const home = mkdtempSync(join(tmpdir(), "pipi-stale-skills-"));
  try {
    const agent = join(home, ".pipi", "agent");
    const present = join(home, "present");
    mkdirSync(present);
    const stale = "~/missing/explanatory-html-pages";
    const settings = {
      skills: [present, stale],
      unrelated: { retained: true },
    };
    const before = JSON.stringify(settings);
    assert.deepEqual(
      reportStaleExplicitSkillSettings({ settings, agentDir: agent }),
      [stale],
    );
    assert.equal(JSON.stringify(settings), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const boundary of [
  "skills",
  "backups",
  "backups/shared-skill-migration-v1",
]) {
  test(`migration refuses external ${boundary} directory links`, () => {
    const home = mkdtempSync(join(tmpdir(), "pipi-boundary-"));
    try {
      const agent = join(home, "agent");
      const external = join(home, "external");
      mkdirSync(join(agent, "skills", "frontend-quality"), { recursive: true });
      mkdirSync(external);
      writeFileSync(join(external, "sentinel"), "untouched");
      if (boundary === "skills")
        rmSync(join(agent, "skills"), { recursive: true });
      if (boundary.includes("/")) mkdirSync(join(agent, "backups"));
      symlinkSync(external, join(agent, boundary));
      assert.throws(() =>
        migrateLegacySharedSkills({ stagedAgentDir: agent, adopt: true }),
      );
      assert.equal(
        readFileSync(join(external, "sentinel"), "utf8"),
        "untouched",
      );
      assert.equal(existsSync(join(external, "configuration")), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
