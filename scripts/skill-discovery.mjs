import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let discoveryQueue = Promise.resolve();

const canonicalPath = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

const runtimeEntry = ({ agentDir, repositoryRoot }) => {
  const relative = join(
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  );
  const installed = join(agentDir, "runtime", relative);
  if (existsSync(installed)) return installed;
  if (repositoryRoot) {
    const workspace = join(repositoryRoot, relative);
    if (existsSync(workspace)) return workspace;
  }
  throw new Error(
    `Cannot inspect skill discovery because the installed Pi resource loader is missing: ${installed}`,
  );
};

const withDiscoveryEnvironment = async (home, operation) => {
  const previousHome = process.env.HOME;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  try {
    return await operation();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
};

const inspectDiscovery = async (input) => {
  const module = await import(pathToFileURL(runtimeEntry(input)).href);
  const { DefaultPackageManager, SettingsManager, loadSkills } = module;
  if (
    typeof DefaultPackageManager !== "function" ||
    typeof SettingsManager?.inMemory !== "function" ||
    typeof loadSkills !== "function"
  ) {
    throw new Error(
      "The installed Pi runtime does not expose the package and skill loader APIs required for discovery verification.",
    );
  }

  return withDiscoveryEnvironment(input.home, async () => {
    const createPackageManager = (settings) => {
      const settingsManager = SettingsManager.inMemory(settings, {
        projectTrusted: true,
      });
      return new DefaultPackageManager({
        cwd: input.cwd,
        agentDir: input.agentDir,
        settingsManager,
      });
    };
    const resolveResources = (settings) =>
      createPackageManager(settings).resolve(async () => "skip");

    const resolved = await resolveResources(input.settings ?? {});
    const activePaths = resolved.skills
      .filter(({ enabled }) => enabled)
      .map(({ path }) => path);
    const selectedResult = loadSkills({
      cwd: input.cwd,
      agentDir: input.agentDir,
      skillPaths: activePaths,
      includeDefaults: false,
    });

    const candidates = [];
    const candidateKeys = new Set();
    const addCandidates = (paths, aliasesOnly = false) => {
      for (const path of paths) {
        const result = loadSkills({
          cwd: input.cwd,
          agentDir: input.agentDir,
          skillPaths: [path],
          includeDefaults: false,
        });
        for (const skill of result.skills) {
          const realPath = canonicalPath(skill.filePath);
          if (
            aliasesOnly &&
            !candidates.some((candidate) => candidate.realPath === realPath)
          ) {
            continue;
          }
          const key = `${skill.name}\0${skill.filePath}`;
          if (candidateKeys.has(key)) continue;
          candidateKeys.add(key);
          candidates.push({
            name: skill.name,
            path: skill.filePath,
            realPath,
            source: skill.sourceInfo?.source,
            scope: skill.sourceInfo?.scope,
          });
        }
      }
    };

    addCandidates(activePaths);

    // Pi intentionally collapses paths that resolve to the same file. Resolve the
    // automatic roots separately so the report can retain harmless alias paths.
    const automatic = await resolveResources({});
    addCandidates(
      automatic.skills.filter(({ enabled }) => enabled).map(({ path }) => path),
      true,
    );
    for (const entry of input.settings?.packages ?? []) {
      if (typeof entry !== "string" && entry.skills !== undefined) continue;
      const source = typeof entry === "string" ? entry : entry.source;
      const packageResources = await createPackageManager(
        {},
      ).resolveExtensionSources([source]);
      addCandidates(
        packageResources.skills
          .filter(({ enabled }) => enabled)
          .map(({ path }) => path),
        true,
      );
    }

    const selectedByName = new Map(
      selectedResult.skills.map((skill) => [
        skill.name,
        {
          path: skill.filePath,
          realPath: canonicalPath(skill.filePath),
        },
      ]),
    );
    const identities = [];
    const groups = new Map();
    for (const candidate of candidates) {
      const key = `${candidate.name}\0${candidate.realPath}`;
      let identity = groups.get(key);
      if (!identity) {
        identity = {
          name: candidate.name,
          realPath: candidate.realPath,
          paths: [],
          selected:
            selectedByName.get(candidate.name)?.realPath === candidate.realPath,
        };
        groups.set(key, identity);
        identities.push(identity);
      }
      if (!identity.paths.includes(candidate.path))
        identity.paths.push(candidate.path);
    }

    const collisions = selectedResult.diagnostics
      .filter(({ type, collision }) => type === "collision" && collision)
      .map(({ collision }) => ({
        name: collision.name,
        winnerPath: collision.winnerPath,
        winnerRealPath: canonicalPath(collision.winnerPath),
        loserPath: collision.loserPath,
        loserRealPath: canonicalPath(collision.loserPath),
      }))
      .filter(
        ({ winnerRealPath, loserRealPath }) => winnerRealPath !== loserRealPath,
      );
    const aliases = identities
      .filter(({ paths }) => paths.length > 1)
      .map(({ name, realPath, paths }) => ({
        name,
        realPath,
        paths: [...paths],
      }));

    return {
      identities,
      selected: [...selectedByName].map(([name, identity]) => ({
        name,
        ...identity,
      })),
      aliases,
      collisions,
      diagnostics: selectedResult.diagnostics.filter(
        ({ type }) => type !== "collision",
      ),
    };
  });
};

export const discoverInstalledSkills = (input) => {
  const result = discoveryQueue.then(() => inspectDiscovery(input));
  discoveryQueue = result.catch(() => undefined);
  return result;
};

export const assertSelectedSkillIdentities = ({ discovery, expected }) => {
  for (const [name, expectedPath] of Object.entries(expected)) {
    const collisions = discovery.collisions.filter(
      (collision) => collision.name === name,
    );
    if (collisions.length > 0) {
      throw new Error(
        `Discoverable ${name} implementations collide: ${collisions
          .map(({ winnerPath, loserPath }) => `${winnerPath} <> ${loserPath}`)
          .join(", ")}`,
      );
    }
    const selected = discovery.selected.find((skill) => skill.name === name);
    const expectedRealPath = canonicalPath(join(expectedPath, "SKILL.md"));
    if (!selected) {
      throw new Error(`Required shared skill is not discoverable: ${name}`);
    }
    if (selected.realPath !== expectedRealPath) {
      throw new Error(
        `Selected ${name} skill has the wrong identity: ${selected.path}; expected ${expectedPath}`,
      );
    }
  }
};
