import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineProvider, parseConfig } from "@ai-plugin-toolkit/core";
import { Router } from "@ai-plugin-toolkit/router";
import { evaluateNormalization, normalizeWithModel, normalizeWithRules, protect, restore, type NormalizationCase } from "../src/index.js";

const dataset = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/datasets/normalization-v1/cases.json");
const cases = async () => (JSON.parse(await readFile(dataset, "utf8")) as { cases: NormalizationCase[] }).cases;

const modelRouter = (rewrite: (text: string) => string) =>
  new Router({
    config: parseConfig({ $schemaVersion: 1, project: { id: "p", name: "p" }, providers: { m: { adapter: "m", location: "local" } }, routing: { normalization: { providers: ["m"], maxAttempts: 1 } } }),
    env: {},
    rootDir: "/",
    factories: {
      m: () =>
        defineProvider({
          manifest: { kind: "provider", name: "m", version: "1.0.0", location: "local", capabilities: ["complete"] },
          async complete(req) {
            return { text: rewrite(req.messages[0]!.content), model: "scripted", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
          },
        }),
    },
  });

describe("protected regions", () => {
  it("round-trips code, quotes, URLs, paths, versions, numbers and identifiers exactly", () => {
    const text = 'Run `npm test` on src/a/b.ts (v1.2.3) with MAX_RETRIES=3, see https://x.dev/p?q=1 and "keep this" for userId.';
    const p = protect(text);
    expect(p.slots).toEqual(expect.arrayContaining(["`npm test`", "src/a/b.ts", "v1.2.3", "MAX_RETRIES", "https://x.dev/p?q=1", '"keep this"', "userId"]));
    expect(p.text).not.toMatch(/npm test|keep this|https/);
    expect(restore(p.text, p.slots)).toBe(text);
  });
});

describe("A25: meaning is preserved or the original is used", () => {
  it("the rules normalizer preserves every required span in the baseline dataset", async () => {
    const result = await evaluateNormalization(await cases(), normalizeWithRules);
    expect(result.failures).toEqual([]);
    expect(result.preserved).toBe(result.cases);
    expect(result.transformed).toBeGreaterThan(5);
  });

  it("simplifies wording without touching protected content", () => {
    expect(normalizeWithRules("Set `LOOM_ACTOR` in order to facilitate audit records.").output).toBe("Set `LOOM_ACTOR` to help audit records.");
    expect(normalizeWithRules('He said "utilize it".').output).toBe('He said "utilize it".');
  });

  it("falls back to the original when a model rewrite drops a negation, a number or a placeholder", async () => {
    const original = "Do not retry more than 3 times unless `force` is set.";
    const dropsNot = await normalizeWithModel(original, modelRouter((t) => t.replace("Do not retry", "Retry")));
    expect(dropsNot).toMatchObject({ status: "fallback", output: original });
    expect(dropsNot.invariants.checks.find((c) => c.name === "negation")!.ok).toBe(false);
    const dropsSlot = await normalizeWithModel(original, modelRouter((t) => t.replace(/⟦\d+⟧/, "")));
    expect(dropsSlot.status).toBe("fallback");
    const good = await normalizeWithModel("You must not utilize the old API.", modelRouter((t) => t.replace("utilize", "use")));
    expect(good).toMatchObject({ status: "transformed", output: "You must not use the old API." });
  });

  it("reports long sentences and passive voice as advisories without rewriting them", () => {
    const r = normalizeWithRules("The configuration is validated by the router before every single request is sent to any of the configured providers in the policy.");
    expect(r.advisories.map((a) => a.kind).sort()).toEqual(["long-sentence", "passive-voice"]);
  });
});
