import { LoomError } from "@ai-plugin-toolkit/core";
import { type Db } from "./db.js";

export interface DocumentRecord<T = unknown> {
  key: string;
  revision: number;
  value: T;
  actor: string;
  updatedAt: string;
}

/** Project-scoped plugin documents with optimistic concurrency and immutable history. */
export class DocumentsRepo {
  constructor(private readonly db: Db) {}

  get<T = unknown>(project: string, namespace: string, key: string): DocumentRecord<T> | undefined {
    const row = this.db.get("SELECT * FROM plugin_documents WHERE project_id=? AND namespace=? AND key=? ORDER BY revision DESC LIMIT 1", project, namespace, key);
    if (!row || row.deleted === 1) return undefined;
    return { key, revision: Number(row.revision), value: JSON.parse(String(row.value)) as T, actor: String(row.actor), updatedAt: String(row.updated_at) };
  }

  list<T = unknown>(project: string, namespace: string): DocumentRecord<T>[] {
    const keys = this.db.all("SELECT DISTINCT key FROM plugin_documents WHERE project_id=? AND namespace=? ORDER BY key", project, namespace);
    return keys.flatMap(r => this.get<T>(project, namespace, String(r.key)) ?? []);
  }

  put<T>(project: string, namespace: string, key: string, value: T, actor: string, expectedRevision: number): DocumentRecord<T> {
    return this.write(project, namespace, key, value, actor, expectedRevision, false);
  }

  remove(project: string, namespace: string, key: string, actor: string, expectedRevision: number): void {
    this.write(project, namespace, key, null, actor, expectedRevision, true);
  }

  private write<T>(project: string, namespace: string, key: string, value: T, actor: string, expected: number, deleted: boolean): DocumentRecord<T> {
    return this.db.transaction(() => {
      const current = this.db.get("SELECT MAX(revision) AS revision FROM plugin_documents WHERE project_id=? AND namespace=? AND key=?", project, namespace, key);
      const revision = Number(current?.revision ?? 0);
      if (revision !== expected) throw new LoomError("CONFLICT", `Document ${namespace}/${key} changed: expected revision ${expected}, found ${revision}. Reload before retrying.`);
      const updatedAt = new Date().toISOString();
      this.db.run("INSERT INTO plugin_documents(project_id,namespace,key,revision,value,actor,updated_at,deleted) VALUES(?,?,?,?,?,?,?,?)", project, namespace, key, revision + 1, JSON.stringify(value), actor, updatedAt, deleted ? 1 : 0);
      return { key, revision: revision + 1, value, actor, updatedAt };
    });
  }
}
