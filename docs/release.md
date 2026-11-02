# Release gate (CL-022)

Run `pnpm release:check`. It builds, tests, runs the evaluation, audits dependency licenses, scans tracked files for secrets, checks that no local state is tracked, checks documents and versions, bundles the CLI, and runs the demo with the bundle in a clean directory. It never publishes anything.

In CI it runs as `pnpm release:check --allow-pending=license,upstream`, so the two items that need a person show as pending instead of failing.

## Status (2026-11-02)

| Item | State |
| --- | --- |
| Build, tests, eval, license audit (100 prod deps, all permissive), secret scan, docs, versions, bundle smoke | passing locally |
| License | **pending: copyright holder's decision** (see below) |
| Real upstream runs (Beads, Task Master) | **pending**: real-binary suites exist but have not run |
| Live model runs (Claude, Ollama) | not run; opt-in tests exist |
| Name | `context-loom` (and `contextloom`, `ai-plugin-toolkit`) not taken on npm as of 2026-11-02; `loom-memory` and `loom-cli` are taken. A trademark search has not been done. |
| Repository visibility, package publication | **not done**: explicit final actions, below |

## Choosing a license (owner decision)

All runtime dependencies use permissive licenses (MIT, Apache-2.0, ISC, BSD-2/3, Unlicense), so any common open-source license is compatible. Typical choices:

- **Apache-2.0**: permissive with an explicit patent grant; a common default for developer tools.
- **MIT**: shortest and most permissive; no patent clause.

After deciding, add `LICENSE` at the root, set `"license"` in the published package (`LOOM_LICENSE=<SPDX> pnpm bundle`), and rerun `pnpm release:check`.

The Task Master adapter only invokes the separately installed `task-master` CLI. Task Master's Commons Clause restricts selling a product whose value derives substantially from Task Master; review this if Loom is offered commercially with Task Master as a central feature.

## Final steps (manual, in order)

1. Run the real upstream suites (`bd` 1.3.x, `task-master` 0.43.x) and record the results in `docs/adapters/*.md` and tickets CL-011/CL-014.
2. Optionally run the live model tests (`LOOM_LIVE_TESTS=1`) and `pnpm eval -- --provider anthropic` with a budget.
3. Choose and add the license; confirm the name (and trademark check).
4. `pnpm release:check` with no `--allow-pending`: it must print `READY`.
5. Tag the release (`git tag v0.4.0`).
6. With explicit authorisation: change repository visibility; `cd dist-release/loom && npm publish` (after `LOOM_LICENSE=<SPDX> pnpm bundle`).
