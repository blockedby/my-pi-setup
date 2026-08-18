import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePipiVersionState } from "./pipi-version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const version = validatePipiVersionState(repositoryRoot);
  console.log(`Pipi package and lockfile versions are aligned at ${version}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
