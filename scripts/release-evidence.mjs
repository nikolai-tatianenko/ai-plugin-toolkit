import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const SUITES = {
  beads: {
    files: ["packages/adapter-beads/test/beads.integration.test.ts", "apps/cli/test/workflow.test.ts"],
    groups: ["Beads adapter against real bd", "publishes through real Beads"],
  },
  taskmaster: {
    files: ["packages/adapter-taskmaster/test/taskmaster.integration.test.ts"],
    groups: ["Task Master adapter against real task-master"],
  },
  anthropic: { files: ["apps/cli/test/live-extraction.test.ts"], groups: ["live extraction: anthropic"] },
  ollama: { files: ["apps/cli/test/live-extraction.test.ts"], groups: ["live extraction: ollama"] },
  macos: { groups: ["frozen-install", "build", "bundle", "packed-install", "offline-demo", "idempotency", "workspace-checklists", "workspace-memory-hooks"] },
};

export function sourceFiles(root) {
  return [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))].sort();
}

// Hash source bytes, not the commit ID: receipts survive a merge only if its content is identical.
// Include untracked, non-ignored files so a newly added implementation cannot evade invalidation.
export function sourceDigest(root) {
  const hash = createHash("sha256");
  for (const file of sourceFiles(root)) {
    const bytes = readFileSync(path.join(root, file));
    hash.update(`${file}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export function selectedTests(report, suite) {
  const groups = SUITES[suite]?.groups;
  if (!groups) throw new Error(`Unknown verification suite: ${suite}`);
  const tests = (report.testResults ?? []).flatMap((result) => result.assertionResults ?? [])
    .filter((test) => groups.some((group) => test.fullName?.includes(group)))
    .map((test) => ({ name: test.fullName, status: test.status }));
  assertPassing(tests, suite);
  if (report.success !== true || report.numFailedTests !== 0 || report.numFailedTestSuites !== 0) {
    throw new Error(`${suite}: test runner did not complete successfully`);
  }
  return tests;
}

function assertPassing(tests, suite) {
  if (!Array.isArray(tests) || tests.length === 0 || tests.some((t) => typeof t.name !== "string" || t.status !== "passed")) {
    throw new Error(`${suite}: missing, skipped, or failing verification tests`);
  }
  for (const group of SUITES[suite].groups) {
    if (!tests.some((test) => test.name.includes(group))) throw new Error(`${suite}: missing required scenario: ${group}`);
  }
}

export function validateEvidence(receipt, suite, digest) {
  if (!SUITES[suite]) throw new Error(`Unknown verification suite: ${suite}`);
  if (receipt.schemaVersion !== 1 || receipt.suite !== suite || receipt.sourceDigest !== digest) {
    throw new Error(`${suite}: missing or stale evidence; run pnpm verify:release -- ${suite}`);
  }
  const at = Date.parse(receipt.completedAt);
  if (!Number.isFinite(at) || at > Date.now() + 300_000 || typeof receipt.node !== "string" || !receipt.platform) {
    throw new Error(`${suite}: invalid verification metadata`);
  }
  assertPassing(receipt.tests, suite);
  if (suite === "macos" && receipt.platform !== "darwin") throw new Error("macos: evidence must come from macOS");
  if (["beads", "taskmaster"].includes(suite) && !receipt.details?.version) throw new Error(`${suite}: upstream version missing`);
  if (["anthropic", "ollama"].includes(suite) &&
      (receipt.details?.provider !== suite || typeof receipt.details?.model !== "string" || !receipt.details.model ||
       !Number.isInteger(receipt.details?.created) || receipt.details.created < 3 || receipt.details?.rejected !== 0)) {
    throw new Error(`${suite}: real extraction result metadata missing`);
  }
  return `${receipt.tests.length} passing scenario(s), ${receipt.platform}, Node ${receipt.node}, ${receipt.completedAt}`;
}
