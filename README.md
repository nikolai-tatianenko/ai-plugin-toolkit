# AI Plugin Toolkit

Modular model routing, context preparation, traceable project memory, and evidence-based delivery.

**Status: v0.1 vertical slice implemented; two release gates still open.** Implemented: evidence ingestion, source-linked extraction (Claude, or recorded fixtures), scoped retrieval and bounded context, versioned artifacts, the mobile-release topic pack with questions and evidence-based acceptance, task change sets, and a Beads adapter. **Not yet verified:**
- the Beads adapter against a real `bd` binary (CL-011 gate, see [docs/adapters/beads.md](docs/adapters/beads.md));
- a live model run (CI uses recorded fixtures).

No benchmark, savings or compliance claim is made. Context Loom is a working product name, pending availability checks. A public release and license are still pending.

## Try it

Requires Node.js ≥ 22.13 and pnpm (`corepack enable`).

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
bash examples/synthetic/demo.sh /tmp/loom-demo   # offline end-to-end demo, no credentials
```

Full walkthrough, live Claude extraction and Beads publishing: [docs/quickstart.md](docs/quickstart.md). All commands accept `--json`. Exit codes: 0 success, 1 operation failed or not ready, 2 usage error, 70 internal error.

| Path | Contents |
| --- | --- |
| `packages/core` | Entity, config and extraction schemas, stable IDs, plugin contracts, typed errors, redaction. No IO. |
| `packages/storage-sqlite` | Migrations, project-scoped repositories, FTS5 index, content-addressed evidence files (built-in `node:sqlite`) |
| `packages/router` | Policy routing: capabilities, budgets, bounded timeouts, transient-only retries, permitted fallbacks; fixture provider |
| `packages/provider-anthropic` | Claude provider on the official `@anthropic-ai/sdk` |
| `packages/memory` | Quote-cited extraction, span resolution, proposal vs decision, supersession |
| `packages/retrieval` | Scoped lexical search and bounded context with untrusted-evidence boundaries |
| `packages/acceptance` | Declarative topic packs (`packs/mobile-release.json`), questions, evidence evaluation, readiness |
| `packages/artifacts` | FACTS / VISION / PLAN / STATUS / ACCEPTANCE and decision records with provenance and edit protection |
| `packages/task-sync` | Task derivation, previews, mappings, durable intents, conflict reporting |
| `packages/adapter-beads` | Beads (`bd`) 1.3.x adapter |
| `apps/cli` | `loom` command |
| `apps/eval` | Reproducible extraction evaluation (`pnpm eval`) |
| `examples/synthetic`, `eval/datasets` | Invented fixtures and annotated cases |
| `docs/adr`, `docs/adapters` | Architecture decisions and upstream compatibility notes |

## Planning

- [Vision](.tasks/VISION.md)
- [Full implementation plan](.tasks/plans/CONTEXT-LOOM-IMPLEMENTATION-PLAN.md)
- [Implementation tickets](.tasks/tickets/README.md)
- [Acceptance and integration test plan](.tasks/test-plan/CONTEXT-LOOM-ACCEPTANCE.md)
- [Planning conventions](.tasks/README.md)
