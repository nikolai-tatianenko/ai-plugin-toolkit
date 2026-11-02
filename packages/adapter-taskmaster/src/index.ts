import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { nodeExec, type Exec, type ExecResult } from "@ai-plugin-toolkit/adapter-beads";
import { LoomError, contentHash, defineTaskAdapter, redactString, type ExternalTask, type TaskAdapter, type TaskDraft } from "@ai-plugin-toolkit/core";

/**
 * Task Master (`task-master`) adapter (CL-014). Writes go through the documented CLI
 * with manual (non-AI) options only; reads parse `.taskmaster/tasks/tasks.json`
 * (tagged format). Task Master has no non-AI way to change a task's title or
 * description, so `updateTask` is not declared and sync reports it as unsupported
 * instead of invoking a model. See docs/adapters/task-master.md.
 */

export const TASKMASTER_ADAPTER_VERSION = "0.1.0";
export const SUPPORTED_TASKMASTER = { major: 0, minor: 43, label: "0.43.x" } as const;
export const KEY_MARKER = "loom-idempotency-key:";

const TaskSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  description: z.string().optional(),
  details: z.string().optional(),
  status: z.string().optional(),
  dependencies: z.array(z.union([z.number(), z.string()])).optional(),
});
type TmTask = z.infer<typeof TaskSchema>;
const TaggedSchema = z.record(z.string(), z.looseObject({ tasks: z.array(TaskSchema) }));
const LegacySchema = z.looseObject({ tasks: z.array(TaskSchema) });

export interface TaskMasterAdapterOptions {
  command?: string;
  /** Project directory that contains `.taskmaster/`. */
  projectDir: string;
  /** tasks.json path relative to projectDir. */
  tasksFile?: string;
  tag?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowUntestedVersion?: boolean;
  exec?: Exec;
}

/** Task Master statuses → contract status. Task Master owns status; Loom only reads it. */
export function mapStatus(status: string | undefined): ExternalTask["status"] {
  if (status === "done" || status === "cancelled") return "closed";
  if (status === "in-progress" || status === "review") return "in-progress";
  return "open";
}

export function toExternalTask(task: TmTask): ExternalTask {
  const key = task.details?.split(/\r?\n/).find((l) => l.startsWith(KEY_MARKER))?.slice(KEY_MARKER.length).trim();
  const deps = (task.dependencies ?? []).map(String);
  return {
    externalId: String(task.id),
    title: task.title,
    ...(task.description ? { description: task.description } : {}),
    status: mapStatus(task.status),
    // No revision field upstream: a hash of the fields Loom reads stands in for it.
    revision: contentHash(JSON.stringify([task.title, task.description ?? "", task.details ?? "", task.status ?? "", deps])).slice(0, 16),
    ...(key ? { idempotencyKey: key } : {}),
    ...(deps.length > 0 ? { dependsOn: deps } : {}),
  };
}

export function parseTasksFile(text: string, tag: string): TmTask[] {
  const raw = JSON.parse(text) as unknown;
  const legacy = LegacySchema.safeParse(raw);
  if (legacy.success && Array.isArray((raw as { tasks?: unknown }).tasks)) return legacy.data.tasks;
  const tagged = TaggedSchema.safeParse(raw);
  if (!tagged.success) throw new LoomError("EXTERNAL_TOOL_FAILED", "tasks.json has an unexpected shape (neither tagged nor legacy format).");
  return tagged.data[tag]?.tasks ?? [];
}

const ID = /^\d{1,9}$/;

export class TaskMasterAdapter implements TaskAdapter {
  readonly manifest = {
    kind: "task-adapter" as const,
    name: "taskmaster",
    version: TASKMASTER_ADAPTER_VERSION,
    upstream: { name: "task-master-ai", versionRange: SUPPORTED_TASKMASTER.label },
    capabilities: ["readTasks", "createTask", "linkDependency"] as Array<"readTasks" | "createTask" | "linkDependency">,
  };
  private readonly o: Required<Omit<TaskMasterAdapterOptions, "env">> & { env: NodeJS.ProcessEnv };
  private versionChecked: string | undefined;

  constructor(options: TaskMasterAdapterOptions) {
    if (!path.isAbsolute(options.projectDir)) throw new LoomError("INVALID_PATH", "projectDir must be absolute.");
    this.o = {
      command: options.command ?? "task-master",
      projectDir: options.projectDir,
      tasksFile: options.tasksFile ?? ".taskmaster/tasks/tasks.json",
      tag: options.tag ?? "master",
      env: options.env ?? process.env,
      timeoutMs: options.timeoutMs ?? 120_000,
      allowUntestedVersion: options.allowUntestedVersion ?? false,
      exec: options.exec ?? nodeExec,
    };
  }

  private async run(args: readonly string[]): Promise<string> {
    let result: ExecResult;
    try {
      result = await this.o.exec(this.o.command, args, { cwd: this.o.projectDir, env: this.o.env, timeoutMs: this.o.timeoutMs });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new LoomError("EXTERNAL_TOOL_FAILED", `Task Master CLI "${this.o.command}" was not found. Install task-master-ai ${SUPPORTED_TASKMASTER.label} or set tasks.taskmaster.command.`, { cause });
      }
      throw cause;
    }
    if (result.exitCode !== 0) {
      throw new LoomError("EXTERNAL_TOOL_FAILED", `\`task-master ${args[0]}\` failed (exit ${result.exitCode}): ${redactString((result.stderr || result.stdout).trim()).slice(0, 2_000)}`, {
        details: { command: args[0], exitCode: result.exitCode },
      });
    }
    return result.stdout;
  }

  async checkVersion(): Promise<string> {
    if (this.versionChecked !== undefined) return this.versionChecked;
    const out = await this.run(["--version"]);
    const version = /(\d+\.\d+\.\d+)/.exec(out)?.[1];
    if (version === undefined) {
      if (!this.o.allowUntestedVersion) throw new LoomError("UNSUPPORTED_CAPABILITY", `Could not read the Task Master version ("${out.trim().slice(0, 40)}"). Set LOOM_TASKMASTER_ALLOW_UNTESTED=1 to proceed.`);
      this.versionChecked = "unknown";
      return this.versionChecked;
    }
    const [major, minor] = version.split(".").map(Number);
    if ((major !== SUPPORTED_TASKMASTER.major || minor !== SUPPORTED_TASKMASTER.minor) && !this.o.allowUntestedVersion) {
      throw new LoomError("UNSUPPORTED_CAPABILITY", `Task Master ${version} is outside the reviewed line ${SUPPORTED_TASKMASTER.label}. Set LOOM_TASKMASTER_ALLOW_UNTESTED=1 to try anyway.`);
    }
    this.versionChecked = version;
    return version;
  }

  private file(): string {
    const resolved = path.resolve(this.o.projectDir, this.o.tasksFile);
    if (path.relative(this.o.projectDir, resolved).startsWith("..")) throw new LoomError("INVALID_PATH", "tasksFile escapes the project directory.");
    return resolved;
  }

  /** Create `.taskmaster/` without prompts, aliases, git changes or dependency installs. */
  async initialize(): Promise<"created" | "existing"> {
    await this.checkVersion();
    try {
      await readFile(this.file(), "utf8");
      return "existing";
    } catch {
      await this.run(["init", "--yes", "--skip-install", "--no-aliases", "--no-git"]);
      return "created";
    }
  }

  async readTasks(): Promise<ExternalTask[]> {
    await this.checkVersion();
    let text: string;
    try {
      text = await readFile(this.file(), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    return parseTasksFile(text, this.o.tag).map(toExternalTask);
  }

  async createTask(draft: TaskDraft): Promise<ExternalTask> {
    await this.checkVersion();
    // Manual creation needs both --title and --description; otherwise Task Master would call an AI provider.
    const description = draft.description?.split("\n")[0]?.trim() || draft.title;
    const details = `${KEY_MARKER} ${draft.idempotencyKey}\n\n${draft.description ?? ""}`.trimEnd();
    await this.run(["add-task", `--title=${draft.title}`, `--description=${description}`, `--details=${details}`, `--tag=${this.o.tag}`, `--file=${this.o.tasksFile}`]);
    const created = (await this.readTasks()).find((t) => t.idempotencyKey === draft.idempotencyKey);
    if (created === undefined) throw new LoomError("EXTERNAL_TOOL_FAILED", "Task Master reported success but the new task was not found in tasks.json.");
    return created;
  }

  async linkDependency(externalId: string, dependsOnExternalId: string): Promise<void> {
    await this.checkVersion();
    for (const id of [externalId, dependsOnExternalId]) if (!ID.test(id)) throw new LoomError("VALIDATION_FAILED", `Refusing unexpected Task Master ID ${JSON.stringify(id)}.`);
    await this.run(["add-dependency", `--id=${externalId}`, `--depends-on=${dependsOnExternalId}`, `--tag=${this.o.tag}`, `--file=${this.o.tasksFile}`]);
  }
}

export function createTaskMasterAdapter(options: TaskMasterAdapterOptions): TaskMasterAdapter {
  return defineTaskAdapter(new TaskMasterAdapter(options));
}
