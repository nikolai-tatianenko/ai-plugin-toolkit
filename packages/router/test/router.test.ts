import { describe, expect, it } from "vitest";
import {
  LoomError,
  ProviderError,
  defineProvider,
  parseConfig,
  type CompletionResult,
  type LoomConfig,
  type ProviderAdapter,
} from "@ai-plugin-toolkit/core";
import { Router, createFixtureProvider, type ProviderFactory, type RoutingTrace } from "../src/index.js";

const ok = (text: string, cost: number | null = 0.001): CompletionResult => ({
  text,
  model: "m",
  usage: { inputTokens: 10, outputTokens: 5, costUsd: cost },
});

function provider(location: "local" | "remote", impl: ProviderAdapter["complete"], capabilities: Array<"complete" | "json-output"> = ["complete", "json-output"]): ProviderAdapter {
  return defineProvider({ manifest: { kind: "provider", name: "scripted", version: "1.0.0", location, capabilities }, complete: impl });
}

/** Config objects are built directly (not via parseConfig) where a test needs values the schema forbids, e.g. tiny timeouts. */
function config(overrides: Partial<LoomConfig> & { policy?: Partial<LoomConfig["routing"]["extraction"]> } = {}): LoomConfig {
  const base = parseConfig({ $schemaVersion: 1, project: { id: "demo", name: "Demo" } });
  return {
    ...base,
    providers: overrides.providers ?? {
      a: { adapter: "a", location: "remote", model: "model-a" },
      b: { adapter: "b", location: "local", model: "model-b" },
    },
    project: overrides.project ?? base.project,
    routing: { extraction: { providers: ["a", "b"], timeoutMs: 200, maxAttempts: 2, ...overrides.policy } },
  };
}

function router(cfg: LoomConfig, factories: Record<string, ProviderFactory>, env: Record<string, string> = {}) {
  const traces: RoutingTrace[] = [];
  const r = new Router({ config: cfg, env, rootDir: "/nonexistent", factories, onTrace: (t) => traces.push(t), sleep: async () => {} });
  return { r, traces };
}

async function failure(promise: Promise<unknown>): Promise<LoomError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoomError) return error;
    throw error;
  }
  throw new Error("expected a failure");
}

const msg = { messages: [{ role: "user" as const, content: "SECRET PROMPT TEXT" }] };

describe("Router", () => {
  it("uses the primary provider and records a trace without prompt text", async () => {
    const { r, traces } = router(config(), { a: () => provider("remote", async () => ok("hello")), b: () => provider("local", async () => ok("unused")) });
    const result = await r.complete("extraction", msg);
    expect(result).toMatchObject({ value: "hello", provider: "a", attempts: 1 });
    expect(traces).toHaveLength(1);
    expect(JSON.stringify(traces)).not.toContain("SECRET PROMPT TEXT");
    expect(traces[0]).toMatchObject({ outcome: "ok", provider: "a", inputTokens: 10, costUsd: 0.001 });
  });

  it("retries transient failures a bounded number of times, then falls back", async () => {
    let calls = 0;
    const { r, traces } = router(config(), {
      a: () => provider("remote", async () => {
        calls++;
        throw new ProviderError("overloaded", "busy");
      }),
      b: () => provider("local", async () => ok("from b")),
    });
    const result = await r.complete("extraction", msg);
    expect(calls).toBe(2);
    expect(result.provider).toBe("b");
    expect(result.attempts).toBe(3);
    expect(traces.map((t) => [t.provider, t.outcome, t.category])).toEqual([
      ["a", "error", "overloaded"],
      ["a", "error", "overloaded"],
      ["b", "ok", undefined],
    ]);
  });

  it("does not retry non-transient failures on the same provider", async () => {
    let calls = 0;
    const { r } = router(config(), {
      a: () => provider("remote", async () => {
        calls++;
        throw new ProviderError("auth", "bad key");
      }),
      b: () => provider("local", async () => ok("b")),
    });
    await r.complete("extraction", msg);
    expect(calls).toBe(1);
  });

  it("CL-003: a timeout is bounded even when the adapter ignores its abort signal", async () => {
    const cfg = config({ policy: { providers: ["a"], timeoutMs: 50, maxAttempts: 2 } });
    const { r } = router(cfg, { a: () => provider("remote", () => new Promise(() => {})) });
    const started = Date.now();
    const error = await failure(r.complete("extraction", msg));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error.code).toBe("TIMEOUT");
    expect(error.details?.attempts).toBe(2);
  });

  it("does not leave an unhandled rejection when an adapter rejects after its attempt timed out", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const cfg = config({ policy: { providers: ["a"], timeoutMs: 20, maxAttempts: 1 } });
      const { r } = router(cfg, {
        a: () => provider("remote", (_req, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => setTimeout(() => reject(new ProviderError("cancelled", "late")), 10)))),
      });
      expect((await failure(r.complete("extraction", msg))).code).toBe("TIMEOUT");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("A19: a restricted project never calls a remote provider, even as a fallback", async () => {
    let remoteCalls = 0;
    const cfg = config({ project: { id: "demo", name: "Demo", sensitivity: "restricted" }, policy: { providers: ["a"] } });
    const { r, traces } = router(cfg, {
      a: () => provider("remote", async () => {
        remoteCalls++;
        return ok("leaked");
      }),
    });
    const error = await failure(r.complete("extraction", msg));
    expect(error.code).toBe("POLICY_VIOLATION");
    expect(remoteCalls).toBe(0);
    expect(traces[0]).toMatchObject({ outcome: "skipped", category: "policy" });
  });

  it("A19: a provider configured as local but reporting a remote adapter is refused", async () => {
    let calls = 0;
    const cfg = config({
      project: { id: "demo", name: "Demo", sensitivity: "restricted" },
      providers: { b: { adapter: "b", location: "local" } },
      policy: { providers: ["b"] },
    });
    const { r } = router(cfg, {
      b: () => provider("remote", async () => {
        calls++;
        return ok("x");
      }),
    });
    expect((await failure(r.complete("extraction", msg))).code).toBe("POLICY_VIOLATION");
    expect(calls).toBe(0);
  });

  it("CL-003: missing credentials produce a clear error naming the variable", async () => {
    const cfg = config({ providers: { a: { adapter: "a", location: "remote", apiKeyEnv: "LOOM_TEST_KEY" } }, policy: { providers: ["a"] } });
    const { r } = router(cfg, { a: () => provider("remote", async () => ok("x")) });
    const error = await failure(r.complete("extraction", msg));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("LOOM_TEST_KEY");
  });

  it("passes resolved credentials to the factory and never puts them in traces", async () => {
    const cfg = config({ providers: { a: { adapter: "a", location: "remote", apiKeyEnv: "LOOM_TEST_KEY" } }, policy: { providers: ["a"] } });
    let seen: string | undefined;
    const { r, traces } = router(cfg, { a: ({ apiKey }) => ((seen = apiKey), provider("remote", async () => ok("x"))) }, { LOOM_TEST_KEY: "sk-test-123456789012345678" });
    await r.complete("extraction", msg);
    expect(seen).toBe("sk-test-123456789012345678");
    expect(JSON.stringify(traces)).not.toContain("sk-test");
  });

  it("A18: invalid output is retried within the attempt limit and then fails without a value", async () => {
    let calls = 0;
    const cfg = config({ policy: { providers: ["a"], maxAttempts: 3 } });
    const { r } = router(cfg, { a: () => provider("remote", async () => (calls++, ok("not json"))) });
    const error = await failure(
      r.complete("extraction", { ...msg, responseFormat: "json" }, { validate: (res) => JSON.parse(res.text) as unknown }),
    );
    expect(calls).toBe(3);
    expect(error.code).toBe("PROVIDER_FAILED");
    expect(error.message).toContain("invalid-output");
  });

  it("A18: a valid retry after invalid output succeeds and counts all usage", async () => {
    let calls = 0;
    const { r } = router(config({ policy: { providers: ["a"] } }), {
      a: () => provider("remote", async () => (++calls === 1 ? ok("{bad") : ok('{"ok":true}'))),
    });
    const result = await r.complete("extraction", msg, { validate: (res) => JSON.parse(res.text) as { ok: boolean } });
    expect(result.value).toEqual({ ok: true });
    expect(result.usage.inputTokens).toBe(20);
  });

  it("stops when the cost budget is spent and keeps unknown cost as null", async () => {
    const { r } = router(config({ policy: { providers: ["a"], maxAttempts: 3, maxCostUsd: 0.0015 } }), {
      a: () => provider("remote", async () => ok("{bad", 0.001)),
    });
    const error = await failure(r.complete("extraction", msg, { validate: (res) => JSON.parse(res.text) as unknown }));
    expect(error.code).toBe("BUDGET_EXCEEDED");

    const unknown = router(config({ policy: { providers: ["a"] } }), { a: () => provider("remote", async () => ok("x", null)) });
    expect((await unknown.r.complete("extraction", msg)).usage.costUsd).toBeNull();
  });

  it("skips providers that lack a required capability", async () => {
    const { r, traces } = router(config(), {
      a: () => provider("remote", async () => ok("x"), ["complete"]),
      b: () => provider("local", async () => ok("from b")),
    });
    const result = await r.complete("extraction", { ...msg, responseFormat: "json" });
    expect(result.provider).toBe("b");
    expect(traces[0]).toMatchObject({ outcome: "skipped", category: "capability" });
  });

  it("honours caller cancellation without falling back", async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;
    const { r } = router(config(), {
      a: () => provider("remote", (_req, { signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new ProviderError("cancelled", "aborted")));
        controller.abort();
      })),
      b: () => provider("local", async () => (fallbackCalls++, ok("b"))),
    });
    expect((await failure(r.complete("extraction", msg, { signal: controller.signal }))).code).toBe("CANCELLED");
    expect(fallbackCalls).toBe(0);
  });

  it("reports a missing routing policy as a configuration error", async () => {
    const { r } = router(config(), {});
    expect((await failure(r.complete("planning", msg))).code).toBe("CONFIG_INVALID");
  });
});

describe("fixture provider", () => {
  it("replays the first entry whose match strings all occur, and reports itself as local", async () => {
    const p = createFixtureProvider({
      version: 1,
      responses: [
        { match: ["habit", "SQLite"], json: { items: [] } },
        { match: "anything", text: "plain" },
      ],
    });
    expect(p.manifest.location).toBe("local");
    const signal = new AbortController().signal;
    const res = await p.complete({ model: "", messages: [{ role: "user", content: "habit tracker on SQLite" }] }, { signal });
    expect(JSON.parse(res.text)).toEqual({ items: [] });
    await expect(p.complete({ model: "", messages: [{ role: "user", content: "nope" }] }, { signal })).rejects.toThrow(/no recorded response/);
  });
});
