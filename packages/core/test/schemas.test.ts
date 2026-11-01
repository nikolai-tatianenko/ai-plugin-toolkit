import { describe, expect, it } from "vitest";
import {
  CriterionSchema,
  DecisionSchema,
  FactSchema,
  LoomError,
  QuestionSchema,
  SourceSchema,
  contentHash,
  parseWith,
  stableId,
} from "../src/index.js";

const now = "2026-10-31T17:00:00.000Z";
const sourceId = stableId("source", "demo", contentHash("hello"));
const span = { sourceId, start: 0, end: 5 };

describe("SourceSchema", () => {
  it("accepts a well-formed inline source and applies defaults", () => {
    const source = parseWith(
      SourceSchema,
      {
        id: sourceId,
        projectId: "demo",
        type: "conversation",
        contentHash: contentHash("hello"),
        content: { kind: "inline", text: "hello" },
        ingestedAt: now,
      },
      "source",
    );
    expect(source.mediaType).toBe("text/plain");
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    expect(() =>
      parseWith(
        SourceSchema,
        {
          id: sourceId,
          projectId: "demo",
          type: "conversation",
          contentHash: contentHash("x"),
          content: { kind: "inline", text: "x" },
          ingestedAt: now,
          extra: true,
        },
        "source",
      ),
    ).toThrow(LoomError);
  });
});

describe("FactSchema", () => {
  const fact = { id: stableId("fact", "a"), projectId: "demo", statement: "Uses SQLite", kind: "fact", status: "candidate", createdAt: now };

  it("requires at least one source span", () => {
    expect(FactSchema.safeParse({ ...fact, spans: [] }).success).toBe(false);
    expect(FactSchema.safeParse({ ...fact, spans: [span] }).success).toBe(true);
  });

  it("rejects empty or inverted spans", () => {
    expect(FactSchema.safeParse({ ...fact, spans: [{ ...span, end: 0 }] }).success).toBe(false);
  });

  it("rejects a span whose source ID is not a source ID", () => {
    expect(FactSchema.safeParse({ ...fact, spans: [{ ...span, sourceId: "src_madeup" }] }).success).toBe(false);
  });

  it("ties superseded status to a supersededBy reference", () => {
    expect(FactSchema.safeParse({ ...fact, spans: [span], status: "superseded" }).success).toBe(false);
    expect(
      FactSchema.safeParse({ ...fact, spans: [span], status: "superseded", supersededBy: stableId("fact", "b") }).success,
    ).toBe(true);
  });
});

describe("DecisionSchema (A02: proposals are not decisions)", () => {
  const base = { id: stableId("decision", "db"), projectId: "demo", choice: "SQLite", spans: [span], createdAt: now };

  it("accepts a proposal without a confirmer", () => {
    expect(DecisionSchema.safeParse({ ...base, status: "proposed" }).success).toBe(true);
  });

  it("refuses a confirmed decision with no confirmer", () => {
    expect(DecisionSchema.safeParse({ ...base, status: "confirmed" }).success).toBe(false);
    expect(DecisionSchema.safeParse({ ...base, status: "confirmed", confirmedBy: "nikolai" }).success).toBe(true);
  });
});

describe("QuestionSchema", () => {
  const base = { id: stableId("question", "q"), projectId: "demo", text: "Purchases?", impact: "high" };

  it("does not let an inferred answer close a question", () => {
    const answer = { text: "No purchases", answeredBy: "model", answeredAt: now, origin: "inferred" };
    expect(QuestionSchema.safeParse({ ...base, status: "answered", answer }).success).toBe(false);
    expect(QuestionSchema.safeParse({ ...base, status: "open", answer }).success).toBe(true);
    expect(
      QuestionSchema.safeParse({ ...base, status: "answered", answer: { ...answer, origin: "stated", answeredBy: "nikolai" } })
        .success,
    ).toBe(true);
  });
});

describe("CriterionSchema", () => {
  const base = {
    id: stableId("criterion", "c"),
    projectId: "demo",
    packId: "mobile-release",
    packVersion: "0.1.0",
    title: "Restore purchases",
    severity: "blocker",
    verificationMethod: "physical device test",
    applicability: "applicable",
    verification: "not-checked",
    disposition: "open",
  };

  it("A10: a pass without evidence is rejected", () => {
    expect(CriterionSchema.safeParse({ ...base, verification: "passed" }).success).toBe(false);
    expect(
      CriterionSchema.safeParse({ ...base, verification: "passed", evidenceIds: [stableId("evidence", "e")] }).success,
    ).toBe(true);
  });

  it("A09: not-applicable requires a rationale", () => {
    expect(CriterionSchema.safeParse({ ...base, applicability: "not-applicable" }).success).toBe(false);
    expect(
      CriterionSchema.safeParse({ ...base, applicability: "not-applicable", applicabilityRationale: "No purchases" })
        .success,
    ).toBe(true);
  });

  it("A13: a waiver records actor and reason, and only exists when waived", () => {
    const waiver = { actor: "nikolai", reason: "Deferred to 1.1", at: now };
    expect(CriterionSchema.safeParse({ ...base, disposition: "waived" }).success).toBe(false);
    expect(CriterionSchema.safeParse({ ...base, disposition: "open", waiver }).success).toBe(false);
    const waived = CriterionSchema.parse({ ...base, disposition: "waived", waiver });
    expect(waived.verification).toBe("not-checked");
  });
});

describe("parseWith", () => {
  it("throws VALIDATION_FAILED with path-qualified issues", () => {
    try {
      parseWith(FactSchema, { statement: "" }, "fact");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LoomError);
      const loom = error as LoomError;
      expect(loom.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(loom.details)).toContain("statement");
    }
  });
});
