import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const isolatedRuntimeSource = join(
  repositoryRoot,
  "config",
  "pipi-runtime",
);

const readManifest = (manifestPath) => {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return undefined;
  }
};

const runBunInstall = ({ bunExecutable, cwd, cacheDirectory }) => {
  const result = spawnSync(
    bunExecutable,
    ["install", "--frozen-lockfile", "--cwd", cwd],
    {
      env: {
        ...process.env,
        ...(cacheDirectory ? { BUN_INSTALL_CACHE_DIR: cacheDirectory } : {}),
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `bun install --frozen-lockfile failed in ${cwd} with exit code ${result.status ?? "unknown"}`,
    );
  }
};

export const assertBunLockPolicy = (root = repositoryRoot) => {
  const staleLocks = [];
  if (existsSync(join(root, "package-lock.json")))
    staleLocks.push("package-lock.json");
  if (existsSync(join(root, "config", "pipi-runtime", "package-lock.json"))) {
    staleLocks.push("config/pipi-runtime/package-lock.json");
  }
  const extensionRoot = join(root, "extensions");
  if (existsSync(extensionRoot)) {
    for (const entry of readdirSync(extensionRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        existsSync(join(extensionRoot, entry.name, "package-lock.json"))
      ) {
        staleLocks.push(`extensions/${entry.name}/package-lock.json`);
      }
      if (
        entry.isDirectory() &&
        existsSync(join(extensionRoot, entry.name, "bun.lock"))
      ) {
        staleLocks.push(`extensions/${entry.name}/bun.lock`);
      }
    }
  }
  if (staleLocks.length > 0) {
    throw new Error(
      `Stale first-party lockfiles violate the root Bun workspace policy: ${staleLocks.join(", ")}`,
    );
  }
  if (!existsSync(join(root, "bun.lock"))) {
    throw new Error("Missing authoritative root bun.lock");
  }
};

const pathLexists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const activateStagedDirectory = (stage, target) => {
  const backup = `${target}.rollback-${process.pid}`;
  rmSync(backup, { recursive: true, force: true });
  if (pathLexists(target)) renameSync(target, backup);
  try {
    renameSync(stage, target);
  } catch (error) {
    if (pathLexists(backup)) renameSync(backup, target);
    throw error;
  }
  return {
    commit: () => rmSync(backup, { recursive: true, force: true }),
    rollback: () => {
      rmSync(target, { recursive: true, force: true });
      if (pathLexists(backup)) renameSync(backup, target);
    },
  };
};

export const prepareIsolatedBunRuntime = ({
  prefix,
  bunExecutable,
  cacheDirectory,
  appName,
}) => {
  mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(`${prefix}.stage-`);
  try {
    for (const file of ["package.json", "bun.lock"]) {
      const source = join(isolatedRuntimeSource, file);
      if (!existsSync(source))
        throw new Error(`Missing isolated runtime lock input: ${source}`);
      writeFileSync(join(stage, file), readFileSync(source), { mode: 0o600 });
    }
    runBunInstall({ bunExecutable, cwd: stage, cacheDirectory });
    for (const executable of ["pi", "pi-mcp-adapter", "chrome-devtools-mcp"]) {
      if (!existsSync(join(stage, "node_modules", ".bin", executable))) {
        throw new Error(
          `Isolated Bun install did not create required executable: ${executable}`,
        );
      }
    }
    if (!ensureIsolatedPiBranding({ prefix: stage, appName })) {
      throw new Error(
        "Isolated Bun install did not create the Pi runtime package",
      );
    }
    return activateStagedDirectory(stage, prefix);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
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

export const prepareRepositoryDependencies = ({
  bunExecutable = process.execPath,
  cacheDirectory,
} = {}) => {
  assertBunLockPolicy();
  console.log(
    `Preparing repository Bun workspace dependency cache in ${repositoryRoot}`,
  );
  runBunInstall({
    bunExecutable,
    cwd: repositoryRoot,
    cacheDirectory,
  });
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    prepareRepositoryDependencies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
