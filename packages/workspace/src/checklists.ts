import { z } from "zod";
import { EvidenceEnvironmentKindSchema, LoomError, parseWith } from "@ai-plugin-toolkit/core";
import { BUILTIN_PACKS, activatePack, evaluatePack, loadBuiltinPack, parsePack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";

export const Slug = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/);
export const ChecklistSchema = z.strictObject({
  format: z.literal("loom-checklist/1"),
  id: Slug,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  title: z.string().min(1).max(300),
  description: z.string().default("Custom checklist"),
  items: z.array(z.strictObject({
    id: Slug,
    title: z.string().min(1).max(300),
    expected: z.string().min(1),
    severity: z.enum(["blocker", "major", "minor"]).default("major"),
    method: z.string().min(1).default("Recorded evidence"),
    environments: z.array(EvidenceEnvironmentKindSchema.exclude(["mock"])).min(1).default(["ci", "manual"]),
  })).min(1).max(500),
}).superRefine((v, ctx) => {
  if (new Set(v.items.map(i => i.id)).size !== v.items.length) ctx.addIssue({ code: "custom", path: ["items"], message: "Item IDs must be unique" });
});

/** Simple authoring format compiles into the existing evidence/applicability engine. */
export function checklistPack(raw: unknown): TopicPack {
  if ((raw as { format?: string })?.format === "loom-pack/1") return parsePack(raw);
  const list = parseWith(ChecklistSchema, raw, "checklist");
  return parsePack({
    format: "loom-pack/1", id: list.id, version: list.version, title: list.title,
    description: list.description, advisory: "User-defined checklist; criteria require current evidence.",
    topics: [{ id: "custom", title: list.title }], questions: [],
    criteria: list.items.map(i => ({ id: i.id, topic: "custom", title: i.title, expected: i.expected,
      severity: i.severity, verification: { method: i.method, environments: i.environments },
      task: { title: i.title, description: i.expected } })),
  });
}

export function saveTemplate(store: LoomStore, project: string, raw: unknown, actor: string, expectedRevision = 0) {
  const pack = checklistPack(raw);
  return store.transaction(() => {
    const old = store.documents.get<TopicPack>(project, "checklist.template", pack.id);
    if (old && old.value.version === pack.version && JSON.stringify(old.value) !== JSON.stringify(pack)) throw new LoomError("CONFLICT", "Changed templates require a new version.");
    const saved = store.documents.put(project, "checklist.template", pack.id, pack, actor, expectedRevision);
    store.audit(project, "checklist.template.save", actor, [pack.id]);
    return saved;
  });
}

export async function instantiateChecklist(store: LoomStore, project: string, template: string, id: string, actor: string) {
  parseWith(Slug, id, "checklist instance ID");
  if ((BUILTIN_PACKS as readonly string[]).includes(id) || store.acceptance.activePacks(project).some(p => p.packId === id)) throw new LoomError("CONFLICT", "Choose a new instance ID; existing pack evidence must not be reused for a different definition.");
  const source = store.documents.get<TopicPack>(project, "checklist.template", template)?.value ?? await loadBuiltinPack(template);
  const pack = parsePack({ ...source, id });
  return store.transaction(() => {
    const saved = store.documents.put(project, "checklist.instance", id, { template, pack, archived: false }, actor, 0);
    activatePack(store, project, pack, actor, "workspace");
    return saved;
  });
}

export function getChecklist(store: LoomStore, project: string, id: string) {
  const doc = store.documents.get<{ template: string; pack: TopicPack; archived: boolean }>(project, "checklist.instance", id);
  if (!doc) throw new LoomError("NOT_FOUND", `Checklist ${id} does not exist.`);
  return { ...doc, value: { ...doc.value, pack: parsePack(doc.value.pack) } };
}

export function checklistReport(store: LoomStore, project: string, id: string) {
  const doc = getChecklist(store, project, id);
  return { ...doc, evaluation: evaluatePack(store, project, doc.value.pack) };
}

export function archiveChecklist(store: LoomStore, project: string, id: string, actor: string, expectedRevision: number) {
  return store.transaction(() => {
    const doc = getChecklist(store, project, id);
    const saved = store.documents.put(project, "checklist.instance", id, { ...doc.value, archived: true }, actor, expectedRevision);
    store.acceptance.deactivatePack(project, id);
    store.audit(project, "checklist.archive", actor, [id]);
    return saved;
  });
}
