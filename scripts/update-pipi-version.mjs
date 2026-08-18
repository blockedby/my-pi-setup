import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDeclaredPipiVersion,
  parseStableVersion,
  pipiPackageNames,
  readJson,
  validatePipiVersionState,
} from "./pipi-version.mjs";

const defaultRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const usage = `Usage: npm run update:pipi -- <version>

Updates the aligned Pi AI, coding-agent, and TUI dependency ranges and regenerates
package-lock.json. The script validates registry availability before editing files and
restores both files if lockfile generation or alignment validation fails.
`;

const createCommandRunner =
  (repositoryRoot) =>
  (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: options.capture ? "pipe" : "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const detail = options.capture ? result.stderr.trim() : "";
      throw new Error(
        `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`,
      );
    }
    return result.stdout?.trim();
  };

const checkRegistry = (runCommand, packageName, version) => {
  const output = runCommand(
    "npm",
    ["view", `${packageName}@${version}`, "version", "--json"],
    { capture: true },
  );
  const publishedVersion = JSON.parse(output);
  if (publishedVersion !== version) {
    throw new Error(
      `npm returned ${publishedVersion ?? "no version"} for ${packageName}@${version}.`,
    );
  }
};

export const lockfileInstallArgs = (targetVersion) => [
  "install",
  "--package-lock-only",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--save-prefix=^",
  ...pipiPackageNames.map((packageName) => `${packageName}@${targetVersion}`),
];

export const updatePipiVersion = ({
  repositoryRoot,
  targetVersion,
  runCommand = createCommandRunner(repositoryRoot),
}) => {
  const manifestPath = join(repositoryRoot, "package.json");
  const lockfilePath = join(repositoryRoot, "package-lock.json");
  const version = parseStableVersion(targetVersion);
  const originalManifest = readFileSync(manifestPath, "utf8");
  const originalLockfile = readFileSync(lockfilePath, "utf8");
  const manifest = readJson(manifestPath);
  const currentVersion = getDeclaredPipiVersion(manifest);

  for (const packageName of pipiPackageNames) {
    checkRegistry(runCommand, packageName, version);
  }

  try {
    for (const packageName of pipiPackageNames) {
      manifest.dependencies[packageName] = `^${version}`;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    runCommand("npm", lockfileInstallArgs(version));
    validatePipiVersionState(repositoryRoot);
  } catch (error) {
    writeFileSync(manifestPath, originalManifest);
    writeFileSync(lockfilePath, originalLockfile);
    throw error;
  }

  return { currentVersion, targetVersion: version };
};

const runCli = () => {
  const [versionArgument, ...extraArguments] = process.argv.slice(2);
  if (!versionArgument || versionArgument === "--help") {
    console.log(usage);
    return;
  }
  if (extraArguments.length > 0) {
    throw new Error(`Unexpected arguments: ${extraArguments.join(" ")}`);
  }

  const result = updatePipiVersion({
    repositoryRoot: defaultRepositoryRoot,
    targetVersion: versionArgument,
  });
  console.log(
    `Updated Pipi dependency metadata: ${result.currentVersion} -> ${result.targetVersion}`,
  );
  console.log(
    "Next: review release notes, install dependencies, run checks, update the operation record, and install the isolated runtime.",
  );
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
