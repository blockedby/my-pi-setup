import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertBunLockPolicy } from "../../scripts/install-dependencies.mjs";

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pipi-bun-lock-policy-"));
  mkdirSync(join(root, "extensions", "example"), { recursive: true });
  writeFileSync(join(root, "bun.lock"), "{}\n");
  return root;
};

test("root bun.lock is the only authoritative first-party workspace lock", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertBunLockPolicy(root));

  mkdirSync(join(root, "config", "pipi-runtime"), { recursive: true });
  writeFileSync(
    join(root, "config", "pipi-runtime", "package-lock.json"),
    "{}\n",
  );
  assert.throws(
    () => assertBunLockPolicy(root),
    /Stale first-party lockfiles.*config\/pipi-runtime\/package-lock\.json/,
  );

  await rm(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  assert.throws(
    () => assertBunLockPolicy(root),
    /Stale first-party lockfiles.*package-lock\.json/,
  );
});

test("per-extension locks are rejected and a missing root lock fails closed", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  writeFileSync(join(root, "extensions", "example", "bun.lock"), "{}\n");
  assert.throws(
    () => assertBunLockPolicy(root),
    /extensions\/example\/bun\.lock/,
  );

  await rm(join(root, "extensions", "example", "bun.lock"));
  await rm(join(root, "bun.lock"));
  assert.throws(
    () => assertBunLockPolicy(root),
    /Missing authoritative root bun\.lock/,
  );
});
