import path from "node:path";
import { evaluatePack } from "@ai-plugin-toolkit/acceptance";
import { ARTIFACT_TYPES, generateArtifacts, type ArtifactKind } from "@ai-plugin-toolkit/artifacts";
import { resolveProjectPath } from "@ai-plugin-toolkit/core";
import { applySync, previewSync, type Change } from "@ai-plugin-toolkit/task-sync";
import { withProject } from "../context.js";
import { UsageError, type CommandResult } from "../io.js";

interface Base {
  rootDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

export async function generateCommand(options: Base & { types: string[]; force: boolean; dryRun: boolean }): Promise<CommandResult> {
  const types = options.types.length === 0 ? [...ARTIFACT_TYPES] : options.types;
  for (const t of types) {
    if (!(ARTIFACT_TYPES as readonly string[]).includes(t)) throw new UsageError(`Unknown artifact type "${t}". Choose from: ${ARTIFACT_TYPES.join(", ")}.`);
  }
  return withProject(options.rootDir, options, async (ctx) => {
    const outDir = resolveProjectPath(ctx.loaded.rootDir, ctx.loaded.config.artifacts.dir, "artifacts.dir");
    const outcomes = await generateArtifacts({
      store: ctx.store,
      projectId: ctx.projectId,
      projectName: ctx.loaded.config.project.name,
      outDir,
      packs: await ctx.activePacks(),
      types: types as ArtifactKind[],
      force: options.force,
      dryRun: options.dryRun,
      actor: ctx.actor,
    });
    const conflicts = outcomes.filter((o) => o.status === "conflict");
    const mark = { created: "+", updated: "~", unchanged: "=", restored: "+", conflict: "!" } as const;
    return {
      data: { outDir, dryRun: options.dryRun, artifacts: outcomes, conflicts: conflicts.length },
      lines: [
        `${options.dryRun ? "Would write" : "Artifacts"} in ${path.relative(ctx.loaded.rootDir, outDir) || "."}:`,
        ...outcomes.map((o) => `  ${mark[o.status]} ${o.path}  ${o.status}${o.revision === undefined ? "" : ` (revision ${o.revision})`}${o.reason ? ` — ${o.reason}` : ""}`),
        ...(conflicts.length > 0 ? [`${conflicts.length} conflict(s): files were left untouched.`] : []),
      ],
    };
  });
}

const changeLine = (c: Change) =>
  `  ${c.kind.padEnd(14)} ${c.title}${c.externalId ? `  [${c.externalId}]` : ""}${c.kind === "link" ? ` → depends on ${c.dependsOnExternalId ?? c.dependsOnTaskId}` : ""}${["conflict", "remote-edited", "missing-remote", "adopt"].includes(c.kind) ? `\n      ${c.reason}` : ""}`;

export async function tasksPreviewCommand(options: Base): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const adapter = ctx.taskAdapter();
    const evaluations = (await ctx.activePacks()).map((p) => evaluatePack(ctx.store, ctx.projectId, p));
    const preview = await previewSync(ctx.store, ctx.projectId, adapter, evaluations);
    const writes = ctx.loaded.config.tasks?.allowWrites === true;
    return {
      data: { preview, allowWrites: writes },
      lines: [
        `Preview against ${preview.adapter.upstream} (adapter ${preview.adapter.name}@${preview.adapter.version}) — nothing was written:`,
        ...preview.changes.filter((c) => c.kind !== "unchanged").map(changeLine),
        `  totals: ${Object.entries(preview.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no tasks"}`,
        ...(preview.pendingIntents > 0 ? [`  ${preview.pendingIntents} interrupted operation(s) will be reconciled on the next sync`] : []),
        writes ? "Publish with: loom tasks sync" : "Publishing is disabled: set tasks.allowWrites to true in loom.config.json to enable `loom tasks sync`.",
      ],
    };
  });
}

export async function tasksSyncCommand(options: Base): Promise<{ result: CommandResult; ok: boolean }> {
  return withProject(options.rootDir, options, async (ctx) => {
    const adapter = ctx.taskAdapter();
    const evaluations = (await ctx.activePacks()).map((p) => evaluatePack(ctx.store, ctx.projectId, p));
    const result = await applySync(ctx.store, ctx.projectId, adapter, evaluations, {
      allowWrites: ctx.loaded.config.tasks?.allowWrites === true,
      actor: ctx.actor,
    });
    return {
      ok: result.status === "ok",
      result: {
        data: { sync: result },
        lines: [
          `Sync with ${result.adapter.upstream}: ${result.status}`,
          ...result.applied.map(changeLine),
          ...result.changes.filter((c) => c.kind === "conflict" || c.kind === "remote-edited" || c.kind === "missing-remote").map(changeLine),
          ...result.failures.map((f) => `  ✗ ${f.change.kind} ${f.change.title}: [${f.code}] ${f.message}`),
          `  totals: ${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no tasks"}`,
        ],
      },
    };
  });
}

export async function tasksInitCommand(options: Base): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const adapter = ctx.taskAdapter();
    const version = await adapter.checkVersion();
    const status = await adapter.initialize();
    const name = adapter.manifest.upstream.name;
    return { data: { adapter: adapter.manifest.name, version, status }, lines: [`${name} ${version}: ${status === "created" ? "initialized" : "already initialized"}.`] };
  });
}

export async function tasksListCommand(options: Base): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const tasks = ctx.store.tasks.list(ctx.projectId);
    const adapterName = ctx.loaded.config.tasks?.adapter;
    const mappings = adapterName === undefined ? [] : ctx.store.tasks.mappings(ctx.projectId, adapterName);
    const byTask = new Map(mappings.map((m) => [m.taskId, m]));
    return {
      data: { tasks, mappings },
      lines:
        tasks.length === 0
          ? ["No local tasks yet. Run `loom tasks preview` or `loom tasks sync`."]
          : tasks.map((t) => `  ${t.id}  r${t.revision} ${t.status.padEnd(11)} ${t.title}${byTask.has(t.id) ? `  [${byTask.get(t.id)!.externalId}]` : ""}`),
    };
  });
}
