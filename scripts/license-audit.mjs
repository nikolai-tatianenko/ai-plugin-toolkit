#!/usr/bin/env node
// Dependency license audit (CL-022): every production dependency must have a license on
// the allowlist. Unknown or other licenses fail the audit and need a human decision.
import { execFileSync } from "node:child_process";

export const ALLOWED = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0"]);

export function audit() {
  const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const byLicense = JSON.parse(raw);
  const packages = [];
  const problems = [];
  for (const [license, list] of Object.entries(byLicense)) {
    for (const pkg of list) {
      for (const version of pkg.versions ?? [pkg.version]) packages.push({ name: pkg.name, version, license });
      // SPDX expressions like "(MIT OR Apache-2.0)" pass if any alternative is allowed.
      const options = license.replace(/[()]/g, "").split(/\s+OR\s+/);
      if (!options.some((l) => ALLOWED.has(l.trim()))) problems.push({ name: pkg.name, license });
    }
  }
  return { packages, problems, licenses: Object.fromEntries(Object.entries(byLicense).map(([l, v]) => [l, v.length])) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = audit();
  console.log(`Production dependencies: ${result.packages.length}`);
  for (const [l, n] of Object.entries(result.licenses)) console.log(`  ${l}: ${n}`);
  if (result.problems.length > 0) {
    console.error("Not on the allowlist (needs review):");
    for (const p of result.problems) console.error(`  ${p.name}: ${p.license}`);
    process.exit(1);
  }
  console.log("All production dependency licenses are on the allowlist.");
}
