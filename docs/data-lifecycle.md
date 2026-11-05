# Data lifecycle: corrections, forgetting, retention, export, backups

## Correcting vs forgetting

| Operation | Command | Effect |
| --- | --- | --- |
| Correct a decision | `loom correct <topic> <choice> --reason <why>` | Stores the correction as a source document, creates a decision confirmed by you that cites it, and supersedes the previous one. History stays (`loom memory list --all`). |
| Review | `loom review list`, `loom review resolve <id> --action accept\|revert\|dismiss` or `--keep <record>` | Supersessions across sources and possible contradictions are queued for a person. Nothing is resolved silently. |
| Forget | `loom forget <source-id...> --yes` | Deletes the source and everything derived from it (see below). This cannot be undone. |
| Retention | `retention.sourceMaxAgeDays` in config, then `loom retention show` / `loom retention apply --yes` | Forgets sources older than the limit (by ingest time). |

## What forgetting removes

- The source row, its search-index row and its payload file. The file is kept only if another project holds a source with identical bytes.
- Facts and decisions whose only evidence is that source, with their index rows, embeddings and review items. Records that also cite other sources keep only their remaining spans.
- Extraction runs and rejected candidates for the source (rejected candidates contain quoted text).
- All retrieval caches and transform outputs of the project.
- Supersession is repaired: if the current decision is forgotten, the previous one becomes current again.
- Generated artifacts are regenerated, replacing generated sections even if they were hand-edited. Decision-record files of deleted decisions are deleted.
- The database file is checkpointed and `VACUUM`ed, so deleted rows don't survive in free pages or the WAL.
- The audit log records operation, actor and IDs only, never the deleted text.

Afterwards `loom forget` scans the artifacts directory and every file written by `loom export` for the removed text, and lists files that still contain it. Typical causes are manual notes below an artifact's end marker, or an earlier export.

## What forgetting cannot remove

- **Backups.** Copies in `.loom/backups/` (written automatically before schema migrations and by `loom db backup`) still contain the data. Delete them, or let your backup tooling's retention expire them.
- **Exports** made earlier (they are reported, not deleted).
- **Copies outside Loom**: git history (if `loom-docs/` was committed), file-system snapshots, Time Machine, cloud sync, editors' swap files.
- **Upstream systems**: task titles and descriptions already published to Beads or Task Master.
- **Model providers**: text already sent to a remote provider during extraction is governed by that provider's retention policy.

## Export and import

`loom export --out file.json` writes sources (with raw text), facts, decisions, answers, evidence and dispositions in format `loom-export/1`. Tasks and sync mappings are left out because they are specific to a task system. `loom import file.json` loads an export into an empty project with the same project ID; IDs are preserved because they are derived from the project and the content. Treat export files like the raw evidence they contain.

## Backups and recovery

- Before applying schema migrations to an existing database, Loom writes `.loom/backups/loom-v<from>-<timestamp>.db` (a consistent `VACUUM INTO` copy).
- `loom db backup` writes a backup on demand. `loom db restore <file> --yes` replaces the database, keeping the previous file as `loom.db.before-restore`.
- A failing migration rolls back by itself (ADR 0003). The backup covers the case where a migration succeeds but you need to go back to an older build.
