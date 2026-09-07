import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const STORE_FORMAT_VERSION = 1;
const MANIFEST_FILE_NAME = "manifest.json";
const ARTIFACTS_DIRECTORY_NAME = "artifacts";
const MAX_IDENTIFIER_BYTES = 128;
const MAX_SCHEMA_VERSION_BYTES = 128;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 16_384;
const MAX_REVISIONS_PER_ARTIFACT = 100_000;
const MAX_TOTAL_REVISIONS = 200_000;

/** Maximum encoded size of one stored snapshot or event history. */
export const RUN_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
const MIN_RUN_ARTIFACT_PAGE_BYTES = 4;
/** Maximum requested size of one read page for tool consumers. */
export const RUN_ARTIFACT_MAX_PAGE_BYTES = 64 * 1024;

export type RunArtifactSchemaVersion = string | number;
export type RunArtifactCompleteness = "complete" | "incomplete";

export interface RunArtifactManifestEntry {
  readonly artifactId: string;
  readonly relativePath: string;
  readonly schemaVersion: RunArtifactSchemaVersion;
  readonly bytes: number;
  readonly sha256: string;
  readonly revision: number;
  readonly completeness: RunArtifactCompleteness;
}

export interface RunArtifactReadPage {
  readonly text: string;
  readonly nextCursor?: number;
  readonly revision: number;
  readonly completeness: RunArtifactCompleteness;
}

export interface RunArtifactStoreOptions {
  readonly rootDir: string;
  readonly runId: string;
}

export interface WriteRunArtifactSnapshotRequest {
  readonly artifactId: string;
  readonly schemaVersion: RunArtifactSchemaVersion;
  readonly value: unknown;
}

export interface AppendRunArtifactEventRequest {
  readonly artifactId: string;
  readonly schemaVersion: RunArtifactSchemaVersion;
  readonly event: unknown;
}

export interface ReadRunArtifactRequest {
  readonly artifactId: string;
  readonly revision: number;
  readonly cursor?: number;
  readonly maxBytes: number;
}

export interface RunArtifactStore {
  writeSnapshot(
    request: WriteRunArtifactSnapshotRequest,
  ): Promise<RunArtifactManifestEntry>;
  appendEvent(
    request: AppendRunArtifactEventRequest,
  ): Promise<RunArtifactManifestEntry>;
  manifest(): Promise<ReadonlyArray<RunArtifactManifestEntry>>;
  read(request: ReadRunArtifactRequest): Promise<RunArtifactReadPage>;
}

interface PathIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: string;
}

interface PersistedManifest {
  readonly formatVersion: number;
  readonly runId: string;
  readonly entries: ReadonlyArray<RunArtifactManifestEntry>;
  readonly revisions: ReadonlyArray<RunArtifactManifestEntry>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string | Uint8Array) {
  return typeof value === "string"
    ? Buffer.byteLength(value, "utf8")
    : value.byteLength;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function operationError(operation: string, error: unknown) {
  if (error instanceof Error && error.message.startsWith("Run artifact")) {
    return error;
  }
  return new Error(
    `Run artifact ${operation} failed: ${describeError(error)}`,
    {
      cause: error,
    },
  );
}

function assertIdentifier(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty path-safe identifier.`);
  }
  if (value === "." || value === "..") {
    throw new Error(`${label} must not be a traversal identifier.`);
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(
      `${label} must not contain path separators or control characters.`,
    );
  }
  if (byteLength(value) > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `${label} exceeds the maximum size of ${MAX_IDENTIFIER_BYTES} UTF-8 bytes.`,
    );
  }
  return value;
}

function assertSchemaVersion(value: unknown) {
  if (typeof value === "string") {
    if (!value.trim() || byteLength(value) > MAX_SCHEMA_VERSION_BYTES) {
      throw new Error(
        `schemaVersion must be a non-empty string of at most ${MAX_SCHEMA_VERSION_BYTES} UTF-8 bytes.`,
      );
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(
    "schemaVersion must be a nonnegative safe integer or string.",
  );
}

function assertRevision(value: unknown, label = "revision") {
  if (!isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertByteBudget(value: unknown) {
  if (
    !isSafeInteger(value) ||
    value < MIN_RUN_ARTIFACT_PAGE_BYTES ||
    value > RUN_ARTIFACT_MAX_PAGE_BYTES
  ) {
    throw new Error(
      `maxBytes must be a safe integer from ${MIN_RUN_ARTIFACT_PAGE_BYTES} through ${RUN_ARTIFACT_MAX_PAGE_BYTES}.`,
    );
  }
  return value;
}

function assertCursor(value: unknown) {
  if (!isSafeInteger(value) || value < 0) {
    throw new Error("cursor must be a nonnegative safe integer.");
  }
  return value;
}

function identityOf(stat: fs.Stats): PathIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs.toString(),
  };
}

function sameIdentity(actual: PathIdentity, expected: PathIdentity) {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.birthtimeMs === expected.birthtimeMs
  );
}

function assertDirectoryStat(stat: fs.Stats, label: string) {
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory.`);
  }
}

function setupDirectory(directory: string, label: string) {
  try {
    const stat = fs.lstatSync(directory);
    assertDirectoryStat(stat, label);
    return stat;
  } catch (error) {
    if (!isMissingError(error)) throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    assertDirectoryStat(stat, label);
    return stat;
  }
}

function isMissingError(error: unknown) {
  return isRecord(error) && error.code === "ENOENT";
}

async function requireDirectory(directory: string, label: string) {
  let stat: fs.Stats;
  try {
    stat = await fsp.lstat(directory);
  } catch (error) {
    if (isMissingError(error)) {
      throw new Error(`${label} is missing: ${describeError(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
  assertDirectoryStat(stat, label);
  return stat;
}

function isMissingDirectoryError(error: unknown) {
  return isRecord(error) && isMissingError(error.cause);
}

async function ensureDirectory(directory: string, label: string) {
  try {
    await requireDirectory(directory, label);
  } catch (error) {
    if (!isMissingDirectoryError(error)) throw error;
    try {
      await fsp.mkdir(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!isRecord(mkdirError) || mkdirError.code !== "EEXIST") {
        throw mkdirError;
      }
    }
    await requireDirectory(directory, label);
  }
}

function canonicalRelativePath(
  artifactId: string,
  revision: number,
  extension: "json" | "jsonl",
) {
  return `${ARTIFACTS_DIRECTORY_NAME}/${artifactId}/revision-${revision}.${extension}`;
}

function entryKey(
  entry: Pick<RunArtifactManifestEntry, "artifactId" | "revision">,
) {
  return `${entry.artifactId}\u0000${entry.revision}`;
}

function cloneEntry(entry: RunArtifactManifestEntry) {
  return { ...entry };
}

function sameEntry(
  left: RunArtifactManifestEntry,
  right: RunArtifactManifestEntry,
) {
  return (
    left.artifactId === right.artifactId &&
    left.relativePath === right.relativePath &&
    left.schemaVersion === right.schemaVersion &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.revision === right.revision &&
    left.completeness === right.completeness
  );
}

function validateManifestEntry(value: unknown, label: string) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const artifactId = assertIdentifier(value.artifactId, `${label}.artifactId`);
  const relativePath = value.relativePath;
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    byteLength(relativePath) > 512
  ) {
    throw new Error(
      `${label}.relativePath must be a bounded non-empty string.`,
    );
  }
  const schemaVersion = assertSchemaVersion(value.schemaVersion);
  const bytes = value.bytes;
  if (!isSafeInteger(bytes) || bytes < 0 || bytes > RUN_ARTIFACT_MAX_BYTES) {
    throw new Error(`${label}.bytes is outside the artifact size limit.`);
  }
  const sha256 = value.sha256;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest.`);
  }
  const revision = assertRevision(value.revision, `${label}.revision`);
  const completeness = value.completeness;
  if (completeness !== "complete" && completeness !== "incomplete") {
    throw new Error(`${label}.completeness must be complete or incomplete.`);
  }
  return {
    artifactId,
    relativePath,
    schemaVersion,
    bytes,
    sha256,
    revision,
    completeness,
  } satisfies RunArtifactManifestEntry;
}

function validateCanonicalEntryPath(entry: RunArtifactManifestEntry) {
  const expectedJson = canonicalRelativePath(
    entry.artifactId,
    entry.revision,
    "json",
  );
  const expectedJsonl = canonicalRelativePath(
    entry.artifactId,
    entry.revision,
    "jsonl",
  );
  if (
    entry.relativePath !== expectedJson &&
    entry.relativePath !== expectedJsonl
  ) {
    throw new Error(
      `Registered artifact ${entry.artifactId} revision ${entry.revision} has an unsafe relative path.`,
    );
  }
  return entry.relativePath === expectedJsonl ? "jsonl" : "json";
}

function validateManifest(value: unknown, runId: string) {
  if (!isRecord(value)) {
    throw new Error("The artifact manifest must be an object.");
  }
  if (value.formatVersion !== STORE_FORMAT_VERSION) {
    throw new Error("The artifact manifest format version is unsupported.");
  }
  if (value.runId !== runId) {
    throw new Error("The artifact manifest belongs to a different run.");
  }
  if (!Array.isArray(value.entries) || !Array.isArray(value.revisions)) {
    throw new Error(
      "The artifact manifest must contain entries and revisions arrays.",
    );
  }
  if (
    value.entries.length > MAX_ARTIFACTS ||
    value.revisions.length > MAX_TOTAL_REVISIONS
  ) {
    throw new Error("The artifact manifest exceeds its entry limit.");
  }

  const entries = value.entries.map((entry, index) => {
    const validated = validateManifestEntry(entry, `entries[${index}]`);
    validateCanonicalEntryPath(validated);
    return validated;
  });
  const revisions = value.revisions.map((entry, index) => {
    const validated = validateManifestEntry(entry, `revisions[${index}]`);
    validateCanonicalEntryPath(validated);
    return validated;
  });

  const currentByArtifact = new Map<string, RunArtifactManifestEntry>();
  for (const entry of entries) {
    if (currentByArtifact.has(entry.artifactId)) {
      throw new Error(
        `The artifact manifest contains duplicate entry ${entry.artifactId}.`,
      );
    }
    currentByArtifact.set(entry.artifactId, entry);
  }
  const revisionByKey = new Map<string, RunArtifactManifestEntry>();
  const revisionsByArtifact = new Map<string, RunArtifactManifestEntry[]>();
  for (const entry of revisions) {
    const key = entryKey(entry);
    if (revisionByKey.has(key)) {
      throw new Error(
        `The artifact manifest contains duplicate revision ${entry.artifactId}#${entry.revision}.`,
      );
    }
    revisionByKey.set(key, entry);
    const history = revisionsByArtifact.get(entry.artifactId) ?? [];
    history.push(entry);
    revisionsByArtifact.set(entry.artifactId, history);
  }
  for (const [artifactId, entry] of currentByArtifact) {
    const history = revisionsByArtifact.get(artifactId);
    const latest = history?.reduce(
      (candidate, revision) =>
        !candidate || revision.revision > candidate.revision
          ? revision
          : candidate,
      undefined as RunArtifactManifestEntry | undefined,
    );
    if (
      !latest ||
      latest.revision !== entry.revision ||
      entryKey(latest) !== entryKey(entry) ||
      !sameEntry(latest, entry)
    ) {
      throw new Error(
        `The artifact manifest current entry is inconsistent for ${artifactId}.`,
      );
    }
  }
  for (const artifactId of revisionsByArtifact.keys()) {
    if (!currentByArtifact.has(artifactId)) {
      throw new Error(
        `The artifact manifest history is unindexed for ${artifactId}.`,
      );
    }
  }
  for (const history of revisionsByArtifact.values()) {
    if (history.length > MAX_REVISIONS_PER_ARTIFACT) {
      throw new Error(
        "The artifact manifest exceeds the per-artifact revision limit.",
      );
    }
  }

  return {
    formatVersion: STORE_FORMAT_VERSION,
    runId,
    entries: [...entries].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    ),
    revisions: [...revisions].sort((left, right) =>
      entryKey(left).localeCompare(entryKey(right)),
    ),
  } satisfies PersistedManifest;
}

function encodeManifest(document: PersistedManifest) {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error(
      `The artifact manifest exceeds its maximum size of ${MAX_MANIFEST_BYTES} bytes.`,
    );
  }
  return bytes;
}

function serializeJson(value: unknown, label: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `${label} is not JSON serializable: ${describeError(error)}`,
      {
        cause: error,
      },
    );
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON serializable.`);
  }
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  if (bytes.length > RUN_ARTIFACT_MAX_BYTES) {
    throw new Error(
      `${label} exceeds the maximum artifact size of ${RUN_ARTIFACT_MAX_BYTES} bytes.`,
    );
  }
  return bytes;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isContinuationByte(value: number | undefined) {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function assertValidUtf8(bytes: Uint8Array, label: string) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8.`, { cause: error });
  }
}

function utf8Page(bytes: Uint8Array, cursor: number, maxBytes: number) {
  if (cursor > bytes.length) {
    throw new Error(`cursor ${cursor} exceeds artifact size ${bytes.length}.`);
  }
  if (isContinuationByte(bytes[cursor])) {
    throw new Error(`cursor ${cursor} is not a UTF-8 code point boundary.`);
  }
  const requestedEnd = Math.min(bytes.length, cursor + maxBytes);
  let end = requestedEnd;
  if (end < bytes.length && isContinuationByte(bytes[end])) {
    while (end > cursor && isContinuationByte(bytes[end])) end -= 1;
  }
  const page = Buffer.from(bytes.subarray(cursor, end));
  return {
    text: page.toString("utf8"),
    ...(end < bytes.length ? { nextCursor: end } : {}),
  };
}

function nextRevision(document: PersistedManifest, artifactId: string) {
  const current = document.entries.find(
    (entry) => entry.artifactId === artifactId,
  );
  return (current?.revision ?? 0) + 1;
}

function nextDocument(
  document: PersistedManifest,
  entry: RunArtifactManifestEntry,
) {
  const revisions = [...document.revisions, entry];
  const entries = [
    ...document.entries.filter(
      (candidate) => candidate.artifactId !== entry.artifactId,
    ),
    entry,
  ];
  return validateManifest(
    {
      formatVersion: STORE_FORMAT_VERSION,
      runId: document.runId,
      entries,
      revisions,
    },
    document.runId,
  );
}

function missingPathError(error: unknown) {
  return isRecord(error) && error.code === "ENOENT";
}

function prepareRoot(rootDir: string, runId: string) {
  if (typeof rootDir !== "string" || !rootDir) {
    throw new Error("rootDir must be a non-empty path.");
  }
  const validatedRunId = assertIdentifier(runId, "runId");
  const rootPath = path.resolve(rootDir);
  setupDirectory(rootPath, "Artifact store root");
  const runPath = path.join(rootPath, validatedRunId);
  const runStat = setupDirectory(runPath, "Artifact store run root");
  const rootStat = fs.lstatSync(rootPath);
  return {
    rootPath,
    runPath,
    manifestPath: path.join(runPath, MANIFEST_FILE_NAME),
    artifactsPath: path.join(runPath, ARTIFACTS_DIRECTORY_NAME),
    rootIdentity: identityOf(rootStat),
    runIdentity: identityOf(runStat),
    runId: validatedRunId,
  };
}

export function createRunArtifactStore(options: RunArtifactStoreOptions) {
  const paths = prepareRoot(options.rootDir, options.runId);
  let queue = Promise.resolve();
  let temporaryCounter = 0;

  async function assertOwnedRoots() {
    let rootStat: fs.Stats;
    let runStat: fs.Stats;
    try {
      rootStat = await fsp.lstat(paths.rootPath);
      runStat = await fsp.lstat(paths.runPath);
    } catch (error) {
      throw new Error(
        `Artifact store root was removed or replaced: ${describeError(error)}`,
        {
          cause: error,
        },
      );
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(
        "Artifact store root was replaced by a non-directory or symbolic link.",
      );
    }
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw new Error(
        "Artifact store run root was replaced by a non-directory or symbolic link.",
      );
    }
    if (!sameIdentity(identityOf(rootStat), paths.rootIdentity)) {
      throw new Error(
        "Artifact store root identity changed; refusing to continue.",
      );
    }
    if (!sameIdentity(identityOf(runStat), paths.runIdentity)) {
      throw new Error(
        "Artifact store run root identity changed; refusing to continue.",
      );
    }
  }

  async function loadManifest() {
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(paths.manifestPath);
    } catch (error) {
      if (missingPathError(error)) {
        return {
          formatVersion: STORE_FORMAT_VERSION,
          runId: paths.runId,
          entries: [],
          revisions: [],
        } satisfies PersistedManifest;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        "The artifact manifest must be a regular file, not a symbolic link.",
      );
    }
    if (stat.size > MAX_MANIFEST_BYTES) {
      throw new Error("The artifact manifest exceeds its maximum size.");
    }
    const bytes = await fsp.readFile(paths.manifestPath);
    if (bytes.length > MAX_MANIFEST_BYTES) {
      throw new Error("The artifact manifest exceeds its maximum size.");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error(
        `The artifact manifest is corrupt: ${describeError(error)}`,
        {
          cause: error,
        },
      );
    }
    return validateManifest(value, paths.runId);
  }

  async function ensureArtifactsDirectory() {
    await ensureDirectory(
      paths.artifactsPath,
      "Artifact store artifacts directory",
    );
  }

  async function ensureArtifactDirectory(artifactId: string) {
    await ensureArtifactsDirectory();
    const artifactPath = path.join(paths.artifactsPath, artifactId);
    await ensureDirectory(artifactPath, `Artifact directory ${artifactId}`);
    return artifactPath;
  }

  async function registeredBytes(entry: RunArtifactManifestEntry) {
    const extension = validateCanonicalEntryPath(entry);
    await requireDirectory(
      paths.artifactsPath,
      "Artifact store artifacts directory",
    );
    const artifactPath = path.join(paths.artifactsPath, entry.artifactId);
    await requireDirectory(
      artifactPath,
      `Artifact directory ${entry.artifactId}`,
    );
    const absolutePath = path.join(paths.runPath, entry.relativePath);
    let stat: fs.Stats;
    try {
      stat = await fsp.lstat(absolutePath);
    } catch (error) {
      if (missingPathError(error)) {
        throw new Error(
          `Registered artifact ${entry.artifactId} revision ${entry.revision} is missing.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Registered artifact ${entry.artifactId} revision ${entry.revision} is not a regular file.`,
      );
    }
    if (stat.size !== entry.bytes) {
      throw new Error(
        `Registered artifact ${entry.artifactId} revision ${entry.revision} has an unexpected byte length.`,
      );
    }
    if (stat.size > RUN_ARTIFACT_MAX_BYTES) {
      throw new Error(
        `Registered artifact ${entry.artifactId} exceeds the artifact size limit.`,
      );
    }
    const bytes = await fsp.readFile(absolutePath);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(
        `Registered artifact ${entry.artifactId} revision ${entry.revision} failed its SHA-256 integrity check.`,
      );
    }
    assertValidUtf8(
      bytes,
      `Registered artifact ${entry.artifactId} revision ${entry.revision}`,
    );
    if (extension === "jsonl" && bytes.length === 0) {
      throw new Error(
        `Registered JSONL artifact ${entry.artifactId} is empty.`,
      );
    }
    return bytes;
  }

  async function assertDestinationAbsent(absolutePath: string, label: string) {
    try {
      const stat = await fsp.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not be a symbolic link.`);
      }
      throw new Error(
        `${label} already exists; immutable revisions are write-once.`,
      );
    } catch (error) {
      if (missingPathError(error)) return;
      throw error;
    }
  }

  async function atomicWrite(
    absolutePath: string,
    bytes: Uint8Array,
    options: { readonly replace: boolean; readonly label: string },
  ) {
    const directory = path.dirname(absolutePath);
    const temporaryPath = path.join(
      directory,
      `.run-artifact-${process.pid}-${Date.now()}-${temporaryCounter++}.tmp`,
    );
    if (!options.replace)
      await assertDestinationAbsent(absolutePath, options.label);
    else {
      try {
        const destinationStat = await fsp.lstat(absolutePath);
        if (destinationStat.isSymbolicLink()) {
          throw new Error(`${options.label} must not be a symbolic link.`);
        }
      } catch (error) {
        if (!missingPathError(error)) throw error;
      }
    }
    try {
      await fsp.writeFile(temporaryPath, bytes, {
        encoding: undefined,
        flag: "wx",
        mode: 0o600,
      });
      await fsp.rename(temporaryPath, absolutePath);
    } catch (error) {
      try {
        await fsp.unlink(temporaryPath);
      } catch {
        // Preserve the original disk error for the parent controller.
      }
      throw error;
    }
  }

  async function saveManifest(document: PersistedManifest) {
    const bytes = encodeManifest(document);
    await atomicWrite(paths.manifestPath, bytes, {
      replace: true,
      label: "The artifact manifest",
    });
  }

  function enqueue<T>(operation: string, work: () => Promise<T>) {
    const result = queue.then(async () => {
      try {
        await assertOwnedRoots();
        return await work();
      } catch (error) {
        throw operationError(operation, error);
      }
    });
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const store = {
    writeSnapshot(request: WriteRunArtifactSnapshotRequest) {
      return enqueue("writeSnapshot", async () => {
        const artifactId = assertIdentifier(request.artifactId, "artifactId");
        const schemaVersion = assertSchemaVersion(request.schemaVersion);
        const bytes = serializeJson(request.value, "snapshot value");
        const document = await loadManifest();
        const revision = nextRevision(document, artifactId);
        const relativePath = canonicalRelativePath(
          artifactId,
          revision,
          "json",
        );
        const entry = {
          artifactId,
          relativePath,
          schemaVersion,
          bytes: bytes.length,
          sha256: sha256(bytes),
          revision,
          completeness: "complete",
        } satisfies RunArtifactManifestEntry;
        const next = nextDocument(document, entry);
        const artifactPath = await ensureArtifactDirectory(artifactId);
        const absolutePath = path.join(
          artifactPath,
          `revision-${revision}.json`,
        );
        encodeManifest(next);
        await atomicWrite(absolutePath, bytes, {
          replace: false,
          label: `Artifact ${artifactId} revision ${revision}`,
        });
        await saveManifest(next);
        return cloneEntry(entry);
      });
    },

    appendEvent(request: AppendRunArtifactEventRequest) {
      return enqueue("appendEvent", async () => {
        const artifactId = assertIdentifier(request.artifactId, "artifactId");
        const schemaVersion = assertSchemaVersion(request.schemaVersion);
        const eventBytes = serializeJson(request.event, "event");
        const document = await loadManifest();
        const current = document.entries.find(
          (entry) => entry.artifactId === artifactId,
        );
        const previousBytes = current
          ? await registeredBytes(current)
          : Buffer.alloc(0);
        const bytes = Buffer.concat([previousBytes, eventBytes]);
        if (bytes.length > RUN_ARTIFACT_MAX_BYTES) {
          throw new Error(
            `Event append would exceed the maximum artifact size of ${RUN_ARTIFACT_MAX_BYTES} bytes.`,
          );
        }
        const revision = nextRevision(document, artifactId);
        const relativePath = canonicalRelativePath(
          artifactId,
          revision,
          "jsonl",
        );
        const entry = {
          artifactId,
          relativePath,
          schemaVersion,
          bytes: bytes.length,
          sha256: sha256(bytes),
          revision,
          completeness: "complete",
        } satisfies RunArtifactManifestEntry;
        const next = nextDocument(document, entry);
        const artifactPath = await ensureArtifactDirectory(artifactId);
        const absolutePath = path.join(
          artifactPath,
          `revision-${revision}.jsonl`,
        );
        encodeManifest(next);
        await atomicWrite(absolutePath, bytes, {
          replace: false,
          label: `Artifact ${artifactId} revision ${revision}`,
        });
        await saveManifest(next);
        return cloneEntry(entry);
      });
    },

    manifest() {
      return enqueue("manifest", async () => {
        const document = await loadManifest();
        return document.entries.map(cloneEntry);
      });
    },

    read(request: ReadRunArtifactRequest) {
      return enqueue("read", async () => {
        const artifactId = assertIdentifier(request.artifactId, "artifactId");
        const revision = assertRevision(request.revision);
        const cursor = assertCursor(request.cursor ?? 0);
        const maxBytes = assertByteBudget(request.maxBytes);
        const document = await loadManifest();
        const entry = document.revisions.find(
          (candidate) =>
            candidate.artifactId === artifactId &&
            candidate.revision === revision,
        );
        if (!entry) {
          throw new Error(
            `Artifact ${artifactId} revision ${revision} is not registered for this run.`,
          );
        }
        const bytes = await registeredBytes(entry);
        const page = utf8Page(bytes, cursor, maxBytes);
        return {
          ...page,
          revision: entry.revision,
          completeness: entry.completeness,
        } satisfies RunArtifactReadPage;
      });
    },
  } satisfies RunArtifactStore;

  return store;
}
