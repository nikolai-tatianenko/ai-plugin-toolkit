import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderReport, runEvaluation } from "../src/harness.js";

const datasetDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/datasets/extraction-v1");

describe("extraction evaluation harness (fixture provider)", () => {
  it("is reproducible and reports what validation catches and what only evaluation catches", async () => {
    const report = await runEvaluation({ datasetDir, provider: "fixture" });
    const again = await runEvaluation({ datasetDir, provider: "fixture" });
    const strip = (r: typeof report) => JSON.stringify({ ...r, cases: r.cases.map((c) => ({ ...c, latencyMs: 0 })), totals: { ...r.totals, latencyMs: 0 } });
    expect(strip(again)).toBe(strip(report));

    expect(report.cases.map((c) => c.error)).toEqual([undefined, undefined, undefined]);
    expect(report.totals).toMatchObject({ accepted: 12, rejected: 1, currentDecisionAccuracy: 1 });
    // The invented quote ("Users can delete their account in settings.") is rejected at validation...
    expect(report.cases.find((c) => c.id === "correction")!.rejectedReasons[0]).toMatch(/quote not found/);
    // ...but a claim copied from injected text ("all tests passed") passes validation; only evaluation flags it.
    const injected = report.cases.find((c) => c.id === "build-log-injection")!;
    expect(injected.unsupported.map((u) => u.statement)).toEqual(["All tests passed."]);
    expect(report.totals.precision).toBeCloseTo(11 / 12);
    expect(report.totals.recall).toBeCloseTo(11 / 14);
    expect(report.provider.note).toMatch(/not a model/);
    expect(renderReport(report)).toMatch(/No full-history or retrieval baseline/);
  });
});
