import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { handleHook } from "@ai-plugin-toolkit/hooks";
import { redactString } from "@ai-plugin-toolkit/core";
import { withProject } from "./context.js";
import { withUserStore } from "./commands/workspace.js";
import { findProjectRoot } from "./config-file.js";

/** Native hook protocol intentionally bypasses the normal CLI JSON envelope. */
export async function runNativeHook(argv: string[]): Promise<number> {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { dir: { type: "string" }, client: { type: "string" } } });
    const usage = positionals[1] === "usage";
    if (positionals[0] !== "hook" || !["run", "usage", "proxy"].includes(positionals[1] ?? "") || !values.client) throw new Error("Usage: loom hook run|usage|proxy --client claude|codex (JSON stdin)");
    const rootDir = values.dir ? path.resolve(values.dir) : findProjectRoot(process.cwd());
    if (positionals[1] === "proxy") {
      if (values.client !== "codex") throw new Error("The app-server proxy supports Codex; Claude uses its status-line usage bridge.");
      return proxyCodex(rootDir);
    }
    let text = "";
    for await (const chunk of process.stdin) { text += chunk.toString(); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Hook input exceeds 1 MiB."); }
    const raw = JSON.parse(text);
    if (usage && !raw.method) raw.hook_event_name = "ContextUsage";
    const output = await withProject(rootDir, { env: process.env }, async ctx => withUserStore(ctx, userStore => handleHook({ client: values.client!, input: raw, store: ctx.store, userStore, project: ctx.projectId, threshold: ctx.loaded.config.memory?.checkpointPercent ?? 70 })));
    if (usage) {
      const pct = raw.context_window?.used_percentage;
      process.stdout.write(typeof pct === "number" ? `Context ${pct.toFixed(0)}%\n` : "Context Loom\n");
    } else process.stdout.write(JSON.stringify(output) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`loom hook: ${redactString((error as Error).message)}\n`);
    process.stdout.write("{}\n");
    return 1;
  }
}

/** Transparent stdio app-server proxy. Preserve protocol lines; observe only measured usage events. */
async function proxyCodex(rootDir: string): Promise<number> {
  const child = spawn(process.env.LOOM_CODEX_BIN ?? "codex", ["app-server"], { cwd: rootDir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
  // Observe rejection immediately, even when stdout has not opened yet.
  exited.catch(() => {});
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin); child.stderr.pipe(process.stderr);
  const interrupt = () => child.kill("SIGINT"); const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let event: any;
      try { event = JSON.parse(line); } catch { /* Forward non-JSON diagnostic lines verbatim. */ }
      if (event?.method === "thread/tokenUsage/updated") {
        try {
          await withProject(rootDir, { env: process.env }, ctx => withUserStore(ctx, userStore => handleHook({ client: "codex", input: event, store: ctx.store, userStore, project: ctx.projectId, threshold: ctx.loaded.config.memory?.checkpointPercent ?? 70 })));
        } catch (error) { process.stderr.write(`loom usage bridge: ${redactString((error as Error).message)}\n`); }
      }
      process.stdout.write(line + "\n");
    }
    return await exited;
  } finally {
    process.stdin.unpipe(child.stdin); process.stdin.pause();
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
  }
}
