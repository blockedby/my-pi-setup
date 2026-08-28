import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

const lockPrefix = "pipi-install-lock-v1:";
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

const processStartIdentity = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return fields[19];
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return undefined;
    }
    return null;
  }
};

const bootIdentity = () => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
};

export const encodeInstallLockOwner = (owner) =>
  `${lockPrefix}${Buffer.from(JSON.stringify(owner)).toString("base64url")}`;

export const decodeInstallLockOwner = (value) => {
  if (!value.startsWith(lockPrefix)) return undefined;
  try {
    const owner = JSON.parse(
      Buffer.from(value.slice(lockPrefix.length), "base64url").toString("utf8"),
    );
    if (
      !owner ||
      owner.version !== 1 ||
      typeof owner.host !== "string" ||
      !owner.host ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      (owner.bootId !== null && typeof owner.bootId !== "string") ||
      (owner.processStart !== null && typeof owner.processStart !== "string") ||
      typeof owner.token !== "string" ||
      !tokenPattern.test(owner.token)
    ) {
      return undefined;
    }
    return owner;
  } catch {
    return undefined;
  }
};

const pathLexists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") return false;
    }
    throw error;
  }
};

const readLockOwner = (lockPath) => {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") return undefined;
    }
    throw error;
  }
  if (!stat.isSymbolicLink()) return null;
  return decodeInstallLockOwner(readlinkSync(lockPath)) ?? null;
};

const classifyLockOwner = (owner) => {
  if (owner.host !== hostname()) return "foreign";
  const currentBoot = bootIdentity();
  if (owner.bootId && currentBoot && owner.bootId !== currentBoot)
    return "stale";

  const currentStart = processStartIdentity(owner.pid);
  if (owner.processStart !== null) {
    if (currentStart === undefined) return "stale";
    if (currentStart === null) return "ambiguous";
    return currentStart === owner.processStart ? "live" : "stale";
  }

  try {
    process.kill(owner.pid, 0);
    return "live";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ESRCH") return "stale";
      if (error.code === "EPERM") return "live";
    }
    return "ambiguous";
  }
};

const staleStagePath = (home, token) =>
  join(home, `.pipi-install-stage-${token}`);

const recoverStaleRecoveryMarker = (recoveryPath, token) => {
  const existingOwner = readLockOwner(recoveryPath);
  if (!existingOwner) {
    throw new Error(
      `Pipi installer recovery marker is malformed or ambiguous and was preserved: ${recoveryPath}. Confirm no recovery is active, then remove this exact marker manually.`,
    );
  }
  const classification = classifyLockOwner(existingOwner);
  if (classification !== "stale") {
    const reason =
      classification === "live"
        ? "Another Pipi installer is recovering stale ownership"
        : classification === "foreign"
          ? "Pipi installer recovery marker belongs to another host"
          : "Pipi installer recovery marker owner cannot be verified";
    throw new Error(`${reason}; marker preserved: ${recoveryPath}`);
  }

  const quarantine = `${recoveryPath}.stale-${token}`;
  try {
    renameSync(recoveryPath, quarantine);
  } catch (error) {
    throw new Error(
      `Pipi installer recovery marker changed during stale-owner recovery; retry without removing it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const quarantinedOwner = readLockOwner(quarantine);
  if (!quarantinedOwner || quarantinedOwner.token !== existingOwner.token) {
    if (!pathLexists(recoveryPath)) renameSync(quarantine, recoveryPath);
    throw new Error(
      `Pipi installer recovery marker changed and was preserved: ${recoveryPath}`,
    );
  }
  rmSync(quarantine, { force: true });
};

export const acquireInstallLock = ({ home, token = randomUUID() }) => {
  const lockPath = join(home, ".pipi-install-lock");
  const recoveryPath = `${lockPath}.recovery`;
  const owner = {
    version: 1,
    host: hostname(),
    pid: process.pid,
    bootId: bootIdentity(),
    processStart: processStartIdentity(process.pid) ?? null,
    token,
  };
  const encodedOwner = encodeInstallLockOwner(owner);

  const create = () => symlinkSync(encodedOwner, lockPath);
  if (pathLexists(recoveryPath)) {
    recoverStaleRecoveryMarker(recoveryPath, token);
  }
  try {
    create();
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error)) throw error;
    if (error.code !== "EEXIST") throw error;

    try {
      symlinkSync(encodedOwner, recoveryPath);
    } catch (recoveryError) {
      if (
        recoveryError &&
        typeof recoveryError === "object" &&
        "code" in recoveryError &&
        recoveryError.code === "EEXIST"
      ) {
        throw new Error(
          `Another Pipi installer is checking stale ownership; lock preserved: ${lockPath}`,
        );
      }
      throw recoveryError;
    }

    try {
      const existingOwner = readLockOwner(lockPath);
      if (!existingOwner) {
        throw new Error(
          `Pipi installer lock is malformed or ambiguous and was preserved: ${lockPath}. Confirm no installer is active, then remove this exact lock manually.`,
        );
      }
      const classification = classifyLockOwner(existingOwner);
      if (classification !== "stale") {
        const reason =
          classification === "live"
            ? "Another Pipi installer is active"
            : classification === "foreign"
              ? "Pipi installer lock belongs to another host"
              : "Pipi installer lock owner cannot be verified";
        throw new Error(`${reason}; lock preserved: ${lockPath}`);
      }

      const quarantine = `${lockPath}.stale-${token}`;
      try {
        renameSync(lockPath, quarantine);
      } catch (renameError) {
        throw new Error(
          `Pipi installer lock changed during stale-owner recovery; retry without removing it: ${renameError instanceof Error ? renameError.message : String(renameError)}`,
        );
      }
      const quarantinedOwner = readLockOwner(quarantine);
      if (!quarantinedOwner || quarantinedOwner.token !== existingOwner.token) {
        if (!pathLexists(lockPath)) renameSync(quarantine, lockPath);
        throw new Error(
          `Pipi installer lock changed during stale-owner recovery and was preserved: ${lockPath}`,
        );
      }
      try {
        create();
      } catch (createError) {
        if (!pathLexists(lockPath)) renameSync(quarantine, lockPath);
        throw new Error(
          `Another Pipi installer acquired the HOME during stale-owner recovery: ${createError instanceof Error ? createError.message : String(createError)}`,
        );
      }
      try {
        rmSync(quarantine, { force: true });
        rmSync(staleStagePath(home, existingOwner.token), {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        const currentOwner = readLockOwner(lockPath);
        if (currentOwner?.token === token) unlinkSync(lockPath);
        throw new Error(
          `Recovered stale installer ownership but could not remove its private stage: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    } finally {
      const recoveryOwner = readLockOwner(recoveryPath);
      if (recoveryOwner?.token === token) unlinkSync(recoveryPath);
    }
  }

  return {
    lockPath,
    owner,
    release: () => {
      const currentOwner = readLockOwner(lockPath);
      if (currentOwner?.token === token) unlinkSync(lockPath);
    },
  };
};

const missingDirectories = (path) => {
  const missing = [];
  let current = path;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return missing.reverse();
};

const createTrackedDirectory = (path, mode, createdDirectories) => {
  for (const directory of missingDirectories(path)) {
    mkdirSync(directory, { mode });
    createdDirectories.push(directory);
  }
};

const activateStagedPath = (stage, target, token) => {
  const backup = `${target}.rollback-${token}`;
  rmSync(backup, { recursive: true, force: true });
  if (pathLexists(target)) {
    renameSync(target, backup);
  }
  try {
    renameSync(stage, target);
  } catch (error) {
    if (pathLexists(backup)) renameSync(backup, target);
    throw error;
  }
  return {
    commit: () => rmSync(backup, { recursive: true, force: true }),
    rollback: () => {
      rmSync(target, { recursive: true, force: true });
      if (pathLexists(backup)) renameSync(backup, target);
    },
  };
};

export const createManagedInstallTransaction = ({
  home,
  token,
  agentDir,
  sessionDir,
  launcherPath,
}) => {
  const scratch = staleStagePath(home, token);
  mkdirSync(scratch, { mode: 0o700 });
  const stagedAgentDir = join(scratch, "agent");
  const stagedLauncherPath = join(scratch, "pipi");
  try {
    if (existsSync(agentDir)) {
      cpSync(agentDir, stagedAgentDir, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    } else {
      mkdirSync(stagedAgentDir, { mode: 0o700 });
    }
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }

  const activations = [];
  const createdDirectories = [];
  let agentActivated = false;
  let committed = false;
  const injectFailure = (step) => {
    if (process.env.PIPI_TEST_FAIL_AFTER_STEP === step) {
      throw new Error(`Injected installer failure after ${step}`);
    }
  };

  const activateAgent = () => {
    if (agentActivated) return;
    createTrackedDirectory(dirname(agentDir), 0o700, createdDirectories);
    activations.push(activateStagedPath(stagedAgentDir, agentDir, token));
    agentActivated = true;
    injectFailure("agent-activation");
  };

  return {
    stagedAgentDir,
    stagedLauncherPath,
    injectFailure,
    activateAgent,
    commit: () => {
      activateAgent();

      if (!existsSync(sessionDir)) {
        createTrackedDirectory(sessionDir, 0o700, createdDirectories);
      }
      injectFailure("session-activation");

      createTrackedDirectory(dirname(launcherPath), 0o755, createdDirectories);
      activations.push(
        activateStagedPath(stagedLauncherPath, launcherPath, token),
      );
      injectFailure("launcher-activation");

      committed = true;
      for (const activation of activations) {
        try {
          activation.commit();
        } catch (error) {
          console.warn(
            `Installed managed state but could not remove an activation backup: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `Installed managed state but could not remove its empty stage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    rollback: () => {
      if (!committed) {
        for (const activation of activations.reverse()) activation.rollback();
        for (const directory of createdDirectories.reverse()) {
          try {
            rmdirSync(directory);
          } catch {
            // Preserve nonempty directories that gained unrelated state.
          }
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    },
  };
};

export const writeExecutable = (path, content, mode = 0o700) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
};
