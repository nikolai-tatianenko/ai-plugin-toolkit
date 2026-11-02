import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import {
  BUILTIN_PACKS,
  activatePack,
  answerQuestion,
  evaluatePack,
  importEvidence,
  loadBuiltinPack,
  parseJUnit,
  parsePack,
  setRevision,
  waiveCriterion,
  type TopicPack,
} from "../src/index.js";

let dir: string;
let store: LoomStore;
let pack: TopicPack;
const P = "lib";
const criterion = (key: string, p = pack) => evaluatePack(store, P, p).criteria.find((c) => c.key === key)!;

const junit = (cases: string) => `<?xml version="1.0"?><testsuites><testsuite name="s">${cases}</testsuite></testsuites>`;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-import-"));
  store = await LoomStore.open({ storageDir: dir });
  store.ensureProject(P, "Lib");
  pack = await loadBuiltinPack("open-source-release");
  activatePack(store, P, pack, "t");
  setRevision(store, P, "v1.0.0", "t");
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("built-in packs", () => {
  it.each(BUILTIN_PACKS)("%s is valid and advisory", async (id) => {
    const p = await loadBuiltinPack(id);
    expect(p.advisory.length).toBeGreaterThan(20);
    expect(p.criteria.every((c) => !(c.verification.environments as string[]).includes("mock"))).toBe(true);
  });
});

describe("JUnit import", () => {
  it("passes a criterion only when every matched test passed", async () => {
    const all = importEvidence(store, P, pack, { format: "junit-xml/1", text: junit('<testcase classname="build" name="compiles"/><testcase classname="unit" name="adds"/>'), ref: "junit.xml", actor: "ci" });
    expect(all.items).toEqual([expect.objectContaining({ criterion: "build.clean-checkout", result: "passed" })]);
    expect(criterion("build.clean-checkout").verification).toBe("passed");
  });

  it("never turns failures, skips or no matches into a pass", () => {
    const text = junit('<testcase classname="a" name="ok"/><testcase classname="b" name="broken"><failure message="boom &amp; bust"/></testcase>');
    importEvidence(store, P, pack, { format: "junit-xml/1", text, ref: "f.xml", actor: "ci" });
    expect(criterion("build.clean-checkout").verification).toBe("failed");

    setRevision(store, P, "v1.0.1", "t");
    importEvidence(store, P, pack, { format: "junit-xml/1", text: junit('<testcase classname="a" name="ok"/><testcase classname="b" name="later"><skipped/></testcase>'), ref: "s.xml", actor: "ci" });
    const c = criterion("build.clean-checkout");
    expect(c.verification).not.toBe("passed");
    expect(c.notes.join(" ")).toMatch(/inconclusive/);
    expect(parseJUnit(text).results[1]).toMatchObject({ outcome: "failed", detail: "boom & bust" });
  });

  it("is idempotent for the same file and requires a revision", async () => {
    const text = junit('<testcase classname="build" name="x"/>');
    importEvidence(store, P, pack, { format: "junit-xml/1", text, ref: "j.xml", actor: "ci" });
    const again = importEvidence(store, P, pack, { format: "junit-xml/1", text, ref: "j.xml", actor: "ci" });
    expect(again.items[0]).toMatchObject({ skipped: "already imported" });
    expect(store.acceptance.evidence(P)).toHaveLength(1);

    const fresh = await LoomStore.open({ storageDir: path.join(dir, "other") });
    fresh.ensureProject(P, "Lib");
    expect(() => importEvidence(fresh, P, pack, { format: "junit-xml/1", text, ref: "j.xml", actor: "ci" })).toThrow(/needs a revision/);
    fresh.close();
  });

  it("rejects non-JUnit input and mock environments", () => {
    expect(() => parseJUnit("<html/>")).toThrow(/Not a JUnit/);
    expect(() => importEvidence(store, P, pack, { format: "junit-xml/1", text: junit('<testcase name="build"/>'), ref: "x", actor: "ci", environment: "mock" })).toThrow(/Mock/);
  });
});

describe("build report and review import", () => {
  it("maps checks by explicit criterion or pattern and rejects unknown criteria", () => {
    const report = { format: "loom-build/1", revision: "v1.0.0", checks: [{ name: "secret-scan", result: "passed" }, { name: "x", criterion: "license.dependencies", result: "failed" }] };
    const out = importEvidence(store, P, pack, { format: "loom-build/1", text: JSON.stringify(report), ref: "build.json", actor: "ci" });
    expect(out.items.map((i) => [i.criterion, i.result])).toEqual([
      ["license.dependencies", "failed"],
      ["security.no-secrets", "passed"],
    ]);
    const bad = { ...report, checks: [{ name: "y", criterion: "nope", result: "passed" }] };
    expect(() => importEvidence(store, P, pack, { format: "loom-build/1", text: JSON.stringify(bad), ref: "b", actor: "ci" })).toThrow(/unknown criterion/);
    expect(() => importEvidence(store, P, pack, { format: "loom-build/1", text: JSON.stringify(report), ref: "b", actor: "ci", revision: "v2" })).toThrow(/says revision v1.0.0/);
  });

  it("records a human review with the reviewer as actor, in the manual environment", () => {
    const md = "---\nformat: loom-review/1\nreviewer: Pat Lee\nrevision: v1.0.0\n---\n- passed security.policy: SECURITY.md reviewed\n- failed docs.limitations: missing\n";
    importEvidence(store, P, pack, { format: "loom-review/1", text: md, ref: "review.md", actor: "cli" });
    const evidence = store.acceptance.evidence(P);
    expect(evidence.map((e) => [e.recordedBy, e.environment.kind, e.importer])).toEqual([
      ["Pat Lee", "manual", "loom-review/1"],
      ["Pat Lee", "manual", "loom-review/1"],
    ]);
    expect(criterion("security.policy").verification).toBe("passed");
  });
});

describe("pack updates do not silently rewrite decisions", () => {
  it("a waiver made against an older criterion definition stops applying and asks to be re-confirmed", () => {
    answerQuestion(store, P, pack, { question: "publishes-package", value: "yes", actor: "pat" });
    waiveCriterion(store, P, pack, { criterion: "docs.limitations", actor: "lead", reason: "documented in README" });
    expect(criterion("docs.limitations").disposition).toBe("waived");

    const cosmetic = parsePack({ ...pack, version: "0.1.1", criteria: pack.criteria.map((c) => (c.id === "docs.limitations" ? { ...c, task: { ...c.task, title: "Renamed task" } } : c)) });
    expect(criterion("docs.limitations", cosmetic).disposition).toBe("waived");

    const changed = parsePack({ ...pack, version: "0.2.0", criteria: pack.criteria.map((c) => (c.id === "docs.limitations" ? { ...c, severity: "major" as const } : c)) });
    const c = criterion("docs.limitations", changed);
    expect(c.disposition).toBe("open");
    expect(c.notes.join(" ")).toMatch(/waived by lead was recorded against open-source-release@0.1.0/);
    expect(store.acceptance.dispositions(P)).toHaveLength(1);
  });
});
