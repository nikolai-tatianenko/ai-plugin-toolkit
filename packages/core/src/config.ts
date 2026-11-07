import { MemorySettingsSchema } from "./workspace-config.js";
import path from "node:path";
import { z } from "zod";
import { LoomError } from "./errors.js";
import { ProjectIdSchema } from "./schemas.js";

export const CONFIG_FILENAME = "loom.config.json";
export const CONFIG_VERSION = 1;

/** Routing policy names known to v0.1. Unknown policies are rejected rather than ignored. */
export const ROUTING_TASKS = ["extraction", "summary", "planning", "review", "embedding", "normalization"] as const;
export type RoutingTask = (typeof ROUTING_TASKS)[number];

const ProviderNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "Provider name must be a lowercase slug");
const EnvVarNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Must be an environment variable name");

/**
 * Providers reference credentials by environment variable name only. The schema is
 * strict, so a literal `apiKey` (or any unknown key) in the config file is rejected.
 */
export const ProviderConfigSchema = z.strictObject({
  /** Adapter package/implementation identifier, resolved by the router (CL-003). */
  adapter: z.string().min(1),
  /** `local` means inference never leaves this machine. Anything else is `remote`. */
  location: z.enum(["local", "remote"]),
  model: z.string().min(1).optional(),
  apiKeyEnv: EnvVarNameSchema.optional(),
  baseUrl: z.url().optional(),
  /** Embedding model for adapters that support embeddings (e.g. Ollama "nomic-embed-text"). */
  embeddingModel: z.string().min(1).optional(),
  /** `fixture` adapter only: recorded responses, relative to the project directory. */
  fixture: z.string().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const RoutingPolicySchema = z.strictObject({
  /** Ordered: the first entry is primary, the rest are permitted fallbacks. */
  providers: z.array(ProviderNameSchema).min(1),
  timeoutMs: z.int().min(1_000).max(600_000).default(60_000),
  maxAttempts: z.int().min(1).max(5).default(2),
  maxOutputTokens: z.int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;

export const TASK_ADAPTERS = ["beads", "taskmaster"] as const;

export const TaskSyncConfigSchema = z.strictObject({
  adapter: z.enum(TASK_ADAPTERS),
  /**
   * Publishing writes to an external system. It is off unless the project opts in;
   * `loom tasks preview` works either way.
   */
  allowWrites: z.boolean().default(false),
  beads: z
    .strictObject({
      /** Beads database directory (BEADS_DIR), relative to the project directory. */
      dir: z.string().min(1).default(".beads"),
      /** Executable name or absolute path. Never run through a shell. */
      command: z.string().min(1).default("bd"),
    })
    .default({ dir: ".beads", command: "bd" }),
  taskmaster: z
    .strictObject({
      /** Directory containing `.taskmaster/`, relative to the project directory. */
      dir: z.string().min(1).default("."),
      command: z.string().min(1).default("task-master"),
      tag: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default("master"),
    })
    .default({ dir: ".", command: "task-master", tag: "master" }),
  /**
   * Who owns task status. Only the external task system can own it in this version:
   * Loom reads status back and never sets or closes tasks.
   */
  statusOwner: z.literal("external").default("external"),
});
export type TaskSyncConfig = z.output<typeof TaskSyncConfigSchema>;

export const LoomConfigSchema = z
  .strictObject({
    $schemaVersion: z.literal(CONFIG_VERSION),
    project: z.strictObject({
      id: ProjectIdSchema,
      name: z.string().trim().min(1).max(200),
      /** `restricted` projects may only route to local providers. */
      sensitivity: z.enum(["standard", "restricted"]).default("standard"),
    }),
    storage: z
      .strictObject({
        /** Relative to the directory containing the config file; must stay inside it. */
        dir: z.string().min(1).default(".loom"),
      })
      .default({ dir: ".loom" }),
    providers: z.record(ProviderNameSchema, ProviderConfigSchema).default({}),
    routing: z.partialRecord(z.enum(ROUTING_TASKS), RoutingPolicySchema).default({}),
    artifacts: z
      .strictObject({
        /** Where generated Markdown is written, relative to the project directory. */
        dir: z.string().min(1).default("loom-docs"),
      })
      .default({ dir: "loom-docs" }),
    tasks: TaskSyncConfigSchema.optional(),
    mcp: z
      .strictObject({
        /** Allow MCP clients to call write tools (answer questions, generate artifacts). Off by default. */
        allowWrites: z.boolean().default(false),
      })
      .default({ allowWrites: false }),
    memory: MemorySettingsSchema.optional(),
    retention: z
      .strictObject({
        /** Sources older than this (by ingest time) are forgotten by `loom retention apply`. */
        sourceMaxAgeDays: z.int().min(1).max(36_500).optional(),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    for (const [task, policy] of Object.entries(config.routing)) {
      if (policy === undefined) continue;
      const seen = new Set<string>();
      policy.providers.forEach((name, index) => {
        const where = ["routing", task, "providers", index];
        if (seen.has(name)) {
          ctx.addIssue({ code: "custom", path: where, message: `Provider "${name}" is listed twice` });
        }
        seen.add(name);
        const provider = config.providers[name];
        if (provider === undefined) {
          ctx.addIssue({ code: "custom", path: where, message: `Unknown provider "${name}"` });
        } else if (config.project.sensitivity === "restricted" && provider.location !== "local") {
          ctx.addIssue({
            code: "custom",
            path: where,
            message: `Restricted project cannot route "${task}" to remote provider "${name}"`,
          });
        }
      });
    }
    const contained: Array<[string | undefined, (string | number)[]]> = [
      [config.storage.dir, ["storage", "dir"]],
      [config.artifacts.dir, ["artifacts", "dir"]],
      [config.tasks?.beads.dir, ["tasks", "beads", "dir"]],
      ...(config.tasks?.taskmaster.dir === "." ? [] : ([[config.tasks?.taskmaster.dir, ["tasks", "taskmaster", "dir"]]] as Array<[string | undefined, (string | number)[]]>)),
      ...Object.entries(config.providers).map(
        ([name, p]): [string | undefined, (string | number)[]] => [p.fixture, ["providers", name, "fixture"]],
      ),
    ];
    for (const [value, where] of contained) {
      if (value !== undefined && !isContainedRelativePath(value)) {
        ctx.addIssue({ code: "custom", path: where, message: `${where.join(".")} must be a relative path inside the project directory` });
      }
    }
  });

export type LoomConfig = z.output<typeof LoomConfigSchema>;
export type LoomConfigInput = z.input<typeof LoomConfigSchema>;

function isContainedRelativePath(candidate: string): boolean {
  if (candidate.includes("\0") || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) return false;
  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../") && normalized !== ".";
}

/** Validate already-decoded config data. File reading lives in the interface layer. */
export function parseConfig(raw: unknown, sourceLabel = CONFIG_FILENAME): LoomConfig {
  const result = LoomConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "(root)",
      message: issue.message,
    }));
    throw new LoomError(
      "CONFIG_INVALID",
      `${sourceLabel} is invalid:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`,
      { details: { source: sourceLabel, issues } },
    );
  }
  return result.data;
}

/** Decode JSON text and validate it. Syntax errors become CONFIG_INVALID, not crashes. */
export function parseConfigText(text: string, sourceLabel = CONFIG_FILENAME): LoomConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new LoomError("CONFIG_INVALID", `${sourceLabel} is not valid JSON: ${(cause as Error).message}`, {
      details: { source: sourceLabel },
      cause,
    });
  }
  return parseConfig(raw, sourceLabel);
}

export function defaultConfig(project: { id: string; name: string }): LoomConfig {
  return parseConfig({ $schemaVersion: CONFIG_VERSION, project });
}

/** Absolute storage directory; re-checks containment so a hand-edited config cannot escape the root. */
export function resolveStorageDir(rootDir: string, config: LoomConfig): string {
  return resolveProjectPath(rootDir, config.storage.dir, "storage.dir");
}

/** Resolve a configured relative path, refusing anything outside the project directory (A23). */
export function resolveProjectPath(rootDir: string, relativePath: string, label: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relativePath.includes("\0") || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new LoomError("INVALID_PATH", `${label} resolves outside the project directory: ${relativePath}`);
  }
  return resolved;
}

/** Turn an arbitrary directory name into a valid project ID, or undefined if nothing usable remains. */
export function slugifyProjectId(input: string): string | undefined {
  const slug = input
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return ProjectIdSchema.safeParse(slug).success ? slug : undefined;
}
