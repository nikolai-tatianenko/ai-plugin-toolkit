# Implementation tickets

Status reflects recorded evidence; **implemented does not mean verified or release-ready**. `blocked` means the code exists but the ticket's acceptance criterion cannot be met yet. Dependency IDs establish execution order; milestones describe scope rather than guaranteed dates. Remaining work is summarized in [plan §14](../plans/CONTEXT-LOOM-IMPLEMENTATION-PLAN.md#14-remaining-work-as-of-2026-11-02). See the [full plan](../plans/CONTEXT-LOOM-IMPLEMENTATION-PLAN.md) and [test plan](../test-plan/CONTEXT-LOOM-ACCEPTANCE.md).

| ID | Work | Milestone | Depends on | Status |
| --- | --- | --- | --- | --- |
| [CL-001](CL-001.md) | Foundation and plugin contracts | v0.1 | none | implemented |
| [CL-002](CL-002.md) | SQLite persistence and evidence ingestion | v0.1 | 001 | implemented |
| [CL-003](CL-003.md) | Provider adapter and policy routing | v0.1 | 001 | implemented |
| [CL-004](CL-004.md) | Source-linked fact and decision extraction | v0.1 | 002, 003 | implemented |
| [CL-005](CL-005.md) | Scoped retrieval and context assembly | v0.1 | 004 | implemented |
| [CL-006](CL-006.md) | Versioned artifact generation | v0.1 | 004, 005 | implemented |
| [CL-007](CL-007.md) | Mobile topic pack and question engine | v0.1 | 004, 006 | implemented |
| [CL-008](CL-008.md) | Evidence-backed acceptance report | v0.1 | 007 | implemented |
| [CL-009](CL-009.md) | Beads and Task Master capability investigation | v0.1 | 001 | implemented |
| [CL-010](CL-010.md) | Task change sets and synchronization core | v0.1 | 006, 008, 009 | implemented |
| [CL-011](CL-011.md) | First real task adapter | v0.1 | 009, 010 | blocked (real Beads run pending) |
| [CL-012](CL-012.md) | CLI demo and release documentation | v0.1 | 005, 006, 008, 011 | blocked (on CL-011) |
| [CL-013](CL-013.md) | Corrections conflicts deletion and retention | v0.2 | 004, 005, 006 | implemented |
| [CL-014](CL-014.md) | Second real task adapter | v0.2 | 009, 010, 011 | blocked (real Task Master run pending) |
| [CL-015](CL-015.md) | Cache services and optional embeddings | v0.3 | 005, 013 | implemented |
| [CL-016](CL-016.md) | Controlled-English normalization experiment | v0.3 | 003, 005 | implemented |
| [CL-017](CL-017.md) | MCP interface | v0.3 | 008, 010, 013 | implemented |
| [CL-018](CL-018.md) | Additional topic packs and evidence importers | v0.3 | 007, 008 | implemented |
| [CL-019](CL-019.md) | Two-way sync and recovery hardening | v0.4 | 013, 014 | implemented |
| [CL-020](CL-020.md) | React memory and delivery inspector | v0.4 | 008, 013 | implemented |
| [CL-021](CL-021.md) | Reproducible evaluation and architecture records | v0.1 onward | 004, 005, 008 | in-progress |
| [CL-022](CL-022.md) | Open-source publication gate | release | 012, 021 | blocked (license decision, upstream runs, publication) |
