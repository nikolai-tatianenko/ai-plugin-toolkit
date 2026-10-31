#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on load. It is expected (see docs/adr/0003)
// and is noise for CLI users, so only that one warning is filtered; all others still print.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

// Dynamic import so the filter above is installed before node:sqlite is loaded.
const { run } = await import("./run.js");

const exitCode = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = exitCode;
