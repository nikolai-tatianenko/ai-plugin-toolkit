import {
  LoomError,
  ProviderError,
  isLoomError,
  type CompletionRequest,
  type CompletionResult,
  type ProviderCapability,
  type LoomConfig,
  type ProviderAdapter,
  type ProviderConfig,
  type RoutingPolicy,
  type RoutingTask,
} from "@ai-plugin-toolkit/core";

/** Builds a provider from its config entry. Credentials arrive resolved; adapters never read env themselves. */
export type ProviderFactory = (input: {
  name: string;
  config: ProviderConfig;
  apiKey: string | undefined;
  rootDir: string;
}) => ProviderAdapter;

export interface RoutingTrace {
  task: RoutingTask;
  provider: string;
  model: string | undefined;
  attempt: number;
  outcome: "ok" | "error" | "skipped";
  category?: string;
  /** Why this provider was used, skipped, or failed. Never contains prompt or response text. */
  reason: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  at: string;
}

export interface RouterOptions {
  config: LoomConfig;
  env: Readonly<Record<string, string | undefined>>;
  rootDir: string;
  factories: Readonly<Record<string, ProviderFactory>>;
  onTrace?: (trace: RoutingTrace) => void;
  /** Backoff between retries on the same provider. Injected so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RouteResult<T> {
  value: T;
  result: CompletionResult;
  provider: string;
  model: string;
  attempts: number;
  /** Totals across every attempt of this call, including failed ones. `null` cost means at least one attempt had unknown pricing. */
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  traces: RoutingTrace[];
}

export interface RouteOptions<T> {
  signal?: AbortSignal;
  /** Parse/validate output; throwing marks the attempt `invalid-output` (retried within `maxAttempts`). */
  validate?: (result: CompletionResult) => T;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic policy router (plan §4). For one routing task it walks the policy's
 * providers in order: the first is primary, the rest are the only permitted fallbacks.
 */
export class Router {
  private readonly options: RouterOptions;
  private readonly cache = new Map<string, ProviderAdapter>();

  constructor(options: RouterOptions) {
    this.options = options;
  }

  policy(task: RoutingTask): RoutingPolicy {
    const policy = this.options.config.routing[task];
    if (policy === undefined) {
      throw new LoomError(
        "CONFIG_INVALID",
        `No routing policy for "${task}". Add routing.${task} to loom.config.json (see docs/quickstart.md).`,
        { details: { task } },
      );
    }
    return policy;
  }

  async complete<T = string>(
    task: RoutingTask,
    request: Omit<CompletionRequest, "model">,
    routeOptions: RouteOptions<T> = {},
  ): Promise<RouteResult<T>> {
    const needs: ProviderCapability[] = request.responseFormat === "json" ? ["complete", "json-output"] : ["complete"];
    return this.route(task, needs, (adapter, model, policy, signal) => this.attempt(adapter, { ...request, model }, policy, signal), routeOptions);
  }

  /**
   * Embed texts through the task's policy (same restrictions, timeouts, retries and
   * traces as completions). Embedding is background maintenance, so its cost is traced
   * under its own routing task and counted in project totals.
   */
  async embed(task: RoutingTask, texts: readonly string[], routeOptions: { signal?: AbortSignal } = {}): Promise<RouteResult<number[][]>> {
    return this.route(
      task,
      ["embeddings"],
      async (adapter, model, policy, signal) => {
        const result = await this.bounded(policy, signal, (s) => adapter.embed!(texts, { signal: s, ...(model ? { model } : {}) }));
        if (result.vectors.length !== texts.length) throw new ProviderError("invalid-output", `expected ${texts.length} vectors, got ${result.vectors.length}`);
        return { text: "", model: result.model, usage: result.usage, vectors: result.vectors };
      },
      { ...routeOptions, validate: (r) => (r as CompletionResult & { vectors: number[][] }).vectors },
    );
  }

  private async route<T>(
    task: RoutingTask,
    needs: readonly ProviderCapability[],
    invoke: (adapter: ProviderAdapter, model: string, policy: RoutingPolicy, signal: AbortSignal | undefined) => Promise<CompletionResult>,
    routeOptions: RouteOptions<T>,
  ): Promise<RouteResult<T>> {
    const policy = this.policy(task);
    const { config } = this.options;
    const sleep = this.options.sleep ?? defaultSleep;
    const now = this.options.now ?? Date.now;
    const traces: RoutingTrace[] = [];
    const failures: Array<{ provider: string; category: string; message: string }> = [];
    const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0 as number | null };
    let attemptsMade = 0;

    const trace = (t: Omit<RoutingTrace, "task" | "at">) => {
      const full: RoutingTrace = { task, at: new Date(now()).toISOString(), ...t };
      traces.push(full);
      this.options.onTrace?.(full);
    };
    const addUsage = (usage: CompletionResult["usage"]) => {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.costUsd = totals.costUsd === null || usage.costUsd === null ? null : totals.costUsd + usage.costUsd;
    };

    for (const [index, name] of policy.providers.entries()) {
      const providerConfig = config.providers[name];
      const role = index === 0 ? "primary" : `fallback #${index}`;
      const model = providerConfig?.model;
      const skip = (category: string, reason: string) => {
        trace({ provider: name, model, attempt: 0, outcome: "skipped", category, reason: `${role}: ${reason}` });
        failures.push({ provider: name, category, message: reason });
      };

      if (providerConfig === undefined) {
        skip("config", `provider "${name}" is not configured`);
        continue;
      }
      // A19, enforced at call time as well as at config validation.
      if (config.project.sensitivity === "restricted" && providerConfig.location !== "local") {
        skip("policy", `restricted project may not use remote provider "${name}"`);
        continue;
      }
      const apiKey = providerConfig.apiKeyEnv === undefined ? undefined : this.options.env[providerConfig.apiKeyEnv];
      if (providerConfig.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === "")) {
        skip("credentials", `credentials missing: environment variable ${providerConfig.apiKeyEnv} is not set`);
        continue;
      }

      let adapter: ProviderAdapter;
      try {
        adapter = this.adapter(name, providerConfig, apiKey);
      } catch (error) {
        skip(isLoomError(error) && error.code === "CREDENTIALS_MISSING" ? "credentials" : "config", (error as Error).message);
        continue;
      }
      if (config.project.sensitivity === "restricted" && adapter.manifest.location !== "local") {
        skip("policy", `adapter "${adapter.manifest.name}" reports a remote location; restricted project refuses it`);
        continue;
      }
      const missing = needs.filter((c) => !adapter.manifest.capabilities.includes(c));
      if (missing.length > 0) {
        skip("capability", `adapter "${adapter.manifest.name}" does not declare ${missing.join(", ")}`);
        continue;
      }

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
        if (routeOptions.signal?.aborted) {
          throw new LoomError("CANCELLED", `Routing "${task}" was cancelled.`, { details: { task } });
        }
        if (policy.maxCostUsd !== undefined && totals.costUsd !== null && totals.costUsd >= policy.maxCostUsd) {
          throw new LoomError(
            "BUDGET_EXCEEDED",
            `Routing "${task}" stopped: spent $${totals.costUsd.toFixed(4)} of a $${policy.maxCostUsd} budget.`,
            { details: { task, spentUsd: totals.costUsd, budgetUsd: policy.maxCostUsd, traces } },
          );
        }
        attemptsMade++;
        const started = now();
        try {
          const result = await invoke(adapter, model ?? "", policy, routeOptions.signal);
          addUsage(result.usage);
          let value: T;
          try {
            value = routeOptions.validate === undefined ? (result.text as T) : routeOptions.validate(result);
          } catch (cause) {
            throw new ProviderError("invalid-output", `output failed validation: ${(cause as Error).message}`, { cause });
          }
          trace({
            provider: name,
            model: result.model,
            attempt,
            outcome: "ok",
            reason: `${role}: completed`,
            latencyMs: now() - started,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costUsd: result.usage.costUsd,
          });
          return { value, result, provider: name, model: result.model, attempts: attemptsMade, usage: totals, traces };
        } catch (raw) {
          if (routeOptions.signal?.aborted) {
            throw new LoomError("CANCELLED", `Routing "${task}" was cancelled.`, { details: { task }, cause: raw });
          }
          const error = raw instanceof ProviderError ? raw : new ProviderError("unknown", (raw as Error)?.message ?? String(raw), { cause: raw });
          trace({
            provider: name,
            model,
            attempt,
            outcome: "error",
            category: error.category,
            reason: `${role}: ${error.message}`,
            latencyMs: now() - started,
          });
          failures.push({ provider: name, category: error.category, message: error.message });
          if (!error.transient || attempt === policy.maxAttempts) break;
          await sleep(Math.min(250 * 2 ** (attempt - 1), 4_000));
        }
      }
    }

    const categories = new Set(failures.map((f) => f.category));
    const code =
      categories.size === 1 && categories.has("credentials")
        ? "CREDENTIALS_MISSING"
        : categories.size === 1 && categories.has("policy")
          ? "POLICY_VIOLATION"
          : [...categories].every((c) => c === "timeout")
            ? "TIMEOUT"
            : "PROVIDER_FAILED";
    throw new LoomError(
      code,
      `No permitted provider completed "${task}":\n${failures.map((f) => `  - ${f.provider} [${f.category}]: ${f.message}`).join("\n")}`,
      { details: { task, failures, attempts: attemptsMade, traces } },
    );
  }

  private adapter(name: string, config: ProviderConfig, apiKey: string | undefined): ProviderAdapter {
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;
    const factory = this.options.factories[config.adapter];
    if (factory === undefined) {
      throw new LoomError(
        "CONFIG_INVALID",
        `Provider "${name}" uses unknown adapter "${config.adapter}". Available: ${Object.keys(this.options.factories).join(", ")}.`,
      );
    }
    const adapter = factory({ name, config, apiKey, rootDir: this.options.rootDir });
    this.cache.set(name, adapter);
    return adapter;
  }

  /** One bounded completion attempt. */
  private attempt(adapter: ProviderAdapter, request: CompletionRequest, policy: RoutingPolicy, callerSignal: AbortSignal | undefined): Promise<CompletionResult> {
    const withBudget =
      policy.maxOutputTokens === undefined
        ? request
        : { ...request, maxOutputTokens: Math.min(request.maxOutputTokens ?? policy.maxOutputTokens, policy.maxOutputTokens) };
    return this.bounded(policy, callerSignal, (signal) => adapter.complete!(withBudget, { signal }));
  }

  /** Run one call with a hard timeout that fires even if the adapter ignores its abort signal. */
  private async bounded<R>(policy: RoutingPolicy, callerSignal: AbortSignal | undefined, call: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("timeout"));
        reject(new ProviderError("timeout", `attempt exceeded ${policy.timeoutMs} ms`));
      }, policy.timeoutMs);
    });
    try {
      const pending = call(controller.signal);
      // If the timeout wins, the adapter may still reject later (e.g. after abort); never leave that unhandled.
      pending.catch(() => {});
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
