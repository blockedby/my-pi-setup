import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AcceptanceIdentity } from "./run-acceptance.ts";

/**
 * Code-review identity covers tracked committed, staged, and dirty working-tree
 * changes plus nonignored untracked workspace files. Ignored caches and
 * dependencies belong to the execution environment and are deliberately
 * outside this identity.
 */
export const REVIEW_IDENTITY_SCOPE =
  "tracked-and-staged-plus-nonignored-untracked-workspace" as const;
export const REVIEW_IDENTITY_MAX_DIFF_BYTES = 8 * 1024 * 1024;
export const REVIEW_IDENTITY_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const REVIEW_IDENTITY_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const REVIEW_IDENTITY_MAX_PATHS = 4096;
export const REVIEW_IDENTITY_MAX_PATH_BYTES = 4 * 1024;

const REVIEW_IDENTITY_MAX_IDENTIFIER_LENGTH = 256;
const REVIEW_IDENTITY_MAX_REVISION = 1_000_000_000;
const GIT_TEXT_OUTPUT_BYTES = 64 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DIFF_ARGS = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--binary",
  "--no-color",
] as const;

type UntrackedPath = {
  readonly name: string;
  readonly bytes: Buffer;
};

export interface CaptureReviewIdentityOptions {
  readonly workingDir: string;
  readonly base: string;
  readonly revision: number;
}

function errorDetail(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return detail
    .replace(/[\u0000\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 2_048);
}

function unavailable(reason: string) {
  return Object.freeze({
    state: "unavailable" as const,
    reason: reason.slice(0, 2_048),
  });
}

function fail(reason: string): never {
  throw new Error(reason);
}

function assertString(value: unknown, label: string, maxBytes?: number) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} is invalid.`);
  }
  if (maxBytes !== undefined && Buffer.byteLength(value, "utf8") > maxBytes) {
    fail(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
}

function assertRevision(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > REVIEW_IDENTITY_MAX_REVISION
  ) {
    fail("Review identity revision is invalid.");
  }
}

function canonicalDirectory(value: string, label: string) {
  assertString(value, label);
  if (!path.isAbsolute(value)) fail(`${label} must be absolute.`);

  const absolute = path.resolve(value);
  let supplied: fs.Stats;
  try {
    supplied = fs.lstatSync(absolute);
  } catch (error) {
    fail(`Unable to inspect ${label}: ${errorDetail(error)}`);
  }
  if (supplied.isSymbolicLink()) fail(`${label} may not be a symlink.`);
  if (!supplied.isDirectory()) fail(`${label} must be a directory.`);
  if ((supplied.mode & 0o444) === 0 || (supplied.mode & 0o111) === 0) {
    fail(`${label} is not readable.`);
  }

  let resolved: string;
  try {
    resolved = fs.realpathSync.native(absolute);
  } catch (error) {
    fail(`Unable to resolve ${label}: ${errorDetail(error)}`);
  }
  if (resolved !== absolute) {
    fail(`${label} contains an unresolved symlink path.`);
  }
  return resolved;
}

function gitBuffer(
  cwd: string,
  args: ReadonlyArray<string>,
  maxBuffer: number,
) {
  return execFileSync("git", [...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function decodeUtf8(value: Buffer, label: string) {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    fail(`${label} is not valid UTF-8.`);
  }
  return decoded;
}

function gitText(cwd: string, args: ReadonlyArray<string>, label: string) {
  const output = gitBuffer(cwd, args, GIT_TEXT_OUTPUT_BYTES);
  return decodeUtf8(output, label).replace(/\r?\n$/, "");
}

function gitCommit(cwd: string, revision: string, label: string) {
  const commit = gitText(
    cwd,
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    label,
  );
  if (!SHA_PATTERN.test(commit)) fail(`${label} is not a verified commit.`);
  return commit;
}

function repositoryRoot(workingDir: string) {
  const root = gitText(
    workingDir,
    ["rev-parse", "--show-toplevel"],
    "Git repository root",
  );
  const canonical = canonicalDirectory(root, "Git repository root");
  return canonical;
}

function safeRepositoryPath(value: string) {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

function pathList(raw: Buffer, label: string, budget: CaptureBudget) {
  budget.add(raw.byteLength, label);
  if (raw.byteLength === 0) return [];
  if (raw[raw.byteLength - 1] !== 0) {
    fail(`${label} did not terminate with NUL.`);
  }

  const paths: UntrackedPath[] = [];
  let start = 0;
  for (let offset = 0; offset < raw.byteLength; offset += 1) {
    if (raw[offset] !== 0) continue;
    const bytes = raw.subarray(start, offset);
    const name = decodeUtf8(bytes, label);
    if (!safeRepositoryPath(name)) {
      fail(`${label} contains an unsafe path.`);
    }
    if (bytes.byteLength > REVIEW_IDENTITY_MAX_PATH_BYTES) {
      fail(`${label} contains an oversized path.`);
    }
    paths.push({ name, bytes: Buffer.from(bytes) });
    if (paths.length > REVIEW_IDENTITY_MAX_PATHS) {
      fail(`${label} exceeds the ${REVIEW_IDENTITY_MAX_PATHS}-path limit.`);
    }
    start = offset + 1;
  }

  const unique = new Map<string, UntrackedPath>();
  for (const entry of paths) {
    if (unique.has(entry.name)) fail(`${label} contains a duplicate path.`);
    unique.set(entry.name, entry);
  }
  return [...unique.values()].sort((left, right) =>
    Buffer.compare(left.bytes, right.bytes),
  );
}

function assertVisibleTrackedPaths(cwd: string, budget: CaptureBudget) {
  const tracked = gitBuffer(
    cwd,
    ["ls-files", "-v", "-z", "--"],
    REVIEW_IDENTITY_MAX_TOTAL_BYTES,
  );
  budget.add(tracked.byteLength, "tracked path listing");
  if (tracked.byteLength === 0) return;
  if (tracked[tracked.byteLength - 1] !== 0) {
    fail("Tracked path listing did not terminate with NUL.");
  }
  for (let offset = 0; offset < tracked.byteLength; offset += 1) {
    if (tracked[offset] === 0) continue;
    const status = tracked[offset];
    const end = tracked.indexOf(0, offset);
    if (end < 0 || tracked[offset + 1] !== 0x20) {
      fail("Tracked path listing is malformed.");
    }
    if (status === 0x68 || status === 0x53) {
      fail("Tracked path visibility is unknown due to an index skip flag.");
    }
    offset = end;
  }
}

function untrackedPaths(cwd: string, budget: CaptureBudget) {
  const raw = gitBuffer(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--"],
    REVIEW_IDENTITY_MAX_TOTAL_BYTES,
  );
  return pathList(raw, "Untracked path listing", budget);
}

class CaptureBudget {
  total = 0;

  add(bytes: number, label: string) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      fail(`${label} has an invalid byte count.`);
    }
    if (bytes > REVIEW_IDENTITY_MAX_TOTAL_BYTES - this.total) {
      fail(
        `Review identity capture exceeds the ${REVIEW_IDENTITY_MAX_TOTAL_BYTES}-byte limit.`,
      );
    }
    this.total += bytes;
  }
}

function captureDiff(
  cwd: string,
  args: ReadonlyArray<string>,
  label: string,
  budget: CaptureBudget,
) {
  const output = gitBuffer(
    cwd,
    [...DIFF_ARGS, ...args],
    REVIEW_IDENTITY_MAX_DIFF_BYTES,
  );
  if (output.byteLength > REVIEW_IDENTITY_MAX_DIFF_BYTES) {
    fail(`${label} exceeds the ${REVIEW_IDENTITY_MAX_DIFF_BYTES}-byte limit.`);
  }
  budget.add(output.byteLength, label);
  return output;
}

function statPath(root: string, relativePath: string) {
  const segments = relativePath.split("/");
  let current = root;
  let finalStats: fs.Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      fail(
        `Unable to inspect untracked path ${relativePath}: ${errorDetail(error)}`,
      );
    }
    if (stats.isSymbolicLink()) {
      fail(`Untracked path ${relativePath} is a symlink.`);
    }
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) {
        fail(`Untracked path ${relativePath} crosses a non-directory.`);
      }
      if ((stats.mode & 0o444) === 0 || (stats.mode & 0o111) === 0) {
        fail(`Untracked path ${relativePath} crosses an unreadable directory.`);
      }
    } else {
      finalStats = stats;
    }
  }
  if (!finalStats) fail(`Untracked path ${relativePath} is empty.`);
  return { absolute: current, stats: finalStats };
}

function sameFileSnapshot(left: fs.Stats, right: fs.Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function hashUntracked(
  hash: ReturnType<typeof createHash>,
  root: string,
  entry: UntrackedPath,
  budget: CaptureBudget,
) {
  const { absolute, stats } = statPath(root, entry.name);
  if (!stats.isFile()) {
    fail(`Untracked path ${entry.name} is not a regular file.`);
  }
  if ((stats.mode & 0o444) === 0) {
    fail(`Untracked path ${entry.name} is not readable.`);
  }
  if (
    !Number.isSafeInteger(stats.size) ||
    stats.size > REVIEW_IDENTITY_MAX_FILE_BYTES
  ) {
    fail(
      `Untracked path ${entry.name} exceeds the ${REVIEW_IDENTITY_MAX_FILE_BYTES}-byte limit.`,
    );
  }

  budget.add(entry.bytes.byteLength, `Untracked path ${entry.name}`);
  budget.add(stats.size, `Untracked content ${entry.name}`);

  hash.update("untracked\0");
  hash.update(`${entry.bytes.byteLength}\0`);
  hash.update(entry.bytes);
  hash.update(`mode\0${stats.mode & 0o7777}\0size\0${stats.size}\0content\0`);

  let descriptor: number;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    fail(`Unable to read untracked path ${entry.name}: ${errorDetail(error)}`);
  }

  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < stats.size) {
      let count: number;
      try {
        count = fs.readSync(
          descriptor,
          chunk,
          0,
          Math.min(chunk.byteLength, stats.size - offset),
          offset,
        );
      } catch (error) {
        fail(
          `Unable to read untracked path ${entry.name}: ${errorDetail(error)}`,
        );
      }
      if (count === 0) fail(`Untracked path ${entry.name} ended early.`);
      hash.update(chunk.subarray(0, count));
      offset += count;
    }

    let after: fs.Stats;
    try {
      after = fs.fstatSync(descriptor);
    } catch (error) {
      fail(
        `Unable to stat untracked path ${entry.name}: ${errorDetail(error)}`,
      );
    }
    if (!sameFileSnapshot(stats, after)) {
      fail(`Untracked path ${entry.name} changed while fingerprinting.`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  hash.update("\0");
}

function hashRecord(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(`${label}\0${bytes.byteLength}\0`);
  hash.update(bytes);
  hash.update("\0");
}

function capture(options: CaptureReviewIdentityOptions) {
  assertString(options.workingDir, "Review identity working directory");
  assertString(
    options.base,
    "Review identity base",
    REVIEW_IDENTITY_MAX_IDENTIFIER_LENGTH,
  );
  assertRevision(options.revision);

  const suppliedWorkingDir = canonicalDirectory(
    options.workingDir,
    "Review identity working directory",
  );
  const cwd = repositoryRoot(suppliedWorkingDir);
  const headBefore = gitCommit(cwd, "HEAD", "Initial Git HEAD");
  const baseCommit = gitCommit(cwd, options.base, "Review identity base");
  const budget = new CaptureBudget();

  assertVisibleTrackedPaths(cwd, budget);
  const untracked = untrackedPaths(cwd, budget);
  const diffArguments = [
    [`${baseCommit}..${headBefore}`, "--"] as const,
    ["--cached", headBefore, "--"] as const,
    ["--"] as const,
  ];
  const diffs = [
    captureDiff(cwd, diffArguments[0], "Tracked committed diff", budget),
    captureDiff(cwd, diffArguments[1], "Staged diff", budget),
    captureDiff(cwd, diffArguments[2], "Dirty working-tree diff", budget),
  ];

  const hash = createHash("sha256");
  hashRecord(hash, "format", "pipi-review-identity-v1");
  hashRecord(hash, "base", options.base);
  hashRecord(hash, "base-commit", baseCommit);
  hashRecord(hash, "head", headBefore);
  hashRecord(hash, "tracked-committed-diff", diffs[0]!);
  hashRecord(hash, "staged-diff", diffs[1]!);
  hashRecord(hash, "dirty-diff", diffs[2]!);
  for (const entry of untracked) {
    hashUntracked(hash, cwd, entry, budget);
  }

  const headAfter = gitCommit(cwd, "HEAD", "Final Git HEAD");
  if (headAfter !== headBefore) {
    fail("Git HEAD changed while capturing review identity.");
  }

  const identity = Object.freeze({
    base: options.base,
    head: headBefore,
    diffDigest: hash.digest("hex"),
    revision: options.revision,
  } satisfies AcceptanceIdentity);
  return Object.freeze({
    state: "available" as const,
    identity,
    scope: REVIEW_IDENTITY_SCOPE,
  });
}

export function captureReviewIdentity(options: CaptureReviewIdentityOptions) {
  try {
    return capture(options);
  } catch (error) {
    return unavailable(`Review identity unavailable: ${errorDetail(error)}`);
  }
}
