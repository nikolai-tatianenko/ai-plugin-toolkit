import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "vitest";
import { createBeadsAdapter, nodeExec, parseVersion, SUPPORTED_BEADS, type Exec } from "../src/index.js";
import { syncScenarios } from "../../task-sync/test/scenarios.js";

/**
 * Real integration: the shared sync scenarios against an actual `bd` binary and a
 * disposable Beads database. This is the only test that counts as evidence for the
 * adapter. Without a supported `bd`, it is skipped and says why — the CL-011 gate
 * then stays open.
 */
function locateBd(): { bin: string; version: string } | { skip: string } {
  const bin = process.env.LOOM_BD_BIN ?? "bd";
  let out: string;
  try {
    out = execFileSync(bin, ["version"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return { skip: `"${bin}" is not runnable (set LOOM_BD_BIN or install Beads ${SUPPORTED_BEADS.label})` };
  }
  const version = parseVersion(out);
  const [major, minor] = version.split(".").map(Number);
  if (major !== SUPPORTED_BEADS.major || minor !== SUPPORTED_BEADS.minor) {
    return { skip: `bd ${version} found; this suite targets ${SUPPORTED_BEADS.label}` };
  }
  return { bin, version };
}

const found = locateBd();
if ("skip" in found) {
  describe("Beads adapter against real bd", () => {
    it.skip(`SKIPPED — real Beads integration not run: ${found.skip}`, () => {});
  });
} else {
  describe(`Beads adapter against real bd ${found.version}`, () => {
    syncScenarios(async (workDir) => {
      let writes = 0;
      const counting: Exec = async (file, args, options) => {
        if (["create", "update", "dep"].includes(args[0] ?? "")) writes++;
        return nodeExec(file, args, options);
      };
      const beadsDir = path.join(workDir, ".beads");
      const adapter = createBeadsAdapter({ command: found.bin, beadsDir, cwd: workDir, actor: "loom-test", exec: counting });
      await adapter.initialize("loomtest");
      writes = 0;
      return {
        adapter,
        editRemote: async (id, title) => {
          const result = await nodeExec(found.bin, ["update", id, `--title=${title}`, "--json"], {
            cwd: workDir,
            env: { ...process.env, BEADS_DIR: beadsDir, BD_NON_INTERACTIVE: "1" },
            timeoutMs: 60_000,
          });
          if (result.exitCode !== 0) throw new Error(result.stderr);
          // updated_at has second precision in some builds; make sure the edit is observable.
          await new Promise((r) => setTimeout(r, 1_100));
        },
        writes: () => writes,
        cleanup: async () => {},
      };
    });
  });
}
