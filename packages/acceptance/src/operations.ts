import { EvidenceEnvironmentKindSchema, LoomError, parseWith } from "@ai-plugin-toolkit/core";
import { search } from "@ai-plugin-toolkit/retrieval";
import type { LoomStore, StoredEvidence } from "@ai-plugin-toolkit/storage-sqlite";
import { z } from "zod";
import {
  REVISION_KEY,
  criterionId,
  evaluatePack,
  resolveCriterion,
  resolveQuestion,
  type CriterionState,
  type Evaluation,
  type QuestionState,
} from "./evaluate.js";
import { questionHash, type TopicPack } from "./pack.js";

export function activatePack(store: LoomStore, projectId: string, pack: TopicPack, actor: string): void {
  store.transaction(() => {
    store.acceptance.activatePack(projectId, pack.id, pack.version);
    store.audit(projectId, "acceptance.activate", actor, [pack.id]);
  });
}

/** The single active pack, or the one named. */
export function activePackId(store: LoomStore, projectId: string, requested?: string): string {
  const active = store.acceptance.activePacks(projectId);
  if (requested !== undefined) {
    if (!active.some((p) => p.packId === requested)) {
      throw new LoomError("NOT_FOUND", `Pack "${requested}" is not active. Run \`loom assess --pack ${requested}\` first.`);
    }
    return requested;
  }
  if (active.length === 0) throw new LoomError("NOT_FOUND", "No topic pack is active. Run `loom assess --pack mobile-release` first.");
  if (active.length > 1) throw new LoomError("VALIDATION_FAILED", `Several packs are active (${active.map((p) => p.packId).join(", ")}); pass --pack.`);
  return active[0]!.packId;
}

export function normalizeAnswer(pack: TopicPack, questionKey: string, raw: string): string {
  const question = resolveQuestion(pack, questionKey);
  const value = raw.trim();
  if (value === "") throw new LoomError("VALIDATION_FAILED", "An answer cannot be empty.");
  if (question.answer.type === "yes-no") {
    const lowered = value.toLowerCase();
    if (["yes", "y", "true"].includes(lowered)) return "yes";
    if (["no", "n", "false"].includes(lowered)) return "no";
    throw new LoomError("VALIDATION_FAILED", `"${questionKey}" expects yes or no.`);
  }
  if (question.answer.type === "choice") {
    const match = question.answer.options.find((o) => o.toLowerCase() === value.toLowerCase());
    if (match === undefined) throw new LoomError("VALIDATION_FAILED", `"${questionKey}" expects one of: ${question.answer.options.join(", ")}.`);
    return match;
  }
  return value;
}

/** Record a stated answer from a person. Only stated answers resolve applicability. */
export function answerQuestion(
  store: LoomStore,
  projectId: string,
  pack: TopicPack,
  input: { question: string; value: string; actor: string; note?: string },
) {
  const question = resolveQuestion(pack, input.question);
  const value = normalizeAnswer(pack, question.id, input.value);
  return store.transaction(() => {
    const answer = store.acceptance.setAnswer(projectId, {
      packId: pack.id,
      questionKey: question.id,
      value,
      origin: "stated",
      answeredBy: input.actor,
      questionHash: questionHash(question),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    store.audit(projectId, "acceptance.answer", input.actor, [answer.id]);
    return answer;
  });
}

const EvidenceInputSchema = z.strictObject({
  criterion: z.string().min(1),
  result: z.enum(["passed", "failed", "inconclusive"]),
  revision: z.string().trim().min(1, "Evidence must name the source/build revision it applies to"),
  environment: EvidenceEnvironmentKindSchema,
  description: z.string().trim().min(1).optional(),
  artifactRef: z.string().trim().min(1).optional(),
  actor: z.string().trim().min(1),
});

/** Attach verification evidence. Recording is always allowed; whether it counts is decided at evaluation. */
export function addEvidence(store: LoomStore, projectId: string, pack: TopicPack, raw: z.input<typeof EvidenceInputSchema>): StoredEvidence {
  const input = parseWith(EvidenceInputSchema, raw, "evidence");
  const criterion = resolveCriterion(projectId, pack, input.criterion);
  return store.transaction(() => {
    const evidence = store.acceptance.addEvidence(projectId, {
      criterionId: criterionId(projectId, pack.id, criterion.id),
      result: input.result,
      revision: input.revision,
      environment: input.description === undefined ? { kind: input.environment } : { kind: input.environment, description: input.description },
      artifactRef: input.artifactRef,
      recordedBy: input.actor,
    });
    store.audit(projectId, "acceptance.evidence", input.actor, [evidence.id, evidence.criterionId]);
    return evidence;
  });
}

/** A13: a waiver records actor and reason, and is never reported as a pass. */
export function waiveCriterion(store: LoomStore, projectId: string, pack: TopicPack, input: { criterion: string; actor: string; reason: string }): void {
  const criterion = resolveCriterion(projectId, pack, input.criterion);
  if (input.reason.trim() === "") throw new LoomError("VALIDATION_FAILED", "A waiver needs a reason (--reason).");
  const id = criterionId(projectId, pack.id, criterion.id);
  store.transaction(() => {
    store.acceptance.setDisposition(projectId, { criterionId: id, disposition: "waived", actor: input.actor, reason: input.reason });
    store.audit(projectId, "acceptance.waive", input.actor, [id]);
  });
}

/** Human approval, recorded separately from technical verification. */
export function acceptCriterion(store: LoomStore, projectId: string, pack: TopicPack, input: { criterion: string; actor: string; note?: string }): void {
  const criterion = resolveCriterion(projectId, pack, input.criterion);
  const id = criterionId(projectId, pack.id, criterion.id);
  store.transaction(() => {
    store.acceptance.setDisposition(projectId, { criterionId: id, disposition: "accepted", actor: input.actor, reason: input.note });
    store.audit(projectId, "acceptance.accept", input.actor, [id]);
  });
}

export function reopenCriterion(store: LoomStore, projectId: string, pack: TopicPack, input: { criterion: string; actor: string }): void {
  const id = criterionId(projectId, pack.id, resolveCriterion(projectId, pack, input.criterion).id);
  store.transaction(() => {
    store.acceptance.clearDisposition(projectId, id);
    store.audit(projectId, "acceptance.reopen", input.actor, [id]);
  });
}

/** Set the current source/build revision. Evidence for other revisions becomes stale (A12). */
export function setRevision(store: LoomStore, projectId: string, revision: string, actor: string): void {
  if (revision.trim() === "") throw new LoomError("VALIDATION_FAILED", "Revision cannot be empty.");
  store.transaction(() => {
    store.state.set(projectId, REVISION_KEY, revision.trim());
    store.audit(projectId, "acceptance.revision", actor, [revision.trim()]);
  });
}

// ---- Question selection ---------------------------------------------------------

export type QuestionMode = "quick" | "guided" | "challenge";

export interface Suggestion {
  recordId: string;
  kind: string;
  status: string;
  text: string;
}

export interface AskItem {
  kind: "question" | "challenge";
  id: string;
  topic: string;
  text: string;
  priority: number;
  /** Why this is being asked. */
  reason: string;
  answerFormat?: string;
  /** Possibly relevant memory. Inferred, not an answer: a person must still answer. */
  suggestions?: Suggestion[];
}

function suggestionsFor(store: LoomStore, projectId: string, question: QuestionState): Suggestion[] {
  if (question.question.hints.length === 0) return [];
  try {
    return search(store, projectId, question.question.hints.join(" "), { limit: 3, kinds: ["fact", "decision"] }).map((h) => ({
      recordId: h.id,
      kind: h.kind,
      status: h.status,
      text: h.text,
    }));
  } catch {
    return [];
  }
}

function format(q: QuestionState): string {
  const spec = q.question.answer;
  return spec.type === "yes-no" ? "yes | no" : spec.type === "choice" ? spec.options.join(" | ") : "free text";
}

function challenges(store: LoomStore, projectId: string, evaluation: Evaluation): AskItem[] {
  const items: AskItem[] = [];
  const byId = new Map(evaluation.criteria.map((c) => [c.id, c]));
  const push = (c: CriterionState, text: string, reason: string, priority: number) =>
    items.push({ kind: "challenge", id: `challenge:${c.key}:${items.length + 1}`, topic: c.topic, text, reason, priority });

  for (const c of evaluation.criteria) {
    if (c.applicability === "not-applicable" && c.severity !== "minor") {
      push(c, `Is "${c.title}" really out of scope? ${c.applicabilityRationale}`, "not-applicable decisions remove checks; confirm the basis still holds", 6);
    }
    if (c.disposition === "waived") {
      push(c, `"${c.title}" is waived by ${c.waiver!.actor} ("${c.waiver!.reason}"). Is the waiver still justified for revision ${evaluation.revision ?? "(unset)"}?`, "waivers are not passes", 7);
    }
    if (c.disposition === "accepted" && c.verification !== "passed") {
      push(c, `"${c.title}" is accepted but verification is ${c.verification}. What evidence supports the acceptance?`, "approval without evidence", 8);
    }
    if (c.verification === "stale") push(c, `Evidence for "${c.title}" is for an older revision. Re-run: ${c.verificationMethod}`, c.notes.join("; "), 7);
    if (c.applicability === "applicable" && c.verification === "not-checked" && c.notes.length > 0) {
      push(c, `Evidence for "${c.title}" does not count: ${c.notes.join("; ")}. Which ${c.acceptedEnvironments.join("/")} result exists?`, "unacceptable evidence environment", 8);
    }
  }
  // A10: a closed task is not evidence.
  for (const task of store.tasks.list(projectId)) {
    if (task.status !== "closed") continue;
    for (const cid of task.criterionIds) {
      const c = byId.get(cid);
      if (c !== undefined && c.verification !== "passed") {
        push(c, `Task "${task.title}" is closed, but "${c.title}" has verification ${c.verification}. Where is the evidence?`, "completion claim without evidence", 9);
      }
    }
  }
  return items;
}

/**
 * Choose what to ask next (plan §7). Quick: only what blocks the next decision.
 * Guided: everything open, grouped by topic. Challenge: probe completion claims,
 * waivers and inapplicability decisions. Answered questions are never re-asked unless
 * their wording changed (A08).
 */
export function selectQuestions(store: LoomStore, projectId: string, evaluation: Evaluation, mode: QuestionMode, limit = 10): AskItem[] {
  const ask = (q: QuestionState, reason: string): AskItem => {
    const suggestions = suggestionsFor(store, projectId, q);
    return {
      kind: "question",
      id: q.question.id,
      topic: q.question.topic,
      text: q.question.text,
      priority: q.priority,
      reason,
      answerFormat: format(q),
      ...(suggestions.length > 0 ? { suggestions } : {}),
    };
  };
  const pending = evaluation.questions.filter((q) => q.state === "open" || q.state === "stale");
  const reasonOf = (q: QuestionState) =>
    q.state === "stale"
      ? "the question changed since it was answered"
      : q.blocks.length > 0
        ? `decides applicability of ${q.blocks.join(", ")}`
        : "open question";
  const byPriority = (a: QuestionState, b: QuestionState) => b.priority - a.priority || a.question.id.localeCompare(b.question.id);

  if (mode === "quick") {
    const blockingKeys = new Set(evaluation.criteria.filter((c) => c.severity === "blocker" && c.applicability === "unresolved").map((c) => c.key));
    return pending
      .filter((q) => q.blocks.some((k) => blockingKeys.has(k)) || q.question.impact === "high")
      .sort(byPriority)
      .slice(0, Math.min(limit, 5))
      .map((q) => ask(q, reasonOf(q)));
  }
  if (mode === "guided") {
    const out: AskItem[] = [];
    for (const topic of new Set(pending.sort(byPriority).map((q) => q.question.topic))) {
      out.push(...pending.filter((q) => q.question.topic === topic).slice(0, 3).map((q) => ask(q, reasonOf(q))));
    }
    return out.slice(0, limit);
  }
  return [...challenges(store, projectId, evaluation), ...pending.filter((q) => q.state === "stale").map((q) => ask(q, reasonOf(q)))]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}
