import { z } from "zod";
import { EvidenceEnvironmentKindSchema, LoomError, contentHash, parseWith } from "@ai-plugin-toolkit/core";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { REVISION_KEY, criterionId, resolveCriterion } from "./evaluate.js";
import type { PackCriterion, TopicPack } from "./pack.js";

/**
 * Evidence importers (CL-018). Each format is versioned. A criterion gets a `passed`
 * result only when at least one imported result matched it and every matched result
 * passed: skipped, missing or mixed results never produce a pass (no false passes).
 */
export const IMPORT_FORMATS = ["junit-xml/1", "loom-build/1", "loom-review/1"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export interface ImportedResult {
  /** Test or check identifier, used for matching. */
  name: string;
  /** Explicit criterion key, when the input names one. */
  criterion?: string;
  outcome: "passed" | "failed" | "skipped";
  detail?: string;
}

export interface ParsedImport {
  format: ImportFormat;
  results: ImportedResult[];
  revision?: string;
  environment?: z.infer<typeof EvidenceEnvironmentKindSchema>;
  environmentDescription?: string;
  actor?: string;
}

// ---- JUnit XML ------------------------------------------------------------------------

const decode = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_m, name: string, dec?: string, hex?: string) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[name.toLowerCase()]!,
  );
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m === null ? undefined : decode(m[2] ?? m[3] ?? "");
};

/**
 * Minimal JUnit XML reader: <testcase classname name> with optional <failure>, <error> or
 * <skipped>. No DTDs or external entities are processed (XXE-safe by construction).
 */
export function parseJUnit(xml: string): ParsedImport {
  if (!/<testsuites?[\s>]/.test(xml)) throw new LoomError("VALIDATION_FAILED", "Not a JUnit XML report (no <testsuite> element).");
  const results: ImportedResult[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const tag = m[1] ?? "";
    const body = m[3] ?? "";
    const name = [attr(tag, "classname"), attr(tag, "name")].filter(Boolean).join(".");
    if (name === "") continue;
    const failed = /<(failure|error)\b/.test(body);
    const skipped = /<skipped\b/.test(body);
    const message = /<(?:failure|error)\b[^>]*\bmessage\s*=\s*"([^"]*)"/.exec(body)?.[1];
    results.push({ name, outcome: failed ? "failed" : skipped ? "skipped" : "passed", ...(message ? { detail: decode(message).slice(0, 200) } : {}) });
  }
  if (results.length === 0) throw new LoomError("VALIDATION_FAILED", "JUnit report contains no test cases.");
  return { format: "junit-xml/1", results };
}

// ---- Build/CI JSON ------------------------------------------------------------------------

export const BuildReportSchema = z.strictObject({
  format: z.literal("loom-build/1"),
  revision: z.string().min(1),
  environment: z.strictObject({ kind: EvidenceEnvironmentKindSchema, description: z.string().min(1).optional() }).default({ kind: "ci" }),
  checks: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        criterion: z.string().min(1).optional(),
        result: z.enum(["passed", "failed", "skipped"]),
        url: z.string().optional(),
      }),
    )
    .min(1),
});

export function parseBuildReport(text: string): ParsedImport {
  const data = parseWith(BuildReportSchema, JSON.parse(text), "loom-build/1 report");
  return {
    format: "loom-build/1",
    revision: data.revision,
    environment: data.environment.kind,
    ...(data.environment.description === undefined ? {} : { environmentDescription: data.environment.description }),
    results: data.checks.map((c) => ({ name: c.name, outcome: c.result, ...(c.criterion ? { criterion: c.criterion } : {}), ...(c.url ? { detail: c.url } : {}) })),
  };
}

// ---- Human review markdown ------------------------------------------------------------------

/**
 * ```
 * ---
 * format: loom-review/1
 * reviewer: Pat
 * revision: build-41
 * ---
 * - passed privacy.disclosures: labels match the data inventory
 * - failed store.assets: screenshots missing
 * ```
 */
export function parseReview(text: string): ParsedImport {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (front === null) throw new LoomError("VALIDATION_FAILED", "Review file needs a front matter block (--- ... ---).");
  const meta = Object.fromEntries(
    front[1]!
      .split(/\r?\n/)
      .map((l) => /^([a-z-]+):\s*(.+)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!.trim()]),
  );
  if (meta.format !== "loom-review/1") throw new LoomError("VALIDATION_FAILED", 'Review front matter must say "format: loom-review/1".');
  if (!meta.reviewer) throw new LoomError("VALIDATION_FAILED", "Review front matter must name the reviewer.");
  if (!meta.revision) throw new LoomError("VALIDATION_FAILED", "Review front matter must name the revision reviewed.");
  const results: ImportedResult[] = [];
  for (const line of text.slice(front[0].length).split(/\r?\n/)) {
    const m = /^\s*[-*]\s+(passed|failed|skipped)\s+([a-z][a-z0-9.-]*)\s*(?::\s*(.*))?$/.exec(line);
    if (m !== null) results.push({ name: m[2]!, criterion: m[2]!, outcome: m[1] as ImportedResult["outcome"], ...(m[3] ? { detail: m[3] } : {}) });
  }
  if (results.length === 0) throw new LoomError("VALIDATION_FAILED", 'Review lists no results (lines like "- passed <criterion>: note").');
  return { format: "loom-review/1", results, revision: meta.revision, environment: "manual", actor: meta.reviewer, environmentDescription: `review by ${meta.reviewer}` };
}

export function parseImport(format: ImportFormat, text: string): ParsedImport {
  if (format === "junit-xml/1") return parseJUnit(text);
  if (format === "loom-build/1") return parseBuildReport(text);
  return parseReview(text);
}

// ---- Mapping and recording ---------------------------------------------------------------

function matchers(criterion: PackCriterion, format: ImportFormat): RegExp[] {
  const patterns = format === "junit-xml/1" ? (criterion.evidence?.junit ?? []) : (criterion.evidence?.checks ?? []);
  return patterns.map((p) => new RegExp(p, "i"));
}

export interface ImportPlanItem {
  criterion: string;
  result: "passed" | "failed" | "inconclusive";
  matched: string[];
  reason: string;
}

/** Decide one result per criterion from the matched inputs. Pure. */
export function planImport(pack: TopicPack, parsed: ParsedImport): { items: ImportPlanItem[]; unmatched: string[] } {
  const items: ImportPlanItem[] = [];
  const used = new Set<string>();
  for (const criterion of pack.criteria) {
    const res = matchers(criterion, parsed.format);
    const matched = parsed.results.filter((r) => r.criterion === criterion.id || (r.criterion === undefined && res.some((re) => re.test(r.name))));
    if (matched.length === 0) continue;
    matched.forEach((r) => used.add(r.name));
    const failed = matched.filter((r) => r.outcome === "failed");
    const skipped = matched.filter((r) => r.outcome === "skipped");
    const result = failed.length > 0 ? "failed" : skipped.length > 0 ? "inconclusive" : "passed";
    const reason =
      result === "failed"
        ? `${failed.length}/${matched.length} matched result(s) failed`
        : result === "inconclusive"
          ? `${skipped.length}/${matched.length} matched result(s) skipped; a skip is not a pass`
          : `all ${matched.length} matched result(s) passed`;
    items.push({ criterion: criterion.id, result, matched: matched.map((r) => r.name), reason });
  }
  for (const r of parsed.results) {
    if (r.criterion !== undefined && !pack.criteria.some((c) => c.id === r.criterion)) {
      throw new LoomError("VALIDATION_FAILED", `Imported result names unknown criterion "${r.criterion}" for ${pack.id}@${pack.version}.`);
    }
  }
  return { items, unmatched: parsed.results.filter((r) => !used.has(r.name)).map((r) => r.name) };
}

export interface ImportOptions {
  format: ImportFormat;
  text: string;
  /** File name or URL stored as the evidence reference. */
  ref: string;
  actor: string;
  revision?: string;
  environment?: z.infer<typeof EvidenceEnvironmentKindSchema>;
  dryRun?: boolean;
}

/** Parse, map and record. Re-importing the same file content is idempotent per criterion. */
export function importEvidence(store: LoomStore, projectId: string, pack: TopicPack, options: ImportOptions) {
  const parsed = parseImport(options.format, options.text);
  const revision = options.revision ?? parsed.revision ?? store.state.get(projectId, REVISION_KEY);
  if (revision === undefined) throw new LoomError("VALIDATION_FAILED", "Imported evidence needs a revision: pass --revision, include it in the file, or run `loom revision set`.");
  if (parsed.revision !== undefined && options.revision !== undefined && parsed.revision !== options.revision) {
    throw new LoomError("VALIDATION_FAILED", `The file says revision ${parsed.revision} but --revision is ${options.revision}.`);
  }
  const environment = options.environment ?? parsed.environment ?? "ci";
  if (environment === "mock") throw new LoomError("VALIDATION_FAILED", "Mock results are not acceptance evidence.");
  const plan = planImport(pack, parsed);
  const importRef = `${options.format}:${contentHash(options.text).slice(0, 16)}`;
  const recorded: Array<ImportPlanItem & { evidenceId?: string; skipped?: string }> = [];
  if (!options.dryRun) {
    store.transaction(() => {
      for (const item of plan.items) {
        const id = criterionId(projectId, pack.id, resolveCriterion(projectId, pack, item.criterion).id);
        if (store.acceptance.hasImported(projectId, id, importRef)) {
          recorded.push({ ...item, skipped: "already imported" });
          continue;
        }
        const evidence = store.acceptance.addEvidence(projectId, {
          criterionId: id,
          result: item.result,
          revision,
          environment: { kind: environment, description: [parsed.environmentDescription, item.reason].filter(Boolean).join("; ") },
          artifactRef: options.ref,
          recordedBy: parsed.actor ?? options.actor,
          importer: options.format,
          importRef,
        });
        recorded.push({ ...item, evidenceId: evidence.id });
      }
      store.audit(projectId, "acceptance.import", options.actor, recorded.flatMap((r) => (r.evidenceId ? [r.evidenceId] : [])));
    });
  }
  return { format: options.format, revision, environment, importRef, items: options.dryRun ? plan.items : recorded, unmatched: plan.unmatched };
}
