import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export const MINIMUM_BUN_VERSION = "1.4.0";
export const MINIMUM_SANDBOX_NODE_VERSION = "22.19.0";

const currentBunVersion = (
  process.versions as NodeJS.ProcessVersions & { bun?: string }
).bun;

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  command: string,
  pathValue = process.env.PATH ?? "",
  excludedDirectories: readonly string[] = [],
) {
  const excluded = new Set(excludedDirectories.map((path) => resolve(path)));
  const names =
    process.platform === "win32" && !command.toLowerCase().endsWith(".exe")
      ? [command, `${command}.exe`]
      : [command];
  const candidates =
    isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [isAbsolute(command) ? command : resolve(command)]
      : pathValue
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) => names.map((name) => join(directory, name)));

  for (const candidate of candidates) {
    if (excluded.has(resolve(dirname(candidate)))) continue;
    if (executable(candidate)) return resolve(candidate);
  }
  return undefined;
}

export function parseRuntimeVersion(value: string) {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return match.slice(1).map(Number) as [number, number, number];
}

export function runtimeVersionAtLeast(actual: string, minimum: string) {
  const actualParts = parseRuntimeVersion(actual);
  const minimumParts = parseRuntimeVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index])
      return actualParts[index] > minimumParts[index];
  }
  return true;
}

interface RuntimeResolutionOptions {
  env?: NodeJS.ProcessEnv;
  pathValue?: string;
  currentExecutable?: string;
  currentVersion?: string;
  probeVersion?: (executable: string) => string;
  verifyCapability?: (executable: string) => boolean;
}

function resolveRuntime(
  name: "Bun" | "Node.js",
  command: string,
  overrideName: "PIPI_BUN_RUNTIME" | "PIPI_NODE_RUNTIME",
  minimumVersion: string,
  options: RuntimeResolutionOptions = {},
) {
  const env = options.env ?? process.env;
  const pathValue = options.pathValue ?? env.PATH ?? "";
  const override = env[overrideName];
  const currentExecutable = options.currentExecutable;
  const current =
    !override && currentExecutable && executable(currentExecutable)
      ? resolve(currentExecutable)
      : undefined;
  const pathExecutable = override
    ? findExecutable(override, pathValue)
    : findExecutable(command, pathValue, current ? [dirname(current)] : []);
  const candidates = override
    ? pathExecutable
      ? [pathExecutable]
      : []
    : [
        ...(current ? [current] : []),
        ...(pathExecutable ? [pathExecutable] : []),
      ];
  if (candidates.length === 0) {
    throw new Error(
      `${name} >= ${minimumVersion} is required but ${override ? `${overrideName}=${override}` : command} was not executable. Install ${name} or set ${overrideName} to an executable path.`,
    );
  }

  const failures: string[] = [];
  for (const selected of candidates) {
    let version =
      !override && current && selected === current
        ? options.currentVersion
        : undefined;
    if (!version) {
      try {
        version = (
          options.probeVersion ??
          ((executablePath) =>
            execFileSync(executablePath, ["--version"], {
              encoding: "utf8",
              timeout: 5_000,
              stdio: ["ignore", "pipe", "pipe"],
            }))
        )(selected).trim();
      } catch (error) {
        failures.push(
          `${selected}: version probe failed (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
    }
    if (!runtimeVersionAtLeast(version, minimumVersion)) {
      failures.push(`${selected}: unsupported ${version}`);
      continue;
    }
    if (options.verifyCapability && !options.verifyCapability(selected)) {
      failures.push(
        `${selected}: required security capability was not verified`,
      );
      continue;
    }
    return { executable: selected, version };
  }
  throw new Error(
    `${name} >= ${minimumVersion} is required; ${failures.join("; ")}.`,
  );
}

export function resolveBunRuntime(options: RuntimeResolutionOptions = {}) {
  return resolveRuntime("Bun", "bun", "PIPI_BUN_RUNTIME", MINIMUM_BUN_VERSION, {
    currentExecutable: currentBunVersion ? process.execPath : undefined,
    currentVersion: currentBunVersion,
    ...options,
  });
}

export function verifyNodePermissionCapability(nodeExecutable: string) {
  const root = mkdtempSync(join(tmpdir(), "pipi-node-permission-"));
  const allowed = join(root, "allowed.txt");
  const forbidden = join(root, "forbidden.txt");
  writeFileSync(allowed, "allowed\n");
  writeFileSync(forbidden, "forbidden\n");
  const marker = "pipi-node-permission-capability-ok";
  const probe = `
const { readFileSync } = require("node:fs");
if (process.release?.name !== "node" || typeof process.permission?.has !== "function") process.exit(41);
if (!process.permission.has("fs.read", ${JSON.stringify(allowed)})) process.exit(42);
if (readFileSync(${JSON.stringify(allowed)}, "utf8") !== "allowed\\n") process.exit(43);
try {
  readFileSync(${JSON.stringify(forbidden)}, "utf8");
  process.exit(44);
} catch (error) {
  if (error?.code !== "ERR_ACCESS_DENIED") process.exit(45);
}
process.stdout.write(${JSON.stringify(marker)});
`;
  try {
    const output = execFileSync(
      nodeExecutable,
      ["--permission", `--allow-fs-read=${allowed}`, "--eval", probe],
      {
        encoding: "utf8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output === marker;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Resolve the narrow Node fallback used only by the workflow security boundary.
 * Bun does not provide Node's permission model, so this path must never fall
 * back to the Bun executable or run without a supported Node permission mode.
 */
export function resolveSandboxNodeRuntime(
  options: RuntimeResolutionOptions = {},
) {
  return resolveRuntime(
    "Node.js",
    "node",
    "PIPI_NODE_RUNTIME",
    MINIMUM_SANDBOX_NODE_VERSION,
    {
      currentExecutable: currentBunVersion ? undefined : process.execPath,
      currentVersion: currentBunVersion ? undefined : process.versions.node,
      verifyCapability: verifyNodePermissionCapability,
      ...options,
    },
  );
}
