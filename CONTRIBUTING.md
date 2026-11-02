# Contributing

Thanks for helping. This project values traceable claims: please keep changes small, tested, and honest about what is verified.

## Setup

Node.js ≥ 22.13 and pnpm 10 (`corepack enable`).

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Inspector browser tests need Playwright's Chromium (`pnpm --filter @ai-plugin-toolkit/inspector exec playwright install chromium`); without it they are skipped with a message.

## Before opening a pull request

- `pnpm build && pnpm test` passes. TypeScript strict mode is the lint gate (no separate linter yet).
- `pnpm secrets:scan` and `pnpm licenses:audit` pass. Synthetic test secrets need a `secret-scan: synthetic` comment on the same line.
- New behaviour has tests. Integration with real upstream tools (Beads, Task Master, model providers) must not be claimed from mocks: add or extend the opt-in real tests, which skip explicitly when the tool or credential is missing.
- Update the relevant ticket in `.tasks/tickets/` with changed paths, checks run and remaining limitations. "Implemented" is not "verified".
- Use only synthetic data in fixtures and tests. Never commit real conversations, credentials or `.loom/` directories.

## Structure

See README.md for the package map and `docs/adr/` for architecture decisions. Core (`packages/core`) must not import provider, storage or task-system implementations; a test enforces this.

## Design rules worth knowing

- Every stored claim cites a source span; nothing unverifiable is accepted.
- Proposals are not decisions; closed tasks are not evidence; waivers are not passes.
- External systems are never overwritten silently; remote edits are reported.
- Unknown costs stay unknown.
