import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "@ai-plugin-toolkit/adapter-beads";
import { createTaskMasterAdapter, mapStatus, parseTasksFile, toExternalTask } from "../src/index.js";
import { syncScenarios } from "../../task-sync/test/scenarios.js";

/**
 * Fake `task-master` that edits tasks.json the way the documented commands do. It pins
 * argument construction and file parsing; it is not evidence that the real CLI behaves
 * the same — see taskmaster.integration.test.ts.
 */
export function fakeTaskMaster(dir: string, calls: string[][] = [], version = "0.43.1"): Exec {
  const file = path.join(dir, ".taskmaster/tasks/tasks.json");
  const load = async () => JSON.parse(await readFile(file, "utf8")) as Record<string, { tasks: Array<Record<string, unknown>> }>;
  const flag = (args: readonly string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return async (_cmd, args) => {
    calls.push([...args]);
    if (args[0] === "--version") return { stdout: `${version}\n`, stderr: "", exitCode: 0 };
    if (args[0] === "init") {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ master: { tasks: [] } }));
      return { stdout: "initialized", stderr: "", exitCode: 0 };
    }
    const data = await load();
    const tasks = data[flag(args, "tag") ?? "master"]!.tasks;
    if (args[0] === "add-task") {
      if (!flag(args, "title") || !flag(args, "description")) return { stdout: "", stderr: "Either --prompt or both --title and --description must be provided", exitCode: 1 };
      const id = tasks.reduce((m, t) => Math.max(m, Number(t.id)), 0) + 1;
      tasks.push({ id, title: flag(args, "title"), description: flag(args, "description"), details: flag(args, "details") ?? "", status: "pending", dependencies: [] });
    } else if (args[0] === "add-dependency") {
      const task = tasks.find((t) => String(t.id) === flag(args, "id"))!;
      (task.dependencies as number[]).push(Number(flag(args, "depends-on")));
    } else if (args[0] === "set-status") {
      tasks.find((t) => String(t.id) === flag(args, "id"))!.status = flag(args, "status");
    } else {
      return { stdout: "", stderr: `unknown command ${args[0]}`, exitCode: 1 };
    }
    await writeFile(file, JSON.stringify(data));
    return { stdout: "ok", stderr: "", exitCode: 0 };
  };
}

describe("Task Master adapter (fake CLI)", () => {
  it("creates manually (never via --prompt), stores the idempotency key in details and reads it back", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loom-tm-"));
    const calls: string[][] = [];
    const a = createTaskMasterAdapter({ projectDir: dir, exec: fakeTaskMaster(dir, calls) });
    expect(await a.initialize()).toBe("created");
    expect(calls.find((c) => c[0] === "init")).toEqual(["init", "--yes", "--skip-install", "--no-aliases", "--no-git"]);
    const title = '-p "x"; rm -rf /';
    const t = await a.createTask({ title, description: "First line\nmore", idempotencyKey: "habit:tsk_1" });
    expect(t).toMatchObject({ externalId: "1", title, idempotencyKey: "habit:tsk_1", status: "open" });
    const add = calls.find((c) => c[0] === "add-task")!;
    expect(add).toContain(`--title=${title}`);
    expect(add).toContain("--description=First line");
    expect(add.some((x) => x.startsWith("--prompt"))).toBe(false);
    await a.createTask({ title: "Second", idempotencyKey: "habit:tsk_2" });
    await a.linkDependency("2", "1");
    expect((await a.readTasks()).find((x) => x.externalId === "2")!.dependsOn).toEqual(["1"]);
    await expect(a.linkDependency("--x", "1")).rejects.toThrow(/unexpected Task Master ID/);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not declare updateTask (no non-AI update exists upstream)", () => {
    const a = createTaskMasterAdapter({ projectDir: "/tmp", exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
    expect(a.manifest.capabilities).toEqual(["readTasks", "createTask", "linkDependency"]);
    expect("updateTask" in a).toBe(false);
  });

  it("reads tagged and legacy formats and maps statuses", () => {
    const tagged = JSON.stringify({ master: { tasks: [{ id: 3, title: "T", status: "done", details: "loom-idempotency-key: k\n\nx", dependencies: [1] }] }, other: { tasks: [] } });
    expect(parseTasksFile(tagged, "master").map(toExternalTask)[0]).toMatchObject({ externalId: "3", status: "closed", idempotencyKey: "k", dependsOn: ["1"] });
    expect(parseTasksFile(JSON.stringify({ tasks: [{ id: 1, title: "L" }] }), "master")).toHaveLength(1);
    expect(parseTasksFile(tagged, "missing")).toEqual([]);
    expect(["pending", "in-progress", "review", "done", "deferred", "cancelled"].map(mapStatus)).toEqual(["open", "in-progress", "in-progress", "closed", "open", "closed"]);
  });

  it("refuses an unreviewed version unless allowed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "loom-tm-"));
    await expect(createTaskMasterAdapter({ projectDir: dir, exec: fakeTaskMaster(dir, [], "0.50.0") }).readTasks()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(createTaskMasterAdapter({ projectDir: dir, exec: fakeTaskMaster(dir, [], "0.50.0"), allowUntestedVersion: true }).readTasks()).resolves.toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("shared sync scenarios against the fake Task Master CLI", () => {
  syncScenarios(async (workDir) => {
    const calls: string[][] = [];
    const adapter = createTaskMasterAdapter({ projectDir: workDir, exec: fakeTaskMaster(workDir, calls) });
    await adapter.initialize();
    calls.length = 0;
    return {
      adapter,
      editRemote: async (id, title) => {
        const file = path.join(workDir, ".taskmaster/tasks/tasks.json");
        const data = JSON.parse(await readFile(file, "utf8")) as { master: { tasks: Array<{ id: number; title: string }> } };
        data.master.tasks.find((t) => String(t.id) === id)!.title = title;
        await writeFile(file, JSON.stringify(data));
      },
      writes: () => calls.filter((c) => c[0] === "add-task" || c[0] === "add-dependency").length,
      cleanup: async () => {},
    };
  });
});
