import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionsRoot = join(repositoryRoot, "extensions");
const liveTests = new Set([
  "extensions/subagents/claude.test.ts",
  "extensions/subagents/codex.test.ts",
]);

const testFiles = readdirSync(extensionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    const directory = join(extensionsRoot, entry.name);
    return readdirSync(directory, { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith(".test.ts"))
      .map((file) => relative(repositoryRoot, join(directory, file.name)));
  })
  .filter((path) => !liveTests.has(path))
  .sort();

if (testFiles.length === 0) {
  console.error("No deterministic extension tests were found.");
  process.exitCode = 1;
} else {
  console.log(
    `Running ${testFiles.length} deterministic extension test files (live Claude/Codex tests excluded).`,
  );
  const result = spawnSync(
    process.execPath,
    ["--test", "--experimental-strip-types", ...testFiles],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
