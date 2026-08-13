import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** Model-visible guidance appended after an explicit truncated tool result. */
export const DELEGATION_ADVISORY_TEXT =
  'Advisory: this result was truncated. Consider delegating a self-contained follow-up to `subagent_spawn` with `profile: "luna-explore"`; do not wait or poll for it.';

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
      hasNumericLimitFlag(details, "matchLimitReached")
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

/**
 * Holds the one-advisory-per-parent-run state without retaining paths, queries,
 * or any other event history.
 */
export function createDelegationAdvisor() {
  let advised = false;

  return {
    reset() {
      advised = false;
    },

    patchResult(options: {
      activeTools: readonly string[];
      toolName: string;
      details: unknown;
      isError: boolean;
      content: readonly ToolResultContent[];
    }) {
      if (
        advised ||
        options.isError ||
        !options.activeTools.includes("subagent_spawn") ||
        !isTruncatedToolResult(options.toolName, options.details)
      ) {
        return;
      }

      advised = true;
      const advisoryTextBlock: TextContent = {
        type: "text",
        text: DELEGATION_ADVISORY_TEXT,
      };
      return { content: [...options.content, advisoryTextBlock] };
    },
  };
}
