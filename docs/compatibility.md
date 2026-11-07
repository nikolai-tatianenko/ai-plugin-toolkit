# Compatibility

| Component | Supported / tested | Notes |
| --- | --- | --- |
| Node.js | 22.13+ (tested 22.23.4 locally; CI on 22 and 24) | needs built-in `node:sqlite` |
| OS | Linux (tested), macOS (clean-install CI added, passing receipt required), Windows (untested) | paths are handled with `node:path`; `bd`/`task-master` must be on PATH |
| SQLite | bundled with Node (3.53.x on Node 22.23) | FTS5 required (present in Node's build) |
| Claude API | `@anthropic-ai/sdk` 1.3.0, default model `claude-opus-5-5` | tested against a local HTTP stub; live test opt-in |
| Ollama | HTTP API `/api/chat`, `/api/embed` | tested against a local stub; live test opt-in |
| Beads (`bd`) | 1.3.x (docs and source of v1.3.2 reviewed) | real-binary suite skips when `bd` is absent: **not yet run** |
| Task Master | 0.43.x (`task-master-ai@0.43.1` reviewed) | create/link only; no non-AI update upstream; real-binary suite **not yet run** |
| MCP | `@modelcontextprotocol/sdk` 1.32.0, stdio transport | tested with the SDK client in memory and over a real stdio process |
| Browsers (inspector) | Chromium via Playwright 1.63.0 | other browsers expected to work, not tested |

Schema migrations are forward-only. A newer database is refused by an older build without modification. A backup is written before migrating an existing database.

Workspace extensions: schema v4; GitHub REST PR and GitLab REST MR adapters tested with deterministic transports, not live host accounts. The optional memory server is exercised over real loopback HTTP with authentication and revision conflicts. Claude/Codex native JSON hooks and generated shell commands are exercised locally. Real native host sessions are not verified here. See [workspace setup and telemetry limitations](workspace.md).
