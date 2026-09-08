import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSafeRepositoryRelativePath } from "./feature-planning.ts";
import type { FeatureTaskGitDiff } from "./feature-task-worktrees.ts";

export const CHECK_INPUT_REVISION_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CHECK_INPUT_REVISION_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const CHECK_INPUT_REVISION_MAX_PATHS = 4096;
export const CHECK_INPUT_REVISION_MAX_PATH_BYTES = 4 * 1024;

export interface CheckInputRevisionEvidence extends Pick<
  FeatureTaskGitDiff,
  "baseToHead" | "tracked" | "staged" | "untracked" | "conflictPaths"
> {
  readonly fingerprint: string;
}

export interface CheckInputRevision {
  readonly fingerprint: string;
  readonly paths: ReadonlyArray<string>;
  readonly bytes: number;
}

export interface CheckInputRevisionOptions {
  readonly workspaceRoot: string;
  readonly head: string;
  readonly evidence: CheckInputRevisionEvidence;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxPaths?: number;
  readonly maxPathBytes?: number;
}

function errorCode(error: unknown) {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function failure(label: string, error?: unknown) {
  if (error === undefined) return new Error(label);
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${label}: ${detail}`);
}

function assertLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function excludedPath(filePath: string) {
  return filePath
    .split("/")
    .some((segment) => [".git", "node_modules"].includes(segment));
}

function canonicalWorkspaceRoot(workspaceRoot: string) {
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error("Check input workspace root must be absolute.");
  }
  const absolute = path.resolve(workspaceRoot);
  let supplied;
  try {
    supplied = fs.lstatSync(absolute);
  } catch (error) {
    throw failure("Unable to inspect check input workspace root", error);
  }
  if (supplied.isSymbolicLink()) {
    throw new Error("Check input workspace root may not be a symlink.");
  }
  if (!supplied.isDirectory()) {
    throw new Error("Check input workspace root must be a directory.");
  }
  let root;
  try {
    root = fs.realpathSync.native(absolute);
  } catch (error) {
    throw failure("Unable to resolve check input workspace root", error);
  }
  if (root !== absolute) {
    throw new Error(
      "Check input workspace root contains an unresolved symlink path.",
    );
  }
  if ((supplied.mode & 0o444) === 0 || (supplied.mode & 0o111) === 0) {
    throw new Error("Check input workspace root is not readable.");
  }
  return root;
}

function statPath(filePath: string) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw failure(`Unable to inspect check input path ${filePath}`, error);
  }
}

function assertReadableDirectory(stats: fs.Stats, filePath: string) {
  if ((stats.mode & 0o444) === 0 || (stats.mode & 0o111) === 0) {
    throw new Error(`Check input directory is not readable: ${filePath}.`);
  }
}

function statToken(stats: fs.Stats) {
  return [stats.mode & 0xffff, stats.size, stats.mtimeMs, stats.ctimeMs].join(
    ":",
  );
}

function sameFileStats(before: fs.Stats, after: fs.Stats) {
  return (
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function minimalPaths(paths: ReadonlyArray<string>) {
  const sorted = [...paths].sort((left, right) => {
    const byLength = left.length - right.length;
    return byLength || left.localeCompare(right);
  });
  const roots: string[] = [];
  for (const filePath of sorted) {
    if (
      roots.some((root) => filePath === root || filePath.startsWith(`${root}/`))
    ) {
      continue;
    }
    roots.push(filePath);
  }
  return roots.sort();
}

export function captureCheckInputRevision(options: CheckInputRevisionOptions) {
  const maxFileBytes =
    options.maxFileBytes ?? CHECK_INPUT_REVISION_MAX_FILE_BYTES;
  const maxTotalBytes =
    options.maxTotalBytes ?? CHECK_INPUT_REVISION_MAX_TOTAL_BYTES;
  const maxPaths = options.maxPaths ?? CHECK_INPUT_REVISION_MAX_PATHS;
  const maxPathBytes =
    options.maxPathBytes ?? CHECK_INPUT_REVISION_MAX_PATH_BYTES;
  assertLimit(maxFileBytes, "Check input file limit");
  assertLimit(maxTotalBytes, "Check input total limit");
  assertLimit(maxPaths, "Check input path limit");
  assertLimit(maxPathBytes, "Check input path byte limit");

  const root = canonicalWorkspaceRoot(options.workspaceRoot);
  if (options.head.includes("\0")) {
    throw new Error("Check input HEAD identity is invalid.");
  }
  if (
    !options.evidence.fingerprint ||
    options.evidence.fingerprint.includes("\0")
  ) {
    throw new Error("Check input diff fingerprint is unavailable.");
  }

  const fields = [
    ["baseToHead", options.evidence.baseToHead],
    ["tracked", options.evidence.tracked],
    ["staged", options.evidence.staged],
    ["untracked", options.evidence.untracked],
    ["conflictPaths", options.evidence.conflictPaths],
  ] as const;
  const paths = new Set<string>();
  const fieldPaths = new Map<string, ReadonlyArray<string>>();
  for (const [field, values] of fields) {
    const normalized: string[] = [];
    for (const filePath of values) {
      if (typeof filePath !== "string") {
        throw new Error(`Check input ${field} contains a non-string path.`);
      }
      if (
        Buffer.byteLength(filePath, "utf8") > maxPathBytes ||
        !isSafeRepositoryRelativePath(filePath)
      ) {
        throw new Error(
          `Check input ${field} contains an unsafe or oversized path: ${JSON.stringify(filePath)}.`,
        );
      }
      if (excludedPath(filePath)) continue;
      normalized.push(filePath);
      paths.add(filePath);
    }
    fieldPaths.set(field, [...new Set(normalized)].sort());
  }
  if (paths.size > maxPaths) {
    throw new Error(
      `Check input path count exceeds the ${maxPaths}-path limit.`,
    );
  }

  const hash = createHash("sha256");
  hash.update("pipi-check-input-revision-v1\0");
  hash.update(`head\0${options.head}\0`);
  hash.update(`diff\0${options.evidence.fingerprint}\0`);
  for (const [field] of fields) {
    hash.update(`${field}\0`);
    for (const filePath of fieldPaths.get(field)!) {
      hash.update(`${filePath}\0`);
    }
    hash.update("\0");
  }

  let bytes = 0;
  let records = 0;
  const countRecord = (filePath: string) => {
    records += 1;
    if (records > maxPaths) {
      throw new Error(
        `Check input path count exceeds the ${maxPaths}-path limit.`,
      );
    }
    if (
      Buffer.byteLength(filePath, "utf8") > maxPathBytes ||
      !isSafeRepositoryRelativePath(filePath)
    ) {
      throw new Error(
        `Check input traversal produced an unsafe or oversized path: ${JSON.stringify(filePath)}.`,
      );
    }
  };

  const readFile = (filePath: string, absolute: string, stats: fs.Stats) => {
    if (!stats.isFile()) {
      throw new Error(`Check input path is not a regular file: ${filePath}.`);
    }
    if ((stats.mode & 0o444) === 0) {
      throw new Error(`Check input file is not readable: ${filePath}.`);
    }
    if (!Number.isSafeInteger(stats.size) || stats.size > maxFileBytes) {
      throw new Error(
        `Check input file exceeds the ${maxFileBytes}-byte limit: ${filePath}.`,
      );
    }
    if (bytes > maxTotalBytes - stats.size) {
      throw new Error(
        `Check input content exceeds the ${maxTotalBytes}-byte total limit.`,
      );
    }

    hash.update(`file\0${filePath}\0${statToken(stats)}\0`);
    let file;
    try {
      file = fs.openSync(
        absolute,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      throw failure(`Unable to read check input file ${filePath}`, error);
    }
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let offset = 0;
      while (offset < stats.size) {
        let count;
        try {
          count = fs.readSync(
            file,
            chunk,
            0,
            Math.min(chunk.length, stats.size - offset),
            offset,
          );
        } catch (error) {
          throw failure(`Unable to read check input file ${filePath}`, error);
        }
        if (count === 0) {
          throw new Error(`Check input file ended early: ${filePath}.`);
        }
        hash.update(chunk.subarray(0, count));
        offset += count;
      }
      let after;
      try {
        after = fs.fstatSync(file);
      } catch (error) {
        throw failure(`Unable to stat check input file ${filePath}`, error);
      }
      if (!sameFileStats(stats, after)) {
        throw new Error(
          `Check input file changed while fingerprinting: ${filePath}.`,
        );
      }
      hash.update("\0");
      bytes += stats.size;
    } finally {
      fs.closeSync(file);
    }
  };

  const visit = (filePath: string, absolute: string): void => {
    if (excludedPath(filePath)) return;
    countRecord(filePath);
    const stats = statPath(absolute);
    if (!stats) {
      hash.update(`missing\0${filePath}\0`);
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Check input path is a symlink: ${filePath}.`);
    }
    if (stats.isDirectory()) {
      assertReadableDirectory(stats, filePath);
      hash.update(`directory\0${filePath}\0${statToken(stats)}\0`);
      let directory;
      try {
        directory = fs.opendirSync(absolute);
      } catch (error) {
        throw failure(
          `Unable to read check input directory ${filePath}`,
          error,
        );
      }
      const entries: string[] = [];
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (entries.length >= maxPaths) {
            throw new Error(
              `Check input directory exceeds the ${maxPaths}-path limit: ${filePath}.`,
            );
          }
          entries.push(entry.name);
        }
      } catch (error) {
        if (error instanceof Error) throw error;
        throw failure(
          `Unable to read check input directory ${filePath}`,
          error,
        );
      } finally {
        directory.closeSync();
      }
      for (const name of entries.sort()) {
        const child = path.posix.join(filePath, name);
        if (excludedPath(child)) continue;
        visit(child, path.join(absolute, name));
      }
      hash.update("\0");
      return;
    }
    readFile(filePath, absolute, stats);
  };

  for (const filePath of minimalPaths([...paths])) {
    const absolute = path.join(root, ...filePath.split("/"));
    let parent = root;
    let parentMissing = false;
    const segments = filePath.split("/");
    for (const segment of segments.slice(0, -1)) {
      parent = path.join(parent, segment);
      const stats = statPath(parent);
      if (!stats) {
        parentMissing = true;
        break;
      }
      if (stats.isSymbolicLink()) {
        throw new Error(`Check input path crosses a symlink: ${filePath}.`);
      }
      if (!stats.isDirectory()) {
        parentMissing = true;
        break;
      }
      assertReadableDirectory(stats, parent);
    }
    if (parentMissing) {
      countRecord(filePath);
      hash.update(`missing\0${filePath}\0`);
      continue;
    }
    visit(filePath, absolute);
  }

  return {
    fingerprint: hash.digest("hex"),
    paths: [...paths].sort(),
    bytes,
  } satisfies CheckInputRevision;
}
