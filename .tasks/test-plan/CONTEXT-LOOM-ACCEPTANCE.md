# Acceptance and integration test plan

Status: v0.1 automated suite in place (see the coverage table below). Use synthetic fixtures only.

## Coverage (2026-11-02, v0.1–v0.4)

| ID | Status | Where |
| --- | --- | --- |
| A01 | passed | storage, memory and CLI tests |
| A02 | passed | `memory/test/extract.test.ts`, CLI workflow |
| A03 | passed | `extract.test.ts`, `retrieval.test.ts`, CLI workflow |
| A04 | passed | `extract.test.ts` |
| A05 | passed (storage and retrieval; no caches exist yet) | `store.test.ts`, `retrieval.test.ts` |
| A06 | passed | `memory/test/lifecycle.test.ts`, CLI workflow 4 |
| A07 | passed | `artifacts.test.ts`, CLI workflow |
| A08 | passed | `acceptance.test.ts` |
| A09 | passed | `acceptance.test.ts`, CLI workflow |
| A10 | passed | `acceptance.test.ts` |
| A11 | passed | `acceptance.test.ts`, CLI workflow |
| A12 | passed | `acceptance.test.ts`, CLI workflow |
| A13 | passed | `acceptance.test.ts`, CLI workflow |
| A14 | passed against the reference adapter and a fake Task Master CLI; real Beads/Task Master **not run** | `task-sync/test/sync.test.ts`, `adapter-taskmaster/test/*.ts`; real suites skipped |
| A15 | as A14 | same |
| A16 | as A14; two-way resolution passes (CL-019) | same, plus `sync.test.ts` two-way suite |
| A17 | as A14 | same |
| A18 | passed | `router.test.ts`, `extract.test.ts` |
| A19 | passed (config and runtime) | `config.test.ts`, `router.test.ts` |
| A20 | passed | `extract.test.ts`, `retrieval.test.ts` |
| A21 | passed (including a raw scan of the database file) | `lifecycle.test.ts`, CLI workflow 5 |
| A22 | passed | `plugins.test.ts`, `sync.test.ts`, `beads.unit.test.ts` |
| A23 | passed | `config.test.ts`, `store.test.ts`, `beads.unit.test.ts` |
| A24 | passed | `retrieval/test/cache.test.ts`, CLI test |
| A25 | passed on the 11-case baseline (rules); model path falls back on violations | `normalize/test/normalize.test.ts` |
| A26 | passed up to `tasks preview`; ingest-to-sync needs real Beads | fresh-clone run, `examples/synthetic/demo.sh` |
| A27 | supported path exists (Ollama + local embeddings); **not verified** with a real local model and network denied | `provider-ollama` stub tests |

The release gate "one real adapter" is **open** until the real Beads suites run. Workflows 4 (correction) and 5 (deletion) are automated in `apps/cli/test/workflow.test.ts`. CI runs on Node 22 and 24.

## Required automated integration workflows

1. Initialize → ingest → extract sourced facts → retrieve → generate artifacts.
2. Select mobile pack → answer questions → generate criteria → attach evidence → evaluate readiness.
3. Generate task change set → preview → publish through first real adapter → rerun.
4. Correct a decision → supersede old fact → regenerate affected artifacts → invalidate related caches.
5. Delete scoped evidence → remove dependent facts, indexes, summaries, caches, and exports.
6. Simulate interrupted persistence/synchronization → restart → reconcile without loss or duplication.

CI uses deterministic provider fixtures for reproducibility. Live-model extraction is a separate opt-in evaluation with bounded budget and synthetic data. A mocked adapter cannot establish upstream compatibility; run the actual supported CLI/service against disposable task data. Missing credentials or unavailable dependencies must produce explicit skips and leave the corresponding readiness gate open.

## Scenarios

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| A01 | Import identical conversation twice | Stable source IDs and counts; no duplicate facts/tasks |
| A02 | Suggest PostgreSQL, later decide SQLite | Proposal remains distinct; confirmed current decision is SQLite |
| A03 | Ask for evidence behind a generated fact | Source ID and exact span resolve to original material |
| A04 | Model invents a source ID | Candidate rejected or flagged; never accepted as verified |
| A05 | Query project A with matching records in B | No cross-project retrieval or cache leakage |
| A06 | Correct an existing decision | History retained; current summaries use corrected decision |
| A07 | Manual edit to generated plan | Edit preserved or explicit conflict; no silent overwrite |
| A08 | Existing valid question answer | Not asked again unless its applicability/source changes |
| A09 | App has no purchases | Purchase criterion marked not-applicable with rationale |
| A10 | Task says done without evidence | Acceptance remains not-checked/open |
| A11 | Emulator/mock evidence for physical-device requirement | Requirement remains unverified |
| A12 | Build revision changes after pass | Affected verification becomes stale |
| A13 | Waive a failed criterion | Actor and reason recorded; waiver is not shown as a passed test |
| A14 | Preview task changes | No external writes |
| A15 | Publish twice through real adapter | External IDs and task counts stable |
| A16 | Remote task manually edited | Conflict reported; manual changes preserved |
| A17 | Crash after some external creates | Retry reconciles checkpoint/mapping without duplicate creates |
| A18 | Provider timeout or invalid output | Bounded retry; actionable failure; no corrupt records |
| A19 | Local-only policy and remote fallback configured | Remote fallback rejected |
| A20 | Prompt injection in imported evidence | Treated as source data; no elevated tool authority |
| A21 | Forget source | Derived records/search/cache/export no longer expose deleted content |
| A22 | Unsupported adapter operation | Explicit capability error; no fabricated success |
| A23 | Malicious file path or shell metacharacters | No traversal or unintended command execution |
| A24 | Permission/memory revision changes | Cached retrieval invalidated before reuse |
| A25 | Normalize negation, code, quantities, quotations | Protected meaning/content retained or original used |
| A26 | Clean installation | Documented synthetic demo completes with declared prerequisites |
| A27 | Fully local configuration with network denied | Supported local workflow completes; no cloud dependency claimed otherwise |

## Evaluation design

Create a small human-reviewed dataset spanning project changes, ambiguous proposals, conflicting preferences, missing requirements, and long tool logs. Compare full-history and simple retrieval baselines with the same model, inputs, and evaluation criteria.

Report:
- Fact extraction precision/recall against annotated cases.
- Source citation correctness and unsupported-claim rate.
- Current-decision retrieval and correction behavior.
- Acceptance false-pass rate.
- Duplicate task count and conflict preservation.
- End-to-end latency, retries, tokens and cost including background extraction/aggregation.
- Dataset/model/config versions, sample sizes, raw synthetic outcomes, and limitations.

Choose and document numerical release thresholds after establishing the baseline, before tuning against the held-out evaluation cases. Hard safety/correctness gates are zero duplicate writes in the deterministic retry suite, zero cross-project disclosure in isolation tests, and no false verified passes in required evidence scenarios.

## Release evidence record

For each check record: ticket, test/scenario ID, command, commit/build, environment, timestamp, outcome, evidence path, reviewer when applicable, and remaining limitations.

v0.1 requires A01–A05, A07–A20, A22–A23, A26 as applicable to implemented scope. Later-feature checks remain explicitly deferred, not passed. Source-backed facts, correct acceptance states, and one real adapter are mandatory. A second adapter, offline operation, standards compliance, and two-way sync cannot be claimed before their own checks pass.

## Final release sequence

Complete implementation and local checks → clean-install validation → documentation/license/dependency review → synthetic demo and evidence report → separately authorized repository/package publication. Hosting and production credentials come last.
