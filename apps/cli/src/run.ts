import path from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "@ai-plugin-toolkit/core";
import { configValidateCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { EXIT, UsageError, writeFailure, writeSuccess, type CliIo, type CommandResult, type ExitCode } from "./io.js";

export { EXIT, type CliIo, type ExitCode } from "./io.js";

export const HELP = `loom ${VERSION} — Context Loom (working name), planning-stage toolkit

Usage: loom <command> [options]

Commands:
  init                 Create loom.config.json and a local storage directory
  config validate      Validate loom.config.json and report its settings
  help                 Show this help
  version              Print the version

Global options:
  --dir <path>         Project directory (default: current directory)
  --json               Machine-readable output on stdout
  -h, --help           Show help
  -v, --version        Print the version

init options:
  --project-id <id>    Lowercase project ID (default: derived from the directory name)
  --name <name>        Display name (default: directory name)
  --dry-run            Report what would be created without writing anything

Exit codes: 0 success, 1 operation failed, 2 usage error, 70 internal error.
`;

const OPTIONS = {
  dir: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
  "project-id": { type: "string" },
  name: { type: "string" },
  "dry-run": { type: "boolean", default: false },
} as const;

type OptionName = keyof typeof OPTIONS;
const GLOBAL_OPTIONS: readonly OptionName[] = ["dir", "json", "help", "version"];

function rejectUnsupported(command: string, values: Record<string, unknown>, allowed: readonly OptionName[]): void {
  for (const [name, value] of Object.entries(values)) {
    const isSet = value !== undefined && value !== false;
    if (isSet && !GLOBAL_OPTIONS.includes(name as OptionName) && !allowed.includes(name as OptionName)) {
      throw new UsageError(`Option --${name} is not supported by \`${command}\`.`);
    }
  }
}

export async function run(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let json = argv.includes("--json");
  let command = "loom";
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (cause) {
      throw new UsageError((cause as Error).message);
    }
    const { values, positionals } = parsed;
    json = values.json;

    if (values.version || positionals[0] === "version") {
      return writeSuccess(io, { json }, "version", { data: { version: VERSION }, lines: [VERSION] });
    }
    if (values.help || positionals.length === 0 || positionals[0] === "help") {
      io.stdout(HELP);
      return EXIT.ok;
    }

    const rootDir = path.resolve(io.cwd, values.dir ?? ".");
    command = positionals.slice(0, 2).join(" ");
    let result: CommandResult;

    switch (positionals[0]) {
      case "init": {
        command = "init";
        if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${positionals[1]}`);
        rejectUnsupported(command, values, ["project-id", "name", "dry-run"]);
        result = await initCommand({
          rootDir,
          projectId: values["project-id"],
          name: values.name,
          dryRun: values["dry-run"],
        });
        break;
      }
      case "config": {
        if (positionals[1] !== "validate" || positionals.length > 2) {
          throw new UsageError("Usage: loom config validate [--dir <path>] [--json]");
        }
        rejectUnsupported(command, values, []);
        result = await configValidateCommand({ rootDir, cwd: io.cwd, env: io.env });
        break;
      }
      default:
        command = positionals[0] ?? "loom";
        throw new UsageError(`Unknown command: ${positionals[0]}`);
    }
    return writeSuccess(io, { json }, command, result);
  } catch (error) {
    return writeFailure(io, { json }, command, error);
  }
}
