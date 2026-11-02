# Inspector (CL-020)

`loom inspect [--port <n>]` starts a **read-only** web inspector for the project and prints a URL like `http://127.0.0.1:<port>/?token=…`.

## What it shows

- **Overview:** counts, readiness per active pack.
- **Memory:** facts and decisions with status. Each has a "Trace to source" link to the exact quoted evidence, and "Open in source" highlights the cited span in the original text. Decisions show their supersession chain.
- **Acceptance:** every criterion's applicability, verification and disposition. Each links to its evidence, with environment, revision, recorder and importer, and whether the item **counts** (e.g. emulator evidence for a physical-device criterion does not). Linked tasks are shown with a reminder that task status is not verification.
- **Review:** possible contradictions and cross-source supersessions.
- **Tasks:** local tasks, remote edits, and an on-demand change preview (reads the task system, writes nothing).
- **Usage:** routing totals per task (including background embedding work) and recent routing decisions; unknown cost is shown as unknown.
- **Artifacts:** latest generated revisions.

## Security model

- Binds to `127.0.0.1` only and answers `GET` only. The database connection is read-only.
- Every API call needs the random per-run token from the printed URL. The UI moves the token out of the address bar on load.
- Requests whose `Host` header is not loopback are rejected (DNS-rebinding defence). Responses carry a strict Content-Security-Policy, `nosniff`, `no-referrer` and `no-store`.
- Not designed for multi-user or remote hosting.

## Tests

`packages/inspector/test/inspector.test.ts` runs the real server and real Chromium (Playwright):
- token, `Host` and method checks;
- fact → exact source span, and criterion → evidence with the "counts" flag;
- keyboard operation (skip link, navigation, focus moving to each view heading);
- an axe-core scan of every view with no serious or critical violations;
- a 375 px viewport check for horizontal overflow, with screenshots.

Browser tests are skipped (and say so) if Playwright is not available.
