import Anthropic from "@anthropic-ai/sdk";
import {
  LoomError,
  ProviderError,
  defineProvider,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
  type ProviderFailureCategory,
} from "@ai-plugin-toolkit/core";

export const ANTHROPIC_PROVIDER_VERSION = "0.1.0";
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Published first-party prices in USD per million tokens (input, output, cache read),
 * as listed in the Claude API reference used for this release. A model missing here
 * reports cost `null` (unknown), never zero.
 */
export const PRICING_USD_PER_MTOK: Readonly<Record<string, readonly [input: number, output: number, cacheRead: number]>> = {
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-sonnet-5-5": [2, 10, 0.2],
  "claude-fable-5-1": [10, 50, 0.25],
};

/** Cache writes are billed as a multiple of the input price, by TTL. */
const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 } as const;

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Model used when the request does not override it. */
  model?: string;
  baseURL?: string;
  /** Test seam: a fetch implementation (e.g. pointed at a local stub server). */
  fetch?: typeof fetch;
  /**
   * Mark the system prompt as a prompt-cache breakpoint (default `true`). Repeated calls
   * with the same operator instructions, such as extraction over many sources, then
   * read it at the cache price instead of paying full input each time.
   */
  promptCaching?: boolean;
}

export function estimateCostUsd(model: string, usage: Anthropic.Usage): number | null {
  const price = PRICING_USD_PER_MTOK[model];
  if (price === undefined) return null;
  const [input, output, cacheRead] = price;
  const written = usage.cache_creation_input_tokens ?? 0;
  // Without a TTL breakdown, assume the default 5-minute TTL, which is all this provider writes.
  const written1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const writeCost = (written - written1h) * input * CACHE_WRITE_MULTIPLIER["5m"]
    + written1h * input * CACHE_WRITE_MULTIPLIER["1h"];
  return (usage.input_tokens * input + (usage.cache_read_input_tokens ?? 0) * cacheRead + writeCost + usage.output_tokens * output) / 1_000_000;
}

/** Map SDK errors to typed provider failures. Messages carry status and type only, never request content. */
export function classifyAnthropicError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const wrap = (category: ProviderFailureCategory, message: string, status?: number) =>
    new ProviderError(category, `Anthropic: ${message}`, { cause: error, ...(status === undefined ? {} : { details: { status } }) });

  if (error instanceof Anthropic.APIUserAbortError) return wrap("cancelled", "request aborted");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return wrap("timeout", "request timed out");
  if (error instanceof Anthropic.APIConnectionError) return wrap("network", "connection failed");
  if (error instanceof Anthropic.RateLimitError) return wrap("rate-limited", "rate limited (429)", 429);
  if (error instanceof Anthropic.AuthenticationError) return wrap("auth", "authentication failed (401); check the API key", 401);
  if (error instanceof Anthropic.PermissionDeniedError) return wrap("auth", "permission denied (403)", 403);
  if (error instanceof Anthropic.InternalServerError) {
    return error.status === 529
      ? wrap("overloaded", "API overloaded (529)", 529)
      : wrap("server-error", `server error (${error.status})`, error.status);
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 408 || status === 409) return wrap("server-error", `transient API error (${status})`, status);
    return wrap("bad-request", `request rejected (${status ?? "no status"}${error.type ? `, ${error.type}` : ""})`, status);
  }
  return wrap("unknown", error instanceof Error ? error.message : String(error));
}

/**
 * Claude via the official SDK. The router owns retries and timeouts, so the SDK's own
 * retries are disabled (`maxRetries: 0`) to keep attempt counts bounded and visible.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): ProviderAdapter {
  if (options.apiKey.trim() === "") {
    throw new LoomError("CREDENTIALS_MISSING", "Anthropic provider needs an API key.");
  }
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: 0,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const defaultModel = options.model ?? DEFAULT_ANTHROPIC_MODEL;
  const promptCaching = options.promptCaching ?? true;

  return defineProvider({
    manifest: {
      kind: "provider",
      name: "anthropic",
      version: ANTHROPIC_PROVIDER_VERSION,
      location: "remote",
      capabilities: ["complete", "json-output"],
    },
    async complete(request: CompletionRequest, { signal }: { signal: AbortSignal }): Promise<CompletionResult> {
      const model = request.model || defaultModel;
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        messages: request.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      };
      const system = [request.system, ...request.messages.filter((m) => m.role === "system").map((m) => m.content)]
        .filter((part): part is string => part !== undefined && part !== "")
        .join("\n\n");
      // Only the system prompt is a breakpoint: messages carry per-request evidence, so
      // caching them would pay the write premium on bytes that are never read back.
      if (system !== "") params.system = promptCaching ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system;
      if (request.responseFormat === "json" && request.jsonSchema !== undefined) {
        params.output_config = { format: { type: "json_schema", schema: request.jsonSchema } };
      }

      let response: Anthropic.Message;
      try {
        response = await client.messages.create(params, { signal });
      } catch (error) {
        throw classifyAnthropicError(error);
      }

      if (response.stop_reason === "refusal") {
        throw new ProviderError("refusal", "Anthropic: the model declined the request (stop_reason: refusal).");
      }
      if (response.stop_reason === "max_tokens") {
        throw new ProviderError("truncated", "Anthropic: output hit max_tokens before finishing.");
      }
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      return {
        text,
        model: response.model,
        stopReason: response.stop_reason ?? "unknown",
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          ...(response.usage.cache_read_input_tokens ? { cacheReadInputTokens: response.usage.cache_read_input_tokens } : {}),
          ...(response.usage.cache_creation_input_tokens ? { cacheWriteInputTokens: response.usage.cache_creation_input_tokens } : {}),
          costUsd: estimateCostUsd(model, response.usage),
        },
      };
    },
  });
}
