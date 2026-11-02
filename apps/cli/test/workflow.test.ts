import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type CliIo } from "../src/run.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, "../dist/main.js");
const examples = path.resolve(here, "../../../examples/synthetic");

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "loom-workflow-"));
  await copyFile(path.join(examples, "kickoff-conversation.json"), path.join(workDir, "kickoff.json"));
  await copyFile(path.join(examples, "fixtures/extraction.json"), path.join(workDir, "recorded.json"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function loom(args: string[], env: Record<string, string> = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd: workDir, env: { LOOM_ACTOR: "pat", ...env }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) };
  const code = await run(args, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as { ok: boolean; data: Record<string, any>; error?: { code: string } } };
}

const ANSWERS: Array<[string, string]> = [
  ["platforms", "android"], ["accounts", "no"], ["purchases", "no"], ["ads", "no"], ["children", "no"],
  ["personal-data", "no"], ["remote-data", "no"], ["offline", "yes"], ["notifications", "yes"],
];

async function prepared() {
  expect((await loom(["init", "--project-id", "habit", "--name", "Habit", "--provider", "fixture", "--fixture", "recorded.json", "--tasks", "beads"])).code).toBe(EXIT.ok);
  expect((await loom(["ingest", "kickoff.json"])).code).toBe(EXIT.ok);
}

describe("workflow 1: init → ingest → extract → retrieve → generate", () => {
  it("produces cited memory, bounded context and stable artifacts", async () => {
    await prepared();
    const extract = (await loom(["extract", "--json"])).json();
    expect(extract.data.totals).toMatchObject({ extracted: 1, created: 7, rejected: 0 });
    expect((await loom(["extract", "--json"])).json().data.totals).toMatchObject({ extracted: 0, skipped: 1 });

    const memory = (await loom(["memory", "list", "--json"])).json().data;
    const decision = memory.decisions.find((d: { choice: string }) => d.choice === "On-device SQLite");
    expect(decision.status).toBe("confirmed");
    const shown = (await loom(["memory", "show", decision.id, "--json"])).json().data;
    expect(shown.evidence[0].text).toBe("Decision: keep everything on device in SQLite.");

    const hits = (await loom(["search", "storage", "--json"])).json().data.hits;
    expect(hits[0]).toMatchObject({ kind: "decision", status: "confirmed" });
    const context = (await loom(["context", "offline", "reminders", "--max-chars", "600", "--json"])).json().data;
    expect(context.usedChars).toBeLessThanOrEqual(600);

    const generated = (await loom(["generate", "--json"])).json().data;
    expect(generated.artifacts.every((a: { status: string }) => a.status === "created")).toBe(true);
    const again = (await loom(["generate", "--json"])).json().data;
    expect(again.artifacts.every((a: { status: string }) => a.status === "unchanged")).toBe(true);
    const facts = await readFile(path.join(workDir, "loom-docs/FACTS.md"), "utf8");
    expect(facts).toMatch(/Reminders must work offline\. _\(unreviewed\)_ — `fct_[0-9a-f]+` · `src_[0-9a-f]+:\d+-\d+`/);
  });

  it("A07 via CLI: a hand edit inside a generated section makes generate exit 1 and keeps the edit", async () => {
    await prepared();
    await loom(["extract"]);
    await loom(["generate", "vision"]);
    const file = path.join(workDir, "loom-docs/VISION.md");
    const edited = (await readFile(file, "utf8")).replace("## Requirements", "## Requirements (edited)");
    await writeFile(file, edited);
    await loom(["memory", "confirm", (await loom(["memory", "list", "--kind", "facts", "--json"])).json().data.facts[0].id]);
    const result = await loom(["generate", "vision"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stdout).toMatch(/! VISION\.md {2}conflict/);
    expect(await readFile(file, "utf8")).toBe(edited);
  });
});

describe("workflow 2: pack → questions → answers → evidence → readiness", () => {
  it("evaluates readiness from evidence only", async () => {
    await prepared();
    await loom(["extract"]);
    expect((await loom(["assess", "--pack", "mobile-release"])).code).toBe(EXIT.ok);
    const quick = (await loom(["questions", "--json"])).json().data.items;
    expect(quick.length).toBeGreaterThan(0);
    const purchases = quick.find((q: { id: string }) => q.id === "purchases");
    expect(purchases.suggestions[0].text).toContain("no purchases");

    for (const [q, v] of ANSWERS) expect((await loom(["answer", q, v])).code).toBe(EXIT.ok);
    expect((await loom(["questions", "--mode", "guided", "--json"])).json().data.items).toEqual([]);

    const criteria = (await loom(["criteria", "list", "--json"])).json().data.evaluation.criteria;
    const restore = criteria.find((c: { key: string }) => c.key === "purchases.restore");
    expect(restore.applicability).toBe("not-applicable");

    // Evidence needs a revision.
    const noRevision = await loom(["evidence", "add", "offline.core-flows", "--result", "passed", "--env", "physical-device", "--json"]);
    expect(noRevision.json().error?.code).toBe("VALIDATION_FAILED");
    await loom(["revision", "set", "build-7"]);
    await loom(["evidence", "add", "offline.core-flows", "--result", "passed", "--env", "emulator"]);
    const report1 = (await loom(["report", "--json"])).json().data.evaluations[0];
    expect(report1.criteria.find((c: { key: string }) => c.key === "offline.core-flows").verification).toBe("not-checked");

    // Record passing evidence for everything applicable in an acceptable environment.
    for (const c of report1.criteria.filter((x: { applicability: string }) => x.applicability === "applicable")) {
      await loom(["evidence", "add", c.key, "--result", "passed", "--env", c.acceptedEnvironments[0], "--description", "synthetic"]);
    }
    expect((await loom(["report", "--require-ready"])).code).toBe(EXIT.ok);
    await loom(["revision", "set", "build-8"]);
    const stale = await loom(["report", "--require-ready", "--json"]);
    expect(stale.code).toBe(EXIT.failure);
    expect(stale.json().data.ready).toBe(false);

    expect((await loom(["waive", "store.assets"])).code).toBe(EXIT.usage);
    expect((await loom(["waive", "store.assets", "--reason", "internal build only"])).code).toBe(EXIT.ok);
  });
});

describe("workflow 3: change set → preview → publish → rerun", () => {
  it("is blocked with explicit messages until policy and a supported bd are in place", async () => {
    await prepared();
    await loom(["assess", "--pack", "mobile-release"]);
    for (const [q, v] of ANSWERS) await loom(["answer", q, v]);
    const sync = await loom(["tasks", "sync", "--json"]);
    expect(sync.json().error).toMatchObject({ code: "POLICY_VIOLATION" });
    const preview = await loom(["tasks", "preview", "--json"], { PATH: "/nonexistent" });
    expect(preview.code).toBe(EXIT.failure);
    expect(preview.json().error).toMatchObject({ code: "EXTERNAL_TOOL_FAILED" });
  });

  const bd = (() => {
    try {
      return /\b1\.3\.\d+/.test(execFileSync(process.env.LOOM_BD_BIN ?? "bd", ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return false;
    }
  })();
  it.skipIf(!bd)(`publishes through real Beads and reruns without duplicates${bd ? "" : " — SKIPPED: no supported bd on PATH"}`, async () => {
    await prepared();
    const config = JSON.parse(await readFile(path.join(workDir, "loom.config.json"), "utf8"));
    config.tasks.allowWrites = true;
    if (process.env.LOOM_BD_BIN) config.tasks.beads.command = process.env.LOOM_BD_BIN;
    await writeFile(path.join(workDir, "loom.config.json"), JSON.stringify(config));
    await loom(["assess", "--pack", "mobile-release"]);
    for (const [q, v] of ANSWERS) await loom(["answer", q, v]);
    expect((await loom(["tasks", "init"])).code).toBe(EXIT.ok);
    const preview = (await loom(["tasks", "preview", "--json"])).json().data.preview;
    const first = (await loom(["tasks", "sync", "--json"])).json().data.sync;
    expect(first.status).toBe("ok");
    expect(first.applied.filter((c: { kind: string }) => c.kind === "create")).toHaveLength(preview.counts.create);
    const second = (await loom(["tasks", "sync", "--json"])).json().data.sync;
    expect(second.applied).toEqual([]);
  }, 300_000);
});

describe("workflow 4: correct a decision → supersede → regenerate", () => {
  it("A06: the corrected decision appears in regenerated summaries; history is kept", async () => {
    await prepared();
    await loom(["extract"]);
    await loom(["generate"]);
    const corrected = await loom(["correct", "storage", "SQLite", "with", "iCloud", "sync", "--reason", "users asked for backup", "--json"]);
    expect(corrected.code).toBe(EXIT.ok);
    const generated = (await loom(["generate", "--json"])).json().data.artifacts;
    expect(generated.find((a: { name: string }) => a.name === "VISION.md").status).toBe("updated");
    const vision = await readFile(path.join(workDir, "loom-docs/VISION.md"), "utf8");
    expect(vision).toMatch(/\*\*storage:\*\* SQLite with iCloud sync — confirmed by pat/);
    expect(vision).not.toMatch(/On-device SQLite — confirmed/);
    const history = (await loom(["memory", "list", "--kind", "decisions", "--all", "--json"])).json().data.decisions;
    expect(history.find((d: { choice: string }) => d.choice === "On-device SQLite").status).toBe("superseded");
  });
});

describe("workflow 5: forget scoped evidence", () => {
  it("A21: forgetting removes facts, search hits, decision records and generated text, and flags old exports", async () => {
    await prepared();
    await loom(["extract"]);
    await loom(["generate"]);
    expect((await loom(["export", "--out", "backup.json"])).code).toBe(EXIT.ok);
    const sourceId = (await loom(["sources", "list", "--json"])).json().data.sources[0].id;
    expect((await loom(["forget", sourceId])).code).toBe(EXIT.usage); // --yes required
    const forgot = (await loom(["forget", sourceId, "--yes", "--json"])).json().data;
    expect(forgot.results[0].deletedRecords).toHaveLength(7);
    expect(forgot.removedFiles).toHaveLength(2);
    expect(forgot.stillPresent).toEqual(["backup.json"]);
    expect((await loom(["memory", "list", "--all", "--json"])).json().data).toMatchObject({ facts: [], decisions: [] });
    expect((await loom(["search", "reminders", "offline", "--json"])).json().data.hits).toEqual([]);
    for (const name of ["FACTS.md", "VISION.md", "PLAN.md", "STATUS.md"]) {
      expect(await readFile(path.join(workDir, "loom-docs", name), "utf8")).not.toMatch(/Reminders must work offline|SQLite/);
    }
  });
});

describe("built binary", () => {
  it("runs the documented demo as a real process", async () => {
    const cli = (args: string[]) => execFileAsync(process.execPath, [binPath, ...args], { cwd: workDir, env: { ...process.env, LOOM_ACTOR: "ci" } });
    await cli(["init", "--project-id", "habit", "--provider", "fixture", "--fixture", "recorded.json"]);
    await cli(["ingest", "kickoff.json"]);
    const extract = await cli(["extract"]);
    expect(extract.stderr).toBe("");
    expect(extract.stdout).toMatch(/7 new/);
    await cli(["assess", "--pack", "mobile-release"]);
    await cli(["answer", "purchases", "no"]);
    await cli(["generate"]);
    const plan = await readFile(path.join(workDir, "loom-docs/PLAN.md"), "utf8");
    expect(plan).toMatch(/purchases\.restore`: Not applicable/);
  });
});

describe("caches and local embeddings (CL-015)", () => {
  it("caches search per memory revision and supports semantic search with the local hashing embedder", async () => {
    expect((await loom(["init", "--project-id", "habit", "--provider", "fixture", "--fixture", "recorded.json", "--embeddings", "hashing"])).code).toBe(EXIT.ok);
    await loom(["ingest", "kickoff.json"]);
    await loom(["extract"]);
    expect((await loom(["search", "offline", "--json"])).json().data.cache).toBe("miss");
    expect((await loom(["search", "offline", "--json"])).json().data.cache).toBe("hit");
    await loom(["memory", "confirm", (await loom(["memory", "list", "--kind", "facts", "--json"])).json().data.facts[0].id]);
    expect((await loom(["search", "offline", "--json"])).json().data.cache).toBe("miss");

    expect((await loom(["embed", "--json"])).json().data).toMatchObject({ embedded: 7, reused: 0 });
    expect((await loom(["embed", "--json"])).json().data).toMatchObject({ embedded: 0, reused: 7 });
    const hits = (await loom(["search", "reminders", "offline", "--semantic", "--json"])).json().data.hits;
    expect(hits[0].text).toBe("Reminders must work offline.");
    const stats = (await loom(["cache", "stats", "--json"])).json().data.stats;
    expect(stats.map((s: { namespace: string }) => s.namespace)).toContain("retrieval");
    await loom(["generate", "status"]);
    expect(await readFile(path.join(workDir, "loom-docs/STATUS.md"), "utf8")).toMatch(/- embedding: \d+ call\(s\).*cost \$0\.0000/);
  });
});

describe("custom packs and evidence import (CL-018)", () => {
  it("activates a pack file inside the project and imports JUnit results without false passes", async () => {
    await prepared();
    const pack = {
      format: "loom-pack/1", id: "team-checks", version: "1.0.0", title: "Team checks", description: "d", advisory: "Internal checklist.",
      topics: [{ id: "q", title: "Quality" }], questions: [],
      criteria: [{ id: "q.tests", topic: "q", title: "Unit tests pass", expected: "All unit tests pass", severity: "blocker",
        verification: { method: "CI", environments: ["ci"] }, task: { title: "Fix tests", description: "Make unit tests pass." }, evidence: { junit: ["^unit\\\\."], checks: [] } }],
    };
    await writeFile(path.join(workDir, "team-pack.json"), JSON.stringify(pack));
    expect((await loom(["assess", "--pack-file", "../outside.json"])).code).toBe(EXIT.failure);
    expect((await loom(["assess", "--pack-file", "team-pack.json"])).code).toBe(EXIT.ok);
    await writeFile(path.join(workDir, "junit.xml"), '<testsuites><testsuite><testcase classname="unit" name="a"/><testcase classname="unit" name="b"><skipped/></testcase></testsuite></testsuites>');
    const imported = (await loom(["evidence", "import", "junit.xml", "--revision", "r1", "--json"])).json().data;
    expect(imported.items[0]).toMatchObject({ criterion: "q.tests", result: "inconclusive" });
    await loom(["revision", "set", "r1"]);
    expect((await loom(["report", "--require-ready"])).code).toBe(EXIT.failure);
  });
});
