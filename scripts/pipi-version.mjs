import { readFileSync } from "node:fs";
import { join } from "node:path";

export const pipiPackageNames = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

export const pipiResolutionPackageNames = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
];

export const legacyPipiResolutionPackageNames = [
  "@earendil-works/pi-client",
  "@earendil-works/pi-protocol",
];

export const parseStableVersion = (value) => {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(
      `Expected a stable semantic version such as 0.84.2, received: ${value}`,
    );
  }
  return value;
};

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export const readBunLock = (path) =>
  JSON.parse(readFileSync(path, "utf8").replace(/,\s*([}\]])/g, "$1"));

const versionParts = (version) =>
  parseStableVersion(version).split(".").map(Number);

export const compareStableVersions = (left, right) => {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
};

export const pipiResolutionPackageNamesFor = (version) =>
  compareStableVersions(version, "0.85.0") < 0
    ? [...pipiResolutionPackageNames, ...legacyPipiResolutionPackageNames]
    : pipiResolutionPackageNames;

export const requiresChangelogReview = (currentVersion, targetVersion) => {
  if (compareStableVersions(targetVersion, currentVersion) <= 0) return false;
  const [currentMajor, currentMinor] = versionParts(currentVersion);
  const [targetMajor, targetMinor] = versionParts(targetVersion);
  return currentMajor !== targetMajor || currentMinor !== targetMinor;
};

export const getDeclaredPipiVersion = (manifest) => {
  const versions = pipiPackageNames.map((packageName) => {
    const spec = manifest.dependencies?.[packageName];
    const version =
      typeof spec === "string"
        ? spec.match(/^\^(\d+\.\d+\.\d+)$/)?.[1]
        : undefined;
    if (!version) {
      throw new Error(
        `package.json must declare ${packageName} with a caret-prefixed stable version.`,
      );
    }
    return version;
  });

  const [version] = versions;
  if (versions.some((candidate) => candidate !== version)) {
    throw new Error(
      `Pipi package versions are not aligned: ${pipiPackageNames
        .map((packageName, index) => `${packageName}@${versions[index]}`)
        .join(", ")}`,
    );
  }
  return version;
};

const lockedPackageVersion = (lockfile, packageName) => {
  const resolution = lockfile.packages?.[packageName]?.[0];
  if (typeof resolution !== "string") return undefined;
  return resolution.startsWith(`${packageName}@`)
    ? resolution.slice(packageName.length + 1)
    : undefined;
};

export const validatePipiVersionState = (repositoryRoot) => {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const lockfile = readBunLock(join(repositoryRoot, "bun.lock"));
  const version = getDeclaredPipiVersion(manifest);
  const expectedRange = `^${version}`;

  for (const packageName of pipiPackageNames) {
    if (
      lockfile.workspaces?.[""]?.dependencies?.[packageName] !== expectedRange
    ) {
      throw new Error(
        `bun.lock root dependency for ${packageName} is not ${expectedRange}.`,
      );
    }
  }

  for (const packageName of pipiResolutionPackageNamesFor(version)) {
    if (manifest.overrides?.[packageName] !== version) {
      throw new Error(
        `package.json override for ${packageName} is not ${version}.`,
      );
    }
    const lockedVersion = lockedPackageVersion(lockfile, packageName);
    if (lockedVersion !== version) {
      throw new Error(
        `bun.lock resolves ${packageName} to ${lockedVersion ?? "nothing"}; expected ${version}.`,
      );
    }
  }

  if (compareStableVersions(version, "0.85.0") >= 0) {
    for (const packageName of legacyPipiResolutionPackageNames) {
      if (manifest.overrides?.[packageName] !== undefined) {
        throw new Error(
          `package.json retains obsolete override ${packageName}.`,
        );
      }
    }
  }

  const codingAgent =
    lockfile.packages?.["@earendil-works/pi-coding-agent"]?.[2];
  for (const dependencyName of [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ]) {
    if (codingAgent?.dependencies?.[dependencyName] !== expectedRange) {
      throw new Error(
        `The locked coding agent expects ${dependencyName}@${codingAgent?.dependencies?.[dependencyName] ?? "unknown"}; expected ${expectedRange}.`,
      );
    }
  }

  return version;
};
