# Changelog

All notable changes. Versions follow the plan's milestones. Nothing has been published to a package registry.

## Unreleased

- Preserve Unicode in shared-memory uploads when UTF-8 characters span request chunks; enforce the upload limit in bytes.
- Explain the intended audience, end-to-end workflow and workspace extensions in the README.
- License the project under MIT (`LICENSE`); the bundle declares it.
- Add a local verification runbook with a prompt for a local coding agent (`docs/local-verification.md`).
- Add reusable checklist templates and evidence-backed instances with snapshot isolation and optimistic concurrency.
- Add configurable GitHub PR / GitLab MR preview and create/update adapters.
- Add private user profiles/goals, user/shared/server memory layers, optional authenticated single-project memory server and portable project state.
- Add modular Claude/Codex hooks, safe configuration merge/uninstall, self-reflection, pre-compaction checkpoints and a measured 70% usage policy with telemetry bridges.
- Add schema v4 for revisioned project-scoped plugin documents and gated MCP checklist/shared-memory tools.

## 0.4.0 (unreleased)

Release candidate covering milestones v0.1 to v0.4. The release gate (CL-022) still needs the real-upstream and live-model execution receipts, macOS verification, and explicitly authorized publication. Run `pnpm release:check`.

### Release verification follow-up
- Require source-bound execution receipts for Beads, Task Master, real Claude/Ollama extraction, and clean macOS installation. Missing or skipped verification cannot produce READY.
- Add `pnpm verify:release -- <suite>`, real extraction workflows with provenance checks, and macOS Node 22/24 CI artifacts.
- Cover fetch transports and normalized socket arguments in the local-only workflow's network guard.

### v0.4
- Two-way task reconciliation: `loom tasks pull`, `tasks conflicts`, `tasks resolve --keep local|remote`. Remote edits are preserved for a decision, and status is owned by the task system. A sync lock prevents concurrent runs (CL-019).
- Database recovery: automatic backup before schema migrations; `loom db status|backup|restore` (CL-019).
- Read-only web inspector `loom inspect`: provenance, revisions, contradictions, routing cost, acceptance evidence, task previews; tested with Playwright and axe (CL-020).

### v0.3
- Caches keyed by memory and permission revisions; embedding cache; hybrid search; local hashing embedder; Ollama provider for local chat and embeddings (CL-015).
- Opt-in controlled-English normalization experiment with protected regions and meaning checks; no compliance claim (CL-016).
- MCP server over stdio, `loom mcp`: read tools on a read-only connection, write tools behind `mcp.allowWrites` (CL-017).
- Topic packs `open-source-release`, `web-release`, `ai-feature`; custom pack files; evidence importers `junit-xml/1`, `loom-build/1`, `loom-review/1`. Pack updates no longer silently carry waivers to changed criteria (CL-018).

### v0.2
- Corrections (`loom correct`), conflict review (`loom review`), scoped forgetting (`loom forget`), export/import, retention policy (CL-013).
- Task Master adapter, manual (non-AI) commands only (CL-014).

### v0.1
- Vertical slice: ingest, quote-cited extraction, scoped retrieval and context, versioned artifacts, mobile-release pack, evidence-based acceptance, task change sets, Beads adapter, CLI, evaluation harness (CL-001 to CL-012, CL-021 part).
