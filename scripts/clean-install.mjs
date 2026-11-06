import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "./release-evidence.mjs";

// Portable clean installation check. The caller enforces the host requirement
// before this result can become a macOS verification receipt.
export function verifyCleanInstall({ root, temp, run }) {
  const checkout = path.join(temp, "source");
  for (const file of sourceFiles(root)) {
    const dest = path.join(checkout, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(path.join(root, file), dest);
  }
  const tests = [];
  const step = (name, fn) => { fn(); tests.push({ name, status: "passed" }); };
  step("frozen-install", () => run("pnpm", ["install", "--frozen-lockfile"], { cwd: checkout }));
  step("build", () => run("pnpm", ["build"], { cwd: checkout }));
  step("bundle", () => run(process.execPath, ["scripts/bundle-cli.mjs"], { cwd: checkout }));
  const installed = path.join(temp, "installed");
  step("packed-install", () => {
    const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp], { cwd: path.join(checkout, "dist-release/loom") }));
    run("npm", ["install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", path.join(temp, packed[0].filename)]);
  });
  const pkg = JSON.parse(readFileSync(path.join(checkout, "dist-release/loom/package.json"), "utf8"));
  const bin = path.join(installed, "node_modules", pkg.name, "lib/loom-bin.mjs");
  const project = path.join(temp, "project");
  mkdirSync(project);
  cpSync(path.join(checkout, "examples/synthetic/kickoff-conversation.json"), path.join(project, "kickoff.json"));
  cpSync(path.join(checkout, "examples/synthetic/fixtures/extraction.json"), path.join(project, "recorded.json"));
  const env = { ...process.env, LOOM_USER_HOME: path.join(temp, "private-memory") };
  const loom = (...commandArgs) => JSON.parse(run(process.execPath, [bin, "--dir", project, ...commandArgs, "--json"], { cwd: project, env }));
  step("offline-demo", () => {
    loom("init", "--project-id", "macos-check", "--provider", "fixture", "--fixture", "recorded.json");
    loom("ingest", "kickoff.json");
    if (loom("extract").data.totals.created !== 7) throw new Error("packed extraction did not produce 7 records");
    loom("assess", "--pack", "web-release");
    loom("generate");
    if (!readFileSync(path.join(project, "loom-docs/VISION.md"), "utf8").includes("SQLite")) throw new Error("packed VISION missing decision");
  });
  step("idempotency", () => {
    if (loom("ingest", "kickoff.json").data.existing !== 1) throw new Error("ingest was not idempotent");
    if (loom("extract").data.totals.skipped !== 1) throw new Error("extract was not idempotent");
    if (loom("generate").data.artifacts.some((a) => a.status !== "unchanged")) throw new Error("generate was not idempotent");
  });
  step("workspace-checklists", () => {
    loom("checklists", "template", "init", "delivery", "--out", "delivery.json");
    loom("checklists", "template", "save", "--file", "delivery.json");
    loom("checklists", "create", "packed-release", "--template", "delivery");
    loom("revision", "set", "packed-build");
    loom("evidence", "add", "tests", "--pack", "packed-release", "--result", "passed", "--env", "ci", "--revision", "packed-build");
    if (loom("checklists", "report", "packed-release").data.value.evaluation.readiness.status !== "ready") throw new Error("installed checklist evidence workflow failed");
  });
  step("workspace-memory-hooks", () => {
    writeFileSync(path.join(project, "profile.json"), JSON.stringify({ id: "synthetic", name: "Synthetic user", goals: ["Verify installed memory"] }));
    loom("profile", "set", "--file", "profile.json");
    const output = JSON.parse(run(process.execPath, [bin, "--dir", project, "hook", "run", "--client", "codex"], { cwd: project, env, stdio: ["pipe", "pipe", "pipe"], input: JSON.stringify({ session_id: "packed-check", hook_event_name: "SessionStart" }) }));
    if (!output.hookSpecificOutput?.additionalContext.includes("Verify installed memory")) throw new Error("installed native hook lost private goals");
    if (!loom("hooks", "install", "--client", "claude", "--dry-run").data.value.settings.hooks.Stop.length) throw new Error("installed hook manifest missing Stop");
  });
  return { tests, details: { package: pkg.name, version: pkg.version, cleanInstall: true } };
}
