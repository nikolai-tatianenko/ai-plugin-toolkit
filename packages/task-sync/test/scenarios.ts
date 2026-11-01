import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { activatePack, answerQuestion, evaluatePack, loadBuiltinPack, parsePack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { LoomError, requireTaskCapability, type ExternalTask, type TaskAdapter } from "@ai-plugin-toolkit/core";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { applySync, previewSync } from "../src/index.js";

/**
 * Sync scenarios shared by every task adapter. Run against the in-memory reference
 * adapter they check sync-core logic only; run against a real upstream (e.g. Beads)
 * they are the integration evidence for that adapter.
 */
export interface AdapterHarness {
  adapter: TaskAdapter;
  /** Simulate a person editing the remote task outside Loom. */
  editRemote(externalId: string, title: string): Promise<void>;
  /** Number of remote write operations so far (create/update/link), if observable. */
  writes(): number;
  cleanup(): Promise<void>;
}

export function syncScenarios(makeHarness: (workDir: string) => Promise<AdapterHarness>): void {
  let dir: string;
  let store: LoomStore;
  let pack: TopicPack;
  let h: AdapterHarness;
  const P = "habit";
  const evaluations = () => [evaluatePack(store, P, pack)];
  const sync = (adapter: TaskAdapter = h.adapter, extra: Partial<Parameters<typeof applySync>[4]> = {}) =>
    applySync(store, P, adapter, evaluations(), { allowWrites: true, actor: "tester", ...extra });
  const remoteTasks = async () => (await requireTaskCapability(h.adapter, "readTasks")()).filter((t) => t.idempotencyKey?.startsWith(`loom:${P}:`));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "loom-sync-"));
    store = await LoomStore.open({ storageDir: path.join(dir, ".loom") });
    store.ensureProject(P, "Habit");
    pack = await loadBuiltinPack("mobile-release");
    activatePack(store, P, pack, "t");
    const answers: Array<[string, string]> = [
      ["platforms", "android"], ["accounts", "no"], ["purchases", "yes"], ["ads", "no"], ["children", "no"],
      ["personal-data", "no"], ["remote-data", "no"], ["offline", "no"], ["notifications", "no"],
    ];
    for (const [question, value] of answers) answerQuestion(store, P, pack, { question, value, actor: "pat" });
    h = await makeHarness(dir);
  });
  afterEach(async () => {
    store.close();
    await h.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("A14: preview makes no external writes and no local writes", async () => {
    const auditBefore = store.auditEvents(P).length;
    const preview = await previewSync(store, P, h.adapter, evaluations());
    expect(preview.counts.create).toBeGreaterThan(3);
    expect(preview.counts.link).toBeGreaterThan(0);
    expect(h.writes()).toBe(0);
    expect(await remoteTasks()).toEqual([]);
    expect(store.tasks.list(P)).toEqual([]);
    expect(store.auditEvents(P).length).toBe(auditBefore);
  });

  it("publishing requires explicit project policy", async () => {
    await expect(sync(h.adapter, { allowWrites: false })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    expect(h.writes()).toBe(0);
  });

  it("A15: publishing twice keeps external IDs and task counts stable", async () => {
    const first = await sync();
    expect(first.status).toBe("ok");
    const created = first.applied.filter((c) => c.kind === "create").length;
    const remote1 = await remoteTasks();
    expect(remote1).toHaveLength(created);
    const ids1 = store.tasks.mappings(P, h.adapter.manifest.name).map((m) => [m.taskId, m.externalId]);

    const second = await sync();
    expect(second.status).toBe("ok");
    expect(second.applied).toEqual([]);
    expect(second.counts).toEqual({ unchanged: created });
    expect((await remoteTasks()).map((t) => t.externalId).sort()).toEqual(remote1.map((t) => t.externalId).sort());
    expect(store.tasks.mappings(P, h.adapter.manifest.name).map((m) => [m.taskId, m.externalId])).toEqual(ids1);
  });

  it("links dependencies once (restore depends on the purchase flow)", async () => {
    await sync();
    const mapping = (key: string) => store.tasks.mappings(P, h.adapter.manifest.name).find((m) => store.tasks.get(P, m.taskId)!.origin.endsWith(key))!;
    const restore = mapping("purchases.restore");
    const flow = mapping("purchases.flow");
    expect(restore.linkedDeps).toEqual([flow.externalId]);
    const remote = (await remoteTasks()).find((t) => t.externalId === restore.externalId)!;
    expect(remote.dependsOn).toContain(flow.externalId);
    expect((await previewSync(store, P, h.adapter, evaluations())).counts.link).toBeUndefined();
  });

  it("A16: a manually edited remote task is reported and never overwritten", async () => {
    await sync();
    const target = store.tasks.mappings(P, h.adapter.manifest.name)[0]!;
    await h.editRemote(target.externalId, "Edited by a person");
    const preview = await previewSync(store, P, h.adapter, evaluations());
    expect(preview.changes.find((c) => c.externalId === target.externalId)).toMatchObject({ kind: "remote-edited" });

    // A local change to the same task (new pack wording) is now a conflict; the remote edit survives,
    // while untouched tasks are updated normally.
    pack = parsePack({ ...pack, version: "0.1.1", criteria: pack.criteria.map((c) => ({ ...c, task: { ...c.task, title: `${c.task.title} (v2)` } })) });
    const preview2 = await previewSync(store, P, h.adapter, evaluations());
    expect(preview2.changes.find((c) => c.externalId === target.externalId)).toMatchObject({ kind: "conflict" });
    const result = await sync();
    expect(result.failures).toEqual([]);
    const remote = await remoteTasks();
    expect(remote.find((t) => t.externalId === target.externalId)!.title).toBe("Edited by a person");
    expect(remote.filter((t) => t.externalId !== target.externalId).every((t) => t.title.endsWith("(v2)"))).toBe(true);
    expect(result.applied.filter((c) => c.kind === "update")).toHaveLength(remote.length - 1);
  });

  it("A17: a crash after some external creates is reconciled without duplicates", async () => {
    let creates = 0;
    const crash = await sync(h.adapter, {
      afterRemoteCreate: () => {
        if (++creates === 3) throw new Error("simulated crash after remote create, before the mapping was saved");
      },
    }).catch((e: unknown) => e);
    // The simulated crash surfaces as a failure of that one change; earlier creates are mapped.
    const partial = crash as Awaited<ReturnType<typeof sync>>;
    expect(partial.status).toBe("partial");
    expect(store.tasks.pendingIntents(P, h.adapter.manifest.name)).toHaveLength(1);

    const retry = await sync();
    expect(retry.applied.filter((c) => c.kind === "adopt")).toHaveLength(1);
    expect(store.tasks.pendingIntents(P, h.adapter.manifest.name)).toEqual([]);
    const remote = await remoteTasks();
    const keys = remote.map((t) => t.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(remote).toHaveLength(store.tasks.list(P).length);
  });

  it("A22: an operation the adapter does not declare fails explicitly", async () => {
    const limited: TaskAdapter = { manifest: { ...h.adapter.manifest, capabilities: h.adapter.manifest.capabilities.filter((c) => c !== "linkDependency") } };
    for (const c of limited.manifest.capabilities) (limited as Record<string, unknown>)[c] = (h.adapter as unknown as Record<string, (...a: unknown[]) => unknown>)[c]!.bind(h.adapter);
    const result = await sync(limited);
    expect(result.status).toBe("partial");
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.every((f) => f.code === "UNSUPPORTED_CAPABILITY")).toBe(true);
    expect(() => requireTaskCapability(limited, "linkDependency")).toThrow(LoomError);
  });

  it("does not close or change remote status, and reads status back", async () => {
    await sync();
    for (const t of await remoteTasks()) expect(t.status).toBe("open");
    expect(store.tasks.list(P).every((t) => t.status === "open")).toBe(true);
  });
}

/** Re-export for adapters that need the remote shape in assertions. */
export type { ExternalTask };
