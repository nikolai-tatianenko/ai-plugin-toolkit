import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SUITES, selectedTests, sourceDigest, validateEvidence } from "../../../scripts/release-evidence.mjs";

const work: string[] = [];
afterEach(() => { for (const dir of work.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const receipt = (suite: string, overrides = {}) => ({
  schemaVersion: 1, suite, sourceDigest: "snapshot", completedAt: new Date().toISOString(),
  platform: "linux", node: process.version,
  tests: [{ name: "Task Master adapter against real task-master creates tasks", status: "passed" }],
  details: { version: "0.43.1" }, ...overrides,
});

describe("release execution evidence", () => {
  it("requires Task Master execution independently of Beads", () => {
    expect(() => validateEvidence(receipt("beads"), "taskmaster", "snapshot")).toThrow();
    expect(validateEvidence(receipt("taskmaster"), "taskmaster", "snapshot")).toContain("1 passing");
  });
  it("requires both Beads scenarios, including CLI publication", () => {
    const r = receipt("beads", { tests: [{ name: "Beads adapter against real bd creates", status: "passed" }], details: { version: "1.3.2" } });
    expect(() => validateEvidence(r, "beads", "snapshot")).toThrow(/publishes through real Beads/);
  });
  it.each(["skipped", "pending", "failed"])("rejects a %s upstream scenario", (status) => {
    const r = receipt("taskmaster");
    r.tests[0]!.status = status;
    expect(() => validateEvidence(r, "taskmaster", "snapshot")).toThrow(/skipped/);
  });
  it("rejects stale evidence and missing runtime or upstream metadata", () => {
    expect(() => validateEvidence(receipt("taskmaster"), "taskmaster", "changed")).toThrow(/stale/);
    expect(() => validateEvidence(receipt("taskmaster", { details: {} }), "taskmaster", "snapshot")).toThrow(/version/);
    expect(() => validateEvidence(receipt("taskmaster", { completedAt: "invalid" }), "taskmaster", "snapshot")).toThrow(/metadata/);
  });
  it("does not treat fixture passes or an empty selection as real integration evidence", () => {
    const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0,
      testResults: [{ assertionResults: [{ fullName: "Task Master unit tests fake CLI", status: "passed" }] }] };
    expect(() => selectedTests(report, "taskmaster")).toThrow();
  });
  it("accepts passed selected tests while ignoring deliberately filtered unrelated tests", () => {
    const report = { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ assertionResults: [
      { fullName: "Task Master adapter against real task-master creates", status: "passed" },
      { fullName: "unrelated test", status: "pending" },
    ] }] };
    expect(selectedTests(report, "taskmaster")).toHaveLength(1);
    report.success = false;
    expect(() => selectedTests(report, "taskmaster")).toThrow(/successfully/);
  });
  it("requires real extraction metadata and refuses Linux evidence for macOS", () => {
    expect(() => validateEvidence(receipt("anthropic", { tests: [{ name: "live extraction: anthropic", status: "passed" }] }), "anthropic", "snapshot")).toThrow(/extraction/);
    const tests = SUITES.macos.groups.map((name) => ({ name, status: "passed" }));
    expect(() => validateEvidence(receipt("macos", { tests }), "macos", "snapshot")).toThrow(/macOS/);
    expect(validateEvidence(receipt("macos", { tests, platform: "darwin" }), "macos", "snapshot")).toContain("darwin");
  });
  it("binds evidence to source content, including new files, while ignoring receipts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-snapshot-")); work.push(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(path.join(dir, ".gitignore"), ".release-evidence/\n");
    writeFileSync(path.join(dir, "source.ts"), "before");
    execFileSync("git", ["add", "."], { cwd: dir });
    const original = sourceDigest(dir);
    mkdirSync(path.join(dir, ".release-evidence"));
    writeFileSync(path.join(dir, ".release-evidence/taskmaster.json"), "receipt");
    expect(sourceDigest(dir)).toBe(original);
    writeFileSync(path.join(dir, "source.ts"), "after");
    expect(sourceDigest(dir)).not.toBe(original);
    writeFileSync(path.join(dir, "source.ts"), "before");
    writeFileSync(path.join(dir, "new.ts"), "new implementation");
    expect(sourceDigest(dir)).not.toBe(original);
  });
  it("fails without credentials and removes an earlier passing receipt", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "loom-preflight-")); work.push(dir);
    const file = path.join(dir, "anthropic.json");
    writeFileSync(file, JSON.stringify(receipt("anthropic")));
    const env = { ...process.env, LOOM_RELEASE_EVIDENCE_DIR: dir, LOOM_ANTHROPIC_MODEL: "live-model" };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync(process.execPath, [new URL("../../../scripts/verify-release.mjs", import.meta.url).pathname, "anthropic"], { env, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ANTHROPIC_API_KEY is required");
    expect(existsSync(file)).toBe(false);
  });
});
