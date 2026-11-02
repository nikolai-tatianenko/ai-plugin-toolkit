import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { createTaskMasterAdapter, SUPPORTED_TASKMASTER } from "../src/index.js";
import { syncScenarios } from "../../task-sync/test/scenarios.js";

/** Real integration against an installed `task-master` 0.43.x. Skipped, with the reason, otherwise. */
function locate(): { bin: string } | { skip: string } {
  const bin = process.env.LOOM_TASKMASTER_BIN ?? "task-master";
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    const [major, minor] = (/(\d+)\.(\d+)\.\d+/.exec(out) ?? []).slice(1).map(Number);
    if (major !== SUPPORTED_TASKMASTER.major || minor !== SUPPORTED_TASKMASTER.minor) return { skip: `task-master ${out.trim()} found; this suite targets ${SUPPORTED_TASKMASTER.label}` };
    return { bin };
  } catch {
    return { skip: `"${bin}" is not runnable (set LOOM_TASKMASTER_BIN or install task-master-ai ${SUPPORTED_TASKMASTER.label})` };
  }
}

const found = locate();
if ("skip" in found) {
  describe("Task Master adapter against real task-master", () => {
    it.skip(`SKIPPED — real Task Master integration not run: ${found.skip}`, () => {});
  });
} else {
  describe("Task Master adapter against real task-master", () => {
    syncScenarios(async (workDir) => {
      let writes = 0;
      const adapter = createTaskMasterAdapter({
        command: found.bin,
        projectDir: workDir,
        exec: async (file, args, options) => {
          if (["add-task", "add-dependency"].includes(args[0] ?? "")) writes++;
          const { nodeExec } = await import("@ai-plugin-toolkit/adapter-beads");
          return nodeExec(file, args, options);
        },
      });
      await adapter.initialize();
      writes = 0;
      return {
        adapter,
        editRemote: async (id, title) => {
          const file = path.join(workDir, ".taskmaster/tasks/tasks.json");
          const data = JSON.parse(await readFile(file, "utf8")) as Record<string, { tasks: Array<{ id: number; title: string }> }>;
          data.master!.tasks.find((t) => String(t.id) === id)!.title = title;
          await writeFile(file, JSON.stringify(data, null, 2));
        },
        writes: () => writes,
        cleanup: async () => {},
      };
    });
  });
}
