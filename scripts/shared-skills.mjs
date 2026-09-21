import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export const sharedSkillNames = [
  "browser-chrome",
  "frontend-quality",
  "code-review",
];

const skillName = (skillPath) => {
  const source = readFileSync(join(skillPath, "SKILL.md"), "utf8");
  return source.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
};

export const inspectSharedSkills = (home) => {
  const root = join(home, ".agents", "skills");
  const skills = Object.fromEntries(
    sharedSkillNames.map((name) => {
      const path = join(root, name);
      let entry;
      try {
        entry = lstatSync(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          throw new Error(
            `Required shared skill is missing: ${path}. Install the shared ${name} skill before installing Pipi.`,
          );
        }
        throw error;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        throw new Error(
          `Required shared skill is not a directory or symlink: ${path}`,
        );
      }
      if (!existsSync(join(path, "SKILL.md"))) {
        throw new Error(
          `Required shared skill is incomplete: ${path} (missing SKILL.md). Repair the shared skill before installing Pipi.`,
        );
      }
      const declaredName = skillName(path);
      if (declaredName !== name) {
        throw new Error(
          `Required shared skill at ${path} declares ${declaredName ?? "no name"}; expected ${name}.`,
        );
      }
      return [
        name,
        {
          path,
          symbolicLink: entry.isSymbolicLink(),
          linkTarget: entry.isSymbolicLink() ? readlinkSync(path) : undefined,
        },
      ];
    }),
  );

  for (const relativePath of [
    ["control-mcp", "server.mjs"],
    ["scripts", "common.sh"],
    ["scripts", "control-mcp.sh"],
    ["scripts", "mcp.sh"],
    ["scripts", "open-headed.sh"],
    ["scripts", "open-headless.sh"],
    ["scripts", "close-headless.sh"],
  ]) {
    const path = join(skills["browser-chrome"].path, ...relativePath);
    if (!existsSync(path)) {
      throw new Error(
        `Required shared browser-chrome contract is incomplete: ${path}. Repair the shared skill before installing Pipi.`,
      );
    }
  }
  return skills;
};

const pathLexists = (path) =>
  lstatSync(path, { throwIfNoEntry: false }) !== undefined;

const legacySkillPaths = (agentDir) =>
  sharedSkillNames.map((name) => ({
    name,
    path: join(agentDir, "skills", name),
  }));

export const validateBrowserControlContract = ({
  executable,
  sharedBrowserDir,
  adapterSourceDir,
}) => {
  const sharedModule = join(sharedBrowserDir, "control-mcp", "server.mjs");
  const adapterModule = join(adapterSourceDir, "control-mcp", "server.mjs");
  const probe = `
const paths = ${JSON.stringify([sharedModule, adapterModule])};
const output = [];
for (const path of paths) {
  const { pathToFileURL } = await import("node:url");
  const module = await import(pathToFileURL(path).href);
  if (typeof module.createControlServer !== "function" || typeof module.handleJsonRpcRequest !== "function") throw new Error("browser control module does not export the required contract");
  const server = module.createControlServer({ env: {} });
  const listed = await module.handleJsonRpcRequest(server, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const acquire = await module.handleJsonRpcRequest(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_chrome_acquire_session", arguments: { form: "headless-disposable" } } });
  const reject = await module.handleJsonRpcRequest(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_chrome_acquire_session", arguments: { form: "headless-disposable", requiresPersistent: true } } });
  output.push({ tools: listed.result.tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations })), acquire: acquire.result, reject: reject.result });
}
process.stdout.write(JSON.stringify(output));`;
  let contracts;
  try {
    contracts = JSON.parse(
      execFileSync(executable, ["--input-type=module", "--eval", probe], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      }),
    );
  } catch (error) {
    throw new Error(
      `Cannot validate the shared browser-chrome control contract: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (JSON.stringify(contracts[0]) !== JSON.stringify(contracts[1])) {
    throw new Error(
      "The shared browser-chrome control schemas or safety behavior are incompatible with Pipi's pinned runtime adapter; installation was not changed.",
    );
  }
  return contracts[0];
};

const assertOwnedDirectoryBoundary = (path) => {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error(
      `Refusing migration through a non-directory or symbolic-link boundary: ${path}`,
    );
  }
};

export const inspectLegacySharedSkills = ({ agentDir, adopt }) => {
  assertOwnedDirectoryBoundary(join(agentDir, "skills"));
  const conflicts = [];
  for (const skill of legacySkillPaths(agentDir)) {
    try {
      lstatSync(skill.path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    conflicts.push(skill);
  }
  if (conflicts.length > 0 && !adopt) {
    throw new Error(
      `Legacy Pipi skill copies require explicit migration: ${conflicts.map(({ path }) => path).join(", ")}. Re-run with --adopt-shared-skills to preserve them in Pipi's non-discovery backup area and adopt the shared skills.`,
    );
  }
  if (adopt && conflicts.length > 0) {
    assertOwnedDirectoryBoundary(join(agentDir, "backups"));
    const backupRoot = join(agentDir, "backups", "shared-skill-migration-v1");
    assertOwnedDirectoryBoundary(backupRoot);
    if (pathLexists(join(backupRoot, "configuration"))) {
      throw new Error(
        `Migration configuration backup already exists: ${join(backupRoot, "configuration")}`,
      );
    }
    for (const skill of conflicts) {
      const backup = join(backupRoot, skill.name);
      if (pathLexists(backup)) {
        throw new Error(
          `Shared-skill migration backup already exists and was preserved: ${backup}. Resolve it before adopting another copy.`,
        );
      }
    }
  }
  return { conflicts };
};

const copyEntryWithoutDereferencing = (source, target) => {
  mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
    verbatimSymlinks: true,
  });
};

export const migrateLegacySharedSkills = ({ stagedAgentDir, adopt }) => {
  const inspection = inspectLegacySharedSkills({
    agentDir: stagedAgentDir,
    adopt,
  });
  const backupRoot = join(
    stagedAgentDir,
    "backups",
    "shared-skill-migration-v1",
  );
  if (inspection.conflicts.length > 0) {
    const configBackup = join(backupRoot, "configuration");
    if (pathLexists(configBackup)) {
      throw new Error(
        `Migration configuration backup already exists: ${configBackup}`,
      );
    }
    mkdirSync(configBackup, { recursive: true, mode: 0o700 });
    const entries = ["settings.json", "mcp.json"];
    const absent = [];
    for (const name of entries) {
      const source = join(stagedAgentDir, name);
      if (pathLexists(source))
        copyEntryWithoutDereferencing(source, join(configBackup, name));
      else absent.push(name);
    }
    writeFileSync(
      join(configBackup, "absence.json"),
      JSON.stringify(absent, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  for (const skill of inspection.conflicts) {
    const backup = join(backupRoot, skill.name);
    if (pathLexists(backup)) {
      throw new Error(
        `Shared-skill migration backup already exists and was preserved: ${backup}. Resolve it before adopting another differing copy.`,
      );
    }
    copyEntryWithoutDereferencing(skill.path, backup);
    rmSync(skill.path, { recursive: true, force: true });
  }
  return {
    adopted: inspection.conflicts.map(({ name }) => name),
    backupRoot,
  };
};

export const reportStaleExplicitSkillSettings = ({ settings, agentDir }) => {
  const explicit = Array.isArray(settings.skills) ? settings.skills : [];
  const stale = explicit.filter((entry) => {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") return false;
    if (
      source.startsWith("!") ||
      source.startsWith("-") ||
      source.startsWith("+")
    )
      return false;
    const resolved = source.startsWith("~/")
      ? resolve(agentDir, "..", "..", source.slice(2))
      : resolve(agentDir, source);
    return (
      !existsSync(resolved) ||
      sharedSkillNames.some(
        (name) => resolved === join(agentDir, "skills", name),
      )
    );
  });
  if (stale.length > 0) {
    console.warn(
      `Stale explicit skill settings reference missing paths or retired Pipi-local copies and were not changed: ${stale.map((entry) => (typeof entry === "string" ? entry : entry.source)).join(", ")}`,
    );
  }
  return stale;
};

export const assertNoDiscoverableAdapterMetadata = (adapterDir) => {
  for (const name of ["SKILL.md", "skill.md"]) {
    if (existsSync(join(adapterDir, name))) {
      throw new Error(
        `Browser runtime adapter must not be discoverable as a skill: ${join(adapterDir, name)}`,
      );
    }
  }
};

export const sharedSkillLabel = (skill) =>
  `${basename(skill.path)}${skill.symbolicLink ? " (developer symlink preserved)" : ""}`;
