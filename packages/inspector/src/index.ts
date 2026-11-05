import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { evaluatePack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { LoomError, isLoomError, redactSecrets, type TaskAdapter } from "@ai-plugin-toolkit/core";
import { describeRecord, resolveSpans } from "@ai-plugin-toolkit/memory";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { previewSync } from "@ai-plugin-toolkit/task-sync";

/**
 * Local, read-only web inspector (CL-020). The server binds to loopback only, answers
 * GET requests only, requires a random per-run token for every API call, and rejects
 * requests whose Host header is not loopback (DNS-rebinding defence). The store passed
 * in should be opened read-only.
 */

export interface InspectorOptions {
  store: LoomStore;
  projectId: string;
  projectName: string;
  loadPacks: () => Promise<TopicPack[]>;
  taskAdapter?: () => TaskAdapter;
  host?: "127.0.0.1" | "::1" | "localhost";
  port?: number;
  /** Fixed token for tests; random by default. */
  token?: string;
}

export interface RunningInspector {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

const UI_DIR = fileURLToPath(new URL("../ui-dist/", import.meta.url));
const STATIC: Record<string, string> = { "/": "index.html", "/inspector.js": "inspector.js", "/styles.css": "styles.css" };
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export async function buildOverview(o: InspectorOptions) {
  const { store, projectId } = o;
  const packs = await o.loadPacks();
  const evaluations = packs.map((p) => evaluatePack(store, projectId, p));
  const facts = store.memory.listFacts(projectId, { includeInactive: true });
  const decisions = store.memory.listDecisions(projectId, { includeInactive: true });
  return {
    project: { id: projectId, name: o.projectName },
    memoryRevision: store.memory.revision(projectId),
    counts: {
      sources: store.countSources(projectId),
      facts: facts.filter((f) => f.status === "candidate" || f.status === "confirmed").length,
      decisions: decisions.filter((d) => d.status === "confirmed").length,
      proposals: decisions.filter((d) => d.status === "proposed").length,
      superseded: decisions.filter((d) => d.status === "superseded").length + facts.filter((f) => f.status === "superseded").length,
      reviewItems: store.memory.reviewItems(projectId).length,
      tasks: store.tasks.list(projectId).length,
    },
    readiness: evaluations.map((e) => ({ pack: e.pack, revision: e.revision ?? null, ...e.readiness })),
  };
}

async function api(o: InspectorOptions, pathname: string, params: URLSearchParams): Promise<unknown> {
  const { store, projectId } = o;
  const id = pathname.split("/")[3];
  if (pathname === "/api/overview") return buildOverview(o);
  if (pathname === "/api/memory") {
    return {
      facts: store.memory.listFacts(projectId, { includeInactive: true }),
      decisions: store.memory.listDecisions(projectId, { includeInactive: true }),
      review: store.memory.reviewItems(projectId, { all: true }),
    };
  }
  if (pathname.startsWith("/api/records/") && id) return describeRecord(store, projectId, id);
  if (pathname.startsWith("/api/sources/") && id) {
    const source = store.getSource(projectId, id);
    if (source === undefined) throw new LoomError("NOT_FOUND", `Source ${id} not found.`);
    const text = await store.readSourceText(projectId, id);
    const records = store.memory.recordsCiting(projectId, id);
    return { source: { id: source.id, type: source.type, title: source.title ?? null, mediaType: source.mediaType, ingestedAt: source.ingestedAt }, text, records };
  }
  if (pathname === "/api/acceptance") {
    const packs = await o.loadPacks();
    const evidence = store.acceptance.evidence(projectId);
    const tasks = store.tasks.list(projectId);
    return packs.map((p) => {
      const e = evaluatePack(store, projectId, p);
      return {
        pack: e.pack,
        revision: e.revision ?? null,
        readiness: e.readiness,
        criteria: e.criteria.map((c) => ({
          ...c,
          evidence: evidence.filter((x) => x.criterionId === c.id),
          tasks: tasks.filter((t) => t.criterionIds.includes(c.id)).map((t) => ({ id: t.id, title: t.title, status: t.status })),
        })),
        questions: e.questions.map((q) => ({ id: q.question.id, text: q.question.text, state: q.state, answer: q.answer ?? null })),
      };
    });
  }
  if (pathname === "/api/routing") return { summary: store.routing.summary(projectId), recent: store.routing.list(projectId, Number(params.get("limit") ?? 50)) };
  if (pathname === "/api/artifacts") return store.artifacts.listLatest(projectId);
  if (pathname === "/api/tasks") {
    const tasks = store.tasks.list(projectId, { includeRetired: true });
    let preview: unknown = null;
    let previewError: string | null = null;
    if (o.taskAdapter !== undefined && params.get("preview") === "1") {
      try {
        preview = await previewSync(store, projectId, o.taskAdapter(), (await o.loadPacks()).map((p) => evaluatePack(store, projectId, p)));
      } catch (error) {
        previewError = error instanceof Error ? error.message : String(error);
      }
    }
    return { tasks, runs: store.tasks.runs(projectId), preview, previewError, adapterConfigured: o.taskAdapter !== undefined };
  }
  if (pathname.startsWith("/api/spans/") && id) {
    const record = await describeRecord(store, projectId, id);
    return resolveSpans(store, projectId, record.record.spans);
  }
  throw new LoomError("NOT_FOUND", `Unknown endpoint ${pathname}`);
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { "content-type": type, ...SECURITY_HEADERS });
  res.end(body);
}

export async function startInspector(options: InspectorOptions): Promise<RunningInspector> {
  const host = options.host ?? "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const allowedHosts = new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") return send(res, 405, "Method not allowed", "text/plain");
    if (!allowedHosts.has((req.headers.host ?? "").toLowerCase())) return send(res, 421, "Misdirected request", "text/plain");
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = STATIC[url.pathname];
    if (file !== undefined) {
      try {
        return send(res, 200, await readFile(UI_DIR + file), TYPES[file.split(".").pop()!]!);
      } catch {
        return send(res, 500, "Inspector UI is not built. Run `pnpm build`.", "text/plain");
      }
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, "Not found", "text/plain");
    const presented = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (presented.length !== tokenBytes.length || !timingSafeEqual(presented, tokenBytes)) {
      return send(res, 401, JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Missing or wrong inspector token." } }), "application/json");
    }
    try {
      const data = await api(options, url.pathname, url.searchParams);
      return send(res, 200, JSON.stringify(redactSecrets({ ok: true, data })), "application/json");
    } catch (error) {
      const status = isLoomError(error) && error.code === "NOT_FOUND" ? 404 : 500;
      return send(res, status, JSON.stringify({ ok: false, error: { code: isLoomError(error) ? error.code : "INTERNAL", message: (error as Error).message } }), "application/json");
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => send(res, 500, "Internal error", "text/plain"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  for (const h of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(`${h}:${port}`);
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    url: `http://${displayHost}:${port}/?token=${token}`,
    token,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
