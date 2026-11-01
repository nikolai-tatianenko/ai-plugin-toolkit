import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "@ai-plugin-toolkit/core";
import { createAnthropicProvider, estimateCostUsd } from "../src/index.js";

/**
 * The adapter runs through the real SDK and real HTTP, against a local stub of the
 * Messages API. This verifies request shape and error mapping; it is NOT evidence that
 * the live API behaves the same — see the opt-in live test at the end.
 */
type Handler = (body: Record<string, any>, req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let baseURL: string;
let handler: Handler;
const requests: Array<{ body: Record<string, any>; headers: IncomingMessage["headers"] }> = [];

const reply = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "request-id": "req_test" });
  res.end(JSON.stringify(body));
};
const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: '{"items":[]}' }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 200 },
  ...overrides,
});
const apiError = (type: string) => ({ type: "error", error: { type, message: "stub" } });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, any>;
      requests.push({ body, headers: req.headers });
      handler(body, req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const provider = () => createAnthropicProvider({ apiKey: "sk-ant-test-key-0000000000", baseURL });
const signal = () => new AbortController().signal;

async function category(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return `${error.category}:${error.transient ? "transient" : "permanent"}`;
    throw error;
  }
  return "no error";
}

describe("Anthropic provider (SDK against a local stub)", () => {
  it("sends system, messages and the JSON schema; returns text, usage and cost", async () => {
    handler = (_body, _req, res) => reply(res, 200, message());
    requests.length = 0;
    const result = await provider().complete(
      {
        model: "claude-opus-5-5",
        system: "operator instructions",
        messages: [{ role: "user", content: "evidence" }],
        responseFormat: "json",
        jsonSchema: { type: "object" },
        maxOutputTokens: 4000,
      },
      { signal: signal() },
    );
    expect(result).toMatchObject({ text: '{"items":[]}', model: "claude-opus-5-5", stopReason: "end_turn" });
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 200, costUsd: (1000 * 4 + 200 * 20) / 1e6 });

    const sent = requests[0]!;
    // SDK 1.x sends the key as a bearer token with API version 2026-10-21.
    expect(sent.headers.authorization).toBe("Bearer sk-ant-test-key-0000000000");
    expect(sent.headers["anthropic-version"]).toBeDefined();
    expect(sent.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: "operator instructions",
      messages: [{ role: "user", content: "evidence" }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(sent.body.thinking).toBeUndefined();
  });

  it.each([
    [429, "rate_limit_error", "rate-limited:transient"],
    [529, "overloaded_error", "overloaded:transient"],
    [500, "api_error", "server-error:transient"],
    [401, "authentication_error", "auth:permanent"],
    [400, "invalid_request_error", "bad-request:permanent"],
  ])("maps HTTP %i to %s / %s", async (status, type, expected) => {
    handler = (_body, _req, res) => reply(res, status, apiError(type));
    expect(await category(provider().complete({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }] }, { signal: signal() }))).toBe(expected);
  });

  it("treats a refusal as permanent and max_tokens as truncated", async () => {
    handler = (_body, _req, res) => reply(res, 200, message({ stop_reason: "refusal", content: [] }));
    expect(await category(provider().complete({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }] }, { signal: signal() }))).toBe(
      "refusal:permanent",
    );
    handler = (_body, _req, res) => reply(res, 200, message({ stop_reason: "max_tokens" }));
    expect(await category(provider().complete({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }] }, { signal: signal() }))).toBe(
      "truncated:transient",
    );
  });

  it("maps an aborted request to cancelled", async () => {
    handler = () => {}; // never answers
    const controller = new AbortController();
    const pending = provider().complete({ model: "claude-opus-5-5", messages: [{ role: "user", content: "x" }] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await category(pending)).toBe("cancelled:permanent");
  });

  it("keeps unknown pricing unknown", () => {
    expect(estimateCostUsd("some-future-model", { input_tokens: 1, output_tokens: 1 } as never)).toBeNull();
    expect(estimateCostUsd("claude-opus-5-5", { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5 } as never)).toBeNull();
  });
});

const live = process.env.LOOM_LIVE_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
describe.skipIf(!live)("Anthropic provider (live API, opt-in: LOOM_LIVE_TESTS=1 and ANTHROPIC_API_KEY)", () => {
  it("completes a tiny JSON request", async () => {
    const p = createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const result = await p.complete(
      {
        model: "claude-opus-5-5",
        messages: [{ role: "user", content: 'Return {"ok": true}.' }],
        responseFormat: "json",
        jsonSchema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
        maxOutputTokens: 1000,
      },
      { signal: AbortSignal.timeout(60_000) },
    );
    expect(JSON.parse(result.text)).toEqual({ ok: true });
  }, 90_000);
});
