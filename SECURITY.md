# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**: use GitHub's "Report a vulnerability" (private security advisory) on this repository, or contact the maintainer listed on the repository profile. Do not open a public issue for a security problem. Include steps to reproduce and the version (`loom --version`).

Expect an acknowledgement within 7 days. Fixes are released as patch versions and noted in CHANGELOG.md.

## Supported versions

Only the latest released minor version receives security fixes. Nothing has been published yet; until a first release, report against the `main` branch.

## Security model (summary)

- **Local-first.** Data stays in the project's storage directory (`.loom/`, git-ignored by `loom init`). Remote model providers receive the evidence you extract, under the provider's own terms. Restricted projects (`sensitivity: restricted`) are refused remote providers at config validation and again at call time.
- **Credentials** are referenced by environment-variable name only; the config schema rejects literal keys. Output, traces and audit records are redacted.
- **Untrusted evidence.** Imported text is data, never instructions: it is wrapped in escaped evidence blocks, and extraction cannot change acceptance or task state. A claim quoted verbatim from injected text can still pass validation (see docs/adr/0005).
- **External tools** (`bd`, `task-master`) run via `execFile` without a shell, with literal `--flag=value` arguments and validated IDs.
- **MCP** runs over stdio only. Read tools use a read-only database connection; write tools are off unless `mcp.allowWrites` is true.
- **Inspector** binds to loopback, needs a per-run token, rejects non-loopback `Host` headers, is GET-only and read-only, and sends a strict CSP.
- **Deletion:** `loom forget` removes derived data and scrubs the database file, but not backups, exports, git history or upstream systems (docs/data-lifecycle.md).
- Multi-user or network hosting is not supported and needs a separate authorization review.
