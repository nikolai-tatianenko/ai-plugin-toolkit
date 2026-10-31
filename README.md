# AI Plugin Toolkit

Modular model routing, context preparation, traceable project memory, and evidence-based delivery.

**Status: early implementation.** Implemented: validated contracts, configuration, SQLite evidence storage and a CLI for ingesting and inspecting sources. No model provider, fact extraction, task integration, benchmark or compliance claim is implemented or verified. Context Loom is a working product name, pending availability checks. A public release and license are still pending.

## What works today

Requires Node.js ≥ 22.13 and pnpm (`corepack enable`).

```sh
pnpm install
pnpm build
pnpm test

node apps/cli/dist/main.js init --dir ./demo        # creates demo/loom.config.json and a git-ignored demo/.loom/
node apps/cli/dist/main.js config validate --dir ./demo
node apps/cli/dist/main.js ingest --dir ./demo examples/synthetic/kickoff-conversation.json
node apps/cli/dist/main.js sources list --dir ./demo
node apps/cli/dist/main.js help
```

All commands accept `--json`. Exit codes: 0 success, 1 operation failed, 2 usage error, 70 internal error.

| Path | Contents |
| --- | --- |
| `packages/core` | Entity schemas, config schema, stable IDs, plugin contracts, typed errors, redaction. No IO. |
| `packages/storage-sqlite` | Migrations, project-scoped source storage, content-addressed evidence files (built-in `node:sqlite`) |
| `apps/cli` | `loom` command: `init`, `config validate`, `ingest`, `sources list`, `sources show` |
| `examples/synthetic` | Invented fixtures for demos and tests |
| `docs/adr` | Architecture decisions |

## Planning

- [Vision](.tasks/VISION.md)
- [Full implementation plan](.tasks/plans/CONTEXT-LOOM-IMPLEMENTATION-PLAN.md)
- [Implementation tickets](.tasks/tickets/README.md)
- [Acceptance and integration test plan](.tasks/test-plan/CONTEXT-LOOM-ACCEPTANCE.md)
- [Planning conventions](.tasks/README.md)

First demonstration target: import a synthetic conversation → inspect sourced facts → generate vision and plan → answer acceptance questions → preview and synchronize tasks through one real adapter → rerun without duplicates.
