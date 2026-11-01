import { z } from "zod";
import { LoomError } from "./errors.js";
import { ID_PREFIXES, type EntityKind, isIdOf } from "./ids.js";

/**
 * Entity contracts from the implementation plan (§3). These are the validated
 * shapes every module exchanges; storage, adapters and interfaces map to them.
 * Invariants that encode product rules (e.g. "a pass needs evidence") live here
 * so no module can bypass them.
 */

export const idOf = (kind: EntityKind) =>
  z.string().refine((value) => isIdOf(kind, value), { message: `Expected a ${ID_PREFIXES[kind]}_ ID` });

export const ProjectIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Project ID must be lowercase letters, digits or '-', max 63 chars");
export type ProjectId = z.infer<typeof ProjectIdSchema>;

const Timestamp = z.iso.datetime({ offset: true });
const NonEmpty = z.string().trim().min(1);
const Actor = NonEmpty.max(200);

/** Character offsets into the original source text, end-exclusive. */
export const SourceSpanSchema = z
  .strictObject({
    sourceId: idOf("source"),
    start: z.int().nonnegative(),
    end: z.int().nonnegative(),
  })
  .refine((span) => span.end > span.start, { message: "Span end must be greater than start" });
export type SourceSpan = z.infer<typeof SourceSpanSchema>;

export const SourceTypeSchema = z.enum(["conversation", "document", "tool-output"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;
export const SOURCE_TYPES: readonly SourceType[] = SourceTypeSchema.options;

export const ContentRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inline"), text: z.string() }),
  z.strictObject({
    kind: z.literal("file"),
    /** Path relative to the storage directory; validated against traversal by the storage layer. */
    path: NonEmpty,
    bytes: z.int().nonnegative(),
  }),
]);

export const SourceSchema = z.strictObject({
  id: idOf("source"),
  projectId: ProjectIdSchema,
  type: SourceTypeSchema,
  title: NonEmpty.max(500).optional(),
  mediaType: NonEmpty.default("text/plain"),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  content: ContentRefSchema,
  /** When the evidence was originally produced, if known. */
  createdAt: Timestamp.optional(),
  ingestedAt: Timestamp,
});
export type Source = z.infer<typeof SourceSchema>;

export const FactKindSchema = z.enum(["fact", "goal", "requirement", "preference", "constraint", "event"]);
export type FactKind = z.infer<typeof FactKindSchema>;

export const FactSchema = z
  .strictObject({
    id: idOf("fact"),
    projectId: ProjectIdSchema,
    statement: NonEmpty,
    kind: FactKindSchema,
    spans: z.array(SourceSpanSchema).min(1, "A fact must cite at least one source span"),
    status: z.enum(["candidate", "confirmed", "rejected", "superseded"]),
    supersededBy: idOf("fact").optional(),
    validFrom: Timestamp.optional(),
    validTo: Timestamp.optional(),
    createdAt: Timestamp,
  })
  .refine((f) => (f.status === "superseded") === (f.supersededBy !== undefined), {
    message: "supersededBy is required exactly when status is 'superseded'",
    path: ["supersededBy"],
  });
export type Fact = z.infer<typeof FactSchema>;

export const DecisionSchema = z
  .strictObject({
    id: idOf("decision"),
    projectId: ProjectIdSchema,
    choice: NonEmpty,
    /** Short subject the decision is about (e.g. "storage"); a newer confirmed decision on the same topic supersedes older ones. */
    topic: NonEmpty.max(100).optional(),
    rationale: NonEmpty.optional(),
    alternatives: z.array(NonEmpty).default([]),
    /** A proposal is never a decision until someone confirms it. */
    status: z.enum(["proposed", "confirmed", "rejected", "superseded"]),
    confirmedBy: Actor.optional(),
    supersedes: idOf("decision").optional(),
    spans: z.array(SourceSpanSchema).min(1, "A decision must cite at least one source span"),
    createdAt: Timestamp,
  })
  .refine((d) => d.status !== "confirmed" || d.confirmedBy !== undefined, {
    message: "A confirmed decision must record who confirmed it",
    path: ["confirmedBy"],
  });
export type Decision = z.infer<typeof DecisionSchema>;

export const QuestionSchema = z
  .strictObject({
    id: idOf("question"),
    projectId: ProjectIdSchema,
    text: NonEmpty,
    impact: z.enum(["high", "medium", "low"]),
    status: z.enum(["open", "answered", "withdrawn"]),
    answer: z
      .strictObject({
        text: NonEmpty,
        answeredBy: Actor,
        answeredAt: Timestamp,
        /** An inferred answer is a suggestion; only a stated answer closes the question. */
        origin: z.enum(["stated", "inferred"]),
        spans: z.array(SourceSpanSchema).default([]),
      })
      .optional(),
    criterionIds: z.array(idOf("criterion")).default([]),
  })
  .refine((q) => q.status !== "answered" || q.answer?.origin === "stated", {
    message: "An answered question needs a stated (not inferred) answer",
    path: ["answer"],
  });
export type Question = z.infer<typeof QuestionSchema>;

export const ArtifactTypeSchema = z.enum(["facts", "vision", "plan", "status", "acceptance", "decision-record"]);

export const ArtifactSchema = z.strictObject({
  id: idOf("artifact"),
  projectId: ProjectIdSchema,
  type: ArtifactTypeSchema,
  revision: z.int().positive(),
  sourceIds: z.array(idOf("source")),
  generator: z.strictObject({
    name: NonEmpty,
    version: NonEmpty,
    model: NonEmpty.optional(),
  }),
  path: NonEmpty.optional(),
  createdAt: Timestamp,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const EvidenceEnvironmentKindSchema = z.enum([
  "physical-device",
  "emulator",
  "simulator",
  "ci",
  "manual",
  "production",
  "mock",
]);

export const EvidenceSchema = z.strictObject({
  id: idOf("evidence"),
  projectId: ProjectIdSchema,
  criterionId: idOf("criterion"),
  result: z.enum(["passed", "failed", "inconclusive"]),
  /** Source commit or build identifier the result applies to. */
  revision: NonEmpty,
  environment: z.strictObject({
    kind: EvidenceEnvironmentKindSchema,
    description: NonEmpty.optional(),
  }),
  artifactRef: NonEmpty.optional(),
  collectedAt: Timestamp,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CriterionSchema = z
  .strictObject({
    id: idOf("criterion"),
    projectId: ProjectIdSchema,
    packId: NonEmpty,
    packVersion: NonEmpty,
    title: NonEmpty,
    severity: z.enum(["blocker", "major", "minor"]),
    verificationMethod: NonEmpty,
    applicability: z.enum(["applicable", "not-applicable", "unresolved"]),
    applicabilityRationale: NonEmpty.optional(),
    verification: z.enum(["not-checked", "passed", "failed", "stale"]),
    evidenceIds: z.array(idOf("evidence")).default([]),
    disposition: z.enum(["open", "accepted", "waived"]),
    waiver: z.strictObject({ actor: Actor, reason: NonEmpty, at: Timestamp }).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.applicability === "not-applicable" && c.applicabilityRationale === undefined) {
      ctx.addIssue({ code: "custom", path: ["applicabilityRationale"], message: "not-applicable needs a rationale" });
    }
    if ((c.verification === "passed" || c.verification === "failed") && c.evidenceIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "A verification result requires evidence" });
    }
    if ((c.disposition === "waived") !== (c.waiver !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["waiver"], message: "waiver is required exactly when disposition is 'waived'" });
    }
  });
export type Criterion = z.infer<typeof CriterionSchema>;

export const TaskSchema = z.strictObject({
  id: idOf("task"),
  projectId: ProjectIdSchema,
  title: NonEmpty.max(300),
  description: z.string().optional(),
  status: z.enum(["open", "in-progress", "closed"]),
  criterionIds: z.array(idOf("criterion")).default([]),
  dependsOn: z.array(idOf("task")).default([]),
  revision: z.int().positive(),
});
export type Task = z.infer<typeof TaskSchema>;

export const SyncMappingSchema = z.strictObject({
  id: idOf("syncMapping"),
  projectId: ProjectIdSchema,
  taskId: idOf("task"),
  adapter: z.strictObject({ name: NonEmpty, version: NonEmpty }),
  externalId: NonEmpty,
  idempotencyKey: NonEmpty,
  lastLocalRevision: z.int().positive(),
  lastRemoteRevision: NonEmpty.optional(),
  syncedAt: Timestamp,
});
export type SyncMapping = z.infer<typeof SyncMappingSchema>;

export const AuditEventSchema = z
  .strictObject({
    id: idOf("auditEvent"),
    projectId: ProjectIdSchema,
    operation: NonEmpty,
    actor: Actor,
    changedIds: z.array(z.string()).default([]),
    result: z.enum(["ok", "error"]),
    errorCode: NonEmpty.optional(),
    at: Timestamp,
  })
  .refine((e) => e.result === "ok" || e.errorCode !== undefined, {
    message: "A failed audit event must include an error code",
    path: ["errorCode"],
  });
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * Parse untrusted input against a schema, converting failures into a typed
 * LoomError with path-qualified issues. Never returns a partially valid value.
 */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    }));
    const summary = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new LoomError("VALIDATION_FAILED", `Invalid ${what}: ${summary}`, { details: { issues } });
  }
  return result.data;
}
