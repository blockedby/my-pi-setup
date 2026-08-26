import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDeclaredPipiVersion, readJson } from "./pipi-version.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const home = process.env.HOME || homedir();
const isolatedPrefix = join(home, ".pipi", "agent", "npm");
const manifest = readJson(join(repositoryRoot, "package.json"));
const expectedVersion = getDeclaredPipiVersion(manifest);
const installedPackage = readJson(
  join(
    isolatedPrefix,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  ),
);
const isolatedManifest = readJson(join(isolatedPrefix, "package.json"));
const expectedAllowScripts = {
  "@google/genai@1.52.0": true,
  "protobufjs@7.6.5": true,
};

if (installedPackage.version !== expectedVersion) {
  throw new Error(
    `Installed Pipi runtime is ${installedPackage.version}; expected ${expectedVersion}.`,
  );
}
if (
  installedPackage.piConfig?.name !== "pipi" ||
  installedPackage.piConfig?.configDir !== ".pi"
) {
  throw new Error("The installed Pi runtime is not branded as Pipi.");
}
if (
  isolatedManifest.dependencies?.["@earendil-works/pi-coding-agent"] !==
  expectedVersion
) {
  throw new Error(
    "The isolated Pipi manifest does not pin the expected runtime.",
  );
}
if (isolatedManifest.dependencies?.["pi-mcp-adapter"] !== "2.15.0") {
  throw new Error(
    "The isolated Pipi manifest does not pin MCP adapter 2.15.0.",
  );
}
if (
  JSON.stringify(isolatedManifest.allowScripts) !==
  JSON.stringify(expectedAllowScripts)
) {
  throw new Error("The isolated Pipi install-script policy is unexpected.");
}

const trackedOverrides = readFileSync(
  join(repositoryRoot, "config", "pipi-model-overrides.json"),
);
const installedOverrides = readFileSync(
  join(home, ".pipi", "agent", "models.json"),
);
if (!trackedOverrides.equals(installedOverrides)) {
  throw new Error(
    "Installed Pipi model overrides differ from the tracked copy.",
  );
}

const launcher = join(home, ".local", "bin", "pipi");
const launcherSource = readFileSync(launcher, "utf8");
for (const variable of [
  "PIPI_CODING_AGENT_DIR",
  "PIPI_CODING_AGENT_SESSION_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
]) {
  if (!launcherSource.includes(`export ${variable}=`)) {
    throw new Error(`Pipi launcher does not export ${variable}.`);
  }
}
const launcherVersion = execFileSync(launcher, ["--version"], {
  encoding: "utf8",
}).trim();
if (launcherVersion !== expectedVersion) {
  throw new Error(
    `Pipi launcher reports ${launcherVersion}; expected ${expectedVersion}.`,
  );
}
const launcherHelp = execFileSync(launcher, ["--help"], {
  encoding: "utf8",
});
if (!launcherHelp.includes("pipi - AI coding assistant")) {
  throw new Error("Pipi launcher help is not branded as pipi.");
}

const interactiveModule = pathToFileURL(
  join(
    isolatedPrefix,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "modes",
    "interactive",
    "interactive-mode.js",
  ),
).href;
const resumeCommand = execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "--eval",
    `Object.defineProperty(process.stdout, "isTTY", { value: true });
const { formatResumeCommand } = await import(${JSON.stringify(interactiveModule)});
process.stdout.write(formatResumeCommand({
  isPersisted: () => true,
  getSessionFile: () => "/dev/null",
  getSessionId: () => "test-session",
  usesDefaultSessionDir: () => false,
  getSessionDir: () => "/tmp/pipi sessions",
}) ?? "");`,
  ],
  { encoding: "utf8" },
);
if (
  resumeCommand !==
  "pipi --session-dir '/tmp/pipi sessions' --session test-session"
) {
  throw new Error(`Unexpected Pipi resume command: ${resumeCommand}`);
}

console.log(
  `Installed Pipi ${expectedVersion}, branded launcher/resume command, MCP 2.15.0, install-script policy, and model overrides are verified.`,
);
