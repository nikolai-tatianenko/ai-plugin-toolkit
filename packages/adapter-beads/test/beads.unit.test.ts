import { describe, expect, it } from "vitest";
import { LoomError } from "@ai-plugin-toolkit/core";
import { createBeadsAdapter, mapStatus, parseVersion, toExternalTask, type Exec } from "../src/index.js";

/**
 * Unit tests with a fake `exec`: they pin argument construction and output parsing
 * against the documented v1.3.2 shapes. They do not show that real `bd` behaves this
 * way — that is beads.integration.test.ts.
 */
interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function fake(responses: Record<string, unknown>, calls: Call[] = []): Exec {
  return async (file, args, options) => {
    calls.push({ file, args: [...args], env: options.env });
    const key = args[0] === "dep" ? "dep" : args[0]!;
    const body = responses[key];
    if (body instanceof Error) throw body;
    if (typeof body === "object" && body !== null && "exitCode" in body) return body as { stdout: string; stderr: string; exitCode: number };
    return { stdout: typeof body === "string" ? body : JSON.stringify(body), stderr: "", exitCode: 0 };
  };
}

const issue = (over: Record<string, unknown> = {}) => ({
  id: "loom-a1b2",
  title: "Verify sandbox purchases",
  description: "desc",
  status: "open",
  priority: 2,
  issue_type: "task",
  created_at: "2026-11-01T10:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
  external_ref: "loom:habit:tsk_1",
  ...over,
});
const adapter = (exec: Exec, extra = {}) => createBeadsAdapter({ beadsDir: "/proj/.beads", cwd: "/proj", exec, env: { PATH: "/usr/bin" }, ...extra });

describe("Beads adapter (fake exec)", () => {
  it("creates with literal arguments: no shell, flag values attached with '='", async () => {
    const calls: Call[] = [];
    const a = adapter(fake({ version: { version: "1.3.2" }, create: issue() }, calls));
    const title = '-p 0; rm -rf / $(whoami) `id` "quoted"';
    const task = await a.createTask({ title, description: "line 1\nline 2", idempotencyKey: "habit:tsk_1" });
    const create = calls.find((c) => c.args[0] === "create")!;
    expect(create.file).toBe("bd");
    expect(create.args).toEqual([
      "create",
      `--title=${title}`,
      "--type=task",
      "--external-ref=loom:habit:tsk_1",
      "--description=line 1\nline 2",
      "--json",
    ]);
    expect(create.env).toMatchObject({ BEADS_DIR: "/proj/.beads", BD_NON_INTERACTIVE: "1", PATH: "/usr/bin" });
    expect(task).toMatchObject({ externalId: "loom-a1b2", idempotencyKey: "habit:tsk_1", revision: "2026-11-01T10:00:00Z", status: "open" });
  });

  it("A23: refuses IDs that could be interpreted as flags or paths", async () => {
    const a = adapter(fake({ version: { version: "1.3.2" } }));
    await expect(a.linkDependency("--force", "loom-1")).rejects.toThrow(/unexpected Beads issue ID/);
    await expect(a.updateTask("../x", { title: "t" }, "r")).rejects.toThrow(/unexpected Beads issue ID/);
  });

  it("reads tasks, mapping status, dependencies and only loom-owned idempotency keys", async () => {
    const a = adapter(
      fake({
        version: "bd version 1.3.2 (release: main@abc123)",
        list: [
          issue({ dependencies: [{ issue_id: "loom-a1b2", depends_on_id: "loom-c3d4", type: "blocks" }, { depends_on_id: "loom-e5", type: "related" }] }),
          issue({ id: "loom-c3d4", status: "in_progress", external_ref: "jira-ABC" }),
          issue({ id: "loom-e5", status: "closed", external_ref: null }),
        ],
      }),
    );
    const tasks = await a.readTasks();
    expect(tasks.map((t) => [t.externalId, t.status, t.idempotencyKey, t.dependsOn])).toEqual([
      ["loom-a1b2", "open", "habit:tsk_1", ["loom-c3d4"]],
      ["loom-c3d4", "in-progress", undefined, undefined],
      ["loom-e5", "closed", undefined, undefined],
    ]);
  });

  it("update checks updated_at first and reports a conflict instead of overwriting", async () => {
    const calls: Call[] = [];
    const a = adapter(fake({ version: { version: "1.3.2" }, show: [issue({ updated_at: "2026-11-01T12:00:00Z" })] }, calls));
    const error = (await a.updateTask("loom-a1b2", { title: "new" }, "2026-11-01T10:00:00Z").catch((e: unknown) => e)) as LoomError;
    expect(error.code).toBe("CONFLICT");
    expect(calls.some((c) => c.args[0] === "update")).toBe(false);
  });

  it("never changes status (Beads owns it)", async () => {
    const a = adapter(fake({ version: { version: "1.3.2" } }));
    await expect(a.updateTask("loom-a1b2", { status: "closed" }, "r")).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  it("refuses versions outside the reviewed line unless explicitly allowed", async () => {
    await expect(adapter(fake({ version: { version: "2.0.0" } })).readTasks()).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    const allowed = adapter(fake({ version: { version: "1.4.0" }, list: [] }), { allowUntestedVersion: true });
    await expect(allowed.readTasks()).resolves.toEqual([]);
  });

  it("explains a missing bd binary and surfaces failures with exit codes", async () => {
    const enoent = Object.assign(new Error("spawn bd ENOENT"), { code: "ENOENT" });
    await expect(adapter(fake({ version: enoent })).readTasks()).rejects.toThrow(/Beads CLI "bd" was not found/);
    const failing = adapter(fake({ version: { version: "1.3.2" }, list: { stdout: "", stderr: "database locked", exitCode: 1 } }));
    await expect(failing.readTasks()).rejects.toMatchObject({ code: "EXTERNAL_TOOL_FAILED", message: expect.stringContaining("database locked") });
    const garbage = adapter(fake({ version: { version: "1.3.2" }, list: "not json" }));
    await expect(garbage.readTasks()).rejects.toThrow(/did not return JSON/);
  });

  it("parses both version output forms and maps statuses", () => {
    expect(parseVersion('{"version":"1.3.2","build":"release"}')).toBe("1.3.2");
    expect(parseVersion("bd version 1.3.2 (release: main@abc)\n")).toBe("1.3.2");
    expect(["open", "blocked", "deferred", "in_progress", "hooked", "closed"].map(mapStatus)).toEqual(["open", "open", "open", "in-progress", "in-progress", "closed"]);
    expect(toExternalTask(issue({ description: "" })).description).toBeUndefined();
  });
});
