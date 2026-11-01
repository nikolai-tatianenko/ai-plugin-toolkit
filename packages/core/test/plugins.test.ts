import { describe, expect, it } from "vitest";
import {
  LoomError,
  UnsupportedCapabilityError,
  defineProvider,
  defineTaskAdapter,
  requireProviderCapability,
  requireTaskCapability,
  type TaskAdapter,
} from "../src/index.js";

const readOnlyAdapter = (): TaskAdapter => ({
  manifest: {
    kind: "task-adapter",
    name: "read-only",
    version: "0.1.0",
    upstream: { name: "example", versionRange: ">=1.0.0 <2" },
    capabilities: ["readTasks"],
  },
  readTasks: async () => [{ externalId: "1", title: "T", status: "open", revision: "r1" }],
});

describe("task adapter contract", () => {
  it("returns a bound method for a declared capability", async () => {
    const adapter = defineTaskAdapter(readOnlyAdapter());
    const readTasks = requireTaskCapability(adapter, "readTasks");
    await expect(readTasks()).resolves.toHaveLength(1);
  });

  it("A22: an undeclared operation fails explicitly instead of no-op success", () => {
    const adapter = defineTaskAdapter(readOnlyAdapter());
    expect(() => requireTaskCapability(adapter, "createTask")).toThrow(UnsupportedCapabilityError);
  });

  it("does not allow an implemented-but-undeclared method to be called", () => {
    const adapter = defineTaskAdapter({
      ...readOnlyAdapter(),
      createTask: async () => ({ externalId: "2", title: "x", status: "open", revision: "r" }),
    });
    expect(() => requireTaskCapability(adapter, "createTask")).toThrow(/does not support "createTask"/);
  });

  it("rejects a manifest that declares a capability without implementing it", () => {
    const adapter = readOnlyAdapter();
    expect(() =>
      defineTaskAdapter({ ...adapter, manifest: { ...adapter.manifest, capabilities: ["readTasks", "updateTask"] } }),
    ).toThrow(/declared but not implemented/);
  });

  it("validates manifest fields", () => {
    const adapter = readOnlyAdapter();
    expect(() => defineTaskAdapter({ ...adapter, manifest: { ...adapter.manifest, version: "latest" } })).toThrow(
      LoomError,
    );
  });
});

describe("provider contract", () => {
  const provider = {
    manifest: { kind: "provider", name: "fixture", version: "0.1.0", location: "local", capabilities: ["complete"] },
    complete: async () => ({ text: "ok", model: "m", usage: { inputTokens: 1, outputTokens: 1, costUsd: null } }),
  } as const;

  it("accepts a valid provider and keeps unknown cost as null", async () => {
    const defined = defineProvider({ ...provider, manifest: { ...provider.manifest, capabilities: ["complete"] } });
    const result = await defined.complete({ model: "m", messages: [] }, { signal: new AbortController().signal });
    expect(result.usage.costUsd).toBeNull();
  });

  it("requires embed() when embeddings are declared", () => {
    expect(() =>
      defineProvider({ ...provider, manifest: { ...provider.manifest, capabilities: ["complete", "embeddings"] } }),
    ).toThrow(UnsupportedCapabilityError);
  });

  it("refuses an undeclared provider capability", () => {
    const defined = defineProvider({ ...provider, manifest: { ...provider.manifest, capabilities: ["complete"] } });
    expect(() => requireProviderCapability(defined, "json-output")).toThrow(UnsupportedCapabilityError);
  });
});
