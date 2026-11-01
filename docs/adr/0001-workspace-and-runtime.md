# ADR 0001: Workspace, runtime and validation stack

Status: accepted for v0.1 foundation (CL-001)
Date: 2026-10-31

## Context

The plan (§2) calls for a TypeScript/Node.js monorepo with pinned package manager and runtime, independent modules, and a core that never imports provider, storage or task-adapter implementations.

## Decision

- **pnpm workspaces** (`packages/*`, `apps/*`), version pinned via `packageManager`. Strict dependency isolation surfaces undeclared imports early.
- **Node.js ≥ 22.13**, CI on 22 and 24. 22.13 is the first 22.x where `node:sqlite` loads without a flag, which CL-002 intends to use (separate ADR).
- **TypeScript 6.0, strict**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. ESM only, `NodeNext` resolution, project references (`tsc -b`). TypeScript 7 (native) was released but is deferred until the toolchain around it settles.
- **zod 4** for every contract that crosses a boundary (entities, config, plugin manifests). Product rules that must not be bypassed are schema invariants, e.g. a criterion cannot be `passed` without evidence IDs; a decision cannot be `confirmed` without a confirmer; an inferred answer cannot close a question.
- **Vitest** for unit and integration tests. CLI tests run in-process (injected IO) and against the built binary.
- **No CLI framework**: `node:util` `parseArgs`, to keep the dependency surface small until command count justifies one.
- **Core boundary enforced by test** (`packages/core/test/boundary.test.ts`): an import allowlist (`zod`, `node:crypto`, `node:path`). Core performs no file or network IO; the CLI owns file reading.

## Consequences

- Adding a dependency to core is a deliberate change to the allowlist test.
- Package names use the `@ai-plugin-toolkit/*` scope and stay `private` until the publication gate (CL-022) resolves naming.
- Contributors need pnpm (via Corepack: `corepack enable`).
