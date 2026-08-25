import type { AgentTranscriptItem, AgentTreeSessionEvent } from "./domain.ts";

export const MAX_TRANSCRIPT_ITEMS = 512;
export const MAX_TRANSCRIPT_TEXT = 64 * 1024;

export function boundedTranscriptText(text: string) {
  return text.slice(0, MAX_TRANSCRIPT_TEXT);
}

export function appendTranscriptEvent(
  transcript: AgentTranscriptItem[],
  event: AgentTreeSessionEvent,
  now = Date.now(),
) {
  if (event.type === "user") {
    transcript.push({
      kind: "user",
      text: boundedTranscriptText(event.text),
      at: now,
    });
  } else if (event.type === "assistant") {
    transcript.push({
      kind: "assistant",
      text: boundedTranscriptText(event.text),
      ...(event.thinking
        ? { thinking: boundedTranscriptText(event.thinking) }
        : {}),
      at: now,
    });
  } else if (event.type === "tool") {
    transcript.push({
      kind: "tool",
      phase: event.phase,
      toolCallId: event.toolCallId,
      name: event.name,
      text: boundedTranscriptText(event.text),
      isError: event.isError,
      at: now,
    });
  } else {
    return;
  }

  if (transcript.length > MAX_TRANSCRIPT_ITEMS) {
    transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ITEMS);
  }
}
