# Task Master compatibility notes (CL-009)

Status: **investigated, not implemented.** The second adapter is CL-014 (v0.2).

| Item | Value |
| --- | --- |
| Project | Task Master (`task-master-ai`) |
| Repository | https://github.com/eyaltoledano/claude-task-master |
| Reviewed version | 0.43.1 (npm `task-master-ai@0.43.1`, tag `task-master-ai@0.43.1`) |
| License | MIT **with Commons Clause** ([LICENSE](https://github.com/eyaltoledano/claude-task-master/blob/main/LICENSE)). Using it as a separately installed tool is unaffected; selling a product or service whose value derives substantially from Task Master is not granted. Review this before any bundling or hosted offering. |
| Interfaces | CLI `task-master` (also an MCP server, `task-master-mcp`); data in `.taskmaster/tasks/tasks.json` with tags (state in `.taskmaster/state.json`, "Do not manually edit") |

Sources read: [README](https://github.com/eyaltoledano/claude-task-master/blob/task-master-ai%400.43.1/README.md), [command reference](https://github.com/eyaltoledano/claude-task-master/blob/task-master-ai%400.43.1/docs/command-reference.md), [task structure](https://github.com/eyaltoledano/claude-task-master/blob/task-master-ai%400.43.1/docs/task-structure.md), [`scripts/modules/commands.js`](https://github.com/eyaltoledano/claude-task-master/blob/task-master-ai%400.43.1/scripts/modules/commands.js).

## Findings

| Contract operation | Task Master | Notes |
| --- | --- | --- |
| `createTask` | `task-master add-task --title … --description … [--details …] [--dependencies 1,2] [--priority …]` | Manual creation needs **both** `--title` and `--description`; otherwise `--prompt` invokes an AI provider, which the adapter must never trigger implicitly. |
| `readTasks` | `task-master list` (text) or read `tasks.json` | No `--json` flag in the reviewed reference; reading `tasks.json` directly ties the adapter to the file format. |
| `updateTask` | `update-task --id … --prompt …` is AI-driven | No documented non-AI field update for title/description. |
| `linkDependency` | `task-master add-dependency --id <id> --depends-on <id>` | Supported. |
| status | `task-master set-status --id … --status …` | Loom does not change status. |
| idempotency key / external reference | none documented | Retried creates can't be detected without a convention (e.g. a marker in `details`). |
| revision for conflict detection | none documented | Would need a content hash of the task record. |

## Selection

**Beads was chosen as the first adapter (CL-011)** because it documents `--json` output for every command used, has an `external_ref` field for idempotency, has native dependency edges, an `updated_at` revision, and an MIT license. Task Master's non-AI update path and machine-readable reads need a deeper look (or the MCP interface) before an adapter can meet the same contract without inventing capabilities.

## Real test strategy (for CL-014)

Install the pinned `task-master-ai` into a temporary directory, initialize a disposable project without AI providers configured, and run the shared scenarios in `packages/task-sync/test/scenarios.ts` against it. Any operation that would need an AI call is declared unsupported (`UNSUPPORTED_CAPABILITY`).
