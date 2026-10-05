import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const goalIdentity = JSON.parse(
  readFileSync(
    new URL("../config/pi-goal-integrity.json", import.meta.url),
    "utf8",
  ),
);
export const goalPackagePath = (prefix) =>
  join(prefix, "node_modules", goalIdentity.name);

const dependencyPackage = (from, name) => {
  const entry = fileURLToPath(
    import.meta.resolve(
      name,
      pathToFileURL(join(realpathSync(from), "package.json")).href,
    ),
  );
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (manifest.name === name) return { directory, manifest, entry };
    } catch {
      /* Continue to the dependency package root. */
    }
    directory = dirname(directory);
  }
  throw new Error(`Missing dependency manifest: ${name}`);
};

export const goalDependencyPaths = (prefix) => {
  const root = goalPackagePath(prefix);
  const kit = dependencyPackage(root, "@narumitw/pi-tui-kit");
  const names = [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
    "@narumitw/pi-tui-kit",
    "grok-mermaid",
    "highlight.js",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      dependencyPackage(
        ["grok-mermaid", "highlight.js"].includes(name) ? kit.directory : root,
        name,
      ).directory,
    ]),
  );
};

// Validate before activation and during installed-state checks. The immutable
// npm bytes are retained, including the generated entry and all lazy chunks.
export const validateGoalPackage = (prefix) => {
  const root = goalPackagePath(prefix);
  try {
    const isolatedRoot = realpathSync(prefix) + "/";
    const assertContained = (path) => {
      if (!realpathSync(path).startsWith(isolatedRoot))
        throw new Error(`Dependency escapes isolated prefix: ${path}`);
    };
    assertContained(root);
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    if (
      manifest.name !== goalIdentity.name ||
      manifest.version !== goalIdentity.version ||
      JSON.stringify(manifest.pi?.extensions) !==
        JSON.stringify(["./dist/index.ts"])
    )
      throw new Error("Unexpected manifest or extension entry");
    for (const [file, expected] of Object.entries(goalIdentity.files)) {
      const path = join(root, file);
      assertContained(path);
      if (!lstatSync(path, { throwIfNoEntry: false })?.isFile())
        throw new Error(`Missing or nonregular file: ${file}`);
      if (
        createHash("sha256").update(readFileSync(path)).digest("hex") !==
        expected
      )
        throw new Error(`Integrity mismatch: ${file}`);
    }
    const kit = dependencyPackage(root, "@narumitw/pi-tui-kit");
    for (const [name, version] of Object.entries(goalIdentity.dependencies)) {
      const dependency =
        name === "@narumitw/pi-tui-kit"
          ? kit
          : dependencyPackage(kit.directory, name);
      assertContained(dependency.directory);
      assertContained(dependency.entry);
      if (
        dependency.manifest.version !== version ||
        !lstatSync(dependency.entry)?.isFile()
      )
        throw new Error(`Invalid dependency: ${name}@${version}`);
    }
    // Resolve peers from Goal itself, not an unrelated top-level installation.
    for (const name of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
      "typebox",
    ]) {
      const dependency = dependencyPackage(root, name);
      assertContained(dependency.directory);
      assertContained(dependency.entry);
      if (
        name.startsWith("@earendil-works/") &&
        dependency.manifest.version !== "1.0.3"
      )
        throw new Error(`Wrong SDK peer: ${name}`);
    }
    return root;
  } catch (error) {
    throw new Error(
      `Invalid isolated @narumitw/pi-goal ${goalIdentity.version} package: ${error.message}`,
      { cause: error },
    );
  }
};

// A whole upstream monorepo is NOT equivalent to this single package. Preserve
// its other resources while excluding Goal; never delete Plan or other tools.
const isUpstreamMonorepo = (source) => {
  const normalized = source
    .trim()
    .replace(/^git:(?!\/\/)/, "")
    .trim()
    .replace(/^git\+/, "")
    .replace(/^github:/, "https://github.com/")
    .replace(/^git@github.com:/, "ssh://git@github.com/");
  const urlText = /^(?:narumiruna\/|github.com\/)/i.test(normalized)
    ? `https://${normalized.startsWith("github.com/") ? "" : "github.com/"}${normalized}`
    : normalized;
  try {
    const url = new URL(urlText);
    return (
      ["https:", "http:", "ssh:", "git:"].includes(url.protocol) &&
      url.hostname.replace(/^www\./, "").toLowerCase() === "github.com" &&
      /^\/narumiruna\/pi-extensions(?:\.git)?(?:[/@]|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
};

export const normalizeGoalPackage = ({
  packages,
  desiredPath,
  settingsBaseDir,
  home,
}) => {
  const selected = resolve(desiredPath);
  const retained = [];
  for (const entry of packages) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") {
      retained.push(entry);
      continue;
    }
    if (/^npm:\s*@narumitw\/pi-goal(?:@[^\s]+)?\s*$/.test(source)) continue;
    if (isUpstreamMonorepo(source)) {
      const filter = typeof entry === "string" ? { source } : entry;
      const exclusion = "!packages/pi-goal/**";
      if (Array.isArray(filter.extensions) && filter.extensions.length === 0) {
        retained.push(entry); // explicit disable-all must not become enable-all
        continue;
      }
      const existing = filter.extensions ?? [];
      // Pi applies +exact-path after glob exclusions. Matching -exact-path
      // overrides it; publish Goal-only exclusions last for ordered deltas too.
      const forceExclusions = existing
        .filter(
          (pattern) =>
            pattern.startsWith("+") &&
            /(?:^|\/)packages\/pi-goal(?:\/|$)/.test(
              pattern.slice(1).replaceAll("\\", "/"),
            ),
        )
        .map((pattern) => `-${pattern.slice(1)}`);
      const controls = new Set([exclusion, ...forceExclusions]);
      retained.push({
        ...filter,
        extensions: [
          ...existing.filter((pattern) => !controls.has(pattern)),
          ...controls,
        ],
      });
      continue;
    }
    if (/^(?:npm:|git:|https?:|ssh:|git@|github:)/.test(source)) {
      retained.push(entry);
      continue;
    }
    let path;
    try {
      path = source.startsWith("file:")
        ? fileURLToPath(source)
        : source === "~"
          ? home
          : source.startsWith("~/")
            ? resolve(home, source.slice(2))
            : resolve(settingsBaseDir, source);
    } catch {
      retained.push(entry);
      continue;
    }
    if (
      path === selected ||
      path === join(selected, "dist/index.ts") ||
      path === join(settingsBaseDir, "npm", "node_modules", goalIdentity.name)
    )
      continue;
    if (path.endsWith("/dist/index.ts")) {
      try {
        if (
          JSON.parse(
            readFileSync(join(dirname(dirname(path)), "package.json"), "utf8"),
          ).name === goalIdentity.name
        )
          continue;
      } catch {
        /* Preserve unrelated extension files. */
      }
    }
    try {
      if (realpathSync(path) === realpathSync(selected)) continue;
    } catch {
      /* Missing local resources are preserved. */
    }
    try {
      if (
        JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name ===
        goalIdentity.name
      )
        continue;
    } catch {
      /* Preserve unavailable unrelated resources. */
    }
    retained.push(entry);
  }
  return [...retained, selected];
};
