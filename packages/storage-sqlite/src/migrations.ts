import type { DatabaseSync } from "node:sqlite";
import { LoomError } from "@ai-plugin-toolkit/core";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a released migration; add a new one.
 * Every migration runs inside its own transaction together with its bookkeeping row.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "projects-sources-audit",
    sql: `
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        created_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sources (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id),
        type          TEXT NOT NULL CHECK (type IN ('conversation', 'document', 'tool-output')),
        title         TEXT,
        media_type    TEXT NOT NULL,
        content_hash  TEXT NOT NULL CHECK (length(content_hash) = 64),
        content_kind  TEXT NOT NULL CHECK (content_kind IN ('inline', 'file')),
        content_text  TEXT,
        content_path  TEXT,
        content_bytes INTEGER NOT NULL CHECK (content_bytes >= 0),
        created_at    TEXT,
        ingested_at   TEXT NOT NULL,
        UNIQUE (project_id, content_hash),
        CHECK ((content_kind = 'inline' AND content_text IS NOT NULL AND content_path IS NULL)
            OR (content_kind = 'file'   AND content_text IS NULL     AND content_path IS NOT NULL))
      ) STRICT;
      CREATE INDEX sources_project_ingested ON sources (project_id, ingested_at, id);

      CREATE TABLE audit_events (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        operation   TEXT NOT NULL,
        actor       TEXT NOT NULL,
        changed_ids TEXT NOT NULL DEFAULT '[]',
        result      TEXT NOT NULL CHECK (result IN ('ok', 'error')),
        error_code  TEXT,
        at          TEXT NOT NULL
      ) STRICT;
      CREATE INDEX audit_events_project_at ON audit_events (project_id, at);
    `,
  },
];

const BOOKKEEPING = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;
`;

export function currentSchemaVersion(db: DatabaseSync): number {
  db.exec(BOOKKEEPING);
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
  return row.version ?? 0;
}

/**
 * Apply pending migrations one at a time. A failing migration rolls back completely,
 * leaving the database at the last successfully applied version and still usable.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  ordered.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new LoomError("INTERNAL", `Migrations must be numbered 1..n without gaps (found ${m.version} at ${i + 1}).`);
    }
  });

  const from = currentSchemaVersion(db);
  const latest = ordered.length;
  if (from > latest) {
    throw new LoomError(
      "INTERNAL",
      `Database schema version ${from} is newer than this build supports (${latest}). Upgrade the toolkit; the database was not modified.`,
      { details: { databaseVersion: from, supportedVersion: latest } },
    );
  }

  for (const migration of ordered.slice(from)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (cause) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new LoomError(
        "INTERNAL",
        `Migration ${migration.version} (${migration.name}) failed and was rolled back; database remains at version ${currentSchemaVersion(db)}.`,
        { cause, details: { migration: migration.version } },
      );
    }
  }
  return { from, to: currentSchemaVersion(db) };
}
