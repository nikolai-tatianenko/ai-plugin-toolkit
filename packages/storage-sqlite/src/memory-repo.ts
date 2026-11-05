import {
  DecisionSchema,
  FactSchema,
  LoomError,
  newId,
  parseWith,
  type Decision,
  type Fact,
  type SourceSpan,
} from "@ai-plugin-toolkit/core";
import { type Db, type Row, json, now, parseJson, str } from "./db.js";

export type MemoryKind = "fact" | "decision" | "source";

export interface ExtractionRun {
  id: string;
  projectId: string;
  sourceId: string;
  promptVersion: string;
  provider: string | undefined;
  model: string | undefined;
  status: "running" | "ok" | "error";
  accepted: number;
  rejected: number;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  costUsd: number | null;
  errorCode: string | undefined;
  startedAt: string;
  finishedAt: string | undefined;
}

export interface RejectedCandidate {
  id: string;
  runId: string;
  reason: string;
  candidate: unknown;
  createdAt: string;
}

export interface ReviewItem {
  id: string;
  kind: string;
  recordIds: string[];
  detail: string;
  status: "open" | "resolved" | "dismissed";
  resolution: string | undefined;
  resolvedBy: string | undefined;
  createdAt: string;
}

export interface FtsHit {
  recordId: string;
  kind: MemoryKind;
  text: string;
  score: number;
}

function rowToFact(row: Row): Fact {
  return parseWith(
    FactSchema,
    {
      id: row.id,
      projectId: row.project_id,
      statement: row.statement,
      kind: row.kind,
      spans: parseJson<SourceSpan[]>(row.spans, []),
      status: row.status,
      ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
      createdAt: row.created_at,
    },
    "stored fact",
  );
}

function rowToDecision(row: Row): Decision & { statement: string; supersededBy?: string } {
  const decision = parseWith(
    DecisionSchema,
    {
      id: row.id,
      projectId: row.project_id,
      choice: row.choice,
      ...(row.topic === null ? {} : { topic: row.topic }),
      ...(row.rationale === null ? {} : { rationale: row.rationale }),
      alternatives: parseJson<string[]>(row.alternatives, []),
      status: row.status,
      ...(row.confirmed_by === null ? {} : { confirmedBy: row.confirmed_by }),
      ...(row.supersedes === null ? {} : { supersedes: row.supersedes }),
      spans: parseJson<SourceSpan[]>(row.spans, []),
      createdAt: row.created_at,
    },
    "stored decision",
  );
  return {
    ...decision,
    statement: String(row.statement),
    ...(row.superseded_by === null ? {} : { supersededBy: String(row.superseded_by) }),
  };
}

export type StoredDecision = ReturnType<typeof rowToDecision>;

function rowToRun(row: Row): ExtractionRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sourceId: String(row.source_id),
    promptVersion: String(row.prompt_version),
    provider: str(row.provider),
    model: str(row.model),
    status: row.status as ExtractionRun["status"],
    accepted: Number(row.accepted),
    rejected: Number(row.rejected),
    inputTokens: row.input_tokens === null ? undefined : Number(row.input_tokens),
    outputTokens: row.output_tokens === null ? undefined : Number(row.output_tokens),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    errorCode: str(row.error_code),
    startedAt: String(row.started_at),
    finishedAt: str(row.finished_at),
  };
}

/** Facts, decisions, extraction runs and the lexical index (L1 memory). */
export class MemoryRepo {
  constructor(private readonly db: Db) {}

  /** Durable job record, committed before any model call so a crash leaves a visible "running" row. */
  startRun(input: { projectId: string; sourceId: string; promptVersion: string; provider?: string; model?: string }): string {
    const id = newId("job");
    this.db.run(
      `INSERT INTO extraction_runs (id, project_id, source_id, prompt_version, provider, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      id,
      input.projectId,
      input.sourceId,
      input.promptVersion,
      input.provider ?? null,
      input.model ?? null,
      now(),
    );
    return id;
  }

  finishRun(
    runId: string,
    outcome: {
      status: "ok" | "error";
      accepted?: number;
      rejected?: number;
      provider?: string;
      model?: string;
      usage?: { inputTokens: number; outputTokens: number; costUsd: number | null };
      errorCode?: string;
    },
  ): void {
    this.db.run(
      `UPDATE extraction_runs SET status = ?, accepted = ?, rejected = ?, provider = COALESCE(?, provider), model = COALESCE(?, model),
         input_tokens = ?, output_tokens = ?, cost_usd = ?, error_code = ?, finished_at = ? WHERE id = ?`,
      outcome.status,
      outcome.accepted ?? 0,
      outcome.rejected ?? 0,
      outcome.provider ?? null,
      outcome.model ?? null,
      outcome.usage?.inputTokens ?? null,
      outcome.usage?.outputTokens ?? null,
      outcome.usage?.costUsd ?? null,
      outcome.errorCode ?? null,
      now(),
      runId,
    );
  }

  lastSuccessfulRun(projectId: string, sourceId: string, promptVersion: string): ExtractionRun | undefined {
    const row = this.db.get(
      `SELECT * FROM extraction_runs WHERE project_id = ? AND source_id = ? AND prompt_version = ? AND status = 'ok'
       ORDER BY started_at DESC, id DESC LIMIT 1`,
      projectId,
      sourceId,
      promptVersion,
    );
    return row === undefined ? undefined : rowToRun(row);
  }

  listRuns(projectId: string): ExtractionRun[] {
    return this.db.all("SELECT * FROM extraction_runs WHERE project_id = ? ORDER BY started_at, id", projectId).map(rowToRun);
  }

  /** Insert a validated fact. Idempotent by ID; returns false when it already existed. */
  insertFact(fact: Fact, runId: string): boolean {
    const valid = parseWith(FactSchema, fact, "fact");
    return this.db.transaction(() => {
      const { changes } = this.db.run(
        `INSERT INTO facts (id, project_id, kind, statement, status, superseded_by, spans, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        valid.id,
        valid.projectId,
        valid.kind,
        valid.statement,
        valid.status,
        valid.supersededBy ?? null,
        json(valid.spans),
        runId,
        valid.createdAt,
      );
      if (changes > 0) {
        this.index(valid.projectId, valid.id, "fact", valid.statement);
        this.linkSources(valid.projectId, valid.id, valid.spans);
        this.bump(valid.projectId);
      }
      return changes > 0;
    });
  }

  insertDecision(decision: Decision & { statement: string }, runId: string): boolean {
    const { statement: _statement, ...fields } = decision;
    const valid = parseWith(DecisionSchema, fields, "decision");
    return this.db.transaction(() => {
      const { changes } = this.db.run(
        `INSERT INTO decisions (id, project_id, topic, choice, statement, rationale, alternatives, status, confirmed_by, supersedes, spans, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
        valid.id,
        valid.projectId,
        valid.topic ?? null,
        valid.choice,
        decision.statement,
        valid.rationale ?? null,
        json(valid.alternatives),
        valid.status,
        valid.confirmedBy ?? null,
        valid.supersedes ?? null,
        json(valid.spans),
        runId,
        valid.createdAt,
      );
      if (changes > 0) {
        this.index(valid.projectId, valid.id, "decision", [valid.topic, valid.choice, decision.statement].filter(Boolean).join(" — "));
        this.linkSources(valid.projectId, valid.id, valid.spans);
        this.bump(valid.projectId);
      }
      return changes > 0;
    });
  }

  /** Mark `oldId` superseded by `newId`, keeping the old record for history (plan §3 lifecycle). */
  supersedeDecision(projectId: string, oldId: string, newId: string): void {
    this.db.transaction(() => {
      this.db.run(
        "UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE project_id = ? AND id = ? AND status = 'confirmed'",
        newId,
        projectId,
        oldId,
      );
      this.db.run("UPDATE decisions SET supersedes = COALESCE(supersedes, ?) WHERE project_id = ? AND id = ?", oldId, projectId, newId);
      this.bump(projectId);
    });
  }

  setFactStatus(projectId: string, id: string, status: "candidate" | "confirmed" | "rejected"): void {
    const { changes } = this.db.run(
      "UPDATE facts SET status = ? WHERE project_id = ? AND id = ? AND status <> 'superseded'",
      status,
      projectId,
      id,
    );
    if (changes === 0) throw new LoomError("NOT_FOUND", `Fact ${id} not found (or superseded) in project "${projectId}".`);
    this.bump(projectId);
  }

  getFact(projectId: string, id: string): Fact | undefined {
    const row = this.db.get("SELECT * FROM facts WHERE project_id = ? AND id = ?", projectId, id);
    return row === undefined ? undefined : rowToFact(row);
  }

  getDecision(projectId: string, id: string): StoredDecision | undefined {
    const row = this.db.get("SELECT * FROM decisions WHERE project_id = ? AND id = ?", projectId, id);
    return row === undefined ? undefined : rowToDecision(row);
  }

  listFacts(projectId: string, options: { includeInactive?: boolean } = {}): Fact[] {
    const filter = options.includeInactive ? "" : "AND status IN ('candidate', 'confirmed')";
    return this.db.all(`SELECT * FROM facts WHERE project_id = ? ${filter} ORDER BY created_at, id`, projectId).map(rowToFact);
  }

  listDecisions(projectId: string, options: { includeInactive?: boolean } = {}): StoredDecision[] {
    const filter = options.includeInactive ? "" : "AND status IN ('proposed', 'confirmed')";
    return this.db
      .all(`SELECT * FROM decisions WHERE project_id = ? ${filter} ORDER BY created_at, id`, projectId)
      .map(rowToDecision);
  }

  /** Current confirmed decisions on a topic, newest first. */
  confirmedOnTopic(projectId: string, topic: string): StoredDecision[] {
    return this.db
      .all(
        "SELECT * FROM decisions WHERE project_id = ? AND status = 'confirmed' AND lower(topic) = lower(?) ORDER BY created_at DESC, id DESC",
        projectId,
        topic,
      )
      .map(rowToDecision);
  }

  insertRejected(projectId: string, runId: string, reason: string, candidate: unknown): void {
    this.db.run(
      "INSERT INTO rejected_candidates (id, project_id, run_id, reason, candidate, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId("job"),
      projectId,
      runId,
      reason,
      json(candidate),
      now(),
    );
  }

  listRejected(projectId: string): RejectedCandidate[] {
    return this.db
      .all("SELECT * FROM rejected_candidates WHERE project_id = ? ORDER BY rowid", projectId)
      .map((r) => ({
        id: String(r.id),
        runId: String(r.run_id),
        reason: String(r.reason),
        candidate: parseJson<unknown>(r.candidate, null),
        createdAt: String(r.created_at),
      }));
  }

  /**
   * Monotonic memory revision for caches and staleness checks. Every write that changes
   * what retrieval can return (insert, status change, supersession, deletion) bumps it.
   */
  revision(projectId: string): string {
    return String(this.db.get("SELECT value FROM project_state WHERE project_id = ? AND key = 'memory.revision'", projectId)?.value ?? "0");
  }

  bump(projectId: string): void {
    this.db.run(
      `INSERT INTO project_state (project_id, key, value, updated_at) VALUES (?, 'memory.revision', '1', ?)
       ON CONFLICT (project_id, key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at`,
      projectId,
      now(),
    );
  }

  index(projectId: string, recordId: string, kind: MemoryKind, text: string): void {
    this.db.run("DELETE FROM memory_fts WHERE project_id = ? AND record_id = ?", projectId, recordId);
    this.db.run("INSERT INTO memory_fts (text, project_id, record_id, kind) VALUES (?, ?, ?, ?)", text, projectId, recordId, kind);
  }

  isIndexed(projectId: string, recordId: string): boolean {
    return this.db.get("SELECT 1 FROM memory_fts WHERE project_id = ? AND record_id = ?", projectId, recordId) !== undefined;
  }

  /**
   * Full-text search. `match` must already be a safe FTS5 expression (see retrieval's
   * query builder); the project filter is applied in SQL, never after the fact.
   */
  search(projectId: string, match: string, limit: number): FtsHit[] {
    return this.db
      .all(
        `SELECT record_id, kind, text, bm25(memory_fts) AS score FROM memory_fts
         WHERE memory_fts MATCH ? AND project_id = ? ORDER BY score LIMIT ?`,
        match,
        projectId,
        limit,
      )
      .map((r) => ({ recordId: String(r.record_id), kind: r.kind as MemoryKind, text: String(r.text), score: Number(r.score) }));
  }

  // ---- Lifecycle (CL-013) -------------------------------------------------------

  /** Fact and decision IDs that cite a source. */
  recordsCiting(projectId: string, sourceId: string): string[] {
    return this.db
      .all("SELECT record_id FROM record_sources WHERE project_id = ? AND source_id = ? ORDER BY record_id", projectId, sourceId)
      .map((r) => String(r.record_id));
  }

  /** Replace a record's spans (e.g. after one of its sources was forgotten). */
  replaceSpans(projectId: string, id: string, spans: readonly SourceSpan[]): void {
    const table = id.startsWith("fct_") ? "facts" : "decisions";
    this.db.transaction(() => {
      this.db.run(`UPDATE ${table} SET spans = ? WHERE project_id = ? AND id = ?`, json(spans), projectId, id);
      this.db.run("DELETE FROM record_sources WHERE project_id = ? AND record_id = ?", projectId, id);
      this.linkSources(projectId, id, spans);
      this.bump(projectId);
    });
  }

  /** Remove a fact or decision and everything derived from it (index rows, embeddings, links, review items). */
  deleteRecord(projectId: string, id: string): void {
    this.db.transaction(() => {
      const table = id.startsWith("fct_") ? "facts" : "decisions";
      this.db.run(`DELETE FROM ${table} WHERE project_id = ? AND id = ?`, projectId, id);
      this.db.run("DELETE FROM memory_fts WHERE project_id = ? AND record_id = ?", projectId, id);
      this.db.run("DELETE FROM embeddings WHERE project_id = ? AND record_id = ?", projectId, id);
      this.db.run("DELETE FROM record_sources WHERE project_id = ? AND record_id = ?", projectId, id);
      this.db.run("DELETE FROM review_items WHERE project_id = ? AND record_ids LIKE ?", projectId, `%"${id}"%`);
      this.bump(projectId);
    });
  }

  /** Remove extraction runs (and their rejected candidates, which contain quoted text) for a source. */
  deleteRunsForSource(projectId: string, sourceId: string): void {
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM rejected_candidates WHERE project_id = ? AND run_id IN (SELECT id FROM extraction_runs WHERE project_id = ? AND source_id = ?)",
        projectId,
        projectId,
        sourceId,
      );
      // Facts/decisions from these runs that survive (they cite other sources) are re-pointed to keep the FK valid.
      const runs = this.db.all("SELECT id FROM extraction_runs WHERE project_id = ? AND source_id = ?", projectId, sourceId).map((r) => String(r.id));
      for (const run of runs) {
        const survivor = this.db.get("SELECT 1 FROM facts WHERE run_id = ? UNION SELECT 1 FROM decisions WHERE run_id = ?", run, run);
        if (survivor === undefined) this.db.run("DELETE FROM extraction_runs WHERE id = ?", run);
        else this.db.run("UPDATE extraction_runs SET source_id = (SELECT source_id FROM record_sources WHERE project_id = ? AND record_id IN (SELECT id FROM facts WHERE run_id = ? UNION SELECT id FROM decisions WHERE run_id = ?) LIMIT 1) WHERE id = ?", projectId, run, run, run);
      }
    });
  }

  /** Set a decision's status directly (review resolution, supersession repair). */
  setDecisionStatus(projectId: string, id: string, status: "proposed" | "confirmed" | "rejected" | "superseded", supersededBy?: string): void {
    this.db.run(
      "UPDATE decisions SET status = ?, superseded_by = ? WHERE project_id = ? AND id = ?",
      status,
      supersededBy ?? null,
      projectId,
      id,
    );
    this.bump(projectId);
  }

  /** Decisions on a topic in evidence order (oldest first), any status. */
  decisionsOnTopic(projectId: string, topic: string): StoredDecision[] {
    return this.db
      .all("SELECT * FROM decisions WHERE project_id = ? AND lower(topic) = lower(?) ORDER BY created_at, id", projectId, topic)
      .map(rowToDecision);
  }

  // ---- Review items -------------------------------------------------------------

  addReviewItem(projectId: string, input: { kind: string; recordIds: string[]; detail: string }): boolean {
    const ids = json([...input.recordIds].sort());
    const { changes } = this.db.run(
      `INSERT INTO review_items (id, project_id, kind, record_ids, detail, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)
       ON CONFLICT (project_id, kind, record_ids) DO NOTHING`,
      newId("job"),
      projectId,
      input.kind,
      ids,
      input.detail,
      now(),
    );
    return changes > 0;
  }

  reviewItems(projectId: string, options: { all?: boolean } = {}): ReviewItem[] {
    return this.db
      .all(`SELECT * FROM review_items WHERE project_id = ? ${options.all ? "" : "AND status = 'open'"} ORDER BY created_at, id`, projectId)
      .map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        recordIds: parseJson<string[]>(r.record_ids, []),
        detail: String(r.detail),
        status: r.status as ReviewItem["status"],
        resolution: str(r.resolution),
        resolvedBy: str(r.resolved_by),
        createdAt: String(r.created_at),
      }));
  }

  closeReviewItem(projectId: string, id: string, status: "resolved" | "dismissed", resolution: string, actor: string): void {
    const { changes } = this.db.run(
      "UPDATE review_items SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE project_id = ? AND id = ? AND status = 'open'",
      status,
      resolution,
      actor,
      now(),
      projectId,
      id,
    );
    if (changes === 0) throw new LoomError("NOT_FOUND", `No open review item ${id} in project "${projectId}".`);
  }

  // ---- Embeddings (CL-015) ---------------------------------------------------------

  putEmbedding(projectId: string, recordId: string, model: string, hash: string, vector: readonly number[]): void {
    this.db.run(
      `INSERT INTO embeddings (project_id, record_id, model, content_hash, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, record_id, model) DO UPDATE SET content_hash = excluded.content_hash, vector = excluded.vector, created_at = excluded.created_at`,
      projectId,
      recordId,
      model,
      hash,
      json(vector),
      now(),
    );
  }

  embedding(projectId: string, recordId: string, model: string): { hash: string; vector: number[] } | undefined {
    const row = this.db.get("SELECT content_hash, vector FROM embeddings WHERE project_id = ? AND record_id = ? AND model = ?", projectId, recordId, model);
    return row === undefined ? undefined : { hash: String(row.content_hash), vector: parseJson<number[]>(row.vector, []) };
  }

  embeddings(projectId: string, model: string): Array<{ recordId: string; vector: number[] }> {
    return this.db
      .all("SELECT record_id, vector FROM embeddings WHERE project_id = ? AND model = ?", projectId, model)
      .map((r) => ({ recordId: String(r.record_id), vector: parseJson<number[]>(r.vector, []) }));
  }

  private linkSources(projectId: string, recordId: string, spans: readonly SourceSpan[]): void {
    for (const sourceId of new Set(spans.map((s) => s.sourceId))) {
      this.db.run(
        "INSERT INTO record_sources (project_id, record_id, source_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        projectId,
        recordId,
        sourceId,
      );
    }
  }
}
