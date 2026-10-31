import { LoomError, type Source } from "@ai-plugin-toolkit/core";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { loadConfigFile } from "../config-file.js";
import type { CommandResult } from "../io.js";

function summary(source: Source) {
  return {
    id: source.id,
    type: source.type,
    title: source.title ?? null,
    mediaType: source.mediaType,
    contentHash: source.contentHash,
    storage: source.content.kind,
    bytes: source.content.kind === "file" ? source.content.bytes : Buffer.byteLength(source.content.text, "utf8"),
    createdAt: source.createdAt ?? null,
    ingestedAt: source.ingestedAt,
  };
}

async function withStore<T>(rootDir: string, fn: (store: LoomStore, projectId: string) => Promise<T>): Promise<T> {
  const loaded = await loadConfigFile(rootDir);
  const store = await LoomStore.open({ storageDir: loaded.storageDir });
  try {
    store.ensureProject(loaded.config.project.id, loaded.config.project.name);
    return await fn(store, loaded.config.project.id);
  } finally {
    store.close();
  }
}

export async function sourcesListCommand(options: { rootDir: string; limit: number }): Promise<CommandResult> {
  return withStore(options.rootDir, async (store, projectId) => {
    const total = store.countSources(projectId);
    const sources = store.listSources(projectId, { limit: options.limit }).map(summary);
    return {
      data: { projectId, total, sources },
      lines:
        total === 0
          ? [`No sources in "${projectId}". Add some with \`loom ingest <file>\`.`]
          : [
              `${total} source(s) in "${projectId}"${sources.length < total ? ` (showing ${sources.length})` : ""}:`,
              ...sources.map((s) => `  ${s.id}  ${s.type.padEnd(12)} ${String(s.bytes).padStart(8)} B  ${s.title ?? ""}`),
            ],
    };
  });
}

export async function sourcesShowCommand(options: { rootDir: string; id: string }): Promise<CommandResult> {
  return withStore(options.rootDir, async (store, projectId) => {
    const source = store.getSource(projectId, options.id);
    if (source === undefined) {
      throw new LoomError("NOT_FOUND", `Source ${options.id} not found in project "${projectId}".`);
    }
    const text = await store.readSourceText(projectId, source.id);
    const meta = summary(source);
    return {
      data: { source: meta, text },
      lines: [
        `${meta.id}  ${meta.type}  ${meta.title ?? ""}`,
        `  hash ${meta.contentHash}  ${meta.bytes} B  stored ${meta.storage}  ingested ${meta.ingestedAt}`,
        "",
        text,
      ],
    };
  });
}
