import { LoomError, isIdOf, type SourceSpan } from "@ai-plugin-toolkit/core";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { spanText, speakerAt } from "./evidence-text.js";

export interface ResolvedSpan extends SourceSpan {
  sourceTitle: string | undefined;
  speaker: string;
  /** Exact original text at the span (decoded from JSON escaping for conversation messages). */
  text: string;
}

/** Resolve spans to the original evidence; fails loudly if a span no longer resolves. */
export async function resolveSpans(store: LoomStore, projectId: string, spans: readonly SourceSpan[]): Promise<ResolvedSpan[]> {
  const out: ResolvedSpan[] = [];
  for (const span of spans) {
    const source = store.getSource(projectId, span.sourceId);
    if (source === undefined) throw new LoomError("NOT_FOUND", `Span cites ${span.sourceId}, which is not in project "${projectId}".`);
    const text = await store.readSourceText(projectId, source.id);
    if (span.end > text.length) throw new LoomError("INTERNAL", `Span ${span.start}-${span.end} is outside ${source.id}.`);
    out.push({ ...span, sourceTitle: source.title, speaker: speakerAt(source, text, span.start), text: spanText(source, text, span) });
  }
  return out;
}

export type MemoryRecord =
  | { kind: "fact"; record: NonNullable<ReturnType<LoomStore["memory"]["getFact"]>>; evidence: ResolvedSpan[] }
  | { kind: "decision"; record: NonNullable<ReturnType<LoomStore["memory"]["getDecision"]>>; evidence: ResolvedSpan[] };

/** A fact or decision with its evidence opened (A03: source ID and exact span resolve to the original). */
export async function describeRecord(store: LoomStore, projectId: string, id: string): Promise<MemoryRecord> {
  if (isIdOf("fact", id)) {
    const record = store.memory.getFact(projectId, id);
    if (record !== undefined) return { kind: "fact", record, evidence: await resolveSpans(store, projectId, record.spans) };
  } else if (isIdOf("decision", id)) {
    const record = store.memory.getDecision(projectId, id);
    if (record !== undefined) return { kind: "decision", record, evidence: await resolveSpans(store, projectId, record.spans) };
  }
  throw new LoomError("NOT_FOUND", `No fact or decision ${id} in project "${projectId}".`);
}
