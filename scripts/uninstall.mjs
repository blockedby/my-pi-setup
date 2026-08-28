import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const managedLauncherMarker = "# Managed by pipi-alias installer.";

const parseArgs = (args) => {
  const options = { binDir: undefined, purge: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--purge") {
      options.purge = true;
      continue;
    }
    if (argument === "--bin-dir") {
      const value = args[index + 1];
      if (!value) throw new Error("--bin-dir requires a path");
      options.binDir = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help") {
      console.log(
        `Usage: bun scripts/uninstall.mjs [--purge] [--bin-dir PATH]\n\n--purge also removes ~/.pipi configuration and sessions.`,
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
};

const uninstall = () => {
  const options = parseArgs(process.argv.slice(2));
  const home = process.env.HOME || homedir();
  const launcherPath = join(
    options.binDir ?? join(home, ".local", "bin"),
    "pipi",
  );
  const pipiDir = join(home, ".pipi");

  if (existsSync(launcherPath)) {
    const launcher = readFileSync(launcherPath, "utf8");
    if (!launcher.includes(managedLauncherMarker)) {
      throw new Error(
        `Refusing to remove launcher not managed by this installer: ${launcherPath}`,
      );
    }
    rmSync(launcherPath);
    console.log(`Removed Pipi launcher: ${launcherPath}`);
  } else {
    console.log(`Pipi launcher is already absent: ${launcherPath}`);
  }

  if (options.purge) {
    rmSync(pipiDir, { recursive: true, force: true });
    console.log(`Removed Pipi configuration and sessions: ${pipiDir}`);
  } else if (existsSync(pipiDir)) {
    console.log(`Preserved Pipi configuration and sessions: ${pipiDir}`);
  }
};

try {
  uninstall();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
