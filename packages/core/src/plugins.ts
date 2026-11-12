import { z } from "zod";
import { LoomError, UnsupportedCapabilityError } from "./errors.js";
import { parseWith } from "./schemas.js";

/**
 * Plugin contracts (implementation plan §2, §8). Core defines the shapes; concrete
 * providers and task adapters live in their own packages and depend on core, never
 * the reverse. In-process plugins are trusted code: capability declarations prevent
 * accidental misuse, they are not a security sandbox.
 */

export const PROVIDER_CAPABILITIES = ["complete", "json-output", "embeddings"] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const TASK_CAPABILITIES = ["readTasks", "createTask", "updateTask", "linkDependency", "readChanges"] as const;
export type TaskCapability = (typeof TASK_CAPABILITIES)[number];

const PluginNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "Plugin name must be a lowercase slug");
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "Version must be semver");

export const ProviderManifestSchema = z.strictObject({
  kind: z.literal("provider"),
  name: PluginNameSchema,
  version: VersionSchema,
  location: z.enum(["local", "remote"]),
  capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)).min(1),
});
export type ProviderManifest = z.infer<typeof ProviderManifestSchema>;

export const TaskAdapterManifestSchema = z.strictObject({
  kind: z.literal("task-adapter"),
  name: PluginNameSchema,
  version: VersionSchema,
  /** Exact upstream tool + version range this adapter was tested against (CL-009). */
  upstream: z.strictObject({ name: z.string().min(1), versionRange: z.string().min(1) }),
  capabilities: z.array(z.enum(TASK_CAPABILITIES)),
});
export type TaskAdapterManifest = z.infer<typeof TaskAdapterManifestSchema>;

// ---- Provider contract -------------------------------------------------------

export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  model: string;
  /** Operator instructions. Kept separate from `messages` so untrusted evidence never lands here. */
  system?: string;
  messages: readonly CompletionMessage[];
  maxOutputTokens?: number;
  /** Ask for JSON output. Requires the `json-output` capability. */
  responseFormat?: "text" | "json";
  /** JSON Schema the output must satisfy when `responseFormat` is `json` (provider-enforced where supported). */
  jsonSchema?: Record<string, unknown>;
}

export interface Usage {
  /** Input tokens billed at the full rate (excludes prompt-cache reads and writes). */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache, when the provider reports any. */
  cacheReadInputTokens?: number;
  /** Input tokens written to the provider's prompt cache, when the provider reports any. */
  cacheWriteInputTokens?: number;
  /** Unknown pricing stays `null`; it is never reported as zero. */
  costUsd: number | null;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: Usage;
  /** Provider stop reason, verbatim (e.g. `end_turn`). */
  stopReason?: string;
}

export const PROVIDER_FAILURE_CATEGORIES = [
  "timeout",
  "rate-limited",
  "overloaded",
  "server-error",
  "network",
  "auth",
  "bad-request",
  "refusal",
  "truncated",
  "invalid-output",
  "cancelled",
  "unknown",
] as const;
export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

/** Categories worth retrying on the same provider. Everything else fails fast (plan §4). */
export const TRANSIENT_FAILURES: ReadonlySet<ProviderFailureCategory> = new Set([
  "timeout",
  "rate-limited",
  "overloaded",
  "server-error",
  "network",
  "truncated",
  "invalid-output",
]);

/** Typed provider failure. `category` decides retry and fallback; messages never contain prompt text or secrets. */
export class ProviderError extends LoomError {
  readonly category: ProviderFailureCategory;
  readonly transient: boolean;

  constructor(category: ProviderFailureCategory, message: string, options?: { cause?: unknown; details?: Record<string, unknown> }) {
    super(category === "timeout" ? "TIMEOUT" : category === "cancelled" ? "CANCELLED" : "PROVIDER_FAILED", message, {
      details: { category, ...options?.details },
      ...(options?.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ProviderError";
    this.category = category;
    this.transient = TRANSIENT_FAILURES.has(category);
  }
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  usage: Usage;
}

export interface ProviderAdapter {
  readonly manifest: ProviderManifest;
  /** Required when the manifest declares `complete`. */
  complete?(request: CompletionRequest, options: { signal: AbortSignal }): Promise<CompletionResult>;
  /** Required when the manifest declares `embeddings`. */
  embed?(texts: readonly string[], options: { signal: AbortSignal; model?: string }): Promise<EmbeddingResult>;
}

// ---- Task adapter contract ---------------------------------------------------

export interface ExternalTask {
  externalId: string;
  title: string;
  description?: string;
  status: "open" | "in-progress" | "closed";
  /** Opaque remote revision marker used for conflict detection. */
  revision: string;
  /** Key stored on the remote record at creation, if the upstream can hold one. */
  idempotencyKey?: string;
  /** External IDs this task depends on, when the upstream reports them. */
  dependsOn?: string[];
}

export interface TaskDraft {
  title: string;
  description?: string;
  /** Stored on the remote record so a retried create can be detected and adopted. */
  idempotencyKey: string;
}

export interface TaskChanges {
  tasks: ExternalTask[];
  checkpoint: string;
}

export interface TaskAdapter {
  readonly manifest: TaskAdapterManifest;
  readTasks?(): Promise<ExternalTask[]>;
  createTask?(draft: TaskDraft): Promise<ExternalTask>;
  updateTask?(
    externalId: string,
    patch: Partial<Pick<ExternalTask, "title" | "description" | "status">>,
    expectedRevision: string,
  ): Promise<ExternalTask>;
  linkDependency?(externalId: string, dependsOnExternalId: string): Promise<void>;
  readChanges?(sinceCheckpoint: string | undefined): Promise<TaskChanges>;
}

type TaskMethods = Required<Pick<TaskAdapter, TaskCapability>>;

/** Validate a provider's manifest and that declared capabilities have implementations. */
export function defineProvider<P extends ProviderAdapter>(provider: P): P {
  const manifest = parseWith(ProviderManifestSchema, provider.manifest, `provider manifest`);
  if (manifest.capabilities.includes("embeddings") && typeof provider.embed !== "function") {
    throw new UnsupportedCapabilityError(manifest.name, "embeddings", "declared but not implemented");
  }
  if (manifest.capabilities.includes("complete") && typeof provider.complete !== "function") {
    throw new UnsupportedCapabilityError(manifest.name, "complete", "declared but not implemented");
  }
  return provider;
}

/** Validate a task adapter's manifest and that every declared capability has a method. */
export function defineTaskAdapter<A extends TaskAdapter>(adapter: A): A {
  const manifest = parseWith(TaskAdapterManifestSchema, adapter.manifest, `task adapter manifest`);
  for (const capability of manifest.capabilities) {
    if (typeof adapter[capability] !== "function") {
      throw new UnsupportedCapabilityError(manifest.name, capability, "declared but not implemented");
    }
  }
  return adapter;
}

export function supportsTaskCapability(adapter: TaskAdapter, capability: TaskCapability): boolean {
  return adapter.manifest.capabilities.includes(capability) && typeof adapter[capability] === "function";
}

/**
 * Return the bound method for a capability, or throw UnsupportedCapabilityError.
 * Callers use this instead of optional chaining so a missing operation can never
 * look like a successful no-op.
 */
export function requireTaskCapability<C extends TaskCapability>(adapter: TaskAdapter, capability: C): TaskMethods[C] {
  if (!supportsTaskCapability(adapter, capability)) {
    throw new UnsupportedCapabilityError(adapter.manifest.name, capability);
  }
  const method = adapter[capability] as (...args: never[]) => unknown;
  return method.bind(adapter) as TaskMethods[C];
}

export function requireProviderCapability(provider: ProviderAdapter, capability: ProviderCapability): void {
  if (!provider.manifest.capabilities.includes(capability)) {
    throw new UnsupportedCapabilityError(provider.manifest.name, capability);
  }
}
