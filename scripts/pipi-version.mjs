import { readFileSync } from "node:fs";
import { join } from "node:path";

export const pipiPackageNames = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
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

export const validatePipiVersionState = (repositoryRoot) => {
  const manifest = readJson(join(repositoryRoot, "package.json"));
  const lockfile = readJson(join(repositoryRoot, "package-lock.json"));
  const version = getDeclaredPipiVersion(manifest);
  const expectedRange = `^${version}`;

  for (const packageName of pipiPackageNames) {
    const locked = lockfile.packages?.[`node_modules/${packageName}`];
    if (locked?.version !== version) {
      throw new Error(
        `package-lock.json resolves ${packageName} to ${locked?.version ?? "nothing"}; expected ${version}.`,
      );
    }
    if (
      lockfile.packages?.[""]?.dependencies?.[packageName] !== expectedRange
    ) {
      throw new Error(
        `package-lock.json root dependency for ${packageName} is not ${expectedRange}.`,
      );
    }
  }

  const codingAgent =
    lockfile.packages?.["node_modules/@earendil-works/pi-coding-agent"];
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
