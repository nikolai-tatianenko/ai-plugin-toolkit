import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LoomError,
  defineTaskAdapter,
  redactString,
  type ExternalTask,
  type TaskAdapter,
  type TaskDraft,
} from "@ai-plugin-toolkit/core";

/**
 * Beads (`bd`) task adapter (CL-011). Talks to the documented CLI with `--json`.
 * Compatibility notes: docs/adapters/beads.md. Commands run through execFile with an
 * argument array (never a shell), and flag values use `--flag=value` so a title that
 * starts with "-" cannot be parsed as a flag (A23).
 */

export const BEADS_ADAPTER_VERSION = "0.1.0";
/** Upstream line whose documentation and source (v1.3.2) this adapter was written against. */
export const SUPPORTED_BEADS = { major: 1, minor: 3, label: "1.3.x" } as const;
export const EXTERNAL_REF_PREFIX = "loom:";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export type Exec = (file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<ExecResult>;

export const nodeExec: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(error);
        if (error && error.killed) return reject(new LoomError("TIMEOUT", `${file} did not finish within ${options.timeoutMs} ms.`));
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      },
    );
  });

export interface BeadsAdapterOptions {
  /** `bd` on PATH, or an absolute path. */
  command?: string;
  /** Absolute Beads database directory, passed as BEADS_DIR. */
  beadsDir: string;
  /** Working directory for `bd` (the project directory). */
  cwd: string;
  /** Base environment (PATH, HOME). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  actor?: string;
  timeoutMs?: number;
  /** Allow a `bd` version outside the reviewed line. Off by default. */
  allowUntestedVersion?: boolean;
  /** Test seam. */
  exec?: Exec;
}

const DependencySchema = z.looseObject({
  depends_on_id: z.string().optional(),
  id: z.string().optional(),
  type: z.string().optional(),
  dependency_type: z.string().optional(),
});
export const BeadsIssueSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  status: z.string().optional(),
  updated_at: z.string().min(1),
  external_ref: z.string().nullish(),
  dependencies: z.array(DependencySchema).nullish(),
});
export type BeadsIssue = z.infer<typeof BeadsIssueSchema>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function checkId(id: string): string {
  if (!ID.test(id)) throw new LoomError("VALIDATION_FAILED", `Refusing unexpected Beads issue ID ${JSON.stringify(id)}.`);
  return id;
}

/** Beads status → contract status. Beads owns status; Loom only reads it. */
export function mapStatus(status: string | undefined): ExternalTask["status"] {
  if (status === "closed") return "closed";
  if (status === "in_progress" || status === "hooked") return "in-progress";
  return "open";
}

export function toExternalTask(issue: BeadsIssue): ExternalTask {
  const ref = issue.external_ref ?? undefined;
  const deps = (issue.dependencies ?? [])
    .filter((d) => (d.type ?? d.dependency_type ?? "blocks") === "blocks")
    .map((d) => d.depends_on_id ?? d.id)
    .filter((d): d is string => typeof d === "string" && d !== issue.id);
  return {
    externalId: issue.id,
    title: issue.title,
    ...(issue.description === undefined || issue.description === "" ? {} : { description: issue.description }),
    status: mapStatus(issue.status),
    revision: issue.updated_at,
    ...(ref?.startsWith(EXTERNAL_REF_PREFIX) ? { idempotencyKey: ref.slice(EXTERNAL_REF_PREFIX.length) } : {}),
    ...(deps.length > 0 ? { dependsOn: [...new Set(deps)] } : {}),
  };
}

export function parseVersion(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // fall back to the text form: "bd version 1.3.2 (...)"
  }
  const match = /(\d+\.\d+\.\d+)/.exec(stdout);
  if (match === null) throw new LoomError("EXTERNAL_TOOL_FAILED", "Could not read the Beads version from `bd version`.");
  return match[1]!;
}

export class BeadsAdapter implements TaskAdapter {
  readonly manifest = {
    kind: "task-adapter" as const,
    name: "beads",
    version: BEADS_ADAPTER_VERSION,
    upstream: { name: "beads (bd)", versionRange: SUPPORTED_BEADS.label },
    capabilities: ["readTasks", "createTask", "updateTask", "linkDependency"] as Array<"readTasks" | "createTask" | "updateTask" | "linkDependency">,
  };
  private readonly options: Required<Omit<BeadsAdapterOptions, "actor">> & { actor: string | undefined };
  private versionChecked: string | undefined;

  constructor(options: BeadsAdapterOptions) {
    if (!path.isAbsolute(options.beadsDir)) throw new LoomError("INVALID_PATH", "beadsDir must be absolute.");
    this.options = {
      command: options.command ?? "bd",
      beadsDir: options.beadsDir,
      cwd: options.cwd,
      env: options.env ?? process.env,
      actor: options.actor,
      timeoutMs: options.timeoutMs ?? 60_000,
      allowUntestedVersion: options.allowUntestedVersion ?? false,
      exec: options.exec ?? nodeExec,
    };
  }

  private async run(args: readonly string[], { json = true } = {}): Promise<string> {
    const full = [...args, ...(json ? ["--json"] : []), ...(this.options.actor ? [`--actor=${this.options.actor}`] : [])];
    let result: ExecResult;
    try {
      result = await this.options.exec(this.options.command, full, {
        cwd: this.options.cwd,
        env: { ...this.options.env, BEADS_DIR: this.options.beadsDir, BD_NON_INTERACTIVE: "1", BD_DISABLE_METRICS: "1" },
        timeoutMs: this.options.timeoutMs,
      });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new LoomError(
          "EXTERNAL_TOOL_FAILED",
          `Beads CLI "${this.options.command}" was not found. Install Beads ${SUPPORTED_BEADS.label} (see docs/adapters/beads.md) or set tasks.beads.command.`,
          { cause },
        );
      }
      throw cause;
    }
    if (result.exitCode !== 0) {
      const detail = redactString((result.stderr || result.stdout).trim()).slice(0, 2_000);
      throw new LoomError("EXTERNAL_TOOL_FAILED", `\`bd ${args[0]}\` failed (exit ${result.exitCode}): ${detail}`, {
        details: { command: args[0], exitCode: result.exitCode },
      });
    }
    return result.stdout;
  }

  private parse<T extends z.ZodType>(schema: T, stdout: string, what: string): z.output<T> {
    let raw: unknown;
    try {
      raw = JSON.parse(stdout);
    } catch (cause) {
      throw new LoomError("EXTERNAL_TOOL_FAILED", `\`bd ${what}\` did not return JSON.`, { cause });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new LoomError("EXTERNAL_TOOL_FAILED", `\`bd ${what}\` returned an unexpected shape: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    return parsed.data;
  }

  /** Check `bd version` once per adapter instance against the reviewed line. */
  async checkVersion(): Promise<string> {
    if (this.versionChecked !== undefined) return this.versionChecked;
    const version = parseVersion(await this.run(["version"]));
    const [major, minor] = version.split(".").map(Number);
    if ((major !== SUPPORTED_BEADS.major || minor !== SUPPORTED_BEADS.minor) && !this.options.allowUntestedVersion) {
      throw new LoomError(
        "UNSUPPORTED_CAPABILITY",
        `Beads ${version} is outside the reviewed line ${SUPPORTED_BEADS.label}. Install ${SUPPORTED_BEADS.label} or set LOOM_BEADS_ALLOW_UNTESTED=1 to try anyway.`,
        { details: { version, supported: SUPPORTED_BEADS.label } },
      );
    }
    this.versionChecked = version;
    return version;
  }

  /** Create the Beads database if missing, without touching AGENTS.md, git hooks or global git settings. */
  async initialize(prefix = "loom"): Promise<"created" | "existing"> {
    await this.checkVersion();
    try {
      await access(this.options.beadsDir);
      return "existing";
    } catch {
      // not present: create below
    }
    await mkdir(path.dirname(this.options.beadsDir), { recursive: true });
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(prefix)) throw new LoomError("VALIDATION_FAILED", `Invalid Beads prefix "${prefix}".`);
    await this.run(["init", "--non-interactive", "--quiet", "--skip-agents", "--skip-hooks", `--prefix=${prefix}`], { json: false });
    return "created";
  }

  async readTasks(): Promise<ExternalTask[]> {
    await this.checkVersion();
    const issues = this.parse(z.array(BeadsIssueSchema).nullable(), await this.run(["list", "--all", "--flat", "--limit=0"]), "list");
    return (issues ?? []).map(toExternalTask);
  }

  async createTask(draft: TaskDraft): Promise<ExternalTask> {
    await this.checkVersion();
    const ref = `${EXTERNAL_REF_PREFIX}${draft.idempotencyKey}`;
    const args = ["create", `--title=${draft.title}`, "--type=task", `--external-ref=${ref}`];
    if (draft.description !== undefined) args.push(`--description=${draft.description}`);
    const issue = this.parse(BeadsIssueSchema, await this.run(args), "create");
    return toExternalTask(issue);
  }

  private async show(externalId: string): Promise<BeadsIssue> {
    const issues = this.parse(z.array(BeadsIssueSchema).min(1), await this.run(["show", checkId(externalId)]), "show");
    return issues[0]!;
  }

  /**
   * Update title/description only if the issue is unchanged since `expectedRevision`
   * (its `updated_at`). Beads has no compare-and-set, so a write in the short window
   * between the check and the update is not detected; see the compatibility notes.
   */
  async updateTask(
    externalId: string,
    patch: Partial<Pick<ExternalTask, "title" | "description" | "status">>,
    expectedRevision: string,
  ): Promise<ExternalTask> {
    await this.checkVersion();
    if (patch.status !== undefined) {
      throw new LoomError("UNSUPPORTED_CAPABILITY", "The Beads adapter does not change status: status is owned by Beads.");
    }
    const current = await this.show(externalId);
    if (current.updated_at !== expectedRevision) {
      throw new LoomError("CONFLICT", `Beads issue ${externalId} changed since the last sync (updated_at ${current.updated_at}, expected ${expectedRevision}).`);
    }
    const args = ["update", checkId(externalId)];
    if (patch.title !== undefined) args.push(`--title=${patch.title}`);
    if (patch.description !== undefined) args.push(`--description=${patch.description}`);
    if (args.length === 2) return toExternalTask(current);
    this.parse(z.array(BeadsIssueSchema), await this.run(args), "update");
    return toExternalTask(await this.show(externalId));
  }

  async linkDependency(externalId: string, dependsOnExternalId: string): Promise<void> {
    await this.checkVersion();
    await this.run(["dep", "add", checkId(externalId), checkId(dependsOnExternalId), "--type=blocks"]);
  }
}

export function createBeadsAdapter(options: BeadsAdapterOptions): BeadsAdapter {
  return defineTaskAdapter(new BeadsAdapter(options));
}
