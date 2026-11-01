import { readFile } from "node:fs/promises";
import path from "node:path";
import { LoomError, SOURCE_TYPES, contentHash, parseIngestPayload, stableId, type SourceType, type ValidSourceInput } from "@ai-plugin-toolkit/core";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { loadConfigFile } from "../config-file.js";
import { UsageError, type CommandResult } from "../io.js";

export interface IngestOptions {
  rootDir: string;
  cwd: string;
  files: readonly string[];
  type?: string | undefined;
  title?: string | undefined;
  dryRun: boolean;
  actor: string;
}

export async function ingestCommand(options: IngestOptions): Promise<CommandResult> {
  if (options.files.length === 0) throw new UsageError("Usage: loom ingest <file...> [--type <type>] [--title <title>]");
  if (options.title !== undefined && options.files.length > 1) {
    throw new UsageError("--title applies to a single file; pass one file or omit --title.");
  }
  if (options.type !== undefined && !SOURCE_TYPES.includes(options.type as SourceType)) {
    throw new UsageError(`--type must be one of: ${SOURCE_TYPES.join(", ")}`);
  }

  const loaded = await loadConfigFile(options.rootDir);
  const projectId = loaded.config.project.id;

  // Read and validate every file before opening the store: one bad file means nothing is written.
  const inputs: ValidSourceInput[] = [];
  for (const file of options.files) {
    const absolute = path.resolve(options.cwd, file);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(absolute);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      throw new LoomError(code === "ENOENT" ? "NOT_FOUND" : "VALIDATION_FAILED", `Cannot read ${file}: ${code ?? cause}`, {
        cause,
      });
    }
    inputs.push(
      parseIngestPayload(file, bytes, {
        ...(options.type === undefined ? {} : { type: options.type as SourceType }),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    );
  }

  if (options.dryRun) {
    const planned = inputs.map((input) => ({
      file: input.label,
      id: stableId("source", projectId, contentHash(input.text)),
      type: input.type,
      title: input.title,
      bytes: Buffer.byteLength(input.text, "utf8"),
    }));
    return {
      data: { dryRun: true, projectId, sources: planned },
      lines: [
        `Would ingest ${planned.length} file(s) into "${projectId}" (duplicates are not checked in dry run):`,
        ...planned.map((p) => `  + ${p.id}  ${p.type}  ${p.file}`),
      ],
    };
  }

  const store = await LoomStore.open({ storageDir: loaded.storageDir });
  try {
    store.ensureProject(projectId, loaded.config.project.name);
    const outcomes = await store.ingest(projectId, inputs, { actor: options.actor });
    const rows = outcomes.map((o, i) => ({
      file: inputs[i]?.label,
      status: o.status,
      id: o.source.id,
      type: o.source.type,
      title: o.source.title,
    }));
    const created = rows.filter((r) => r.status === "created").length;
    return {
      data: { dryRun: false, projectId, created, existing: rows.length - created, sources: rows },
      lines: [
        `Ingested ${rows.length} file(s) into "${projectId}": ${created} new, ${rows.length - created} already present`,
        ...rows.map((r) => `  ${r.status === "created" ? "+" : "="} ${r.id}  ${r.type}  ${r.file}`),
      ],
    };
  } finally {
    store.close();
  }
}
