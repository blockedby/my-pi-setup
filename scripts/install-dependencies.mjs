import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hasRuntimeDependencies = (directory) => {
  const manifest = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  );
  return Object.keys(manifest.dependencies ?? {}).length > 0;
};

export const installDependencies = () => {
  const extensionRoot = join(repositoryRoot, "extensions");
  const directories = [
    repositoryRoot,
    ...readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(extensionRoot, entry.name))
      .filter((directory) => existsSync(join(directory, "package.json")))
      .filter(hasRuntimeDependencies),
  ];

  for (const directory of directories) {
    console.log(`Installing dependencies in ${directory}`);
    const result = spawnSync("npm", ["ci", "--prefix", directory], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `npm ci failed in ${directory} with exit code ${result.status ?? "unknown"}`,
      );
    }
  }
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    installDependencies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
