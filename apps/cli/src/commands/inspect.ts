import { startInspector } from "@ai-plugin-toolkit/inspector";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { withProject } from "../context.js";
import type { CommandResult } from "../io.js";

/** `loom inspect`: read-only local web inspector; runs until interrupted (Ctrl+C). */
export async function inspectCommand(options: {
  rootDir: string;
  env: Readonly<Record<string, string | undefined>>;
  port: number;
  stdout: (t: string) => void;
}): Promise<CommandResult> {
  const prepared = await withProject(options.rootDir, options, async (ctx) => ({
    packs: await ctx.activePacks(),
    storageDir: ctx.loaded.storageDir,
    projectId: ctx.projectId,
    projectName: ctx.loaded.config.project.name,
    adapter: ctx.loaded.config.tasks === undefined ? undefined : ctx.taskAdapter(),
  }));
  const store = await LoomStore.open({ storageDir: prepared.storageDir, readOnly: true });
  const running = await startInspector({
    store,
    projectId: prepared.projectId,
    projectName: prepared.projectName,
    loadPacks: async () => prepared.packs,
    ...(prepared.adapter === undefined ? {} : { taskAdapter: () => prepared.adapter! }),
    port: options.port,
  });
  options.stdout(`Loom inspector (read-only) for "${prepared.projectId}":\n  ${running.url}\nOpen the URL above; the token in it is required. Press Ctrl+C to stop.\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await running.close();
  store.close();
  return { data: {}, lines: ["Inspector stopped."] };
}
