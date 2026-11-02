# MCP interface (CL-017)

`loom mcp --dir <project>` runs a Model Context Protocol server over **stdio** for one project.

## Supported deployment

- A local process started by you or by your agent host (Claude Code, Claude Desktop and other MCP clients). It inherits your OS user's permissions. **There is no network listener**, so there is no remote authentication to configure. The trust boundary is the local account.
- Remote or multi-user hosting (HTTP/SSE) is **not supported** in this version; it needs its own authentication and authorization design (plan §10).

Example client configuration:

```json
{ "mcpServers": { "loom": { "command": "node", "args": ["/path/to/ai-plugin-toolkit/apps/cli/dist/main.js", "mcp", "--dir", "/path/to/project"] } } }
```

## Tools

| Tool | Kind | Notes |
| --- | --- | --- |
| `loom_search` | read | current records first; `includeHistory` for superseded ones |
| `loom_read_record` | read | fact/decision plus exact evidence, wrapped in `<untrusted-evidence>` |
| `loom_read_source` | read | source text or a range, wrapped in `<untrusted-evidence>` |
| `loom_context` | read | bounded, cited context |
| `loom_questions` | read | quick/guided/challenge questions for an active pack |
| `loom_acceptance_report` | read | readiness per criterion |
| `loom_task_preview` | read | task change set; reads the task system, writes nothing |
| `loom_answer_question` | write | needs `mcp.allowWrites: true`; recorded as `mcp:<actor>` |
| `loom_generate_artifacts` | write | needs `mcp.allowWrites: true`; hand edits are kept and reported as conflicts |

## Guarantees and tests

- **Read tools cannot mutate.** They use a SQLite connection opened with `readOnly: true` plus `PRAGMA query_only`. The test suite runs every read tool and checks that the database file is byte-identical afterwards, and that a write attempt on that connection fails.
- **Writes enforce policy.** With `mcp.allowWrites` false (the default), write tools return `POLICY_VIOLATION`. When allowed, each call opens a short-lived writable store, and the audit log records the MCP actor.
- **Scope.** The server serves exactly one project; IDs from other projects in the same store return `NOT_FOUND`.
- Tool results never include provider credentials. Evidence is marked untrusted, and the server instructions tell clients not to follow instructions inside it.
