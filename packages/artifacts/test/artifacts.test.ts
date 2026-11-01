import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activatePack, answerQuestion, loadBuiltinPack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { parseConfig } from "@ai-plugin-toolkit/core";
import { extractSource } from "@ai-plugin-toolkit/memory";
import { Router, createFixtureProvider, type FixtureFile } from "@ai-plugin-toolkit/router";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { generateArtifacts, splitManaged } from "../src/index.js";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/synthetic");
let dir: string;
let out: string;
let store: LoomStore;
let pack: TopicPack;

const generate = (extra: { force?: boolean } = {}) =>
  generateArtifacts({ store, projectId: "habit", projectName: "Habit", outDir: out, packs: [pack], actor: "t", ...extra });
const byName = (outcomes: Awaited<ReturnType<typeof generate>>) => Object.fromEntries(outcomes.map((o) => [o.name, o]));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-artifacts-"));
  out = path.join(dir, "docs");
  store = await LoomStore.open({ storageDir: path.join(dir, ".loom") });
  store.ensureProject("habit", "Habit");
  const text = await readFile(path.join(examples, "kickoff-conversation.json"), "utf8");
  const [o] = await store.ingest("habit", [{ type: "conversation", text, mediaType: "application/json" }], { actor: "t" });
  const fixture = JSON.parse(await readFile(path.join(examples, "fixtures/extraction.json"), "utf8")) as FixtureFile;
  const router = new Router({
    config: parseConfig({ $schemaVersion: 1, project: { id: "habit", name: "Habit" }, providers: { f: { adapter: "f", location: "local" } }, routing: { extraction: { providers: ["f"] } } }),
    env: {},
    rootDir: dir,
    factories: { f: () => createFixtureProvider(fixture) },
  });
  await extractSource({ store, router, projectId: "habit", sourceId: o!.source.id, actor: "t" });
  pack = await loadBuiltinPack("mobile-release");
  activatePack(store, "habit", pack, "t");
  answerQuestion(store, "habit", pack, { question: "purchases", value: "no", actor: "pat" });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("artifact generation", () => {
  it("writes cited artifacts with revision headers and decision records with exact quotes", async () => {
    const outcomes = byName(await generate());
    expect(Object.values(outcomes).every((o) => o.status === "created" && o.revision === 1)).toBe(true);
    const vision = await readFile(path.join(out, "VISION.md"), "utf8");
    expect(vision).toMatch(/^<!-- loom:artifact name=VISION.md type=vision revision=1 /);
    expect(vision).toMatch(/\*\*storage:\*\* On-device SQLite — confirmed by user/);
    expect(vision).toMatch(/## Open proposals \(not decisions\)\n\n_None._/);
    expect(vision).toMatch(/## Proposals not chosen\n\n- \*\*storage:\*\* PostgreSQL with a hosted backend/);
    for (const line of vision.split("\n").filter((l) => l.startsWith("- ") && l.includes("fct_"))) {
      expect(line).toMatch(/`src_[0-9a-f]+:\d+-\d+`/);
    }
    const plan = await readFile(path.join(out, "PLAN.md"), "utf8");
    expect(plan).toMatch(/## Exclusions[\s\S]*purchases\.restore`: Not applicable: "purchases" was answered "no" by pat/);
    const decision = Object.keys(outcomes).find((n) => n.startsWith("decisions/") && n.includes("dec_"))!;
    const record = await readFile(path.join(out, decision), "utf8");
    expect(record).toMatch(/“(Decision: keep everything on device in SQLite\.|PostgreSQL is one option if you want a hosted backend\.)”/);
  });

  it("CL-006: regeneration with unchanged inputs is stable (no new revisions, identical bytes)", async () => {
    await generate();
    const before = await readFile(path.join(out, "PLAN.md"), "utf8");
    const second = await generate();
    expect(second.every((o) => o.status === "unchanged")).toBe(true);
    expect(await readFile(path.join(out, "PLAN.md"), "utf8")).toBe(before);
    expect(store.artifacts.latest("habit", "PLAN.md")!.revision).toBe(1);
  });

  it("keeps manual notes below the end marker when inputs change", async () => {
    await generate();
    const file = path.join(out, "STATUS.md");
    await writeFile(file, `${await readFile(file, "utf8")}\nOwner: Pat (manual note)\n`);
    answerQuestion(store, "habit", pack, { question: "accounts", value: "no", actor: "pat" });
    const outcome = byName(await generate())["STATUS.md"]!;
    expect(outcome).toMatchObject({ status: "updated", revision: 2 });
    const text = await readFile(file, "utf8");
    expect(text).toContain("Owner: Pat (manual note)");
    expect(text).toMatch(/revision=2 /);
  });

  it("A07: a manual edit inside the generated section is a conflict, never silently overwritten", async () => {
    await generate();
    const file = path.join(out, "PLAN.md");
    const edited = (await readFile(file, "utf8")).replace("## Work", "## Work (reordered by Pat)");
    await writeFile(file, edited);
    answerQuestion(store, "habit", pack, { question: "accounts", value: "yes", actor: "pat" });
    const outcome = byName(await generate())["PLAN.md"]!;
    expect(outcome.status).toBe("conflict");
    expect(outcome.reason).toMatch(/edited by hand/);
    expect(await readFile(file, "utf8")).toBe(edited);
    expect(store.artifacts.latest("habit", "PLAN.md")!.revision).toBe(1);

    const forced = byName(await generate({ force: true }))["PLAN.md"]!;
    expect(forced).toMatchObject({ status: "updated", revision: 2 });
    expect(await readFile(file, "utf8")).not.toContain("reordered by Pat");
  });

  it("refuses to overwrite a file it did not create", async () => {
    await generate();
    const file = path.join(out, "FACTS.md");
    await writeFile(file, "# My own facts file\n");
    expect(byName(await generate())["FACTS.md"]!.status).toBe("conflict");
    expect(await readFile(file, "utf8")).toBe("# My own facts file\n");
  });

  it("recreates a deleted file at the same revision when inputs are unchanged", async () => {
    await generate();
    await rm(path.join(out, "VISION.md"));
    expect(byName(await generate())["VISION.md"]).toMatchObject({ status: "restored", revision: 1 });
    expect(splitManaged(await readFile(path.join(out, "VISION.md"), "utf8"))).toBeDefined();
  });
});
