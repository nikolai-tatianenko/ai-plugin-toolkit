# ADR 0011: Two-way reconciliation keeps both sides until a person chooses

Status: accepted for v0.4 (CL-019)
Date: 2026-11-02

## Decision

- `loom tasks pull` applies remote **status** directly (the task system owns it; `tasks.statusOwner` is the literal `external`). Remote **content** edits are stored next to the local plan (`remote_title`, `remote_description`) and nothing is overwritten.
- `tasks resolve --keep remote` records the decision and stops Loom from proposing updates for that task; a later plan change for it becomes a conflict, never an update. `--keep local` publishes the plan over the edit. This is an explicit override and needs `tasks.allowWrites`.
- An advisory per-project lock (stale after 10 minutes) prevents two syncs from writing concurrently. Crash recovery still relies on durable intents and idempotency keys (ADR 0007).
- An automatic `VACUUM INTO` backup is taken before migrating an existing database. `loom db restore` replaces the database and keeps the previous file.

## Consequences

- Task Master has no non-AI update, so `--keep local` and plan updates are unsupported there and reported as such.
