# Quickstart

Prerequisites: Node.js ≥ 22.13 and pnpm 10 (`corepack enable`). Optional: Beads `bd` 1.3.x for task publishing, and `ANTHROPIC_API_KEY` for live extraction with Claude.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

`loom` is not installed on `PATH`. Run it as `node apps/cli/dist/main.js` (the examples below use `alias loom="node $PWD/apps/cli/dist/main.js"`). Every command accepts `--json` and `--dir <project>`.

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

## Live and integration tests

| Test | Runs when | Otherwise |
| --- | --- | --- |
| Claude live smoke test | `LOOM_LIVE_TESTS=1` and `ANTHROPIC_API_KEY` set | skipped (shown as skipped) |
| Real Beads scenarios + CLI publish | `bd` 1.3.x on `PATH` or `LOOM_BD_BIN` | skipped with reason; CL-011 gate stays open |
| Extraction evaluation | `pnpm eval` (fixture) or `pnpm eval -- --provider anthropic` | live run exits 3 with `SKIPPED` without a key |

## Limitations (v0.1)

- One real model provider (Claude). No local inference, so fully local operation (A27) is not supported.
- One task adapter (Beads), one-way. The real-upstream run is pending (see docs/adapters/beads.md).
- Built-in `mobile-release` pack only. Its platform and legal items are advisory, not reviewed against store policies.
- No forgetting/retention, contradiction review, caches, embeddings, MCP or UI yet (v0.2+).
