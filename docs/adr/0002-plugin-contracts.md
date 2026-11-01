# ADR 0002: Plugin contracts and capability declarations

Status: accepted for v0.1 foundation (CL-001)
Date: 2026-10-31

## Context

Providers and task systems (Beads, Task Master, later others) differ in what they support. The plan requires unsupported operations to fail explicitly and forbids inventing upstream capabilities.

## Decision

- Core defines `ProviderAdapter` and `TaskAdapter` interfaces and zod-validated manifests. Implementations live in their own packages and depend on core.
- A manifest declares capabilities. `defineProvider` / `defineTaskAdapter` reject a manifest that declares a capability with no implementation.
- Callers obtain operations through `requireTaskCapability` / `requireProviderCapability`, which throw `UnsupportedCapabilityError` for anything undeclared — even if a method happens to exist. Optional chaining on adapter methods is not used, so a missing operation can never look like a successful no-op.
- Task adapter manifests record the exact upstream tool and tested version range, filled in by CL-009.
- `Usage.costUsd` is `number | null`; unknown pricing is `null`, never `0`.
- Credentials are referenced by environment variable name (`apiKeyEnv`); the strict config schema rejects literal keys.

## Consequences

- In-process plugins remain trusted code. Capability checks prevent accidental misuse; they are not a sandbox.
- The task-adapter method set (`readTasks`, `createTask`, `updateTask`, `linkDependency`, `readChanges`) is provisional until CL-009 confirms what Beads and Task Master actually expose.
