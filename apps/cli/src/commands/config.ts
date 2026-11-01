import path from "node:path";
import { loadConfigFile } from "../config-file.js";
import type { CommandResult } from "../io.js";

export async function configValidateCommand(options: { rootDir: string; cwd: string; env: Readonly<Record<string, string | undefined>> }): Promise<CommandResult> {
  const loaded = await loadConfigFile(options.rootDir);
  const { config } = loaded;
  const providers = Object.entries(config.providers);
  const routes = Object.entries(config.routing).filter(([, policy]) => policy !== undefined);

  const missingCredentials = providers
    .filter(([, provider]) => provider.apiKeyEnv !== undefined && !options.env[provider.apiKeyEnv])
    .map(([name, provider]) => ({ provider: name, env: provider.apiKeyEnv }));

  const relative = path.relative(options.cwd, loaded.configPath);
  const shownPath = relative === "" || relative.startsWith("..") ? loaded.configPath : relative;

  return {
    data: {
      valid: true,
      configPath: loaded.configPath,
      storageDir: loaded.storageDir,
      config,
      warnings: missingCredentials.map((m) => ({
        code: "CREDENTIAL_ENV_UNSET",
        message: `Provider "${m.provider}" expects ${m.env}, which is not set.`,
      })),
    },
    lines: [
      `✓ ${shownPath} is valid`,
      `  project: ${config.project.id} (${config.project.sensitivity})`,
      `  storage: ${loaded.storageDir}`,
      `  providers: ${providers.length === 0 ? "none configured" : providers.map(([n, p]) => `${n} [${p.location}]`).join(", ")}`,
      `  routing: ${routes.length === 0 ? "none configured" : routes.map(([task, p]) => `${task} → ${p!.providers.join(" > ")}`).join("; ")}`,
      ...missingCredentials.map((m) => `  ! ${m.provider}: environment variable ${m.env} is not set`),
    ],
  };
}
