import type { Source } from "@ai-plugin-toolkit/core";

/**
 * Helpers that relate model-facing text back to the original bytes. Spans always
 * index the stored original (verbatim JSON for conversations), so `loom memory show`
 * can display exactly what was said.
 */

export interface MessageRange {
  index: number;
  role: string;
  /** Offsets of the message content inside the original text (inside the JSON quotes). */
  start: number;
  end: number;
  content: string;
}

interface ConversationShape {
  messages?: Array<{ role?: unknown; content?: unknown }>;
}

function isConversation(source: Source): boolean {
  return source.type === "conversation" && source.mediaType === "application/json";
}

/** Locate each message's content within the raw JSON text, in order. */
export function messageRanges(source: Source, text: string): MessageRange[] {
  if (!isConversation(source)) return [];
  let parsed: ConversationShape;
  try {
    parsed = JSON.parse(text) as ConversationShape;
  } catch {
    return [];
  }
  const ranges: MessageRange[] = [];
  let cursor = 0;
  for (const [index, message] of (parsed.messages ?? []).entries()) {
    if (typeof message.content !== "string" || typeof message.role !== "string") continue;
    const encoded = JSON.stringify(message.content);
    const at = text.indexOf(encoded, cursor);
    if (at === -1) continue; // non-canonical escaping; speaker lookup falls back to "unknown"
    ranges.push({ index: index + 1, role: message.role, start: at + 1, end: at + encoded.length - 1, content: message.content });
    cursor = at + encoded.length;
  }
  return ranges;
}

/** Text shown to the model: numbered messages for conversations, the original otherwise. */
export function renderForModel(source: Source, text: string): string {
  const ranges = messageRanges(source, text);
  if (ranges.length === 0) return text;
  return ranges.map((m) => `[#${m.index} ${m.role}] ${m.content}`).join("\n");
}

/**
 * Resolve an exact quote to a span in the original text. Tries the literal quote and,
 * for JSON conversations, its JSON-escaped form. Returns undefined when it does not occur.
 */
export function resolveQuote(source: Source, text: string, quote: string): { start: number; end: number } | undefined {
  const candidates = [quote];
  if (isConversation(source)) candidates.push(JSON.stringify(quote).slice(1, -1));
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const at = text.indexOf(candidate);
    if (at !== -1) return { start: at, end: at + candidate.length };
  }
  return undefined;
}

/** Who said the text at `offset`: a conversation role, or the source type for documents and tool output. */
export function speakerAt(source: Source, text: string, offset: number): string {
  if (!isConversation(source)) return source.type;
  const range = messageRanges(source, text).find((m) => offset >= m.start && offset < m.end);
  return range?.role ?? "unknown";
}

/** Exact original text of a span, decoded from JSON escaping when it lies inside a conversation message. */
export function spanText(source: Source, text: string, span: { start: number; end: number }): string {
  const raw = text.slice(span.start, span.end);
  if (!isConversation(source)) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}
