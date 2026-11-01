# ADR 0006: Separate applicability, verification and disposition

Status: accepted for v0.1 (CL-007, CL-008)
Date: 2026-11-01

## Decision

- **Topic packs are declarative JSON** (`loom-pack/1`): questions, criteria and conditions as data, validated by schema with cross-references checked. Packs can't run code. A pack must not list `mock` as an accepted evidence environment.
- **Applicability** comes from stated answers via three-valued conditions (`applicable`, `not-applicable`, `unresolved`). The not-applicable rationale cites the answers that decided it, with actor and date (A09).
- **Answers** are stored with a hash of the question's wording and options. An answer to a different wording is `stale` and is asked again (A08). Only `stated` answers resolve applicability. Memory matches are shown as unconfirmed suggestions, never as answers.
- **Verification** is computed from evidence only: the latest passed or failed result, in an accepted environment, at the current revision. Evidence for another revision makes the criterion `stale` (A12). Unaccepted environments, such as emulator evidence for a physical-device criterion, are listed as notes and don't count (A11). Task status is never read (A10).
- **Disposition** is separate: `accepted` (human approval) and `waived` (actor and reason required, shown as waived, never as passed) (A13).
- **Readiness**: `not-ready` while any applicable blocker or major criterion is unresolved, not passed, or not waived; `ready-with-waivers` when waivers were needed. Minor gaps are listed but don't block.

## Consequences

- The mobile pack is an engineering checklist. Its platform and legal items are marked advisory until reviewed against authoritative sources.
- Custom pack files and additional packs are CL-018.
