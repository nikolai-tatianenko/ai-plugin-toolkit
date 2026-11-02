# ADR 0008: Corrections supersede; forgetting deletes and scrubs

Status: accepted for v0.2 (CL-013)
Date: 2026-11-02

## Decision

- **Corrections are evidence.** `loom correct` stores the correction text as a source document. The new decision cites it, is confirmed by the person, and supersedes the current one. History is kept.
- **Uncertain conflicts go to review.** Supersession across different sources, and statements that look contradictory (similar wording, exactly one negated), create review items. Resolution (accept, revert, keep one, dismiss) is explicit and audited.
- **Forgetting follows dependency edges** (`record_sources`): records cited only by the source are deleted, multi-source records lose the span, and supersession is recomputed. Rejected candidates, index rows, embeddings, caches and transforms are removed, and the payload file too unless another project shares it. Artifacts are regenerated with generated sections replaced, and decision-record files are removed. The database is checkpointed and `VACUUM`ed. Remaining copies in artifacts or recorded exports are reported.
- **The audit log keeps IDs only.** Backups, exports, git history and upstream systems are out of reach and documented (docs/data-lifecycle.md).
- Export/import (`loom-export/1`) preserves IDs and excludes adapter-specific sync state.

## Consequences

- `VACUUM` rewrites the database file, which is slow for large stores; this is acceptable for an explicit, rare operation.
- The contradiction heuristic is lexical; it misses paraphrased contradictions and needs human review.
