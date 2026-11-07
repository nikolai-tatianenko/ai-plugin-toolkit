import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { addEvidence, setRevision } from "@ai-plugin-toolkit/acceptance";
import { archiveChecklist, checklistReport, getChecklist, instantiateChecklist, layeredContext, saveMemory, saveProfile, saveTemplate, USER_PROJECT, SharedMemoryClient, createMemoryServer, pullServerMemory, sharedSnapshot, safeEndpoint } from "../src/index.js";

let dir: string, store: LoomStore, user: LoomStore;
let server: Server | undefined;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-workspace-"));
  store = await LoomStore.open({ storageDir: path.join(dir, "shared") });
  user = await LoomStore.open({ storageDir: path.join(dir, "user") });
  store.ensureProject("alpha", "Alpha"); store.ensureProject("beta", "Beta"); user.ensureProject(USER_PROJECT, "User");
});
afterEach(async () => { if (server) { await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } store.close(); user.close(); await rm(dir, { recursive: true, force: true }); });
const template = { format: "loom-checklist/1", id: "delivery", version: "1.0.0", title: "Delivery", items: [{ id: "tests", title: "Tests", expected: "Regression tests pass", environments: ["ci"] }] };
const entry = (id: string, text: string) => ({ id, text, status: "confirmed", provenance: "User stated in setup" });

it("isolates project documents and rejects stale writes across independent connections", async () => {
  const d = saveMemory(store, "alpha", "shared", entry("database", "SQLite"), "user");
  expect(store.documents.list("beta", "memory.shared")).toEqual([]);
  const second = await LoomStore.open({ storageDir: store.storageDir });
  try {
    saveMemory(second, "alpha", "shared", entry("database", "Postgres"), "user", d.revision);
    expect(() => saveMemory(store, "alpha", "shared", entry("database", "MySQL"), "stale", d.revision)).toThrow(/changed/);
    expect(store.documents.get<any>("alpha", "memory.shared", "database")!.value.text).toBe("Postgres");
  } finally { second.close(); }
});

it("creates independent checklist snapshots, requires evidence and invalidates passes on new builds", async () => {
  saveTemplate(store, "alpha", template, "user");
  await instantiateChecklist(store, "alpha", "delivery", "release-a", "user");
  await instantiateChecklist(store, "alpha", "delivery", "release-b", "user");
  setRevision(store, "alpha", "build-1", "user");
  const pack = getChecklist(store, "alpha", "release-a").value.pack;
  expect(checklistReport(store, "alpha", "release-a").evaluation.readiness.status).toBe("not-ready");
  addEvidence(store, "alpha", pack, { criterion: "tests", environment: "ci", result: "passed", revision: "build-1", actor: "qa" });
  expect(checklistReport(store, "alpha", "release-a").evaluation.readiness.status).toBe("ready");
  expect(checklistReport(store, "alpha", "release-b").evaluation.readiness.status).toBe("not-ready");
  setRevision(store, "alpha", "build-2", "user");
  expect(checklistReport(store, "alpha", "release-a").evaluation.criteria[0]!.verification).toBe("stale");
  saveTemplate(store, "alpha", { ...template, version: "2.0.0", title: "New template" }, "user", 1);
  expect(getChecklist(store, "alpha", "release-a").value.pack.title).toBe("Delivery");
  archiveChecklist(store, "alpha", "release-a", "user", 1);
  expect(store.acceptance.activePacks("alpha").map(p => p.packId)).toEqual(["release-b"]);
});

it("rejects duplicate items and in-place meaning changes under the same template version", () => {
  expect(() => saveTemplate(store, "alpha", { ...template, items: [...template.items, ...template.items] }, "u")).toThrow();
  saveTemplate(store, "alpha", template, "u");
  expect(() => saveTemplate(store, "alpha", { ...template, title: "Changed" }, "u", 1)).toThrow(/new version/);
});

it("refuses instance names that could inherit another pack's evidence", async () => {
  await expect(instantiateChecklist(store, "alpha", "web-release", "web-release", "u")).rejects.toThrow(/new instance ID/);
});

it("assembles bounded private/shared/server context and excludes proposals and another project", () => {
  saveProfile(user, { id: "nick", name: "Nick", goals: ["Ship reliable tools"] }, "user");
  saveMemory(user, USER_PROJECT, "user", entry("language", "Private preference"), "user");
  saveMemory(store, "alpha", "shared", entry("stack", "TypeScript"), "user");
  saveMemory(store, "alpha", "shared", { ...entry("guess", "UNCONFIRMED"), status: "proposed" }, "agent");
  saveMemory(store, "beta", "shared", entry("other", "OTHER PROJECT"), "user");
  const text = layeredContext(user, store, "alpha").text;
  expect(text).toContain("Ship reliable tools"); expect(text).toContain("Private preference"); expect(text).toContain("TypeScript");
  expect(text).not.toContain("UNCONFIRMED"); expect(text).not.toContain("OTHER PROJECT");
  expect(layeredContext(user, store, "alpha", 100).text.length).toBe(100);
  expect(layeredContext(user, store, "alpha", 100).truncated).toBe(true);
});

it("supports authenticated optional server push/pull with conflict protection and no private memory export", async () => {
  const token = "test-token-with-at-least-24-characters";
  server = createMemoryServer({ store, project: "alpha", token });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const settings = { url, tokenEnv: "MEMORY_TOKEN", allowWrites: true, timeoutMs: 1000 };
  const client = new SharedMemoryClient(settings, token);
  saveMemory(user, USER_PROJECT, "user", entry("private", "NEVER UPLOAD"), "user");
  saveMemory(store, "alpha", "shared", entry("shared", "Shared note"), "user");
  const snapshot = sharedSnapshot(store, "alpha");
  expect(JSON.stringify(snapshot)).not.toContain("NEVER UPLOAD");
  const saved = await client.request("alpha", "PUT", snapshot, 0);
  expect(saved.revision).toBe(1);
  await expect(client.request("alpha", "PUT", snapshot, 0)).rejects.toThrow(/changed/);
  await expect(new SharedMemoryClient(settings, "wrong").request("alpha", "GET")).rejects.toThrow(/401/);
  await expect(client.request("beta", "GET")).rejects.toThrow(/404/);
  await expect(new SharedMemoryClient({ ...settings, allowWrites: false }, token).request("alpha", "PUT", snapshot, 1)).rejects.toThrow(/disabled/);
  await pullServerMemory(client, store, "alpha", "user");
  expect(layeredContext(user, store, "alpha").text).toContain("[server:shared@1]");
  const response = await fetch(`${url}/v1/projects/alpha/shared-memory`, { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
  expect(response.status).toBe(428);
});

it("rejects unsafe endpoints and assistant checkpoints in server snapshots", async () => {
  expect(() => safeEndpoint("http://example.com")).toThrow(/HTTPS/);
  expect(() => safeEndpoint("https://user:password@example.com")).toThrow(/credentials/);
  let calls = 0;
  const transport = (async () => { calls++; return new Response("{}"); }) as typeof fetch;
  const client = new SharedMemoryClient({ url: "https://example.com", tokenEnv: "KEY", allowWrites: true, timeoutMs: 1000 }, "token", transport);
  await expect(client.request("alpha", "PUT", { entries: [{ id: "bad", text: "proposal", kind: "checkpoint", status: "proposed", provenance: "agent", tags: [] }] }, 0)).rejects.toThrow();
  expect(calls).toBe(0);
});
