import { getChecklist } from "@ai-plugin-toolkit/workspace";
import { activePackId, loadBuiltinPack, loadPackFile, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { createBeadsAdapter } from "@ai-plugin-toolkit/adapter-beads";
import { createTaskMasterAdapter } from "@ai-plugin-toolkit/adapter-taskmaster";
import type { TaskAdapter } from "@ai-plugin-toolkit/core";
import { LoomError, resolveProjectPath, type ProviderConfig } from "@ai-plugin-toolkit/core";
import { createAnthropicProvider } from "@ai-plugin-toolkit/provider-anthropic";
import { createOllamaProvider } from "@ai-plugin-toolkit/provider-ollama";
import { Router, fixtureProviderFactory, hashingEmbedderFactory, type ProviderFactory } from "@ai-plugin-toolkit/router";
import { permissionsRevision } from "@ai-plugin-toolkit/retrieval";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import { loadConfigFile, type LoadedConfig } from "./config-file.js";

/** A task adapter plus the lifecycle helpers every supported upstream provides. */
export type ManagedTaskAdapter = TaskAdapter & { checkVersion(): Promise<string>; initialize(): Promise<"created" | "existing"> };

export interface ProjectContext {
  loaded: LoadedConfig;
  projectId: string;
  store: LoomStore;
  actor: string;
  env: Readonly<Record<string, string | undefined>>;
  router(): Router;
  /** Embedding function through routing.embedding, or undefined when no policy is configured. */
  embedder(): { embed: (texts: readonly string[]) => Promise<{ vectors: number[][]; model: string }>; model: string } | undefined;
  /** Hash of the access-relevant configuration, used in cache keys. */
  permissions: string;
  taskAdapter(): ManagedTaskAdapter;
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

const ollamaFactory: ProviderFactory = ({ config }) =>
  createOllamaProvider({
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.model === undefined ? {} : { model: config.model }),
    ...(config.embeddingModel === undefined ? {} : { embeddingModel: config.embeddingModel }),
  });

export const PROVIDER_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  anthropic: anthropicFactory,
  fixture: fixtureProviderFactory,
  ollama: ollamaFactory,
  hashing: hashingEmbedderFactory,
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
  // Built-in packs load from the package; custom packs from the project file recorded at activation.
  const loadActivated = async (activation: { packId: string; source: string }): Promise<TopicPack> => {
    if (activation.source === "workspace") return getChecklist(store, projectId, activation.packId).value.pack;
    if (activation.source === "builtin") return loadBuiltinPack(activation.packId);
    const pack = await loadPackFile(resolveProjectPath(loaded.rootDir, activation.source, "pack file"));
    if (pack.id !== activation.packId) throw new LoomError("CONFIG_INVALID", `${activation.source} now defines pack "${pack.id}", but "${activation.packId}" was activated from it.`);
    return pack;
  };
  let router: Router | undefined;
  let adapter: ManagedTaskAdapter | undefined;
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
    permissions: permissionsRevision(loaded.config),
    embedder() {
      const policy = loaded.config.routing.embedding;
      if (policy === undefined) return undefined;
      const primary = loaded.config.providers[policy.providers[0]!];
      const model = primary?.embeddingModel ?? primary?.model ?? primary?.adapter ?? "unknown";
      const r = ctx.router();
      return {
        model: `${primary?.adapter ?? "?"}:${model}`,
        embed: async (texts) => {
          const routed = await r.embed("embedding", texts);
          return { vectors: routed.value, model: routed.model };
        },
      };
    },
    taskAdapter() {
      const tasks = loaded.config.tasks;
      if (tasks === undefined) {
        throw new LoomError("CONFIG_INVALID", 'No task adapter configured. Add "tasks": {"adapter": "beads"} to loom.config.json (see docs/quickstart.md).');
      }
      const env = { ...process.env, ...io.env };
      adapter ??=
        tasks.adapter === "taskmaster"
          ? createTaskMasterAdapter({
              command: tasks.taskmaster.command,
              projectDir: tasks.taskmaster.dir === "." ? loaded.rootDir : resolveProjectPath(loaded.rootDir, tasks.taskmaster.dir, "tasks.taskmaster.dir"),
              tag: tasks.taskmaster.tag,
              env,
              allowUntestedVersion: io.env.LOOM_TASKMASTER_ALLOW_UNTESTED === "1",
            })
          : createBeadsAdapter({
              command: tasks.beads.command,
              beadsDir: resolveProjectPath(loaded.rootDir, tasks.beads.dir, "tasks.beads.dir"),
              cwd: loaded.rootDir,
              env,
              actor,
              allowUntestedVersion: io.env.LOOM_BEADS_ALLOW_UNTESTED === "1",
            });
      return adapter;
    },
    async pack(requested) {
      const id = activePackId(store, projectId, requested);
      return loadActivated(store.acceptance.activePacks(projectId).find((p) => p.packId === id)!);
    },
    async activePacks() {
      return Promise.all(store.acceptance.activePacks(projectId).map(loadActivated));
    },
  };
  try {
    store.ensureProject(projectId, loaded.config.project.name);
    return await fn(ctx);
  } finally {
    store.close();
  }
}
