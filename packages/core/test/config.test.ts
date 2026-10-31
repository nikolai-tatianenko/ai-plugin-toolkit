import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LoomError,
  defaultConfig,
  parseConfig,
  parseConfigText,
  resolveStorageDir,
  slugifyProjectId,
} from "../src/index.js";

const base = { $schemaVersion: 1, project: { id: "demo", name: "Demo" } };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof LoomError ? error.code : "NOT_LOOM";
  }
  return undefined;
}

describe("parseConfig", () => {
  it("fills defaults", () => {
    const config = defaultConfig({ id: "demo", name: "Demo" });
    expect(config.storage.dir).toBe(".loom");
    expect(config.project.sensitivity).toBe("standard");
    expect(config.providers).toEqual({});
  });

  it("rejects literal API keys (strict provider schema)", () => {
    const raw = { ...base, providers: { claude: { adapter: "anthropic", location: "remote", apiKey: "sk-test" } } };
    expect(codeOf(() => parseConfig(raw))).toBe("CONFIG_INVALID");
  });

  it("rejects routing to an unknown provider", () => {
    const raw = { ...base, routing: { extraction: { providers: ["ghost"] } } };
    expect(() => parseConfig(raw)).toThrow(/Unknown provider "ghost"/);
  });

  it("A19: restricted project cannot route to a remote provider, even as fallback", () => {
    const raw = {
      ...base,
      project: { ...base.project, sensitivity: "restricted" },
      providers: {
        local: { adapter: "ollama", location: "local" },
        cloud: { adapter: "anthropic", location: "remote", apiKeyEnv: "ANTHROPIC_API_KEY" },
      },
      routing: { extraction: { providers: ["local", "cloud"] } },
    };
    expect(() => parseConfig(raw)).toThrow(/Restricted project cannot route "extraction" to remote provider "cloud"/);
    const ok = parseConfig({ ...raw, routing: { extraction: { providers: ["local"] } } });
    expect(ok.routing.extraction?.timeoutMs).toBe(60_000);
    expect(ok.routing.extraction?.maxAttempts).toBe(2);
  });

  it("rejects unknown routing tasks", () => {
    const raw = {
      ...base,
      providers: { p: { adapter: "x", location: "local" } },
      routing: { "do-everything": { providers: ["p"] } },
    };
    expect(codeOf(() => parseConfig(raw))).toBe("CONFIG_INVALID");
  });

  it.each(["../outside", "/etc", "C:\\data", "a/../../b", "."])("A23: rejects storage.dir %s", (dir) => {
    expect(codeOf(() => parseConfig({ ...base, storage: { dir } }))).toBe("CONFIG_INVALID");
  });

  it("reports JSON syntax errors as CONFIG_INVALID", () => {
    expect(codeOf(() => parseConfigText("{ not json"))).toBe("CONFIG_INVALID");
  });
});

describe("resolveStorageDir", () => {
  it("resolves inside the root", () => {
    const config = defaultConfig({ id: "demo", name: "Demo" });
    expect(resolveStorageDir("/work/demo", config)).toBe(path.resolve("/work/demo/.loom"));
  });

  it("re-checks containment for configs that bypassed validation", () => {
    const config = { ...defaultConfig({ id: "demo", name: "Demo" }), storage: { dir: "../../etc" } };
    expect(codeOf(() => resolveStorageDir("/work/demo", config))).toBe("INVALID_PATH");
  });
});

describe("slugifyProjectId", () => {
  it.each([
    ["My Demo App", "my-demo-app"],
    ["Café_Ünïcode", "cafe-unicode"],
    ["---", undefined],
    ["日本語", undefined],
  ])("%s → %s", (input, expected) => {
    expect(slugifyProjectId(input)).toBe(expected);
  });
});
