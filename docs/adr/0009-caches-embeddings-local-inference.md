# ADR 0009: Revision-keyed caches, optional embeddings, local inference via Ollama

Status: accepted for v0.3 (CL-015)
Date: 2026-11-02

## Decision

- **A monotonic memory revision** is bumped by every write that changes what retrieval can return. Retrieval and context caches are valid only for the exact (memory revision, permissions revision, cache version). On any change, the project's caches are cleared before reuse (A24). The permissions revision hashes sensitivity, providers and routing.
- **Cache rows are keyed by project.** There is no global cache, so no cross-project hits.
- **Embeddings are optional** and routed through `routing.embedding` with the same policy rules and traces as completions. Their cost therefore appears in project totals under its own task ("full cost includes cache maintenance"). Vectors are keyed by record, model and content hash, so unchanged records are never re-embedded. Hybrid search fuses lexical and vector ranks within the project.
- **The hashing embedder** is a local, deterministic feature-hashing baseline, labelled as lexical rather than semantic.
- **Ollama** adds local chat and embeddings. Its manifest reports `remote` unless the base URL is loopback, so a misconfigured "local" provider on another host is still refused for restricted projects.
- Cache sizes are not written into STATUS.md, because they change on every read and would break artifact stability.

## Consequences

- Fully local operation (A27) is possible with Ollama plus the hashing or Ollama embedder, but has not been verified against a real Ollama with network access denied.
