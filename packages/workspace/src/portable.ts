import { z } from "zod";
import { ReviewTargetSchema, parseWith, LoomError } from "@ai-plugin-toolkit/core";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { parsePack } from "@ai-plugin-toolkit/acceptance";
import { MemoryEntrySchema } from "./memory.js";

export const WORKSPACE_NAMESPACES = ["checklist.template", "checklist.instance", "memory.shared", "review.target"] as const;
const PortableSchema = z.array(z.strictObject({ namespace: z.enum(WORKSPACE_NAMESPACES), key: z.string().min(1), value: z.unknown() })).max(5000);

/** Portable project state excludes private identities, user notes, server credentials and session checkpoints. */
export function exportWorkspace(store: LoomStore, project: string) {
  return WORKSPACE_NAMESPACES.flatMap(namespace => store.documents.list(project, namespace).map(d => ({ namespace, key: d.key, value: d.value })));
}
export function parseWorkspace(raw: unknown) {
  const docs = parseWith(PortableSchema, raw ?? [], "workspace export");
  const keys = new Set<string>();
  for (const d of docs) {
    const key = `${d.namespace}/${d.key}`;
    if (keys.has(key)) throw new LoomError("VALIDATION_FAILED", "Duplicate workspace document."); keys.add(key);
    if (d.namespace === "checklist.template" && parsePack(d.value).id !== d.key) throw new LoomError("VALIDATION_FAILED", "Template ID mismatch.");
    if (d.namespace === "checklist.instance") {
      const instance = parseWith(z.strictObject({ template: z.string(), pack: z.unknown(), archived: z.boolean() }), d.value, "checklist instance");
      if (parsePack(instance.pack).id !== d.key) throw new LoomError("VALIDATION_FAILED", "Instance ID mismatch.");
    }
    if (d.namespace === "memory.shared") parseWith(MemoryEntrySchema, d.value, "shared memory");
    if (d.namespace === "review.target") {
      // Imported files may describe external writes but cannot enable them.
      d.value = { ...parseWith(ReviewTargetSchema, d.value, "review target"), allowWrites: false };
    }
  }
  return docs;
}
export function importWorkspace(store: LoomStore, project: string, raw: unknown, actor: string) {
  const docs = parseWorkspace(raw);
  return store.transaction(() => {
    for (const doc of docs) {
      store.documents.put(project, doc.namespace, doc.key, doc.value, actor, 0);
      if (doc.namespace === "checklist.instance") {
        const value = doc.value as { pack: { version: string }; archived: boolean };
        if (!value.archived) store.acceptance.activatePack(project, doc.key, value.pack.version, "workspace");
      }
    }
    return docs.length;
  });
}
