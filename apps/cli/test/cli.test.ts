import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, run, type CliIo } from "../src/run.js";

const execFileAsync = promisify(execFile);
const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/main.js");

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "loom-cli-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function loom(args: string[], env: Record<string, string | undefined> = {}) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd: workDir, env, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) };
  const code = await run(args, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as Record<string, any> };
}

async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe("loom init", () => {
  it("creates config and a git-ignored storage directory", async () => {
    const result = await loom(["init", "--dir", "My App", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    const data = result.json().data;
    expect(data.projectId).toBe("my-app");
    const config = JSON.parse(await readFile(data.configPath, "utf8"));
    expect(config.project).toEqual({ id: "my-app", name: "My App", sensitivity: "standard" });
    expect(await readFile(path.join(data.storageDir, ".gitignore"), "utf8")).toContain("*");
  });

  it("--dry-run writes nothing", async () => {
    const result = await loom(["init", "--dry-run", "--project-id", "demo"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Would create");
    expect(await exists(path.join(workDir, "loom.config.json"))).toBe(false);
    expect(await exists(path.join(workDir, ".loom"))).toBe(false);
  });

  it("refuses to overwrite an existing config and preserves its content", async () => {
    await writeFile(path.join(workDir, "loom.config.json"), '{"hand":"edited"}');
    const result = await loom(["init", "--project-id", "demo", "--json"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.json().error.code).toBe("ALREADY_EXISTS");
    expect(await readFile(path.join(workDir, "loom.config.json"), "utf8")).toBe('{"hand":"edited"}');
  });

  it("rejects an invalid project ID as a usage-level validation failure", async () => {
    const result = await loom(["init", "--project-id", "Bad ID", "--json"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.json().error.code).toBe("CONFIG_INVALID");
  });

  it("rejects options that belong to another command", async () => {
    const result = await loom(["config", "validate", "--dry-run"]);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("--dry-run is not supported");
  });
});

describe("loom config validate", () => {
  it("reports a missing config with a clear next step", async () => {
    const result = await loom(["config", "validate"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toMatch(/No loom\.config\.json .* Run `loom init` first/);
  });

  it("validates an initialized project", async () => {
    await loom(["init", "--project-id", "demo"]);
    const result = await loom(["config", "validate", "--json"]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.json().data.config.project.id).toBe("demo");
  });

  it("explains invalid configs with field paths", async () => {
    await writeFile(
      path.join(workDir, "loom.config.json"),
      JSON.stringify({ $schemaVersion: 1, project: { id: "demo", name: "D" }, storage: { dir: "../escape" } }),
    );
    const result = await loom(["config", "validate"]);
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toContain("storage.dir");
  });

  it("warns about unset credential variables without printing secrets", async () => {
    await writeFile(
      path.join(workDir, "loom.config.json"),
      JSON.stringify({
        $schemaVersion: 1,
        project: { id: "demo", name: "D" },
        providers: { cloud: { adapter: "anthropic", location: "remote", apiKeyEnv: "LOOM_TEST_KEY" } },
      }),
    );
    const unset = await loom(["config", "validate", "--json"]);
    expect(unset.json().data.warnings[0].code).toBe("CREDENTIAL_ENV_UNSET");

    const set = await loom(["config", "validate", "--json"], { LOOM_TEST_KEY: "sk-ant-api03-secretsecretsecretsecret" });
    expect(set.json().data.warnings).toEqual([]);
    expect(set.stdout).not.toContain("secretsecret");
  });
});

describe("general CLI behavior", () => {
  it("prints version and help", async () => {
    expect((await loom(["--version"])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const help = await loom([]);
    expect(help.code).toBe(EXIT.ok);
    expect(help.stdout).toContain("config validate");
  });

  it("returns a usage exit code for unknown commands and flags", async () => {
    expect((await loom(["frobnicate"])).code).toBe(EXIT.usage);
    const flag = await loom(["init", "--nope", "--json"]);
    expect(flag.code).toBe(EXIT.usage);
    expect(flag.json().error.code).toBe("USAGE");
  });
});

describe("built binary (clean-checkout smoke)", () => {
  it("runs init and validate as a real process", async () => {
    const opts = { cwd: workDir };
    const init = await execFileAsync(process.execPath, [binPath, "init", "--project-id", "smoke", "--json"], opts);
    expect(JSON.parse(init.stdout).ok).toBe(true);
    const validate = await execFileAsync(process.execPath, [binPath, "config", "validate"], opts);
    expect(validate.stdout).toContain("is valid");
  });

  it("exits non-zero on failure", async () => {
    await expect(execFileAsync(process.execPath, [binPath, "config", "validate"], { cwd: workDir })).rejects.toMatchObject({
      code: EXIT.failure,
    });
  });
});
