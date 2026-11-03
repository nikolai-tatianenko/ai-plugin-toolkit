# Context Loom implementation plan

Status: v0.1–v0.4 and the release gate implemented in review (PR #4, see [tickets](../tickets/README.md)); real upstream runs, the license decision and publication pending. What is left: [§14](#14-remaining-work-as-of-2026-11-02). Repository name remains ai-plugin-toolkit. Working product name is not finalized.

## 1. End-to-end behavior

Capture conversation/document/tool evidence → extract candidate facts and decisions → detect duplicates and conflicts → retrieve relevant project knowledge → generate or revise vision/plan/status → select topic-pack criteria → ask high-impact unanswered questions → preview task changes → synchronize through a capability-aware adapter → collect verification evidence.

Routing selects models for both interactive and background tasks. The three layers are not three mandatory sequential model calls. Read-only retrieval can avoid inference.

## 2. Modules and dependency direction

Proposed TypeScript/Node.js monorepo with a package manager and supported runtime version pinned during foundation work:

| Package | Responsibility |
| --- | --- |
| core | Validated schemas, plugin contracts, configuration, events, stable IDs |
| storage-sqlite | Structured persistence, migrations, transactions, local indexes |
| memory | Ingest, extraction lifecycle, corrections, source lineage |
| retrieval | Scoped lexical search, optional embedding adapter, ranking |
| router | Provider capabilities, policy, budget, timeouts, fallback |
| context | Context assembly, budgets, optional normalization |
| artifacts | Facts, vision, plans, status, decision records |
| acceptance | Topic packs, questions, evidence evaluation |
| task-sync | Internal tasks, change sets, mappings, conflict detection |
| adapter-beads / adapter-taskmaster | Version-specific external integrations |
| interface-mcp | Later agent-facing tool interface |
| apps/cli | First usable product interface |
| apps/inspector | Later React inspection UI |

Core must not import provider, storage, or task-system implementations. Modules should be reusable independently; avoid circular dependencies and package proliferation without a useful boundary.

## 3. Persistence and schemas

SQLite stores structured records, relationships, revisions, synchronization mappings, and indexes. Files hold large evidence payloads and generated Markdown exports. SQLite is the authoritative structured state; exported files carry provenance and revision metadata.

| Entity | Required information |
| --- | --- |
| Source | ID, project/scope, type, timestamp, original content/reference, hash |
| Fact | Statement, source spans, scope, candidate/confirmed status, validity |
| Decision | Choice, rationale, alternatives, confirmation, supersedes relation |
| Question | Missing information, impact, answer, affected criteria |
| Artifact | Type, revision, source references, generator/model metadata |
| Criterion | Applicability rule, expected behavior, verification method, severity |
| Evidence | Result, source/build revision, environment, timestamp, artifact reference |
| Task | Stable ID, description, criteria links, dependencies |
| Sync mapping | Adapter/version, external ID, last remote/local revision |
| Audit event | Operation, actor, scope, changed IDs, result without secret payloads |

Use transactions for local multi-record changes. Track file writes and background work durably so crashes can be retried. Migration failures must leave a recoverable database.

### Memory levels

- L0: raw conversations, documents, tool outputs.
- L1: extracted facts, preferences, constraints, events, decisions.
- L2: project/scenario summaries.
- L3: explicitly confirmed stable cross-project preferences.

Lower levels remain available for evidence drill-down. A Mermaid canvas can later represent short-term task state with node IDs pointing to raw logs. The authoritative graph must be structured data; Mermaid is a rendering, not an execution format.

### Lifecycle

Deduplicate by scoped source identity/content hash. Extract candidates with strict output validation and bounded retries. Require source spans to exist. Preserve proposal versus decision distinctions. Detect possible contradictions for review rather than silently resolving uncertain conflicts. Supersede outdated records without losing their history.

Deletion follows dependency edges through facts, summaries, embeddings, caches, and generated exports. Explain backup retention limits. Retention and explicit forget operations are distinct from ordinary supersession.

## 4. Routing

Start with deterministic task policies: extraction, summary generation, planning, review. Each policy declares permitted providers, capabilities, model, token/cost budget, timeout, and fallback.

Sensitive projects must never fall back to a disallowed remote provider. Retry only transient failures and cap attempts. Log routing reasons, usage, latency, and failure categories. Unknown pricing should remain unknown rather than count as zero.

A local storage deployment is not automatically offline. Fully local mode requires local inference/embeddings and a network-denied verification run.

## 5. Context preparation and caching

Apply project/identity restrictions before retrieval. Prefer current confirmed decisions while preserving access to superseded evidence for historical questions. Assemble bounded context with source IDs and explicit untrusted-data boundaries. Protect code, quotations, identifiers, and structured tool arguments from rewriting.

Optional ASD-STE100-inspired normalization must preserve original text and record transformation/version. Validate negation, quantities, constraints, and meaning; fall back to original text on uncertainty. Check authoritative standard and licensing requirements before claiming compliance or distributing standard-derived resources.

Cache embeddings by content hash and model version; transformations by content and transformer version; retrieval by query, scope, permissions revision, and memory revision. Cache routing only when policy/capabilities remain valid. Exact response caching is opt-in for eligible read-only operations; never replay side-effecting tool calls as fresh execution. Semantic response caching is deferred.

Stable prompt prefixes may help compatible provider caches but must be measured independently from memory savings.

## 6. Artifacts and human edits

Generate FACTS.md, VISION.md, PLAN.md, STATUS.md, ACCEPTANCE.md and individual decision records. Each artifact includes revision and source references. Plans include milestones, dependencies, verification methods, unresolved questions, and exclusions.

Use tracked generated sections or a reviewed change set for human-edited documents. Detect conflicts using prior generated revision and current content. Do not replace an entire manually edited artifact without explicit policy.

## 7. Topic packs and questioning

Versioned packs contain metadata, applicability rules, question branches, criterion IDs, severity, verification requirements, and task templates. Begin with mobile app release. Add open-source, web, and AI feature packs later.

Mobile topics: platforms/devices, onboarding, authentication, offline behavior, purchases/restore, ads/age behavior, privacy/deletion, accessibility, error handling, store assets, build and release evidence. Platform/legal requirements require authoritative review before inclusion as mandatory rules.

Question modes:
- Quick: only questions blocking the next action.
- Guided: small groups by topic.
- Challenge: probe unsupported completion claims, assumptions, and edge cases.

Reuse answers until their source or applicability changes. Distinguish unanswered questions from inferred answers. Ask highest-impact questions first.

Criterion applicability: applicable, not-applicable, unresolved.
Verification: not-checked, passed, failed, stale.
Disposition: open, accepted, waived with actor and reason.

Evidence must identify build/source revision and environment. Mocks do not establish device or production readiness. Source changes can invalidate prior passes. A closed task alone cannot satisfy a criterion. Human approval and technical readiness are separate signals.

## 8. Beads and Task Master

Before implementing, identify exact upstream repositories, versions, supported CLI/API/file formats, license, and failure behavior. Record this in adapter compatibility documentation. Do not invent upstream capabilities.

Proposed internal operations: capabilities, readTasks, createTask, updateTask, linkDependency, readChanges. Unsupported operations must report a typed error or documented alternative.

v0.1 uses one-way publishing with preview and explicit project policy for writes. Store external IDs, idempotency keys, checkpoints, and remote revisions. Handle partial success and interrupted retries. Preserve manual edits and flag conflicts. One selected task system owns status per project. Do not close tasks based only on model text. Add two-way reconciliation after real integration tests pass.

## 9. Interfaces

Illustrative commands, subject to executable-name availability:

- loom init
- loom ingest ./conversation.md
- loom memory inspect
- loom generate vision plan status
- loom assess --pack mobile-release
- loom questions --mode challenge
- loom tasks preview --adapter beads
- loom tasks sync --adapter beads
- loom report

CLI supports machine-readable JSON, useful exit codes, dry runs, clear missing-configuration errors, and secret redaction.

Later MCP exposes scoped search, source reads, question answers, artifact generation, and task previews. Writes use policy and authentication appropriate to deployment. A React inspector shows provenance, conflicts, revisions, costs, and acceptance evidence.

## 10. Security and reliability

Keep credentials outside data exports. Treat retrieved content and imported packs as untrusted. Use declarative packs initially; do not execute arbitrary pack commands automatically. Validate paths and prevent traversal. Avoid shell interpolation for adapter arguments. Prevent cross-project cache leakage. Plugins receive only declared capabilities, though in-process plugins are trusted code rather than a security sandbox.

Provide explicit retention/deletion behavior, durable background-job state, bounded retries, cancellation, and auditable failures. Multi-user hosting requires a separate authorization review before release.

## 11. Milestones and gates

### v0.1: complete vertical slice

Foundation → evidence/facts → artifacts → mobile pack/questions → first real adapter → clean installation and documentation.

Gate: import synthetic conversation, inspect citations, generate plan, resolve questions, preview/publish tasks, rerun without duplicates. No mock may be counted as a real adapter. Basic routing uses one provider plus explicit policies; normalization can remain disabled. Second adapter is a stretch goal, not a hidden release requirement.

The original end-of-day discussion was a scope target, not proof of delivery or a guaranteed deadline.

### v0.2

Second adapter, correction/deletion lifecycle, contradiction review, incremental artifacts, migration/export support.

### v0.3

MCP, additional topic packs, verification imports, richer routing, validated normalization and caching.

### v0.4

React inspector, two-way synchronization, multi-user permissions, broader recovery/compatibility testing.

All tickets begin planned. Release gates depend on evidence, not elapsed time.

## 12. Validation and evaluation

See the linked test plan. Require automated integration tests for ingest-to-artifact and preview-to-sync workflows. Use deterministic fixtures for CI and opt-in live provider runs for extraction behavior. Pin fixture and dependency versions; report skips.

Compare full-history and simple retrieval baselines using the same model and dataset. Measure fact/source accuracy, correction handling, retrieval relevance, unsupported assertions, acceptance false passes, total tokens including maintenance, latency, retries, and cost. Publish raw synthetic fixtures and reproducible commands; do not repeat Tencent benchmark percentages as our own.

## 13. Open-source release

Choose license, check naming/package availability and dependency licenses, create CONTRIBUTING and SECURITY documentation, provide a clean-machine quickstart and synthetic demo, establish CI and a compatibility matrix, and publish honest limitations. Add short architecture decisions for SQLite, plugin contracts, evidence lifecycle, and sync ownership.

Repository publication, package publication, hosting, and production credentials are final release activities after local gates pass. This planning change does not authorize changing visibility or publishing packages.

## 14. Remaining work (as of 2026-11-02)

All tickets CL-001 to CL-022 have code in PR #4 (v0.1 to v0.4 plus the release gate). What remains needs either a real upstream binary, credentials, or an owner decision. Nothing below can be closed by more code alone.

### 14.1 To finish (required)

| # | Work | Tickets | How |
| --- | --- | --- | --- |
| 1 | Run the real Beads suites (A14–A17 against `bd` 1.3.x, CLI publish/rerun) and record results | CL-011, CL-012 | install `bd` 1.3.x, `pnpm test` |
| 2 | Run the real Task Master suite against `task-master` 0.43.x and record results | CL-014 | install `task-master-ai@0.43.x`, `pnpm test` |
| 3 | Fix any incompatibilities found in 1–2 | CL-011, CL-014 | — |
| 4 | Choose the license and add LICENSE; confirm the name (npm: `context-loom` not taken on 2026-11-02; trademark search pending) | CL-022 | owner decision, see docs/release.md |
| 5 | `pnpm release:check` prints READY with no `--allow-pending` | CL-022 | after 1–4 |
| 6 | Review and merge PR #4; tag v0.4.0; then (separately authorised) change visibility and publish | CL-022 | manual |

### 14.2 Strongly recommended

| # | Work | Tickets |
| --- | --- | --- |
| 7 | Live model runs: `LOOM_LIVE_TESTS=1 pnpm test` (Claude; Ollama with `LOOM_OLLAMA_MODEL`), `pnpm eval -- --provider anthropic` with a budget | CL-003, CL-015, CL-021 |
| 8 | Fully local run with a **real** Ollama model (the network-denied workflow already passes against a local stub) | CL-015 |
| 9 | Human review of `eval/datasets/*` annotations; run baselines and set thresholds | CL-021, CL-016 |
| 10 | Review of advisory pack items against store, legal and regulatory sources | CL-007, CL-018 |
| 11 | Manual screen-reader pass of the inspector | CL-020 |
| 12 | Before any controlled-language compliance claim: obtain and review the authoritative standard | CL-016 |

Decisions recorded on 2026-11-03: the license stays pending (owner will decide later); real Beads/Task Master runs are deferred (the sandbox used for development may not install or run them).

### 14.3 Known limitations (accepted for 0.4.0, documented)

- No separate linter (TypeScript strict is the gate).
- Beads has no compare-and-set; Task Master has no non-AI update (updates reported as unsupported).
- Contradiction detection is lexical; the hashing embedder is lexical.
- Forgetting cannot reach backups, exports, git history, upstream systems or provider-side retention.
- MCP and inspector are local-only; multi-user hosting needs an authorization design.

## References and status

Architecture inspiration: [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory). Inspiration is not a dependency decision. Verify the pinned upstream version/license before reusing code. The plan is based on the project discussion; no Beads/Task Master API compatibility has yet been established.

Related: [Vision](../VISION.md), [Tickets](../tickets/README.md), [Test plan](../test-plan/CONTEXT-LOOM-ACCEPTANCE.md).
