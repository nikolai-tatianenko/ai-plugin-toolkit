import { contentHash, type LoomConfig } from "@ai-plugin-toolkit/core";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { assembleContext, search, type AssembledContext, type ContextOptions, type SearchHit, type SearchOptions } from "./index.js";

/**
 * Retrieval caches (CL-015). An entry is valid only for the exact memory revision and
 * permissions revision it was computed under; when either changes, the project's
 * retrieval caches are cleared before anything is reused (A24). Keys and rows are
 * project-scoped, so there are no cross-project hits (A05).
 */
export const RETRIEVAL_CACHE_VERSION = "retrieval-cache-v1";
const NAMESPACES = ["retrieval", "context", "semantic"] as const;
const VALIDITY_KEY = "cache.validity";

/** Everything about the configuration that can change who may see what. */
export function permissionsRevision(config: LoomConfig): string {
  return contentHash(JSON.stringify([config.project.id, config.project.sensitivity, config.providers, config.routing])).slice(0, 16);
}

/** Clear caches if memory or permissions changed since they were filled. Returns true when cleared. */
export function ensureCacheValidity(store: LoomStore, projectId: string, permissions: string): boolean {
  const current = `${store.memory.revision(projectId)}:${permissions}:${RETRIEVAL_CACHE_VERSION}`;
  if (store.state.get(projectId, VALIDITY_KEY) === current) return false;
  store.transaction(() => {
    for (const ns of NAMESPACES) store.cache.clear(projectId, ns);
    store.state.set(projectId, VALIDITY_KEY, current);
  });
  return true;
}

function key(projectId: string, permissions: string, kind: string, query: string, options: unknown, memoryRevision: string): string {
  return contentHash(JSON.stringify([RETRIEVAL_CACHE_VERSION, kind, projectId, permissions, memoryRevision, query.normalize("NFKC").trim().toLowerCase(), options]));
}

export interface CacheOutcome<T> {
  value: T;
  cache: "hit" | "miss";
}

export function cachedSearch(store: LoomStore, projectId: string, query: string, options: SearchOptions, permissions: string): CacheOutcome<SearchHit[]> {
  ensureCacheValidity(store, projectId, permissions);
  const k = key(projectId, permissions, "search", query, options, store.memory.revision(projectId));
  const hit = store.cache.get(projectId, "retrieval", k);
  if (hit !== undefined) return { value: JSON.parse(hit) as SearchHit[], cache: "hit" };
  const value = search(store, projectId, query, options);
  store.cache.put(projectId, "retrieval", k, JSON.stringify(value));
  return { value, cache: "miss" };
}

export async function cachedContext(
  store: LoomStore,
  projectId: string,
  query: string,
  options: ContextOptions,
  permissions: string,
): Promise<CacheOutcome<AssembledContext>> {
  ensureCacheValidity(store, projectId, permissions);
  const { transformStatement, ...rest } = options;
  const k = key(projectId, permissions, "context", query, { ...rest, transform: transformStatement?.name ?? null }, store.memory.revision(projectId));
  const hit = store.cache.get(projectId, "context", k);
  if (hit !== undefined) return { value: JSON.parse(hit) as AssembledContext, cache: "hit" };
  const value = await assembleContext(store, projectId, query, options);
  store.cache.put(projectId, "context", k, JSON.stringify(value));
  return { value, cache: "miss" };
}

// ---- Embeddings and hybrid search -------------------------------------------------

export type EmbedFn = (texts: readonly string[]) => Promise<{ vectors: number[][]; model: string }>;

function recordText(store: LoomStore, projectId: string): Array<{ id: string; text: string; active: boolean }> {
  return [
    ...store.memory.listFacts(projectId, { includeInactive: true }).map((f) => ({ id: f.id, text: f.statement, active: f.status === "candidate" || f.status === "confirmed" })),
    ...store.memory.listDecisions(projectId, { includeInactive: true }).map((d) => ({
      id: d.id,
      text: [d.topic, d.choice, d.statement].filter(Boolean).join(" — "),
      active: d.status === "confirmed" || d.status === "proposed",
    })),
  ];
}

/**
 * Embed records whose text changed or that have no vector for this model. Vectors are
 * keyed by record, model and content hash, so unchanged records are never re-embedded.
 */
export async function ensureEmbeddings(store: LoomStore, projectId: string, embed: EmbedFn, model: string, batchSize = 64): Promise<{ embedded: number; reused: number }> {
  const todo = recordText(store, projectId).filter((r) => store.memory.embedding(projectId, r.id, model)?.hash !== contentHash(r.text));
  const total = recordText(store, projectId).length;
  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    const { vectors } = await embed(batch.map((r) => r.text));
    store.transaction(() => batch.forEach((r, j) => store.memory.putEmbedding(projectId, r.id, model, contentHash(r.text), vectors[j]!)));
  }
  return { embedded: todo.length, reused: total - todo.length };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Lexical + embedding search fused by reciprocal rank. Embeddings only re-rank and add
 * records from the same project; the project filter is applied before either list.
 */
export async function hybridSearch(
  store: LoomStore,
  projectId: string,
  query: string,
  embedder: { embed: EmbedFn; model: string },
  options: SearchOptions = {},
): Promise<Array<SearchHit & { semantic: number | null }>> {
  const limit = options.limit ?? 20;
  let lexical: SearchHit[] = [];
  try {
    lexical = search(store, projectId, query, { ...options, limit: limit * 2, kinds: options.kinds ?? ["fact", "decision"] });
  } catch {
    lexical = [];
  }
  await ensureEmbeddings(store, projectId, embedder.embed, embedder.model);
  const [queryVector] = (await embedder.embed([query])).vectors;
  const active = new Map(recordText(store, projectId).map((r) => [r.id, r.active]));
  const semantic = store.memory
    .embeddings(projectId, embedder.model)
    .filter((e) => options.includeHistory || active.get(e.recordId) === true)
    .map((e) => ({ id: e.recordId, score: cosine(queryVector!, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit * 2);

  const fused = new Map<string, number>();
  lexical.forEach((h, i) => fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (60 + i)));
  semantic.forEach((h, i) => fused.set(h.id, (fused.get(h.id) ?? 0) + 1 / (60 + i)));
  const semanticScore = new Map(semantic.map((s) => [s.id, s.score]));
  const lexicalById = new Map(lexical.map((h) => [h.id, h]));
  const out: Array<SearchHit & { semantic: number | null }> = [];
  for (const [id, score] of [...fused.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit)) {
    const base = lexicalById.get(id) ?? hydrate(store, projectId, id);
    if (base !== undefined) out.push({ ...base, score, semantic: semanticScore.get(id) ?? null });
  }
  return out;
}

function hydrate(store: LoomStore, projectId: string, id: string): SearchHit | undefined {
  if (id.startsWith("fct_")) {
    const f = store.memory.getFact(projectId, id);
    return f && { id, kind: "fact", status: f.status, text: f.statement, score: 0, spans: f.spans };
  }
  const d = store.memory.getDecision(projectId, id);
  return d && { id, kind: "decision", status: d.status, text: `${d.choice} — ${d.statement}`, score: 0, spans: d.spans, ...(d.topic ? { topic: d.topic } : {}) };
}
