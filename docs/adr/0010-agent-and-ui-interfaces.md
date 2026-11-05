# ADR 0010: MCP over stdio and a loopback-only inspector, both read-only by construction

Status: accepted for v0.3/v0.4 (CL-017, CL-020)
Date: 2026-11-02

## Decision

- **MCP** runs over stdio only (`loom mcp`); the trust boundary is the local OS account. Read tools use a SQLite connection opened `readOnly` with `PRAGMA query_only`, so a bug in a read tool cannot write. Write tools (answer question, generate artifacts) are off unless `mcp.allowWrites`. They open a short-lived writable store and are audited as `mcp:<actor>`. Evidence in results is wrapped as untrusted.
- **Inspector**: an HTTP server bound to loopback that answers GET only, over a read-only store. A random per-run token is required for API calls (the UI moves it out of the address bar). Non-loopback `Host` headers are rejected (DNS rebinding), and responses carry a strict CSP (no inline scripts), `nosniff`, `no-referrer` and `no-store`. The React UI is bundled with esbuild and type-checked separately.
- Remote or multi-user hosting of either interface is out of scope until an authorization design exists.

## Consequences

- Accessibility is checked automatically with axe-core plus keyboard tests; a manual screen-reader pass is still recommended before release.
