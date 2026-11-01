import { describe } from "vitest";
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
