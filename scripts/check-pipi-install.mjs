import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const launcherVersion = execFileSync(launcher, ["--version"], {
  encoding: "utf8",
}).trim();
if (launcherVersion !== expectedVersion) {
  throw new Error(
    `Pipi launcher reports ${launcherVersion}; expected ${expectedVersion}.`,
  );
}

console.log(
  `Installed Pipi ${expectedVersion}, MCP 2.15.0, install-script policy, and model overrides are verified.`,
);
