import { LoomError, isIdOf } from "@ai-plugin-toolkit/core";
import { describeRecord, extractAll, extractSource, type ExtractResult } from "@ai-plugin-toolkit/memory";
import { cachedContext, cachedSearch, ensureEmbeddings, hybridSearch } from "@ai-plugin-toolkit/retrieval";
import { withProject } from "../context.js";
import { UsageError, type CommandResult } from "../io.js";

interface Base {
  rootDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

export async function extractCommand(options: Base & { source?: string | undefined; force: boolean }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const common = { store: ctx.store, router: ctx.router(), projectId: ctx.projectId, actor: ctx.actor, force: options.force };
    const results: ExtractResult[] =
      options.source === undefined ? await extractAll(common) : [await extractSource({ ...common, sourceId: options.source })];
    const extracted = results.filter((r) => r.status === "extracted");
    const created = extracted.reduce((n, r) => n + r.created.length, 0);
    const rejected = extracted.reduce((n, r) => n + r.rejected.length, 0);
    const costs = extracted.map((r) => r.usage?.costUsd);
    const cost = costs.some((c) => c === null) ? null : costs.reduce<number>((n, c) => n + (c ?? 0), 0);
    return {
      data: { projectId: ctx.projectId, results, totals: { extracted: extracted.length, skipped: results.length - extracted.length, created, rejected, costUsd: cost } },
      lines: [
        results.length === 0
          ? `No sources in "${ctx.projectId}". Add some with \`loom ingest <file>\`.`
          : `Extraction: ${extracted.length} source(s) processed, ${results.length - extracted.length} already extracted (use --force to re-run)`,
        ...extracted.map(
          (r) =>
            `  ${r.sourceId}  via ${r.provider} (${r.model}): ${r.created.length} new, ${r.existing.length} existing, ${r.superseded.length} superseded, ${r.rejected.length} rejected`,
        ),
        ...extracted.flatMap((r) => r.rejected.map((x) => `    ✗ rejected: ${x.reason}`)),
        ...(extracted.length > 0 ? [`  cost: ${cost === null ? "unknown (pricing not available)" : `$${cost.toFixed(4)}`}`] : []),
      ],
    };
  });
}

export async function memoryListCommand(options: Base & { kind?: string | undefined; all: boolean }): Promise<CommandResult> {
  const kind = options.kind ?? "all";
  if (!["all", "facts", "decisions", "rejected"].includes(kind)) throw new UsageError("--kind must be facts, decisions, rejected or all.");
  return withProject(options.rootDir, options, async (ctx) => {
    const facts = kind === "all" || kind === "facts" ? ctx.store.memory.listFacts(ctx.projectId, { includeInactive: options.all }) : [];
    const decisions = kind === "all" || kind === "decisions" ? ctx.store.memory.listDecisions(ctx.projectId, { includeInactive: options.all }) : [];
    const rejected = kind === "rejected" || (kind === "all" && options.all) ? ctx.store.memory.listRejected(ctx.projectId) : [];
    const span = (spans: ReadonlyArray<{ sourceId: string; start: number; end: number }>) => spans.map((s) => `${s.sourceId}:${s.start}-${s.end}`).join(", ");
    return {
      data: { projectId: ctx.projectId, facts, decisions, rejected },
      lines: [
        ...(facts.length > 0 ? [`Facts (${facts.length}):`, ...facts.map((f) => `  ${f.id}  [${f.kind}, ${f.status}] ${f.statement}  ← ${span(f.spans)}`)] : []),
        ...(decisions.length > 0
          ? [`Decisions (${decisions.length}):`, ...decisions.map((d) => `  ${d.id}  [${d.status}${d.topic ? `, ${d.topic}` : ""}] ${d.choice} — ${d.statement}  ← ${span(d.spans)}`)]
          : []),
        ...(rejected.length > 0 ? [`Rejected candidates (${rejected.length}):`, ...rejected.map((r) => `  ✗ ${r.reason}`)] : []),
        ...(facts.length + decisions.length + rejected.length === 0 ? [`No records. Run \`loom extract\` after \`loom ingest\`.`] : []),
      ],
    };
  });
}

export async function memoryShowCommand(options: Base & { id: string }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const described = await describeRecord(ctx.store, ctx.projectId, options.id);
    const r = described.record;
    const head =
      described.kind === "fact"
        ? `${r.id}  fact (${(r as { kind: string }).kind}, ${r.status}): ${(r as { statement: string }).statement}`
        : `${r.id}  decision (${r.status}): ${(r as { choice: string }).choice} — ${(r as { statement: string }).statement}`;
    return {
      data: described as unknown as Record<string, unknown>,
      lines: [
        head,
        ...("confirmedBy" in r && r.confirmedBy ? [`  confirmed by ${r.confirmedBy}`] : []),
        "  evidence:",
        ...described.evidence.map((e) => `    ${e.sourceId}:${e.start}-${e.end} (${e.speaker}${e.sourceTitle ? `, ${e.sourceTitle}` : ""}): “${e.text}”`),
      ],
    };
  });
}

export async function memoryReviewCommand(options: Base & { id: string; status: "confirmed" | "rejected" }): Promise<CommandResult> {
  if (!isIdOf("fact", options.id)) throw new UsageError("Only facts can be confirmed or rejected here; decisions are confirmed by their evidence.");
  return withProject(options.rootDir, options, async (ctx) => {
    ctx.store.transaction(() => {
      ctx.store.memory.setFactStatus(ctx.projectId, options.id, options.status);
      ctx.store.audit(ctx.projectId, `memory.${options.status === "confirmed" ? "confirm" : "reject"}`, ctx.actor, [options.id]);
    });
    return { data: { id: options.id, status: options.status }, lines: [`${options.id} → ${options.status} (by ${ctx.actor})`] };
  });
}

export async function searchCommand(options: Base & { query: string; all: boolean; limit: number; semantic: boolean }): Promise<CommandResult> {
  if (options.query.trim() === "") throw new UsageError("Usage: loom search <words...>");
  return withProject(options.rootDir, options, async (ctx) => {
    let hits;
    let cache: string = "off";
    if (options.semantic) {
      const embedder = ctx.embedder();
      if (embedder === undefined) throw new LoomError("CONFIG_INVALID", "--semantic needs routing.embedding in loom.config.json (e.g. the local hashing or ollama adapter).");
      hits = await hybridSearch(ctx.store, ctx.projectId, options.query, embedder, { limit: options.limit, includeHistory: options.all });
    } else {
      const outcome = cachedSearch(ctx.store, ctx.projectId, options.query, { limit: options.limit, includeHistory: options.all }, ctx.permissions);
      hits = outcome.value;
      cache = outcome.cache;
    }
    return {
      data: { projectId: ctx.projectId, query: options.query, hits, cache },
      lines: hits.length === 0 ? ["No matches."] : hits.map((h) => `  ${h.id}  [${h.kind}${h.kind === "source" ? "" : `, ${h.status}`}] ${h.text}`),
    };
  });
}

export async function contextCommand(options: Base & { query: string; maxChars: number }): Promise<CommandResult> {
  if (options.query.trim() === "") throw new UsageError("Usage: loom context <words...> [--max-chars <n>]");
  return withProject(options.rootDir, options, async (ctx) => {
    const { value: context, cache } = await cachedContext(ctx.store, ctx.projectId, options.query, { maxChars: options.maxChars }, ctx.permissions);
    return {
      data: { ...(context as unknown as Record<string, unknown>), cache },
      lines: [context.text.trimEnd(), "", `(${context.usedChars}/${context.maxChars} chars; ${context.included.length} included, ${context.omitted.length} omitted; cache ${cache})`],
    };
  });
}

export async function embedCommand(options: Base): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const embedder = ctx.embedder();
    if (embedder === undefined) throw new LoomError("CONFIG_INVALID", "No routing.embedding policy configured.");
    const result = await ensureEmbeddings(ctx.store, ctx.projectId, embedder.embed, embedder.model);
    return { data: { model: embedder.model, ...result }, lines: [`Embeddings (${embedder.model}): ${result.embedded} computed, ${result.reused} reused.`] };
  });
}

export async function cacheCommand(options: Base & { clear: boolean }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const removed = options.clear ? ctx.store.cache.clear(ctx.projectId) + ctx.store.cache.clearTransforms(ctx.projectId) : 0;
    const stats = ctx.store.cache.stats(ctx.projectId);
    return {
      data: { stats, removed },
      lines: [
        ...(options.clear ? [`Cleared ${removed} cache entr(ies).`] : []),
        ...(stats.length === 0 ? ["Caches are empty."] : stats.map((s) => `  ${s.namespace.padEnd(10)} ${s.entries} entries, ${s.bytes} bytes, ${s.hits} hits`)),
      ],
    };
  });
}

export function requireNumber(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be an integer between ${min} and ${max}.`);
  return n;
}

export function notFound(what: string): never {
  throw new LoomError("NOT_FOUND", what);
}
