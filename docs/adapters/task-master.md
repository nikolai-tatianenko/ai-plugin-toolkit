# Task Master compatibility notes (CL-009)

Status: **adapter implemented (CL-014); real-upstream integration not yet run.**

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

## Adapter (CL-014)

- Writes go through the CLI with manual options only: `add-task --title --description --details`, `add-dependency --id --depends-on`, `init --yes --skip-install --no-aliases --no-git`. `--prompt` is never used, so Task Master never calls an AI provider on Loom's behalf.
- Reads parse `.taskmaster/tasks/tasks.json` (tagged format, tag configurable; legacy format accepted). The idempotency key is stored as a `loom-idempotency-key:` line in `details`. The revision is a hash of title, description, details, status and dependencies.
- **Declared capabilities:** readTasks, createTask, linkDependency. **Not supported:** updateTask (no non-AI update upstream) and readChanges. Sync reports each local update as `UNSUPPORTED_CAPABILITY`, and `tasks resolve --keep local` is unavailable.
- Version gate: 0.43.x (`LOOM_TASKMASTER_ALLOW_UNTESTED=1` to override).
- Task Master enables outbound telemetry by default. Loom requires `"anonymousTelemetry": false` inside `global` in `.taskmaster/config.json` before launching it. On a fresh project, `loom tasks init` creates that configuration and the empty tagged task file. For an existing configuration, set the flag alongside the other `global` settings. Loom preserves the existing file.
- Tests: unit tests and the shared sync scenarios against a fake CLI that edits `tasks.json` the documented way (shapes only). The real-binary suite `taskmaster.integration.test.ts` runs when `task-master` 0.43.x is installed (`LOOM_TASKMASTER_BIN`); **not yet run**.

## Real test strategy

Install the pinned `task-master-ai` into a temporary directory, initialize a disposable project without AI providers configured, and run the shared scenarios in `packages/task-sync/test/scenarios.ts` against it. Any operation that would need an AI call is declared unsupported (`UNSUPPORTED_CAPABILITY`).
