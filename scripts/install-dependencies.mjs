import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

const readManifest = (manifestPath) => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
};

export const ensureIsolatedNpmPolicy = ({ prefix, allowScripts }) => {
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const manifestPath = join(prefix, "package.json");
  const manifest = readManifest(manifestPath) ?? {
    name: "pipi-isolated-runtime",
    private: true,
    dependencies: {},
  };
  manifest.private = true;
  manifest.dependencies ??= {};
  manifest.allowScripts = Object.fromEntries(
    allowScripts.map((packageId) => [packageId, true]),
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
};

export const ensureIsolatedPiBranding = ({ prefix, appName }) => {
  const manifestPath = join(
    prefix,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  );
  const manifest = readManifest(manifestPath);
  if (!manifest) return false;
  const piConfig =
    manifest.piConfig && typeof manifest.piConfig === "object"
      ? manifest.piConfig
      : {};
  manifest.piConfig = { ...piConfig, name: appName };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
};

export const ensureIsolatedNpmPackage = ({
  prefix,
  packageName,
  packageSpec,
  expectedVersion,
}) => {
  const installedManifest = readManifest(
    join(prefix, "node_modules", packageName, "package.json"),
  );
  const prefixManifest = readManifest(join(prefix, "package.json"));
  if (
    installedManifest?.version === expectedVersion &&
    prefixManifest?.dependencies?.[packageName] === expectedVersion
  )
    return;

  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  console.log(`Installing isolated Pi package ${packageSpec} in ${prefix}`);
  const result = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--no-package-lock",
      "--save-exact",
      packageSpec,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm install failed for ${packageSpec} with exit code ${result.status ?? "unknown"}`,
    );
  }
};

export const installDependencies = () => {
  const extensionRoot = join(repositoryRoot, "extensions");
  const submoduleConfig = readManifest(
    join(repositoryRoot, "config", "submodules.json"),
  );
  const submoduleDirectories = Object.values(submoduleConfig?.submodules ?? {})
    .map((submodule) =>
      typeof submodule?.path === "string"
        ? join(repositoryRoot, submodule.path)
        : undefined,
    )
    .filter((directory) => directory !== undefined)
    .filter((directory) => existsSync(join(directory, "package.json")))
    .filter(hasRuntimeDependencies);
  const directories = [
    repositoryRoot,
    ...readdirSync(extensionRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(extensionRoot, entry.name))
      .filter((directory) => existsSync(join(directory, "package.json")))
      .filter(hasRuntimeDependencies),
    ...submoduleDirectories,
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
