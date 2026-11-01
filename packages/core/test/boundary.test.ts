import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * CL-001 acceptance: core imports no provider, storage, or task-adapter implementation.
 * Enforced as an allowlist so new dependencies require a deliberate change here.
 */
const ALLOWED_EXTERNAL = new Set(["zod", "node:crypto", "node:path"]);

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(coreRoot, "src");

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers: string[] = [];
  for (const match of text.matchAll(/(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.push((match[1] ?? match[2])!);
  }
  return specifiers;
}

describe("core dependency boundary", () => {
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(srcDir, f));

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((f) => [path.relative(coreRoot, f), f]))("%s imports only allowed modules", (_name, file) => {
    const external = importsOf(file).filter((s) => !s.startsWith("."));
    expect(external.filter((s) => !ALLOWED_EXTERNAL.has(s))).toEqual([]);
  });

  it("declares only allowed runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(coreRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["zod"]);
  });
});
