import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDeclaredPipiVersion,
  parseStableVersion,
  pipiPackageNames,
  pipiResolutionPackageNames,
  readJson,
  validatePipiVersionState,
} from "./pipi-version.mjs";

const defaultRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const usage = `Usage: bun run update:pipi -- <version>

Updates the aligned Pi dependency ranges and exact Bun resolution overrides, then
regenerates bun.lock. Registry availability is validated before editing files, and
package.json plus bun.lock are restored if generation or validation fails.
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
  const publishedVersion = runCommand(
    "bun",
    ["pm", "view", `${packageName}@${version}`, "version"],
    { capture: true },
  );
  if (publishedVersion !== version) {
    throw new Error(
      `Bun returned ${publishedVersion || "no version"} for ${packageName}@${version}.`,
    );
  }
};

export const lockfileInstallArgs = () => [
  "install",
  "--lockfile-only",
  "--save-text-lockfile",
];

export const updatePipiVersion = ({
  repositoryRoot,
  targetVersion,
  runCommand = createCommandRunner(repositoryRoot),
}) => {
  const manifestPath = join(repositoryRoot, "package.json");
  const lockfilePath = join(repositoryRoot, "bun.lock");
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
    manifest.overrides ??= {};
    for (const packageName of pipiResolutionPackageNames) {
      manifest.overrides[packageName] = version;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    runCommand("bun", lockfileInstallArgs(version));
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
