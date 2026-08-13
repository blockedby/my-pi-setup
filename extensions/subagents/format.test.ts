import assert from "node:assert/strict";
import test from "node:test";
import { formatContextUtilization } from "./src/format.ts";

test("renders unknown occupancy with the known capacity", () => {
  assert.equal(
    formatContextUtilization({ tokens: null, contextWindow: 300_000 }),
    "?%/300k",
  );
});

test("renders exact capacity as 100 percent", () => {
  assert.equal(
    formatContextUtilization({ tokens: 300_000, contextWindow: 300_000 }),
    "100%/300k",
  );
});

test("marks any over-capacity occupancy instead of clamping it", () => {
  assert.equal(
    formatContextUtilization({ tokens: 311_923, contextWindow: 300_000 }),
    ">100%/300k",
  );
  assert.equal(
    formatContextUtilization({ tokens: 300_001, contextWindow: 300_000 }),
    ">100%/300k",
  );
});
