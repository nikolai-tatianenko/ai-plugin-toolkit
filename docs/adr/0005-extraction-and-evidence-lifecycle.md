# ADR 0005: Quote-cited extraction and decision lifecycle

Status: accepted for v0.1 (CL-004, CL-005)
Date: 2026-11-01

## Context

Every accepted claim needs a resolvable source span (A03). Invented sources must be rejected (A04). A proposal is not a decision (A02), and reruns must not duplicate facts (A01).

## Decision

- **Models cite quotes, not offsets.** The model returns `{sourceId, quote}`, and memory resolves the quote to a span in the original bytes. For JSON conversations it also tries the JSON-escaped form, so spans index the stored file exactly. A source ID the model wasn't shown, a quote that doesn't occur, or a schema violation rejects the candidate. Rejections are stored with their reason.
- **Proposal vs decision**: `proposal` is always stored as `proposed`. A `decision` is `confirmed` only when the quoted text was said by a human: the `user` role in a conversation, or a document. Decisions from assistant, system or tool text are downgraded to `proposed`. `confirmedBy` records the speaker and source.
- **Supersession**: a newer confirmed decision on the same `topic` supersedes older ones, ordered by evidence time (source `createdAt`, else ingest time) plus position in the source, not processing order. History is kept.
- **Idempotency**: record IDs are stable hashes of project, kind, source, spans and normalized text. A source already extracted with the current prompt version is skipped unless `--force`, and forced reruns hit the same IDs.
- **Durability**: an `extraction_runs` row is committed before the model call (`running`) and finished as `ok` or `error`. All records for a run are written in one transaction after validation, so a failure leaves none (A18).
- **Untrusted evidence**: evidence is sent in an `<evidence>` block with embedded closing tags neutralized. Instructions stay in the system prompt. Extraction can only write memory records, never acceptance or task state (A20). Retrieval quotes evidence, and model-written statements, only inside escaped `<untrusted-evidence>` blocks.
- **Retrieval** is SQLite FTS5 over facts, decisions and sources. Every query is filtered by project in SQL (A05). User text is reduced to quoted terms joined by OR, so FTS syntax can't be injected. Ranking weights favour current confirmed decisions, and superseded records are reachable only with `--all`.

## Consequences

- A claim copied verbatim from an injected instruction still passes validation, because the quote exists. The evaluation harness shows this case; only review or evaluation catches it.
- Paraphrase quality of `statement` is not checked against the quote.
- Contradiction review, forgetting and retention are v0.2 (CL-013).
