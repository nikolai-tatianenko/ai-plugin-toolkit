import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, LoomError, parseConfigText, resolveStorageDir, type LoomConfig } from "@ai-plugin-toolkit/core";

export interface LoadedConfig {
  rootDir: string;
  configPath: string;
  storageDir: string;
  config: LoomConfig;
}

/**
 * Project root for a command run without `--dir`: the nearest directory at or above
 * `start` that contains loom.config.json (like git finds .git). Falls back to `start`.
 */
export function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

/** Read and validate `<rootDir>/loom.config.json`. */
export async function loadConfigFile(rootDir: string): Promise<LoadedConfig> {
  const root = path.resolve(rootDir);
  const configPath = path.join(root, CONFIG_FILENAME);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LoomError("CONFIG_NOT_FOUND", `No ${CONFIG_FILENAME} in ${root}. Run \`loom init\` first.`, {
        details: { configPath },
      });
    }
    throw cause;
  }
  const config = parseConfigText(text, configPath);
  return { rootDir: root, configPath, storageDir: resolveStorageDir(root, config), config };
}
