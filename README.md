# AI Plugin Toolkit

Modular model routing, context preparation, traceable project memory, and evidence-based delivery.

**Status: 0.4.0 release candidate, not published.** Milestones v0.1–v0.4 are implemented: cited memory, corrections and forgetting, caches and local inference, an MCP server, a read-only inspector, topic packs with evidence importers, and Beads and Task Master adapters with two-way reconciliation. **Still open:**
- real runs of the Beads and Task Master adapters against installed binaries;
- live model runs;
- the license decision and publication ([docs/release.md](docs/release.md)).

No benchmark, savings or compliance claim is made. Context Loom is a working product name.

## Try it

Requires Node.js ≥ 22.13 and pnpm (`corepack enable`).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
bash examples/synthetic/demo.sh /tmp/loom-demo   # offline end-to-end demo, no credentials
node apps/cli/dist/main.js inspect --dir /tmp/loom-demo   # read-only web inspector
```

Walkthrough: [docs/quickstart.md](docs/quickstart.md). `node apps/cli/dist/main.js help` lists every command; all accept `--json`. Exit codes: 0 success, 1 failed or not ready, 2 usage, 70 internal.

| Path | Contents |
| --- | --- |
| `packages/core` | Schemas, config, IDs, plugin contracts, typed errors, redaction. No IO. |
| `packages/storage-sqlite` | Migrations, repositories, FTS5, caches, embeddings, backups (built-in `node:sqlite`) |
| `packages/router` | Policy routing (completions and embeddings), fixture provider, hashing embedder |
| `packages/provider-anthropic`, `packages/provider-ollama` | Claude (official SDK); local Ollama chat and embeddings |
| `packages/memory` | Quote-cited extraction, corrections, review, forgetting, export/import |
| `packages/retrieval` | Scoped search, bounded context, revision-keyed caches, hybrid search |
| `packages/normalize` | Opt-in plain-English rewrite with meaning checks (experiment) |
| `packages/acceptance` | Topic packs (`packs/`), questions, evidence evaluation, importers |
| `packages/artifacts` | FACTS / VISION / PLAN / STATUS / ACCEPTANCE and decision records |
| `packages/task-sync` | Change sets, previews, durable intents, two-way reconciliation |
| `packages/adapter-beads`, `packages/adapter-taskmaster` | Beads 1.3.x and Task Master 0.43.x adapters |
| `packages/interface-mcp` | MCP server (stdio) |
| `packages/inspector` | Read-only web inspector (React) |
| `apps/cli`, `apps/eval` | `loom` CLI; evaluation harness (`pnpm eval`) |
| `scripts/` | Release gate (`pnpm release:check`), license audit, secret scan, CLI bundle |
| `docs/` | Quickstart, ADRs, adapters, data lifecycle, MCP, inspector, normalization, release |

## Project

- [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Compatibility](docs/compatibility.md)
- [Vision](.tasks/VISION.md) · [Plan](.tasks/plans/CONTEXT-LOOM-IMPLEMENTATION-PLAN.md) (§14: what is left) · [Tickets](.tasks/tickets/README.md) · [Test plan](.tasks/test-plan/CONTEXT-LOOM-ACCEPTANCE.md)
