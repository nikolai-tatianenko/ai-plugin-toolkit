import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { LoomError, parseWith, type LoomConfig } from "@ai-plugin-toolkit/core";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { MemoryEntrySchema, type MemoryEntry } from "./memory.js";

const SnapshotSchema = z.strictObject({ entries: z.array(MemoryEntrySchema).max(1000) }).superRefine((v, ctx) => {
  if (v.entries.some(e => e.status !== "confirmed" || e.kind === "checkpoint")) ctx.addIssue({ code: "custom", message: "Server snapshots contain confirmed shared memories only" });
  if (new Set(v.entries.map(e => e.id)).size !== v.entries.length) ctx.addIssue({ code: "custom", message: "Duplicate memory IDs" });
});
export type SharedSnapshot = z.infer<typeof SnapshotSchema>;
type ServerSettings = NonNullable<NonNullable<LoomConfig["memory"]>["server"]>;

export function safeEndpoint(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new LoomError("CONFIG_INVALID", "Endpoints must not contain credentials, queries or fragments.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new LoomError("POLICY_VIOLATION", "Remote endpoints require HTTPS (HTTP is allowed only on loopback).");
  return url;
}

/** Optional transport; construction and local reads never contact a server. */
export class SharedMemoryClient {
  constructor(private readonly config: ServerSettings, private readonly token: string, private readonly transport: typeof fetch = fetch) {
    safeEndpoint(config.url);
    if (!token) throw new LoomError("CREDENTIALS_MISSING", `Set ${config.tokenEnv} before connecting to the memory server.`);
  }
  async request(project: string, method: "GET" | "PUT", snapshot?: SharedSnapshot, revision?: number) {
    if (method === "PUT" && !this.config.allowWrites) throw new LoomError("POLICY_VIOLATION", "Memory server writes are disabled.");
    const url = `${this.config.url.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(project)}/shared-memory`;
    const response = await this.transport(url, {
      method, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...(revision === undefined ? {} : { "If-Match": `"${revision}"` }) },
      ...(snapshot === undefined ? {} : { body: JSON.stringify(parseWith(SnapshotSchema, snapshot, "shared snapshot")) }),
    });
    if (response.status === 409) throw new LoomError("CONFLICT", "Server memory changed. Pull and review before retrying.");
    if (!response.ok) throw new LoomError("EXTERNAL_TOOL_FAILED", `Memory server returned HTTP ${response.status}.`);
    const raw: unknown = await readBoundedJson(response);
    const value = parseWith(z.strictObject({ revision: z.int().min(0), entries: SnapshotSchema.shape.entries }), raw, "server memory");
    parseWith(SnapshotSchema, { entries: value.entries }, "server memory");
    return value;
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new LoomError("INVALID_OUTPUT", "Empty memory response.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new LoomError("INVALID_OUTPUT", "Memory server response exceeds 1 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function sharedSnapshot(store: LoomStore, project: string): SharedSnapshot {
  return { entries: store.documents.list<MemoryEntry>(project, "memory.shared").map(d => d.value).filter(e => e.status === "confirmed" && e.kind !== "checkpoint") };
}

export async function pullServerMemory(client: SharedMemoryClient, store: LoomStore, project: string, actor: string) {
  const remote = await client.request(project, "GET");
  return store.transaction(() => {
    const old = store.documents.get(project, "memory.server", "snapshot");
    const saved = store.documents.put(project, "memory.server", "snapshot", remote, actor, old?.revision ?? 0);
    store.audit(project, "memory.server.pull", actor, ["snapshot"]);
    return saved;
  });
}

/** Small optional single-project service. Bind to loopback; use a TLS proxy for remote hosting. */
export function createMemoryServer(options: { store: LoomStore; project: string; token: string }): Server {
  if (options.token.length < 24) throw new LoomError("CONFIG_INVALID", "Memory server token must contain at least 24 characters.");
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
    const provided = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.token}`);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) { send(401, { error: "unauthorized" }); return; }
    if (req.url !== `/v1/projects/${encodeURIComponent(options.project)}/shared-memory`) { send(404, { error: "not-found" }); return; }
    const current = () => options.store.documents.get<SharedSnapshot>(options.project, "server.snapshot", "shared");
    try {
      if (req.method === "GET") { const d = current(); send(200, { revision: d?.revision ?? 0, entries: d?.value.entries ?? [] }); return; }
      if (req.method !== "PUT") { send(405, { error: "method-not-allowed" }); return; }
      const match = req.headers["if-match"]?.toString().match(/^"(\d+)"$/);
      if (!match) { send(428, { error: "if-match-required" }); return; }
      let body = "";
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > 1024 * 1024) { send(413, { error: "too-large" }); return; } }
      const snapshot = parseWith(SnapshotSchema, JSON.parse(body), "shared snapshot");
      const saved = options.store.documents.put(options.project, "server.snapshot", "shared", snapshot, "server-client", Number(match[1]));
      send(200, { revision: saved.revision, entries: saved.value.entries });
    } catch (error) {
      send(error instanceof LoomError && error.code === "CONFLICT" ? 409 : 400, { error: "request-rejected" });
    }
  });
}
