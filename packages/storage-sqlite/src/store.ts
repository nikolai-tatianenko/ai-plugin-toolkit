import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LoomError,
  ProjectIdSchema,
  SourceInputSchema,
  SourceSchema,
  contentHash,
  isLoomError,
  newId,
  parseWith,
  stableId,
  type Source,
  type SourceInput,
} from "@ai-plugin-toolkit/core";
import { Db } from "./db.js";
import { readEvidenceFile, writeEvidenceFile } from "./evidence-files.js";
import { MemoryRepo } from "./memory-repo.js";
import { MIGRATIONS, migrate, type Migration } from "./migrations.js";
import { AcceptanceRepo, ArtifactRepo, RoutingRepo, StateRepo, TaskRepo } from "./repos.js";

export const DATABASE_FILENAME = "loom.db";
export const DEFAULT_INLINE_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export interface IngestOutcome {
  source: Source;
  status: "created" | "existing";
}

export interface StoreOptions {
  storageDir: string;
  inlineLimitBytes?: number;
  maxSourceBytes?: number;
  /** Test seam: override the migration list. */
  migrations?: readonly Migration[];
  /** Test seam: called inside the ingest transaction after each insert. */
  onInsert?: (source: Source) => void;
}

type Row = Record<string, string | number | null>;

function rowToSource(row: Row): Source {
  return parseWith(
    SourceSchema,
    {
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      ...(row.title === null ? {} : { title: row.title }),
      mediaType: row.media_type,
      contentHash: row.content_hash,
      content:
        row.content_kind === "inline"
          ? { kind: "inline", text: row.content_text }
          : { kind: "file", path: row.content_path, bytes: row.content_bytes },
      ...(row.created_at === null ? {} : { createdAt: row.created_at }),
      ingestedAt: row.ingested_at,
    },
    "stored source",
  );
}

/**
 * Structured persistence for one storage directory. SQLite is the authoritative
 * structured state; large payloads live in content-addressed files.
 * Every read and write takes an explicit project ID — there is no unscoped query.
 */
export class LoomStore {
  readonly storageDir: string;
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly handle: Db;
  readonly memory: MemoryRepo;
  readonly state: StateRepo;
  readonly routing: RoutingRepo;
  readonly acceptance: AcceptanceRepo;
  readonly artifacts: ArtifactRepo;
  readonly tasks: TaskRepo;
  private readonly inlineLimit: number;
  private readonly maxSourceBytes: number;
  private readonly onInsert: ((source: Source) => void) | undefined;

  private constructor(db: DatabaseSync, options: StoreOptions, databasePath: string) {
    this.db = db;
    this.handle = new Db(db);
    this.memory = new MemoryRepo(this.handle);
    this.state = new StateRepo(this.handle);
    this.routing = new RoutingRepo(this.handle);
    this.acceptance = new AcceptanceRepo(this.handle);
    this.artifacts = new ArtifactRepo(this.handle);
    this.tasks = new TaskRepo(this.handle);
    this.storageDir = path.resolve(options.storageDir);
    this.databasePath = databasePath;
    this.inlineLimit = options.inlineLimitBytes ?? DEFAULT_INLINE_LIMIT_BYTES;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.onInsert = options.onInsert;
  }

  static async open(options: StoreOptions): Promise<LoomStore> {
    const storageDir = path.resolve(options.storageDir);
    await mkdir(storageDir, { recursive: true });
    const databasePath = path.join(storageDir, DATABASE_FILENAME);
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
      migrate(db, options.migrations ?? MIGRATIONS);
    } catch (error) {
      db.close();
      throw error;
    }
    const store = new LoomStore(db, options, databasePath);
    try {
      await store.indexUnindexedSources();
    } catch (error) {
      store.close();
      throw error;
    }
    return store;
  }

  /** Atomic group of writes across repositories. Re-entrant. */
  transaction<T>(fn: () => T): T {
    return this.handle.transaction(fn);
  }

  /** Sources stored before the lexical index existed (schema v1) are indexed on open. */
  private async indexUnindexedSources(): Promise<void> {
    const rows = this.db
      .prepare(
        "SELECT id, project_id FROM sources WHERE id NOT IN (SELECT record_id FROM memory_fts WHERE kind = 'source') ORDER BY rowid",
      )
      .all() as Row[];
    for (const row of rows) {
      const projectId = String(row.project_id);
      const source = this.getSource(projectId, String(row.id));
      if (source === undefined) continue;
      const text = await this.readSourceText(projectId, source.id);
      this.memory.index(projectId, source.id, "source", searchableText(source, text));
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  schemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
    return row.v ?? 0;
  }

  ensureProject(projectId: string, name: string): void {
    parseWith(ProjectIdSchema, projectId, "project ID");
    this.db
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name")
      .run(projectId, name, new Date().toISOString());
  }

  /**
   * Ingest a batch atomically. All inputs are validated first; then evidence files are
   * written; then every row plus an audit event is inserted in one transaction.
   * Any failure leaves no new source rows. Identical content in the same project
   * resolves to the existing source (status "existing").
   */
  async ingest(projectId: string, inputs: readonly SourceInput[], options: { actor: string }): Promise<IngestOutcome[]> {
    try {
      return await this.ingestUnaudited(projectId, inputs, options);
    } catch (error) {
      this.recordAudit(projectId, "sources.ingest", options.actor, [], isLoomError(error) ? error.code : "INTERNAL");
      throw error;
    }
  }

  private async ingestUnaudited(
    projectId: string,
    inputs: readonly SourceInput[],
    options: { actor: string },
  ): Promise<IngestOutcome[]> {
    parseWith(ProjectIdSchema, projectId, "project ID");
    if (!this.projectExists(projectId)) {
      throw new LoomError("NOT_FOUND", `Project "${projectId}" is not initialized in this store.`);
    }
    if (inputs.length === 0) throw new LoomError("VALIDATION_FAILED", "Nothing to ingest.");

    // 1. Validate everything before touching disk or database.
    const prepared = inputs.map((raw, index) => {
      const label = (raw as { label?: unknown }).label;
      const input = parseWith(SourceInputSchema, raw, typeof label === "string" ? label : `input #${index + 1}`);
      const bytes = Buffer.byteLength(input.text, "utf8");
      if (bytes > this.maxSourceBytes) {
        throw new LoomError(
          "VALIDATION_FAILED",
          `${input.label ?? `input #${index + 1}`} is ${bytes} bytes; the limit is ${this.maxSourceBytes}.`,
        );
      }
      const hash = contentHash(input.text);
      return { input, bytes, hash, id: stableId("source", projectId, hash) };
    });

    // 2. Content-addressed payload files (idempotent; safe to leave behind on later failure).
    const filePaths = new Map<string, string>();
    for (const item of prepared) {
      if (item.bytes > this.inlineLimit && !filePaths.has(item.hash) && this.findSourceRow(projectId, item.id) === undefined) {
        filePaths.set(item.hash, await writeEvidenceFile(this.storageDir, item.input.text, item.hash));
      }
    }

    // 3. One transaction for all rows and the audit event.
    const ingestedAt = new Date().toISOString();
    return this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT INTO sources (id, project_id, type, title, media_type, content_hash, content_kind,
                             content_text, content_path, content_bytes, created_at, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project_id, content_hash) DO NOTHING`);
      const outcomes: IngestOutcome[] = [];
      for (const { input, bytes, hash, id } of prepared) {
        const filePath = filePaths.get(hash);
        const result = insert.run(
          id,
          projectId,
          input.type,
          input.title ?? null,
          input.mediaType,
          hash,
          filePath === undefined ? "inline" : "file",
          filePath === undefined ? input.text : null,
          filePath ?? null,
          bytes,
          input.createdAt ?? null,
          ingestedAt,
        );
        const source = this.getSource(projectId, id);
        if (source === undefined) throw new LoomError("INTERNAL", `Source ${id} missing after insert.`);
        if (result.changes > 0) {
          this.memory.index(projectId, id, "source", searchableText(source, input.text));
          this.onInsert?.(source);
        }
        outcomes.push({ source, status: result.changes > 0 ? "created" : "existing" });
      }
      const created = outcomes.filter((o) => o.status === "created").map((o) => o.source.id);
      this.recordAudit(projectId, "sources.ingest", options.actor, created);
      return outcomes;
    });
  }

  getSource(projectId: string, id: string): Source | undefined {
    const row = this.findSourceRow(projectId, id);
    return row === undefined ? undefined : rowToSource(row);
  }

  listSources(projectId: string, options: { limit?: number; offset?: number } = {}): Source[] {
    const rows = this.db
      .prepare("SELECT * FROM sources WHERE project_id = ? ORDER BY ingested_at, id LIMIT ? OFFSET ?")
      .all(projectId, options.limit ?? 100, options.offset ?? 0) as Row[];
    return rows.map(rowToSource);
  }

  countSources(projectId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sources WHERE project_id = ?").get(projectId) as { n: number };
    return row.n;
  }

  /** Original evidence text, verified against its hash. */
  async readSourceText(projectId: string, id: string): Promise<string> {
    const source = this.getSource(projectId, id);
    if (source === undefined) throw new LoomError("NOT_FOUND", `Source ${id} not found in project "${projectId}".`);
    if (source.content.kind === "inline") return source.content.text;
    return readEvidenceFile(this.storageDir, source.content.path, source.contentHash);
  }

  auditEvents(projectId: string): Array<{ operation: string; result: string; errorCode: string | null; changedIds: string[] }> {
    const rows = this.db
      .prepare("SELECT operation, result, error_code, changed_ids FROM audit_events WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as Row[];
    return rows.map((r) => ({
      operation: String(r.operation),
      result: String(r.result),
      errorCode: r.error_code === null ? null : String(r.error_code),
      changedIds: JSON.parse(String(r.changed_ids)) as string[],
    }));
  }

  /** Append an audit event (operation, actor, changed IDs, result). Never pass secret payloads. */
  audit(projectId: string, operation: string, actor: string, changedIds: string[], errorCode?: string): void {
    this.recordAudit(projectId, operation, actor, changedIds, errorCode);
  }

  projectExists(projectId: string): boolean {
    return this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId) !== undefined;
  }

  private findSourceRow(projectId: string, id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE project_id = ? AND id = ?").get(projectId, id) as Row | undefined;
  }

  private recordAudit(projectId: string, operation: string, actor: string, changedIds: string[], errorCode?: string): void {
    try {
      this.db
        .prepare(
          "INSERT INTO audit_events (id, project_id, operation, actor, changed_ids, result, error_code, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          newId("auditEvent"),
          projectId,
          operation,
          actor,
          JSON.stringify(changedIds),
          errorCode === undefined ? "ok" : "error",
          errorCode ?? null,
          new Date().toISOString(),
        );
    } catch (cause) {
      // An audit failure inside a transaction must abort it; outside one it must not mask the original error.
      if (this.db.isTransaction) throw cause;
    }
  }

}

/** Index conversations by their message text rather than JSON keys; other sources as-is. */
export function searchableText(source: Source, text: string): string {
  const parts = [source.title ?? ""];
  if (source.type === "conversation" && source.mediaType === "application/json") {
    try {
      const parsed = JSON.parse(text) as { messages?: Array<{ content?: unknown }> };
      for (const message of parsed.messages ?? []) if (typeof message.content === "string") parts.push(message.content);
      return parts.join("\n");
    } catch {
      // fall through: index raw text
    }
  }
  parts.push(text);
  return parts.join("\n");
}
