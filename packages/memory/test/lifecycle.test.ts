import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineProvider, parseConfig } from "@ai-plugin-toolkit/core";
import { Router } from "@ai-plugin-toolkit/router";
import { DATABASE_FILENAME, LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import {
  correctDecision,
  exportProject,
  extractSource,
  forgetSource,
  importProject,
  looksContradictory,
  resolveReview,
  sourcesPastRetention,
} from "../src/index.js";

let dir: string;
let store: LoomStore;
const P = "habit";

/** Every sentence becomes a requirement; "Decision: X." sentences become decisions on topic "storage". */
const router = () =>
  new Router({
    config: parseConfig({ $schemaVersion: 1, project: { id: P, name: P }, providers: { s: { adapter: "s", location: "local" } }, routing: { extraction: { providers: ["s"] } } }),
    env: {},
    rootDir: dir,
    factories: {
      s: () =>
        defineProvider({
          manifest: { kind: "provider", name: "sentences", version: "1.0.0", location: "local", capabilities: ["complete", "json-output"] },
          async complete(req) {
            const content = req.messages[0]!.content;
            const sourceId = /source-id="([^"]+)"/.exec(content)![1]!;
            const body = content.slice(content.indexOf("\n") + 1, content.lastIndexOf("\n"));
            const items = body
              .split(/(?<=\.)\s+/)
              .filter((s) => s.trim())
              .map((s) => {
                const d = /^Decision: (.+)\.$/.exec(s);
                return d
                  ? { type: "decision", statement: s, topic: "storage", choice: d[1], evidence: [{ sourceId, quote: s }] }
                  : { type: "requirement", statement: s, evidence: [{ sourceId, quote: s }] };
              });
            return { text: JSON.stringify({ items }), model: "s", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
          },
        }),
    },
  });

async function remember(text: string, createdAt?: string): Promise<string> {
  const [o] = await store.ingest(P, [{ type: "document", text, ...(createdAt ? { createdAt } : {}) }], { actor: "t" });
  await extractSource({ store, router: router(), projectId: P, sourceId: o!.source.id, actor: "t" });
  return o!.source.id;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-lifecycle-"));
  store = await LoomStore.open({ storageDir: dir, inlineLimitBytes: 64 });
  store.ensureProject(P, "Habit");
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("A06: corrections", () => {
  it("a correction supersedes the current decision, cites its own evidence and keeps history", async () => {
    await remember("Decision: use SQLite.", "2026-10-01T00:00:00Z");
    const before = store.memory.revision(P);
    const result = await correctDecision(store, P, { topic: "storage", choice: "IndexedDB", reason: "Web build needs browser storage", actor: "lead" });
    expect(result.decision).toMatchObject({ status: "confirmed", choice: "IndexedDB", confirmedBy: expect.stringContaining("lead") });
    expect(store.memory.confirmedOnTopic(P, "storage").map((d) => d.choice)).toEqual(["IndexedDB"]);
    const history = store.memory.decisionsOnTopic(P, "storage");
    expect(history.map((d) => [d.choice, d.status])).toEqual([
      ["use SQLite", "superseded"],
      ["IndexedDB", "confirmed"],
    ]);
    const span = result.decision.spans[0]!;
    expect((await store.readSourceText(P, span.sourceId)).slice(span.start, span.end)).toBe("IndexedDB");
    expect(store.memory.revision(P)).not.toBe(before);
  });
});

describe("conflict review", () => {
  it("flags a supersession across sources for a person to accept or revert", async () => {
    await remember("Decision: use SQLite.", "2026-10-01T00:00:00Z");
    await remember("Decision: use Realm.", "2026-10-05T00:00:00Z");
    const [item] = store.memory.reviewItems(P);
    expect(item).toMatchObject({ kind: "decision-superseded" });
    expect(resolveReview(store, P, item!.id, { action: "revert" }, "lead")).toMatch(/^reverted/);
    expect(store.memory.confirmedOnTopic(P, "storage").map((d) => d.choice)).toEqual(["use SQLite"]);
    expect(store.memory.decisionsOnTopic(P, "storage").find((d) => d.choice === "use Realm")!.status).toBe("rejected");
    expect(store.memory.reviewItems(P)).toEqual([]);
  });

  it("flags possible contradictions between facts without resolving them", async () => {
    await remember("Reminders must work offline.");
    await remember("Reminders do not work offline.");
    const [item] = store.memory.reviewItems(P);
    expect(item!.kind).toBe("possible-contradiction");
    expect(store.memory.listFacts(P)).toHaveLength(2);
    const keep = item!.recordIds.find((id) => store.memory.getFact(P, id)!.statement.includes("must"))!;
    resolveReview(store, P, item!.id, { action: "keep", recordId: keep }, "lead");
    expect(store.memory.listFacts(P).map((f) => f.statement)).toEqual(["Reminders must work offline."]);
  });

  it("contradiction heuristic needs similar wording and exactly one negation", () => {
    expect(looksContradictory("The app supports offline sync.", "The app does not support offline sync.")).toBe(true);
    expect(looksContradictory("Reminders must work offline.", "Reminders never work offline.")).toBe(true);
    expect(looksContradictory("Reminders must work offline.", "Payments use Stripe.")).toBe(false);
    expect(looksContradictory("No backend in v1.", "No ads in v1.")).toBe(false);
  });
});

describe("A21: forgetting a source", () => {
  it("removes the source, derived records, index rows, rejected candidates, caches and the payload file", async () => {
    const secret = "Decision: use the confidential Falcon backend. Falcon credentials rotate weekly. Long enough to be stored as a payload file.";
    const sourceId = await remember(secret, "2026-10-01T00:00:00Z");
    const keepId = await remember("Reminders must work offline.");
    store.memory.insertRejected(P, store.memory.listRuns(P)[0]!.id, "test", { quote: "Falcon" });
    store.cache.put(P, "retrieval", "k", "Falcon cached answer");
    const payloads = async () => (await readdir(path.join(dir, "evidence"), { recursive: true })).filter((f) => f.endsWith(".txt"));
    expect(await payloads()).toHaveLength(1);

    const result = await forgetSource(store, P, sourceId, "lead");
    expect(result.deletedRecords.length).toBeGreaterThan(0);
    expect(result.payloadFileRemoved).toBe(true);
    expect(await payloads()).toHaveLength(0);
    expect(store.getSource(P, sourceId)).toBeUndefined();
    expect(store.memory.listFacts(P, { includeInactive: true }).map((f) => f.statement)).toEqual(["Reminders must work offline."]);
    expect(store.memory.listDecisions(P, { includeInactive: true })).toEqual([]);
    expect(store.memory.listRejected(P)).toEqual([]);
    expect(store.memory.search(P, '"falcon"', 10)).toEqual([]);
    expect(store.cache.stats(P)).toEqual([]);
    expect(store.getSource(P, keepId)).toBeDefined();
    expect(store.auditEvents(P).at(-1)).toMatchObject({ operation: "memory.forget" });
    expect(JSON.stringify(store.auditEvents(P))).not.toContain("Falcon");
    expect(result.removedText.some((t) => t.includes("Falcon"))).toBe(true);

    // The database file itself (after VACUUM) no longer contains the text.
    store.close();
    const raw = await readFile(path.join(dir, DATABASE_FILENAME));
    expect(raw.includes(Buffer.from("Falcon"))).toBe(false);
    store = await LoomStore.open({ storageDir: dir });
  });

  it("restores the previous decision when the superseding one is forgotten", async () => {
    await remember("Decision: use SQLite.", "2026-10-01T00:00:00Z");
    const newer = await remember("Decision: use Realm.", "2026-10-05T00:00:00Z");
    await forgetSource(store, P, newer, "lead");
    expect(store.memory.confirmedOnTopic(P, "storage").map((d) => d.choice)).toEqual(["use SQLite"]);
  });

  it("keeps a record that also cites another source, minus the forgotten span", async () => {
    const a = await remember("Shared requirement.");
    const [b] = await store.ingest(P, [{ type: "document", text: "Copy: Shared requirement." }], { actor: "t" });
    const fact = store.memory.listFacts(P)[0]!;
    store.memory.replaceSpans(P, fact.id, [...fact.spans, { sourceId: b!.source.id, start: 6, end: 25 }]);
    const result = await forgetSource(store, P, a, "lead");
    expect(result.updatedRecords).toEqual([fact.id]);
    expect(store.memory.getFact(P, fact.id)!.spans.map((s) => s.sourceId)).toEqual([b!.source.id]);
  });
});

describe("export, import and retention", () => {
  it("round-trips memory and acceptance state into an empty store with the same IDs", async () => {
    await remember("Decision: use SQLite.", "2026-10-01T00:00:00Z");
    await remember("Decision: use Realm.", "2026-10-05T00:00:00Z");
    store.state.set(P, "build.revision", "r9");
    const data = await exportProject(store, P, "Habit");
    expect(data.format).toBe("loom-export/1");

    const other = await LoomStore.open({ storageDir: path.join(dir, "copy") });
    try {
      other.ensureProject(P, "Habit");
      const counts = await importProject(other, P, JSON.parse(JSON.stringify(data)), "lead");
      expect(counts).toMatchObject({ sources: 2, decisions: 2 });
      expect(other.memory.listDecisions(P, { includeInactive: true }).map((d) => [d.id, d.status])).toEqual(
        store.memory.listDecisions(P, { includeInactive: true }).map((d) => [d.id, d.status]),
      );
      expect(other.state.get(P, "build.revision")).toBe("r9");
      await expect(importProject(other, P, data, "lead")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
      await expect(importProject(other, "other", data, "lead")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      other.close();
    }
  });

  it("lists sources past the retention period", async () => {
    const id = await remember("Old note.");
    expect(sourcesPastRetention(store, P, 30)).toEqual([]);
    expect(sourcesPastRetention(store, P, 30, Date.now() + 31 * 86_400_000)).toEqual([id]);
  });
});
