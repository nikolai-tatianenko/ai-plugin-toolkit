// Bundles the React UI into ui-dist/. Type-checks it first (esbuild does not).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsc = path.resolve(here, "../../node_modules/typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", path.join(here, "ui/tsconfig.json")], { stdio: "inherit" });
mkdirSync(path.join(here, "ui-dist"), { recursive: true });
await build({
  entryPoints: [path.join(here, "ui/main.tsx")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(here, "ui-dist/inspector.js"),
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});
for (const f of ["index.html", "styles.css"]) copyFileSync(path.join(here, "ui", f), path.join(here, "ui-dist", f));
