import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractChangelogRange } from "../../scripts/check-pipi-changelog.mjs";
import {
  compareStableVersions,
  getDeclaredPipiVersion,
  parseStableVersion,
  pipiPackageNames,
  pipiResolutionPackageNames,
  requiresChangelogReview,
  validatePipiVersionState,
} from "../../scripts/pipi-version.mjs";
import {
  lockfileInstallArgs,
  updatePipiVersion,
} from "../../scripts/update-pipi-version.mjs";

const manifestFor = (version) => ({
  dependencies: Object.fromEntries(
    pipiPackageNames.map((packageName) => [packageName, `^${version}`]),
  ),
  overrides: Object.fromEntries(
    pipiResolutionPackageNames.map((packageName) => [packageName, version]),
  ),
});

const packageEntry = (packageName, version, metadata = {}) => [
  `${packageName}@${version}`,
  "",
  metadata,
  "sha512-fixture",
];

const lockfileFor = (version) => ({
  lockfileVersion: 2,
  configVersion: 1,
  workspaces: { "": { name: "fixture", ...manifestFor(version) } },
  packages: {
    ...Object.fromEntries(
      pipiResolutionPackageNames.map((packageName) => [
        packageName,
        packageEntry(packageName, version),
      ]),
    ),
    "@earendil-works/pi-coding-agent": packageEntry(
      "@earendil-works/pi-coding-agent",
      version,
      {
        dependencies: {
          "@earendil-works/pi-agent-core": `^${version}`,
          "@earendil-works/pi-ai": `^${version}`,
          "@earendil-works/pi-tui": `^${version}`,
        },
      },
    ),
  },
});

const createFixture = async (version = "0.84.2") => {
  const root = await mkdtemp(join(tmpdir(), "pipi-version-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(manifestFor(version), null, 2)}\n`,
  );
  writeFileSync(
    join(root, "bun.lock"),
    `${JSON.stringify(lockfileFor(version), null, 2)}\n`,
  );
  return root;
};

test("accepts stable semantic versions only", () => {
  assert.equal(parseStableVersion("0.84.2"), "0.84.2");
  for (const invalid of ["v0.84.2", "0.84", "0.84.2-beta.1", "latest"]) {
    assert.throws(() => parseStableVersion(invalid), /stable semantic version/);
  }
});

test("requires changelog review only for forward minor or major upgrades", () => {
  assert.equal(compareStableVersions("0.85.0", "0.84.9") > 0, true);
  assert.equal(requiresChangelogReview("0.84.1", "0.84.2"), false);
  assert.equal(requiresChangelogReview("0.84.2", "0.85.0"), true);
  assert.equal(requiresChangelogReview("0.84.2", "1.0.0"), true);
  assert.equal(requiresChangelogReview("0.85.0", "0.84.2"), false);
});

test("extracts all new release sections and exposes breaking changes", () => {
  const changelog = `# Changelog

## [Unreleased]

- Later work.

## [0.85.1] - 2026-09-02

### Fixed

- Patch fix.

## [0.85.0] - 2026-09-01

### Breaking Changes

- Changed an API.

## [0.84.2] - 2026-08-14

### Fixed

- Old fix.
`;
  const result = extractChangelogRange(changelog, "0.84.2", "0.85.1");
  assert.match(result, /\[0\.85\.1\]/);
  assert.match(result, /\[0\.85\.0\]/);
  assert.match(result, /### Breaking Changes/);
  assert.doesNotMatch(result, /\[0\.84\.2\]/);
});

test("requires aligned caret ranges", () => {
  const manifest = manifestFor("0.84.2");
  assert.equal(getDeclaredPipiVersion(manifest), "0.84.2");
  manifest.dependencies["@earendil-works/pi-tui"] = "^0.84.1";
  assert.throws(() => getDeclaredPipiVersion(manifest), /not aligned/);
});

test("pins the requested patch with Bun overrides and regenerates bun.lock", async (t) => {
  const root = await createFixture("0.84.1");
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetVersion = "0.84.2";
  const calls = [];

  const runCommand = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "pm") return targetVersion;
    assert.equal(command, "bun");
    assert.deepEqual(args, lockfileInstallArgs(targetVersion));
    writeFileSync(
      join(root, "bun.lock"),
      `${JSON.stringify(lockfileFor(targetVersion), null, 2)}\n`,
    );
    return "";
  };

  assert.deepEqual(
    updatePipiVersion({
      repositoryRoot: root,
      targetVersion,
      runCommand,
    }),
    { currentVersion: "0.84.1", targetVersion },
  );
  assert.equal(calls.filter(([, args]) => args[0] === "pm").length, 3);
  assert.equal(validatePipiVersionState(root), targetVersion);
  const updated = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    updated.dependencies["@earendil-works/pi-coding-agent"],
    `^${targetVersion}`,
  );
  for (const packageName of pipiResolutionPackageNames) {
    assert.equal(updated.overrides[packageName], targetVersion);
  }
});

test("validates Bun manifest, lock, overrides, and coding-agent family", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(validatePipiVersionState(root), "0.84.2");

  const lockfile = lockfileFor("0.84.2");
  lockfile.packages["@earendil-works/pi-coding-agent"][2].dependencies[
    "@earendil-works/pi-agent-core"
  ] = "^0.84.1";
  writeFileSync(
    join(root, "bun.lock"),
    `${JSON.stringify(lockfile, null, 2)}\n`,
  );
  assert.throws(
    () => validatePipiVersionState(root),
    /pi-agent-core@\^0\.84\.1/,
  );
});
