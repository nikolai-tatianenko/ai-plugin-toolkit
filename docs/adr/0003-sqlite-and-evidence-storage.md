# ADR 0003: SQLite via node:sqlite, content-addressed evidence files

Status: accepted for v0.1 (CL-002)
Date: 2026-10-31

## Context

Plan §3: SQLite is the authoritative structured state; files hold large evidence payloads; multi-record changes are transactional; migration failure must leave a recoverable database.

## Decision

- **Driver: built-in `node:sqlite` (`DatabaseSync`)**, not `better-sqlite3`. No native build step, no prebuilt-binary downloads, works on a clean machine with only Node ≥ 22.13. Trade-off: the module is still flagged experimental and prints an `ExperimentalWarning`; the CLI filters only that warning. If the API changes incompatibly, the driver is isolated in `packages/storage-sqlite`.
- **Pragmas**: WAL, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`. `STRICT` tables with `CHECK` constraints mirroring the zod enums.
- **Migrations**: append-only, numbered 1..n, each applied in its own `BEGIN IMMEDIATE` transaction together with its `schema_migrations` row. A failing migration rolls back and the database stays at the previous version. A database newer than the build is refused without modification.
- **Source identity**: `stableId("source", projectId, sha256(text))`, plus `UNIQUE(project_id, content_hash)`. Re-importing identical bytes returns the existing source; the same bytes in another project are a separate source. Bytes are never normalized (CRLF vs LF are different sources) so hashes and spans always refer to the original.
- **Payloads** over 64 KiB go to `evidence/<hh>/<sha256>.txt`, written atomically (temp + rename) *before* the transaction that references them. A crash can leave an unreferenced file, never a row pointing to a missing file. Reads verify the hash.
- **Batches are atomic**: validate every input → write payload files → one transaction for all rows and the audit event. Any failure inserts no source rows and records an error audit event outside the rolled-back transaction.
- Every query takes an explicit project ID; there is no unscoped read API.

## Consequences

- Unreferenced payload files need a collection step (with deletion work in CL-013).
- Background-job durability (plan §3) is not covered yet; it arrives with extraction (CL-004).
- Backups and export/import formats are deferred (v0.2).
