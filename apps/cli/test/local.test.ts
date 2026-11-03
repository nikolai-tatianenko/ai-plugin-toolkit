import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashingVector } from "@ai-plugin-toolkit/router";
import { EXIT, run, type CliIo } from "../src/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, "../../../examples/synthetic");
let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "loom-local-"));
  await copyFile(path.join(examples, "kickoff-conversation.json"), path.join(workDir, "kickoff.json"));
  await copyFile(path.join(examples, "fixtures/extraction.json"), path.join(workDir, "recorded.json"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function loom(args: string[], cwd = workDir) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = { cwd, env: { LOOM_ACTOR: "pat", PATH: process.env.PATH }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) };
  const code = await run(args, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) as { data: Record<string, any>; error?: { code: string } } };
}

describe("project discovery and small CLI conveniences", () => {
  it("finds loom.config.json in a parent directory when --dir is not given", async () => {
    await loom(["init", "--project-id", "habit"]);
    await mkdir(path.join(workDir, "src", "deep"), { recursive: true });
    const nested = path.join(workDir, "src", "deep");
    expect((await loom(["ingest", "../../kickoff.json"], nested)).code).toBe(EXIT.ok);
    expect((await loom(["sources", "list", "--json"], nested)).json().data.total).toBe(1);
  });

  it("ingest --dry-run reports which files are already stored", async () => {
    await loom(["init", "--project-id", "habit"]);
    await writeFile(path.join(workDir, "new.md"), "Brand new note.");
    expect((await loom(["ingest", "kickoff.json", "new.md", "--dry-run", "--json"])).json().data).toMatchObject({ new: 2, existing: 0 });
    await loom(["ingest", "kickoff.json"]);
    const dry = (await loom(["ingest", "kickoff.json", "new.md", "--dry-run", "--json"])).json().data;
    expect(dry).toMatchObject({ new: 1, existing: 1 });
    expect(dry.sources.map((s: { status: string }) => s.status)).toEqual(["existing", "new"]);
    expect((await loom(["sources", "list", "--json"])).json().data.total).toBe(1);
  });

  it("revision set --from-git records the current commit and marks a dirty tree", async () => {
    await loom(["init", "--project-id", "habit"]);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: workDir, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first");
    const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
    expect((await loom(["revision", "set", "--from-git", "--json"])).json().data.revision).toBe(head);
    git("add", "kickoff.json");
    expect((await loom(["revision", "set", "--from-git", "--json"])).json().data.revision).toBe(`${head}-dirty`);
    expect((await loom(["revision", "set"])).code).toBe(EXIT.usage);
  });
});

/**
 * A27: fully local operation with outside network access denied. Every non-loopback
 * socket connection and DNS lookup is blocked (and recorded) while the whole workflow
 * runs against a local Ollama-compatible server on 127.0.0.1. The stub stands in for a
 * real Ollama: it shows Loom needs nothing beyond loopback, not how a local model performs.
 */
describe("A27: restricted project, local inference, network denied", () => {
  let server: Server;
  const blocked: string[] = [];
  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;

  beforeEach(async () => {
    const fixture = JSON.parse(await readFile(path.join(examples, "fixtures/extraction.json"), "utf8")) as { responses: Array<{ json: unknown }> };
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages?: Array<{ content: string }>; input?: string[] };
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/api/embed") {
          res.end(JSON.stringify({ embeddings: body.input!.map((t) => hashingVector(t)) }));
          return;
        }
        const sourceId = /source-id="([^"]+)"/.exec(body.messages!.map((m) => m.content).join("\n"))?.[1] ?? "";
        const content = JSON.stringify(fixture.responses[0]!.json).replaceAll("{{sourceId}}", sourceId);
        res.end(JSON.stringify({ model: "local-model", message: { role: "assistant", content }, done_reason: "stop", prompt_eval_count: 100, eval_count: 50 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const isLoopback = (host: unknown) => typeof host === "string" && /^(127\.|::1$|localhost$)/.test(host);
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      const opts = args[0] as { host?: string; path?: string } | number;
      const host = typeof opts === "object" ? (opts.path ? "unix" : (opts.host ?? "localhost")) : String(args[1] ?? "localhost");
      if (host !== "unix" && !isLoopback(host)) {
        blocked.push(host);
        throw new Error(`network denied: ${host}`);
      }
      return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
    } as typeof net.Socket.prototype.connect;
    (dns as { lookup: unknown }).lookup = (hostname: string, ...rest: unknown[]) => {
      const cb = rest.at(-1) as (err: Error | null, address?: string, family?: number) => void;
      if (!isLoopback(hostname)) {
        blocked.push(`dns:${hostname}`);
        cb(new Error(`DNS denied: ${hostname}`));
        return;
      }
      cb(null, "127.0.0.1", 4);
    };
  });
  afterEach(async () => {
    net.Socket.prototype.connect = originalConnect;
    (dns as { lookup: unknown }).lookup = originalLookup;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("completes ingest → extract → embed → semantic search → assess → generate without leaving the machine", async () => {
    const port = (server.address() as AddressInfo).port;
    expect((await loom(["init", "--project-id", "habit", "--provider", "ollama", "--model", "local-model", "--embeddings", "ollama"])).code).toBe(EXIT.ok);
    const configPath = path.join(workDir, "loom.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.project.sensitivity = "restricted";
    for (const p of Object.values(config.providers) as Array<{ baseUrl: string }>) p.baseUrl = `http://127.0.0.1:${port}`;
    await writeFile(configPath, JSON.stringify(config));
    expect((await loom(["config", "validate"])).code).toBe(EXIT.ok);

    expect((await loom(["ingest", "kickoff.json"])).code).toBe(EXIT.ok);
    const extract = (await loom(["extract", "--json"])).json().data;
    expect(extract.totals).toMatchObject({ extracted: 1, created: 7 });
    expect(extract.results[0].provider).toBe("local");
    expect((await loom(["embed", "--json"])).json().data).toMatchObject({ embedded: 7 });
    const hits = (await loom(["search", "reminders", "offline", "--semantic", "--json"])).json().data.hits;
    expect(hits[0].text).toBe("Reminders must work offline.");
    expect((await loom(["assess", "--pack", "mobile-release"])).code).toBe(EXIT.ok);
    expect((await loom(["generate"])).code).toBe(EXIT.ok);
    expect(await readFile(path.join(workDir, "loom-docs/STATUS.md"), "utf8")).toMatch(/- extraction: 1 call\(s\).*cost \$0\.0000/);
    expect(blocked).toEqual([]);

    // A remote provider cannot be added to a restricted project (A19).
    config.providers.claude = { adapter: "anthropic", location: "remote", apiKeyEnv: "ANTHROPIC_API_KEY" };
    config.routing.extraction.providers.push("claude");
    await writeFile(configPath, JSON.stringify(config));
    expect((await loom(["config", "validate", "--json"])).json().error?.code).toBe("CONFIG_INVALID");
  }, 60_000);

  it("the network guard really blocks outside connections", async () => {
    await expect(fetch("https://api.anthropic.com/v1/models")).rejects.toThrow();
    expect(blocked.length).toBeGreaterThan(0);
  });
});
