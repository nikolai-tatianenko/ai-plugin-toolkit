import { z } from "zod";

/**
 * Contract for model output during extraction (CL-004). The model never produces
 * character offsets: it cites an exact quote from a named source, and the memory
 * layer resolves the quote to a span in the original bytes. A quote that does not
 * occur, or a source the model was not shown, rejects the candidate (A04).
 */
export const EXTRACTION_PROMPT_VERSION = "extract-v1";

export const CandidateTypeSchema = z.enum([
  "fact",
  "goal",
  "requirement",
  "preference",
  "constraint",
  "event",
  /** Someone suggested an option. Never becomes a confirmed decision on its own. */
  "proposal",
  /** Someone with authority chose an option. */
  "decision",
]);
export type CandidateType = z.infer<typeof CandidateTypeSchema>;

export const CandidateEvidenceSchema = z.strictObject({
  sourceId: z.string().min(1),
  /** Exact, contiguous text copied from the source. */
  quote: z.string().min(1).max(2_000),
});

export const ExtractionCandidateSchema = z.strictObject({
  type: CandidateTypeSchema,
  /** One self-contained sentence. */
  statement: z.string().trim().min(1).max(1_000),
  /** Short subject such as "storage" or "purchases"; required for proposals and decisions. */
  topic: z.string().trim().min(1).max(100).optional(),
  /** Proposals and decisions: the option chosen or suggested. */
  choice: z.string().trim().min(1).max(500).optional(),
  alternatives: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
  evidence: z.array(CandidateEvidenceSchema).min(1).max(10),
});
export type ExtractionCandidate = z.infer<typeof ExtractionCandidateSchema>;

export const ExtractionOutputSchema = z.strictObject({
  items: z.array(z.unknown()).max(200),
});

/**
 * Hand-written JSON Schema for provider-side structured output. Kept minimal (no
 * length limits) because providers support only a subset of JSON Schema; the zod
 * schemas above remain the authoritative validation.
 */
export const EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "statement", "evidence"],
        properties: {
          type: { type: "string", enum: CandidateTypeSchema.options },
          statement: { type: "string" },
          topic: { type: "string" },
          choice: { type: "string" },
          alternatives: { type: "array", items: { type: "string" } },
          rationale: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["sourceId", "quote"],
              properties: { sourceId: { type: "string" }, quote: { type: "string" } },
            },
          },
        },
      },
    },
  },
};
