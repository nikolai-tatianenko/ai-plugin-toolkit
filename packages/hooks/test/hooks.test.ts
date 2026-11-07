import { mkdtemp, rm, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { USER_PROJECT } from "@ai-plugin-toolkit/workspace";
import { handleHook, installHooks, normalizeCodex } from "../src/index.js";
let dir: string, store: LoomStore, user: LoomStore;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "loom-hooks-")); store = await LoomStore.open({ storageDir: path.join(dir, "shared") }); user = await LoomStore.open({ storageDir: path.join(dir, "user") }); store.ensureProject("p", "P"); user.ensureProject(USER_PROJECT, "User"); });
afterEach(async () => { store.close(); user.close(); await rm(dir, { recursive: true, force: true }); });
const run = (input: unknown, client = "claude") => handleHook({ input, client, store, userStore: user, project: "p" });
const usage = (n: number, event = "PostToolUse", session = "s") => ({ session_id: session, hook_event_name: event, context_window: { used_percentage: n } });

it("checkpoints exactly on threshold crossings, deduplicates and rearms after compaction", () => {
  expect(run(usage(69))).toEqual({});
  expect(JSON.stringify(run(usage(70)))).toContain("70.0%");
  const count = () => store.documents.list("p", "session.checkpoint").length;
  expect(count()).toBe(1);
  expect(run(usage(80))).toEqual({}); expect(count()).toBe(1);
  run(usage(20));
  run(usage(72)); expect(count()).toBe(2);
  run(usage(70, "PostToolUse", "second")); expect(count()).toBe(3);
});

it("bridges status-line measurements to the next tool hook without repeated continuation", () => {
  run(usage(71, "ContextUsage"));
  expect(JSON.stringify(run({ session_id: "s", hook_event_name: "PostToolUse" }))).toContain("71.0%");
  expect(run({ session_id: "s", hook_event_name: "PostToolUse" })).toEqual({});
});

it("runs end-of-turn reflection once and never stores it as a confirmed memory", () => {
  expect(run({ session_id: "s", hook_event_name: "Stop", last_assistant_message: "Implemented feature" })).toHaveProperty("decision", "block");
  expect(run({ session_id: "s", hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
  const checkpoint = store.documents.list<any>("p", "session.checkpoint")[0]!;
  expect(checkpoint.value.status).toBe("proposed");
  expect(store.documents.list("p", "memory.shared")).toEqual([]);
});

it("preserves pre-compaction state when usage is absent and does not invent a percentage", () => {
  run({ session_id: "s", hook_event_name: "PreCompact" }, "codex");
  expect(store.documents.list<any>("p", "session.checkpoint")[0]!.value.percentage).toBe(null);
  expect(run({ session_id: "t", hook_event_name: "PostToolUse" }, "codex")).toEqual({});
});

it("normalizes Codex app-server usage using the last request, not cumulative billing tokens", () => {
  const event = { method: "thread/tokenUsage/updated", params: { threadId: "codex-s", tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 700 }, total: { totalTokens: 50000 } } } };
  expect(normalizeCodex(event).usage).toEqual({ usedTokens: 700, contextWindowTokens: 1000 });
  run(event, "codex");
  expect(JSON.stringify(run({ session_id: "codex-s", hook_event_name: "PostToolUse" }, "codex"))).toContain("70.0%");
});

it("merges and uninstalls only Loom hooks, preserves custom status lines and is idempotent", async () => {
  await mkdir(path.join(dir, ".claude"));
  const file = path.join(dir, ".claude/settings.json");
  const existing = { statusLine: { type: "command", command: "custom-status" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "existing" }] }] } };
  await writeFile(file, JSON.stringify(existing));
  const options = { client: "claude", root: dir, cli: "/tmp/a path/loom.js" };
  await installHooks(options); const first = await readFile(file, "utf8");
  await installHooks(options); expect(await readFile(file, "utf8")).toBe(first);
  const installed = JSON.parse(first);
  expect(installed.statusLine.command).toBe("custom-status"); expect(installed.hooks.Stop).toHaveLength(2);
  await installHooks({ ...options, uninstall: true });
  expect(JSON.parse(await readFile(file, "utf8")).hooks.Stop).toEqual(existing.hooks.Stop);
  expect((await readdir(path.join(dir, ".claude"))).some(f => f.includes("loom-backup"))).toBe(true);
});

it("rejects malformed hook payloads instead of sharing state under a fake session", () => {
  expect(() => run({ hook_event_name: "Stop" })).toThrow();
  expect(() => run(usage(101))).toThrow();
  expect(() => run(usage(70), "unknown")).toThrow(/Unknown/);
});

it("dry-runs installation without creating configuration directories", async () => {
  const before = await readdir(dir);
  const preview = await installHooks({ client: "codex", root: dir, cli: "/tmp/loom.js", dryRun: true });
  expect(preview.settings.hooks.Stop).toHaveLength(1);
  expect(await readdir(dir)).toEqual(before);
});
