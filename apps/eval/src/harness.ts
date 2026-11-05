import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { EXTRACTION_PROMPT_VERSION, VERSION, parseConfig, parseIngestPayload, parseWith, type SourceSpan } from "@ai-plugin-toolkit/core";
import { extractSource, resolveQuote } from "@ai-plugin-toolkit/memory";
import { createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "@ai-plugin-toolkit/provider-anthropic";
import { Router, createFixtureProvider, FixtureFileSchema } from "@ai-plugin-toolkit/router";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";

/**
 * Extraction evaluation (CL-021, v0.1 part). Compares accepted records with
 * annotated expectations by span overlap. Reports what was measured and with what;
 * it never extrapolates to savings or quality claims.
 */

const AnnotationSchema = z.strictObject({
  type: z.enum(["fact", "goal", "requirement", "preference", "constraint", "event", "proposal", "decision"]),
  quote: z.string().min(1),
  topic: z.string().optional(),
});
export const DatasetSchema = z.strictObject({
  dataset: z.string(),
  version: z.string(),
  review: z.string(),
  cases: z.array(
    z.strictObject({
      id: z.string(),
      file: z.string(),
      type: z.enum(["conversation", "document", "tool-output"]),
      expected: z.array(AnnotationSchema),
      currentDecisions: z.record(z.string(), z.string()),
    }),
  ),
});

export interface CaseResult {
  id: string;
  accepted: number;
  rejected: number;
  matched: number;
  expected: number;
  /** Accepted records whose evidence overlaps no annotation: possible unsupported claims. */
  unsupported: Array<{ id: string; statement: string; quote: string }>;
  missed: Array<{ type: string; quote: string }>;
  typeMismatches: Array<{ expected: string; got: string; quote: string }>;
  decisions: Array<{ topic: string; expected: string; actual: string | null; ok: boolean }>;
  rejectedReasons: string[];
  error?: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
}

export interface EvalReport {
  harness: { version: string; promptVersion: string };
  dataset: { name: string; version: string; review: string; cases: number };
  provider: { name: string; model: string; note: string };
  totals: {
    precision: number | null;
    recall: number | null;
    unsupportedRate: number | null;
    citationResolvable: number;
    currentDecisionAccuracy: number | null;
    accepted: number;
    rejected: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number | null;
    latencyMs: number;
  };
  cases: CaseResult[];
  limitations: string[];
}

export interface EvalOptions {
  datasetDir: string;
  provider: "fixture" | "anthropic";
  apiKey?: string;
  model?: string;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

function recordType(kind: string, status?: string): string {
  if (kind === "decision") return status === "proposed" ? "proposal" : "decision";
  return kind;
}

export async function runEvaluation(options: EvalOptions): Promise<EvalReport> {
  const dataset = parseWith(DatasetSchema, JSON.parse(await readFile(path.join(options.datasetDir, "annotations.json"), "utf8")), "annotations");
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const makeProvider = async () =>
    options.provider === "fixture"
      ? createFixtureProvider(parseWith(FixtureFileSchema, JSON.parse(await readFile(path.join(options.datasetDir, "fixture.json"), "utf8")), "fixture"), "eval-fixture")
      : createAnthropicProvider({ apiKey: options.apiKey ?? "", model });
  const provider = await makeProvider();

  const cases: CaseResult[] = [];
  for (const c of dataset.cases) {
    const dir = await mkdtemp(path.join(tmpdir(), "loom-eval-"));
    const store = await LoomStore.open({ storageDir: dir });
    const started = Date.now();
    try {
      store.ensureProject("eval", "eval");
      const bytes = await readFile(path.join(options.datasetDir, c.file));
      const input = parseIngestPayload(c.file, bytes, { type: c.type });
      const [outcome] = await store.ingest("eval", [input], { actor: "eval" });
      const source = outcome!.source;
      const text = await store.readSourceText("eval", source.id);
      const router = new Router({
        config: parseConfig({
          $schemaVersion: 1,
          project: { id: "eval", name: "eval" },
          providers: { p: { adapter: "p", location: provider.manifest.location } },
          routing: { extraction: { providers: ["p"], timeoutMs: 180_000, maxAttempts: 2 } },
        }),
        env: {},
        rootDir: dir,
        factories: { p: () => provider },
      });
      const result = await extractSource({ store, router, projectId: "eval", sourceId: source.id, actor: "eval" });

      const annotations = c.expected.map((a) => ({ ...a, span: resolveQuote(source, text, a.quote) }));
      const missingAnnotation = annotations.find((a) => a.span === undefined);
      if (missingAnnotation) throw new Error(`annotation quote not in source: ${missingAnnotation.quote}`);
      const records: Array<{ id: string; type: string; statement: string; spans: SourceSpan[] }> = [
        ...store.memory.listFacts("eval", { includeInactive: true }).map((f) => ({ id: f.id, type: f.kind, statement: f.statement, spans: f.spans })),
        ...store.memory.listDecisions("eval", { includeInactive: true }).map((d) => ({ id: d.id, type: recordType("decision", d.status), statement: d.statement, spans: d.spans })),
      ];
      const matchedAnnotations = new Set<number>();
      const unsupported: CaseResult["unsupported"] = [];
      const typeMismatches: CaseResult["typeMismatches"] = [];
      let matched = 0;
      for (const r of records) {
        const hit = annotations.findIndex((a, i) => !matchedAnnotations.has(i) && r.spans.some((s) => overlaps(s, a.span!)));
        if (hit === -1) {
          unsupported.push({ id: r.id, statement: r.statement, quote: r.spans.map((s) => text.slice(s.start, s.end)).join(" … ") });
          continue;
        }
        matchedAnnotations.add(hit);
        if (annotations[hit]!.type === r.type) matched++;
        else typeMismatches.push({ expected: annotations[hit]!.type, got: r.type, quote: annotations[hit]!.quote });
      }
      const decisions = Object.entries(c.currentDecisions).map(([topic, expected]) => {
        const current = store.memory.confirmedOnTopic("eval", topic)[0];
        return { topic, expected, actual: current?.choice ?? null, ok: current !== undefined && current.choice.toLowerCase().includes(expected.toLowerCase()) };
      });
      cases.push({
        id: c.id,
        accepted: records.length,
        rejected: result.rejected.length,
        matched,
        expected: annotations.length,
        unsupported,
        missed: annotations.filter((_, i) => !matchedAnnotations.has(i)).map((a) => ({ type: a.type, quote: a.quote })),
        typeMismatches,
        decisions,
        rejectedReasons: result.rejected.map((r) => r.reason),
        latencyMs: Date.now() - started,
        usage: result.usage ?? null,
      });
    } catch (error) {
      cases.push({
        id: c.id, accepted: 0, rejected: 0, matched: 0, expected: c.expected.length, unsupported: [], missed: [], typeMismatches: [], decisions: [],
        rejectedReasons: [], error: (error as Error).message, latencyMs: Date.now() - started, usage: null,
      });
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  const sum = (f: (c: CaseResult) => number) => cases.reduce((n, c) => n + f(c), 0);
  const costs = cases.map((c) => c.usage?.costUsd ?? null);
  const decisions = cases.flatMap((c) => c.decisions);
  return {
    harness: { version: VERSION, promptVersion: EXTRACTION_PROMPT_VERSION },
    dataset: { name: dataset.dataset, version: dataset.version, review: dataset.review, cases: dataset.cases.length },
    provider:
      options.provider === "fixture"
        ? { name: "fixture", model: "eval-fixture", note: "Hand-written responses: measures validation and scoring, not a model." }
        : { name: "anthropic", model, note: "Live model run over synthetic data." },
    totals: {
      precision: ratio(sum((c) => c.matched), sum((c) => c.accepted)),
      recall: ratio(sum((c) => c.matched), sum((c) => c.expected)),
      unsupportedRate: ratio(sum((c) => c.unsupported.length), sum((c) => c.accepted)),
      // Every accepted span was resolved against the source at acceptance time; this records that no case errored.
      citationResolvable: cases.every((c) => c.error === undefined) ? 1 : 0,
      currentDecisionAccuracy: ratio(decisions.filter((d) => d.ok).length, decisions.length),
      accepted: sum((c) => c.accepted),
      rejected: sum((c) => c.rejected),
      inputTokens: sum((c) => c.usage?.inputTokens ?? 0),
      outputTokens: sum((c) => c.usage?.outputTokens ?? 0),
      costUsd: costs.some((x) => x === null) ? null : costs.reduce<number>((n, x) => n + (x ?? 0), 0),
      latencyMs: sum((c) => c.latencyMs),
    },
    cases,
    limitations: [
      `${dataset.cases.length} synthetic cases; far too small for statistical claims.`,
      "Annotations are provisional until a person reviews them (see dataset.review).",
      "No full-history or retrieval baseline has been run yet; no comparative or savings claim is made.",
      "Matching is by span overlap and record type; paraphrase quality of statements is not scored.",
    ],
  };
}

export function renderReport(report: EvalReport): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const t = report.totals;
  return [
    `# Extraction evaluation — ${report.dataset.name}@${report.dataset.version}`,
    "",
    `Provider: ${report.provider.name} (${report.provider.model}) — ${report.provider.note}`,
    `Harness ${report.harness.version}, prompt ${report.harness.promptVersion}. ${report.dataset.review}`,
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Precision (type-correct matches / accepted) | ${pct(t.precision)} |`,
    `| Recall (type-correct matches / annotated) | ${pct(t.recall)} |`,
    `| Unsupported-claim rate | ${pct(t.unsupportedRate)} |`,
    `| Current-decision accuracy | ${pct(t.currentDecisionAccuracy)} |`,
    `| Accepted / rejected candidates | ${t.accepted} / ${t.rejected} |`,
    `| Tokens in / out | ${t.inputTokens} / ${t.outputTokens} |`,
    `| Cost | ${t.costUsd === null ? "unknown" : `$${t.costUsd.toFixed(4)}`} |`,
    `| Latency (total) | ${t.latencyMs} ms |`,
    "",
    ...report.cases.flatMap((c) => [
      `## ${c.id}`,
      "",
      c.error ? `- ERROR: ${c.error}` : `- ${c.matched}/${c.expected} matched; ${c.accepted} accepted, ${c.rejected} rejected`,
      ...c.unsupported.map((u) => `- unsupported: “${u.statement}” citing “${u.quote}”`),
      ...c.missed.map((m) => `- missed ${m.type}: “${m.quote}”`),
      ...c.typeMismatches.map((m) => `- type mismatch: expected ${m.expected}, got ${m.got} for “${m.quote}”`),
      ...c.rejectedReasons.map((r) => `- rejected: ${r}`),
      ...c.decisions.map((d) => `- current decision on ${d.topic}: ${d.actual ?? "none"} (${d.ok ? "ok" : `expected ${d.expected}`})`),
      "",
    ]),
    "## Limitations",
    "",
    ...report.limitations.map((l) => `- ${l}`),
    "",
  ].join("\n");
}
