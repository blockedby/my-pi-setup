import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * The readiness verifier proves source provenance only. It never rewrites or
 * executes `command`, and it does not make a shell command safe. A sandbox or
 * controller retains execution authority and must enforce execution policy
 * separately.
 */

export const PLANNING_READINESS_MAX_COMMAND_BYTES = 8 * 1024;
export const PLANNING_READINESS_MAX_PURPOSE_BYTES = 2 * 1024;
export const PLANNING_READINESS_MAX_EXCERPT_BYTES = 16 * 1024;
export const PLANNING_READINESS_MAX_SOURCE_BYTES = 256 * 1024;
export const PLANNING_READINESS_MAX_PATH_BYTES = 4 * 1024;

const relativePathSchema = Type.String({
  minLength: 1,
  maxLength: PLANNING_READINESS_MAX_PATH_BYTES,
});

const planningReadinessSourceSchema = Type.Object(
  {
    path: relativePathSchema,
    excerpt: Type.String({
      minLength: 1,
      maxLength: PLANNING_READINESS_MAX_EXCERPT_BYTES,
    }),
  },
  { additionalProperties: false },
);

export const PlanningReadinessCheckSchema = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: PLANNING_READINESS_MAX_COMMAND_BYTES,
    }),
    cwd: relativePathSchema,
    purpose: Type.String({
      minLength: 1,
      maxLength: PLANNING_READINESS_MAX_PURPOSE_BYTES,
    }),
    source: planningReadinessSourceSchema,
  },
  { additionalProperties: false },
);

export const PLANNING_READINESS_CHECK_SCHEMA = PlanningReadinessCheckSchema;

export type PlanningReadinessCheck = Static<
  typeof PlanningReadinessCheckSchema
>;

export const PlanningReadinessVerifiedCheckSchema = Type.Object(
  {
    command: Type.String({
      minLength: 1,
      maxLength: PLANNING_READINESS_MAX_COMMAND_BYTES,
    }),
    cwd: relativePathSchema,
    purpose: Type.String({
      minLength: 1,
      maxLength: PLANNING_READINESS_MAX_PURPOSE_BYTES,
    }),
    source: planningReadinessSourceSchema,
    sourceHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  },
  { additionalProperties: false },
);

export const PLANNING_READINESS_VERIFIED_CHECK_SCHEMA =
  PlanningReadinessVerifiedCheckSchema;

export type PlanningReadinessVerifiedCheck = Static<
  typeof PlanningReadinessVerifiedCheckSchema
>;

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function errorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertRepositoryRelativePath(
  value: string,
  label: string,
  allowRoot: boolean,
) {
  if (byteLength(value) > PLANNING_READINESS_MAX_PATH_BYTES) {
    throw new Error(`${label} exceeds its bounded path size.`);
  }
  if (value === "." && allowRoot) return;
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        // Control characters are explicitly rejected as unsafe path input.
        // eslint-disable-next-line no-control-regex -- intentional security validation.
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
}

function assertTextByteBounds(check: PlanningReadinessCheck) {
  const textFields = [
    ["command", check.command, PLANNING_READINESS_MAX_COMMAND_BYTES],
    ["purpose", check.purpose, PLANNING_READINESS_MAX_PURPOSE_BYTES],
    [
      "source excerpt",
      check.source.excerpt,
      PLANNING_READINESS_MAX_EXCERPT_BYTES,
    ],
  ] as const;
  for (const [label, value, maximum] of textFields) {
    if (!value.trim()) throw new Error(`${label} must not be blank.`);
    if (byteLength(value) > maximum) {
      throw new Error(`${label} exceeds its bounded UTF-8 size.`);
    }
  }
}

function canonicalWorkspaceRoot(workspaceRoot: string) {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error("Planning readiness workspace root must be absolute.");
  }
  const supplied = path.resolve(workspaceRoot);
  let root: string;
  try {
    root = fs.realpathSync.native(supplied);
  } catch (error) {
    throw new Error(
      `Planning readiness workspace root is unavailable: ${errorDetail(error)}`,
      { cause: error },
    );
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch (error) {
    throw new Error(
      `Planning readiness workspace root is unavailable: ${errorDetail(error)}`,
      { cause: error },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error("Planning readiness workspace root must be a directory.");
  }
  return root;
}

function resolveContainedPath(
  root: string,
  relativePath: string,
  label: string,
) {
  const candidate = path.join(root, ...relativePath.split("/"));
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(candidate);
  } catch (error) {
    const detail =
      errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
        ? "path is missing"
        : errorDetail(error);
    throw new Error(
      `Planning readiness ${label} cannot be resolved: ${detail}`,
      {
        cause: error,
      },
    );
  }
  if (!isContained(root, resolved)) {
    throw new Error(
      `Planning readiness ${label} resolves outside the workspace root.`,
    );
  }
  return resolved;
}

function readSourceFile(root: string, sourcePath: string, excerpt: string) {
  const resolved = resolveContainedPath(root, sourcePath, "source");
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(
      `Planning readiness source cannot be inspected: ${errorDetail(error)}`,
      { cause: error },
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Planning readiness source must be a regular file.");
  }
  if (
    !Number.isSafeInteger(stats.size) ||
    stats.size > PLANNING_READINESS_MAX_SOURCE_BYTES
  ) {
    throw new Error(
      `Planning readiness source exceeds ${PLANNING_READINESS_MAX_SOURCE_BYTES} bytes.`,
    );
  }

  let contents: Buffer;
  try {
    contents = fs.readFileSync(resolved);
  } catch (error) {
    throw new Error(
      `Planning readiness source cannot be read: ${errorDetail(error)}`,
      { cause: error },
    );
  }
  if (contents.length > PLANNING_READINESS_MAX_SOURCE_BYTES) {
    throw new Error(
      `Planning readiness source exceeds ${PLANNING_READINESS_MAX_SOURCE_BYTES} bytes.`,
    );
  }
  if (contents.indexOf(Buffer.from(excerpt, "utf8")) === -1) {
    throw new Error(
      "Planning readiness source does not contain the exact excerpt.",
    );
  }
  return { contents, resolved };
}

const BARE_SCRIPT_INVOCATION_PATTERN =
  /^(?:bun|npm|pnpm|yarn) run ([A-Za-z0-9_@%+=:,./-]+)$/u;

function bareScriptName(command: string) {
  const match = BARE_SCRIPT_INVOCATION_PATTERN.exec(command);
  if (!match || match[1].startsWith("-")) return undefined;
  return match[1];
}

function isJsonWhitespace(code: number) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function skipJsonWhitespace(source: string, start: number) {
  let index = start;
  while (index < source.length && isJsonWhitespace(source.charCodeAt(index)))
    index += 1;
  return index;
}

function parseJsonStringToken(source: string, start: number) {
  if (source[start] !== '"') throw new Error("Invalid JSON string token.");
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      const value: unknown = JSON.parse(source.slice(start, index + 1));
      if (typeof value !== "string")
        throw new Error("Invalid JSON string token.");
      return { start, end: index + 1, value };
    }
    if (character.charCodeAt(0) < 0x20)
      throw new Error("Invalid JSON string token.");
  }
  throw new Error("Unterminated JSON string token.");
}

function isJsonValueTerminator(character: string | undefined) {
  return (
    character === undefined ||
    character === "," ||
    character === "]" ||
    character === "}" ||
    isJsonWhitespace(character.charCodeAt(0))
  );
}

function skipJsonValue(source: string, start: number): number {
  const index = skipJsonWhitespace(source, start);
  const character = source[index];
  if (character === '"') return parseJsonStringToken(source, index).end;
  if (character === "{") return parseJsonObjectEntries(source, index).end;
  if (character === "[") return skipJsonArray(source, index);
  for (const literal of ["true", "false", "null"]) {
    if (source.startsWith(literal, index)) return index + literal.length;
  }
  if (character === "-" || (character >= "0" && character <= "9")) {
    let end = index;
    while (!isJsonValueTerminator(source[end])) end += 1;
    return end;
  }
  throw new Error("Invalid JSON value.");
}

function skipJsonArray(source: string, start: number) {
  let index = skipJsonWhitespace(source, start + 1);
  if (source[index] === "]") return index + 1;
  while (index < source.length) {
    index = skipJsonValue(source, index);
    index = skipJsonWhitespace(source, index);
    if (source[index] === ",") {
      index = skipJsonWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === "]") return index + 1;
    throw new Error("Invalid JSON array.");
  }
  throw new Error("Unterminated JSON array.");
}

function parseJsonObjectEntries(source: string, start: number) {
  if (source[start] !== "{") throw new Error("Invalid JSON object.");
  const entries: Array<{
    start: number;
    key: string;
    valueStart: number;
    valueEnd: number;
  }> = [];
  let index = skipJsonWhitespace(source, start + 1);
  if (source[index] === "}") return { end: index + 1, entries };
  while (index < source.length) {
    const key = parseJsonStringToken(source, index);
    index = skipJsonWhitespace(source, key.end);
    if (source[index] !== ":") throw new Error("Invalid JSON object.");
    const valueStart = skipJsonWhitespace(source, index + 1);
    const valueEnd = skipJsonValue(source, valueStart);
    entries.push({
      start: key.start,
      key: key.value,
      valueStart,
      valueEnd,
    });
    index = skipJsonWhitespace(source, valueEnd);
    if (source[index] === ",") {
      index = skipJsonWhitespace(source, index + 1);
      continue;
    }
    if (source[index] === "}") return { end: index + 1, entries };
    throw new Error("Invalid JSON object.");
  }
  throw new Error("Unterminated JSON object.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerptContainsSpan(
  source: string,
  excerpt: string,
  start: number,
  end: number,
) {
  let offset = source.indexOf(excerpt);
  while (offset !== -1) {
    if (offset <= start && offset + excerpt.length >= end) return true;
    offset = source.indexOf(excerpt, offset + 1);
  }
  return false;
}

function confirmsBareScriptInvocation(
  source: string,
  excerpt: string,
  scriptName: string,
  scripts: unknown,
) {
  if (
    !isRecord(scripts) ||
    !Object.prototype.hasOwnProperty.call(scripts, scriptName) ||
    typeof scripts[scriptName] !== "string"
  )
    return false;

  const rootStart = skipJsonWhitespace(source, 0);
  if (source[rootStart] !== "{") return false;
  const rootEntries = parseJsonObjectEntries(source, rootStart).entries;
  const scriptsEntry = rootEntries
    .filter((entry) => entry.key === "scripts")
    .pop();
  if (!scriptsEntry || source[scriptsEntry.valueStart] !== "{") return false;

  const scriptEntries = parseJsonObjectEntries(
    source,
    scriptsEntry.valueStart,
  ).entries;
  const matchingEntry = scriptEntries
    .filter((entry) => entry.key === scriptName)
    .pop();
  if (!matchingEntry || source[matchingEntry.valueStart] !== '"') return false;
  const value = parseJsonStringToken(source, matchingEntry.valueStart);
  if (value.end !== matchingEntry.valueEnd) return false;
  return excerptContainsSpan(
    source,
    excerpt,
    matchingEntry.start,
    matchingEntry.valueEnd,
  );
}

/**
 * Resolve and fingerprint a source-backed readiness check without executing it.
 * The command is copied verbatim from the bounded source excerpt, except for a
 * bare package-script runner whose key/value definition is copied instead;
 * wrapper commands are not inferred. This is provenance evidence, not shell
 * safety: the sandbox/controller remains responsible for deciding whether and
 * how to execute the command.
 */
export function verifyPlanningReadinessSource(
  workspaceRoot: string,
  check: unknown,
) {
  if (!Value.Check(PlanningReadinessCheckSchema, check)) {
    throw new Error(
      "Planning readiness check does not match its strict TypeBox schema.",
    );
  }
  assertTextByteBounds(check);
  assertRepositoryRelativePath(check.cwd, "Planning readiness cwd", true);
  assertRepositoryRelativePath(
    check.source.path,
    "Planning readiness source path",
    false,
  );
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const cwd = resolveContainedPath(root, check.cwd, "cwd");
  let cwdStats: fs.Stats;
  try {
    cwdStats = fs.statSync(cwd);
  } catch (error) {
    throw new Error(
      `Planning readiness cwd cannot be inspected: ${errorDetail(error)}`,
      { cause: error },
    );
  }
  if (!cwdStats.isDirectory()) {
    throw new Error("Planning readiness cwd must resolve to a directory.");
  }

  const { contents, resolved: sourcePath } = readSourceFile(
    root,
    check.source.path,
    check.source.excerpt,
  );
  let commandConfirmed = check.source.excerpt.includes(check.command);
  if (path.basename(check.source.path) === "package.json") {
    const manifest: unknown = JSON.parse(contents.toString("utf8"));
    const scripts =
      typeof manifest === "object" && manifest !== null && "scripts" in manifest
        ? manifest.scripts
        : undefined;
    const scriptName = bareScriptName(check.command);
    const packageJsonAtCwd =
      path.basename(sourcePath) === "package.json" &&
      sourcePath === path.join(cwd, "package.json");
    commandConfirmed =
      isRecord(scripts) &&
      Object.entries(scripts).some(
        ([name, value]) =>
          value === check.command &&
          (scriptName
            ? confirmsBareScriptInvocation(
                contents.toString("utf8"),
                check.source.excerpt,
                name,
                scripts,
              )
            : commandConfirmed ||
              check.source.excerpt.includes(JSON.stringify(check.command))),
      );
    if (!commandConfirmed && scriptName) {
      commandConfirmed =
        packageJsonAtCwd &&
        confirmsBareScriptInvocation(
          contents.toString("utf8"),
          check.source.excerpt,
          scriptName,
          scripts,
        );
    }
  }
  if (!commandConfirmed) {
    throw new Error(
      "Planning readiness source excerpt must contain the exact command from the declared script or repository instructions.",
    );
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  return {
    ...structuredClone(check),
    sourceHash: sha256,
  } satisfies PlanningReadinessVerifiedCheck;
}
