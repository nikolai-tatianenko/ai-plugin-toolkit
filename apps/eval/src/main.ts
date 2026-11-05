#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on load; filter only that one (see docs/adr/0003).
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

const { parseArgs } = await import("node:util");
const { writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { runEvaluation, renderReport } = await import("./harness.js");

const { values } = parseArgs({
  options: {
    dataset: { type: "string", default: "eval/datasets/extraction-v1" },
    provider: { type: "string", default: "fixture" },
    model: { type: "string" },
    out: { type: "string" },
    json: { type: "boolean", default: false },
  },
});
if (values.provider !== "fixture" && values.provider !== "anthropic") {
  process.stderr.write("--provider must be fixture or anthropic\n");
  process.exit(2);
}
const apiKey = process.env.ANTHROPIC_API_KEY;
if (values.provider === "anthropic" && !apiKey) {
  process.stderr.write("SKIPPED: --provider anthropic needs ANTHROPIC_API_KEY. No live evaluation was run.\n");
  process.exit(3);
}
const report = await runEvaluation({
  datasetDir: path.resolve(values.dataset),
  provider: values.provider,
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(values.model === undefined ? {} : { model: values.model }),
});
const text = values.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report);
if (values.out) await writeFile(values.out, text);
else process.stdout.write(text);
process.exitCode = report.cases.some((c) => c.error !== undefined) ? 1 : 0;
