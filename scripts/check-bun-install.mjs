import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBunLockPolicy } from "./install-dependencies.mjs";
import { readBunLock } from "./pipi-version.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const lockfile = readBunLock(join(repositoryRoot, "bun.lock"));
const runtimeManifest = JSON.parse(
  readFileSync(
    join(repositoryRoot, "config", "pipi-runtime", "package.json"),
    "utf8",
  ),
);
const runtimeLock = readBunLock(
  join(repositoryRoot, "config", "pipi-runtime", "bun.lock"),
);

assertBunLockPolicy();

const workspacePaths = Object.keys(lockfile.workspaces ?? {}).filter(Boolean);
const expectedWorkspaces = manifest.workspaces.packages.flatMap((pattern) => {
  if (pattern !== "extensions/*")
    throw new Error(`Unexpected workspace pattern: ${pattern}`);
  return readdirSync(join(repositoryRoot, "extensions"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .filter((entry) =>
      existsSync(
        join(repositoryRoot, "extensions", entry.name, "package.json"),
      ),
    )
    .map((entry) => `extensions/${entry.name}`)
    .sort();
});
if (
  JSON.stringify(workspacePaths.sort()) !== JSON.stringify(expectedWorkspaces)
) {
  throw new Error(
    "bun.lock workspace inventory does not match package.json roots",
  );
}

const applicable = expectedWorkspaces.filter((workspace) => {
  const packageManifest = JSON.parse(
    readFileSync(join(repositoryRoot, workspace, "package.json"), "utf8"),
  );
  return (
    packageManifest.scripts?.["prepare:compiler"] ===
    "bun node_modules/@effect/tsgo/dist/effect-tsgo.js patch"
  );
});
if (applicable.length !== 9) {
  throw new Error(
    `Expected 9 Effect TSGO workspaces, found ${applicable.length}`,
  );
}
for (const workspace of applicable) {
  const compiler = join(
    repositoryRoot,
    workspace,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
  );
  const version = execFileSync(process.execPath, [compiler, "--version"], {
    encoding: "utf8",
  }).trim();
  if (version !== "Version 7.0.2+effect-tsgo.0.24.3") {
    throw new Error(`${workspace} has unexpected compiler: ${version}`);
  }
  const effectCompiler = execFileSync(
    process.execPath,
    [
      join(
        repositoryRoot,
        workspace,
        "node_modules",
        "@effect",
        "tsgo",
        "dist",
        "effect-tsgo.js",
      ),
      "get-exe-path",
    ],
    { encoding: "utf8" },
  ).trim();
  if (!existsSync(effectCompiler)) {
    throw new Error(
      `${workspace} cannot resolve its native Effect TSGO compiler`,
    );
  }
}

const expectedRootTrust = ["@google/genai", "msgpackr-extract", "protobufjs"];
if (
  JSON.stringify(manifest.trustedDependencies) !==
    JSON.stringify(expectedRootTrust) ||
  JSON.stringify(lockfile.trustedDependencies) !==
    JSON.stringify(expectedRootTrust)
) {
  throw new Error("Root trustedDependencies is not the reviewed narrow policy");
}
const expectedRuntimeTrust = ["@google/genai", "protobufjs"];
if (
  JSON.stringify(runtimeManifest.trustedDependencies) !==
    JSON.stringify(expectedRuntimeTrust) ||
  JSON.stringify(runtimeLock.trustedDependencies) !==
    JSON.stringify(expectedRuntimeTrust)
) {
  throw new Error("Isolated runtime trustedDependencies is unexpected");
}
for (const [packageName, version] of Object.entries(
  runtimeManifest.dependencies,
)) {
  const resolution = runtimeLock.packages?.[packageName]?.[0];
  if (resolution !== `${packageName}@${version}`) {
    throw new Error(
      `Isolated runtime lock does not pin ${packageName}@${version}`,
    );
  }
}

if (process.platform === "linux" && process.arch === "x64") {
  const bunStore = join(repositoryRoot, "node_modules", ".bun");
  const entries = readdirSync(bunStore);
  if (
    !entries.some((entry) => entry.startsWith("@effect+tsgo-linux-x64@0.24.3"))
  ) {
    throw new Error("Linux x64 Effect TSGO native package is missing");
  }
  const msgpackrEntry = entries.find((entry) =>
    entry.startsWith("@msgpackr-extract+msgpackr-extract-linux-x64@3.0.4"),
  );
  if (!msgpackrEntry) {
    throw new Error("Linux x64 msgpackr native optional package is missing");
  }
}

console.log(
  `Verified ${workspacePaths.length + 1} root/workspace package roots, ${applicable.length} Effect TSGO patched TypeScript 7.0.2 compilers, narrow lifecycle trust, isolated Bun pins, and current-platform native packages.`,
);
