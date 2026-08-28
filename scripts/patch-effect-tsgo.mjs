import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = join(repositoryRoot, "extensions");

export const patchEffectCompilers = ({
  bunExecutable = process.execPath,
} = {}) => {
  const applicable = readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(extensionRoot, entry.name))
    .filter((directory) => existsSync(join(directory, "package.json")))
    .filter((directory) => {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      return (
        manifest.scripts?.["prepare:compiler"] ===
        "bun node_modules/@effect/tsgo/dist/effect-tsgo.js patch"
      );
    });
  const lockHash = createHash("sha256")
    .update(readFileSync(join(repositoryRoot, "bun.lock")))
    .digest("hex");
  const markerPath = join(
    repositoryRoot,
    "node_modules",
    ".pipi-effect-tsgo-patched",
  );
  if (
    existsSync(markerPath) &&
    readFileSync(markerPath, "utf8").trim() === lockHash
  ) {
    console.log(
      `Effect TSGO compiler patch already verified for ${applicable.length} workspaces.`,
    );
    return applicable;
  }

  for (const directory of applicable) {
    console.log(`Patching the Effect TSGO compiler for ${directory}`);
    const result = spawnSync(
      bunExecutable,
      ["run", "--cwd", directory, "prepare:compiler"],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `effect-tsgo patch failed in ${directory} with exit code ${result.status ?? "unknown"}`,
      );
    }
  }
  writeFileSync(markerPath, `${lockHash}\n`);
  return applicable;
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    patchEffectCompilers();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
