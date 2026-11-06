import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { run } from "../src/run.js";
const bin = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "loom-full-workspace-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function loom(args: string[], root = dir) {
  let stdout = "", stderr = "";
  const code = await run([...args, "--json"], { cwd: root, env: { LOOM_ACTOR: "nick", LOOM_USER_HOME: path.join(dir, "private") }, stdout: s => stdout += s, stderr: s => stderr += s });
  return { code, stdout, stderr, data: JSON.parse(stdout).data, error: JSON.parse(stdout).error };
}
async function jsonFile(name: string, value: unknown) { await writeFile(path.join(dir, name), JSON.stringify(value)); }
function native(input: unknown, client = "claude", action = "run") {
  return JSON.parse(execFileSync(process.execPath, [bin, "--dir", dir, "hook", action, "--client", client], { encoding: "utf8", input: JSON.stringify(input), env: { ...process.env, LOOM_USER_HOME: path.join(dir, "private") } }));
}

it("sets up and manages a custom checklist, attaches real-format evidence and previews a defined existing MR", async () => {
  expect((await loom(["init", "--project-id", "demo"])).code).toBe(0);
  expect((await loom(["checklists", "template", "init", "delivery", "--out", "delivery.json"])).code).toBe(0);
  expect((await loom(["checklists", "template", "save", "--file", "delivery.json"])).code).toBe(0);
  expect((await loom(["checklists", "create", "mr-five", "--template", "delivery"])).code).toBe(0);
  expect((await loom(["revision", "set", "commit-123"])).code).toBe(0);
  expect((await loom(["report", "--pack", "mr-five"])).data.evaluations[0].readiness.status).toBe("not-ready");
  expect((await loom(["evidence", "add", "tests", "--pack", "mr-five", "--result", "passed", "--env", "ci", "--revision", "commit-123", "--ref", "https://github.com/o/r/actions/runs/1"])).code).toBe(0);
  expect((await loom(["checklists", "report", "mr-five"])).data.value.evaluation.readiness.status).toBe("ready");
  await jsonFile("target.json", { provider: "github", repository: "o/r", base: "main", head: "feature", title: "Deliver checklists", number: 5, tokenEnv: "HOST_TOKEN", allowWrites: false });
  expect((await loom(["reviews", "define", "existing", "--file", "target.json"])).code).toBe(0);
  const preview = await loom(["reviews", "preview", "existing", "--checklists", "mr-five"]);
  expect(preview.data.value.number).toBe(5); expect(preview.data.value.body).toContain("- [x] Tests pass");
  expect((await loom(["checklists", "export", "mr-five", "--out", "exported-checklist.json"])).code).toBe(0);
  expect(JSON.parse(await readFile(path.join(dir, "exported-checklist.json"), "utf8")).format).toBe("loom-pack/1");
  expect((await loom(["checklists", "archive", "mr-five", "--expected-revision", "1"])).code).toBe(0);
  expect((await loom(["reviews", "preview", "existing", "--checklists", "mr-five"])).error.code).toBe("VALIDATION_FAILED");
});

it("persists private identity/goals, shared notes and native checkpoints, and preserves project state across export/import", async () => {
  await loom(["init", "--project-id", "demo"]);
  await jsonFile("profile.json", { id: "nick", name: "Nick", goals: ["Ship useful modular tools"] });
  expect((await loom(["profile", "set", "--file", "profile.json"])).code).toBe(0);
  await jsonFile("note.json", { id: "architecture", text: "Use plugins", status: "confirmed", provenance: "User explicitly requested modular plugins" });
  expect((await loom(["notes", "put", "--layer", "shared", "--file", "note.json"])).code).toBe(0);
  expect((await loom(["notes", "put", "--layer", "user", "--file", "note.json"])).code).toBe(0);
  expect((await loom(["notes", "put", "--layer", "shared", "--file", "note.json"])).error.code).toBe("CONFLICT");
  const started = native({ session_id: "session-1", hook_event_name: "SessionStart" });
  expect(started.hookSpecificOutput.additionalContext).toContain("Ship useful modular tools");
  expect(native({ session_id: "session-1", hook_event_name: "Stop", last_assistant_message: "Implemented plugin" })).toHaveProperty("decision", "block");
  expect(native({ session_id: "session-1", hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
  expect((await loom(["checkpoints", "list"])).data.value).toHaveLength(1);
  await loom(["checklists", "template", "init", "delivery", "--out", "delivery.json"]);
  await loom(["checklists", "template", "save", "--file", "delivery.json"]);
  await loom(["checklists", "create", "release", "--template", "delivery"]);
  expect((await loom(["export", "--out", "project.json"])).code).toBe(0);
  const exported = JSON.parse(await readFile(path.join(dir, "project.json"), "utf8"));
  expect(exported.workspace.map((d: any) => d.namespace)).toContain("memory.shared");
  expect(JSON.stringify(exported)).not.toContain("Ship useful modular tools");
  expect(JSON.stringify(exported)).not.toContain("Implemented plugin");
  const destination = path.join(dir, "destination"); await mkdir(destination);
  await loom(["init", "--project-id", "demo"], destination);
  expect((await loom(["import", "../project.json"], destination)).code).toBe(0);
  expect((await loom(["checklists", "show", "release"], destination)).data.value.value.pack.id).toBe("release");
  expect((await loom(["notes", "list", "--layer", "shared"], destination)).data.value[0].value.text).toBe("Use plugins");
});

it("installs an executable Claude hook configuration without replacing unrelated settings", async () => {
  await loom(["init", "--project-id", "demo"]);
  const output = execFileSync(process.execPath, [bin, "--dir", dir, "hooks", "install", "--client", "claude", "--json"], { encoding: "utf8" });
  expect(JSON.parse(output).ok).toBe(true);
  const settings = JSON.parse(await readFile(path.join(dir, ".claude/settings.json"), "utf8"));
  const command = settings.hooks.Stop[0].hooks[0].command;
  const response = execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", input: JSON.stringify({ session_id: "installed", hook_event_name: "Stop", last_assistant_message: "Done" }), env: { ...process.env, LOOM_USER_HOME: path.join(dir, "private") } });
  expect(JSON.parse(response).decision).toBe("block");
  expect(settings.statusLine.command).toContain("usage");
});

it("proxies app-server protocol and automatically checkpoints measured Codex usage", async () => {
  await loom(["init", "--project-id", "demo"]);
  const fake = path.join(dir, "fake-codex");
  const usage = { method: "thread/tokenUsage/updated", params: { threadId: "proxy-session", tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 700 }, total: { totalTokens: 100000 } } } };
  await writeFile(fake, `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({id:1,result:{echo:JSON.parse(input).method}})+'\\n');process.stdout.write(${JSON.stringify(JSON.stringify(usage))}+'\\n');});\n`);
  await chmod(fake, 0o755);
  const wire = execFileSync(process.execPath, [bin, "--dir", dir, "hook", "proxy", "--client", "codex"], { encoding: "utf8", input: '{"id":1,"method":"initialize"}', env: { ...process.env, LOOM_CODEX_BIN: fake, LOOM_USER_HOME: path.join(dir, "private") } });
  const lines = wire.trim().split("\n").map(s => JSON.parse(s));
  expect(lines[0]).toEqual({ id: 1, result: { echo: "initialize" } });
  expect(lines[1]).toEqual(usage);
  expect(JSON.stringify(native({ session_id: "proxy-session", hook_event_name: "PostToolUse" }, "codex"))).toContain("70.0%");
});
