# Quickstart

Prerequisites: Node.js ≥ 22.13 and pnpm 10 (`corepack enable`). Optional: Beads `bd` 1.3.x for task publishing, and `ANTHROPIC_API_KEY` for live extraction with Claude.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

To put `loom` on your `PATH`, build the self-contained bundle and install it globally:

```bash
pnpm bundle && npm install -g ./dist-release/loom
```

Or run it in place as `node apps/cli/dist/main.js` (e.g. `alias loom="node $PWD/apps/cli/dist/main.js"`). Every command accepts `--json`. Without `--dir`, `loom` uses the nearest directory at or above the current one that contains `loom.config.json`. Set the build revision from git with `loom revision set --from-git`.

## 1. Offline demo (recorded extraction, no credentials)

```bash
bash examples/synthetic/demo.sh /tmp/loom-demo
```

The script runs the whole flow on the synthetic kickoff conversation, using the recorded fixture `examples/synthetic/fixtures/extraction.json` instead of a model. The steps are below.

```bash
loom init --dir demo --project-id habit --provider fixture --fixture recorded.json --tasks beads
loom ingest --dir demo kickoff-conversation.json
loom extract --dir demo                    # 7 cited records; reruns are skipped
loom memory list --dir demo                # facts, decisions (PostgreSQL proposed, SQLite confirmed)
loom memory show --dir demo <dec_…>        # the exact quote behind a decision
loom search --dir demo storage
loom context --dir demo offline reminders --max-chars 1200
loom assess --dir demo --pack mobile-release
loom questions --dir demo --mode quick     # highest-impact questions, with unconfirmed memory suggestions
loom answer --dir demo purchases no        # purchase criteria become not-applicable, with rationale
loom revision set --dir demo build-41
loom evidence add --dir demo offline.core-flows --result passed --env physical-device --description "Pixel 8"
loom report --dir demo
loom generate --dir demo                   # loom-docs/{FACTS,VISION,PLAN,STATUS,ACCEPTANCE}.md + decisions/
loom tasks preview --dir demo              # needs bd 1.3.x; writes nothing
```

## 2. Live extraction with Claude

```bash
export ANTHROPIC_API_KEY=…                  # never put keys in loom.config.json; the schema rejects them
loom init --dir live --provider anthropic   # providers.claude → claude-opus-5-5, routing.extraction
loom ingest --dir live notes.md
loom extract --dir live                     # reports provider, model, tokens and cost (or "unknown")
```

`loom.config.json` routing excerpt:

```json
{
  "providers": { "claude": { "adapter": "anthropic", "location": "remote", "model": "claude-opus-5-5", "apiKeyEnv": "ANTHROPIC_API_KEY" } },
  "routing": { "extraction": { "providers": ["claude"], "timeoutMs": 120000, "maxAttempts": 2, "maxOutputTokens": 16000 } }
}
```

Add more provider names to `routing.extraction.providers` to allow fallbacks. A project with `"sensitivity": "restricted"` may only list `local` providers, and this is checked at config validation and again on every call.

## 3. Publishing tasks to Beads

```bash
npm install -g @beads/bd@1.3.2              # see docs/adapters/beads.md
# in loom.config.json: "tasks": { "adapter": "beads", "allowWrites": true }
loom tasks init                             # creates .beads/ (no AGENTS.md, hooks or global git changes)
loom tasks preview                          # change set: create / link / update / conflict …
loom tasks sync                             # publish; rerun is a no-op
loom tasks list
```

Edits made in Beads are reported and never overwritten. Status is owned by Beads, and closing a task there does not pass a criterion: record evidence with `loom evidence add`.

## 4. Corrections, review and forgetting

```bash
loom correct storage "SQLite with iCloud sync" --reason "users asked for backup"   # supersedes, keeps history
loom review list                                    # cross-source supersessions, possible contradictions
loom review resolve <id> --action accept|revert|dismiss   # or --keep <record-id>
loom forget <source-id> --yes                       # deletes the source and everything derived from it
loom export --out project.json && loom import project.json   # into an empty project
```

See [data-lifecycle.md](data-lifecycle.md) for what forgetting can and cannot reach.

## 5. Local models, embeddings and caches

```bash
loom init --dir local --provider ollama --model llama3.1:8b --embeddings ollama   # nothing leaves the machine
loom init --dir offline --provider fixture --fixture recorded.json --embeddings hashing
loom embed && loom search reminders offline --semantic
loom cache stats
```

## 6. More packs and imported evidence

```bash
loom assess --pack open-source-release        # also: web-release, ai-feature, or --pack-file my-pack.json
loom evidence import junit.xml --revision v1.2.0   # junit-xml/1; also loom-build/1 JSON, loom-review/1 Markdown
```

A criterion passes from imported results only if at least one result matched it and every matched result passed.

## 7. Agents and the inspector

```bash
loom mcp --dir <project>          # MCP over stdio (read tools; writes only if mcp.allowWrites)
loom inspect --dir <project>      # read-only web UI on 127.0.0.1 with a token URL
```

## 8. Two-way task sync and recovery

```bash
loom tasks pull                   # status comes back; remote edits are kept for a decision
loom tasks conflicts
loom tasks resolve <task-id> --keep remote   # or --keep local (publishes over the edit; needs allowWrites)
loom db backup && loom db status && loom db restore <file> --yes
```

## Live and integration tests

| Test | Runs when | Otherwise |
| --- | --- | --- |
| Claude live smoke test | `LOOM_LIVE_TESTS=1` and `ANTHROPIC_API_KEY` set | skipped (shown as skipped) |
| Real Beads scenarios + CLI publish | `bd` 1.3.x on `PATH` or `LOOM_BD_BIN` | skipped with reason; CL-011 gate stays open |
| Real Task Master scenarios | `task-master` 0.43.x or `LOOM_TASKMASTER_BIN` | skipped with reason; CL-014 gate stays open |
| Ollama live test | `LOOM_LIVE_TESTS=1 LOOM_OLLAMA_MODEL=<model>` | skipped |
| Inspector browser tests | Playwright Chromium installed | skipped with reason |
| Extraction evaluation | `pnpm eval` (fixture) or `pnpm eval -- --provider anthropic` | live run exits 3 with `SKIPPED` without a key |

## Limitations (0.4.0)

- Real upstream runs (Beads, Task Master) and live model runs are pending; see plan §14.
- Fully local operation (Ollama) is verified with outside network access denied against a local Ollama-compatible stub, not yet against a real Ollama model.
- Pack items about platform and legal rules are advisory. Normalization makes no compliance claim.
- MCP and the inspector are local-only.
