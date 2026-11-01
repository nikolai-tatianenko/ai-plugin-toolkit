import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EvidenceEnvironmentKindSchema, LoomError, contentHash, parseWith } from "@ai-plugin-toolkit/core";

/**
 * Topic packs are declarative, versioned JSON (plan §7). They contain no executable
 * code: conditions are data evaluated by this module, so an imported pack cannot run
 * commands (plan §10).
 */

export type Condition =
  | { question: string; equals: string }
  | { question: string; in: string[] }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ question: z.string().min(1), equals: z.string().min(1) }),
    z.strictObject({ question: z.string().min(1), in: z.array(z.string().min(1)).min(1) }),
    z.strictObject({ all: z.array(ConditionSchema).min(1) }),
    z.strictObject({ any: z.array(ConditionSchema).min(1) }),
    z.strictObject({ not: ConditionSchema }),
  ]),
);

const KeySchema = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/, "Keys are lowercase dotted slugs");

export const AnswerSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("yes-no") }),
  z.strictObject({ type: z.literal("choice"), options: z.array(z.string().min(1)).min(2) }),
  z.strictObject({ type: z.literal("text") }),
]);
export type AnswerSpec = z.infer<typeof AnswerSpecSchema>;

export const PackQuestionSchema = z.strictObject({
  id: KeySchema,
  topic: KeySchema,
  text: z.string().min(1),
  impact: z.enum(["high", "medium", "low"]),
  answer: AnswerSpecSchema,
  /** Only asked when this holds (e.g. follow-ups). Absent: always asked. */
  askWhen: ConditionSchema.optional(),
  /** Words used to find possibly relevant memory; matches are shown as unconfirmed suggestions. */
  hints: z.array(z.string().min(2)).default([]),
});
export type PackQuestion = z.infer<typeof PackQuestionSchema>;

export const PackCriterionSchema = z.strictObject({
  id: KeySchema,
  topic: KeySchema,
  title: z.string().min(1),
  expected: z.string().min(1),
  severity: z.enum(["blocker", "major", "minor"]),
  /** Absent: always applicable. */
  applicableWhen: ConditionSchema.optional(),
  verification: z.strictObject({
    method: z.string().min(1),
    /** Environments whose evidence can establish this criterion. "mock" is never allowed. */
    environments: z.array(EvidenceEnvironmentKindSchema.exclude(["mock"])).min(1),
  }),
  task: z.strictObject({ title: z.string().min(1).max(300), description: z.string().min(1) }),
  /** Task dependencies by criterion id. */
  dependsOn: z.array(KeySchema).default([]),
});
export type PackCriterion = z.infer<typeof PackCriterionSchema>;

export const TopicPackSchema = z
  .strictObject({
    format: z.literal("loom-pack/1"),
    id: KeySchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().min(1),
    description: z.string().min(1),
    /** Statement of authority: what has and has not been reviewed against official sources. */
    advisory: z.string().min(1),
    topics: z.array(z.strictObject({ id: KeySchema, title: z.string().min(1) })).min(1),
    questions: z.array(PackQuestionSchema),
    criteria: z.array(PackCriterionSchema).min(1),
  })
  .superRefine((pack, ctx) => {
    const topics = new Set(pack.topics.map((t) => t.id));
    const questions = new Map(pack.questions.map((q) => [q.id, q]));
    const criteria = new Set(pack.criteria.map((c) => c.id));
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (questions.size !== pack.questions.length) issue(["questions"], "Question ids must be unique");
    if (criteria.size !== pack.criteria.length) issue(["criteria"], "Criterion ids must be unique");

    const checkCondition = (condition: Condition | undefined, path: (string | number)[]) => {
      if (condition === undefined) return;
      if ("all" in condition) condition.all.forEach((c, i) => checkCondition(c, [...path, "all", i]));
      else if ("any" in condition) condition.any.forEach((c, i) => checkCondition(c, [...path, "any", i]));
      else if ("not" in condition) checkCondition(condition.not, [...path, "not"]);
      else {
        const question = questions.get(condition.question);
        if (question === undefined) return issue(path, `Unknown question "${condition.question}"`);
        const values = "equals" in condition ? [condition.equals] : condition.in;
        const allowed = question.answer.type === "yes-no" ? ["yes", "no"] : question.answer.type === "choice" ? question.answer.options : undefined;
        for (const value of values) {
          if (allowed !== undefined && !allowed.includes(value)) issue(path, `"${value}" is not a possible answer to "${question.id}"`);
        }
      }
    };
    pack.questions.forEach((q, i) => {
      if (!topics.has(q.topic)) issue(["questions", i, "topic"], `Unknown topic "${q.topic}"`);
      checkCondition(q.askWhen, ["questions", i, "askWhen"]);
    });
    pack.criteria.forEach((c, i) => {
      if (!topics.has(c.topic)) issue(["criteria", i, "topic"], `Unknown topic "${c.topic}"`);
      checkCondition(c.applicableWhen, ["criteria", i, "applicableWhen"]);
      for (const dep of c.dependsOn) if (!criteria.has(dep)) issue(["criteria", i, "dependsOn"], `Unknown criterion "${dep}"`);
    });
  });
export type TopicPack = z.infer<typeof TopicPackSchema>;

/** Identifies a question's wording and answer options; an answer to a different hash must be asked again (A08). */
export function questionHash(question: PackQuestion): string {
  return contentHash(JSON.stringify([question.id, question.text, question.answer]));
}

export const BUILTIN_PACKS = ["mobile-release"] as const;

export function parsePack(raw: unknown, label = "topic pack"): TopicPack {
  return parseWith(TopicPackSchema, raw, label);
}

export async function loadPackFile(file: string): Promise<TopicPack> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw new LoomError("VALIDATION_FAILED", `Cannot read topic pack ${file}: ${(cause as Error).message}`, { cause });
  }
  return parsePack(raw, `topic pack ${file}`);
}

/** Load a pack shipped with this package by id. */
export async function loadBuiltinPack(id: string): Promise<TopicPack> {
  if (!(BUILTIN_PACKS as readonly string[]).includes(id)) {
    throw new LoomError("NOT_FOUND", `Unknown topic pack "${id}". Built-in packs: ${BUILTIN_PACKS.join(", ")}.`);
  }
  return loadPackFile(fileURLToPath(new URL(`../packs/${id}.json`, import.meta.url)));
}
