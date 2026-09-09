import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { URL, URLSearchParams } from "node:url";
import * as zlib from "node:zlib";

const MAX_REPOSITORIES = 512;
const MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 1_000_000;
const MAX_CONFIG_VALUE_BYTES = 32 * 1024;
const MAX_CONFIG_VALUES = 128;
const MAX_CONFIG_OUTPUT_BYTES = 512 * 1024;
const MAX_GIT_COMMAND_MS = 30_000;
const MAX_PATH_BYTES = 4 * 1024;
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_OBJECTS = 250_000;
const MAX_OBJECT_BYTES_TOTAL = 512 * 1024 * 1024;
const MAX_TREE_DEPTH = 1024;
const MAX_SPLIT_INDEX_FILES = 32;
const UNSAFE_ORIGIN_ERROR =
  "Readiness Git origin URL contains embedded credentials or secret-bearing metadata.";
const SECRET_ORIGIN_PARAMETER_PARTS = new Set([
  "auth",
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "jwt",
  "key",
  "pass",
  "passwd",
  "password",
  "pwd",
  "secret",
  "sig",
  "signature",
  "token",
]);

const SAFE_CORE_SETTINGS = [
  "filemode",
  "ignorecase",
  "symlinks",
  "precomposeunicode",
  "autocrlf",
  "eol",
  "safecrlf",
  "protecthfs",
  "protectntfs",
  "checkstat",
  "trustctime",
  "ignorestat",
  "fsmonitor",
  "fscache",
  "splitindex",
  "sparsecheckout",
  "untrackedcache",
] as const;

const FORCED_CORE_SETTINGS = new Set([
  "fsmonitor",
  "fscache",
  "splitindex",
  "sparsecheckout",
  "untrackedcache",
]);

type ObjectFormat = "sha1" | "sha256";
type DotGitKind = "directory" | "file";
type GitlinkStatus = "absent" | "uninitialized" | "initialized";

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface IndexStat {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
}

interface IndexEntry {
  readonly path: string;
  readonly pathBytes: Buffer;
  readonly mode: number;
  readonly oid: string;
  readonly stage: number;
  readonly assumeValid: boolean;
  readonly skipWorktree: boolean;
  readonly intentToAdd: boolean;
  readonly stat: IndexStat;
}

interface ParsedIndex {
  readonly version: number;
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly sharedIndexNames: ReadonlyArray<string>;
}

interface IndexCapture {
  readonly raw: Buffer;
  readonly parsed: ParsedIndex;
  readonly shared: ReadonlyMap<string, Buffer>;
  readonly fingerprint: string;
}

interface GitObject {
  readonly oid: string;
  readonly type: "commit" | "tree" | "blob";
  readonly body: Buffer;
}

interface TreeEntry {
  readonly mode: number;
  readonly oid: string;
  readonly name: string;
}

interface RepositoryMetadata {
  readonly key: string;
  readonly worktreeRoot: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly gitDirIdentity: FileIdentity;
  readonly commonGitDirIdentity: FileIdentity;
  readonly indexPath: string;
  readonly objectFormat: ObjectFormat;
  readonly formatVersion: string;
  readonly formatVersionValues: ReadonlyArray<string>;
  readonly extensionEntries: ReadonlyArray<readonly [string, string]>;
  readonly submoduleActiveEntries: ReadonlyArray<readonly [string, string]>;
  readonly headCommit: string;
  readonly headTree: string;
  readonly headFingerprint: string;
  readonly indexFingerprint: string;
  readonly dotGitPath: string;
  readonly dotGitKind: DotGitKind;
  readonly dotGitFingerprint?: string;
  readonly commondirFingerprint?: string;
  readonly originUrls: ReadonlyArray<string>;
  readonly coreSettings: Readonly<Record<string, ReadonlyArray<string>>>;
}

interface GitlinkObservation {
  readonly path: string;
  readonly status: GitlinkStatus;
  readonly childKey?: string;
}

interface InspectedRepository {
  readonly metadata: RepositoryMetadata;
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly sparseTreeOids: ReadonlyArray<string>;
  readonly gitlinks: ReadonlyArray<GitlinkObservation>;
}

interface RepositoryDiscovery {
  readonly repositories: ReadonlyArray<InspectedRepository>;
}

interface SnapshotBudget {
  objectCount: number;
  objectBytes: number;
}

interface OwnedDirectory {
  readonly path: string;
  readonly identity: FileIdentity;
}

interface NormalizeIndexOptions {
  readonly tempRoot: string;
  readonly id: string;
}

interface ObjectReader {
  read(oid: string): GitObject;
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

function errorStatus(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }
  return undefined;
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function objectHashAlgorithm(format: ObjectFormat) {
  return format === "sha1" ? "sha1" : "sha256";
}

function hashLength(format: ObjectFormat) {
  return format === "sha1" ? 20 : 32;
}

function strictUtf8(value: Buffer, label: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
}

function strictAscii(value: Buffer, label: string) {
  for (const byte of value) {
    if (byte > 0x7f) throw new Error(`${label} is not valid ASCII.`);
  }
  return value.toString("ascii");
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

function lstatIfPresent(value: string) {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function fileIdentity(stats: fs.Stats) {
  return { dev: stats.dev, ino: stats.ino } satisfies FileIdentity;
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectory(value: string, label: string) {
  const stats = lstatIfPresent(value);
  if (!stats) throw new Error(`${label} is missing.`);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symbolic-link directory.`);
  }
  return fileIdentity(stats);
}

function assertRegularFile(value: string, label: string, maximum: number) {
  const stats = lstatIfPresent(value);
  if (!stats) throw new Error(`${label} is missing.`);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a non-symbolic-link regular file.`);
  }
  if (!Number.isSafeInteger(stats.size) || stats.size > maximum) {
    throw new Error(`${label} exceeds its bounded size.`);
  }
  return stats;
}

function readRegularFile(value: string, label: string, maximum: number) {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      value,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const before = fs.fstatSync(descriptor);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`${label} must be a regular file.`);
    }
    if (!Number.isSafeInteger(before.size) || before.size > maximum) {
      throw new Error(`${label} exceeds its bounded size.`);
    }
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      !sameIdentity(fileIdentity(before), fileIdentity(after)) ||
      before.size !== after.size ||
      contents.length !== after.size
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return contents;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `))
      throw error;
    throw new Error(`Unable to read ${label}: ${errorDetail(error)}`, {
      cause: error,
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function canonicalDirectory(value: string, label: string) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  const supplied = path.resolve(value);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(supplied);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${errorDetail(error)}`, {
      cause: error,
    });
  }
  assertDirectory(resolved, label);
  return resolved;
}

function canonicalGitPath(value: string, base: string, label: string) {
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(base, value);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(candidate);
  } catch (error) {
    throw new Error(`${label} is unavailable: ${errorDetail(error)}`, {
      cause: error,
    });
  }
  return resolved;
}

function validateRelativeRepositoryPath(value: string, label: string) {
  if (
    value.length === 0 ||
    byteLength(value) > MAX_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded repository-relative path.`);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        // eslint-disable-next-line no-control-regex -- intentional path validation.
        /[\u0000-\u001f\u007f]/u.test(part),
    )
  ) {
    throw new Error(`${label} must be a bounded repository-relative path.`);
  }
  return value;
}

function validateTreeName(value: string, label: string) {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    // eslint-disable-next-line no-control-regex -- intentional path validation.
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} contains an unsupported tree name.`);
  }
  if (byteLength(value) > MAX_PATH_BYTES) {
    throw new Error(`${label} exceeds its bounded path size.`);
  }
  return value;
}

function validateOid(value: string, format: ObjectFormat, label: string) {
  const expectedLength = hashLength(format) * 2;
  if (
    value.length !== expectedLength ||
    !new RegExp(`^[0-9a-f]{${expectedLength}}$`, "u").test(value)
  ) {
    throw new Error(`${label} is not a valid ${format} object id.`);
  }
  return value;
}

function gitEnvironment(overrides: Readonly<Record<string, string>> = {}) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_"))
      environment[key] = value;
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: ":",
  });
  Object.assign(environment, overrides);
  return environment;
}

const SAFE_GIT_OPTIONS = [
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.fscache=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "core.sparseCheckout=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
];

function rawGit(
  cwd: string,
  args: ReadonlyArray<string>,
  options: {
    readonly input?: Buffer;
    readonly environment?: Readonly<Record<string, string>>;
    readonly maxBuffer?: number;
  } = {},
) {
  const common = {
    cwd,
    env: gitEnvironment(options.environment),
    encoding: "buffer" as const,
    maxBuffer: options.maxBuffer ?? MAX_CONFIG_OUTPUT_BYTES,
    timeout: MAX_GIT_COMMAND_MS,
  };
  if (options.input === undefined) {
    return execFileSync("git", [...SAFE_GIT_OPTIONS, ...args], {
      ...common,
      stdio: ["ignore", "pipe", "ignore"],
    });
  }
  return execFileSync("git", [...SAFE_GIT_OPTIONS, ...args], {
    ...common,
    input: options.input,
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function requiredGit(
  cwd: string,
  args: ReadonlyArray<string>,
  label: string,
  options: {
    readonly input?: Buffer;
    readonly environment?: Readonly<Record<string, string>>;
    readonly maxBuffer?: number;
  } = {},
) {
  try {
    return rawGit(cwd, args, options);
  } catch (error) {
    throw new Error(`${label} failed: ${errorDetail(error)}`, {
      cause: error,
    });
  }
}

function optionalGit(
  cwd: string,
  args: ReadonlyArray<string>,
  label: string,
  options: {
    readonly input?: Buffer;
    readonly environment?: Readonly<Record<string, string>>;
    readonly maxBuffer?: number;
  } = {},
) {
  try {
    return rawGit(cwd, args, options);
  } catch (error) {
    if (errorStatus(error) === 1) return undefined;
    throw new Error(`${label} failed: ${errorDetail(error)}`, {
      cause: error,
    });
  }
}

function singleLine(value: Buffer, label: string) {
  const text = strictUtf8(value, label);
  if (text.endsWith("\n")) {
    const withoutNewline = text.slice(0, -1);
    if (withoutNewline.endsWith("\r")) return withoutNewline.slice(0, -1);
    return withoutNewline;
  }
  if (text.includes("\n") || text.includes("\r")) {
    throw new Error(`${label} returned multiple lines.`);
  }
  return text;
}

function nullRecords(value: Buffer, label: string) {
  if (value.length === 0) return [];
  if (value[value.length - 1] !== 0)
    throw new Error(`${label} was not NUL terminated.`);
  const records = strictUtf8(value.subarray(0, -1), label).split("\0");
  return records.map((record) => {
    if (record.includes("\0")) throw new Error(`${label} is malformed.`);
    return record;
  });
}

function boundedConfigValue(value: string, label: string) {
  if (
    byteLength(value) > MAX_CONFIG_VALUE_BYTES ||
    value.includes("\0") ||
    // eslint-disable-next-line no-control-regex -- intentional config validation.
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} exceeds the safe config value bounds.`);
  }
  return value;
}

function isSecretOriginParameterName(value: string) {
  const parts = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .split("_")
    .filter(Boolean);
  if (parts.length === 0) return false;
  if (
    parts.includes("session") &&
    (parts.length === 1 || parts.at(-1) === "id")
  ) {
    return true;
  }
  return parts.some((part) => SECRET_ORIGIN_PARAMETER_PARTS.has(part));
}

function hasSecretOriginParameter(value: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  try {
    for (const [name, candidate] of new URLSearchParams(decoded)) {
      if (
        isSecretOriginParameterName(name) ||
        isSecretOriginParameterName(candidate)
      ) {
        return true;
      }
    }
  } catch {
    return true;
  }
  return false;
}

function validateOriginUrl(value: string) {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/u.exec(value);
  if (!match) return;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(UNSAFE_ORIGIN_ERROR);
  }

  const protocol = match[1].toLowerCase();
  const authority = match[2];
  const atSign = authority.lastIndexOf("@");
  const userInfo = atSign < 0 ? "" : authority.slice(0, atSign);
  const hasUserInfo = atSign >= 0;
  const hasPasswordDelimiter = userInfo.includes(":") || /%3a/iu.test(userInfo);
  const hasCredentials =
    hasUserInfo || parsed.username.length > 0 || parsed.password.length > 0;
  if (
    (protocol === "ssh"
      ? parsed.password.length > 0 || hasPasswordDelimiter
      : hasCredentials) ||
    (parsed.search.length > 0 &&
      hasSecretOriginParameter(parsed.search.slice(1))) ||
    (parsed.hash.length > 0 && hasSecretOriginParameter(parsed.hash.slice(1)))
  ) {
    throw new Error(UNSAFE_ORIGIN_ERROR);
  }
}

function validateOriginUrls(values: ReadonlyArray<string>) {
  for (const value of values) validateOriginUrl(value);
}

function configValues(cwd: string, key: string) {
  const output = optionalGit(
    cwd,
    ["config", "--local", "--no-includes", "--null", "--get-all", key],
    `reading ${key}`,
    { maxBuffer: MAX_CONFIG_OUTPUT_BYTES },
  );
  if (output === undefined) return [];
  const values = nullRecords(output, `config values for ${key}`).map((value) =>
    boundedConfigValue(value, key),
  );
  if (values.length > MAX_CONFIG_VALUES)
    throw new Error(`Config values for ${key} exceed their bounded size.`);
  return values;
}

function configRegexpEntries(
  cwd: string,
  pattern: string,
  label: string,
  preserveKey = false,
) {
  const output = optionalGit(
    cwd,
    ["config", "--local", "--no-includes", "--null", "--get-regexp", pattern],
    label,
    { maxBuffer: MAX_CONFIG_OUTPUT_BYTES },
  );
  if (output === undefined) return [];
  return nullRecords(output, label).map((record) => {
    const separator = record.indexOf("\n");
    if (separator < 1)
      throw new Error(`${label} returned a malformed key/value pair.`);
    const key = record.slice(0, separator);
    const value = boundedConfigValue(record.slice(separator + 1), label);
    return [preserveKey ? key : key.toLowerCase(), value] as const;
  });
}

function parseGitPointer(value: Buffer, label: string) {
  const text = strictUtf8(value, label);
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) throw new Error(`${label} is malformed.`);
  const match = /^gitdir:\s*(\S.*)$/u.exec(lines[0] ?? "");
  if (!match || byteLength(match[1]) > MAX_PATH_BYTES)
    throw new Error(`${label} is malformed.`);
  return match[1];
}

function inspectDotGit(worktreeRoot: string, gitDir: string) {
  const dotGitPath = path.join(worktreeRoot, ".git");
  const stats = lstatIfPresent(dotGitPath);
  if (!stats) throw new Error(`${worktreeRoot} has no .git metadata.`);
  if (stats.isSymbolicLink())
    throw new Error(`${dotGitPath} must not be a symbolic link.`);
  if (stats.isDirectory()) {
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(dotGitPath);
    } catch (error) {
      throw new Error(
        `Unable to resolve ${dotGitPath}: ${errorDetail(error)}`,
        {
          cause: error,
        },
      );
    }
    if (resolved !== gitDir)
      throw new Error(`${dotGitPath} does not identify the active Git dir.`);
    return {
      path: dotGitPath,
      kind: "directory" as const,
      fingerprint: undefined,
    };
  }
  if (!stats.isFile())
    throw new Error(`${dotGitPath} has an unsupported type.`);
  const contents = readRegularFile(
    dotGitPath,
    dotGitPath,
    MAX_CONFIG_VALUE_BYTES,
  );
  const pointer = parseGitPointer(contents, dotGitPath);
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(path.resolve(worktreeRoot, pointer));
  } catch (error) {
    throw new Error(`Unable to resolve ${dotGitPath}: ${errorDetail(error)}`, {
      cause: error,
    });
  }
  if (resolved !== gitDir)
    throw new Error(`${dotGitPath} does not identify the active Git dir.`);
  return {
    path: dotGitPath,
    kind: "file" as const,
    fingerprint: sha256(contents),
  };
}

function sourceConfig(cwd: string, objectFormat: ObjectFormat) {
  const includeEntries = configRegexpEntries(
    cwd,
    "^include",
    "reading local include settings",
  );
  if (includeEntries.length > 0) {
    throw new Error(
      "Local Git config includes are unsupported for readiness snapshots.",
    );
  }

  const extensionEntries = configRegexpEntries(
    cwd,
    "^extensions\\.",
    "reading local Git extensions",
  );
  for (const [key, value] of extensionEntries) {
    if (key === "extensions.worktreeconfig") {
      if (value.toLowerCase() !== "true")
        throw new Error("Unsupported disabled worktree config extension.");
      continue;
    }
    if (key !== "extensions.objectformat") {
      throw new Error(`Unsupported local Git extension: ${key}.`);
    }
    if (value.toLowerCase() !== objectFormat) {
      throw new Error(`Git object format extension disagrees with Git.`);
    }
  }

  const formatValues = configValues(cwd, "core.repositoryformatversion");
  const expectedFormatVersion = objectFormat === "sha256" ? "1" : "0";
  const formatVersion = formatValues.at(-1) ?? "0";
  if (formatVersion !== expectedFormatVersion) {
    throw new Error(
      `Unsupported Git repository format version ${formatVersion}.`,
    );
  }

  const bareValues = configValues(cwd, "core.bare");
  if (bareValues.at(-1)?.toLowerCase() === "true")
    throw new Error(
      "Bare repositories are unsupported for readiness snapshots.",
    );

  const coreSettings: Record<string, ReadonlyArray<string>> = {};
  for (const key of SAFE_CORE_SETTINGS) {
    coreSettings[key] = configValues(cwd, `core.${key}`);
  }

  const originUrls = configValues(cwd, "remote.origin.url");
  if (originUrls.length > MAX_CONFIG_VALUES)
    throw new Error("The origin URL list exceeds its bounded size.");
  validateOriginUrls(originUrls);
  const submoduleActiveEntries = [
    ...configRegexpEntries(
      cwd,
      "^submodule\\.active$",
      "reading submodule active settings",
    ),
    ...configRegexpEntries(
      cwd,
      "^submodule\\..*\\.active$",
      "reading submodule active settings",
      true,
    ),
  ];
  if (submoduleActiveEntries.length > MAX_CONFIG_VALUES)
    throw new Error("Submodule active settings exceed their bounded size.");

  return {
    formatVersion,
    formatVersionValues: formatValues,
    extensionEntries,
    submoduleActiveEntries,
    originUrls,
    coreSettings,
  } satisfies Pick<
    RepositoryMetadata,
    | "formatVersion"
    | "formatVersionValues"
    | "extensionEntries"
    | "submoduleActiveEntries"
    | "originUrls"
    | "coreSettings"
  >;
}

function splitIndexSharedNames(
  index: Buffer,
  format: ObjectFormat,
  parsedEntriesEnd: number,
) {
  const digestLength = hashLength(format);
  const checksumStart = index.length - digestLength;
  const names: string[] = [];
  let offset = parsedEntriesEnd;
  while (offset < checksumStart) {
    if (checksumStart - offset < 8)
      throw new Error("Git index extension header is truncated.");
    const signature = strictAscii(
      index.subarray(offset, offset + 4),
      "Git index extension signature",
    );
    const length = index.readUInt32BE(offset + 4);
    offset += 8;
    if (length > checksumStart - offset)
      throw new Error("Git index extension exceeds its bounded file.");
    const payload = index.subarray(offset, offset + length);
    if (signature === "link") {
      if (payload.length < digestLength)
        throw new Error("Git split-index link extension is truncated.");
      const oid = payload.subarray(0, digestLength).toString("hex");
      names.push(`sharedindex.${oid}`);
    }
    offset += length;
  }
  if (offset !== checksumStart)
    throw new Error("Git index extensions are malformed.");
  if (new Set(names).size !== names.length)
    throw new Error("Git index contains duplicate split-index links.");
  if (names.length > MAX_SPLIT_INDEX_FILES)
    throw new Error("Git index references too many split-index files.");
  return names;
}

function readVarint(value: Buffer, offset: number) {
  let result = 0;
  let count = 0;
  while (true) {
    if (offset >= value.length || count >= 8)
      throw new Error("Git v4 index pathname compression is malformed.");
    const byte = value[offset] ?? 0;
    offset += 1;
    result = result * 128 + (byte & 0x7f);
    if (!Number.isSafeInteger(result))
      throw new Error("Git v4 index pathname compression is too large.");
    count += 1;
    if ((byte & 0x80) === 0) return { value: result, offset };
  }
}

function parseIndex(
  index: Buffer,
  format: ObjectFormat,
  label = "Git index",
  allowSplitPlaceholders = false,
): ParsedIndex {
  const digestLength = hashLength(format);
  if (index.length < 12 + digestLength)
    throw new Error(`${label} is too small.`);
  const checksumStart = index.length - digestLength;
  const expectedChecksum = createHash(objectHashAlgorithm(format))
    .update(index.subarray(0, checksumStart))
    .digest();
  if (!expectedChecksum.equals(index.subarray(checksumStart)))
    throw new Error(`${label} checksum is invalid.`);
  if (index.subarray(0, 4).toString("ascii") !== "DIRC")
    throw new Error(`${label} has an invalid signature.`);
  const version = index.readUInt32BE(4);
  if (![2, 3, 4].includes(version))
    throw new Error(`${label} uses unsupported index version ${version}.`);
  const count = index.readUInt32BE(8);
  if (count > MAX_INDEX_ENTRIES)
    throw new Error(`${label} contains too many entries.`);

  const entries: IndexEntry[] = [];
  let offset = 12;
  let previousPath = Buffer.alloc(0);
  const fixedLength = 40 + digestLength + 2;
  for (let entryNumber = 0; entryNumber < count; entryNumber += 1) {
    const entryStart = offset;
    if (offset + fixedLength > checksumStart)
      throw new Error(`${label} entry ${entryNumber} is truncated.`);
    const stat: IndexStat = {
      ctimeSeconds: index.readUInt32BE(offset),
      ctimeNanoseconds: index.readUInt32BE(offset + 4),
      mtimeSeconds: index.readUInt32BE(offset + 8),
      mtimeNanoseconds: index.readUInt32BE(offset + 12),
      dev: index.readUInt32BE(offset + 16),
      ino: index.readUInt32BE(offset + 20),
      uid: index.readUInt32BE(offset + 28),
      gid: index.readUInt32BE(offset + 32),
      size: index.readUInt32BE(offset + 36),
    };
    const mode = index.readUInt32BE(offset + 24);
    const oid = index
      .subarray(offset + 40, offset + 40 + digestLength)
      .toString("hex");
    const flags = index.readUInt16BE(offset + 40 + digestLength);
    offset += fixedLength;
    const hasExtendedFlags = (flags & 0x4000) !== 0;
    const extendedFlags = hasExtendedFlags ? index.readUInt16BE(offset) : 0;
    if (hasExtendedFlags) offset += 2;
    if ((extendedFlags & ~0x6000) !== 0)
      throw new Error(`${label} uses unsupported extended entry flags.`);

    let pathBytes: Buffer;
    if (version === 4) {
      const removed = readVarint(index, offset);
      offset = removed.offset;
      const nul = index.indexOf(0, offset);
      if (nul < 0 || nul > checksumStart)
        throw new Error(`${label} v4 pathname is unterminated.`);
      if (removed.value > previousPath.length)
        throw new Error(`${label} v4 pathname prefix is invalid.`);
      pathBytes = Buffer.concat([
        previousPath.subarray(0, previousPath.length - removed.value),
        index.subarray(offset, nul),
      ]);
      offset = nul + 1;
    } else {
      const nul = index.indexOf(0, offset);
      if (nul < 0 || nul > checksumStart)
        throw new Error(`${label} pathname is unterminated.`);
      pathBytes = index.subarray(offset, nul);
      offset = nul + 1;
      const consumed = offset - entryStart;
      offset = entryStart + ((consumed + 7) & ~7);
    }
    const splitPlaceholder = allowSplitPlaceholders && pathBytes.length === 0;
    if (!splitPlaceholder && (pathBytes.length === 0 || pathBytes.includes(0)))
      throw new Error(`${label} contains an empty pathname.`);
    if (
      !splitPlaceholder &&
      (flags & 0x0fff) !== 0x0fff &&
      (flags & 0x0fff) !== pathBytes.length
    ) {
      throw new Error(`${label} pathname length flag is invalid.`);
    }
    const entryPath = strictUtf8(pathBytes, `${label} pathname`);
    if (!splitPlaceholder && mode === 0o40000 && entryPath.endsWith("/")) {
      validateRelativeRepositoryPath(
        entryPath.slice(0, -1),
        `${label} sparse directory pathname`,
      );
    } else if (!splitPlaceholder) {
      validateRelativeRepositoryPath(entryPath, `${label} pathname`);
    }
    previousPath = Buffer.from(pathBytes);
    entries.push({
      path: entryPath,
      pathBytes: Buffer.from(pathBytes),
      mode,
      oid,
      stage: (flags >>> 12) & 0x3,
      assumeValid: (flags & 0x8000) !== 0,
      skipWorktree: (extendedFlags & 0x4000) !== 0,
      intentToAdd: (extendedFlags & 0x2000) !== 0,
      stat,
    });
    if (offset > checksumStart)
      throw new Error(`${label} entry ${entryNumber} exceeds its file.`);
  }

  const sharedIndexNames = splitIndexSharedNames(index, format, offset);
  return { version, entries, sharedIndexNames };
}

function sourceIndexFingerprint(
  indexPath: string,
  format: ObjectFormat,
): IndexCapture {
  const raw = readRegularFile(indexPath, indexPath, MAX_INDEX_BYTES);
  const parsed = parseIndex(raw, format, indexPath, true);
  const shared = new Map<string, Buffer>();
  let indexBytes = raw.length;
  const fingerprint = createHash("sha256");
  fingerprint.update("readiness-index\0");
  fingerprint.update(raw);
  for (const name of [...parsed.sharedIndexNames].sort()) {
    const sharedPath = path.join(path.dirname(indexPath), name);
    const contents = readRegularFile(sharedPath, sharedPath, MAX_INDEX_BYTES);
    indexBytes += contents.length;
    if (indexBytes > MAX_INDEX_BYTES)
      throw new Error(
        `${indexPath} and its split indexes exceed their bounded size.`,
      );
    parseIndex(contents, format, sharedPath);
    shared.set(name, contents);
    fingerprint.update(name);
    fingerprint.update("\0");
    fingerprint.update(contents);
  }
  return {
    raw,
    parsed,
    shared,
    fingerprint: fingerprint.digest("hex"),
  };
}

function zeroIndexStat() {
  return {
    ctimeSeconds: 0,
    ctimeNanoseconds: 0,
    mtimeSeconds: 0,
    mtimeNanoseconds: 0,
    dev: 0,
    ino: 0,
    uid: 0,
    gid: 0,
    size: 0,
  } satisfies IndexStat;
}

function parseTreeBody(body: Buffer, format: ObjectFormat, label: string) {
  const digestLength = hashLength(format);
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) throw new Error(`${label} has a malformed mode.`);
    const modeText = strictAscii(
      body.subarray(offset, space),
      `${label} tree mode`,
    );
    if (!/^[0-7]+$/u.test(modeText))
      throw new Error(`${label} has an invalid tree mode.`);
    const mode = Number.parseInt(modeText, 8);
    const nul = body.indexOf(0, space + 1);
    if (nul < 0) throw new Error(`${label} has an unterminated tree name.`);
    const name = validateTreeName(
      strictUtf8(body.subarray(space + 1, nul), `${label} tree name`),
      label,
    );
    if (names.has(name)) throw new Error(`${label} has duplicate tree names.`);
    names.add(name);
    const oidStart = nul + 1;
    if (oidStart + digestLength > body.length)
      throw new Error(`${label} has a truncated tree object id.`);
    const oid = body
      .subarray(oidStart, oidStart + digestLength)
      .toString("hex");
    validateOid(oid, format, `${label} tree object id`);
    offset = oidStart + digestLength;
    if (
      mode !== 0o40000 &&
      mode !== 0o160000 &&
      mode !== 0o100644 &&
      mode !== 0o100755 &&
      mode !== 0o120000
    ) {
      throw new Error(`${label} uses unsupported tree mode ${modeText}.`);
    }
    entries.push({ mode, oid, name });
  }
  return entries;
}

function createObjectReader(
  repository: RepositoryMetadata,
  budget: SnapshotBudget,
): ObjectReader {
  const cache = new Map<string, GitObject>();
  return {
    read(oid) {
      validateOid(oid, repository.objectFormat, "Git object id");
      const cached = cache.get(oid);
      if (cached) return cached;
      if (budget.objectCount >= MAX_OBJECTS)
        throw new Error(
          "Readiness Git snapshot object count exceeded its limit.",
        );
      const output = requiredGit(
        repository.worktreeRoot,
        ["cat-file", "--batch"],
        `reading Git object ${oid}`,
        {
          input: Buffer.from(`${oid}\n`, "ascii"),
          maxBuffer: MAX_OBJECT_BYTES + 16 * 1024,
        },
      );
      const headerEnd = output.indexOf(0x0a);
      if (headerEnd < 0) throw new Error("Git cat-file returned no header.");
      const header = strictAscii(
        output.subarray(0, headerEnd),
        "Git cat-file header",
      );
      const parts = header.split(" ");
      if (parts.length !== 3 || parts[0] !== oid)
        throw new Error("Git cat-file returned a mismatched object header.");
      if (parts[1] !== "commit" && parts[1] !== "tree" && parts[1] !== "blob")
        throw new Error(`Git object ${oid} has unsupported type ${parts[1]}.`);
      const size = Number(parts[2]);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES)
        throw new Error(`Git object ${oid} exceeds its bounded size.`);
      const bodyStart = headerEnd + 1;
      const bodyEnd = bodyStart + size;
      if (bodyEnd >= output.length || output[bodyEnd] !== 0x0a)
        throw new Error(`Git object ${oid} is truncated.`);
      if (output.length !== bodyEnd + 1)
        throw new Error(`Git cat-file returned unexpected trailing data.`);
      const body = Buffer.from(output.subarray(bodyStart, bodyEnd));
      const expectedOid = createHash(
        objectHashAlgorithm(repository.objectFormat),
      )
        .update(`${parts[1]} ${size}\0`)
        .update(body)
        .digest("hex");
      if (expectedOid !== oid)
        throw new Error(`Git object ${oid} failed its content hash check.`);
      budget.objectCount += 1;
      budget.objectBytes += body.length;
      if (budget.objectBytes > MAX_OBJECT_BYTES_TOTAL)
        throw new Error(
          "Readiness Git snapshot object data exceeded its limit.",
        );
      const object = {
        oid,
        type: parts[1],
        body,
      } satisfies GitObject;
      cache.set(oid, object);
      return object;
    },
  };
}

function joinRepositoryPath(prefix: string, name: string) {
  const joined = prefix.length === 0 ? name : `${prefix}/${name}`;
  return validateRelativeRepositoryPath(joined, "Git tree pathname");
}

function expandTreeLeaves(
  reader: ObjectReader,
  oid: string,
  format: ObjectFormat,
  prefix: string,
  depth = 0,
): ReadonlyArray<{
  readonly path: string;
  readonly pathBytes: Buffer;
  readonly mode: number;
  readonly oid: string;
}> {
  if (depth > MAX_TREE_DEPTH)
    throw new Error("Git tree nesting exceeds its bounded depth.");
  const object = reader.read(oid);
  if (object.type !== "tree")
    throw new Error(`Git object ${oid} is not a tree.`);
  const entries = parseTreeBody(object.body, format, `Git tree ${oid}`);
  const leaves: Array<{
    readonly path: string;
    readonly pathBytes: Buffer;
    readonly mode: number;
    readonly oid: string;
  }> = [];
  for (const entry of entries) {
    const entryPath = joinRepositoryPath(prefix, entry.name);
    if (entry.mode === 0o40000) {
      leaves.push(
        ...expandTreeLeaves(reader, entry.oid, format, entryPath, depth + 1),
      );
      continue;
    }
    leaves.push({
      path: entryPath,
      pathBytes: Buffer.from(entryPath, "utf8"),
      mode: entry.mode,
      oid: entry.oid,
    });
  }
  return leaves;
}

function isSparseDirectory(entry: IndexEntry) {
  return entry.mode === 0o40000 && entry.path.endsWith("/");
}

function normalizedIndexEntries(
  repository: RepositoryMetadata,
  capture: IndexCapture,
  options: NormalizeIndexOptions,
  reader: ObjectReader,
) {
  const indexDirectory = path.join(options.tempRoot, "indexes");
  fs.mkdirSync(indexDirectory, { recursive: true, mode: 0o700 });
  const temporaryIndex = path.join(indexDirectory, `${options.id}.index`);
  fs.writeFileSync(temporaryIndex, capture.raw, { mode: 0o600 });
  for (const [name, contents] of capture.shared) {
    fs.writeFileSync(path.join(indexDirectory, name), contents, {
      mode: 0o600,
    });
  }
  requiredGit(
    repository.worktreeRoot,
    [
      "update-index",
      "--no-split-index",
      "--no-fsmonitor",
      "--no-untracked-cache",
      "--index-version=2",
      "--force-write-index",
    ],
    `normalizing the index for ${repository.key || "the root repository"}`,
    { environment: { GIT_INDEX_FILE: temporaryIndex } },
  );
  const normalized = readRegularFile(
    temporaryIndex,
    temporaryIndex,
    MAX_INDEX_BYTES,
  );
  const parsed = parseIndex(
    normalized,
    repository.objectFormat,
    temporaryIndex,
  );
  const entries: IndexEntry[] = [];
  const sparseTreeOids: string[] = [];
  for (const entry of parsed.entries) {
    if (!isSparseDirectory(entry)) {
      if (entry.mode === 0o40000)
        throw new Error("A non-sparse Git index contains a directory entry.");
      entries.push(entry);
      if (entries.length > MAX_INDEX_ENTRIES)
        throw new Error("Normalized Git index contains too many entries.");
      continue;
    }
    sparseTreeOids.push(entry.oid);
    const prefix = entry.path.slice(0, -1);
    const leaves = expandTreeLeaves(
      reader,
      entry.oid,
      repository.objectFormat,
      prefix,
    );
    for (const leaf of leaves) {
      entries.push({
        path: leaf.path,
        pathBytes: leaf.pathBytes,
        mode: leaf.mode,
        oid: leaf.oid,
        stage: 0,
        assumeValid: entry.assumeValid,
        skipWorktree: entry.skipWorktree,
        intentToAdd: false,
        stat: zeroIndexStat(),
      });
      if (entries.length > MAX_INDEX_ENTRIES)
        throw new Error("Normalized Git index contains too many entries.");
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.path}\0${entry.stage}`;
    if (seen.has(key))
      throw new Error(`Git index contains duplicate entry ${entry.path}.`);
    seen.add(key);
  }
  return { entries, sparseTreeOids };
}

function metadataForRepository(
  worktreeRoot: string,
  key: string,
  format: ObjectFormat,
  gitDir: string,
  commonGitDir: string,
  indexPath: string,
  headFile: Buffer,
  headCommit: string,
  headTree: string,
  dotGit: ReturnType<typeof inspectDotGit>,
  commondirFingerprint: string | undefined,
  config: ReturnType<typeof sourceConfig>,
  index: IndexCapture,
) {
  return {
    key,
    worktreeRoot,
    gitDir,
    commonGitDir,
    gitDirIdentity: fileIdentity(fs.statSync(gitDir)),
    commonGitDirIdentity: fileIdentity(fs.statSync(commonGitDir)),
    indexPath,
    objectFormat: format,
    formatVersion: config.formatVersion,
    formatVersionValues: config.formatVersionValues,
    extensionEntries: config.extensionEntries,
    submoduleActiveEntries: config.submoduleActiveEntries,
    headCommit,
    headTree,
    headFingerprint: sha256(headFile),
    indexFingerprint: index.fingerprint,
    dotGitPath: dotGit.path,
    dotGitKind: dotGit.kind,
    ...(dotGit.fingerprint === undefined
      ? {}
      : { dotGitFingerprint: dotGit.fingerprint }),
    ...(commondirFingerprint === undefined ? {} : { commondirFingerprint }),
    originUrls: config.originUrls,
    coreSettings: config.coreSettings,
  } satisfies RepositoryMetadata;
}

function inspectRepository(
  worktreeRoot: string,
  key: string,
  temporaryRoot: string,
  id: string,
  budget: SnapshotBudget,
) {
  const insideWorkTree = singleLine(
    requiredGit(
      worktreeRoot,
      ["rev-parse", "--is-inside-work-tree"],
      `checking the worktree for ${key || "the root repository"}`,
    ),
    "Git worktree status",
  );
  if (insideWorkTree !== "true")
    throw new Error(`${worktreeRoot} is not a non-bare Git worktree.`);

  const topLevel = canonicalGitPath(
    singleLine(
      requiredGit(
        worktreeRoot,
        ["rev-parse", "--show-toplevel"],
        `reading the top level for ${key || "the root repository"}`,
      ),
      "Git top level",
    ),
    worktreeRoot,
    "Git top level",
  );
  if (topLevel !== worktreeRoot)
    throw new Error(`Git top level does not match ${worktreeRoot}.`);

  const gitDir = canonicalGitPath(
    singleLine(
      requiredGit(
        worktreeRoot,
        ["rev-parse", "--absolute-git-dir"],
        `reading the Git dir for ${key || "the root repository"}`,
      ),
      "Git dir",
    ),
    worktreeRoot,
    "Git dir",
  );
  const commonGitDir = canonicalGitPath(
    singleLine(
      requiredGit(
        worktreeRoot,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        `reading the common Git dir for ${key || "the root repository"}`,
      ),
      "Common Git dir",
    ),
    worktreeRoot,
    "Common Git dir",
  );
  const gitDirIdentity = assertDirectory(gitDir, "Active Git dir");
  const commonGitDirIdentity = assertDirectory(commonGitDir, "Common Git dir");
  if (gitDir !== commonGitDir && !isContained(commonGitDir, gitDir)) {
    throw new Error("Git dir is outside its common Git dir.");
  }
  if (gitDir !== commonGitDir) {
    const commondirPath = path.join(gitDir, "commondir");
    assertRegularFile(commondirPath, commondirPath, MAX_CONFIG_VALUE_BYTES);
  }
  const dotGit = inspectDotGit(worktreeRoot, gitDir);
  const commondirFingerprint =
    gitDir === commonGitDir
      ? undefined
      : sha256(
          readRegularFile(
            path.join(gitDir, "commondir"),
            path.join(gitDir, "commondir"),
            MAX_CONFIG_VALUE_BYTES,
          ),
        );

  const formatText = singleLine(
    requiredGit(
      worktreeRoot,
      ["rev-parse", "--show-object-format=storage"],
      `reading the object format for ${key || "the root repository"}`,
    ),
    "Git object format",
  );
  if (formatText !== "sha1" && formatText !== "sha256")
    throw new Error(`Unsupported Git object format ${formatText}.`);
  const format = formatText satisfies ObjectFormat;

  const headFile = readRegularFile(
    path.join(gitDir, "HEAD"),
    path.join(gitDir, "HEAD"),
    MAX_CONFIG_VALUE_BYTES,
  );
  const headCommit = validateOid(
    singleLine(
      requiredGit(
        worktreeRoot,
        ["rev-parse", "--verify", "HEAD^{commit}"],
        `reading HEAD for ${key || "the root repository"}`,
      ),
      "Git HEAD",
    ),
    format,
    "Git HEAD",
  );
  const headTree = validateOid(
    singleLine(
      requiredGit(
        worktreeRoot,
        ["rev-parse", "--verify", "HEAD^{tree}"],
        `reading the HEAD tree for ${key || "the root repository"}`,
      ),
      "Git HEAD tree",
    ),
    format,
    "Git HEAD tree",
  );

  const indexPath = canonicalGitPath(
    singleLine(
      requiredGit(
        worktreeRoot,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        `reading the index path for ${key || "the root repository"}`,
      ),
      "Git index",
    ),
    worktreeRoot,
    "Git index",
  );
  if (!isContained(gitDir, indexPath) || path.basename(indexPath) !== "index")
    throw new Error("Git index is outside the active Git dir.");
  const index = sourceIndexFingerprint(indexPath, format);
  const config = sourceConfig(worktreeRoot, format);
  const metadata = {
    ...metadataForRepository(
      worktreeRoot,
      key,
      format,
      gitDir,
      commonGitDir,
      indexPath,
      headFile,
      headCommit,
      headTree,
      dotGit,
      commondirFingerprint,
      config,
      index,
    ),
    gitDirIdentity,
    commonGitDirIdentity,
  } satisfies RepositoryMetadata;
  const reader = createObjectReader(metadata, budget);
  const normalized = normalizedIndexEntries(
    metadata,
    index,
    { tempRoot: temporaryRoot, id },
    reader,
  );
  const gitlinks = normalized.entries
    .filter((entry) => entry.mode === 0o160000)
    .reduce<IndexEntry[]>((selected, entry) => {
      if (
        !selected.some(
          (existing) =>
            existing.path === entry.path && existing.stage === entry.stage,
        )
      )
        selected.push(entry);
      return selected;
    }, []);
  for (const entry of gitlinks) {
    validateOid(entry.oid, format, `Gitlink ${entry.path}`);
  }
  return {
    metadata,
    entries: normalized.entries,
    sparseTreeOids: normalized.sparseTreeOids,
    gitlinks,
  } satisfies Omit<InspectedRepository, "gitlinks"> & {
    readonly gitlinks: ReadonlyArray<IndexEntry>;
  };
}

function submoduleLocation(
  parent: Pick<InspectedRepository, "metadata">,
  relativePath: string,
  childKey: string,
) {
  validateRelativeRepositoryPath(relativePath, "Gitlink path");
  const candidate = path.resolve(
    parent.metadata.worktreeRoot,
    ...relativePath.split("/"),
  );
  if (!isContained(parent.metadata.worktreeRoot, candidate))
    throw new Error("Gitlink path escapes its worktree.");
  const stats = lstatIfPresent(candidate);
  if (!stats) {
    return {
      path: relativePath,
      status: "absent" as const,
    } satisfies GitlinkObservation;
  }
  if (stats.isSymbolicLink())
    throw new Error(
      `Initialized Gitlink ${relativePath} must not be a symlink.`,
    );
  if (!stats.isDirectory()) {
    return {
      path: relativePath,
      status: "uninitialized" as const,
    } satisfies GitlinkObservation;
  }
  const resolved = canonicalDirectory(candidate, `Gitlink ${relativePath}`);
  if (!isContained(parent.metadata.worktreeRoot, resolved))
    throw new Error(`Gitlink ${relativePath} escapes its worktree.`);
  const dotGit = lstatIfPresent(path.join(resolved, ".git"));
  if (!dotGit) {
    return {
      path: relativePath,
      status: "uninitialized" as const,
    } satisfies GitlinkObservation;
  }
  if (dotGit.isSymbolicLink())
    throw new Error(`Gitlink ${relativePath} has a symbolic .git path.`);
  if (!dotGit.isFile() && !dotGit.isDirectory())
    throw new Error(`Gitlink ${relativePath} has an unsupported .git path.`);
  return {
    path: relativePath,
    status: "initialized" as const,
    childKey,
    worktreeRoot: resolved,
  };
}

function discoveryWithLinks(
  workspaceRoot: string,
  temporaryRoot: string,
  budget: SnapshotBudget,
) {
  const repositories: InspectedRepository[] = [];
  const queue: Array<{ readonly worktreeRoot: string; readonly key: string }> =
    [{ worktreeRoot: workspaceRoot, key: "" }];
  const seenKeys = new Set<string>();
  const seenWorktrees = new Set<string>();
  let nextId = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (seenKeys.has(current.key))
      throw new Error(`Duplicate Git repository key ${current.key}.`);
    seenKeys.add(current.key);
    if (seenWorktrees.has(current.worktreeRoot))
      throw new Error("A Git worktree is referenced by multiple gitlinks.");
    seenWorktrees.add(current.worktreeRoot);
    if (repositories.length >= MAX_REPOSITORIES)
      throw new Error("Readiness Git repository count exceeded its limit.");

    const inspected = inspectRepository(
      current.worktreeRoot,
      current.key,
      temporaryRoot,
      `repo-${nextId}`,
      budget,
    );
    nextId += 1;
    const linkObservations: GitlinkObservation[] = [];
    const linkPaths = new Set<string>();
    for (const entry of inspected.gitlinks) {
      if (linkPaths.has(entry.path)) continue;
      linkPaths.add(entry.path);
      const childKey =
        current.key.length === 0 ? entry.path : `${current.key}/${entry.path}`;
      const observation = submoduleLocation(inspected, entry.path, childKey);
      linkObservations.push(observation);
      if (observation.status === "initialized") {
        if (!observation.childKey || !observation.worktreeRoot)
          throw new Error("Initialized Gitlink is missing its child identity.");
        queue.push({
          worktreeRoot: observation.worktreeRoot,
          key: observation.childKey,
        });
      }
    }
    repositories.push({
      ...inspected,
      gitlinks: linkObservations,
    });
  }
  return { repositories } satisfies RepositoryDiscovery;
}

function compareStringArrays(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function comparePairs(
  left: ReadonlyArray<readonly [string, string]>,
  right: ReadonlyArray<readonly [string, string]>,
) {
  return compareStringArrays(
    left.map(([key, value]) => `${key}\0${value}`),
    right.map(([key, value]) => `${key}\0${value}`),
  );
}

function compareCoreSettings(
  left: Readonly<Record<string, ReadonlyArray<string>>>,
  right: Readonly<Record<string, ReadonlyArray<string>>>,
) {
  const keys = Object.keys(left);
  return (
    compareStringArrays(keys, Object.keys(right)) &&
    keys.every((key) => compareStringArrays(left[key] ?? [], right[key] ?? []))
  );
}

function sameMetadata(left: RepositoryMetadata, right: RepositoryMetadata) {
  return (
    left.key === right.key &&
    left.worktreeRoot === right.worktreeRoot &&
    left.gitDir === right.gitDir &&
    left.commonGitDir === right.commonGitDir &&
    sameIdentity(left.gitDirIdentity, right.gitDirIdentity) &&
    sameIdentity(left.commonGitDirIdentity, right.commonGitDirIdentity) &&
    left.indexPath === right.indexPath &&
    left.objectFormat === right.objectFormat &&
    left.formatVersion === right.formatVersion &&
    compareStringArrays(left.formatVersionValues, right.formatVersionValues) &&
    comparePairs(left.extensionEntries, right.extensionEntries) &&
    left.headCommit === right.headCommit &&
    left.headTree === right.headTree &&
    left.headFingerprint === right.headFingerprint &&
    left.indexFingerprint === right.indexFingerprint &&
    left.dotGitPath === right.dotGitPath &&
    left.dotGitKind === right.dotGitKind &&
    left.dotGitFingerprint === right.dotGitFingerprint &&
    left.commondirFingerprint === right.commondirFingerprint &&
    compareStringArrays(left.originUrls, right.originUrls) &&
    comparePairs(left.submoduleActiveEntries, right.submoduleActiveEntries) &&
    compareCoreSettings(left.coreSettings, right.coreSettings)
  );
}

function linkSignature(link: GitlinkObservation) {
  return `${link.path}\0${link.status}\0${link.childKey ?? ""}`;
}

function assertDiscoveryUnchanged(
  expected: RepositoryDiscovery,
  current: RepositoryDiscovery,
) {
  const expectedByKey = new Map(
    expected.repositories.map((repository) => [
      repository.metadata.key,
      repository,
    ]),
  );
  const currentByKey = new Map(
    current.repositories.map((repository) => [
      repository.metadata.key,
      repository,
    ]),
  );
  if (expectedByKey.size !== currentByKey.size) {
    throw new Error("Readiness Git repository initialization changed.");
  }
  for (const [key, expectedRepository] of expectedByKey) {
    const currentRepository = currentByKey.get(key);
    if (!currentRepository)
      throw new Error("Readiness Git repository initialization changed.");
    if (!sameMetadata(expectedRepository.metadata, currentRepository.metadata))
      throw new Error("Readiness Git metadata changed during the command.");
    if (
      !compareStringArrays(
        expectedRepository.gitlinks.map(linkSignature),
        currentRepository.gitlinks.map(linkSignature),
      )
    ) {
      throw new Error("Readiness Git submodule initialization changed.");
    }
  }
}

function writeOwnedFile(
  value: string,
  contents: Buffer | string,
  mode = 0o444,
) {
  fs.writeFileSync(value, contents, { flag: "wx", mode });
  fs.chmodSync(value, mode);
}

function mkdirOwned(value: string, mode = 0o700) {
  fs.mkdirSync(value, { recursive: true, mode });
  const stats = lstatIfPresent(value);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`Snapshot path ${value} is not an owned directory.`);
  fs.chmodSync(value, mode);
}

function makeReadOnlyTree(value: string) {
  const stats = lstatIfPresent(value);
  if (!stats || stats.isSymbolicLink())
    throw new Error(`Snapshot path ${value} is not a regular owned path.`);
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(value, { withFileTypes: true })) {
      makeReadOnlyTree(path.join(value, entry.name));
    }
    fs.chmodSync(value, 0o555);
    return;
  }
  if (!stats.isFile())
    throw new Error(`Snapshot path ${value} has an unsupported type.`);
  fs.chmodSync(value, 0o444);
}

function makeWritableTree(value: string) {
  const stats = lstatIfPresent(value);
  if (!stats || stats.isSymbolicLink())
    throw new Error(`Snapshot path ${value} is not a regular owned path.`);
  if (stats.isDirectory()) {
    fs.chmodSync(value, 0o700);
    for (const entry of fs.readdirSync(value, { withFileTypes: true })) {
      makeWritableTree(path.join(value, entry.name));
    }
    return;
  }
  if (!stats.isFile())
    throw new Error(`Snapshot path ${value} has an unsupported type.`);
  fs.chmodSync(value, 0o600);
}

function looseObjectPath(snapshotGitDir: string, oid: string) {
  return path.join(snapshotGitDir, "objects", oid.slice(0, 2), oid.slice(2));
}

function createObjectStore(
  repository: InspectedRepository,
  snapshotGitDir: string,
  budget: SnapshotBudget,
) {
  const reader = createObjectReader(repository.metadata, budget);
  const objects = new Map<string, GitObject>();
  const excluded = new Set<string>();
  const expandedTrees = new Set<string>();

  const exclude = (oid: string) => {
    validateOid(oid, repository.metadata.objectFormat, "Gitlink object id");
    excluded.add(oid);
    objects.delete(oid);
  };

  const add = (oid: string, expectedType: GitObject["type"]) => {
    validateOid(oid, repository.metadata.objectFormat, "Git object id");
    if (excluded.has(oid)) return undefined;
    const existing = objects.get(oid);
    if (existing) {
      if (existing.type !== expectedType)
        throw new Error(`Git object ${oid} has an unexpected type.`);
      return existing;
    }
    const object = reader.read(oid);
    if (object.type !== expectedType)
      throw new Error(`Git object ${oid} is not a ${expectedType}.`);
    objects.set(oid, object);
    return object;
  };

  const addTree = (oid: string, depth = 0) => {
    if (excluded.has(oid)) return [] as ReadonlyArray<TreeEntry>;
    const object = add(oid, "tree");
    if (!object) return [] as ReadonlyArray<TreeEntry>;
    if (expandedTrees.has(oid))
      return parseTreeBody(
        object.body,
        repository.metadata.objectFormat,
        `Git tree ${oid}`,
      );
    if (depth > MAX_TREE_DEPTH)
      throw new Error("Git tree nesting exceeds its bounded depth.");
    expandedTrees.add(oid);
    const entries = parseTreeBody(
      object.body,
      repository.metadata.objectFormat,
      `Git tree ${oid}`,
    );
    for (const entry of entries) {
      if (entry.mode === 0o40000) {
        addTree(entry.oid, depth + 1);
      } else if (entry.mode === 0o160000) {
        exclude(entry.oid);
      } else {
        add(entry.oid, "blob");
      }
    }
    return entries;
  };

  for (const entry of repository.entries) {
    if (entry.mode === 0o160000) exclude(entry.oid);
  }
  add(repository.metadata.headCommit, "commit");
  addTree(repository.metadata.headTree);
  for (const oid of repository.sparseTreeOids) addTree(oid);
  for (const entry of repository.entries) {
    if (entry.mode === 0o160000) continue;
    if (entry.mode === 0 && /^0+$/u.test(entry.oid)) {
      if (!entry.intentToAdd)
        throw new Error(
          `Git index has an unexpected empty entry ${entry.path}.`,
        );
      continue;
    }
    if (
      entry.mode !== 0o100644 &&
      entry.mode !== 0o100755 &&
      entry.mode !== 0o120000
    ) {
      throw new Error(`Git index uses unsupported mode for ${entry.path}.`);
    }
    add(entry.oid, "blob");
  }

  return {
    write() {
      for (const object of objects.values()) {
        if (excluded.has(object.oid)) continue;
        const header = Buffer.from(
          `${object.type} ${object.body.length}\0`,
          "ascii",
        );
        const compressed = zlib.deflateSync(
          Buffer.concat([header, object.body]),
        );
        if (compressed.length > MAX_OBJECT_BYTES)
          throw new Error("Compressed Git object exceeds its bounded size.");
        const destination = looseObjectPath(snapshotGitDir, object.oid);
        mkdirOwned(path.dirname(destination));
        writeOwnedFile(destination, compressed);
      }
    },
  };
}

function compareIndexEntriesForWrite(left: IndexEntry, right: IndexEntry) {
  const pathComparison = Buffer.compare(left.pathBytes, right.pathBytes);
  return pathComparison !== 0 ? pathComparison : left.stage - right.stage;
}

function writeIndex(entries: ReadonlyArray<IndexEntry>, format: ObjectFormat) {
  const sorted = [...entries].sort(compareIndexEntriesForWrite);
  const digestLength = hashLength(format);
  const chunks: Buffer[] = [];
  let totalLength = 12 + digestLength;
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  chunks.push(header);
  for (const entry of sorted) {
    validateRelativeRepositoryPath(entry.path, "Snapshot index pathname");
    validateOid(entry.oid, format, `Snapshot index entry ${entry.path}`);
    const fixed = Buffer.alloc(40 + digestLength + 2);
    fixed.writeUInt32BE(entry.stat.ctimeSeconds >>> 0, 0);
    fixed.writeUInt32BE(entry.stat.ctimeNanoseconds >>> 0, 4);
    fixed.writeUInt32BE(entry.stat.mtimeSeconds >>> 0, 8);
    fixed.writeUInt32BE(entry.stat.mtimeNanoseconds >>> 0, 12);
    fixed.writeUInt32BE(entry.stat.dev >>> 0, 16);
    fixed.writeUInt32BE(entry.stat.ino >>> 0, 20);
    fixed.writeUInt32BE(entry.mode >>> 0, 24);
    fixed.writeUInt32BE(entry.stat.uid >>> 0, 28);
    fixed.writeUInt32BE(entry.stat.gid >>> 0, 32);
    fixed.writeUInt32BE(entry.stat.size >>> 0, 36);
    Buffer.from(entry.oid, "hex").copy(fixed, 40);
    let flags = Math.min(entry.pathBytes.length, 0x0fff) | (entry.stage << 12);
    if (entry.assumeValid) flags |= 0x8000;
    if (entry.skipWorktree || entry.intentToAdd) flags |= 0x4000;
    fixed.writeUInt16BE(flags, 40 + digestLength);
    const extended =
      entry.skipWorktree || entry.intentToAdd ? Buffer.alloc(2) : undefined;
    if (extended) {
      if (entry.skipWorktree) extended[0] |= 0x40;
      if (entry.intentToAdd) extended[0] |= 0x20;
    }
    const pathPart = Buffer.concat([entry.pathBytes, Buffer.from([0])]);
    const unpaddedLength =
      fixed.length + (extended?.length ?? 0) + pathPart.length;
    const padding = Buffer.alloc((8 - (unpaddedLength % 8)) % 8);
    const entryLength =
      fixed.length + (extended?.length ?? 0) + pathPart.length + padding.length;
    totalLength += entryLength;
    if (totalLength > MAX_INDEX_BYTES)
      throw new Error("Snapshot Git index exceeds its bounded size.");
    chunks.push(fixed, ...(extended ? [extended] : []), pathPart, padding);
  }
  const body = Buffer.concat(chunks);
  const checksum = createHash(objectHashAlgorithm(format))
    .update(body)
    .digest();
  return Buffer.concat([body, checksum]);
}

function quoteConfigValue(value: string) {
  boundedConfigValue(value, "Snapshot Git config");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function quoteConfigSubsection(value: string) {
  if (
    value.length === 0 ||
    byteLength(value) > MAX_PATH_BYTES ||
    value.includes("\0") ||
    // eslint-disable-next-line no-control-regex -- intentional config validation.
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Snapshot Git submodule config has an unsafe name.");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function snapshotSubmoduleActiveConfig(
  entries: ReadonlyArray<readonly [string, string]>,
) {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (key.toLowerCase() === "submodule.active") {
      lines.push("[submodule]", `\tactive = ${quoteConfigValue(value)}`);
      continue;
    }
    const match = /^submodule\.(.+)\.active$/iu.exec(key);
    if (!match) throw new Error(`Unsupported submodule config key: ${key}.`);
    lines.push(
      `[submodule ${quoteConfigSubsection(match[1])}]`,
      `\tactive = ${quoteConfigValue(value)}`,
    );
  }
  return lines;
}

function snapshotConfig(repository: RepositoryMetadata) {
  validateOriginUrls(repository.originUrls);
  const lines = [
    "[core]",
    `\trepositoryformatversion = ${repository.formatVersion}`,
    "\tbare = false",
    "\tlogallrefupdates = false",
    "\thooksPath = /dev/null",
    "\tfsmonitor = false",
    "\tfscache = false",
    "\tsplitIndex = false",
    "\tsparseCheckout = false",
    "\tuntrackedCache = false",
    "\tattributesFile = /dev/null",
    "\texcludesFile = /dev/null",
  ];
  for (const [key, values] of Object.entries(repository.coreSettings)) {
    if (FORCED_CORE_SETTINGS.has(key)) continue;
    for (const value of values)
      lines.push(`\t${key} = ${quoteConfigValue(value)}`);
  }
  lines.push("[index]", "\tsparse = false");
  if (repository.objectFormat === "sha256") {
    lines.push("[extensions]", "\tobjectFormat = sha256");
  }
  if (repository.originUrls.length > 0) {
    lines.push('[remote "origin"]');
    for (const value of repository.originUrls)
      lines.push(`\turl = ${quoteConfigValue(value)}`);
  }
  lines.push(
    ...snapshotSubmoduleActiveConfig(repository.submoduleActiveEntries),
  );
  const config = `${lines.join("\n")}\n`;
  if (byteLength(config) > MAX_CONFIG_OUTPUT_BYTES)
    throw new Error("Snapshot Git config exceeds its bounded size.");
  return config;
}

function writeSnapshotRepository(
  repository: InspectedRepository,
  temporaryRoot: string,
  id: string,
  budget: SnapshotBudget,
) {
  const snapshotGitDir = path.join(temporaryRoot, "repositories", id);
  mkdirOwned(snapshotGitDir);
  // Git's repository probe requires a refs directory even though the
  // sanitized view intentionally contains no refs or ref files.
  mkdirOwned(path.join(snapshotGitDir, "refs"));
  mkdirOwned(path.join(snapshotGitDir, "objects"));
  const objectStore = createObjectStore(repository, snapshotGitDir, budget);
  objectStore.write();
  writeOwnedFile(
    path.join(snapshotGitDir, "HEAD"),
    `${repository.metadata.headCommit}\n`,
  );
  writeOwnedFile(
    path.join(snapshotGitDir, "config"),
    snapshotConfig(repository.metadata),
  );
  writeOwnedFile(
    path.join(snapshotGitDir, "index"),
    writeIndex(repository.entries, repository.metadata.objectFormat),
  );
  return snapshotGitDir;
}

function createNestedGitDirectoryPlaceholders(
  repositories: ReadonlyArray<InspectedRepository>,
  sources: ReadonlyMap<string, string>,
) {
  for (const parent of repositories) {
    const parentSource = sources.get(parent.metadata.key);
    if (!parentSource)
      throw new Error("Git snapshot parent source is missing.");
    for (const child of repositories) {
      if (child.metadata.key === parent.metadata.key) continue;
      if (!isContained(parent.metadata.gitDir, child.metadata.gitDir)) continue;
      const relative = path.relative(
        parent.metadata.gitDir,
        child.metadata.gitDir,
      );
      if (relative.length === 0 || path.isAbsolute(relative))
        throw new Error("Nested Git snapshot path is invalid.");
      const relativeParts = relative.split(path.sep);
      if (
        relativeParts.some(
          (part) =>
            part.length === 0 ||
            part === "." ||
            part === ".." ||
            [
              "commondir",
              "hooks",
              "logs",
              "objects",
              "refs",
              "worktrees",
            ].includes(part),
        )
      ) {
        throw new Error("Nested Git snapshot path uses a reserved component.");
      }
      mkdirOwned(path.join(parentSource, ...relativeParts));
    }
  }
}

function createPointerSnapshot(
  repository: RepositoryMetadata,
  temporaryRoot: string,
  id: string,
) {
  const pointerDirectory = path.join(temporaryRoot, "pointers");
  mkdirOwned(pointerDirectory);
  const source = path.join(pointerDirectory, `${id}.git`);
  writeOwnedFile(source, `gitdir: ${repository.gitDir}\n`);
  return source;
}

function createOwnedSnapshotRoot(workspaceRoot: string) {
  const parent = path.dirname(workspaceRoot);
  assertDirectory(parent, "Readiness Git snapshot parent");
  const snapshotPath = fs.mkdtempSync(
    path.join(parent, ".pipi-readiness-git-"),
  );
  const identity = assertDirectory(snapshotPath, "Readiness Git snapshot");
  return { path: snapshotPath, identity } satisfies OwnedDirectory;
}

function disposeOwnedSnapshot(snapshot: OwnedDirectory) {
  const stats = lstatIfPresent(snapshot.path);
  if (!stats) return;
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    !sameIdentity(fileIdentity(stats), snapshot.identity)
  ) {
    throw new Error(
      "Readiness Git snapshot ownership changed; refusing cleanup.",
    );
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(snapshot.path);
  } catch (error) {
    throw new Error(
      `Unable to verify readiness Git snapshot cleanup: ${errorDetail(error)}`,
      {
        cause: error,
      },
    );
  }
  if (resolved !== snapshot.path)
    throw new Error(
      "Readiness Git snapshot path was redirected; refusing cleanup.",
    );
  makeWritableTree(snapshot.path);
  fs.rmSync(snapshot.path, { recursive: true, force: true });
  if (lstatIfPresent(snapshot.path))
    throw new Error("Readiness Git snapshot remained after cleanup.");
}

function revalidate(
  workspaceRoot: string,
  temporaryRoot: string,
  expected: RepositoryDiscovery,
) {
  const verificationRoot = path.join(temporaryRoot, "verification");
  const verificationBudget: SnapshotBudget = {
    objectCount: 0,
    objectBytes: 0,
  };
  mkdirOwned(verificationRoot, 0o700);
  try {
    const current = discoveryWithLinks(
      workspaceRoot,
      verificationRoot,
      verificationBudget,
    );
    assertDiscoveryUnchanged(expected, current);
  } catch (error) {
    throw new Error(
      "Readiness Git snapshot source changed or became unavailable.",
      {
        cause: error,
      },
    );
  } finally {
    fs.rmSync(verificationRoot, { recursive: true, force: true });
  }
}

export function createReadinessGitSnapshot(workspaceRoot: string) {
  const root = canonicalDirectory(workspaceRoot, "Readiness workspace root");
  const snapshot = createOwnedSnapshotRoot(root);
  let disposed = false;
  try {
    const discovery = discoveryWithLinks(root, snapshot.path, {
      objectCount: 0,
      objectBytes: 0,
    });
    const snapshotBudget: SnapshotBudget = {
      objectCount: 0,
      objectBytes: 0,
    };
    const bindings: Array<{ source: string; destination: string }> = [];
    const destinations = new Set<string>();
    const repositorySources = new Map<string, string>();
    for (const [index, repository] of discovery.repositories.entries()) {
      const id = `repo-${index}`;
      const source = writeSnapshotRepository(
        repository,
        snapshot.path,
        id,
        snapshotBudget,
      );
      repositorySources.set(repository.metadata.key, source);
      if (destinations.has(repository.metadata.gitDir))
        throw new Error("Multiple repositories share a Git dir destination.");
      destinations.add(repository.metadata.gitDir);
      bindings.push({
        source,
        destination: repository.metadata.gitDir,
      });
      if (repository.metadata.dotGitKind === "file") {
        const pointerSource = createPointerSnapshot(
          repository.metadata,
          snapshot.path,
          `${id}-pointer`,
        );
        if (destinations.has(repository.metadata.dotGitPath))
          throw new Error("Multiple repositories share a .git destination.");
        destinations.add(repository.metadata.dotGitPath);
        bindings.push({
          source: pointerSource,
          destination: repository.metadata.dotGitPath,
        });
      }
    }
    createNestedGitDirectoryPlaceholders(
      discovery.repositories,
      repositorySources,
    );
    for (const source of repositorySources.values()) makeReadOnlyTree(source);
    revalidate(root, snapshot.path, discovery);
    return {
      bindings,
      verifyUnchanged() {
        if (disposed)
          throw new Error("Readiness Git snapshot has already been disposed.");
        revalidate(root, snapshot.path, discovery);
      },
      dispose() {
        if (disposed) return;
        disposeOwnedSnapshot(snapshot);
        disposed = true;
      },
    };
  } catch (error) {
    try {
      disposeOwnedSnapshot(snapshot);
    } catch (cleanupError) {
      throw new Error(
        `Readiness Git snapshot setup failed and cleanup was refused: ${errorDetail(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}
