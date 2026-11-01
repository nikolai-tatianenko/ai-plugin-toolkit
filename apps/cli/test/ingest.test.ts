import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type CliIo } from "../src/run.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, "../dist/main.js");
const fixture = path.resolve(here, "../../../examples/synthetic/kickoff-conversation.json");

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "loom-ingest-"));
  await copyFile(fixture, path.join(workDir, "kickoff.json"));
  await writeFile(path.join(workDir, "notes.md"), "# Notes\nReminders must work offline.\n");
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function loom(args: string[]) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd: workDir, env: { LOOM_ACTOR: "tester" }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) };
  const code = await run(args, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, any> };
}

describe("ingest → sources workflow (synthetic fixture)", () => {
  it("A01: ingesting the same files twice keeps IDs and counts stable", async () => {
    await loom(["init", "--project-id", "habit"]);
    const first = await loom(["ingest", "kickoff.json", "notes.md", "--json"]);
    expect(first.code).toBe(EXIT.ok);
    expect(first.json().data).toMatchObject({ created: 2, existing: 0 });

    const second = await loom(["ingest", "kickoff.json", "notes.md", "--json"]);
    expect(second.json().data).toMatchObject({ created: 0, existing: 2 });
    expect(second.json().data.sources.map((s: { id: string }) => s.id)).toEqual(
      first.json().data.sources.map((s: { id: string }) => s.id),
    );

    const list = await loom(["sources", "list", "--json"]);
    expect(list.json().data.total).toBe(2);
  });

  it("A03: a stored source shows the exact original text", async () => {
    await loom(["init", "--project-id", "habit"]);
    const ingest = await loom(["ingest", "kickoff.json", "--json"]);
    const id = ingest.json().data.sources[0].id as string;
    const show = await loom(["sources", "show", id, "--json"]);
    const original = await import("node:fs/promises").then((fs) => fs.readFile(fixture, "utf8"));
    expect(show.json().data.text).toBe(original);
    expect(show.json().data.source.type).toBe("conversation");
  });

  it("one malformed file in a batch leaves no records", async () => {
    await loom(["init", "--project-id", "habit"]);
    await writeFile(path.join(workDir, "broken.json"), '{"messages": "nope"}');
    const result = await loom(["ingest", "notes.md", "broken.json", "--json"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.json().error.code).toBe("VALIDATION_FAILED");
    expect((await loom(["sources", "list", "--json"])).json().data.total).toBe(0);
  });

  it("--dry-run validates and reports IDs without creating storage", async () => {
    await loom(["init", "--project-id", "habit"]);
    const dry = await loom(["ingest", "kickoff.json", "--dry-run", "--json"]);
    expect(dry.code).toBe(EXIT.ok);
    const real = await loom(["ingest", "kickoff.json", "--json"]);
    expect(real.json().data.sources[0].id).toBe(dry.json().data.sources[0].id);
    expect(real.json().data.created).toBe(1);
  });

  it("reports usage and lookup errors clearly", async () => {
    await loom(["init", "--project-id", "habit"]);
    expect((await loom(["ingest"])).code).toBe(EXIT.usage);
    expect((await loom(["ingest", "a.md", "b.md", "--title", "x"])).code).toBe(EXIT.usage);
    expect((await loom(["ingest", "notes.md", "--type", "email"])).code).toBe(EXIT.usage);
    expect((await loom(["ingest", "missing.md", "--json"])).json().error.code).toBe("NOT_FOUND");
    expect((await loom(["sources", "show", "src_00000000000000000000000000", "--json"])).json().error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("built binary ingests without leaking the SQLite experimental warning", async () => {
    await execFileAsync(process.execPath, [binPath, "init", "--project-id", "habit"], { cwd: workDir });
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, "ingest", "kickoff.json"], { cwd: workDir });
    expect(stdout).toContain("1 new");
    expect(stderr).toBe("");
  });
});
