#!/usr/bin/env node
// Local release gate (CL-022). Runs every check and prints a checklist. Exit code 0 only
// when nothing is failing. `--allow-pending license,upstream` downgrades the decisions
// that only a person can make to warnings (used in CI before the release decision).
// Publishing (repository visibility, package registry) is never done by this script.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./license-audit.mjs";
import { scan } from "./secret-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowArg = process.argv.find((a) => a.startsWith("--allow-pending"));
const allowPending = new Set((allowArg?.split("=")[1] ?? (allowArg ? process.argv[process.argv.indexOf(allowArg) + 1] : "") ?? "").split(",").filter(Boolean));
const results = [];
const check = (name, fn, { pendingKey } = {}) => {
  try {
    const detail = fn();
    results.push({ name, status: "pass", detail: detail ?? "" });
  } catch (error) {
    const status = pendingKey && allowPending.has(pendingKey) ? "pending" : "fail";
    results.push({ name, status, detail: error.message.split("\n")[0] });
  }
};
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

check("build", () => (run("pnpm", ["build"]), "pnpm build"));
check("tests", () => {
  const out = run("pnpm", ["test"], { env: { ...process.env, CI: "1" } });
  return (out.match(/Tests\s+[^\n]+/) ?? ["?"])[0].trim();
});
check("extraction evaluation (fixture)", () => (run("node", ["apps/eval/dist/main.js", "--json"]), "pnpm eval"));
check("dependency licenses", () => {
  const r = audit();
  if (r.problems.length > 0) throw new Error(`not on allowlist: ${r.problems.map((p) => `${p.name} (${p.license})`).join(", ")}`);
  return `${r.packages.length} production packages, all allowlisted`;
});
check("secret scan", () => {
  const r = scan();
  if (r.findings.length > 0) throw new Error(`${r.findings.length} possible secret(s): ${r.findings.map((f) => f.file).join(", ")}`);
  return `${r.files} tracked files clean`;
});
check("no local state or env files tracked", () => {
  const tracked = run("git", ["ls-files"]).split("\n");
  const bad = tracked.filter((f) => /(^|\/)\.loom\/|(^|\/)\.env(\.|$)|\.db$/.test(f));
  if (bad.length > 0) throw new Error(bad.join(", "));
  return "none";
});
check("license chosen", () => {
  if (!existsSync(path.join(root, "LICENSE"))) throw new Error("no LICENSE file: the copyright holder must choose a license (docs/release.md)");
  return readFileSync(path.join(root, "LICENSE"), "utf8").split("\n")[0];
}, { pendingKey: "license" });
check("required documents", () => {
  const missing = ["README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "docs/quickstart.md", "docs/compatibility.md", "docs/release.md", "docs/data-lifecycle.md"].filter((f) => !existsSync(path.join(root, f)));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);
  return "present";
});
check("version consistency", () => {
  const cli = JSON.parse(readFileSync(path.join(root, "apps/cli/package.json"), "utf8")).version;
  const core = /VERSION = "([^"]+)"/.exec(readFileSync(path.join(root, "packages/core/src/version.ts"), "utf8"))[1];
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  if (cli !== core) throw new Error(`apps/cli ${cli} vs core VERSION ${core}`);
  if (!changelog.includes(`## ${cli}`)) throw new Error(`CHANGELOG.md has no "## ${cli}" entry`);
  return cli;
});
check("bundled CLI works from a clean directory", () => {
  run("node", ["scripts/bundle-cli.mjs"]);
  const work = mkdtempSync(path.join(tmpdir(), "loom-release-"));
  try {
    const bundle = path.join(work, "pkg");
    cpSync(path.join(root, "dist-release/loom"), bundle, { recursive: true });
    cpSync(path.join(root, "examples/synthetic/kickoff-conversation.json"), path.join(work, "kickoff.json"));
    cpSync(path.join(root, "examples/synthetic/fixtures/extraction.json"), path.join(work, "recorded.json"));
    const loom = (...args) => execFileSync(process.execPath, [path.join(bundle, "lib/loom-bin.mjs"), "--dir", work, ...args], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LOOM_ACTOR: "release-check" } });
    const version = loom("--version").trim();
    loom("init", "--project-id", "release", "--provider", "fixture", "--fixture", "recorded.json");
    loom("ingest", "kickoff.json");
    if (!/7 new/.test(loom("extract"))) throw new Error("bundled extract did not produce 7 records");
    loom("assess", "--pack", "web-release");
    loom("generate");
    if (!existsSync(path.join(work, "loom-docs/VISION.md"))) throw new Error("bundled generate wrote no VISION.md");
    const pack = run("npm", ["pack", "--dry-run", "--json"], { cwd: bundle });
    const files = JSON.parse(pack)[0].files.length;
    return `loom ${version}; demo OK; npm pack would contain ${files} files`;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
check("real upstream adapter runs recorded", () => {
  const notes = readFileSync(path.join(root, "docs/adapters/beads.md"), "utf8");
  if (/\*\*not run\*\*/.test(notes)) throw new Error("Beads real-binary suite has not been run (docs/adapters/beads.md)");
  return "recorded";
}, { pendingKey: "upstream" });

const icon = { pass: "✓", pending: "…", fail: "✗" };
console.log("Release checks");
for (const r of results) console.log(`  ${icon[r.status]} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
console.log("\nManual, explicitly authorised final steps (never run by this script):");
console.log("  - choose the license and add LICENSE (copyright holder)");
console.log("  - confirm the package/product name (npm view <name>) and trademark check");
console.log("  - change repository visibility; publish the package (npm publish from dist-release/loom)");
const failed = results.filter((r) => r.status === "fail");
const pending = results.filter((r) => r.status === "pending");
console.log(`\n${failed.length === 0 ? (pending.length === 0 ? "READY" : `READY EXCEPT ${pending.length} PENDING DECISION(S)`) : `NOT READY: ${failed.length} failing`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
