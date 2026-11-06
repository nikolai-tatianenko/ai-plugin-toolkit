# Workspace extension verification

Baseline upstream: `b1fc4ea85643c6f3082b79934a1556831a364250` (PR #5).
The local baseline was reconstructed from that exact GitHub tree; all 216 original blob hashes matched before edits. This report covers the implementation diff developed against that baseline, before publication. The tested implementation diff SHA-256 (excluding this report) is `78231869e60198d8d799f4ddb50f126b8b5c3247523eae7b821d42ba971a399e`.

Environment: Linux, Node v24.22.1, pnpm 11.25.0. CI uses the repository-pinned pnpm and Node 22/24 on Linux and macOS. No product UI was changed; evidence is command/protocol/test output rather than screenshots.

| Scenario | Observed result |
| --- | --- |
| Build | Passed (`pnpm build`) |
| Full automated suite | 299 passed, 14 skipped, 37 files (34 passed, 3 skipped) |
| New feature scenarios | Template/instance isolation, evidence staleness, reserved pack ID protection, concurrent writes, private/shared/server isolation, authentication, server revision conflicts, native hook JSON, generated shell execution, recursion guard, exact threshold crossing/rearming, app-server proxy forwarding, MR adapter create/update, MCP policy gating, and portable state round-trip passed |
| Packaged install | Eight scenarios passed: frozen install, build, bundle, npm-packed install, offline demo, idempotency, checklist workflow, private profile/native hook workflow |
| Local packaged-install adaptation | pnpm 11 required `--ignore-scripts` for third-party install scripts; this was explicit in the local run. macOS CI runs the unmodified workflow. No Linux result was used as macOS evidence |
| Dependency audit | 100 production dependencies; all licenses on the allowlist |
| Secret scan | Passed against staged source files |
| Fixture evaluation | Completed; a scoring/validation fixture, not a model-quality benchmark. Existing synthetic dataset still reports unsupported/missed items; no quality claim is made |
| Strict release gate | Exited 1 with six explicit missing requirements; did not report READY |

## Before and after

| Before | After |
| --- | --- |
| Built-in/imported topic packs; no template/instance management | Author, version, import, list, snapshot, report, export, archive and delete reusable checklists; use existing evidence engine |
| No configurable PR/MR publication module | Define GitHub/GitLab targets, select existing review numbers and branch pairs, preview, explicitly create/update |
| Source-derived project memory only | Separate private identity/goals/notes, shared project notes, optional server snapshot |
| No optional shared-memory service | Authenticated single-project loopback HTTP service/client with revision preconditions and explicit sync |
| No host lifecycle/checkpoint adapters | Claude/Codex hooks; turn-end reflection, pre-compaction snapshots and measured 70% context policy |
| No Codex telemetry relay | Transparent stdio app-server proxy observes native usage events while forwarding protocol traffic |

## Limits and remaining release evidence

- Real Claude/Ollama extraction and Beads/Task Master execution were not run: required credentials/models/binaries are absent here.
- Native Claude/Codex sessions were not run. Tests exercise real local CLI processes and simulated protocol input; the app-server proxy test uses a simulated executable.
- GitHub/GitLab runtime review adapters were tested with deterministic HTTP transports; no live review was created through those adapters.
- macOS CI must rerun for the new source snapshot and upload its new eight-scenario receipt. The user's own Mac remains unverified.
- The license/name decision and publication remain pending. The strict gate requires current Beads, Task Master, Claude, Ollama and macOS receipts plus the license.
- Existing 14 skips cover native upstream/live-provider suites and Chromium/browser scenarios unavailable locally. No new workspace scenario is skipped.
- Optional memory service is single-project and token-authenticated, with loopback binding. Multi-tenant hosting and Windows shell hooks are outside this implementation.

Reproduce: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm bundle`; use [workspace setup](../workspace.md) for native configuration and [release instructions](../release.md) for real execution receipts. A passing build/test suite does not override missing release evidence.
