import type { Fact, SourceSpan } from "@ai-plugin-toolkit/core";
import type { CriterionState, Evaluation } from "@ai-plugin-toolkit/acceptance";
import type { ResolvedSpan } from "@ai-plugin-toolkit/memory";
import type { LocalTask, StoredDecision } from "@ai-plugin-toolkit/storage-sqlite";

/**
 * Pure renderers: same input, same Markdown. No timestamps or random values appear in
 * generated text, so regeneration with unchanged inputs is byte-identical (CL-006).
 */

export interface ProjectSnapshot {
  project: { id: string; name: string };
  facts: Fact[];
  decisions: StoredDecision[];
  evaluations: Evaluation[];
  tasks: LocalTask[];
  extraction: { sources: number; runsOk: number; runsFailed: number; rejected: number };
  sync: { adapter: string; lastStatus: string; mapped: number } | undefined;
  /** Exact evidence text for decision records, keyed by decision ID. */
  decisionEvidence: Record<string, ResolvedSpan[]>;
}

export interface Rendered {
  body: string;
  sourceIds: string[];
  recordIds: string[];
}

const cite = (spans: readonly SourceSpan[]) => spans.map((s) => `\`${s.sourceId}:${s.start}-${s.end}\``).join(", ");
const sourcesOf = (records: ReadonlyArray<{ spans: readonly SourceSpan[] }>) => [...new Set(records.flatMap((r) => r.spans.map((s) => s.sourceId)))].sort();
const statusTag = (status: string) => (status === "candidate" ? " _(unreviewed)_" : "");
const md = (text: string) => text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

function factLines(facts: readonly Fact[]): string[] {
  return facts.map((f) => `- ${md(f.statement)}${statusTag(f.status)} — \`${f.id}\` · ${cite(f.spans)}`);
}

function section(title: string, lines: readonly string[], empty: string): string[] {
  return [`## ${title}`, "", ...(lines.length > 0 ? lines : [`_${empty}_`]), ""];
}

export function renderFacts(s: ProjectSnapshot): Rendered {
  const kinds = ["goal", "requirement", "constraint", "preference", "fact", "event"] as const;
  const titles: Record<string, string> = {
    goal: "Goals",
    requirement: "Requirements",
    constraint: "Constraints",
    preference: "Preferences",
    fact: "Other facts",
    event: "Events",
  };
  const lines = [
    `# Facts — ${s.project.name}`,
    "",
    "Extracted from stored evidence. Each entry cites `source:start-end`; open one with `loom memory show <id>`. _(unreviewed)_ marks extracted facts nobody has confirmed yet.",
    "",
  ];
  for (const kind of kinds) {
    const facts = s.facts.filter((f) => f.kind === kind);
    if (facts.length > 0) lines.push(...section(titles[kind]!, factLines(facts), ""));
  }
  if (s.facts.length === 0) lines.push("_No facts yet. Run `loom ingest` and `loom extract`._", "");
  return { body: lines.join("\n"), sourceIds: sourcesOf(s.facts), recordIds: s.facts.map((f) => f.id) };
}

export function renderVision(s: ProjectSnapshot): Rendered {
  const of = (kind: string) => s.facts.filter((f) => f.kind === kind);
  const confirmed = s.decisions.filter((d) => d.status === "confirmed");
  const proposed = s.decisions.filter((d) => d.status === "proposed");
  // A proposal stays a proposal (A02), but one followed by a confirmed decision on its topic is no longer open.
  const decidedLater = (p: StoredDecision) => confirmed.some((c) => c.topic !== undefined && c.topic === p.topic && c.createdAt > p.createdAt);
  const open = proposed.filter((p) => !decidedLater(p));
  const passedOver = proposed.filter(decidedLater);
  const lines = [
    `# Vision — ${s.project.name}`,
    "",
    "Assembled only from cited project memory; nothing here is invented by the generator.",
    "",
    ...section("What we are building", factLines(of("goal")), "No goals recorded yet."),
    ...section("Requirements", factLines(of("requirement")), "No requirements recorded yet."),
    ...section("Constraints", factLines(of("constraint")), "No constraints recorded yet."),
    ...section("Preferences", factLines(of("preference")), "No preferences recorded."),
    ...section(
      "Decisions in force",
      confirmed.map((d) => `- **${md(d.topic ?? "general")}:** ${md(d.choice)} — confirmed by ${md(d.confirmedBy ?? "?")} · [record](decisions/${d.id}.md) · ${cite(d.spans)}`),
      "No confirmed decisions.",
    ),
    ...section(
      "Open proposals (not decisions)",
      open.map((d) => `- **${md(d.topic ?? "general")}:** ${md(d.choice)} — proposed · \`${d.id}\` · ${cite(d.spans)}`),
      "None.",
    ),
    ...(passedOver.length > 0
      ? section(
          "Proposals not chosen",
          passedOver.map((d) => `- **${md(d.topic ?? "general")}:** ${md(d.choice)} — a later confirmed decision covers this topic · \`${d.id}\` · ${cite(d.spans)}`),
          "",
        )
      : []),
  ];
  const records = [...s.facts.filter((f) => f.kind !== "event" && f.kind !== "fact"), ...confirmed, ...proposed];
  return { body: lines.join("\n"), sourceIds: sourcesOf(records), recordIds: records.map((r) => r.id) };
}

function criteriaOf(s: ProjectSnapshot): CriterionState[] {
  return s.evaluations.flatMap((e) => e.criteria);
}

export function renderPlan(s: ProjectSnapshot): Rendered {
  const criteria = new Map(criteriaOf(s).map((c) => [c.id, c]));
  const taskById = new Map(s.tasks.map((t) => [t.id, t]));
  const lines = [`# Plan — ${s.project.name}`, ""];
  for (const evaluation of s.evaluations) {
    lines.push(`## Milestone: ${evaluation.pack.title} (${evaluation.pack.id}@${evaluation.pack.version})`, "");
    lines.push(`Readiness: **${evaluation.readiness.status}** at revision \`${evaluation.revision ?? "unset"}\`.`, "");
  }
  const workLines = s.tasks.map((t) => {
    const c = t.criterionIds.map((id) => criteria.get(id)).filter((x): x is CriterionState => x !== undefined);
    const deps = t.dependsOn.map((d) => taskById.get(d)?.title ?? d);
    return [
      `### ${md(t.title)}`,
      "",
      `- Task: \`${t.id}\` (revision ${t.revision})${deps.length > 0 ? ` · depends on: ${deps.map(md).join("; ")}` : ""}`,
      ...c.map((x) => `- Criterion \`${x.key}\` (${x.severity}): verification **${x.verification}** · method: ${md(x.verificationMethod)} · accepts: ${x.acceptedEnvironments.join(", ")}`),
      "",
    ].join("\n");
  });
  lines.push(...section("Work", workLines, "No tasks yet. Run `loom tasks preview` to derive them from acceptance criteria."));
  const open = s.evaluations.flatMap((e) => e.questions.filter((q) => q.state === "open" || q.state === "stale"));
  lines.push(
    ...section(
      "Unresolved questions",
      open.map((q) => `- \`${q.question.id}\` (${q.question.impact}): ${md(q.question.text)}${q.blocks.length > 0 ? ` — decides ${q.blocks.join(", ")}` : ""}`),
      "None.",
    ),
  );
  const excluded = criteriaOf(s).filter((c) => c.applicability === "not-applicable");
  lines.push(...section("Exclusions", excluded.map((c) => `- \`${c.key}\`: ${md(c.applicabilityRationale ?? "")}`), "None."));
  return { body: lines.join("\n"), sourceIds: [], recordIds: [...s.tasks.map((t) => t.id), ...excluded.map((c) => c.id)] };
}

export function renderStatus(s: ProjectSnapshot): Rendered {
  const criteria = criteriaOf(s);
  const count = (pred: (c: CriterionState) => boolean) => criteria.filter(pred).length;
  const lines = [
    `# Status — ${s.project.name}`,
    "",
    "## Memory",
    "",
    `- Sources: ${s.extraction.sources}; extraction runs: ${s.extraction.runsOk} ok, ${s.extraction.runsFailed} failed; rejected candidates: ${s.extraction.rejected}`,
    `- Facts: ${s.facts.length} (${s.facts.filter((f) => f.status === "confirmed").length} confirmed by a person)`,
    `- Decisions: ${s.decisions.filter((d) => d.status === "confirmed").length} confirmed, ${s.decisions.filter((d) => d.status === "proposed").length} proposed`,
    "",
    "## Acceptance",
    "",
  ];
  if (s.evaluations.length === 0) lines.push("_No topic pack active._", "");
  for (const e of s.evaluations) {
    lines.push(
      `- ${e.pack.id}@${e.pack.version} at revision \`${e.revision ?? "unset"}\`: **${e.readiness.status}**`,
      `  - applicable ${count((c) => c.packId === e.pack.id && c.applicability === "applicable")}, not applicable ${count((c) => c.packId === e.pack.id && c.applicability === "not-applicable")}, unresolved ${count((c) => c.packId === e.pack.id && c.applicability === "unresolved")}`,
      `  - passed ${count((c) => c.packId === e.pack.id && c.verification === "passed")}, failed ${count((c) => c.packId === e.pack.id && c.verification === "failed")}, stale ${count((c) => c.packId === e.pack.id && c.verification === "stale")}, waived ${e.readiness.waived.length}`,
      `  - blocking: ${e.readiness.blocking.length === 0 ? "none" : e.readiness.blocking.map((b) => `\`${b.criterion}\``).join(", ")}`,
    );
  }
  lines.push("", "## Tasks", "");
  lines.push(`- Local tasks: ${s.tasks.length} (${s.tasks.filter((t) => t.status === "closed").length} closed upstream)`);
  lines.push(s.sync === undefined ? "- Not synchronized." : `- Synchronized with ${s.sync.adapter}: ${s.sync.mapped} mapped; last run ${s.sync.lastStatus}`);
  lines.push("", "A closed task never counts as verification; see ACCEPTANCE.md for evidence.", "");
  return { body: lines.join("\n"), sourceIds: [], recordIds: [] };
}

export function renderAcceptance(s: ProjectSnapshot): Rendered {
  const lines = [`# Acceptance — ${s.project.name}`, ""];
  if (s.evaluations.length === 0) lines.push("_No topic pack active. Run `loom assess --pack mobile-release`._", "");
  for (const e of s.evaluations) {
    lines.push(
      `## ${e.pack.title} (${e.pack.id}@${e.pack.version})`,
      "",
      `> ${md(e.pack.advisory)}`,
      "",
      `Revision \`${e.revision ?? "unset"}\` · readiness **${e.readiness.status}**`,
      "",
      "| Criterion | Severity | Applicability | Verification | Disposition | Evidence |",
      "| --- | --- | --- | --- | --- | --- |",
      ...e.criteria.map(
        (c) =>
          `| \`${c.key}\` ${md(c.title)} | ${c.severity} | ${c.applicability} | ${c.verification} | ${c.disposition === "waived" ? `waived by ${md(c.waiver!.actor)}: ${md(c.waiver!.reason)}` : c.disposition} | ${c.evidenceIds.map((x) => `\`${x}\``).join(" ") || "—"} |`,
      ),
      "",
    );
    const notes = e.criteria.filter((c) => c.notes.length > 0 || c.applicabilityRationale);
    if (notes.length > 0) {
      lines.push("### Notes", "");
      for (const c of notes) {
        if (c.applicabilityRationale) lines.push(`- \`${c.key}\`: ${md(c.applicabilityRationale)}`);
        for (const note of c.notes) lines.push(`- \`${c.key}\`: ${md(note)}`);
      }
      lines.push("");
    }
  }
  return { body: lines.join("\n"), sourceIds: [], recordIds: criteriaOf(s).map((c) => c.id) };
}

export function renderDecision(s: ProjectSnapshot, d: StoredDecision): Rendered {
  const evidence = s.decisionEvidence[d.id] ?? [];
  const lines = [
    `# Decision: ${md(d.choice)}`,
    "",
    `- ID: \`${d.id}\``,
    `- Topic: ${md(d.topic ?? "general")}`,
    `- Status: **${d.status}**${d.confirmedBy ? ` (confirmed by ${md(d.confirmedBy)})` : ""}`,
    ...(d.supersedes ? [`- Supersedes: [\`${d.supersedes}\`](${d.supersedes}.md)`] : []),
    ...(d.supersededBy ? [`- Superseded by: [\`${d.supersededBy}\`](${d.supersededBy}.md)`] : []),
    "",
    "## Statement",
    "",
    md(d.statement),
    "",
    ...(d.rationale ? ["## Rationale", "", md(d.rationale), ""] : []),
    ...(d.alternatives.length > 0 ? ["## Alternatives considered", "", ...d.alternatives.map((a) => `- ${md(a)}`), ""] : []),
    "## Evidence",
    "",
    ...evidence.map((e) => `- \`${e.sourceId}:${e.start}-${e.end}\` (${e.speaker}${e.sourceTitle ? `, ${md(e.sourceTitle)}` : ""}): “${md(e.text)}”`),
    "",
  ];
  return { body: lines.join("\n"), sourceIds: sourcesOf([d]), recordIds: [d.id] };
}
