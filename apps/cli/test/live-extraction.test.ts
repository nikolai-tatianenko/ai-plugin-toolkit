import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";

// Opt-in, synthetic evidence only. This exercises the real provider through the CLI,
// including extraction validation, persistence, provenance, retrieval and generation.
for (const provider of ["anthropic", "ollama"] as const) {
  const model = process.env[provider === "anthropic" ? "LOOM_ANTHROPIC_MODEL" : "LOOM_OLLAMA_MODEL"];
  const enabled = process.env.LOOM_LIVE_TESTS === "1" && Boolean(model) &&
    (provider !== "anthropic" || Boolean(process.env.ANTHROPIC_API_KEY));
  describe.skipIf(!enabled)(`live extraction: ${provider}`, () => {
    it("preserves human decisions, assistant proposals and exact citations through the CLI", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "loom-live-"));
      const messages = [
        { role: "user", content: "Decision: store project data in SQLite." },
        { role: "assistant", content: "Proposal: use PostgreSQL for analytics." },
        { role: "user", content: "Requirement: the app must work offline." },
      ];
      const loom = async (args: string[]) => {
        let stdout = "";
        const code = await run([...args, "--json"], {
          cwd: dir, env: { ...process.env, LOOM_ACTOR: "live-verification" },
          stdout: (s) => { stdout += s; }, stderr: () => {},
        });
        const result = JSON.parse(stdout);
        // Avoid printing provider responses or environment values on failure.
        expect(code, `${args[0]} failed: ${result.error?.code ?? "unknown"}`).toBe(0);
        return result.data;
      };
      try {
        await writeFile(path.join(dir, "conversation.json"), JSON.stringify({ messages }));
        await loom(["init", "--project-id", "live-check", "--provider", provider, "--model", model!]);
        const configFile = path.join(dir, "loom.config.json");
        const config = JSON.parse(await readFile(configFile, "utf8"));
        config.routing.extraction.maxAttempts = 1;
        config.routing.extraction.maxOutputTokens = 3000;
        if (provider === "ollama") {
          config.providers.local.baseUrl = process.env.LOOM_OLLAMA_URL ?? "http://127.0.0.1:11434";
          // Leave room for a cold model load and CPU-only inference on the verification host.
          config.routing.extraction.timeoutMs = 240_000;
        }
        await writeFile(configFile, JSON.stringify(config));
        await loom(["ingest", "conversation.json"]);
        const extraction = await loom(["extract"]);
        expect(extraction.totals.rejected).toBe(0);
        expect(extraction.totals.created).toBeGreaterThanOrEqual(3);
        const memory = await loom(["memory", "list"]);
        expect(memory.decisions.some((d: { choice: string; status: string }) => /sqlite/i.test(d.choice) && d.status === "confirmed")).toBe(true);
        expect(memory.decisions.some((d: { choice: string; status: string }) => /postgresql/i.test(d.choice) && d.status === "proposed")).toBe(true);
        expect(memory.facts.some((f: { statement: string }) => /offline/i.test(f.statement))).toBe(true);
        for (const record of [...memory.facts, ...memory.decisions]) {
          const shown = await loom(["memory", "show", record.id]);
          expect(shown.evidence.length).toBeGreaterThan(0);
          for (const evidence of shown.evidence) {
            expect(evidence.text.length).toBeGreaterThan(0);
            expect(messages.some((m) => m.content.includes(evidence.text))).toBe(true);
          }
        }
        expect((await loom(["search", "offline"])).hits.length).toBeGreaterThan(0);
        expect((await loom(["context", "offline", "--max-chars", "800"])).usedChars).toBeLessThanOrEqual(800);
        await loom(["generate"]);
        expect(await readFile(path.join(dir, "loom-docs/VISION.md"), "utf8")).toMatch(/SQLite/i);
        const again = await loom(["extract"]);
        expect(again.totals).toMatchObject({ extracted: 0, skipped: 1, created: 0 });
        if (process.env.LOOM_LIVE_RESULT_FILE) {
          const result = extraction.results[0];
          await writeFile(process.env.LOOM_LIVE_RESULT_FILE, JSON.stringify({
            provider, model: result.model, created: extraction.totals.created,
            rejected: extraction.totals.rejected, usage: result.usage,
          }));
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 360_000);
  });
}
