import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { normalizeGoalPackage } from "../../../scripts/goal-package.mjs";

const home = mkdtempSync(join(tmpdir(), "pipi-goal-filters-"));
const agentDir = join(home, "agent");
const cwd = join(home, "workspace");
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PIPI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
let networkRequests = 0;
Socket.prototype.connect = function () {
  networkRequests++;
  throw new Error("Network forbidden");
};
globalThis.fetch = async () => {
  networkRequests++;
  throw new Error("Network forbidden");
};
try {
  const { DefaultPackageManager } = await import(
    new URL(
      "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js",
      import.meta.url,
    ).href
  );
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const monorepoDir = join(agentDir, "git/github.com/narumiruna/pi-extensions");
  const desiredPath = join(agentDir, "runtime/node_modules/@narumitw/pi-goal");
  const goalEntry = "packages/pi-goal/dist/index.ts";
  const planEntry = "packages/pi-plan-mode/dist/index.ts";
  for (const path of [cwd, monorepoDir, desiredPath])
    mkdirSync(path, { recursive: true });
  writeFileSync(
    join(monorepoDir, "package.json"),
    JSON.stringify({ pi: { extensions: [goalEntry, planEntry] } }),
  );
  for (const entry of [goalEntry, planEntry]) {
    mkdirSync(join(monorepoDir, entry, ".."), { recursive: true });
    writeFileSync(join(monorepoDir, entry), "export default () => {};\n");
  }
  writeFileSync(
    join(desiredPath, "package.json"),
    JSON.stringify({
      name: "@narumitw/pi-goal",
      pi: { extensions: ["index.ts"] },
    }),
  );
  writeFileSync(join(desiredPath, "index.ts"), "export default () => {};\n");
  const resolvePackages = async (packages) => {
    const manager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({ packages }),
    });
    return (
      await manager.resolve(() => {
        throw new Error("Unexpected installation");
      })
    ).extensions
      .filter((entry) => entry.enabled)
      .map((entry) => entry.path)
      .sort();
  };
  for (const [forceInclude, existingExclusions] of [
    [goalEntry, []],
    ["./" + goalEntry, []],
    [join(monorepoDir, goalEntry), []],
    [goalEntry, ["!packages/pi-goal/**"]],
  ]) {
    const monorepo = {
      source: "git:github.com/narumiruna/pi-extensions",
      extensions: [
        "!**",
        ...existingExclusions,
        "+" + forceInclude,
        "+" + planEntry,
      ],
      skills: [],
      themes: [],
    };
    // Establish that the actual Pi filter contract force-includes this Goal.
    assert.deepEqual(
      await resolvePackages([monorepo]),
      [join(monorepoDir, goalEntry), join(monorepoDir, planEntry)].sort(),
    );
    const normalized = normalizeGoalPackage({
      packages: [monorepo],
      desiredPath,
      settingsBaseDir: agentDir,
      home,
    });
    assert.deepEqual(
      await resolvePackages(normalized),
      [join(desiredPath, "index.ts"), join(monorepoDir, planEntry)].sort(),
    );
    assert.deepEqual(normalized[0].skills, monorepo.skills);
    assert.deepEqual(normalized[0].themes, monorepo.themes);
    assert.ok(normalized[0].extensions.includes("+" + planEntry));
    assert.deepEqual(
      normalizeGoalPackage({
        packages: normalized,
        desiredPath,
        settingsBaseDir: agentDir,
        home,
      }),
      normalized,
    );
  }
  assert.equal(networkRequests, 0);
  console.log(
    JSON.stringify({
      passed: true,
      cases: 4,
      canonicalGoalEntries: 1,
      unrelatedResourcesPreserved: true,
      networkRequests,
    }),
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
