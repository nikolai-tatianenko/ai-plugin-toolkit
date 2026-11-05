# Controlled-English normalization (experiment, CL-016)

Status: **experimental, opt-in, off by default.** Nothing is normalized unless you run `loom normalize` or `loom context --normalize`.

## What it does

1. **Protects** code (fenced and inline), quotations, URLs, file paths, versions, numbers with units, and identifiers (`camelCase`, `snake_case`, `UPPER_CASE`). They become placeholders and are restored byte for byte.
2. **Rewrites** with a small, project-written list of plain-language substitutions (e.g. "in order to" → "to", "utilize" → "use", "prior to" → "before"; see `SUBSTITUTIONS` in `packages/normalize/src/index.ts`). With `--via-model`, a model rewrites the text instead, through `routing.normalization`.
3. **Checks meaning invariants**: negation, modal verbs, conditions and quantifiers, numbers, and protected regions must be identical before and after (equivalent phrasings such as "prior to"/"before" count as the same). **If any check fails, the original text is used** (`status: fallback`).
4. **Reports advisories** (long sentences, passive voice) without rewriting them, because restructuring a sentence can move the scope of a negation.
5. **Keeps provenance**: every result records transformer, version, content hash, changes and the invariant report. Results are cached per project by content hash, transformer and version. In `loom context --normalize`, only record statements are rewritten and the header says so; evidence is always quoted verbatim.

## What it is not

- **Not ASD-STE100.** The ASD Simplified Technical English specification was not obtained or reviewed for this project, and no rules or dictionary entries from it are used. Nothing here claims compliance with it or with any other controlled-language standard. Building a compliant normalizer would require licensing and reviewing the authoritative specification first.
- Not a guarantee of meaning preservation beyond the listed invariants. A rewrite can still change emphasis or nuance; the checks catch the specific features above.

## Baseline evaluation (A25)

`eval/datasets/normalization-v1/cases.json` holds 11 cases (negation, numbers, code, quotations, conditions, unchanged text). Each case lists spans that must survive verbatim. `packages/normalize/test/normalize.test.ts` runs the rules normalizer over them: all required spans are preserved and 7+ cases are simplified. A scripted model that drops a negation, a number or a placeholder falls back to the original. The cases were written by the implementing agent and still need human review. No live model run has been evaluated.
