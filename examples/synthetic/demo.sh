#!/usr/bin/env bash
# Offline end-to-end demo on synthetic data (no credentials, no network).
# Usage: bash examples/synthetic/demo.sh [target-dir]
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target="${1:-$(mktemp -d)/loom-demo}"
loom() { node "$repo/apps/cli/dist/main.js" --dir "$target" "$@"; }
export LOOM_ACTOR="${LOOM_ACTOR:-demo}"

if [[ ! -f "$repo/apps/cli/dist/main.js" ]]; then echo "Run 'pnpm install && pnpm build' first." >&2; exit 1; fi
mkdir -p "$target"
cp "$repo/examples/synthetic/kickoff-conversation.json" "$target/"
cp "$repo/examples/synthetic/fixtures/extraction.json" "$target/recorded.json"

step() { printf '\n\033[1m$ loom %s\033[0m\n' "$*"; loom "$@"; }
step init --project-id habit --name "Habit tracker" --provider fixture --fixture recorded.json --tasks beads
step ingest "$target/kickoff-conversation.json"
step extract
step extract                                   # rerun: skipped, no duplicates
step memory list
decision="$(loom memory list --kind decisions --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).data.decisions.find(x=>x.status==="confirmed");console.log(d.id)})')"
step memory show "$decision"
step context offline reminders --max-chars 1200
step assess --pack mobile-release
step questions --mode quick
for qa in "platforms both" "accounts no" "purchases no" "ads no" "children no" "personal-data yes" "remote-data no" "offline yes" "notifications yes"; do
  # shellcheck disable=SC2086
  loom answer $qa >/dev/null
done
step criteria list
step revision set build-41
step evidence add offline.core-flows --result passed --env emulator --description "Pixel emulator"
step evidence add offline.core-flows --result passed --env physical-device --description "Pixel 8, Android 16"
step waive store.assets --reason "Internal test build; listing assets not needed yet"
step report
step generate
step generate                                  # unchanged inputs: no new revisions
step questions --mode challenge
if command -v "${LOOM_BD_BIN:-bd}" >/dev/null 2>&1; then
  step tasks preview
else
  printf '\n(skipped: tasks preview needs Beads bd 1.3.x — see docs/adapters/beads.md)\n'
fi
printf '\nArtifacts: %s/loom-docs\n' "$target"
