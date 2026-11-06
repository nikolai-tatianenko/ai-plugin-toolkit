import { exportWorkspace, importWorkspace, parseWorkspace } from "@ai-plugin-toolkit/workspace";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARTIFACT_TYPES, generateArtifacts } from "@ai-plugin-toolkit/artifacts";
import { LoomError, resolveProjectPath } from "@ai-plugin-toolkit/core";
import {
  correctDecision,
  exportProject,
  forgetSource,
  importProject,
  resolveReview,
  sourcesPastRetention,
  type ForgetResult,
  type ReviewAction,
} from "@ai-plugin-toolkit/memory";
import { withProject, type ProjectContext } from "../context.js";
import { UsageError, type CommandResult } from "../io.js";

interface Base {
  rootDir: string;
  env: Readonly<Record<string, string | undefined>>;
}

const EXPORTS_KEY = "exports.paths";

export async function correctCommand(options: Base & { topic: string; choice: string; reason?: string | undefined }): Promise<CommandResult> {
  if (options.reason === undefined || options.reason.trim() === "") throw new UsageError("Usage: loom correct <topic> <choice...> --reason <why>");
  return withProject(options.rootDir, options, async (ctx) => {
    const result = await correctDecision(ctx.store, ctx.projectId, { topic: options.topic, choice: options.choice, reason: options.reason!, actor: ctx.actor });
    return {
      data: result as unknown as Record<string, unknown>,
      lines: [
        `${result.decision.id}: "${result.decision.choice}" is now the confirmed decision on "${result.decision.topic}" (by ${ctx.actor})`,
        ...result.superseded.map((id) => `  superseded ${id} (history kept)`),
        "Run `loom generate` to refresh artifacts.",
      ],
    };
  });
}

export async function reviewListCommand(options: Base & { all: boolean }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const items = ctx.store.memory.reviewItems(ctx.projectId, { all: options.all });
    return {
      data: { items },
      lines:
        items.length === 0
          ? ["No open review items."]
          : items.flatMap((i) => [`  ${i.id}  [${i.kind}${i.status === "open" ? "" : `, ${i.status}`}] ${i.detail}`, `      records: ${i.recordIds.join(", ")}${i.resolution ? `  → ${i.resolution}` : ""}`]),
    };
  });
}

export async function reviewResolveCommand(options: Base & { id: string; action?: string | undefined; keep?: string | undefined }): Promise<CommandResult> {
  let decision: ReviewAction;
  if (options.keep !== undefined) decision = { action: "keep", recordId: options.keep };
  else if (options.action === "accept" || options.action === "revert" || options.action === "dismiss") decision = { action: options.action };
  else throw new UsageError("Usage: loom review resolve <id> --action accept|revert|dismiss | --keep <record-id>");
  return withProject(options.rootDir, options, async (ctx) => {
    const resolution = resolveReview(ctx.store, ctx.projectId, options.id, decision, ctx.actor);
    return { data: { id: options.id, resolution }, lines: [`${options.id}: ${resolution}`] };
  });
}

async function filesUnder(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  } catch {
    return [];
  }
}

/** After forgetting, regenerate artifacts and look for remaining copies of the removed text. */
async function afterForget(ctx: ProjectContext, results: readonly ForgetResult[]) {
  const outDir = resolveProjectPath(ctx.loaded.rootDir, ctx.loaded.config.artifacts.dir, "artifacts.dir");
  const artifacts = await generateArtifacts({
    store: ctx.store,
    projectId: ctx.projectId,
    projectName: ctx.loaded.config.project.name,
    outDir,
    packs: await ctx.activePacks(),
    types: ARTIFACT_TYPES,
    // Deleted content must not survive in generated sections, even hand-edited ones.
    force: true,
    actor: ctx.actor,
  });
  // Decision records of deleted decisions are stale files: remove only those we generated.
  const deleted = new Set(results.flatMap((r) => r.deletedRecords));
  const removedFiles: string[] = [];
  for (const file of await filesUnder(path.join(outDir, "decisions"))) {
    const id = path.basename(file, ".md");
    if (deleted.has(id)) {
      await rm(file, { force: true });
      removedFiles.push(path.relative(ctx.loaded.rootDir, file));
    }
  }
  const fragments = results.flatMap((r) => r.removedText);
  const exports = JSON.parse(ctx.store.state.get(ctx.projectId, EXPORTS_KEY) ?? "[]") as string[];
  const candidates = [...(await filesUnder(outDir)), ...exports.map((e) => path.resolve(ctx.loaded.rootDir, e))];
  const stillPresent: string[] = [];
  for (const file of candidates) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (fragments.some((f) => text.includes(f))) stillPresent.push(path.relative(ctx.loaded.rootDir, file));
  }
  return { artifacts: artifacts.map((a) => ({ name: a.name, status: a.status })), removedFiles, stillPresent };
}

export async function forgetCommand(options: Base & { sources: string[]; yes: boolean }): Promise<CommandResult> {
  if (options.sources.length === 0) throw new UsageError("Usage: loom forget <source-id...> --yes");
  if (!options.yes) throw new UsageError("Forgetting permanently deletes the source and everything derived from it. Re-run with --yes.");
  return withProject(options.rootDir, options, async (ctx) => {
    const results: ForgetResult[] = [];
    for (const id of options.sources) results.push(await forgetSource(ctx.store, ctx.projectId, id, ctx.actor));
    const after = await afterForget(ctx, results);
    return {
      data: { results: results.map(({ removedText: _r, ...rest }) => rest), ...after },
      lines: [
        ...results.map((r) => `Forgot ${r.sourceId}: ${r.deletedRecords.length} record(s) deleted, ${r.updatedRecords.length} trimmed, ${r.cacheEntriesRemoved} cache entr(ies) cleared${r.payloadFileRemoved ? ", payload file removed" : ""}`),
        `Artifacts regenerated; ${after.removedFiles.length} decision record file(s) removed.`,
        ...(after.stillPresent.length > 0
          ? [`! Removed text still appears in: ${after.stillPresent.join(", ")} (manual notes or earlier exports). Edit or delete these files.`]
          : ["No remaining copies found in artifacts or recorded exports."]),
        "Backups, other copies and git history are not changed (see docs/data-lifecycle.md).",
      ],
    };
  });
}

export async function exportCommand(options: Base & { out?: string | undefined; cwd: string }): Promise<CommandResult> {
  if (options.out === undefined) throw new UsageError("Usage: loom export --out <file.json>");
  return withProject(options.rootDir, options, async (ctx) => {
    const data = { ...await exportProject(ctx.store, ctx.projectId, ctx.loaded.config.project.name), workspace: exportWorkspace(ctx.store, ctx.projectId) };
    const file = path.resolve(options.cwd, options.out!);
    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx" }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "EEXIST") throw new LoomError("ALREADY_EXISTS", `${file} exists; refusing to overwrite.`);
      throw cause;
    });
    // Remember the export so `loom forget` can warn that it still contains forgotten content.
    const known = new Set(JSON.parse(ctx.store.state.get(ctx.projectId, EXPORTS_KEY) ?? "[]") as string[]);
    known.add(path.relative(ctx.loaded.rootDir, file));
    ctx.store.state.set(ctx.projectId, EXPORTS_KEY, JSON.stringify([...known]));
    ctx.store.audit(ctx.projectId, "memory.export", ctx.actor, [path.basename(file)]);
    return {
      data: { file, sources: data.sources.length, facts: data.facts.length, decisions: data.decisions.length },
      lines: [`Exported ${data.sources.length} source(s), ${data.facts.length} fact(s), ${data.decisions.length} decision(s) to ${file}`, "The file contains raw evidence: store it like the evidence itself."],
    };
  });
}

export async function importCommand(options: Base & { file: string; cwd: string }): Promise<CommandResult> {
  const raw = JSON.parse(await readFile(path.resolve(options.cwd, options.file), "utf8")) as unknown;
  return withProject(options.rootDir, options, async (ctx) => {
    const workspace = parseWorkspace((raw as { workspace?: unknown }).workspace);
    if (exportWorkspace(ctx.store, ctx.projectId).length > 0) throw new LoomError("ALREADY_EXISTS", "Import requires empty workspace state.");
    const counts = await importProject(ctx.store, ctx.projectId, raw, ctx.actor);
    importWorkspace(ctx.store, ctx.projectId, workspace, ctx.actor);
    return { data: counts, lines: [`Imported ${counts.sources} source(s), ${counts.facts} fact(s), ${counts.decisions} decision(s).`] };
  });
}

export async function retentionCommand(options: Base & { apply: boolean; yes: boolean }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const days = ctx.loaded.config.retention.sourceMaxAgeDays;
    if (days === undefined) return { data: { policy: null, due: [] }, lines: ["No retention policy (set retention.sourceMaxAgeDays in loom.config.json)."] };
    const due = sourcesPastRetention(ctx.store, ctx.projectId, days);
    if (!options.apply || due.length === 0) {
      return { data: { policy: { sourceMaxAgeDays: days }, due, applied: false }, lines: [`Retention ${days} day(s): ${due.length} source(s) due${due.length > 0 ? `: ${due.join(", ")}` : ""}.`, ...(due.length > 0 ? ["Apply with: loom retention apply --yes"] : [])] };
    }
    if (!options.yes) throw new UsageError(`${due.length} source(s) would be forgotten permanently. Re-run with --yes.`);
    const results: ForgetResult[] = [];
    for (const id of due) results.push(await forgetSource(ctx.store, ctx.projectId, id, ctx.actor));
    const after = await afterForget(ctx, results);
    return {
      data: { policy: { sourceMaxAgeDays: days }, due, applied: true, ...after },
      lines: [`Retention ${days} day(s): forgot ${results.length} source(s).`, ...(after.stillPresent.length > 0 ? [`! Removed text still appears in: ${after.stillPresent.join(", ")}`] : [])],
    };
  });
}
