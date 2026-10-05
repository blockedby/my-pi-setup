import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  getDeclaredPipiVersion,
  readBunLock,
} from "../../scripts/pipi-version.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
test("multi-pass exact root/runtime pins and reviewed integrity are frozen", () => {
  for (const directory of [root, root + "/config/pipi-runtime"]) {
    const manifest = JSON.parse(
      readFileSync(directory + "/package.json", "utf8"),
    );
    assert.equal(
      (manifest.devDependencies ?? manifest.dependencies)["pi-multi-pass"],
      "1.5.1",
    );
    const locked = readBunLock(directory + "/bun.lock").packages[
      "pi-multi-pass"
    ];
    assert.equal(locked[0], "pi-multi-pass@1.5.1");
    assert.equal(
      locked[3],
      "sha512-+ArFAiXpcB3AglLGBJGn2yOQ5ZWLQ1qjiM7VQvLnLn5X7w8hOaLUfFTSx50+MglEIC4IKNaCJe5649ykydMX5Q==",
    );
  }
});

test("real Pi SDK loads unchanged multi-pass and manually switches without network or auth mutation", () => {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./fixtures/multi-pass-smoke.mjs", import.meta.url),
      ),
    ],
    { cwd: root, encoding: "utf8", timeout: 60000 },
  );
  const result = JSON.parse(output.trim().split("\n").at(-1));
  assert.deepEqual(result, {
    passed: true,
    runtime: getDeclaredPipiVersion(
      JSON.parse(readFileSync(root + "/package.json", "utf8")),
    ),
    package: "1.5.1",
    sameModelBothDirections: true,
    authUnchanged: true,
    defaultNoPoolSwitches: 0,
    defaultNoPoolRetries: 0,
    networkRequests: 0,
  });
});
