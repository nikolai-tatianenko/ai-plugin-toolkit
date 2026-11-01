import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets, redactString } from "../src/index.js";

describe("redaction", () => {
  it("redacts secret-named keys but keeps env-var references", () => {
    const out = redactSecrets({ apiKey: "abc", nested: { password: "p", apiKeyEnv: "ANTHROPIC_API_KEY" } });
    expect(out).toEqual({ apiKey: REDACTED, nested: { password: REDACTED, apiKeyEnv: "ANTHROPIC_API_KEY" } });
  });

  it("redacts key-shaped values in free text", () => {
    const text = redactString("failed with sk-ant-api03-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(text).not.toMatch(/sk-ant|ghp_/);
    expect(text.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it("handles arrays and cycles without mutating input", () => {
    const input: Record<string, unknown> = { list: ["Bearer abcdefghijklmnopqrstuvwxyz"], token: "t" };
    input.self = input;
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.self).toBe("[Circular]");
    expect(out.list).toEqual([REDACTED]);
    expect(input.token).toBe("t");
  });
});
