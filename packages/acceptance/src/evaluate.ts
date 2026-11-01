import {
  CriterionSchema,
  EvidenceEnvironmentKindSchema,
  LoomError,
  isIdOf,
  parseWith,
  stableId,
  type Criterion,
} from "@ai-plugin-toolkit/core";
import type { LoomStore, StoredAnswer, StoredEvidence } from "@ai-plugin-toolkit/storage-sqlite";
import { questionHash, type Condition, type PackCriterion, type PackQuestion, type TopicPack } from "./pack.js";

export const REVISION_KEY = "build.revision";

export type Tristate = true | false | undefined;

export interface QuestionState {
  question: PackQuestion;
  id: string;
  /** open: needs an answer; answered: valid stated answer; stale: answered for a different wording; not-needed: askWhen is false; waiting: askWhen depends on unanswered questions. */
  state: "open" | "answered" | "stale" | "not-needed" | "waiting";
  answer?: StoredAnswer;
  /** Criteria whose applicability is still unresolved because of this question. */
  blocks: string[];
  priority: number;
}

export interface CriterionState extends Criterion {
  key: string;
  topic: string;
  expected: string;
  acceptedEnvironments: string[];
  taskTitle: string;
  taskDescription: string;
  dependsOn: string[];
  /** Human-readable reasons behind the verification state (e.g. rejected evidence). */
  notes: string[];
  /** Answers the applicability decision was based on. */
  basis: Array<{ question: string; value: string; answeredBy: string; answeredAt: string }>;
}

export interface Evaluation {
  pack: { id: string; version: string; title: string; advisory: string };
  revision: string | undefined;
  questions: QuestionState[];
  criteria: CriterionState[];
  readiness: {
    status: "ready" | "ready-with-waivers" | "not-ready";
    blocking: Array<{ criterion: string; reason: string }>;
    waived: string[];
    minorGaps: string[];
  };
}

const IMPACT = { high: 3, medium: 2, low: 1 } as const;
const SEVERITY = { blocker: 3, major: 2, minor: 1 } as const;

export const criterionId = (projectId: string, packId: string, key: string) => stableId("criterion", projectId, packId, key);

/** Accept either the pack key ("purchases.restore") or the stable criterion ID. */
export function resolveCriterion(projectId: string, pack: TopicPack, ref: string): PackCriterion {
  const found = pack.criteria.find((c) => c.id === ref || (isIdOf("criterion", ref) && criterionId(projectId, pack.id, c.id) === ref));
  if (found === undefined) throw new LoomError("NOT_FOUND", `No criterion "${ref}" in pack ${pack.id}@${pack.version}.`);
  return found;
}

export function resolveQuestion(pack: TopicPack, ref: string): PackQuestion {
  const found = pack.questions.find((q) => q.id === ref);
  if (found === undefined) throw new LoomError("NOT_FOUND", `No question "${ref}" in pack ${pack.id}@${pack.version}.`);
  return found;
}

/** Valid answers keyed by question id. Answers to a changed question, or inferred ones, do not count. */
function validAnswers(pack: TopicPack, answers: readonly StoredAnswer[]): Map<string, StoredAnswer> {
  const out = new Map<string, StoredAnswer>();
  for (const answer of answers) {
    const question = pack.questions.find((q) => q.id === answer.questionKey);
    if (question === undefined || answer.origin !== "stated" || answer.questionHash !== questionHash(question)) continue;
    out.set(answer.questionKey, answer);
  }
  return out;
}

/**
 * Three-valued evaluation: undefined means "unresolved" (a needed answer is missing).
 * `deciding` collects only the answers that determined the result, so a rationale
 * cites the reason a criterion was excluded and nothing else.
 */
export function evaluateCondition(condition: Condition, answers: ReadonlyMap<string, StoredAnswer>, deciding: Set<string>): Tristate {
  const branch = (children: Condition[], short: boolean): Tristate => {
    const results = children.map((c) => {
      const used = new Set<string>();
      return { value: evaluateCondition(c, answers, used), used };
    });
    const decisive = results.filter((r) => r.value === short);
    const value: Tristate = decisive.length > 0 ? short : results.some((r) => r.value === undefined) ? undefined : !short;
    for (const r of decisive.length > 0 ? decisive : results) for (const q of r.used) deciding.add(q);
    return value;
  };
  if ("all" in condition) return branch(condition.all, false);
  if ("any" in condition) return branch(condition.any, true);
  if ("not" in condition) {
    const inner = evaluateCondition(condition.not, answers, deciding);
    return inner === undefined ? undefined : !inner;
  }
  const answer = answers.get(condition.question);
  if (answer === undefined) return undefined;
  deciding.add(condition.question);
  return "equals" in condition ? answer.value === condition.equals : condition.in.includes(answer.value);
}

function referencedQuestions(condition: Condition | undefined, out = new Set<string>()): Set<string> {
  if (condition === undefined) return out;
  if ("all" in condition) condition.all.forEach((c) => referencedQuestions(c, out));
  else if ("any" in condition) condition.any.forEach((c) => referencedQuestions(c, out));
  else if ("not" in condition) referencedQuestions(condition.not, out);
  else out.add(condition.question);
  return out;
}

function verificationOf(
  criterion: PackCriterion,
  evidence: readonly StoredEvidence[],
  revision: string | undefined,
  notes: string[],
): { verification: Criterion["verification"]; evidenceIds: string[] } {
  const accepted = new Set<string>(criterion.verification.environments);
  const usable: StoredEvidence[] = [];
  for (const item of evidence) {
    if (!accepted.has(item.environment.kind)) {
      // A11: e.g. emulator or mock evidence for a physical-device requirement.
      notes.push(`${item.id}: ${item.environment.kind} evidence does not satisfy this criterion (accepts ${[...accepted].join(", ")})`);
      continue;
    }
    if (item.result === "inconclusive") {
      notes.push(`${item.id}: inconclusive at revision ${item.revision}`);
      continue;
    }
    usable.push(item);
  }
  const current = revision === undefined ? usable : usable.filter((e) => e.revision === revision);
  const latest = current.at(-1);
  if (latest !== undefined) return { verification: latest.result === "passed" ? "passed" : "failed", evidenceIds: [latest.id] };
  if (usable.length > 0) {
    // A12: results exist, but none for the current revision.
    const last = usable.at(-1)!;
    notes.push(`${last.id}: ${last.result} at revision ${last.revision}, but the current revision is ${revision}`);
    return { verification: "stale", evidenceIds: [] };
  }
  return { verification: "not-checked", evidenceIds: [] };
}

/**
 * Evaluate a pack for a project (CL-008). Applicability, verification and disposition
 * are separate signals; nothing here reads task status, so a closed task can never
 * satisfy a criterion (A10).
 */
export function evaluatePack(store: LoomStore, projectId: string, pack: TopicPack): Evaluation {
  const answers = validAnswers(pack, store.acceptance.answers(projectId, pack.id));
  const allAnswers = new Map(store.acceptance.answers(projectId, pack.id).map((a) => [a.questionKey, a]));
  const revision = store.state.get(projectId, REVISION_KEY);
  const evidence = store.acceptance.evidence(projectId);
  const dispositions = new Map(store.acceptance.dispositions(projectId).map((d) => [d.criterionId, d]));

  const criteria: CriterionState[] = pack.criteria.map((pc) => {
    const id = criterionId(projectId, pack.id, pc.id);
    const used = new Set<string>();
    const applies = pc.applicableWhen === undefined ? true : evaluateCondition(pc.applicableWhen, answers, used);
    const basis = [...used].map((q) => {
      const a = answers.get(q)!;
      return { question: q, value: a.value, answeredBy: a.answeredBy, answeredAt: a.answeredAt };
    });
    const notes: string[] = [];
    const applicability = applies === true ? "applicable" : applies === false ? "not-applicable" : "unresolved";
    const { verification, evidenceIds } =
      applicability === "applicable"
        ? verificationOf(pc, evidence.filter((e) => e.criterionId === id), revision, notes)
        : { verification: "not-checked" as const, evidenceIds: [] };
    const disposition = dispositions.get(id);
    const base = {
      id,
      projectId,
      packId: pack.id,
      packVersion: pack.version,
      title: pc.title,
      severity: pc.severity,
      verificationMethod: pc.verification.method,
      applicability,
      ...(applicability === "not-applicable"
        ? {
            // A09: the rationale is the recorded answer that made the criterion inapplicable.
            applicabilityRationale: `Not applicable: ${basis.map((b) => `"${b.question}" was answered "${b.value}" by ${b.answeredBy} on ${b.answeredAt.slice(0, 10)}`).join("; ")}.`,
          }
        : {}),
      verification,
      evidenceIds,
      disposition: disposition?.disposition ?? "open",
      ...(disposition?.disposition === "waived" ? { waiver: { actor: disposition.actor, reason: disposition.reason!, at: disposition.at } } : {}),
    };
    const validated = parseWith(CriterionSchema, base, `criterion ${pc.id}`);
    return {
      ...validated,
      key: pc.id,
      topic: pc.topic,
      expected: pc.expected,
      acceptedEnvironments: [...pc.verification.environments],
      taskTitle: pc.task.title,
      taskDescription: pc.task.description,
      dependsOn: pc.dependsOn,
      notes,
      basis,
    };
  });

  const questions: QuestionState[] = pack.questions.map((q) => {
    const id = stableId("question", projectId, pack.id, q.id);
    const stored = allAnswers.get(q.id);
    const valid = answers.get(q.id);
    const askWhen = q.askWhen === undefined ? true : evaluateCondition(q.askWhen, answers, new Set());
    const blocks = criteria
      .filter((c) => c.applicability === "unresolved" && referencedQuestions(pack.criteria.find((p) => p.id === c.key)!.applicableWhen).has(q.id))
      .map((c) => c.key);
    const priority = IMPACT[q.impact] * (1 + blocks.reduce((sum, key) => sum + SEVERITY[criteria.find((c) => c.key === key)!.severity], 0));
    const state: QuestionState["state"] =
      valid !== undefined ? "answered" : stored !== undefined ? "stale" : askWhen === false ? "not-needed" : askWhen === undefined ? "waiting" : "open";
    return { question: q, id, state, ...(stored === undefined ? {} : { answer: stored }), blocks, priority };
  });

  const blocking: Evaluation["readiness"]["blocking"] = [];
  const waived: string[] = [];
  const minorGaps: string[] = [];
  for (const c of criteria) {
    if (c.applicability === "not-applicable") continue;
    const important = c.severity !== "minor";
    if (c.applicability === "unresolved") {
      if (important) blocking.push({ criterion: c.key, reason: "applicability unresolved (unanswered question)" });
      else minorGaps.push(c.key);
      continue;
    }
    if (c.verification === "passed") continue;
    if (c.disposition === "waived") {
      waived.push(c.key);
      continue;
    }
    if (important) blocking.push({ criterion: c.key, reason: `verification ${c.verification}` });
    else minorGaps.push(c.key);
  }
  return {
    pack: { id: pack.id, version: pack.version, title: pack.title, advisory: pack.advisory },
    revision,
    questions,
    criteria,
    readiness: {
      status: blocking.length > 0 ? "not-ready" : waived.length > 0 ? "ready-with-waivers" : "ready",
      blocking,
      waived,
      minorGaps,
    },
  };
}

export const ENVIRONMENT_KINDS = EvidenceEnvironmentKindSchema.options;
