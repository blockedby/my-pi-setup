import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareStableVersions,
  getDeclaredPipiVersion,
  parseStableVersion,
  readJson,
  requiresChangelogReview,
} from "./pipi-version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelogUrl =
  "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/CHANGELOG.md";

export const extractChangelogRange = (
  changelog,
  currentVersion,
  targetVersion,
) => {
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm)];
  if (!headings.some((heading) => heading[1] === targetVersion)) {
    throw new Error(
      `The coding-agent changelog has no ${targetVersion} release entry.`,
    );
  }
  const sections = headings.flatMap((heading, index) => {
    const version = heading[1];
    if (
      compareStableVersions(version, currentVersion) <= 0 ||
      compareStableVersions(version, targetVersion) > 0
    ) {
      return [];
    }
    const start = heading.index;
    const end = headings[index + 1]?.index ?? changelog.length;
    return [changelog.slice(start, end).trim()];
  });

  if (sections.length === 0) {
    throw new Error(
      `The coding-agent changelog has no release entries between ${currentVersion} and ${targetVersion}.`,
    );
  }
  return sections.join("\n\n");
};

const fetchChangelog = () => {
  const result = spawnSync(
    "curl",
    ["--fail", "--silent", "--show-error", "--location", changelogUrl],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `curl could not fetch the Pi coding-agent changelog: ${result.stderr.trim() || `exit ${result.status ?? "unknown"}`}`,
    );
  }
  return result.stdout;
};

const run = () => {
  const [targetArgument, ...extraArguments] = process.argv.slice(2);
  if (!targetArgument || extraArguments.length > 0) {
    throw new Error("Usage: npm run check:pipi-changelog -- <version>");
  }

  const targetVersion = parseStableVersion(targetArgument);
  const currentVersion = getDeclaredPipiVersion(
    readJson(resolve(repositoryRoot, "package.json")),
  );
  if (!requiresChangelogReview(currentVersion, targetVersion)) {
    console.log(
      `Pi ${currentVersion} -> ${targetVersion} is not a minor/major upgrade; changelog review skipped.`,
    );
    return;
  }

  const relevantChangelog = extractChangelogRange(
    fetchChangelog(),
    currentVersion,
    targetVersion,
  );
  console.log(
    `Pi coding-agent changelog for ${currentVersion} -> ${targetVersion}:\n`,
  );
  console.log(relevantChangelog);
  if (/^### Breaking Changes\s*$/m.test(relevantChangelog)) {
    console.log(
      "\nBREAKING CHANGES FOUND: inspect affected repository APIs before running the update command.",
    );
  } else {
    console.log("\nNo 'Breaking Changes' section found in this release range.");
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
