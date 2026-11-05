import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activatePack, answerQuestion, evaluatePack, loadBuiltinPack, parsePack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { applySync, previewSync, pullRemote, remoteConflicts, resolveRemoteEdit } from "../src/index.js";

import { LoomError, defineTaskAdapter, type ExternalTask, type TaskAdapter, type TaskDraft } from "@ai-plugin-toolkit/core";
import { syncScenarios, type AdapterHarness } from "./scenarios.js";

/**
 * In-memory reference adapter. It checks sync-core behaviour (previews, mappings,
 * retries, conflicts). It is NOT a real task system and proves nothing about upstream
 * compatibility — the same scenarios run against real Beads in adapter-beads.
 */
class MemoryTasks implements TaskAdapter {
  readonly manifest = {
    kind: "task-adapter" as const,
    name: "memory",
    version: "1.0.0",
    upstream: { name: "in-memory reference", versionRange: "n/a" },
    capabilities: ["readTasks", "createTask", "updateTask", "linkDependency"] as Array<"readTasks" | "createTask" | "updateTask" | "linkDependency">,
  };
  tasks = new Map<string, ExternalTask>();
  writes = 0;
  private seq = 0;
  private rev = 0;

  async readTasks(): Promise<ExternalTask[]> {
    return [...this.tasks.values()].map((t) => structuredClone(t));
  }
  async createTask(draft: TaskDraft): Promise<ExternalTask> {
    this.writes++;
    const task: ExternalTask = {
      externalId: `mem-${++this.seq}`,
      title: draft.title,
      ...(draft.description === undefined ? {} : { description: draft.description }),
      status: "open",
      revision: `r${++this.rev}`,
      idempotencyKey: draft.idempotencyKey,
    };
    this.tasks.set(task.externalId, task);
    return structuredClone(task);
  }
  async updateTask(id: string, patch: Partial<Pick<ExternalTask, "title" | "description">>, expected: string): Promise<ExternalTask> {
    const task = this.tasks.get(id);
    if (task === undefined) throw new LoomError("NOT_FOUND", id);
    if (task.revision !== expected) throw new LoomError("CONFLICT", `${id} changed`);
    this.writes++;
    Object.assign(task, patch, { revision: `r${++this.rev}` });
    return structuredClone(task);
  }
  async linkDependency(id: string, dependsOn: string): Promise<void> {
    const task = this.tasks.get(id)!;
    this.writes++;
    task.dependsOn = [...new Set([...(task.dependsOn ?? []), dependsOn])];
    task.revision = `r${++this.rev}`;
  }
  edit(id: string, title: string): void {
    const task = this.tasks.get(id)!;
    task.title = title;
    task.revision = `r${++this.rev}`;
  }
}

describe("task sync core (in-memory reference adapter)", () => {
  syncScenarios(async (): Promise<AdapterHarness> => {
    const memory = defineTaskAdapter(new MemoryTasks());
    return {
      adapter: memory,
      editRemote: async (id, title) => memory.edit(id, title),
      writes: () => memory.writes,
      cleanup: async () => {},
    };
  });
});

describe("two-way reconciliation (CL-019, reference adapter)", () => {
  let dir: string;
  let store: LoomStore;
  let pack: TopicPack;
  let memory: MemoryTasks;
  const P = "habit";
  const evals = () => [evaluatePack(store, P, pack)];
  const sync = () => applySync(store, P, memory, evals(), { allowWrites: true, actor: "t" });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "loom-twoway-"));
    store = await LoomStore.open({ storageDir: dir });
    store.ensureProject(P, "Habit");
    pack = await loadBuiltinPack("mobile-release");
    activatePack(store, P, pack, "t");
    for (const [q, v] of [["platforms", "android"], ["accounts", "no"], ["purchases", "no"], ["ads", "no"], ["children", "no"], ["personal-data", "no"], ["remote-data", "no"], ["offline", "no"], ["notifications", "no"]] as const) {
      answerQuestion(store, P, pack, { question: q, value: v, actor: "pat" });
    }
    memory = defineTaskAdapter(new MemoryTasks());
    await sync();
  });
  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("pulls status directly and records content edits for resolution without overwriting either side", async () => {
    const [a, b] = store.tasks.mappings(P, "memory");
    memory.tasks.get(a!.externalId)!.status = "closed";
    memory.tasks.get(a!.externalId)!.revision = "manual-1";
    memory.edit(b!.externalId, "Edited in the tracker");
    const pulled = await pullRemote(store, P, memory, "t");
    expect(pulled.statusChanged).toEqual([{ taskId: a!.taskId, from: "open", to: "closed" }]);
    expect(pulled.edited.map((e) => e.taskId)).toEqual([b!.taskId]);
    expect(store.tasks.get(P, b!.taskId)!.title).not.toBe("Edited in the tracker");
    expect(remoteConflicts(store, P).map((t) => t.id)).toEqual([b!.taskId]);
    expect((await pullRemote(store, P, memory, "t")).edited).toHaveLength(1);
  });

  it("keep-remote stops updates; a later plan change becomes a conflict, not an overwrite", async () => {
    const [m] = store.tasks.mappings(P, "memory");
    memory.edit(m!.externalId, "Tracker wording");
    await pullRemote(store, P, memory, "t");
    await resolveRemoteEdit(store, P, memory, { taskId: m!.taskId, keep: "remote", actor: "lead", allowWrites: false });
    expect(remoteConflicts(store, P)).toEqual([]);
    expect((await previewSync(store, P, memory, evals())).changes.find((c) => c.taskId === m!.taskId)!.kind).toBe("unchanged");

    pack = parsePack({ ...pack, version: "9.0.0", criteria: pack.criteria.map((c) => ({ ...c, task: { ...c.task, title: `${c.task.title}!` } })) });
    const result = await sync();
    expect(result.changes.find((c) => c.taskId === m!.taskId)!.kind).toBe("conflict");
    expect(memory.tasks.get(m!.externalId)!.title).toBe("Tracker wording");
  });

  it("keep-local publishes the plan over the edit only with write permission", async () => {
    const [m] = store.tasks.mappings(P, "memory");
    memory.edit(m!.externalId, "Tracker wording");
    await pullRemote(store, P, memory, "t");
    await expect(resolveRemoteEdit(store, P, memory, { taskId: m!.taskId, keep: "local", actor: "lead", allowWrites: false })).rejects.toMatchObject({ code: "POLICY_VIOLATION" });
    await resolveRemoteEdit(store, P, memory, { taskId: m!.taskId, keep: "local", actor: "lead", allowWrites: true });
    expect(memory.tasks.get(m!.externalId)!.title).toBe(store.tasks.get(P, m!.taskId)!.title);
    expect((await previewSync(store, P, memory, evals())).changes.find((c) => c.taskId === m!.taskId)!.kind).toBe("unchanged");
  });

  it("refuses a concurrent sync while another holds the lock", async () => {
    expect(store.tasks.acquireLock(P, "sync.memory", "other-process", 60_000)).toBe(true);
    await expect(sync()).rejects.toMatchObject({ code: "CONFLICT" });
    store.tasks.releaseLock(P, "sync.memory", "other-process");
    await expect(sync()).resolves.toMatchObject({ status: "ok" });
  });
});
