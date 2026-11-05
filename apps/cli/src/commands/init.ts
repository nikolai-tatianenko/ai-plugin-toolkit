import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_FILENAME,
  CONFIG_VERSION,
  LoomError,
  parseConfig,
  resolveStorageDir,
  slugifyProjectId,
} from "@ai-plugin-toolkit/core";
import { UsageError, type CommandResult } from "../io.js";

export interface InitOptions {
  rootDir: string;
  projectId?: string | undefined;
  name?: string | undefined;
  dryRun: boolean;
  /** Extraction provider to configure: "anthropic" (Claude, remote) or "fixture" (recorded responses, local). */
  provider?: string | undefined;
  fixture?: string | undefined;
  model?: string | undefined;
  /** Embedding provider: "hashing" (local feature hashing) or "ollama". */
  embeddings?: string | undefined;
  /** Task system to configure ("beads"). */
  tasks?: string | undefined;
  allowTaskWrites?: boolean;
}

function embeddingSection(kind: string | undefined): { providers: Record<string, unknown>; routing: Record<string, unknown> } {
  if (kind === undefined) return { providers: {}, routing: {} };
  if (kind === "hashing") return { providers: { hashing: { adapter: "hashing", location: "local" } }, routing: { embedding: { providers: ["hashing"], maxAttempts: 1 } } };
  if (kind === "ollama") {
    return {
      providers: { "local-embed": { adapter: "ollama", location: "local", baseUrl: "http://127.0.0.1:11434", embeddingModel: "nomic-embed-text" } },
      routing: { embedding: { providers: ["local-embed"], maxAttempts: 2 } },
    };
  }
  throw new UsageError(`Unknown --embeddings "${kind}". Choose hashing or ollama.`);
}

function providerSection(provider: string | undefined, fixture: string | undefined, model: string | undefined, embeddings: string | undefined): Record<string, unknown> {
  const extra = embeddingSection(embeddings);
  const merge = (base: { providers: Record<string, unknown>; routing: Record<string, unknown> }) => ({
    providers: { ...base.providers, ...extra.providers },
    routing: { ...base.routing, ...extra.routing },
  });
  if (provider === undefined) {
    if (fixture !== undefined) throw new UsageError("--fixture requires --provider fixture.");
    return embeddings === undefined ? {} : merge({ providers: {}, routing: {} });
  }
  if (provider === "ollama") {
    return merge({
      providers: { local: { adapter: "ollama", location: "local", baseUrl: "http://127.0.0.1:11434", model: model ?? "llama3.1:8b" } },
      routing: { extraction: { providers: ["local"], timeoutMs: 300_000, maxAttempts: 2, maxOutputTokens: 8_000 } },
    });
  }
  if (provider === "anthropic") {
    return merge({
      providers: { claude: { adapter: "anthropic", location: "remote", model: model ?? "claude-opus-5-5", apiKeyEnv: "ANTHROPIC_API_KEY" } },
      routing: { extraction: { providers: ["claude"], timeoutMs: 120_000, maxAttempts: 2, maxOutputTokens: 16_000 } },
    });
  }
  if (provider === "fixture") {
    if (fixture === undefined) throw new UsageError("--provider fixture needs --fixture <path to recorded responses>.");
    return merge({
      providers: { recorded: { adapter: "fixture", location: "local", fixture } },
      routing: { extraction: { providers: ["recorded"], maxAttempts: 1 } },
    });
  }
  throw new UsageError(`Unknown --provider "${provider}". Choose anthropic, ollama or fixture.`);
}

/** Keeps raw evidence (conversations, tool logs) out of version control by default. */
const STORAGE_GITIGNORE = "# Context Loom local state: may contain raw conversations. Do not commit.\n*\n";

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

export async function initCommand(options: InitOptions): Promise<CommandResult> {
  const rootDir = path.resolve(options.rootDir);
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const baseName = path.basename(rootDir);

  const projectId = options.projectId ?? slugifyProjectId(baseName);
  if (projectId === undefined) {
    throw new UsageError(`Cannot derive a project ID from "${baseName}". Pass --project-id <id>.`);
  }

  if (options.tasks !== undefined && options.tasks !== "beads" && options.tasks !== "taskmaster") throw new UsageError(`Unknown --tasks "${options.tasks}". Supported: beads, taskmaster.`);
  if (options.allowTaskWrites && options.tasks === undefined) throw new UsageError("--allow-task-writes requires --tasks beads|taskmaster.");
  // Validates the ID/name through the same schema a config file must satisfy.
  const config = parseConfig({
    $schemaVersion: CONFIG_VERSION,
    project: { id: projectId, name: options.name ?? baseName },
    ...providerSection(options.provider, options.fixture, options.model, options.embeddings),
    ...(options.tasks === undefined ? {} : { tasks: { adapter: options.tasks, allowWrites: options.allowTaskWrites === true } }),
  });
  const storageDir = resolveStorageDir(rootDir, config);

  if (await exists(configPath)) {
    throw new LoomError("ALREADY_EXISTS", `${configPath} already exists; refusing to overwrite it.`, {
      details: { configPath },
    });
  }

  const planned = [configPath, storageDir, path.join(storageDir, ".gitignore")];
  if (!options.dryRun) {
    await mkdir(rootDir, { recursive: true });
    // `wx` fails if another process created the file after the check above.
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" }).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new LoomError("ALREADY_EXISTS", `${configPath} already exists; refusing to overwrite it.`, { cause });
      }
      throw cause;
    });
    await mkdir(storageDir, { recursive: true });
    const gitignore = path.join(storageDir, ".gitignore");
    if (!(await exists(gitignore))) await writeFile(gitignore, STORAGE_GITIGNORE, { flag: "wx" });
  }

  const verb = options.dryRun ? "Would create" : "Created";
  return {
    data: { dryRun: options.dryRun, projectId, configPath, storageDir, paths: planned },
    lines: [
      `${verb} project "${projectId}" in ${rootDir}`,
      ...planned.map((p) => `  ${options.dryRun ? "+" : "✓"} ${path.relative(rootDir, p) || "."}`),
      ...(options.dryRun ? [] : ["Next: `loom config validate`"]),
    ],
  };
}
