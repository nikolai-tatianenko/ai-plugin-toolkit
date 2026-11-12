# Release gate (CL-022)

Run `pnpm release:check`. It builds, tests, runs the evaluation, audits dependency licenses, scans tracked files for secrets, checks that no local state is tracked, checks documents and versions, bundles the CLI, and runs the demo with the bundle in a clean directory. It never publishes anything.

In ordinary Linux CI it runs as `pnpm release:check --allow-pending=upstream,live,macos`. Missing verification is reported as **PENDING**, never READY. A final release must run without exceptions.

## Execution evidence (required for READY)

The gate requires separate JSON receipts for **Beads, Task Master, Claude extraction, Ollama extraction, and a clean macOS installation**. Editing adapter documentation cannot satisfy it. A skipped integration test cannot satisfy it either.

Build first, then run each verification on hosts with the required tools:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm verify:release -- beads       # actual bd 1.3.x; includes CLI publish/rerun
pnpm verify:release -- taskmaster  # actual task-master 0.43.x

# ANTHROPIC_API_KEY must already be available in this shell.
# Select a model available to your account. One synthetic extraction request,
# max 3000 output tokens, one attempt; this is a paid live API call.
LOOM_ANTHROPIC_MODEL=<model-id> pnpm verify:release -- anthropic

# Start Ollama and pull the chosen model separately. Only loopback endpoints
# qualify for the local Ollama receipt; no model is downloaded by this command.
LOOM_OLLAMA_MODEL=<installed-model> pnpm verify:release -- ollama

# Run on your Mac, or download the macOS CI artifact for this source snapshot.
pnpm verify:release -- macos
pnpm release:check
```

Receipts are written to ignored `.release-evidence/<suite>.json`. They contain scenario names, status, timestamp, Node/OS versions, upstream version or real extraction model/usage, and a SHA-256 digest of source files. They contain no API keys or conversation text. Receipts are local execution records, not cryptographic attestations.

The digest includes tracked and new non-ignored files. A source, test, lockfile or documentation change invalidates previous results. Finish license/documentation edits before collecting final receipts. An unsuccessful rerun removes that suite's previous receipt. Missing, skipped, failed, malformed, wrong-host or stale evidence blocks READY.

Set `LOOM_RELEASE_EVIDENCE_DIR` to an absolute directory **outside the checkout** to share receipts across hosts. Verify identical source content on each host, combine the five JSON files, and use the same variable for `release:check`. Treat downloaded receipts as evidence from a trusted run, never as proof from an unknown contributor.

The macOS CI matrix runs Node 22 and 24. Each job installs dependencies in a fresh temporary source directory, builds, packs and installs the bundled CLI into a temporary prefix, then runs the synthetic workflow and idempotency checks through the installed CLI. Artifacts are named `macos-release-evidence-node-22` and `macos-release-evidence-node-24`. CI evidence establishes that runner's compatibility; it does not establish that the user's Mac has been configured.

To diagnose a failed live workflow, run `LOOM_LIVE_TESTS=1 pnpm exec vitest run apps/cli/test/live-extraction.test.ts --testNamePattern 'live extraction: anthropic'` (or `ollama`) with the same model variables. Verification intentionally avoids printing captured subprocess output, which may contain sensitive provider diagnostics.

## Status (2026-11-02)

| Item | State |
| --- | --- |
| Build, tests, eval, license audit (100 prod deps, all permissive), secret scan, docs, versions, bundle smoke | passing locally |
| License | **MIT** (decided 2026-11-08, matching quality-gates; `LICENSE`, copyright Nikolai Tatianenko) |
| Real upstream runs (Beads, Task Master) | **pending**: real-binary suites exist but have not run |
| Live model runs (Claude, Ollama) | not run here; real extraction workflows and receipts now required |
| macOS clean installation | CI on Node 22/24 added; passing execution receipt required |
| Name | `context-loom` (and `contextloom`, `ai-plugin-toolkit`) not taken on npm as of 2026-11-02; `loom-memory` and `loom-cli` are taken. A trademark search has not been done. |
| Repository visibility, package publication | **not done**: explicit final actions, below |

## License

MIT, copyright 2026 Nikolai Tatianenko. All runtime dependencies use permissive licenses (MIT, Apache-2.0, ISC, BSD-2/3, Unlicense) compatible with it. The bundle (`pnpm bundle`) ships `LICENSE` and declares `"license": "MIT"`.

The Task Master adapter only invokes the separately installed `task-master` CLI. Task Master's Commons Clause restricts selling a product whose value derives substantially from Task Master; review this if Loom is offered commercially with Task Master as a central feature.

## Final steps (manual, in order)

1. Confirm the package name (license: MIT, done). Finish source/documentation changes before collecting receipts.
2. Run the five verification commands above ([docs/local-verification.md](local-verification.md)), including live extraction and macOS, and collect matching receipts. Update adapter notes and recollect receipts if documentation changes.
3. Optionally run the larger `pnpm eval -- --provider anthropic` evaluation with a budget. The tiny live workflow establishes integration behavior, not a general extraction-quality benchmark.
4. `pnpm release:check` with no `--allow-pending`: it must print `READY`.
5. Tag the release (`git tag v0.4.0`).
6. With explicit authorisation: change repository visibility; `pnpm bundle && cd dist-release/loom && npm publish`.
