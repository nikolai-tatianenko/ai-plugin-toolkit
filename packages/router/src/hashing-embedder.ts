import { createHash } from "node:crypto";
import { ProviderError, defineProvider, type EmbeddingResult, type ProviderAdapter } from "@ai-plugin-toolkit/core";
import type { ProviderFactory } from "./router.js";

/**
 * Local feature-hashing embedder: lowercased word unigrams and bigrams hashed into a
 * fixed-size, L2-normalised vector. Deterministic, offline and free. It captures word
 * overlap, not meaning — it is a baseline and an offline stand-in, not a semantic model.
 */
export const HASHING_DIMENSIONS = 256;
export const HASHING_MODEL = `hashing-v1-${HASHING_DIMENSIONS}`;

export function hashingVector(text: string, dimensions = HASHING_DIMENSIONS): number[] {
  const words = (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1);
  const features = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  const vector = new Array<number>(dimensions).fill(0);
  for (const feature of features) {
    const digest = createHash("sha256").update(feature).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    vector[index]! += digest[4]! & 1 ? 1 : -1;
  }
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export function createHashingEmbedder(): ProviderAdapter {
  return defineProvider({
    manifest: { kind: "provider", name: "hashing", version: "1.0.0", location: "local", capabilities: ["embeddings"] },
    async embed(texts: readonly string[], { signal }: { signal: AbortSignal }): Promise<EmbeddingResult> {
      if (signal.aborted) throw new ProviderError("cancelled", "embedding aborted");
      return { vectors: texts.map((t) => hashingVector(t)), model: HASHING_MODEL, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
  });
}

export const hashingEmbedderFactory: ProviderFactory = () => createHashingEmbedder();
