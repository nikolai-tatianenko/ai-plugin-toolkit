# ADR 0004: Deterministic policy routing with the official Anthropic SDK

Status: accepted for v0.1 (CL-003)
Date: 2026-11-01

## Context

Plan §4: each routing task (extraction, summary, planning, review) has a policy listing permitted providers, budget, timeout and fallback. Sensitive projects must never fall back to a disallowed remote provider. Only transient failures are retried, attempts are capped, and unknown pricing stays unknown.

## Decision

- **`packages/router`** walks the policy's providers in order. The first is primary; the rest are the only permitted fallbacks. Per provider: attempts up to `maxAttempts`, with exponential backoff only for transient categories (timeout, 429, 529, 5xx, network, truncated output, invalid output).
- **A19 is enforced twice**: config validation rejects remote providers for restricted projects, and the router refuses them at call time, including when an adapter's manifest reports `remote` while the config says `local`.
- **Timeouts are bounded by the router**, not the adapter: each attempt races a timer that also aborts the adapter's signal, so a misbehaving adapter can't hang a call.
- **Credentials** are referenced by environment variable name only and resolved by the router, which passes them to the adapter factory. A missing variable is a `CREDENTIALS_MISSING` error that names it.
- **Traces** record provider, model, attempt, outcome, failure category, latency, tokens and cost. They never include prompt or response text, and the CLI stores them in `routing_traces`.
- **The first real provider is Claude via `@anthropic-ai/sdk` 1.3.0** (model `claude-opus-5-5` by default). SDK retries are disabled (`maxRetries: 0`) so attempt counts stay visible and bounded. Structured output uses `output_config.format` with a JSON Schema, and zod remains the authoritative validator. `stop_reason: refusal` is a permanent failure, so the router moves to the next *permitted* provider.
- **Server-side model fallbacks are not enabled.** The API's own fallback would route to models the project policy does not list, which conflicts with the requirement that only policy-listed providers run.
- **Cost** is computed from a small, dated price table, including prompt-cache reads and 5-minute/1-hour cache writes. Models not in it report `costUsd: null`.
- **Prompt caching:** the Anthropic provider marks the system prompt (stable operator instructions) as the only cache breakpoint; messages carry per-request evidence and are never marked. `promptCaching: false` turns it off.
- **Fixture provider**: `adapter: "fixture"` replays recorded JSON responses locally for CI and the offline demo. It is labelled as such in outputs and never counts as model evidence.

## Consequences

- v0.1 started with one real provider. The current implementation also registers Ollama chat/embeddings for fully local projects, plus fixtures and a local hashing embedder. Live Claude/Ollama execution receipts remain required for release.
- Pricing must be kept current by hand until a pricing source is integrated.
