#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUITES, selectedTests, sourceDigest, validateEvidence } from "./release-evidence.mjs";

import { verifyCleanInstall } from "./clean-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const suite = args[0];
if (args.length !== 1 || !SUITES[suite]) {
  console.error(`Usage: pnpm verify:release -- <${Object.keys(SUITES).join("|")}>`);
  process.exit(2);
}
const evidenceDir = path.resolve(root, process.env.LOOM_RELEASE_EVIDENCE_DIR ?? ".release-evidence");
mkdirSync(evidenceDir, { recursive: true });
const receiptPath = path.join(evidenceDir, `${suite}.json`);
// A failed rerun must not leave a previous pass available to the gate.
rmSync(receiptPath, { force: true });
const temp = mkdtempSync(path.join(tmpdir(), "loom-verify-"));
const run = (command, commandArgs, options = {}) => execFileSync(command, commandArgs, {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  timeout: 900_000, ...options,
});

try {
  const digest = sourceDigest(root);
  let tests, details = {};
  if (suite === "macos") {
    if (process.platform !== "darwin") throw new Error("macos verification requires a real macOS host");
    ({ tests, details } = verifyCleanInstall({ root, temp, run }));
  } else {
    const env = { ...process.env, CI: "1", LOOM_LIVE_TESTS: "0" };
    if (suite === "anthropic" || suite === "ollama") {
      if (!process.env[suite === "anthropic" ? "LOOM_ANTHROPIC_MODEL" : "LOOM_OLLAMA_MODEL"]) throw new Error(`${suite}: explicit model environment variable is required`);
      if (suite === "anthropic" && !process.env.ANTHROPIC_API_KEY) throw new Error("anthropic: ANTHROPIC_API_KEY is required");
      if (suite === "ollama") {
        const url = new URL(process.env.LOOM_OLLAMA_URL ?? "http://127.0.0.1:11434");
        if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error("ollama: local validation requires a loopback endpoint");
      }
      env.LOOM_LIVE_TESTS = "1";
      env.LOOM_LIVE_RESULT_FILE = path.join(temp, "live-result.json");
    } else {
      const command = suite === "beads" ? process.env.LOOM_BD_BIN ?? "bd" : process.env.LOOM_TASKMASTER_BIN ?? "task-master";
      const output = run(command, [suite === "beads" ? "version" : "--version"]).trim();
      const version = output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
      const supported = suite === "beads" ? /^1\.3\./ : /^0\.43\./;
      if (!version || !supported.test(version)) throw new Error(`${suite}: supported upstream binary required`);
      details = { version };
    }
    const reportPath = path.join(temp, "vitest.json");
    run("pnpm", ["exec", "vitest", "run", ...SUITES[suite].files,
      "--testNamePattern", SUITES[suite].groups.join("|"), "--reporter=json", `--outputFile=${reportPath}`], { env });
    tests = selectedTests(JSON.parse(readFileSync(reportPath, "utf8")), suite);
    if (env.LOOM_LIVE_RESULT_FILE) details = JSON.parse(readFileSync(env.LOOM_LIVE_RESULT_FILE, "utf8"));
  }
  if (sourceDigest(root) !== digest) throw new Error("Source changed during verification; rerun on a stable snapshot");
  const receipt = { schemaVersion: 1, suite, sourceDigest: digest, completedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, node: process.version, tests, details };
  validateEvidence(receipt, suite, digest);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`VERIFIED ${suite}: ${tests.length} scenario(s). Evidence: ${path.relative(root, receiptPath)}`);
} catch (error) {
  // Subprocess output may contain credentials or raw model responses; retain only a safe error category.
  console.error(error.status !== undefined || error.code === "ETIMEDOUT"
    ? `NOT VERIFIED ${suite}: verification subprocess failed (${error.code ?? `exit ${error.status}`}); no passing evidence written`
    : `NOT VERIFIED ${suite}: ${error.message}`);
  process.exitCode = 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
