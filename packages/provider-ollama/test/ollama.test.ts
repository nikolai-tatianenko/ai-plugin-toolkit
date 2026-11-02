import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderError } from "@ai-plugin-toolkit/core";
import { createOllamaProvider, isLoopback } from "../src/index.js";

/** Local HTTP stub of the Ollama API: checks request shape and error mapping, not a real Ollama. */
let server: Server;
let baseUrl: string;
let handler: (path: string, body: Record<string, any>) => { status: number; body: unknown };
const seen: Array<{ path: string; body: Record<string, any> }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, any>;
      seen.push({ path: req.url ?? "", body });
      const out = handler(req.url ?? "", body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const signal = () => new AbortController().signal;

describe("Ollama provider (local HTTP stub)", () => {
  it("chats with a JSON schema and reports usage at zero cost", async () => {
    handler = () => ({ status: 200, body: { model: "llama3.1", message: { role: "assistant", content: '{"items":[]}' }, done_reason: "stop", prompt_eval_count: 12, eval_count: 3 } });
    const p = createOllamaProvider({ baseUrl, model: "llama3.1" });
    expect(p.manifest).toMatchObject({ location: "local", capabilities: ["complete", "json-output"] });
    const r = await p.complete!({ model: "", system: "sys", messages: [{ role: "user", content: "hi" }], responseFormat: "json", jsonSchema: { type: "object" }, maxOutputTokens: 50 }, { signal: signal() });
    expect(r).toMatchObject({ text: '{"items":[]}', usage: { inputTokens: 12, outputTokens: 3, costUsd: 0 } });
    expect(seen.at(-1)).toMatchObject({ path: "/api/chat", body: { model: "llama3.1", stream: false, format: { type: "object" }, options: { num_predict: 50 }, messages: [{ role: "system" }, { role: "user" }] } });
  });

  it("embeds a batch", async () => {
    handler = () => ({ status: 200, body: { embeddings: [[0.1, 0.2], [0.3, 0.4]], prompt_eval_count: 4 } });
    const p = createOllamaProvider({ baseUrl, embeddingModel: "nomic-embed-text" });
    const r = await p.embed!(["a", "b"], { signal: signal() });
    expect(r).toMatchObject({ vectors: [[0.1, 0.2], [0.3, 0.4]], model: "ollama:nomic-embed-text" });
    expect(seen.at(-1)).toMatchObject({ path: "/api/embed", body: { model: "nomic-embed-text", input: ["a", "b"] } });
  });

  it("maps failures to typed categories", async () => {
    const p = createOllamaProvider({ baseUrl, model: "missing" });
    handler = () => ({ status: 404, body: { error: "model 'missing' not found" } });
    await expect(p.complete!({ model: "", messages: [{ role: "user", content: "x" }] }, { signal: signal() })).rejects.toMatchObject({ category: "bad-request", transient: false });
    handler = () => ({ status: 500, body: { error: "boom" } });
    await expect(p.complete!({ model: "", messages: [{ role: "user", content: "x" }] }, { signal: signal() })).rejects.toMatchObject({ category: "server-error", transient: true });
    handler = () => ({ status: 200, body: { message: { content: "x" }, done_reason: "length" } });
    await expect(p.complete!({ model: "", messages: [{ role: "user", content: "x" }] }, { signal: signal() })).rejects.toBeInstanceOf(ProviderError);
    const down = createOllamaProvider({ baseUrl: "http://127.0.0.1:1", model: "m" });
    await expect(down.complete!({ model: "", messages: [{ role: "user", content: "x" }] }, { signal: signal() })).rejects.toMatchObject({ category: "network" });
  });

  it("A19: a non-loopback Ollama reports itself as remote", () => {
    expect(isLoopback("http://localhost:11434")).toBe(true);
    expect(isLoopback("http://[::1]:11434")).toBe(true);
    expect(isLoopback("http://127.0.0.2:11434")).toBe(true);
    expect(isLoopback("http://gpu-box.lan:11434")).toBe(false);
    expect(createOllamaProvider({ baseUrl: "http://10.0.0.5:11434", model: "m" }).manifest.location).toBe("remote");
  });
});

const live = process.env.LOOM_LIVE_TESTS === "1" && process.env.LOOM_OLLAMA_MODEL !== undefined;
describe.skipIf(!live)("Ollama provider (live, opt-in: LOOM_LIVE_TESTS=1 LOOM_OLLAMA_MODEL=<model>)", () => {
  it("completes JSON against a running local Ollama", async () => {
    const p = createOllamaProvider({ baseUrl: process.env.LOOM_OLLAMA_URL ?? "http://127.0.0.1:11434", model: process.env.LOOM_OLLAMA_MODEL! });
    const r = await p.complete!({ model: "", messages: [{ role: "user", content: 'Reply with {"ok": true}' }], responseFormat: "json", jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }, { signal: AbortSignal.timeout(120_000) });
    expect(JSON.parse(r.text)).toHaveProperty("ok");
  }, 150_000);
});
