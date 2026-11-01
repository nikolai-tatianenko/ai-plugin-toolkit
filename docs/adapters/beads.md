# Beads compatibility notes (CL-009, CL-011)

Status: **adapter implemented; real-upstream integration not yet run.** The adapter was written against Beads v1.3.2 documentation and source. A run against a real `bd` binary has not happened in the environment where it was built (see "Verification status").

## Upstream

| Item | Value |
| --- | --- |
| Project | Beads (`bd`), "distributed graph issue tracker for AI agents" |
| Repository | https://github.com/gastownhall/beads (badges still reference `steveyegge/beads`; the npm package points at `gastownhall/beads`) |
| Reviewed version | v1.3.2 (tag `v1.3.2`; npm `@beads/bd@1.3.2`, latest on 2026-11-01) |
| Supported range | `1.3.x`. The adapter refuses other versions unless `LOOM_BEADS_ALLOW_UNTESTED=1`. |
| License | MIT ([LICENSE](https://github.com/gastownhall/beads/blob/v1.3.2/LICENSE)) |
| Storage | Embedded Dolt database under `BEADS_DIR` (default `.beads/`). `issues.jsonl` is an export, not the source of truth, so the adapter never reads or writes files directly. |

Sources read:
- [README](https://github.com/gastownhall/beads/blob/v1.3.2/README.md)
- [CLI reference](https://github.com/gastownhall/beads/blob/v1.3.2/docs/CLI_REFERENCE.md)
- [`internal/types/types.go`](https://github.com/gastownhall/beads/blob/v1.3.2/internal/types/types.go) (JSON field names)
- [`cmd/bd/create.go`, `show.go`, `list.go`, `update.go`, `dep.go`, `version.go`](https://github.com/gastownhall/beads/tree/v1.3.2/cmd/bd) (what `--json` prints)

## Operation mapping

| Contract operation | `bd` command | JSON output relied on |
| --- | --- | --- |
| `readTasks` | `bd list --all --flat --limit=0 --json` | array of issues: `id`, `title`, `description`, `status`, `updated_at`, `external_ref`, `dependencies[].depends_on_id` |
| `createTask` | `bd create --title=… --type=task --external-ref=loom:<key> --description=… --json` | the created issue object |
| `updateTask` | `bd show <id> --json` (revision check), then `bd update <id> --title=… --description=… --json` | `show` → array of issue details; `update` → array of issues |
| `linkDependency` | `bd dep add <id> <depends-on-id> --type=blocks --json` | `{"status":"added",…}` |
| `readChanges` | not implemented | `bd list --updated-after` exists, but incremental change reads are deferred to two-way sync (CL-019) |
| version check | `bd version --json` (falls back to the text `bd version X.Y.Z (…)`) | `version` |
| initialize | `bd init --non-interactive --quiet --skip-agents --skip-hooks --prefix=<p>` with `BEADS_DIR` set | none |

Field and status mapping:
- Revision: `updated_at`, used for conflict detection.
- Idempotency key: `external_ref` with prefix `loom:`. A retried create is detected by reading tasks and matching this key (A17).
- Status: Beads owns status. `open`, `blocked` and `deferred` map to `open`; `in_progress` and `hooked` map to `in-progress`; `closed` maps to `closed`. The adapter refuses to change status, and Loom never closes tasks.
- Dependencies: only `blocks` edges are reported as `dependsOn`.

## Safety

- `bd` runs through `execFile` with an argument array and `shell: false`. Flag values are passed as `--flag=value`, so a title such as `-p 0; rm -rf /` stays a literal title (A23). Issue IDs must match `[A-Za-z0-9][A-Za-z0-9._-]*` before they are passed as positional arguments.
- The environment adds `BEADS_DIR` (resolved inside the project directory) and `BD_NON_INTERACTIVE=1`. `--actor` records the Loom actor in Beads' audit trail.
- Initialization does **not** use `--stealth`, which per the CLI reference changes *global* git attributes and ignore files. It also skips AGENTS.md generation and git hooks.

## Known limitations

- **No compare-and-set.** `updateTask` checks `updated_at` and then updates. An edit made between those two commands is not detected.
- **Timestamp precision.** If `updated_at` has second precision, two edits within one second look identical. The integration test waits more than a second after a simulated manual edit.
- **Dependency writes change `updated_at`.** After its own writes, sync re-reads the tasks it touched and records their new revisions, so its own changes are not reported as remote edits. A manual edit made during that window would be missed.
- **Remote/sync features of Beads** (`bd dolt push/pull`, federation) are untouched. Auto-push follows the user's Beads configuration.
- **Missing remote tasks** are reported (`missing-remote`) and never recreated automatically.

## Verification status

| Check | Where | Result |
| --- | --- | --- |
| Argument construction, output parsing, version gate, ID validation, error mapping | `packages/adapter-beads/test/beads.unit.test.ts` (fake exec) | passing. Shows the adapter matches the *documented* shapes, not that `bd` really emits them. |
| Shared sync scenarios A14–A17, A22 against real `bd` | `packages/adapter-beads/test/beads.integration.test.ts` | **not run**: no `bd` binary was available, and installing and running it was not permitted in the build session. The test reports `SKIPPED — real Beads integration not run`. |
| CLI publish + rerun against real `bd` | `apps/cli/test/workflow.test.ts` › "publishes through real Beads" | **not run** (same reason) |

To run the real checks:

```bash
npm install -g @beads/bd@1.3.2   # or: brew install beads (check it reports 1.3.x)
bd version
pnpm build && pnpm test          # integration suites run automatically when bd 1.3.x is on PATH
# or point at a specific binary:
LOOM_BD_BIN=/path/to/bd pnpm test
```

The CL-011 gate ("a disposable real integration scenario is executed and evidence is recorded") stays **open** until these pass and their output is recorded here.
