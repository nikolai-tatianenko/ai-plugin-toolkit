import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type Row = Record<string, string | number | null>;

/** Thin helper shared by the store and its repositories. Every query passes a project ID explicitly. */
export class Db {
  constructor(readonly raw: DatabaseSync) {}

  get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.raw.prepare(sql).get(...params) as Row | undefined;
  }

  all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  /**
   * Run `fn` in one IMMEDIATE transaction. Re-entrant: when a transaction is already
   * open, `fn` joins it, so callers can compose repository methods atomically.
   */
  transaction<T>(fn: () => T): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw error;
    }
  }
}

export const json = (value: unknown): string => JSON.stringify(value);
export const parseJson = <T>(value: string | number | null | undefined, fallback: T): T =>
  typeof value === "string" ? (JSON.parse(value) as T) : fallback;
export const str = (value: string | number | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : String(value);
export const now = (): string => new Date().toISOString();
