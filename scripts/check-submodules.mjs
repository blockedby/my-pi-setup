import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRepositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = resolve(
  process.env.PIPI_SUBMODULE_ROOT ?? scriptRepositoryRoot,
);
const configPath = join(repositoryRoot, "config", "submodules.json");
const gitmodulesPath = join(repositoryRoot, ".gitmodules");
const packagePath = join(repositoryRoot, "package.json");

const fail = (message) => {
  throw new Error(message);
};

const git = (args, cwd = repositoryRoot) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();

const gitmodulesValue = (name, key) =>
  git(["config", "-f", gitmodulesPath, "--get", `submodule.${name}.${key}`]);

const assertRelativeVendorPath = (path, name) => {
  if (
    typeof path !== "string" ||
    isAbsolute(path) ||
    normalize(path).startsWith("..") ||
    !normalize(path).startsWith(
      `vendor${process.platform === "win32" ? "\\" : "/"}`,
    )
  ) {
    fail(`Submodule ${name} has unsafe path: ${path}`);
  }
};

const config = JSON.parse(readFileSync(configPath, "utf8"));
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
const configuredSkills = manifest.pi?.skills ?? [];
const entries = Object.entries(config.submodules ?? {});

if (entries.length === 0) fail("No submodules are configured");
if (!existsSync(gitmodulesPath)) fail("Missing .gitmodules");

for (const [name, submodule] of entries) {
  assertRelativeVendorPath(submodule.path, name);
  const directory = join(repositoryRoot, submodule.path);
  const gitmodulesName = submodule.gitmodulesName ?? name;

  if (gitmodulesValue(gitmodulesName, "path") !== submodule.path) {
    fail(`Submodule ${name} path does not match .gitmodules`);
  }
  if (gitmodulesValue(gitmodulesName, "url") !== submodule.url) {
    fail(`Submodule ${name} URL does not match .gitmodules`);
  }
  if (gitmodulesValue(gitmodulesName, "branch") !== submodule.branch) {
    fail(`Submodule ${name} branch does not match .gitmodules`);
  }

  const indexEntry = git(["ls-files", "--stage", "--", submodule.path]);
  const gitlink = indexEntry.match(/^160000 ([0-9a-f]{40}) 0\t/);
  if (!gitlink) fail(`Submodule ${name} is not recorded as a Git gitlink`);
  const pinnedCommit = gitlink[1];

  if (!existsSync(join(directory, ".git"))) {
    fail(
      `Submodule ${name} is not initialized; run git submodule update --init --recursive`,
    );
  }
  const worktreeCommit = git(["rev-parse", "HEAD"], directory);
  if (worktreeCommit !== pinnedCommit) {
    fail(
      `Submodule ${name} worktree is at ${worktreeCommit}, expected ${pinnedCommit}`,
    );
  }
  if (git(["remote", "get-url", "origin"], directory) !== submodule.url) {
    fail(`Submodule ${name} origin URL does not match configured URL`);
  }
  if (git(["status", "--porcelain=v1", "--untracked-files=all"], directory)) {
    fail(`Submodule ${name} has direct worktree changes`);
  }

  for (const relativePath of submodule.requiredFiles ?? []) {
    if (!existsSync(join(directory, relativePath))) {
      fail(`Submodule ${name} is missing required file: ${relativePath}`);
    }
  }

  const skillPathCount = configuredSkills.filter(
    (path) => path === submodule.piSkillPath,
  ).length;
  if (skillPathCount !== 1) {
    fail(
      `package.json must load ${submodule.piSkillPath} exactly once; found ${skillPathCount}`,
    );
  }
  for (const hostPath of submodule.replacesHostPaths ?? []) {
    if (existsSync(join(repositoryRoot, hostPath))) {
      fail(`Submodule ${name} must replace duplicate host path: ${hostPath}`);
    }
  }

  console.log(`valid submodule ${name}: ${pinnedCommit}`);
}
