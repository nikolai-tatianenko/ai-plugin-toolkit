import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activatePack, addEvidence, answerQuestion, loadBuiltinPack, setRevision, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { parseConfig } from "@ai-plugin-toolkit/core";
import { extractSource } from "@ai-plugin-toolkit/memory";
import { Router, createFixtureProvider, type FixtureFile } from "@ai-plugin-toolkit/router";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { startInspector, type RunningInspector } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, "../../../examples/synthetic");
const require = createRequire(import.meta.url);
type Playwright = typeof import("playwright");
let playwright: Playwright | undefined;
try {
  playwright = require("playwright") as Playwright;
} catch {
  playwright = undefined;
}
const axeSource = (require("axe-core") as { source: string }).source;

let dir: string;
let inspector: RunningInspector;
let readStore: LoomStore;
let pack: TopicPack;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-inspector-"));
  const store = await LoomStore.open({ storageDir: dir });
  store.ensureProject("habit", "Habit tracker");
  const text = await readFile(path.join(examples, "kickoff-conversation.json"), "utf8");
  const [o] = await store.ingest("habit", [{ type: "conversation", text, mediaType: "application/json", title: "Kickoff" }], { actor: "t" });
  const fixture = JSON.parse(await readFile(path.join(examples, "fixtures/extraction.json"), "utf8")) as FixtureFile;
  const router = new Router({
    config: parseConfig({ $schemaVersion: 1, project: { id: "habit", name: "Habit" }, providers: { f: { adapter: "f", location: "local" } }, routing: { extraction: { providers: ["f"] } } }),
    env: {},
    rootDir: dir,
    factories: { f: () => createFixtureProvider(fixture) },
    onTrace: (t) => store.routing.insert("habit", t),
  });
  await extractSource({ store, router, projectId: "habit", sourceId: o!.source.id, actor: "t" });
  pack = await loadBuiltinPack("mobile-release");
  activatePack(store, "habit", pack, "t");
  answerQuestion(store, "habit", pack, { question: "offline", value: "yes", actor: "pat" });
  answerQuestion(store, "habit", pack, { question: "purchases", value: "no", actor: "pat" });
  setRevision(store, "habit", "build-41", "t");
  addEvidence(store, "habit", pack, { criterion: "offline.core-flows", result: "passed", revision: "build-41", environment: "emulator", actor: "qa" });
  addEvidence(store, "habit", pack, { criterion: "offline.core-flows", result: "passed", revision: "build-41", environment: "physical-device", description: "Pixel 8", actor: "qa" });
  store.close();
  readStore = await LoomStore.open({ storageDir: dir, readOnly: true });
  inspector = await startInspector({ store: readStore, projectId: "habit", projectName: "Habit tracker", loadPacks: async () => [pack], token: "test-token-0123456789abcdef" });
});
afterAll(async () => {
  await inspector?.close();
  readStore?.close();
  await rm(dir, { recursive: true, force: true });
});

function raw(pathname: string, options: { method?: string; host?: string; auth?: string } = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: inspector.port, path: pathname, method: options.method ?? "GET", headers: { host: options.host ?? `127.0.0.1:${inspector.port}`, ...(options.auth ? { authorization: options.auth } : {}) } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("inspector server", () => {
  it("binds to loopback and requires the token, a loopback Host header and GET", async () => {
    expect(inspector.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    expect((await raw("/api/overview")).status).toBe(401);
    expect((await raw("/api/overview", { auth: "Bearer wrong-token-0123456789abcd" })).status).toBe(401);
    expect((await raw("/api/overview", { auth: "Bearer test-token-0123456789abcdef", host: "evil.example:80" })).status).toBe(421);
    expect((await raw("/api/overview", { method: "POST", auth: "Bearer test-token-0123456789abcdef" })).status).toBe(405);
    const okRes = await raw("/api/overview", { auth: "Bearer test-token-0123456789abcdef" });
    expect(okRes.status).toBe(200);
    expect(okRes.headers["content-security-policy"]).toMatch(/default-src 'self'/);
    expect(JSON.parse(okRes.body).data.counts).toMatchObject({ facts: 5, decisions: 1, proposals: 1 });
  });
});

describe.skipIf(playwright === undefined)("inspector UI in a real browser (Playwright Chromium)", () => {
  async function page(width = 1200, bypassCSP = false) {
    const browser = await playwright!.chromium.launch();
    // bypassCSP only for the axe scan: the inspector's CSP correctly blocks injected inline scripts.
    const context = await browser.newContext({ viewport: { width, height: 900 }, bypassCSP });
    const p = await context.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(inspector.url);
    await p.getByRole("heading", { level: 2, name: "Overview" }).waitFor();
    return { p, browser, errors };
  }
  type Locator = import("playwright").Locator;
  const textOf = async (l: Locator) => {
    await l.waitFor();
    return (await l.textContent())?.trim();
  };
  const focused = async (l: Locator) => {
    await l.waitFor();
    await l.page().waitForFunction((el) => document.activeElement === el, await l.elementHandle(), { timeout: 5_000 });
    return true;
  };

  async function axe(p: import("playwright").Page) {
    await p.addScriptTag({ content: axeSource });
    const result = (await p.evaluate(async () => (window as unknown as { axe: { run: (n: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: unknown[] }> }> } }).axe.run(document, { resultTypes: ["violations"] }))) as { violations: Array<{ id: string; impact: string }> };
    return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
  }

  it("removes the token from the address bar after loading", async () => {
    const { p, browser, errors } = await page();
    expect(p.url()).not.toContain("token");
    expect(errors).toEqual([]);
    await browser.close();
  });

  it("traces a fact to the exact span in its source", async () => {
    const { p, browser } = await page();
    await p.getByRole("link", { name: "Memory" }).click();
    await p.getByRole("link", { name: "Trace fact to source: Reminders must work offline." }).click();
    await p.getByRole("heading", { level: 2, name: "Fact: Reminders must work offline." }).waitFor();
    expect(await textOf(p.getByLabel("Quoted source text (untrusted)"))).toBe("reminders must work offline");
    await p.getByRole("link", { name: "Open in source" }).click();
    expect(await textOf(p.getByLabel("Cited span"))).toBe("reminders must work offline");
    await browser.close();
  }, 60_000);

  it("traces a criterion to its evidence and shows which evidence counts", async () => {
    const { p, browser } = await page();
    await p.getByRole("link", { name: "Acceptance" }).click();
    await p.getByRole("link", { name: "Trace criterion to evidence: Core flows work offline on a physical device" }).click();
    await p.getByRole("heading", { level: 2, name: "Criterion: Core flows work offline on a physical device" }).waitFor();
    const rows = p.getByRole("table", { name: "Evidence for offline.core-flows" }).getByRole("row");
    await rows.nth(2).waitFor();
    expect(await rows.count()).toBe(3);
    const cells = async (i: number) => (await rows.nth(i).getByRole("cell").allTextContents()).map((t) => t.trim());
    expect((await cells(1))[2]).toBe("emulator");
    expect((await cells(1))[5]).toBe("no");
    expect((await cells(2))[2]).toMatch(/^physical-device/);
    expect((await cells(2))[5]).toBe("yes");
    expect(await p.getByText(/emulator evidence does not satisfy/).isVisible()).toBe(true);
    await browser.close();
  }, 60_000);

  it("is operable by keyboard and moves focus to each view heading", async () => {
    const { p, browser } = await page();
    await p.keyboard.press("Tab");
    expect(await focused(p.getByRole("link", { name: "Skip to content" }))).toBe(true);
    await p.keyboard.press("Tab");
    await p.keyboard.press("Tab");
    expect(await focused(p.getByRole("link", { name: "Memory" }))).toBe(true);
    await p.keyboard.press("Enter");
    expect(await focused(p.getByRole("heading", { level: 2, name: "Memory" }))).toBe(true);
    await browser.close();
  }, 60_000);

  it("has no serious or critical axe violations on any view", async () => {
    const { p, browser } = await page(1200, true);
    const views = ["overview", "memory", "acceptance", "review", "tasks", "usage", "artifacts", "criterion/mobile-release/offline.core-flows"];
    const found: Record<string, string[]> = {};
    for (const v of views) {
      await p.evaluate((h) => (location.hash = h), v);
      await p.locator("#view-title").waitFor();
      await p.waitForLoadState("networkidle");
      const violations = await axe(p);
      if (violations.length > 0) found[v] = violations;
    }
    expect(found).toEqual({});
    await browser.close();
  }, 120_000);

  it("fits a phone-width viewport without horizontal page scrolling (visual check)", async () => {
    const { p, browser } = await page(375);
    for (const v of ["overview", "memory", "acceptance"]) {
      await p.evaluate((h) => (location.hash = h), v);
      await p.locator("#view-title").waitFor();
      await p.waitForLoadState("networkidle");
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const shot = await p.screenshot({ path: path.join(dir, `inspector-${v}-375.png`), fullPage: true });
      expect(shot.length).toBeGreaterThan(5_000);
    }
    await browser.close();
  }, 60_000);
});

