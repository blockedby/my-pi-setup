import assert from "node:assert/strict";
import test from "node:test";
import {
  createDelegationAdvisor,
  isTruncatedToolResult,
} from "./src/delegation-advisor.ts";

test("classifies only explicit supported truncation metadata", () => {
  assert.equal(
    isTruncatedToolResult("read", { truncation: { truncated: true } }),
    true,
  );
  assert.equal(isTruncatedToolResult("rg", { truncated: true }), true);
  assert.equal(isTruncatedToolResult("fd", { truncated: true }), true);
  assert.equal(
    isTruncatedToolResult("grep", {
      truncation: { truncated: true },
    }),
    true,
  );
  assert.equal(
    isTruncatedToolResult("find", {
      truncation: { truncated: true },
    }),
    true,
  );
  assert.equal(isTruncatedToolResult("grep", { matchLimitReached: 100 }), true);
  assert.equal(isTruncatedToolResult("grep", { linesTruncated: true }), true);
  assert.equal(
    isTruncatedToolResult("find", { resultLimitReached: 1000 }),
    true,
  );

  assert.equal(
    isTruncatedToolResult("read", { truncation: { truncated: false } }),
    false,
  );
  assert.equal(isTruncatedToolResult("rg", { truncated: false }), false);
  assert.equal(isTruncatedToolResult("other", { truncated: true }), false);
  assert.equal(
    isTruncatedToolResult("grep", { matchLimitReached: "100" }),
    false,
  );
  assert.equal(isTruncatedToolResult("find", undefined), false);
  assert.equal(isTruncatedToolResult("read", null), false);
});

test("compatibility advisor is silent across truncation, errors, tools and resets", () => {
  const advisor = createDelegationAdvisor();
  const content = [
    { type: "image" as const, data: "image-data", mimeType: "image/png" },
    { type: "text" as const, text: "partial output", textSignature: "sig" },
  ];
  const original = structuredClone(content);

  for (const activeTools of [[], ["read"], ["read", "subagent_spawn"]]) {
    for (const isError of [true, false]) {
      for (const [toolName, details] of [
        ["read", { truncation: { truncated: true } }],
        ["rg", { truncated: true }],
        ["fd", { truncated: false }],
        ["other", undefined],
      ] as const) {
        const options = { activeTools, isError, toolName, details, content };
        assert.equal(advisor.patchResult(options), undefined);
        assert.equal(advisor.patchResult(options), undefined);
        advisor.reset();
        assert.equal(advisor.patchResult(options), undefined);
        assert.deepEqual(content, original);
      }
    }
  }
});
