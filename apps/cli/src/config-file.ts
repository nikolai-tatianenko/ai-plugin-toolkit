import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILENAME, LoomError, parseConfigText, resolveStorageDir, type LoomConfig } from "@ai-plugin-toolkit/core";

export interface LoadedConfig {
  rootDir: string;
  configPath: string;
  storageDir: string;
  config: LoomConfig;
}

/** Read and validate `<rootDir>/loom.config.json`. No upward directory search: the root is explicit. */
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
