import { readFile, mkdir, chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { LoomError, ReviewTargetSchema, parseWith, type ReviewTarget } from "@ai-plugin-toolkit/core";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { Slug, archiveChecklist, checklistReport, getChecklist, instantiateChecklist, layeredContext, removeMemory, saveMemory, saveProfile, saveTemplate, USER_PROJECT, SharedMemoryClient, createMemoryServer, pullServerMemory, sharedSnapshot } from "@ai-plugin-toolkit/workspace";
import { installHooks, hookManifest } from "@ai-plugin-toolkit/hooks";
import { httpReviewAdapter, publishReview, reviewPreview, saveReviewTarget } from "@ai-plugin-toolkit/review";
import { withProject, type ProjectContext } from "../context.js";
import { UsageError, type CommandResult } from "../io.js";

type Values = Readonly<Record<string, string | boolean | undefined>>;
const result = (value: unknown): CommandResult => ({ data: { value }, lines: [JSON.stringify(value, null, 2)] });
function arg(args: string[], n: number, label: string) { const v = args[n]; if (!v) throw new UsageError(`Missing ${label}. See loom help.`); return v; }
function option(values: Values, key: string) { const v = values[key]; if (typeof v !== "string" || !v) throw new UsageError(`--${key} is required.`); return v; }
function revision(values: Values, required = false) {
  const raw = values["expected-revision"];
  if (required && raw === undefined) throw new UsageError("--expected-revision is required; read the current record first.");
  const n = Number(raw ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new UsageError("--expected-revision must be a nonnegative integer.");
  return n;
}
async function jsonFile(values: Values, cwd: string) {
  const data = await readFile(path.resolve(cwd, option(values, "file")), "utf8");
  if (Buffer.byteLength(data) > 1024 * 1024) throw new UsageError("JSON input exceeds 1 MiB.");
  return JSON.parse(data) as unknown;
}
export async function withUserStore<T>(ctx: ProjectContext, fn: (store: LoomStore) => Promise<T> | T): Promise<T> {
  const dir = path.resolve(ctx.loaded.rootDir, ctx.env.LOOM_USER_HOME ?? ctx.loaded.config.memory?.userStoreDir ?? path.join(homedir(), ".context-loom", "private"));
  if (dir === ctx.loaded.storageDir) throw new LoomError("CONFIG_INVALID", "Private user storage must be separate from project storage.");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const store = await LoomStore.open({ storageDir: dir });
  try { store.ensureProject(USER_PROJECT, "Private user memory"); await chmod(store.databasePath, 0o600); return await fn(store); }
  finally { store.close(); }
}

export async function workspaceCommand(options: { rootDir: string; cwd: string; env: Readonly<Record<string, string | undefined>>; family: string; args: string[]; values: Values }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async ctx => {
    const { store, projectId: project, actor } = ctx;
    const { args, values, family } = options;
    const action = arg(args, 0, "action");
    if (family === "checklists") {
      if (action === "templates") return result(store.documents.list(project, "checklist.template"));
      if (action === "template") {
        const sub = arg(args, 1, "template action");
        if (sub === "init") {
          const id = parseWith(Slug, arg(args, 2, "template ID"), "template ID");
          const draft = { format: "loom-checklist/1", id, version: "1.0.0", title: id, items: [{ id: "tests", title: "Tests pass", expected: "Relevant tests pass on the current source revision", environments: ["ci"] }] };
          const file = path.resolve(options.cwd, option(values, "out"));
          await writeFile(file, JSON.stringify(draft, null, 2) + "\n", { flag: "wx" });
          return result({ file });
        }
        if (sub === "save") return result(saveTemplate(store, project, await jsonFile(values, options.cwd), actor, revision(values)));
        const id = arg(args, 2, "template ID");
        const doc = store.documents.get(project, "checklist.template", id);
        if (!doc) throw new LoomError("NOT_FOUND", `Template ${id} not found.`);
        if (sub === "show") return result(doc);
        if (sub === "delete") { store.documents.remove(project, "checklist.template", id, actor, revision(values, true)); return result({ deleted: id }); }
      }
      if (action === "create") return result(await instantiateChecklist(store, project, option(values, "template"), arg(args, 1, "instance ID"), actor));
      if (action === "list") return result(store.documents.list(project, "checklist.instance"));
      if (action === "show" || action === "report") return result(checklistReport(store, project, arg(args, 1, "instance ID")));
      if (action === "export") {
        const pack = getChecklist(store, project, arg(args, 1, "instance ID")).value.pack;
        const file = path.resolve(options.cwd, option(values, "out"));
        await writeFile(file, JSON.stringify(pack, null, 2) + "\n", { flag: "wx" });
        return result({ file });
      }
      if (action === "archive") return result(archiveChecklist(store, project, arg(args, 1, "instance ID"), actor, revision(values, true)));
    }
    if (family === "profile") return withUserStore(ctx, user => {
      if (action === "show") return result(user.documents.get(USER_PROJECT, "identity", "self") ?? null);
      if (action === "set") return jsonFile(values, options.cwd).then(raw => result(saveProfile(user, raw, actor, revision(values))));
      if (action === "delete") { user.documents.remove(USER_PROJECT, "identity", "self", actor, revision(values, true)); return result({ deleted: "profile" }); }
      throw new UsageError("profile show|set|delete");
    });
    if (family === "notes") {
      if (action === "context") return withUserStore(ctx, user => result(layeredContext(user, store, project)));
      const layer = option(values, "layer");
      if (layer !== "user" && layer !== "shared" && layer !== "server") throw new UsageError("--layer user|shared|server");
      if (layer === "server") {
        if (action !== "list") throw new UsageError("The server layer is read-only locally; use memory-server pull|push.");
        return result(store.documents.get(project, "memory.server", "snapshot") ?? null);
      }
      const execute = async (targetStore: LoomStore, targetProject: string) => {
        if (action === "list") return result(targetStore.documents.list(targetProject, `memory.${layer}`));
        if (action === "show") return result(targetStore.documents.get(targetProject, `memory.${layer}`, arg(args, 1, "memory ID")) ?? null);
        if (action === "put") return result(saveMemory(targetStore, targetProject, layer, await jsonFile(values, options.cwd), actor, revision(values)));
        if (action === "delete") { const id = arg(args, 1, "memory ID"); removeMemory(targetStore, targetProject, layer, id, actor, revision(values, true)); return result({ deleted: id }); }
        throw new UsageError("notes list|show|put|delete|context");
      };
      return layer === "user" ? withUserStore(ctx, u => execute(u, USER_PROJECT)) : execute(store, project);
    }
    if (family === "checkpoints") {
      if (action === "list") return result(store.documents.list(project, "session.checkpoint"));
      if (action === "show") return result(store.documents.get(project, "session.checkpoint", arg(args, 1, "checkpoint ID")) ?? null);
      if (action === "delete") { store.documents.remove(project, "session.checkpoint", arg(args, 1, "checkpoint ID"), actor, revision(values, true)); return result({ deleted: true }); }
    }
    if (family === "reviews") {
      if (action === "targets") return result(store.documents.list(project, "review.target"));
      const name = arg(args, 1, "target name");
      if (action === "define") return result(saveReviewTarget(store, project, name, await jsonFile(values, options.cwd), actor, revision(values)));
      const doc = store.documents.get<ReviewTarget>(project, "review.target", name);
      if (!doc) throw new LoomError("NOT_FOUND", `Review target ${name} not found.`);
      if (action === "show") return result(doc);
      if (action === "delete") { store.documents.remove(project, "review.target", name, actor, revision(values, true)); return result({ deleted: name }); }
      const target = parseWith(ReviewTargetSchema, doc.value, "review target");
      const ids = option(values, "checklists").split(",");
      const preview = reviewPreview(store, project, target, ids);
      if (action === "preview") return result(preview);
      if (action === "publish") {
        const endpoint = target.apiUrl ?? (target.provider === "github" ? "https://api.github.com" : "https://gitlab.com/api/v4");
        if (ctx.loaded.config.project.sensitivity === "restricted" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname)) throw new LoomError("POLICY_VIOLATION", "Restricted projects cannot publish reviews to remote hosts.");
        const outcome = await publishReview(target, preview.body, httpReviewAdapter(target, ctx.env[target.tokenEnv] ?? ""));
        store.audit(project, "review.publish", actor, [name, String(outcome.request.number)]);
        return result(outcome);
      }
    }
    if (family === "hooks") {
      const client = option(values, "client");
      if (action === "manifest") return result(hookManifest(client, options.rootDir, process.argv[1]!));
      if (action === "install" || action === "uninstall") return result(await installHooks({ client, root: options.rootDir, cli: process.argv[1]!, uninstall: action === "uninstall", dryRun: values["dry-run"] === true }));
    }
    if (family === "memory-server") {
      const config = ctx.loaded.config.memory?.server;
      if (!config) throw new LoomError("CONFIG_INVALID", "Configure memory.server in loom.config.json first.");
      const token = ctx.env[config.tokenEnv] ?? "";
      if (action === "serve") {
        const server = createMemoryServer({ store, project, token });
        const port = Number(values.port ?? 7331);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be 1..65535");
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
        process.stderr.write(`Memory server listening on http://127.0.0.1:${port} for ${project}\n`);
        await new Promise<void>(resolve => { const close = () => server.close(() => resolve()); process.once("SIGINT", close); process.once("SIGTERM", close); });
        return result({ stopped: true });
      }
      if (ctx.loaded.config.project.sensitivity === "restricted" && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.url).hostname)) throw new LoomError("POLICY_VIOLATION", "Restricted projects cannot connect to a remote memory server.");
      const client = new SharedMemoryClient(config, token);
      if (action === "pull") return result(await pullServerMemory(client, store, project, actor));
      if (action === "push") return result(await client.request(project, "PUT", sharedSnapshot(store, project), revision(values, true)));
    }
    throw new UsageError(`Unknown ${family} action. Run loom help.`);
  });
}
