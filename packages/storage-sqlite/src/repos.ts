import { LoomError, contentHash, newId, stableId } from "@ai-plugin-toolkit/core";
import { type Db, type Row, json, now, parseJson, str } from "./db.js";

// ---- Project state -------------------------------------------------------------

/** Small key/value state per project (e.g. the current build revision used for staleness). */
export class StateRepo {
  constructor(private readonly db: Db) {}

  get(projectId: string, key: string): string | undefined {
    return str(this.db.get("SELECT value FROM project_state WHERE project_id = ? AND key = ?", projectId, key)?.value);
  }

  set(projectId: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO project_state (project_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      projectId,
      key,
      value,
      now(),
    );
  }
}

// ---- Routing traces -------------------------------------------------------------

export interface RoutingTraceRecord {
  task: string;
  provider: string;
  model?: string | undefined;
  attempt: number;
  outcome: "ok" | "error" | "skipped";
  category?: string | undefined;
  reason: string;
  latencyMs?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  costUsd?: number | null | undefined;
  at: string;
}

export class RoutingRepo {
  constructor(private readonly db: Db) {}

  insert(projectId: string, trace: RoutingTraceRecord): void {
    this.db.run(
      `INSERT INTO routing_traces (id, project_id, task, provider, model, attempt, outcome, category, reason, latency_ms,
         input_tokens, output_tokens, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("job"),
      projectId,
      trace.task,
      trace.provider,
      trace.model ?? null,
      trace.attempt,
      trace.outcome,
      trace.category ?? null,
      trace.reason,
      trace.latencyMs ?? null,
      trace.inputTokens ?? null,
      trace.outputTokens ?? null,
      trace.costUsd ?? null,
      trace.at,
    );
  }

  /** Totals per routing task. Cost is null when any attempt had unknown pricing. */
  summary(projectId: string): Array<{ task: string; calls: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number | null }> {
    return this.db
      .all(
        `SELECT task, SUM(outcome = 'ok') AS calls, SUM(outcome = 'error') AS errors, SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(output_tokens, 0)) AS output_tokens, SUM(cost_usd) AS cost, SUM(outcome = 'ok' AND cost_usd IS NULL) AS unknown
         FROM routing_traces WHERE project_id = ? AND outcome <> 'skipped' GROUP BY task ORDER BY task`,
        projectId,
      )
      .map((r) => ({
        task: String(r.task),
        calls: Number(r.calls),
        errors: Number(r.errors),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        costUsd: Number(r.unknown) > 0 ? null : Number(r.cost ?? 0),
      }));
  }

  list(projectId: string, limit = 200): RoutingTraceRecord[] {
    return this.db
      .all("SELECT * FROM routing_traces WHERE project_id = ? ORDER BY rowid DESC LIMIT ?", projectId, limit)
      .reverse()
      .map((r) => ({
        task: String(r.task),
        provider: String(r.provider),
        model: str(r.model),
        attempt: Number(r.attempt),
        outcome: r.outcome as RoutingTraceRecord["outcome"],
        category: str(r.category),
        reason: String(r.reason),
        latencyMs: r.latency_ms === null ? undefined : Number(r.latency_ms),
        inputTokens: r.input_tokens === null ? undefined : Number(r.input_tokens),
        outputTokens: r.output_tokens === null ? undefined : Number(r.output_tokens),
        costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
        at: String(r.at),
      }));
  }
}

// ---- Acceptance -------------------------------------------------------------------

export interface StoredAnswer {
  id: string;
  packId: string;
  questionKey: string;
  value: string;
  origin: "stated" | "inferred";
  answeredBy: string;
  answeredAt: string;
  questionHash: string;
  note: string | undefined;
}

export interface StoredEvidence {
  id: string;
  criterionId: string;
  /** Importer that produced it (e.g. "junit-xml/1"), or undefined for `loom evidence add`. */
  importer?: string | undefined;
  importRef?: string | undefined;
  result: "passed" | "failed" | "inconclusive";
  revision: string;
  environment: { kind: string; description?: string };
  artifactRef: string | undefined;
  recordedBy: string;
  collectedAt: string;
}

export interface StoredDisposition {
  criterionId: string;
  disposition: "accepted" | "waived";
  actor: string;
  reason: string | undefined;
  at: string;
  packVersion?: string | undefined;
  criterionHash?: string | undefined;
}

function rowToAnswer(r: Row): StoredAnswer {
  return {
    id: String(r.id),
    packId: String(r.pack_id),
    questionKey: String(r.question_key),
    value: String(r.value),
    origin: r.origin as StoredAnswer["origin"],
    answeredBy: String(r.answered_by),
    answeredAt: String(r.answered_at),
    questionHash: String(r.question_hash),
    note: str(r.note),
  };
}

function rowToEvidence(r: Row): StoredEvidence {
  const description = str(r.env_description);
  return {
    id: String(r.id),
    criterionId: String(r.criterion_id),
    result: r.result as StoredEvidence["result"],
    revision: String(r.revision),
    environment: description === undefined ? { kind: String(r.env_kind) } : { kind: String(r.env_kind), description },
    artifactRef: str(r.artifact_ref),
    recordedBy: String(r.recorded_by),
    collectedAt: String(r.collected_at),
    importer: str(r.importer),
    importRef: str(r.import_ref),
  };
}

export class AcceptanceRepo {
  constructor(private readonly db: Db) {}

  activatePack(projectId: string, packId: string, packVersion: string, source = "builtin"): void {
    this.db.run(
      `INSERT INTO pack_activations (project_id, pack_id, pack_version, activated_at, source) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, pack_id) DO UPDATE SET pack_version = excluded.pack_version, source = excluded.source`,
      projectId,
      packId,
      packVersion,
      now(),
      source,
    );
  }

  activePacks(projectId: string): Array<{ packId: string; packVersion: string; activatedAt: string; source: string }> {
    return this.db
      .all("SELECT * FROM pack_activations WHERE project_id = ? ORDER BY activated_at, pack_id", projectId)
      .map((r) => ({ packId: String(r.pack_id), packVersion: String(r.pack_version), activatedAt: String(r.activated_at), source: String(r.source) }));
  }

  setAnswer(
    projectId: string,
    input: Omit<StoredAnswer, "id" | "answeredAt" | "note"> & { note?: string | undefined },
  ): StoredAnswer {
    const id = stableId("question", projectId, input.packId, input.questionKey);
    this.db.run(
      `INSERT INTO answers (id, project_id, pack_id, question_key, value, origin, answered_by, answered_at, question_hash, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, pack_id, question_key) DO UPDATE SET value = excluded.value, origin = excluded.origin,
         answered_by = excluded.answered_by, answered_at = excluded.answered_at, question_hash = excluded.question_hash, note = excluded.note`,
      id,
      projectId,
      input.packId,
      input.questionKey,
      input.value,
      input.origin,
      input.answeredBy,
      now(),
      input.questionHash,
      input.note ?? null,
    );
    return rowToAnswer(this.db.get("SELECT * FROM answers WHERE id = ?", id)!);
  }

  answers(projectId: string, packId: string): StoredAnswer[] {
    return this.db
      .all("SELECT * FROM answers WHERE project_id = ? AND pack_id = ? ORDER BY question_key", projectId, packId)
      .map(rowToAnswer);
  }

  /** True when this import (same file content) already produced evidence for the criterion. */
  hasImported(projectId: string, criterionId: string, importRef: string): boolean {
    return this.db.get("SELECT 1 FROM evidence WHERE project_id = ? AND criterion_id = ? AND import_ref = ?", projectId, criterionId, importRef) !== undefined;
  }

  addEvidence(projectId: string, input: Omit<StoredEvidence, "id" | "collectedAt"> & { collectedAt?: string }): StoredEvidence {
    const id = newId("evidence");
    this.db.run(
      `INSERT INTO evidence (id, project_id, criterion_id, result, revision, env_kind, env_description, artifact_ref, recorded_by, collected_at, importer, import_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      input.criterionId,
      input.result,
      input.revision,
      input.environment.kind,
      input.environment.description ?? null,
      input.artifactRef ?? null,
      input.recordedBy,
      input.collectedAt ?? now(),
      input.importer ?? null,
      input.importRef ?? null,
    );
    return rowToEvidence(this.db.get("SELECT * FROM evidence WHERE id = ?", id)!);
  }

  evidence(projectId: string): StoredEvidence[] {
    return this.db
      .all("SELECT * FROM evidence WHERE project_id = ? ORDER BY collected_at, rowid", projectId)
      .map(rowToEvidence);
  }

  setDisposition(projectId: string, input: Omit<StoredDisposition, "at">): void {
    if (input.disposition === "waived" && (input.reason === undefined || input.reason.trim() === "")) {
      throw new LoomError("VALIDATION_FAILED", "A waiver needs a reason.");
    }
    this.db.run(
      `INSERT INTO criterion_dispositions (project_id, criterion_id, disposition, actor, reason, at, pack_version, criterion_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, criterion_id) DO UPDATE SET disposition = excluded.disposition, actor = excluded.actor,
         reason = excluded.reason, at = excluded.at, pack_version = excluded.pack_version, criterion_hash = excluded.criterion_hash`,
      projectId,
      input.criterionId,
      input.disposition,
      input.actor,
      input.reason ?? null,
      now(),
      input.packVersion ?? null,
      input.criterionHash ?? null,
    );
  }

  clearDisposition(projectId: string, criterionId: string): void {
    this.db.run("DELETE FROM criterion_dispositions WHERE project_id = ? AND criterion_id = ?", projectId, criterionId);
  }

  dispositions(projectId: string): StoredDisposition[] {
    return this.db.all("SELECT * FROM criterion_dispositions WHERE project_id = ?", projectId).map((r) => ({
      criterionId: String(r.criterion_id),
      disposition: r.disposition as StoredDisposition["disposition"],
      actor: String(r.actor),
      reason: str(r.reason),
      at: String(r.at),
      packVersion: str(r.pack_version),
      criterionHash: str(r.criterion_hash),
    }));
  }
}

// ---- Artifacts ----------------------------------------------------------------------

export interface StoredArtifact {
  id: string;
  type: string;
  name: string;
  revision: number;
  path: string;
  inputHash: string;
  contentHash: string;
  sourceIds: string[];
  recordIds: string[];
  generator: { name: string; version: string; model?: string };
  createdAt: string;
}

function rowToArtifact(r: Row): StoredArtifact {
  return {
    id: String(r.id),
    type: String(r.type),
    name: String(r.name),
    revision: Number(r.revision),
    path: String(r.path),
    inputHash: String(r.input_hash),
    contentHash: String(r.content_hash),
    sourceIds: parseJson<string[]>(r.source_ids, []),
    recordIds: parseJson<string[]>(r.record_ids, []),
    generator: parseJson(r.generator, { name: "unknown", version: "0" }),
    createdAt: String(r.created_at),
  };
}

export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  latest(projectId: string, name: string): StoredArtifact | undefined {
    const row = this.db.get(
      "SELECT * FROM artifacts WHERE project_id = ? AND name = ? ORDER BY revision DESC LIMIT 1",
      projectId,
      name,
    );
    return row === undefined ? undefined : rowToArtifact(row);
  }

  insert(projectId: string, input: Omit<StoredArtifact, "id" | "createdAt">): StoredArtifact {
    const id = stableId("artifact", projectId, input.name, String(input.revision));
    this.db.run(
      `INSERT INTO artifacts (id, project_id, type, name, revision, path, input_hash, content_hash, source_ids, record_ids, generator, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      input.type,
      input.name,
      input.revision,
      input.path,
      input.inputHash,
      input.contentHash,
      json(input.sourceIds),
      json(input.recordIds),
      json(input.generator),
      now(),
    );
    return rowToArtifact(this.db.get("SELECT * FROM artifacts WHERE id = ?", id)!);
  }

  listLatest(projectId: string): StoredArtifact[] {
    return this.db
      .all(
        `SELECT a.* FROM artifacts a JOIN (SELECT name, MAX(revision) AS rev FROM artifacts WHERE project_id = ? GROUP BY name) l
           ON a.name = l.name AND a.revision = l.rev WHERE a.project_id = ? ORDER BY a.name`,
        projectId,
        projectId,
      )
      .map(rowToArtifact);
  }
}

// ---- Tasks and sync ------------------------------------------------------------------

export interface LocalTask {
  id: string;
  origin: string;
  title: string;
  description: string | undefined;
  status: "open" | "in-progress" | "closed";
  criterionIds: string[];
  dependsOn: string[];
  revision: number;
  contentHash: string;
  retired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SyncMappingRecord {
  id: string;
  taskId: string;
  adapter: string;
  adapterVersion: string;
  externalId: string;
  idempotencyKey: string;
  lastLocalRevision: number;
  lastRemoteRevision: string | undefined;
  linkedDeps: string[];
  syncedAt: string;
}

export interface SyncIntent {
  idempotencyKey: string;
  operation: string;
  taskId: string;
  status: "pending" | "done" | "failed";
  startedAt: string;
}

function rowToTask(r: Row): LocalTask {
  return {
    id: String(r.id),
    origin: String(r.origin),
    title: String(r.title),
    description: str(r.description),
    status: r.status as LocalTask["status"],
    criterionIds: parseJson<string[]>(r.criterion_ids, []),
    dependsOn: parseJson<string[]>(r.depends_on, []),
    revision: Number(r.revision),
    contentHash: String(r.content_hash),
    retired: Number(r.retired) === 1,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function rowToMapping(r: Row): SyncMappingRecord {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    adapter: String(r.adapter),
    adapterVersion: String(r.adapter_version),
    externalId: String(r.external_id),
    idempotencyKey: String(r.idempotency_key),
    lastLocalRevision: Number(r.last_local_revision),
    lastRemoteRevision: str(r.last_remote_revision),
    linkedDeps: parseJson<string[]>(r.linked_deps, []),
    syncedAt: String(r.synced_at),
  };
}

export class TaskRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert or update a locally generated task. The revision increases only when
   * title/description/links actually change, so regenerating is idempotent.
   */
  upsert(
    projectId: string,
    input: { id: string; origin: string; title: string; description?: string; criterionIds: string[]; dependsOn: string[] },
  ): { task: LocalTask; change: "created" | "updated" | "unchanged" } {
    const hash = contentHash(json([input.title, input.description ?? "", input.criterionIds, input.dependsOn]));
    return this.db.transaction(() => {
      const existing = this.get(projectId, input.id);
      const at = now();
      if (existing === undefined) {
        this.db.run(
          `INSERT INTO tasks (id, project_id, origin, title, description, status, criterion_ids, depends_on, revision, content_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?)`,
          input.id,
          projectId,
          input.origin,
          input.title,
          input.description ?? null,
          json(input.criterionIds),
          json(input.dependsOn),
          hash,
          at,
          at,
        );
        return { task: this.get(projectId, input.id)!, change: "created" as const };
      }
      if (existing.contentHash === hash && !existing.retired) return { task: existing, change: "unchanged" as const };
      this.db.run(
        `UPDATE tasks SET title = ?, description = ?, criterion_ids = ?, depends_on = ?, content_hash = ?, retired = 0,
           revision = revision + ?, updated_at = ? WHERE project_id = ? AND id = ?`,
        input.title,
        input.description ?? null,
        json(input.criterionIds),
        json(input.dependsOn),
        hash,
        existing.contentHash === hash ? 0 : 1,
        at,
        projectId,
        input.id,
      );
      return { task: this.get(projectId, input.id)!, change: "updated" as const };
    });
  }

  /** Tasks no longer produced by planning are retired locally, never deleted remotely. */
  retire(projectId: string, id: string): void {
    this.db.run("UPDATE tasks SET retired = 1, updated_at = ? WHERE project_id = ? AND id = ?", now(), projectId, id);
  }

  setStatusFromRemote(projectId: string, id: string, status: LocalTask["status"]): void {
    this.db.run("UPDATE tasks SET status = ? WHERE project_id = ? AND id = ?", status, projectId, id);
  }

  get(projectId: string, id: string): LocalTask | undefined {
    const row = this.db.get("SELECT * FROM tasks WHERE project_id = ? AND id = ?", projectId, id);
    return row === undefined ? undefined : rowToTask(row);
  }

  list(projectId: string, options: { includeRetired?: boolean } = {}): LocalTask[] {
    const filter = options.includeRetired ? "" : "AND retired = 0";
    return this.db.all(`SELECT * FROM tasks WHERE project_id = ? ${filter} ORDER BY created_at, id`, projectId).map(rowToTask);
  }

  mapping(projectId: string, adapter: string, taskId: string): SyncMappingRecord | undefined {
    const row = this.db.get(
      "SELECT * FROM sync_mappings WHERE project_id = ? AND adapter = ? AND task_id = ?",
      projectId,
      adapter,
      taskId,
    );
    return row === undefined ? undefined : rowToMapping(row);
  }

  mappings(projectId: string, adapter: string): SyncMappingRecord[] {
    return this.db
      .all("SELECT * FROM sync_mappings WHERE project_id = ? AND adapter = ? ORDER BY synced_at, id", projectId, adapter)
      .map(rowToMapping);
  }

  saveMapping(
    projectId: string,
    input: Omit<SyncMappingRecord, "id" | "syncedAt">,
  ): SyncMappingRecord {
    const id = stableId("syncMapping", projectId, input.adapter, input.taskId);
    this.db.run(
      `INSERT INTO sync_mappings (id, project_id, task_id, adapter, adapter_version, external_id, idempotency_key,
         last_local_revision, last_remote_revision, linked_deps, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, adapter, task_id) DO UPDATE SET adapter_version = excluded.adapter_version,
         external_id = excluded.external_id, last_local_revision = excluded.last_local_revision,
         last_remote_revision = excluded.last_remote_revision, linked_deps = excluded.linked_deps, synced_at = excluded.synced_at`,
      id,
      projectId,
      input.taskId,
      input.adapter,
      input.adapterVersion,
      input.externalId,
      input.idempotencyKey,
      input.lastLocalRevision,
      input.lastRemoteRevision ?? null,
      json(input.linkedDeps),
      now(),
    );
    return this.mapping(projectId, input.adapter, input.taskId)!;
  }

  beginIntent(projectId: string, adapter: string, intent: { idempotencyKey: string; operation: string; taskId: string }): void {
    this.db.run(
      `INSERT INTO sync_intents (project_id, adapter, idempotency_key, operation, task_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (project_id, adapter, idempotency_key, operation) DO UPDATE SET status = 'pending', started_at = excluded.started_at`,
      projectId,
      adapter,
      intent.idempotencyKey,
      intent.operation,
      intent.taskId,
      now(),
    );
  }

  finishIntent(projectId: string, adapter: string, idempotencyKey: string, operation: string, status: "done" | "failed"): void {
    this.db.run(
      `UPDATE sync_intents SET status = ?, finished_at = ? WHERE project_id = ? AND adapter = ? AND idempotency_key = ? AND operation = ?`,
      status,
      now(),
      projectId,
      adapter,
      idempotencyKey,
      operation,
    );
  }

  pendingIntents(projectId: string, adapter: string): SyncIntent[] {
    return this.db
      .all("SELECT * FROM sync_intents WHERE project_id = ? AND adapter = ? AND status = 'pending' ORDER BY started_at", projectId, adapter)
      .map((r) => ({
        idempotencyKey: String(r.idempotency_key),
        operation: String(r.operation),
        taskId: String(r.task_id),
        status: "pending" as const,
        startedAt: String(r.started_at),
      }));
  }

  startRun(projectId: string, adapter: string): string {
    const id = newId("job");
    this.db.run(
      "INSERT INTO sync_runs (id, project_id, adapter, status, started_at) VALUES (?, ?, ?, 'running', ?)",
      id,
      projectId,
      adapter,
      now(),
    );
    return id;
  }

  finishRun(runId: string, status: "ok" | "partial" | "error", summary: unknown): void {
    this.db.run("UPDATE sync_runs SET status = ?, summary = ?, finished_at = ? WHERE id = ?", status, json(summary), now(), runId);
  }

  runs(projectId: string): Array<{ id: string; adapter: string; status: string; summary: unknown; startedAt: string }> {
    return this.db.all("SELECT * FROM sync_runs WHERE project_id = ? ORDER BY started_at, rowid", projectId).map((r) => ({
      id: String(r.id),
      adapter: String(r.adapter),
      status: String(r.status),
      summary: parseJson<unknown>(r.summary, null),
      startedAt: String(r.started_at),
    }));
  }
}

// ---- Caches (CL-015) -----------------------------------------------------------

export interface CacheStats {
  namespace: string;
  entries: number;
  bytes: number;
  hits: number;
}

/**
 * Project-scoped key/value cache. Callers build keys from everything that can change
 * the answer (query, scope, permission and memory revisions); this repo never mixes
 * projects and never decides validity itself.
 */
export class CacheRepo {
  constructor(private readonly db: Db) {}

  get(projectId: string, namespace: string, key: string): string | undefined {
    const row = this.db.get("SELECT value FROM cache_entries WHERE project_id = ? AND namespace = ? AND key = ?", projectId, namespace, key);
    if (row === undefined) return undefined;
    this.db.run(
      "UPDATE cache_entries SET hits = hits + 1, last_hit_at = ? WHERE project_id = ? AND namespace = ? AND key = ?",
      now(),
      projectId,
      namespace,
      key,
    );
    return String(row.value);
  }

  put(projectId: string, namespace: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO cache_entries (project_id, namespace, key, value, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, namespace, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, created_at = excluded.created_at`,
      projectId,
      namespace,
      key,
      value,
      Buffer.byteLength(value, "utf8"),
      now(),
    );
  }

  /** Drop entries for a project (optionally one namespace). Returns the number removed. */
  clear(projectId: string, namespace?: string): number {
    return namespace === undefined
      ? this.db.run("DELETE FROM cache_entries WHERE project_id = ?", projectId).changes
      : this.db.run("DELETE FROM cache_entries WHERE project_id = ? AND namespace = ?", projectId, namespace).changes;
  }

  stats(projectId: string): CacheStats[] {
    return this.db
      .all(
        "SELECT namespace, COUNT(*) AS entries, SUM(bytes) AS bytes, SUM(hits) AS hits FROM cache_entries WHERE project_id = ? GROUP BY namespace ORDER BY namespace",
        projectId,
      )
      .map((r) => ({ namespace: String(r.namespace), entries: Number(r.entries), bytes: Number(r.bytes ?? 0), hits: Number(r.hits ?? 0) }));
  }

  // Transform outputs (CL-016) live next to caches: same project scoping, versioned keys.
  getTransform(projectId: string, hash: string, transformer: string, version: string): { status: string; output: string; report: unknown } | undefined {
    const row = this.db.get(
      "SELECT status, output, report FROM transforms WHERE project_id = ? AND content_hash = ? AND transformer = ? AND version = ?",
      projectId,
      hash,
      transformer,
      version,
    );
    return row === undefined ? undefined : { status: String(row.status), output: String(row.output), report: parseJson<unknown>(row.report, null) };
  }

  putTransform(projectId: string, input: { hash: string; transformer: string; version: string; status: "transformed" | "fallback"; output: string; report: unknown }): void {
    this.db.run(
      `INSERT INTO transforms (project_id, content_hash, transformer, version, status, output, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, content_hash, transformer, version) DO UPDATE SET status = excluded.status, output = excluded.output, report = excluded.report`,
      projectId,
      input.hash,
      input.transformer,
      input.version,
      input.status,
      input.output,
      json(input.report),
      now(),
    );
  }

  clearTransforms(projectId: string): number {
    return this.db.run("DELETE FROM transforms WHERE project_id = ?", projectId).changes;
  }
}
