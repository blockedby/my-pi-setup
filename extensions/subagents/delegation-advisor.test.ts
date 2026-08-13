import assert from "node:assert/strict";
import test from "node:test";
import {
  createDelegationAdvisor,
  DELEGATION_ADVISORY_TEXT,
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

test("appends one advisory while preserving original content and patch scope", () => {
  const advisor = createDelegationAdvisor();
  const content = [
    { type: "image" as const, data: "image-data", mimeType: "image/png" },
    { type: "text" as const, text: "partial text", textSignature: "sig" },
  ];

  const patch = advisor.patchResult({
    activeTools: ["read", "subagent_spawn"],
    toolName: "read",
    details: { truncation: { truncated: true } },
    isError: false,
    content,
  });

  assert.ok(patch);
  assert.deepEqual(Object.keys(patch), ["content"]);
  assert.deepEqual(patch.content, [
    ...content,
    { type: "text", text: DELEGATION_ADVISORY_TEXT },
  ]);
  assert.strictEqual(patch.content[0], content[0]);
  assert.strictEqual(patch.content[1], content[1]);
  assert.deepEqual(content, [
    { type: "image", data: "image-data", mimeType: "image/png" },
    { type: "text", text: "partial text", textSignature: "sig" },
  ]);
});

test("requires an active spawn tool and a successful result", () => {
  const advisor = createDelegationAdvisor();
  const base = {
    toolName: "read",
    details: { truncation: { truncated: true } },
    content: [],
  };

  assert.equal(
    advisor.patchResult({
      ...base,
      activeTools: [],
      isError: false,
    }),
    undefined,
  );
  assert.equal(
    advisor.patchResult({
      ...base,
      activeTools: ["subagent_spawn"],
      isError: true,
    }),
    undefined,
  );
  assert.equal(
    advisor.patchResult({
      ...base,
      activeTools: ["subagent_spawn"],
      isError: false,
      details: { truncation: { truncated: false } },
    }),
    undefined,
  );
  assert.equal(
    advisor.patchResult({
      ...base,
      activeTools: ["subagent_spawn"],
      isError: false,
      details: { truncation: true },
    }),
    undefined,
  );
});

test("deduplicates within a run and advises again after reset", () => {
  const advisor = createDelegationAdvisor();
  const options = {
    activeTools: ["subagent_spawn"],
    toolName: "rg",
    details: { truncated: true },
    isError: false,
    content: [],
  };

  assert.ok(advisor.patchResult(options));
  assert.equal(advisor.patchResult(options), undefined);

  advisor.reset();
  assert.ok(advisor.patchResult(options));
});
