# ADR 0007: One-way publishing; the task system owns status

Status: accepted for v0.1 (CL-010, CL-011)
Date: 2026-11-01

## Decision

- **Planned tasks** are derived from criteria that are applicable, not passed and not waived. Task IDs are stable per criterion, and the revision increases only when the content changes.
- **Preview is read-only**, both locally and remotely (A14). It reads remote tasks to classify each one as create, adopt, update, link, unchanged, conflict, remote-edited, missing-remote or retire.
- **Writes require `tasks.allowWrites: true`** in the project config.
- **Crash safety** (A17): before each remote create, a `pending` intent is committed. After it, the mapping is saved and the intent is completed in one transaction. If a crash happens in between, the next run finds the remote task by its idempotency key (Beads `external_ref`) and adopts it instead of creating a duplicate. Adopted content that differs from the plan is reported as a conflict, not overwritten.
- **Remote edits win** (A16): a remote revision change since the last sync is reported (`remote-edited`, or `conflict` when the local plan also changed), and Loom never overwrites it. Updates also pass the expected revision to the adapter.
- **Status belongs to the task system.** Loom reads it back but never sets or closes it, and a closed task never satisfies a criterion.
- **Unsupported operations** throw `UNSUPPORTED_CAPABILITY` and are reported per change (A22).
- Retired tasks (criterion passed, waived or out of scope) are left untouched remotely.

## Consequences

- Two-way reconciliation and status-driven workflows are CL-019.
- Reconciling after a crash requires an adapter that can read remote tasks; sync refuses to retry pending creates otherwise.
