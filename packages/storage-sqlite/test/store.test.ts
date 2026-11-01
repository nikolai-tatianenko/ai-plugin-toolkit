import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomError, type SourceInput } from "@ai-plugin-toolkit/core";
import { DATABASE_FILENAME, LoomStore, MIGRATIONS, resolveEvidencePath, type Migration } from "../src/index.js";

let dir: string;
const open = (extra: Partial<Parameters<typeof LoomStore.open>[0]> = {}) => LoomStore.open({ storageDir: dir, ...extra });
const doc = (text: string, extra: Partial<SourceInput> = {}): SourceInput => ({ type: "document", text, ...extra });
const actor = { actor: "test" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof LoomError ? error.code : "NOT_LOOM";
  }
  return undefined;
}

describe("migrations", () => {
  it("applies all migrations once and is idempotent on reopen", async () => {
    using first = await open();
    expect(first.schemaVersion()).toBe(MIGRATIONS.length);
    first.close();
    using second = await open();
    expect(second.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it("rolls back a failing migration and leaves the database usable at the previous version", async () => {
    {
      using store = await open();
      store.ensureProject("demo", "Demo");
      await store.ingest("demo", [doc("kept")], actor);
    }
    const broken: Migration[] = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, name: "broken", sql: "CREATE TABLE half_done (x TEXT); SELECT * FROM no_such_table;" },
    ];
    await expect(open({ migrations: broken })).rejects.toThrow(new RegExp(`rolled back; database remains at version ${MIGRATIONS.length}`));

    const raw = new DatabaseSync(path.join(dir, DATABASE_FILENAME));
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
    raw.close();

    using recovered = await open();
    expect(recovered.schemaVersion()).toBe(MIGRATIONS.length);
    expect(recovered.countSources("demo")).toBe(1);
  });

  it("refuses a database from a newer build without modifying it", async () => {
    (await open()).close();
    const raw = new DatabaseSync(path.join(dir, DATABASE_FILENAME));
    raw.prepare("INSERT INTO schema_migrations VALUES (99, 'future', '2030-01-01T00:00:00Z')").run();
    raw.close();
    await expect(open()).rejects.toThrow(/newer than this build supports/);
  });
});

describe("ingest", () => {
  it("A01: identical input twice yields stable IDs and no duplicates", async () => {
    using store = await open();
    store.ensureProject("demo", "Demo");
    const first = await store.ingest("demo", [doc("alpha"), doc("beta")], actor);
    const second = await store.ingest("demo", [doc("alpha", { title: "renamed" }), doc("beta")], actor);
    expect(first.map((o) => o.status)).toEqual(["created", "created"]);
    expect(second.map((o) => o.status)).toEqual(["existing", "existing"]);
    expect(second.map((o) => o.source.id)).toEqual(first.map((o) => o.source.id));
    expect(store.countSources("demo")).toBe(2);
  });

  it("deduplicates identical content within one batch", async () => {
    using store = await open();
    store.ensureProject("demo", "Demo");
    const outcomes = await store.ingest("demo", [doc("same"), doc("same")], actor);
    expect(outcomes.map((o) => o.status)).toEqual(["created", "existing"]);
    expect(store.countSources("demo")).toBe(1);
  });

  it("malformed input anywhere in a batch writes nothing and records a failed audit event", async () => {
    using store = await open();
    store.ensureProject("demo", "Demo");
    const bad = [doc("good one"), { type: "document", text: "" } as SourceInput, doc("good two")];
    expect(await codeOf(store.ingest("demo", bad, actor))).toBe("VALIDATION_FAILED");
    expect(store.countSources("demo")).toBe(0);
    expect(store.auditEvents("demo")).toEqual([
      { operation: "sources.ingest", result: "error", errorCode: "VALIDATION_FAILED", changedIds: [] },
    ]);
  });

  it("a failure inside the transaction rolls back every row of the batch", async () => {
    let inserts = 0;
    using store = await open({
      onInsert: () => {
        if (++inserts === 2) throw new Error("simulated crash after first insert");
      },
    });
    store.ensureProject("demo", "Demo");
    await expect(store.ingest("demo", [doc("one"), doc("two"), doc("three")], actor)).rejects.toThrow(/simulated crash/);
    expect(store.countSources("demo")).toBe(0);
    expect(store.auditEvents("demo").at(-1)?.result).toBe("error");
  });

  it("records a successful audit event listing only newly created IDs", async () => {
    using store = await open();
    store.ensureProject("demo", "Demo");
    const [a] = await store.ingest("demo", [doc("a")], actor);
    await store.ingest("demo", [doc("a"), doc("b")], actor);
    const events = store.auditEvents("demo");
    expect(events[0]?.changedIds).toEqual([a!.source.id]);
    expect(events[1]?.changedIds).toHaveLength(1);
    expect(events[1]?.changedIds).not.toContain(a!.source.id);
  });

  it("enforces the size limit before writing", async () => {
    using store = await open({ maxSourceBytes: 10 });
    store.ensureProject("demo", "Demo");
    await expect(store.ingest("demo", [doc("x".repeat(11))], actor)).rejects.toThrow(/limit is 10/);
    expect(store.countSources("demo")).toBe(0);
  });

  it("rejects ingest into an unknown project", async () => {
    using store = await open();
    expect(await codeOf(store.ingest("ghost", [doc("x")], actor))).toBe("NOT_FOUND");
  });
});

describe("evidence files", () => {
  it("stores large payloads as content-addressed files and verifies them on read", async () => {
    using store = await open({ inlineLimitBytes: 16 });
    store.ensureProject("demo", "Demo");
    const text = "large payload ".repeat(10);
    const [outcome] = await store.ingest("demo", [doc(text)], actor);
    const source = outcome!.source;
    expect(source.content.kind).toBe("file");
    expect(await store.readSourceText("demo", source.id)).toBe(text);

    if (source.content.kind !== "file") throw new Error("unreachable");
    const filePath = resolveEvidencePath(dir, source.content.path);
    expect(await readFile(filePath, "utf8")).toBe(text);
    await writeFile(filePath, "tampered");
    await expect(store.readSourceText("demo", source.id)).rejects.toThrow(/does not match its recorded hash/);
  });

  it("A03: inline source text resolves exactly to the original material", async () => {
    using store = await open();
    store.ensureProject("demo", "Demo");
    const text = "line one\r\nline two — ünïcode\n";
    const [outcome] = await store.ingest("demo", [doc(text)], actor);
    expect(await store.readSourceText("demo", outcome!.source.id)).toBe(text);
  });

  it.each(["../loom.db", "evidence/../../x", "/etc/passwd", "evidence"])("A23: refuses evidence path %s", (p) => {
    expect(() => resolveEvidencePath(dir, p)).toThrow(LoomError);
  });
});

describe("A05: project isolation", () => {
  it("scopes IDs and reads by project", async () => {
    using store = await open();
    store.ensureProject("a", "A");
    store.ensureProject("b", "B");
    const [inA] = await store.ingest("a", [doc("shared text")], actor);
    const [inB] = await store.ingest("b", [doc("shared text")], actor);
    expect(inA!.source.id).not.toBe(inB!.source.id);
    expect(inB!.status).toBe("created");
    expect(store.getSource("b", inA!.source.id)).toBeUndefined();
    expect(await codeOf(store.readSourceText("b", inA!.source.id))).toBe("NOT_FOUND");
    expect(store.listSources("a").map((s) => s.id)).toEqual([inA!.source.id]);
  });
});
