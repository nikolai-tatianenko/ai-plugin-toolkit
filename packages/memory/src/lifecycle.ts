import { z } from "zod";
import {
  DecisionSchema,
  FactSchema,
  LoomError,
  SourceSchema,
  newId,
  parseWith,
  stableId,
  type Fact,
  type SourceSpan,
} from "@ai-plugin-toolkit/core";
import type { LoomStore, StoredDecision } from "@ai-plugin-toolkit/storage-sqlite";
import { spanText } from "./evidence-text.js";

/**
 * Memory lifecycle (CL-013): corrections, contradiction review, scoped forgetting,
 * export/import and retention. Corrections and forgetting are different operations:
 * a correction supersedes and keeps history; forgetting removes content.
 */

// ---- Supersession -----------------------------------------------------------------

/**
 * Recompute which confirmed decision is current for a topic: the newest confirmed one
 * by evidence time. Older confirmed decisions become superseded. Decisions whose
 * superseder no longer exists are restored first. Returns IDs that changed.
 */
export function recomputeTopic(store: LoomStore, projectId: string, topic: string): { superseded: string[]; restored: string[] } {
  const all = store.memory.decisionsOnTopic(projectId, topic);
  const ids = new Set(all.map((d) => d.id));
  const restored: string[] = [];
  for (const d of all) {
    if (d.status === "superseded" && (d.supersededBy === undefined || !ids.has(d.supersededBy) || all.find((x) => x.id === d.supersededBy)?.status === "rejected")) {
      store.memory.setDecisionStatus(projectId, d.id, "confirmed");
      restored.push(d.id);
    }
  }
  const [current, ...older] = store.memory.confirmedOnTopic(projectId, topic);
  const superseded: string[] = [];
  for (const old of older) {
    store.memory.supersedeDecision(projectId, old.id, current!.id);
    superseded.push(old.id);
  }
  return { superseded, restored: restored.filter((id) => !superseded.includes(id)) };
}

/**
 * Record review items for supersessions across different sources. Within one source the
 * order is explicit; across sources it rests on timestamps, so a person should confirm.
 */
export function flagCrossSourceSupersession(store: LoomStore, projectId: string, supersededIds: readonly string[]): number {
  let added = 0;
  for (const id of supersededIds) {
    const old = store.memory.getDecision(projectId, id);
    if (old?.supersededBy === undefined) continue;
    const current = store.memory.getDecision(projectId, old.supersededBy);
    if (current === undefined) continue;
    const sourcesOld = new Set(old.spans.map((s) => s.sourceId));
    if (current.spans.some((s) => sourcesOld.has(s.sourceId))) continue;
    if (
      store.memory.addReviewItem(projectId, {
        kind: "decision-superseded",
        recordIds: [old.id, current.id],
        detail: `"${current.choice}" (${current.spans[0]?.sourceId}) replaced "${old.choice}" (${old.spans[0]?.sourceId}) on topic "${current.topic}" because its evidence is newer. Accept, or revert to keep "${old.choice}".`,
      })
    ) {
      added++;
    }
  }
  return added;
}

// ---- Contradictions -------------------------------------------------------------

const NEGATION = /\b(no|not|never|without|none|cannot|can't|won't|don't|doesn't|isn't|aren't|mustn't|shouldn't)\b/i;
const tokens = (text: string) =>
  new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (t) => t.length > 2 && !NEGATION.test(t) && !["the", "and", "for", "must", "should", "will", "app", "are", "is"].includes(t),
    ),
  );

/** Heuristic: similar wording, but exactly one of the two statements is negated. */
export function looksContradictory(a: string, b: string): boolean {
  if (NEGATION.test(a) === NEGATION.test(b)) return false;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.6;
}

/** Flag possible contradictions between new facts and existing active facts. Nothing is resolved automatically. */
export function detectContradictions(store: LoomStore, projectId: string, factIds: readonly string[]): number {
  const facts = store.memory.listFacts(projectId);
  let added = 0;
  for (const id of factIds) {
    const fact = facts.find((f) => f.id === id);
    if (fact === undefined) continue;
    for (const other of facts) {
      if (other.id === fact.id || !looksContradictory(fact.statement, other.statement)) continue;
      if (
        store.memory.addReviewItem(projectId, {
          kind: "possible-contradiction",
          recordIds: [fact.id, other.id],
          detail: `"${fact.statement}" vs "${other.statement}". Keep one (the other is rejected), or dismiss if both hold.`,
        })
      ) {
        added++;
      }
    }
  }
  return added;
}

export type ReviewAction = { action: "accept" } | { action: "revert" } | { action: "keep"; recordId: string } | { action: "dismiss" };

/** Resolve a review item. Every resolution is explicit and audited; nothing is deleted. */
export function resolveReview(store: LoomStore, projectId: string, itemId: string, decision: ReviewAction, actor: string): string {
  const item = store.memory.reviewItems(projectId).find((i) => i.id === itemId);
  if (item === undefined) throw new LoomError("NOT_FOUND", `No open review item ${itemId}.`);
  return store.transaction(() => {
    let resolution: string;
    if (decision.action === "dismiss") {
      store.memory.closeReviewItem(projectId, itemId, "dismissed", "dismissed: both records stand", actor);
      resolution = "dismissed";
    } else if (item.kind === "decision-superseded") {
      const [oldId, newId] = item.recordIds.map((id) => store.memory.getDecision(projectId, id)!).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).map((d) => d.id);
      if (decision.action === "revert") {
        const newer = store.memory.getDecision(projectId, newId!)!;
        store.memory.setDecisionStatus(projectId, newId!, "rejected");
        recomputeTopic(store, projectId, newer.topic!);
        resolution = `reverted: kept ${oldId}, rejected ${newId}`;
      } else if (decision.action === "accept") {
        resolution = `accepted: ${newId} supersedes ${oldId}`;
      } else {
        throw new LoomError("VALIDATION_FAILED", "Use accept or revert for a superseded decision.");
      }
      store.memory.closeReviewItem(projectId, itemId, "resolved", resolution, actor);
    } else if (item.kind === "possible-contradiction") {
      if (decision.action !== "keep" || !item.recordIds.includes(decision.recordId)) {
        throw new LoomError("VALIDATION_FAILED", `Use --keep with one of: ${item.recordIds.join(", ")} (or dismiss).`);
      }
      const drop = item.recordIds.find((id) => id !== decision.recordId)!;
      store.memory.setFactStatus(projectId, drop, "rejected");
      resolution = `kept ${decision.recordId}, rejected ${drop}`;
      store.memory.closeReviewItem(projectId, itemId, "resolved", resolution, actor);
    } else {
      throw new LoomError("VALIDATION_FAILED", `Unknown review kind ${item.kind}.`);
    }
    store.cache.clear(projectId);
    store.audit(projectId, "memory.review", actor, [itemId, ...item.recordIds]);
    return resolution;
  });
}

// ---- Corrections (A06) ------------------------------------------------------------

export interface CorrectionInput {
  topic: string;
  choice: string;
  reason: string;
  actor: string;
  statement?: string;
}

/**
 * Record a person's correction. The correction text becomes its own source (so the new
 * decision cites real evidence), the decision is confirmed by the actor, and older
 * decisions on the topic are superseded with history kept.
 */
export async function correctDecision(store: LoomStore, projectId: string, input: CorrectionInput) {
  const topic = input.topic.trim().toLowerCase();
  if (topic === "" || input.choice.trim() === "" || input.reason.trim() === "") {
    throw new LoomError("VALIDATION_FAILED", "A correction needs a topic, a choice and a reason.");
  }
  const at = new Date().toISOString();
  const statement = input.statement?.trim() || `Decision on ${topic}: ${input.choice.trim()}.`;
  const text = `Correction recorded by ${input.actor} on ${at}\nTopic: ${topic}\nDecision: ${input.choice.trim()}\nStatement: ${statement}\nReason: ${input.reason.trim()}\n`;
  const [outcome] = await store.ingest(projectId, [{ type: "document", text, title: `Correction: ${topic}`, createdAt: at }], { actor: input.actor });
  const source = outcome!.source;
  const choiceAt = text.indexOf(`Decision: ${input.choice.trim()}`) + "Decision: ".length;
  const span: SourceSpan = { sourceId: source.id, start: choiceAt, end: choiceAt + input.choice.trim().length };
  const runId = store.memory.startRun({ projectId, sourceId: source.id, promptVersion: "correction-v1", provider: "person", model: input.actor });
  return store.transaction(() => {
    const previous = store.memory.confirmedOnTopic(projectId, topic)[0];
    const decision = {
      id: stableId("decision", projectId, source.id, `${span.start}-${span.end}`, input.choice.trim().toLowerCase()),
      projectId,
      topic,
      choice: input.choice.trim(),
      statement,
      rationale: input.reason.trim(),
      alternatives: previous === undefined ? [] : [previous.choice],
      status: "confirmed" as const,
      confirmedBy: `${input.actor} (correction ${source.id})`,
      ...(previous === undefined ? {} : { supersedes: previous.id }),
      spans: [span],
      createdAt: at,
    };
    store.memory.insertDecision(decision, runId);
    const { superseded } = recomputeTopic(store, projectId, topic);
    store.memory.finishRun(runId, { status: "ok", accepted: 1 });
    store.cache.clear(projectId);
    store.audit(projectId, "memory.correct", input.actor, [decision.id, source.id, ...superseded]);
    return { decision: store.memory.getDecision(projectId, decision.id)!, superseded, sourceId: source.id };
  });
}

// ---- Forgetting (A21) ----------------------------------------------------------------

export interface ForgetResult {
  sourceId: string;
  deletedRecords: string[];
  updatedRecords: string[];
  restoredDecisions: string[];
  cacheEntriesRemoved: number;
  payloadFileRemoved: boolean;
  /** Text fragments that were removed, for scanning exports and artifacts afterwards. Not persisted. */
  removedText: string[];
}

/**
 * Forget a source: delete it and everything derived only from it (facts, decisions,
 * rejected candidates, index rows, embeddings, caches, review items), trim spans of
 * records that also cite other sources, repair supersession, then scrub the database
 * file. Artifacts are regenerated by the caller. Audit events keep IDs only.
 */
export async function forgetSource(store: LoomStore, projectId: string, sourceId: string, actor: string): Promise<ForgetResult> {
  const source = store.getSource(projectId, sourceId);
  if (source === undefined) throw new LoomError("NOT_FOUND", `Source ${sourceId} not found in project "${projectId}".`);
  const text = await store.readSourceText(projectId, sourceId);
  const deletedRecords: string[] = [];
  const updatedRecords: string[] = [];
  const removedText = new Set<string>([source.title ?? ""].filter((t) => t.length >= 8));
  const topics = new Set<string>();
  let cacheEntriesRemoved = 0;

  store.transaction(() => {
    for (const id of store.memory.recordsCiting(projectId, sourceId)) {
      const record: Fact | StoredDecision | undefined = id.startsWith("fct_") ? store.memory.getFact(projectId, id) : store.memory.getDecision(projectId, id);
      if (record === undefined) continue;
      for (const span of record.spans.filter((s) => s.sourceId === sourceId)) removedText.add(spanText(source, text, span));
      if ("topic" in record && record.topic !== undefined) topics.add(record.topic);
      const remaining = record.spans.filter((s) => s.sourceId !== sourceId);
      if (remaining.length === 0) {
        if ("statement" in record) removedText.add(record.statement);
        store.memory.deleteRecord(projectId, id);
        deletedRecords.push(id);
      } else {
        store.memory.replaceSpans(projectId, id, remaining);
        updatedRecords.push(id);
      }
    }
    store.memory.deleteRunsForSource(projectId, sourceId);
    cacheEntriesRemoved = store.cache.clear(projectId);
    store.cache.clearTransforms(projectId);
  });
  const { payloadRemoved } = await store.deleteSource(projectId, sourceId);
  const restored: string[] = [];
  store.transaction(() => {
    for (const topic of topics) restored.push(...recomputeTopic(store, projectId, topic).restored);
    store.memory.bump(projectId);
    store.audit(projectId, "memory.forget", actor, [sourceId, ...deletedRecords]);
  });
  store.scrub();
  return {
    sourceId,
    deletedRecords,
    updatedRecords,
    restoredDecisions: restored,
    cacheEntriesRemoved,
    payloadFileRemoved: payloadRemoved,
    removedText: [...removedText].filter((t) => t.trim().length >= 8),
  };
}

// ---- Retention -------------------------------------------------------------------------

/** Sources older than `maxAgeDays` by ingest time. */
export function sourcesPastRetention(store: LoomStore, projectId: string, maxAgeDays: number, now = Date.now()): string[] {
  const cutoff = now - maxAgeDays * 86_400_000;
  const out: string[] = [];
  const total = store.countSources(projectId);
  for (let offset = 0; offset < total; offset += 500) {
    for (const s of store.listSources(projectId, { limit: 500, offset })) if (Date.parse(s.ingestedAt) < cutoff) out.push(s.id);
  }
  return out;
}

// ---- Export / import ---------------------------------------------------------------------

export const EXPORT_FORMAT = "loom-export/1";

const ExportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  exportedAt: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
  sources: z.array(z.object({ source: SourceSchema, text: z.string() })),
  facts: z.array(FactSchema),
  decisions: z.array(z.object({ decision: DecisionSchema, statement: z.string(), supersededBy: z.string().optional() })),
  answers: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(z.record(z.string(), z.unknown())),
  dispositions: z.array(z.record(z.string(), z.unknown())),
  revision: z.string().optional(),
});
export type ProjectExport = z.infer<typeof ExportSchema>;

/** Portable JSON of a project's memory and acceptance state (tasks and sync mappings are adapter-specific and excluded). */
export async function exportProject(store: LoomStore, projectId: string, projectName: string): Promise<ProjectExport> {
  const sources: ProjectExport["sources"] = [];
  const total = store.countSources(projectId);
  for (let offset = 0; offset < total; offset += 500) {
    for (const source of store.listSources(projectId, { limit: 500, offset })) sources.push({ source, text: await store.readSourceText(projectId, source.id) });
  }
  const packs = store.acceptance.activePacks(projectId);
  const revision = store.state.get(projectId, "build.revision");
  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    project: { id: projectId, name: projectName },
    sources,
    facts: store.memory.listFacts(projectId, { includeInactive: true }),
    decisions: store.memory.listDecisions(projectId, { includeInactive: true }).map(({ statement, supersededBy, ...decision }) => ({
      decision,
      statement,
      ...(supersededBy === undefined ? {} : { supersededBy }),
    })),
    answers: packs.flatMap((p) => store.acceptance.answers(projectId, p.packId)) as unknown as Array<Record<string, unknown>>,
    evidence: store.acceptance.evidence(projectId) as unknown as Array<Record<string, unknown>>,
    dispositions: store.acceptance.dispositions(projectId) as unknown as Array<Record<string, unknown>>,
    ...(revision === undefined ? {} : { revision }),
  };
}

/**
 * Import an export into a project with no sources yet (migration between machines or
 * storage directories). IDs are preserved because they derive from project and content.
 */
export async function importProject(store: LoomStore, projectId: string, raw: unknown, actor: string): Promise<{ sources: number; facts: number; decisions: number }> {
  const data = parseWith(ExportSchema, raw, "export file");
  if (data.project.id !== projectId) {
    throw new LoomError("VALIDATION_FAILED", `Export is for project "${data.project.id}", not "${projectId}". IDs are project-scoped; import into a project with the same ID.`);
  }
  if (store.countSources(projectId) > 0) throw new LoomError("ALREADY_EXISTS", `Project "${projectId}" already has sources; import only into an empty project.`);
  if (data.sources.length > 0) {
    await store.ingest(
      projectId,
      data.sources.map(({ source, text }) => ({
        type: source.type,
        text,
        mediaType: source.mediaType,
        ...(source.title === undefined ? {} : { title: source.title }),
        ...(source.createdAt === undefined ? {} : { createdAt: source.createdAt }),
      })),
      { actor },
    );
  }
  return store.transaction(() => {
    const runs = new Map<string, string>();
    const runFor = (sourceId: string) => {
      let run = runs.get(sourceId);
      if (run === undefined) {
        run = store.memory.startRun({ projectId, sourceId, promptVersion: "import-v1", provider: "import" });
        store.memory.finishRun(run, { status: "ok" });
        runs.set(sourceId, run);
      }
      return run;
    };
    for (const fact of data.facts) store.memory.insertFact(fact, runFor(fact.spans[0]!.sourceId));
    for (const { decision, statement } of data.decisions) {
      store.memory.insertDecision({ ...decision, statement, ...(decision.status === "superseded" ? { status: "confirmed" as const } : {}) }, runFor(decision.spans[0]!.sourceId));
    }
    for (const topic of new Set(data.decisions.map((d) => d.decision.topic).filter((t): t is string => t !== undefined))) recomputeTopic(store, projectId, topic);
    for (const a of data.answers) {
      store.acceptance.setAnswer(projectId, {
        packId: String(a.packId),
        questionKey: String(a.questionKey),
        value: String(a.value),
        origin: a.origin === "inferred" ? "inferred" : "stated",
        answeredBy: String(a.answeredBy),
        questionHash: String(a.questionHash),
        ...(typeof a.note === "string" ? { note: a.note } : {}),
      });
    }
    for (const e of data.evidence) {
      const env = e.environment as { kind: string; description?: string };
      store.acceptance.addEvidence(projectId, {
        criterionId: String(e.criterionId),
        result: e.result as "passed",
        revision: String(e.revision),
        environment: env,
        artifactRef: typeof e.artifactRef === "string" ? e.artifactRef : undefined,
        recordedBy: String(e.recordedBy),
        collectedAt: String(e.collectedAt),
      });
    }
    for (const d of data.dispositions) {
      store.acceptance.setDisposition(projectId, {
        criterionId: String(d.criterionId),
        disposition: d.disposition as "waived",
        actor: String(d.actor),
        reason: typeof d.reason === "string" ? d.reason : undefined,
      });
    }
    if (data.revision !== undefined) store.state.set(projectId, "build.revision", data.revision);
    store.audit(projectId, "memory.import", actor, [newId("job")]);
    return { sources: data.sources.length, facts: data.facts.length, decisions: data.decisions.length };
  });
}
