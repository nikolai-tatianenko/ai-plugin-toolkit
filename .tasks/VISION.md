# Vision: AI Plugin Toolkit / Context Loom

## Purpose

Turn conversations into traceable project memory, decisions, plans, tasks, and evidence-backed acceptance reviews. Keep using existing agents and task managers through replaceable adapters.

The system should answer: what do we know; what was decided; what changed; what remains unanswered; what should happen next; and what evidence supports delivery?

## Users and outcomes

- Individual builders: recover project context without repeating decisions.
- Agent developers: embed reusable routing, memory, and acceptance components.
- Engineering teams: reconcile requirements with implementation evidence.
- Contributors: extend topic packs and adapters without changing the core.

## Three layers

1. Routing: explicit model/provider policy, capabilities, privacy, budget, permitted fallback.
2. Context preparation: scoped retrieval, context budgets, stable structure, optional controlled-English normalization.
3. Persistent memory: original evidence, sourced facts, project summaries, confirmed preferences, corrections and deletion.

Artifact generation, topic packs, task synchronization, verification adapters, CLI, MCP, and a later inspector build on these layers.

## Differentiator

Remember what was agreed, ask what is missing, and show whether delivery meets acceptance criteria. A closed task is not proof of acceptance. A proposed choice is not a confirmed decision.

## Principles

- Local storage by default; external inference only according to explicit configuration.
- Original evidence is preserved except when deletion or retention policy requires removal.
- Derived summaries are inspectable, versioned, and source-linked; no promise of lossless summaries.
- Project facts do not silently become global preferences.
- Permissions are applied before retrieval, including cache reads.
- Plugins declare capabilities; unsupported functionality fails explicitly.
- Generated material never silently overwrites human edits.
- Cost and latency include background extraction and maintenance.
- Synthetic examples and reproducible evidence support public claims.

## Initial scope and exclusions

v0.1 is a CLI vertical slice with SQLite/files, one real model provider, basic routing, fact extraction, generated artifacts, a mobile acceptance pack, and one real task adapter. Both Beads and Task Master belong in the roadmap, after their exact projects and integration versions are verified.

Defer autonomous routing, semantic response caching, two-way task synchronization, multi-user hosting, and a dashboard. ASD-STE100-inspired normalization is an optional experiment; compliance is not claimed.

## Success

A new user can install, run a synthetic example, inspect source-linked facts, generate a plan, resolve questions, synchronize through a real adapter, and repeat safely. Evaluation measures evidence correctness, retrieval quality, duplicate prevention, total cost, latency, and failure behavior.

## Open-source and portfolio value

Show architecture decisions, real adapters, meaningful failure tests, reproducible evaluation, and an honest limitations document. Later add a React inspector to visualize sources, contradictions, revisions, and task changes. Publish a short demo and explain engineering ownership and AI-assisted development practices. Naming, license choice, dependency audit, and public release remain explicit release tasks.
