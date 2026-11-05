#!/usr/bin/env node
// Builds a self-contained `loom` CLI package in dist-release/loom (CL-022): one bundled
// ESM file plus the data files it loads at runtime (topic packs, inspector UI).
// Requires `pnpm build` first. Publishing is a separate, explicitly authorised step.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist-release/loom");
const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = process.env.LOOM_RELEASE_VERSION ?? JSON.parse(readFileSync(path.join(root, "apps/cli/package.json"), "utf8")).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "lib"), { recursive: true });
await build({
  entryPoints: [path.join(root, "apps/cli/dist/main.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: path.join(out, "lib/loom.mjs"),
  // Some bundled CommonJS code calls require(); give ESM output a require.
  banner: { js: "import { createRequire as __loomCreateRequire } from 'node:module'; const require = __loomCreateRequire(import.meta.url);" },
  external: ["node:*", "playwright", "esbuild"],
  legalComments: "linked",
  logLevel: "warning",
});
// Runtime data is loaded relative to the module (`../packs/`, `../ui-dist/`), so it sits next to lib/.
cpSync(path.join(root, "packages/acceptance/packs"), path.join(out, "packs"), { recursive: true });
cpSync(path.join(root, "packages/inspector/ui-dist"), path.join(out, "ui-dist"), { recursive: true });
for (const f of ["README.md", "CHANGELOG.md", "SECURITY.md"]) cpSync(path.join(root, f), path.join(out, f));
try {
  cpSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
} catch {
  // No license chosen yet; release:check reports this as a blocker.
}
writeFileSync(path.join(out, "lib/loom-bin.mjs"), "#!/usr/bin/env node\nimport './loom.mjs';\n", { mode: 0o755 });
writeFileSync(
  path.join(out, "package.json"),
  `${JSON.stringify(
    {
      name: process.env.LOOM_PACKAGE_NAME ?? "context-loom",
      version,
      description: "Traceable project memory, evidence-based acceptance and task sync for AI-assisted delivery (working name).",
      type: "module",
      bin: { loom: "lib/loom-bin.mjs" },
      files: ["lib", "packs", "ui-dist", "README.md", "CHANGELOG.md", "SECURITY.md", "LICENSE"],
      engines: rootPkg.engines,
      license: process.env.LOOM_LICENSE ?? "UNLICENSED",
      private: process.env.LOOM_LICENSE === undefined,
    },
    null,
    2,
  )}\n`,
);
console.log(`Bundled CLI ${version} in ${path.relative(root, out)}`);
