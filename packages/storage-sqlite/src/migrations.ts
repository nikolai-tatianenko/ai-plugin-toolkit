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
  {
    version: 2,
    name: "memory-routing-acceptance-artifacts-tasks",
    sql: `
      -- L1 memory (CL-004) -------------------------------------------------------
      CREATE TABLE extraction_runs (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id),
        source_id      TEXT NOT NULL REFERENCES sources(id),
        prompt_version TEXT NOT NULL,
        provider       TEXT,
        model          TEXT,
        status         TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error')),
        accepted       INTEGER NOT NULL DEFAULT 0,
        rejected       INTEGER NOT NULL DEFAULT 0,
        input_tokens   INTEGER,
        output_tokens  INTEGER,
        cost_usd       REAL,
        error_code     TEXT,
        started_at     TEXT NOT NULL,
        finished_at    TEXT
      ) STRICT;
      CREATE INDEX extraction_runs_source ON extraction_runs (project_id, source_id, prompt_version, status);

      CREATE TABLE facts (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id),
        kind          TEXT NOT NULL,
        statement     TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected', 'superseded')),
        superseded_by TEXT,
        spans         TEXT NOT NULL,
        run_id        TEXT NOT NULL REFERENCES extraction_runs(id),
        created_at    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX facts_project ON facts (project_id, status, created_at);

      CREATE TABLE decisions (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id),
        topic        TEXT,
        choice       TEXT NOT NULL,
        statement    TEXT NOT NULL,
        rationale    TEXT,
        alternatives TEXT NOT NULL DEFAULT '[]',
        status       TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'superseded')),
        confirmed_by TEXT,
        supersedes   TEXT,
        superseded_by TEXT,
        spans        TEXT NOT NULL,
        run_id       TEXT NOT NULL REFERENCES extraction_runs(id),
        created_at   TEXT NOT NULL,
        CHECK (status <> 'confirmed' OR confirmed_by IS NOT NULL)
      ) STRICT;
      CREATE INDEX decisions_project_topic ON decisions (project_id, topic, status);

      CREATE TABLE rejected_candidates (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        run_id     TEXT NOT NULL REFERENCES extraction_runs(id),
        reason     TEXT NOT NULL,
        candidate  TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      -- Dependency edges from derived records to evidence (used by later deletion work).
      CREATE TABLE record_sources (
        project_id TEXT NOT NULL,
        record_id  TEXT NOT NULL,
        source_id  TEXT NOT NULL REFERENCES sources(id),
        PRIMARY KEY (record_id, source_id)
      ) STRICT;
      CREATE INDEX record_sources_source ON record_sources (project_id, source_id);

      -- Lexical index (CL-005). Every row carries its project; queries always filter on it.
      CREATE VIRTUAL TABLE memory_fts USING fts5(
        text, project_id UNINDEXED, record_id UNINDEXED, kind UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Routing traces (CL-003): metadata only, never prompt or response text.
      CREATE TABLE routing_traces (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL,
        task          TEXT NOT NULL,
        provider      TEXT NOT NULL,
        model         TEXT,
        attempt       INTEGER NOT NULL,
        outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'skipped')),
        category      TEXT,
        reason        TEXT NOT NULL,
        latency_ms    INTEGER,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        cost_usd      REAL,
        at            TEXT NOT NULL
      ) STRICT;
      CREATE INDEX routing_traces_project ON routing_traces (project_id, at);

      CREATE TABLE project_state (
        project_id TEXT NOT NULL REFERENCES projects(id),
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key)
      ) STRICT;

      -- Acceptance (CL-007, CL-008) ------------------------------------------
      CREATE TABLE pack_activations (
        project_id   TEXT NOT NULL REFERENCES projects(id),
        pack_id      TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, pack_id)
      ) STRICT;

      CREATE TABLE answers (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id),
        pack_id       TEXT NOT NULL,
        question_key  TEXT NOT NULL,
        value         TEXT NOT NULL,
        origin        TEXT NOT NULL CHECK (origin IN ('stated', 'inferred')),
        answered_by   TEXT NOT NULL,
        answered_at   TEXT NOT NULL,
        question_hash TEXT NOT NULL,
        note          TEXT,
        UNIQUE (project_id, pack_id, question_key)
      ) STRICT;

      CREATE TABLE evidence (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id),
        criterion_id    TEXT NOT NULL,
        result          TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'inconclusive')),
        revision        TEXT NOT NULL,
        env_kind        TEXT NOT NULL,
        env_description TEXT,
        artifact_ref    TEXT,
        recorded_by     TEXT NOT NULL,
        collected_at    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX evidence_criterion ON evidence (project_id, criterion_id, collected_at);

      CREATE TABLE criterion_dispositions (
        project_id   TEXT NOT NULL REFERENCES projects(id),
        criterion_id TEXT NOT NULL,
        disposition  TEXT NOT NULL CHECK (disposition IN ('accepted', 'waived')),
        actor        TEXT NOT NULL,
        reason       TEXT,
        at           TEXT NOT NULL,
        PRIMARY KEY (project_id, criterion_id),
        CHECK (disposition <> 'waived' OR (reason IS NOT NULL AND length(trim(reason)) > 0))
      ) STRICT;

      -- Artifacts (CL-006) -----------------------------------------------------
      CREATE TABLE artifacts (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id),
        type         TEXT NOT NULL,
        name         TEXT NOT NULL,
        revision     INTEGER NOT NULL CHECK (revision > 0),
        path         TEXT NOT NULL,
        input_hash   TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_ids   TEXT NOT NULL,
        record_ids   TEXT NOT NULL,
        generator    TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        UNIQUE (project_id, name, revision)
      ) STRICT;

      -- Tasks and synchronization (CL-010) ----------------------------------
      CREATE TABLE tasks (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES projects(id),
        origin        TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT,
        status        TEXT NOT NULL CHECK (status IN ('open', 'in-progress', 'closed')),
        criterion_ids TEXT NOT NULL DEFAULT '[]',
        depends_on    TEXT NOT NULL DEFAULT '[]',
        revision      INTEGER NOT NULL CHECK (revision > 0),
        content_hash  TEXT NOT NULL,
        retired       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sync_mappings (
        id                   TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(id),
        task_id              TEXT NOT NULL REFERENCES tasks(id),
        adapter              TEXT NOT NULL,
        adapter_version      TEXT NOT NULL,
        external_id          TEXT NOT NULL,
        idempotency_key      TEXT NOT NULL,
        last_local_revision  INTEGER NOT NULL,
        last_remote_revision TEXT,
        linked_deps          TEXT NOT NULL DEFAULT '[]',
        synced_at            TEXT NOT NULL,
        UNIQUE (project_id, adapter, task_id),
        UNIQUE (project_id, adapter, external_id),
        UNIQUE (project_id, adapter, idempotency_key)
      ) STRICT;

      -- Written before every external write; a pending row after a crash means "reconcile before retrying".
      CREATE TABLE sync_intents (
        project_id      TEXT NOT NULL REFERENCES projects(id),
        adapter         TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation       TEXT NOT NULL,
        task_id         TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
        started_at      TEXT NOT NULL,
        finished_at     TEXT,
        PRIMARY KEY (project_id, adapter, idempotency_key, operation)
      ) STRICT;

      CREATE TABLE sync_runs (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        adapter     TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'error')),
        summary     TEXT,
        started_at  TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "review-cache-embeddings-two-way-sync",
    sql: `
      -- Conflict review (CL-013): possible contradictions waiting for a person.
      CREATE TABLE review_items (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        kind        TEXT NOT NULL,
        record_ids  TEXT NOT NULL,
        detail      TEXT NOT NULL,
        status      TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
        resolution  TEXT,
        resolved_by TEXT,
        created_at  TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (project_id, kind, record_ids)
      ) STRICT;

      -- Caches (CL-015). Keys always include the project; values never cross projects.
      CREATE TABLE cache_entries (
        project_id  TEXT NOT NULL REFERENCES projects(id),
        namespace   TEXT NOT NULL,
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        hits        INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        last_hit_at TEXT,
        PRIMARY KEY (project_id, namespace, key)
      ) STRICT;

      CREATE TABLE embeddings (
        project_id   TEXT NOT NULL REFERENCES projects(id),
        record_id    TEXT NOT NULL,
        model        TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        vector       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, record_id, model)
      ) STRICT;

      -- Transform outputs (CL-016), keyed by content hash and transformer version.
      CREATE TABLE transforms (
        project_id   TEXT NOT NULL REFERENCES projects(id),
        content_hash TEXT NOT NULL,
        transformer  TEXT NOT NULL,
        version      TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('transformed', 'fallback')),
        output       TEXT NOT NULL,
        report       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (project_id, content_hash, transformer, version)
      ) STRICT;

      -- Pack provenance (CL-018): dispositions remember the criterion definition they were made against.
      ALTER TABLE pack_activations ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin';
      ALTER TABLE criterion_dispositions ADD COLUMN pack_version TEXT;
      ALTER TABLE criterion_dispositions ADD COLUMN criterion_hash TEXT;
      ALTER TABLE evidence ADD COLUMN importer TEXT;
      ALTER TABLE evidence ADD COLUMN import_ref TEXT;

      -- Two-way sync (CL-019): remote edits kept for resolution.
      ALTER TABLE tasks ADD COLUMN remote_title TEXT;
      ALTER TABLE tasks ADD COLUMN remote_description TEXT;
      ALTER TABLE tasks ADD COLUMN resolution TEXT CHECK (resolution IS NULL OR resolution IN ('keep-local', 'keep-remote'));
    `,
  },
  {
    version: 4,
    name: "plugin-documents",
    sql: `
      CREATE TABLE plugin_documents (
        project_id TEXT NOT NULL REFERENCES projects(id),
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        value TEXT NOT NULL,
        actor TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
        PRIMARY KEY(project_id,namespace,key,revision)
      ) STRICT;
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
