import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type LoomConfig } from "@ai-plugin-toolkit/core";
import { HASHING_MODEL, hashingVector } from "@ai-plugin-toolkit/router";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { cachedContext, cachedSearch, ensureEmbeddings, hybridSearch, permissionsRevision } from "../src/index.js";

let dir: string;
let store: LoomStore;
const config = (sensitivity: "standard" | "restricted" = "standard"): LoomConfig => parseConfig({ $schemaVersion: 1, project: { id: "alpha", name: "A", sensitivity } });

let seq = 0;
async function fact(projectId: string, statement: string): Promise<string> {
  store.ensureProject(projectId, projectId);
  const [o] = await store.ingest(projectId, [{ type: "document", text: statement }], { actor: "t" });
  const run = store.memory.startRun({ projectId, sourceId: o!.source.id, promptVersion: "t" });
  const id = `fct_${String(++seq).padStart(26, "0")}`;
  store.memory.insertFact({ id, projectId, statement, kind: "requirement", spans: [{ sourceId: o!.source.id, start: 0, end: statement.length }], status: "candidate", createdAt: new Date().toISOString() }, run);
  return id;
}

let embedCalls = 0;
const embedder = { model: HASHING_MODEL, embed: async (texts: readonly string[]) => ((embedCalls += texts.length), { vectors: texts.map((t) => hashingVector(t)), model: HASHING_MODEL }) };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-cache-"));
  store = await LoomStore.open({ storageDir: dir });
  embedCalls = 0;
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("retrieval cache", () => {
  it("hits on repeat and is invalidated by a memory change before reuse (A24)", async () => {
    await fact("alpha", "Reminders work offline.");
    const perms = permissionsRevision(config());
    expect(cachedSearch(store, "alpha", "offline", {}, perms).cache).toBe("miss");
    expect(cachedSearch(store, "alpha", "offline", {}, perms).cache).toBe("hit");
    await fact("alpha", "Offline sync is required.");
    const after = cachedSearch(store, "alpha", "offline", {}, perms);
    expect(after.cache).toBe("miss");
    expect(after.value.filter((h) => h.kind === "fact")).toHaveLength(2);
  });

  it("is invalidated by a permission change (A24)", async () => {
    await fact("alpha", "Reminders work offline.");
    cachedSearch(store, "alpha", "offline", {}, permissionsRevision(config()));
    expect(cachedSearch(store, "alpha", "offline", {}, permissionsRevision(config("restricted"))).cache).toBe("miss");
    expect(store.cache.stats("alpha").find((s) => s.namespace === "retrieval")!.entries).toBe(1);
  });

  it("A05: never returns another project's cached results", async () => {
    await fact("alpha", "Alpha uses Stripe.");
    await fact("beta", "Beta uses Stripe live keys.");
    const perms = "same";
    const a = cachedSearch(store, "alpha", "stripe", {}, perms);
    const b = cachedSearch(store, "beta", "stripe", {}, perms);
    expect(b.cache).toBe("miss");
    expect(JSON.stringify(a.value)).not.toContain("live keys");
    expect(JSON.stringify(b.value)).toContain("live keys");
  });

  it("caches assembled context under the same rules", async () => {
    await fact("alpha", "Reminders work offline.");
    expect((await cachedContext(store, "alpha", "offline", { maxChars: 500 }, "p")).cache).toBe("miss");
    expect((await cachedContext(store, "alpha", "offline", { maxChars: 500 }, "p")).cache).toBe("hit");
    expect((await cachedContext(store, "alpha", "offline", { maxChars: 600 }, "p")).cache).toBe("miss");
  });
});

describe("embeddings", () => {
  it("embeds each record once per content hash and model", async () => {
    await fact("alpha", "Reminders work offline.");
    await fact("alpha", "Accessibility uses Dynamic Type.");
    expect(await ensureEmbeddings(store, "alpha", embedder.embed, embedder.model)).toEqual({ embedded: 2, reused: 0 });
    expect(await ensureEmbeddings(store, "alpha", embedder.embed, embedder.model)).toEqual({ embedded: 0, reused: 2 });
    await fact("alpha", "New requirement.");
    expect(await ensureEmbeddings(store, "alpha", embedder.embed, embedder.model)).toEqual({ embedded: 1, reused: 2 });
    expect(embedCalls).toBe(3);
  });

  it("hybrid search fuses lexical and vector ranks within the project only", async () => {
    await fact("alpha", "Reminders must work without network access.");
    await fact("alpha", "Accessibility uses Dynamic Type.");
    await fact("beta", "Reminders must work without network access in beta.");
    const hits = await hybridSearch(store, "alpha", "reminders network", embedder);
    expect(hits[0]!.text).toBe("Reminders must work without network access.");
    expect(hits[0]!.semantic).toBeGreaterThan(0);
    expect(hits.every((h) => !h.text.includes("beta"))).toBe(true);
  });
});
