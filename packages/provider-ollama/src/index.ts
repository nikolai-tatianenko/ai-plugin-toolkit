import {
  LoomError,
  ProviderError,
  defineProvider,
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingResult,
  type ProviderAdapter,
} from "@ai-plugin-toolkit/core";

/**
 * Ollama provider over its HTTP API (`POST /api/chat`, `POST /api/embed`). It is the
 * local-inference option: with a loopback base URL nothing leaves the machine, which is
 * what restricted projects and fully local operation (A27) need. Cost is reported as 0
 * (no per-token billing); hardware and energy cost are out of scope.
 */
export const OLLAMA_PROVIDER_VERSION = "0.1.0";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface OllamaProviderOptions {
  baseUrl?: string;
  /** Chat model, e.g. "llama3.1:8b". */
  model?: string;
  /** Embedding model, e.g. "nomic-embed-text". */
  embeddingModel?: string;
  fetch?: typeof fetch;
}

/** Loopback hosts only: anything else is reported as remote so restricted projects refuse it. */
export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

interface ChatResponse {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function call(fetchImpl: typeof fetch, url: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (cause) {
    if (signal.aborted) throw new ProviderError("cancelled", "Ollama request aborted", { cause });
    throw new ProviderError("network", `Ollama is not reachable at ${new URL(url).origin} (is \`ollama serve\` running?)`, { cause });
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => "")).slice(0, 300);
    const category = response.status === 404 ? "bad-request" : response.status >= 500 ? "server-error" : response.status === 429 ? "rate-limited" : "bad-request";
    throw new ProviderError(category, `Ollama returned ${response.status}${text ? `: ${text}` : ""}`, { details: { status: response.status } });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new ProviderError("invalid-output", "Ollama returned a non-JSON body", { cause });
  }
}

export function createOllamaProvider(options: OllamaProviderOptions = {}): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const capabilities: Array<"complete" | "json-output" | "embeddings"> = [];
  if (options.model !== undefined) capabilities.push("complete", "json-output");
  if (options.embeddingModel !== undefined) capabilities.push("embeddings");
  if (capabilities.length === 0) throw new LoomError("CONFIG_INVALID", "Ollama provider needs a chat model, an embedding model, or both.");

  return defineProvider({
    manifest: { kind: "provider", name: "ollama", version: OLLAMA_PROVIDER_VERSION, location: isLoopback(baseUrl) ? "local" : "remote", capabilities },
    ...(options.model === undefined
      ? {}
      : {
          async complete(request: CompletionRequest, { signal }: { signal: AbortSignal }): Promise<CompletionResult> {
            const messages = [
              ...(request.system ? [{ role: "system", content: request.system }] : []),
              ...request.messages.map((m) => ({ role: m.role, content: m.content })),
            ];
            const body = {
              model: request.model || options.model,
              messages,
              stream: false,
              ...(request.responseFormat === "json" ? { format: request.jsonSchema ?? "json" } : {}),
              ...(request.maxOutputTokens === undefined ? {} : { options: { num_predict: request.maxOutputTokens } }),
            };
            const data = (await call(fetchImpl, `${baseUrl}/api/chat`, body, signal)) as ChatResponse;
            if (typeof data.message?.content !== "string") throw new ProviderError("invalid-output", "Ollama response has no message content");
            if (data.done_reason === "length") throw new ProviderError("truncated", "Ollama output hit num_predict before finishing");
            return {
              text: data.message.content,
              model: data.model ?? String(body.model),
              stopReason: data.done_reason ?? "stop",
              usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0, costUsd: 0 },
            };
          },
        }),
    ...(options.embeddingModel === undefined
      ? {}
      : {
          async embed(texts: readonly string[], { signal, model }: { signal: AbortSignal; model?: string }): Promise<EmbeddingResult> {
            const used = model ?? options.embeddingModel!;
            const data = (await call(fetchImpl, `${baseUrl}/api/embed`, { model: used, input: texts }, signal)) as { embeddings?: unknown; prompt_eval_count?: number };
            if (!Array.isArray(data.embeddings) || !data.embeddings.every((v) => Array.isArray(v) && v.every((x) => typeof x === "number"))) {
              throw new ProviderError("invalid-output", "Ollama /api/embed returned no embeddings array");
            }
            return { vectors: data.embeddings as number[][], model: `ollama:${used}`, usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: 0, costUsd: 0 } };
          },
        }),
  });
}
