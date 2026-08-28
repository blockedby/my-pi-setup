import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MINIMUM_BUN_VERSION,
  MINIMUM_SANDBOX_NODE_VERSION,
  parseRuntimeVersion,
  resolveBunRuntime,
  resolveSandboxNodeRuntime,
  runtimeVersionAtLeast,
} from "../../extensions/shared/executable-runtime.ts";

test("repository tests execute under the supported Bun authority", () => {
  assert.equal(typeof process.versions.bun, "string");
  const runtime = resolveBunRuntime({
    env: { ...process.env, PIPI_BUN_RUNTIME: undefined },
  });
  assert.equal(runtime.executable, process.execPath);
  assert.equal(runtime.version, process.versions.bun);
  assert.equal(
    runtimeVersionAtLeast(runtime.version, MINIMUM_BUN_VERSION),
    true,
  );
});

test("runtime version parsing is strict and compares semantic components", () => {
  assert.deepEqual(parseRuntimeVersion("1.4.0\n"), [1, 4, 0]);
  assert.equal(parseRuntimeVersion("1.4.1-canary.2"), undefined);
  assert.equal(parseRuntimeVersion("1.4.1+build.2"), undefined);
  assert.deepEqual(parseRuntimeVersion("v24.20.0"), [24, 20, 0]);
  assert.equal(parseRuntimeVersion("Bun 1.4.0"), undefined);
  assert.equal(runtimeVersionAtLeast("1.4.0", "1.4.0"), true);
  assert.equal(runtimeVersionAtLeast("1.10.0", "1.4.0"), true);
  assert.equal(runtimeVersionAtLeast("1.3.9", "1.4.0"), false);
  assert.equal(runtimeVersionAtLeast("1.4.0-canary.1", "1.4.0"), false);
});

test("missing and too-old Bun errors are actionable", () => {
  assert.throws(
    () =>
      resolveBunRuntime({
        env: { PATH: "" },
        pathValue: "",
        currentExecutable: undefined,
        currentVersion: undefined,
      }),
    new RegExp(`Bun >= ${MINIMUM_BUN_VERSION}.*PIPI_BUN_RUNTIME`),
  );
  assert.throws(
    () =>
      resolveBunRuntime({
        env: { ...process.env, PIPI_BUN_RUNTIME: process.execPath },
        currentExecutable: undefined,
        currentVersion: undefined,
        probeVersion: () => "1.3.9",
      }),
    /Bun >= 1\.4\.0.*unsupported 1\.3\.9/,
  );
});

test("workflow security fallback resolves capability-verified Node, never Bun", () => {
  const runtime = resolveSandboxNodeRuntime({
    env: { ...process.env, PIPI_NODE_RUNTIME: undefined },
  });
  assert.notEqual(runtime.executable, process.execPath);
  assert.equal(
    runtimeVersionAtLeast(runtime.version, MINIMUM_SANDBOX_NODE_VERSION),
    true,
  );
});

test("sandbox rejects a fake Node wrapper that only reports a supported version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pipi-fake-node-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fakeNode = join(root, "node");
  writeFileSync(fakeNode, "#!/bin/sh\nprintf 'v24.20.0\\n'\n");
  chmodSync(fakeNode, 0o700);

  assert.throws(
    () =>
      resolveSandboxNodeRuntime({
        env: { PATH: root, PIPI_NODE_RUNTIME: fakeNode },
        currentExecutable: undefined,
        currentVersion: undefined,
      }),
    /required security capability was not verified/,
  );
});

test("a supported PATH Node replaces an old current-process Node", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pipi-old-node-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldNode = join(root, "node");
  writeFileSync(oldNode, "#!/bin/sh\nprintf 'v20.0.0\\n'\n");
  chmodSync(oldNode, 0o700);
  const supportedNode = resolveSandboxNodeRuntime({
    env: { PATH: dirname(process.execPath).replace(/bun$/, "") },
    pathValue: "/usr/bin:/bin",
    currentExecutable: oldNode,
    currentVersion: "20.0.0",
  });
  assert.notEqual(supportedNode.executable, oldNode);
  assert.equal(
    runtimeVersionAtLeast(supportedNode.version, MINIMUM_SANDBOX_NODE_VERSION),
    true,
  );
});
