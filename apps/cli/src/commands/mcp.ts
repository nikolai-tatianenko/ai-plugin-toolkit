import { loadBuiltinPack, loadPackFile } from "@ai-plugin-toolkit/acceptance";
import { getChecklist } from "@ai-plugin-toolkit/workspace";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveProjectPath } from "@ai-plugin-toolkit/core";
import { createLoomMcpServer } from "@ai-plugin-toolkit/interface-mcp";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { loadConfigFile } from "../config-file.js";
import { withProject } from "../context.js";
import type { CommandResult } from "../io.js";

/**
 * `loom mcp`: stdio MCP server for one project. stdout carries the protocol, so this
 * command prints nothing itself; diagnostics go to stderr. It returns when the client
 * closes the connection.
 */
export async function mcpCommand(options: { rootDir: string; env: Readonly<Record<string, string | undefined>>; stderr: (t: string) => void }): Promise<CommandResult> {
  // Make sure the database exists and is migrated before opening it read-only.
  const { packs, adapterFactory, loaded } = await withProject(options.rootDir, options, async (ctx) => ({
    packs: await ctx.activePacks(),
    adapterFactory: ctx.loaded.config.tasks === undefined ? undefined : () => ctx.taskAdapter(),
    loaded: ctx.loaded,
  }));
  const config = (await loadConfigFile(options.rootDir)).config;
  const readStore = await LoomStore.open({ storageDir: loaded.storageDir, readOnly: true });
  const actor = `mcp:${options.env.LOOM_ACTOR ?? options.env.USER ?? "client"}`;
  const server = createLoomMcpServer({
    projectId: config.project.id,
    projectName: config.project.name,
    config,
    readStore,
    openWriteStore: () => LoomStore.open({ storageDir: loaded.storageDir }),
    loadPacks: async () => Promise.all(readStore.acceptance.activePacks(config.project.id).map(p =>
      p.source === "builtin" ? loadBuiltinPack(p.packId) : p.source === "workspace" ? getChecklist(readStore, config.project.id, p.packId).value.pack : loadPackFile(resolveProjectPath(loaded.rootDir, p.source, "pack file")))),
    artifactsDir: resolveProjectPath(loaded.rootDir, config.artifacts.dir, "artifacts.dir"),
    ...(adapterFactory === undefined ? {} : { taskAdapter: adapterFactory }),
    actor,
  });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
  });
  await server.connect(transport);
  options.stderr(`loom mcp: serving project "${config.project.id}" over stdio (writes ${config.mcp.allowWrites ? "enabled" : "disabled"})\n`);
  await closed;
  readStore.close();
  return { data: {}, lines: [] };
}
