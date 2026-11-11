# Local verification runbook

The release gate (`pnpm release:check`) needs five execution receipts: real Beads, real Task Master, a live Claude extraction, a local Ollama extraction, and a clean macOS installation. A Mac can run all five. You can also download the macOS receipt from GitHub Actions for the same source snapshot and run the other suites on Linux.

Receipts are bound to a SHA-256 digest of the source. Do not edit tracked files between collecting receipts and running `pnpm release:check`. Any edit invalidates the receipts.

## Prerequisites

- macOS (for the `macos` receipt) or Linux, Node.js ≥ 22.13, Git, Corepack (`corepack enable`).
- `bd` 1.3.x (`npm install -g @beads/bd@1.3`) on `PATH`.
- `task-master` 0.43.x (`npm install -g task-master-ai@0.43`) on `PATH`.
- `ANTHROPIC_API_KEY` exported in the shell. Never write it to a file in the repository.
- Ollama running on `127.0.0.1:11434` with a chat model pulled (for example `ollama pull llama3.2`).

## Steps

```bash
git clone https://github.com/nikolai-tatianenko/ai-plugin-toolkit.git
```

```bash
cd ai-plugin-toolkit && git fetch origin && git checkout main && git pull --ff-only
```

```bash
corepack enable && pnpm install --frozen-lockfile && pnpm build && pnpm test
```

```bash
pnpm verify:release -- beads
```

```bash
pnpm verify:release -- taskmaster
```

```bash
LOOM_ANTHROPIC_MODEL='your-model-id' pnpm verify:release -- anthropic
```

```bash
LOOM_OLLAMA_MODEL=llama3.2 pnpm verify:release -- ollama
```

```bash
pnpm verify:release -- macos
```

```bash
pnpm release:check
```

The last command must print `READY`. If you want to test a branch that is not merged yet, check it out instead of `main` (`git checkout <branch> && git pull --ff-only`).

## Prompt for a local coding agent

Paste this into a coding agent that runs on your machine (Claude Code, or another agent with shell access). Replace `BRANCH` if you want something other than `main`.

```text
You are verifying the release candidate of the Git repository
https://github.com/nikolai-tatianenko/ai-plugin-toolkit (product working name "Context Loom", CLI "loom").

Goal: produce the five release execution receipts and get `pnpm release:check` to print READY,
on branch BRANCH=main (latest code). Do not publish anything.

1. Get the latest code:
   - If ./ai-plugin-toolkit does not exist: git clone https://github.com/nikolai-tatianenko/ai-plugin-toolkit.git
   - cd ai-plugin-toolkit && git fetch origin && git checkout "$BRANCH" && git pull --ff-only origin "$BRANCH"
   - Print `git log --oneline -1` and confirm `git status` is clean.
2. Check prerequisites and report what is missing before going further:
   node --version (need >= 22.13), corepack enable, pnpm --version,
   bd --version (need 1.3.x), task-master --version (need 0.43.x),
   whether ANTHROPIC_API_KEY is set (print only "set"/"not set", never the value),
   curl -s http://127.0.0.1:11434/api/tags (Ollama running; list installed models), uname -s.
   Ask me before installing global tools (npm install -g @beads/bd@1.3 task-master-ai@0.43) or pulling an Ollama model.
3. Build and test: pnpm install --frozen-lockfile && pnpm build && pnpm test. All tests must pass
   (skips are fine only for suites whose tools are missing; say which).
4. Collect receipts, one at a time, and report each result:
   pnpm verify:release -- beads
   pnpm verify:release -- taskmaster
   LOOM_ANTHROPIC_MODEL='your-model-id' pnpm verify:release -- anthropic
   LOOM_OLLAMA_MODEL=<an installed chat model> pnpm verify:release -- ollama
   pnpm verify:release -- macos   (only on macOS)
5. Run pnpm release:check (no --allow-pending) and show the full summary table.
6. If something fails:
   - Diagnose from the output (for live suites see docs/release.md, "To diagnose a failed live workflow").
   - If it is an environment problem, tell me exactly what to install or configure.
   - If it is a code bug, make the smallest fix on a new branch `fix/<short-name>` created from BRANCH,
     run pnpm build && pnpm test, commit, push the branch and open a pull request. Do not push to main.
     Note: any committed change invalidates receipts, so rerun steps 4–5 on the fix branch.
7. Rules: never print, log or commit API keys or other secrets; never commit .release-evidence/ or
   .loom/ state; never run npm publish, change repository visibility, create tags or merge pull requests.
8. Finish with a short report: commit SHA, each check (passed / failed + reason / not run + reason),
   the release:check verdict, and any pull request you opened.
```

## After READY

Tagging (`git tag v0.4.0`), making the repository public and `npm publish` are separate, explicit owner decisions. See [release.md](release.md#final-steps-manual-in-order).
