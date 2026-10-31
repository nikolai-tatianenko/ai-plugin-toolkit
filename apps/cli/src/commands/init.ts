import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_FILENAME,
  LoomError,
  defaultConfig,
  resolveStorageDir,
  slugifyProjectId,
} from "@ai-plugin-toolkit/core";
import { UsageError, type CommandResult } from "../io.js";

export interface InitOptions {
  rootDir: string;
  projectId?: string | undefined;
  name?: string | undefined;
  dryRun: boolean;
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

  // Validates the ID/name through the same schema a config file must satisfy.
  const config = defaultConfig({ id: projectId, name: options.name ?? baseName });
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
