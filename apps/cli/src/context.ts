import { activePackId, loadBuiltinPack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { createBeadsAdapter, type BeadsAdapter } from "@ai-plugin-toolkit/adapter-beads";
import { LoomError, resolveProjectPath, type ProviderConfig } from "@ai-plugin-toolkit/core";
import { createAnthropicProvider } from "@ai-plugin-toolkit/provider-anthropic";
import { Router, fixtureProviderFactory, type ProviderFactory } from "@ai-plugin-toolkit/router";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { loadConfigFile, type LoadedConfig } from "./config-file.js";

export interface ProjectContext {
  loaded: LoadedConfig;
  projectId: string;
  store: LoomStore;
  actor: string;
  env: Readonly<Record<string, string | undefined>>;
  router(): Router;
  taskAdapter(): BeadsAdapter;
  pack(requested?: string): Promise<TopicPack>;
  activePacks(): Promise<TopicPack[]>;
}

const anthropicFactory: ProviderFactory = ({ name, config, apiKey }: { name: string; config: ProviderConfig; apiKey: string | undefined }) => {
  if (apiKey === undefined) {
    throw new LoomError("CREDENTIALS_MISSING", `Provider "${name}" (anthropic) needs "apiKeyEnv" naming the environment variable that holds the key.`);
  }
  return createAnthropicProvider({
    apiKey,
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.baseUrl === undefined ? {} : { baseURL: config.baseUrl }),
  });
};

export const PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  anthropic: anthropicFactory,
  fixture: fixtureProviderFactory,
};

export async function withProject<T>(
  rootDir: string,
  io: { env: Readonly<Record<string, string | undefined>> },
  fn: (ctx: ProjectContext) => Promise<T>,
): Promise<T> {
  const loaded = await loadConfigFile(rootDir);
  const store = await LoomStore.open({ storageDir: loaded.storageDir });
  const projectId = loaded.config.project.id;
  const actor = io.env.LOOM_ACTOR ?? io.env.USER ?? "cli";
  let router: Router | undefined;
  let adapter: BeadsAdapter | undefined;
  const ctx: ProjectContext = {
    loaded,
    projectId,
    store,
    actor,
    env: io.env,
    router() {
      router ??= new Router({
        config: loaded.config,
        env: io.env,
        rootDir: loaded.rootDir,
        factories: PROVIDER_FACTORIES,
        // Traces are metadata only (no prompt or response text), persisted for STATUS and audits.
        onTrace: (trace) => store.routing.insert(projectId, trace),
      });
      return router;
    },
    taskAdapter() {
      const tasks = loaded.config.tasks;
      if (tasks === undefined) {
        throw new LoomError("CONFIG_INVALID", 'No task adapter configured. Add "tasks": {"adapter": "beads"} to loom.config.json (see docs/quickstart.md).');
      }
      adapter ??= createBeadsAdapter({
        command: tasks.beads.command,
        beadsDir: resolveProjectPath(loaded.rootDir, tasks.beads.dir, "tasks.beads.dir"),
        cwd: loaded.rootDir,
        env: { ...process.env, ...io.env },
        actor,
        allowUntestedVersion: io.env.LOOM_BEADS_ALLOW_UNTESTED === "1",
      });
      return adapter;
    },
    async pack(requested) {
      return loadBuiltinPack(activePackId(store, projectId, requested));
    },
    async activePacks() {
      return Promise.all(store.acceptance.activePacks(projectId).map((p) => loadBuiltinPack(p.packId)));
    },
  };
  try {
    store.ensureProject(projectId, loaded.config.project.name);
    return await fn(ctx);
  } finally {
    store.close();
  }
}
