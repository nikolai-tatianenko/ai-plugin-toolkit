import { describe, expect, it } from "vitest";
import { contentHash, isIdOf, newId, stableId } from "../src/index.js";

describe("stableId", () => {
  it("is deterministic for the same parts", () => {
    expect(stableId("source", "demo", "abc")).toBe(stableId("source", "demo", "abc"));
  });

  it("does not collide when part boundaries shift", () => {
    expect(stableId("source", "ab", "c")).not.toBe(stableId("source", "a", "bc"));
  });

  it("is scoped by entity kind", () => {
    expect(stableId("source", "x").slice(4)).not.toBe(stableId("fact", "x").slice(4));
  });

  it("produces IDs recognised by isIdOf", () => {
    const id = stableId("fact", "p", "statement");
    expect(id).toMatch(/^fct_[0-9a-f]{26}$/);
    expect(isIdOf("fact", id)).toBe(true);
    expect(isIdOf("source", id)).toBe(false);
  });

  it("rejects an empty part list", () => {
    expect(() => stableId("source")).toThrow(/at least one part/);
  });
});

describe("newId", () => {
  it("is unique and time-sortable", () => {
    const a = newId("auditEvent", 1_700_000_000_000);
    const b = newId("auditEvent", 1_700_000_000_001);
    expect(a).not.toBe(newId("auditEvent", 1_700_000_000_000));
    expect(a < b).toBe(true);
    expect(isIdOf("auditEvent", a)).toBe(true);
  });

  it("rejects invalid timestamps", () => {
    expect(() => newId("job", -1)).toThrow();
    expect(() => newId("job", 2 ** 48)).toThrow();
  });
});

describe("contentHash", () => {
  it("hashes text and equivalent bytes identically", () => {
    expect(contentHash("hello")).toBe(contentHash(new TextEncoder().encode("hello")));
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});
