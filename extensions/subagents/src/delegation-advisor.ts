import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type ToolResultContent = TextContent | ImageContent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTruncatedDetails(details: unknown) {
  if (!isRecord(details) || !isRecord(details.truncation)) return false;
  return details.truncation.truncated === true;
}

function hasNumericLimitFlag(details: unknown, key: string) {
  return isRecord(details) && typeof details[key] === "number";
}

/** Recognizes only explicit truncation metadata from supported tool contracts. */
export function isTruncatedToolResult(toolName: string, details: unknown) {
  if (toolName === "read") return hasTruncatedDetails(details);
  if (toolName === "rg" || toolName === "fd") {
    return isRecord(details) && details.truncated === true;
  }
  if (toolName === "grep") {
    return (
      hasTruncatedDetails(details) ||
      hasNumericLimitFlag(details, "matchLimitReached") ||
      (isRecord(details) && details.linesTruncated === true)
    );
  }
  if (toolName === "find") {
    return (
      hasTruncatedDetails(details) ||
      hasNumericLimitFlag(details, "resultLimitReached")
    );
  }
  return false;
}

/** Compatibility API: tools already supply their own continuation/read hints.
 * Truncation is not evidence that a task needs delegation.
 */
export function createDelegationAdvisor() {
  return {
    reset() {
      // No run state is retained.
    },
    patchResult(_options: {
      activeTools: readonly string[];
      toolName: string;
      details: unknown;
      isError: boolean;
      content: readonly ToolResultContent[];
    }) {
      return undefined;
    },
  };
}
