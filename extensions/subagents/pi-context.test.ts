import assert from "node:assert/strict";
import test from "node:test";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import {
  normalizePiContextUsage,
  refreshPiUsageAfterCompaction,
} from "./src/backends/pi.ts";

const compactionResult: CompactionResult = {
  summary: "summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 311_923,
  details: { readFiles: [], modifiedFiles: [] },
};

test("Pi context adapter preserves an explicit unknown token count", () => {
  assert.deepEqual(
    normalizePiContextUsage({
      tokens: null,
      contextWindow: 300_000,
      percent: null,
    }),
    { tokens: null, contextWindow: 300_000 },
  );
});

test("Pi context adapter omits unavailable tokens without clearing prior state", () => {
  assert.deepEqual(normalizePiContextUsage(undefined, 300_000), {
    contextWindow: 300_000,
  });
});

test("Pi context adapter prefers the active model capacity", () => {
  assert.deepEqual(
    normalizePiContextUsage(
      { tokens: 311_923, contextWindow: 200_000, percent: 155.9615 },
      300_000,
    ),
    { tokens: 311_923, contextWindow: 300_000 },
  );
});

test("successful Pi compaction refreshes usage", () => {
  let refreshes = 0;
  refreshPiUsageAfterCompaction(
    {
      type: "compaction_end",
      reason: "threshold",
      result: compactionResult,
      aborted: false,
      willRetry: false,
    },
    () => {
      refreshes += 1;
    },
  );
  assert.equal(refreshes, 1);
});

test("aborted or result-less Pi compaction keeps prior usage", () => {
  let refreshes = 0;
  const emitUsage = () => {
    refreshes += 1;
  };
  refreshPiUsageAfterCompaction(
    {
      type: "compaction_end",
      reason: "threshold",
      result: compactionResult,
      aborted: true,
      willRetry: false,
    },
    emitUsage,
  );
  refreshPiUsageAfterCompaction(
    {
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
    },
    emitUsage,
  );
  assert.equal(refreshes, 0);
});
