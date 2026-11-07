import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LoomError, parseWith } from "@ai-plugin-toolkit/core";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { layeredContext } from "@ai-plugin-toolkit/workspace";

export const HookInputSchema = z.object({
  session_id: z.string().min(1).max(200),
  hook_event_name: z.enum(["SessionStart", "PostToolUse", "Stop", "PreCompact", "PostCompact", "ContextUsage"]),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().max(128000).nullable().optional(),
  context_window: z.object({ used_percentage: z.number().min(0).max(100).nullable().optional() }).passthrough().optional(),
  usage: z.object({ usedTokens: z.number().nonnegative(), contextWindowTokens: z.number().positive() }).optional(),
}).passthrough();
export type HookInput = z.infer<typeof HookInputSchema>;
export interface HookAdapter { id: string; normalize(raw: unknown): HookInput; }
export function normalizeCodex(raw: unknown): HookInput {
  const event = raw as { method?: string; params?: { threadId?: string; tokenUsage?: { last?: { totalTokens?: number }; modelContextWindow?: number } } };
  if (event?.method === "thread/tokenUsage/updated") {
    const p = event.params;
    return parseWith(HookInputSchema, { session_id: p?.threadId, hook_event_name: "ContextUsage",
      ...(p?.tokenUsage?.modelContextWindow ? { usage: { usedTokens: p.tokenUsage.last?.totalTokens, contextWindowTokens: p.tokenUsage.modelContextWindow } } : {}) }, "Codex token usage");
  }
  return parseWith(HookInputSchema, raw, "Codex hook input");
}
/** Host-specific wire conversion stays behind this small reusable contract. */
export const HOOK_ADAPTERS: Readonly<Record<string, HookAdapter>> = {
  claude: { id: "claude", normalize: raw => parseWith(HookInputSchema, raw, "Claude hook input") },
  codex: { id: "codex", normalize: normalizeCodex },
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type SessionState = { high: boolean; percentage: number | null };

export function handleHook(options: {
  client: string; input: unknown; store: LoomStore; userStore: LoomStore; project: string; threshold?: number;
  adapters?: Readonly<Record<string, HookAdapter>>;
}) {
  const adapter = (options.adapters ?? HOOK_ADAPTERS)[options.client];
  if (!adapter) throw new LoomError("UNSUPPORTED_CAPABILITY", `Unknown hook adapter ${options.client}.`);
  const input = adapter.normalize(options.input);
  const { store, userStore, project } = options;
  const sessionKey = hash(`${options.client}:${input.session_id}`);
  const old = store.documents.get<SessionState>(project, "hook.session", sessionKey);
  const measured = input.context_window?.used_percentage ?? (input.usage ? Math.min(100, input.usage.usedTokens / input.usage.contextWindowTokens * 100) : undefined);
  const percentage = measured ?? old?.value.percentage ?? null;
  const threshold = options.threshold ?? 70;
  if (!Number.isFinite(threshold) || threshold < 1 || threshold > 100) throw new LoomError("CONFIG_INVALID", "Checkpoint threshold must be 1..100 percent.");
  // A status-line/usage event persists the crossing; the next tool hook delivers the reflection prompt.
  const pending = store.documents.get<{ pending: boolean }>(project, "hook.pending", sessionKey);
  const crossing = measured !== undefined && measured >= threshold && !old?.value.high;
  const deliver = input.hook_event_name === "PostToolUse" && (crossing || pending?.value.pending === true);
  const high = measured === undefined ? old?.value.high ?? false : measured >= threshold;
  const message = input.last_assistant_message ?? "";
  const checkpoint = crossing || input.hook_event_name === "PreCompact" || (input.hook_event_name === "Stop" && message.length > 0 && !input.stop_hook_active);
  store.transaction(() => {
    if (!old || old.value.high !== high || old.value.percentage !== percentage) store.documents.put(project, "hook.session", sessionKey, { high, percentage }, `hook:${adapter.id}`, old?.revision ?? 0);
    const shouldPend = input.hook_event_name === "ContextUsage" && crossing;
    if (shouldPend || (pending?.value.pending && (deliver || measured !== undefined && measured < threshold))) {
      store.documents.put(project, "hook.pending", sessionKey, { pending: shouldPend }, `hook:${adapter.id}`, pending?.revision ?? 0);
    }
    if (checkpoint) {
      // This is an untrusted working checkpoint, never a confirmed fact and never uploaded.
      const payload = { client: adapter.id, session: sessionKey, event: input.hook_event_name, percentage,
        status: "proposed", message: message.slice(0, 32000),
        sharedMemory: store.documents.list(project, "memory.shared"),
        checklists: store.documents.list(project, "checklist.instance"),
        revision: store.state.get(project, "build.revision") ?? null };
      const key = `checkpoint-${hash(JSON.stringify(payload))}`;
      if (!store.documents.get(project, "session.checkpoint", key)) {
        store.documents.put(project, "session.checkpoint", key, payload, `hook:${adapter.id}`, 0);
        store.audit(project, "memory.checkpoint", `hook:${adapter.id}`, [key]);
      }
    }
  });
  const reflect = "Reflect on the completed work: check user goals, decisions, corrections, open questions and checklist evidence. Persist durable updates with `loom notes put --layer user|shared --file <memory.json>` (explicit status/provenance); update checklist evidence where needed. Never promote the assistant's own claims into confirmed user decisions. A local working checkpoint was saved when content was available; check `loom checkpoints list`. Do not publish or sync from this hook.";
  if (input.hook_event_name === "SessionStart" || input.hook_event_name === "PostCompact") return {
    hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: layeredContext(userStore, store, project, 6000).text },
  };
  if (input.hook_event_name === "Stop" && !input.stop_hook_active) return { decision: "block", reason: reflect };
  if (deliver) return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Context usage reached ${percentage?.toFixed(1)}% (checkpoint threshold ${threshold}%). ${reflect}` } };
  if (input.hook_event_name === "PreCompact") return { systemMessage: "Context Loom saved the local pre-compaction checkpoint. Review durable memory after compaction." };
  return {};
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
export function hookManifest(client: string, root: string, cli: string, node = process.execPath) {
  if (!HOOK_ADAPTERS[client]) throw new LoomError("UNSUPPORTED_CAPABILITY", `Unknown hook client ${client}.`);
  const command = [node, cli, "--dir", root, "hook", "run", "--client", client].map(shellQuote).join(" ");
  const hooks = Object.fromEntries(["SessionStart", "PostToolUse", "Stop", "PreCompact", "PostCompact"].map(event => [event, [{ hooks: [{ type: "command", command, timeout: 15 }] }]]));
  return { hooks };
}

/** Merge only our exact command, preserving unrelated hook handlers and settings. */
export async function installHooks(options: { client: string; root: string; cli: string; uninstall?: boolean; dryRun?: boolean }) {
  const manifest = hookManifest(options.client, options.root, options.cli);
  const dir = path.join(options.root, options.client === "claude" ? ".claude" : ".codex");
  const file = path.join(dir, options.client === "claude" ? "settings.json" : "hooks.json");
  if (!options.dryRun) await mkdir(dir, { recursive: true });
  // Refuse a symlink escaping the chosen project directory.
  const root = await realpath(options.root);
  const actual = await realpath(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" && options.dryRun) return path.join(root, path.basename(dir)); throw error; });
  if (!actual.startsWith(root + path.sep)) throw new LoomError("INVALID_PATH", "Hook directory escapes the project.");
  let before = "";
  try { before = await readFile(file, "utf8"); if (!(await realpath(file)).startsWith(root + path.sep)) throw new LoomError("INVALID_PATH", "Hook settings escape the project."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const settings = before ? JSON.parse(before) : {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new LoomError("CONFIG_INVALID", "Hook settings must be an object.");
  settings.hooks ??= {};
  if (typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) throw new LoomError("CONFIG_INVALID", "hooks must be an object.");
  for (const [event, groups] of Object.entries(manifest.hooks)) {
    const ownCommand = groups[0]!.hooks[0]!.command;
    const current = settings.hooks[event] ?? [];
    if (!Array.isArray(current)) throw new LoomError("CONFIG_INVALID", `Invalid ${event} hook list.`);
    settings.hooks[event] = current.flatMap((group: any) => {
      if (!Array.isArray(group.hooks)) throw new LoomError("CONFIG_INVALID", "Invalid hook group.");
      const hooks = group.hooks.filter((h: any) => h.command !== ownCommand);
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!options.uninstall) settings.hooks[event].push(...groups);
  }
  // Claude provides measured usage on its status-line input. Do not replace a user's existing status line.
  if (options.client === "claude") {
    const usageCommand = [process.execPath, options.cli, "--dir", options.root, "hook", "usage", "--client", "claude"].map(shellQuote).join(" ");
    if (!options.uninstall && settings.statusLine === undefined) settings.statusLine = { type: "command", command: usageCommand };
    if (options.uninstall && settings.statusLine?.command === usageCommand) delete settings.statusLine;
  }
  const content = JSON.stringify(settings, null, 2) + "\n";
  if (!options.dryRun && content !== before) {
    const latest = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return ""; });
    if (latest !== before) throw new LoomError("CONFLICT", "Hook settings changed during installation.");
    if (before) await writeFile(`${file}.loom-backup-${Date.now()}`, before, { flag: "wx", mode: 0o600 });
    const temp = `${file}.loom-${process.pid}-${Date.now()}`;
    await writeFile(temp, content, { mode: 0o600, flag: "wx" }); await rename(temp, file);
  }
  return { file, settings, dryRun: options.dryRun ?? false };
}
