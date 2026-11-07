# Checklists, review requests and layered memory

These extensions are included in the `loom` CLI. They add three reusable packages:

| Package | Contract |
| --- | --- |
| `workspace` | Checklist templates/instances, private profile, scoped notes, portable project state, optional shared-memory HTTP client/server |
| `hooks` | Host adapters, lifecycle reflection, context checkpoint policy, configuration generation and merge/uninstall |
| `review` | Review preview and provider-independent `ReviewAdapter`; GitHub PR and GitLab MR HTTP implementations |

SQLite schema v4 adds project-scoped revisioned plugin documents. Existing databases receive a backup before migration. Edits use optimistic concurrency: read a record's `revision`, then pass `--expected-revision N`; new records use `0`. Stale writes fail. Deletion records a tombstone and retains revision history; it is not secure erasure. SQLite backups include these records. Source forgetting does not erase manually authored notes or session checkpoints: inspect and delete those separately. Backups and exports remain separate copies.

## 1. Create and manage a checklist

```bash
loom init --project-id my-project
loom checklists template init delivery --out delivery.json
# Edit delivery.json: add/edit/remove items, requirements and accepted evidence environments.
loom checklists template save --file delivery.json
loom checklists templates
loom checklists template show delivery
loom checklists create release-one --template delivery
loom checklists list
loom checklists show release-one
```

Starter format:

```json
{
  "format": "loom-checklist/1",
  "id": "delivery",
  "version": "1.0.0",
  "title": "Delivery",
  "items": [
    {
      "id": "tests",
      "title": "Regression tests",
      "expected": "Relevant regression tests pass against the current source revision",
      "severity": "major",
      "environments": ["ci"]
    }
  ]
}
```

The richer `loom-pack/1` format is also accepted, including applicability questions and dependencies. `--template web-release` and the other built-in packs work without importing a template. Templates are reusable definitions; instances are independent immutable definition snapshots. To change a template, increment its version and save with `--expected-revision`. Create a new instance to use the changed definition: previous evidence cannot silently pass a changed definition. Deleting a template leaves existing instances intact.

```bash
loom revision set --from-git
loom questions --pack release-one
loom answer <question> <value> --pack release-one
loom evidence add tests --pack release-one --result passed --env ci --revision <commit> --ref <CI-URL>
loom checklists report release-one
loom waive tests --pack release-one --reason "Owner accepted this exception"
loom accept tests --pack release-one
loom checklists export release-one --out release-one.json
loom checklists archive release-one --expected-revision 1
loom checklists template delete delivery --expected-revision 1
```

Acceptance and passing evidence stay separate. A waiver is labelled as waived. Advancing the source revision makes older evidence stale. Archived instances cannot be published in a review preview and are removed from active pack reports. Readiness is available through `loom report --require-ready --pack <instance>` for automation.

## 2. Define a GitHub PR or GitLab MR

Write `review-target.json`:

```json
{
  "provider": "github",
  "repository": "owner/repository",
  "base": "main",
  "head": "feature/delivery",
  "title": "Deliver the checklist solution",
  "body": "Problem, resulting behavior and validation.",
  "draft": true,
  "tokenEnv": "GITHUB_TOKEN",
  "allowWrites": false
}
```

Use `provider: "gitlab"` for GitLab, with an optional `apiUrl` for a self-hosted API (for example `https://gitlab.example.com/api/v4`). `repository` accepts nested namespaces. Set `number` to bind an existing PR number or GitLab project-scoped MR IID. An existing request must have the configured source and target branches. Draft state applies at creation; updating a GitHub PR's body does not change its draft/ready state.

```bash
loom reviews define solution --file review-target.json
loom reviews targets
loom reviews show solution
loom reviews preview solution --checklists release-one
# After reviewing, edit allowWrites to true and save the target's next revision:
loom reviews define solution --file review-target.json --expected-revision 1
# Set the named token in your shell separately, then explicitly publish:
loom reviews publish solution --checklists release-one
```

Preview has no host calls and needs no token. Publish finds an open request for the configured branch pair, then creates or updates it. Reruns update the existing request. It does not push code, merge, approve, or publish packages. Existing remote descriptions are replaced with the defined body and current checklist report, so review the preview first. HTTP failures are surfaced, and redirects are refused so credentials are not forwarded elsewhere. Restricted projects refuse review publication to remote hosts.

## 3. Define the user and memory layers

| Layer | Location and purpose | Network behavior |
| --- | --- | --- |
| User | Separate private database; identity, goals, preferences, user notes | Never included in shared-server push or project export |
| Shared | Project database; team/project facts, decisions and goals | Local until an explicit push |
| Server | Optional authenticated service; pulled snapshot cached separately | Explicit `pull`/`push`; normal reads and hooks remain offline |

Create `profile.json`:

```json
{ "id": "nick", "name": "Nick", "goals": ["Ship reliable modular tools"], "preferences": ["Small measurable steps"] }
```

```bash
loom profile set --file profile.json
loom profile show
```

Private storage defaults to `~/.context-loom/private`. Set `LOOM_USER_HOME` or `memory.userStoreDir` to use another directory/identity. Use a directory outside the checkout for private data. Directory mode is 0700 and the database mode is 0600 on Unix. Each OS user's private store is separate; this is a local single-user trust boundary, not hosted multi-user authentication.

Create `memory.json`:

```json
{
  "id": "architecture",
  "text": "Use reusable plugins for integrations",
  "kind": "preference",
  "status": "confirmed",
  "provenance": "User explicitly requested modular plugins",
  "tags": ["architecture"]
}
```

```bash
loom notes put --layer user --file memory.json
loom notes put --layer shared --file memory.json
loom notes list --layer user
loom notes show architecture --layer shared
loom notes put --layer shared --file memory.json --expected-revision 1
loom notes context
loom notes delete architecture --layer shared --expected-revision 2
```

Kinds: `fact`, `goal`, `preference`, `decision`, `checkpoint`. Status: `proposed`, `confirmed`, `rejected`. Only confirmed notes enter layered context. Stored text is untrusted reference data, not permission or higher-priority instructions. The original source-cited extraction memory remains available through `memory`, `search` and `context`; `notes context` and SessionStart hooks supply the new layers. MCP exposes checklist listing/creation/template management and shared memory; MCP writes are disabled by default and agent-authored shared notes are always proposed. Private identity is supplied locally by session hooks, not exposed by the shared-memory MCP tool.

Project `export`/`import` includes shared notes, templates, instances and review-target definitions. It excludes private identity, private notes, session checkpoints, and cached server memory. Imported review targets always have external writes disabled. Document edit revisions restart at 1 after a portable import; SQLite backup/restore retains full history. Stored definitions and checkpoints are local data, so ignore the storage directory in version control.

## 4. Optional shared-memory server

Add this section to `loom.config.json`:

```json
{
  "memory": {
    "checkpointPercent": 70,
    "server": {
      "url": "http://127.0.0.1:7331",
      "tokenEnv": "LOOM_MEMORY_TOKEN",
      "allowWrites": false,
      "timeoutMs": 10000
    }
  }
}
```

Set a random token of at least 24 characters in the named environment variable. A separate server project can use the same project ID and its own storage directory. Start it with `loom memory-server serve --port 7331`. It binds to loopback and serves **one project**. For remote hosting, put it behind an authenticated TLS reverse proxy and configure an HTTPS URL. A token authorizes access to that single project's confirmed shared snapshot. This is an optional small service, not a multi-tenant cloud product.

```bash
loom memory-server pull
loom notes list --layer server
# Explicitly enable memory.server.allowWrites, then use the revision returned by pull:
loom memory-server push --expected-revision 0
```

Push replaces the server's shared snapshot, including removing notes omitted from the snapshot. It sends only confirmed shared notes, excluding private data and checkpoints. `--expected-revision` prevents overwriting concurrent server updates. Pull caches the server layer without overwriting locally authored shared notes. Review/resolve differing notes locally before the next push. The service rejects missing revision preconditions, invalid snapshots, unauthorized tokens, cross-project paths and bodies above 1 MiB. The client bounds responses, sets deadlines and refuses redirects. Restricted projects cannot connect to a non-loopback server. No remote service is contacted by default.

## 5. Claude and Codex hooks

```bash
loom hooks manifest --client claude
loom hooks install --client claude --dry-run
loom hooks install --client claude
loom hooks install --client codex
```

The installer merges project `.claude/settings.json` or `.codex/hooks.json`, preserves unrelated handlers, creates a private backup before changes, and deduplicates its own command. Use the same installed CLI path when rerunning/uninstalling. Run `loom hooks uninstall --client <client>` to remove those commands. Generated commands use absolute, shell-quoted Node/CLI/project paths, so reinstall on another machine. macOS/Linux shells are supported; Windows shell integration is not verified. Review/trust installed Codex hooks through the host's `/hooks` UI. Restart/reload your agent when its configuration requires it. No hook is installed merely by initializing a Loom project.

| Event | Behavior |
| --- | --- |
| `SessionStart`, `PostCompact` | Inject bounded private identity/goals, confirmed user/shared notes, and the explicitly cached server layer |
| `PostToolUse` | On the measured 70% crossing, save a checkpoint and ask the agent to persist durable memory updates |
| `Stop` | Save the supplied final message locally and request one self-reflection continuation; `stop_hook_active` prevents an endless loop |
| `PreCompact` | Save current project memory/checklist state locally before compaction |
| Usage bridge | Persist measured context usage and queue one reflection prompt for the next tool hook |

The threshold is configurable through `memory.checkpointPercent` (1–100). It measures **context-window usage**, not task completion or cumulative billing tokens. The crossing is session-scoped, deduplicated and rearmed when usage falls below the threshold. Checkpoints remain proposed/untrusted, never silently promoted to confirmed user decisions. Inspect them with `loom checkpoints list|show <id>` and remove them with `delete <id> --expected-revision N`. Hooks never publish reviews, sync servers or make paid model calls.

Claude: if no status line exists, installation adds a `loom hook usage --client claude` status-line command to consume `context_window.used_percentage`. An existing status line is preserved; chain the usage command from it to enable exact threshold measurements. PostToolUse itself need not contain a usage field.

Codex: lifecycle hooks do not promise a context percentage. Integrations can pass native `thread/tokenUsage/updated` app-server notifications to `loom hook usage --client codex` on stdin. The adapter uses the **last request** token count and model context window, never the session's cumulative total. Use `loom hook proxy --client codex` in place of `codex app-server` in your app-server client configuration: it forwards stdin/stdout protocol messages and automatically observes usage updates. `LOOM_CODEX_BIN` optionally selects the Codex executable. Alternatively wire notifications from an existing app-server consumer. Installing lifecycle hooks alone does not guarantee the exact 70% trigger. Stop and PreCompact remain useful without usage telemetry. This implementation does not scrape undocumented transcript formats or invent a percentage.

For either host, a canonical telemetry bridge accepts:

```json
{
  "session_id": "host-session-id",
  "hook_event_name": "ContextUsage",
  "usage": { "usedTokens": 140000, "contextWindowTokens": 200000 }
}
```

Native hooks receive/return plain host-protocol JSON without Loom's normal `--json` envelope. Invalid input reports a hook failure; there is no fabricated memory update. Native host sessions, real model extraction and live GitHub/GitLab API behavior require their own execution evidence; synthetic/stub tests do not establish that those environments passed.

Official protocol references reviewed for this implementation: [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude status line](https://code.claude.com/docs/en/statusline), [Codex hooks](https://developers.openai.com/codex/hooks), [Codex app-server](https://developers.openai.com/codex/app-server).
