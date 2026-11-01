import path from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "@ai-plugin-toolkit/core";
import {
  answerCommand,
  assessCommand,
  criteriaListCommand,
  dispositionCommand,
  evidenceAddCommand,
  questionsCommand,
  reportCommand,
  revisionCommand,
} from "./commands/acceptance.js";
import { configValidateCommand } from "./commands/config.js";
import { ingestCommand } from "./commands/ingest.js";
import { initCommand } from "./commands/init.js";
import {
  contextCommand,
  extractCommand,
  memoryListCommand,
  memoryReviewCommand,
  memoryShowCommand,
  requireNumber,
  searchCommand,
} from "./commands/memory.js";
import { generateCommand, tasksInitCommand, tasksListCommand, tasksPreviewCommand, tasksSyncCommand } from "./commands/output.js";
import { sourcesListCommand, sourcesShowCommand } from "./commands/sources.js";
import { EXIT, UsageError, writeFailure, writeSuccess, type CliIo, type CommandResult, type ExitCode } from "./io.js";

export { EXIT, type CliIo, type ExitCode } from "./io.js";

export const HELP = `loom ${VERSION} — Context Loom (working name)

Usage: loom <command> [options]

Project
  init                       Create loom.config.json and a git-ignored storage directory
  config validate            Validate loom.config.json and report its settings

Evidence and memory
  ingest <file...>           Store files as source evidence (.json conversation, .md, .txt, .log)
  sources list | show <id>   List sources / show one with its original text
  extract                    Extract source-linked facts and decisions (uses routing.extraction)
  memory list                List facts and decisions (--kind facts|decisions|rejected, --all)
  memory show <id>           Show a fact or decision with the exact evidence it cites
  memory confirm|reject <id> Review an extracted fact
  search <words...>          Search project memory (current records; --all for history)
  context <words...>         Assemble a bounded, cited context (--max-chars)

Artifacts
  generate [types...]        Write FACTS, VISION, PLAN, STATUS, ACCEPTANCE and decision records

Acceptance
  assess --pack <id>         Activate a topic pack (built-in: mobile-release) and summarize
  questions                  What to answer next (--mode quick|guided|challenge)
  answer <question> <value>  Record a stated answer
  criteria list              Applicability, verification and disposition of every criterion
  evidence add <criterion>   Attach evidence (--result, --env, --revision, --description, --ref)
  waive <criterion>          Waive with --reason (recorded with actor; never shown as passed)
  accept | reopen <criterion> Record or clear human acceptance
  revision set <rev> | show  Current source/build revision (older evidence becomes stale)
  report                     Readiness report (--require-ready exits 1 when not ready)

Tasks
  tasks init                 Create the Beads database configured in tasks.beads.dir
  tasks preview              Show the task change set; writes nothing
  tasks sync                 Publish the change set (requires tasks.allowWrites: true)
  tasks list                 Local tasks and their external IDs

Global options
  --dir <path>   Project directory (default: current directory)
  --json         Machine-readable output on stdout
  -h, --help     Show help;  -v, --version  Print the version

Command options
  init:      --project-id <id> --name <name> --dry-run --provider anthropic|fixture --fixture <path>
             --tasks beads --allow-task-writes
  ingest:    --type <conversation|document|tool-output> --title <title> --dry-run
  extract:   --source <id> --force
  generate:  --force (replace hand-edited generated sections) --dry-run
  questions: --mode <mode> --limit <n> --pack <id>

Environment: LOOM_ACTOR (actor name for audit records), ANTHROPIC_API_KEY (when configured),
LOOM_BEADS_ALLOW_UNTESTED=1 (allow an unreviewed bd version), LOOM_DEBUG=1 (stack traces).
Exit codes: 0 success, 1 operation failed or not ready, 2 usage error, 70 internal error.
`;

const OPTIONS = {
  dir: { type: "string" },
  json: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
  "project-id": { type: "string" },
  name: { type: "string" },
  "dry-run": { type: "boolean", default: false },
  type: { type: "string" },
  title: { type: "string" },
  limit: { type: "string" },
  provider: { type: "string" },
  fixture: { type: "string" },
  tasks: { type: "string" },
  "allow-task-writes": { type: "boolean", default: false },
  source: { type: "string" },
  force: { type: "boolean", default: false },
  kind: { type: "string" },
  all: { type: "boolean", default: false },
  "max-chars": { type: "string" },
  pack: { type: "string" },
  mode: { type: "string" },
  note: { type: "string" },
  result: { type: "string" },
  revision: { type: "string" },
  env: { type: "string" },
  description: { type: "string" },
  ref: { type: "string" },
  reason: { type: "string" },
  "require-ready": { type: "boolean", default: false },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = { [K in OptionName]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };
const GLOBAL_OPTIONS: readonly OptionName[] = ["dir", "json", "help", "version"];

interface Invocation {
  rootDir: string;
  cwd: string;
  env: CliIo["env"];
  args: string[];
  values: Values;
  actor: string;
}
interface Outcome {
  result: CommandResult;
  exit?: ExitCode;
}
interface Command {
  /** Positional words that name the command, e.g. ["memory", "show"]. */
  words: string[];
  /** Number of extra positional arguments: exact number, or [min, max]. */
  args: number | [number, number];
  options: OptionName[];
  usage: string;
  run: (inv: Invocation) => Promise<Outcome>;
}

const ok = async (result: Promise<CommandResult>): Promise<Outcome> => ({ result: await result });
const base = (inv: Invocation) => ({ rootDir: inv.rootDir, env: inv.env });

const COMMANDS: Command[] = [
  {
    words: ["init"],
    args: 0,
    options: ["project-id", "name", "dry-run", "provider", "fixture", "tasks", "allow-task-writes"],
    usage: "loom init [--project-id <id>] [--name <name>] [--provider anthropic|fixture] [--tasks beads]",
    run: (inv) =>
      ok(
        initCommand({
          rootDir: inv.rootDir,
          projectId: inv.values["project-id"],
          name: inv.values.name,
          dryRun: inv.values["dry-run"] === true,
          provider: inv.values.provider,
          fixture: inv.values.fixture,
          tasks: inv.values.tasks,
          allowTaskWrites: inv.values["allow-task-writes"] === true,
        }),
      ),
  },
  { words: ["config", "validate"], args: 0, options: [], usage: "loom config validate", run: (inv) => ok(configValidateCommand({ rootDir: inv.rootDir, cwd: inv.cwd, env: inv.env })) },
  {
    words: ["ingest"],
    args: [1, 10_000],
    options: ["type", "title", "dry-run"],
    usage: "loom ingest <file...> [--type <type>] [--title <title>]",
    run: (inv) =>
      ok(ingestCommand({ rootDir: inv.rootDir, cwd: inv.cwd, files: inv.args, type: inv.values.type, title: inv.values.title, dryRun: inv.values["dry-run"] === true, actor: inv.actor })),
  },
  {
    words: ["sources", "list"],
    args: 0,
    options: ["limit"],
    usage: "loom sources list [--limit <n>]",
    run: (inv) => ok(sourcesListCommand({ rootDir: inv.rootDir, limit: requireNumber(inv.values.limit, "limit", 100, 1, 10_000) })),
  },
  { words: ["sources", "show"], args: 1, options: [], usage: "loom sources show <id>", run: (inv) => ok(sourcesShowCommand({ rootDir: inv.rootDir, id: inv.args[0]! })) },
  {
    words: ["extract"],
    args: 0,
    options: ["source", "force"],
    usage: "loom extract [--source <id>] [--force]",
    run: (inv) => ok(extractCommand({ ...base(inv), source: inv.values.source, force: inv.values.force === true })),
  },
  {
    words: ["memory", "list"],
    args: 0,
    options: ["kind", "all"],
    usage: "loom memory list [--kind facts|decisions|rejected] [--all]",
    run: (inv) => ok(memoryListCommand({ ...base(inv), kind: inv.values.kind, all: inv.values.all === true })),
  },
  { words: ["memory", "show"], args: 1, options: [], usage: "loom memory show <id>", run: (inv) => ok(memoryShowCommand({ ...base(inv), id: inv.args[0]! })) },
  { words: ["memory", "confirm"], args: 1, options: [], usage: "loom memory confirm <fact-id>", run: (inv) => ok(memoryReviewCommand({ ...base(inv), id: inv.args[0]!, status: "confirmed" })) },
  { words: ["memory", "reject"], args: 1, options: [], usage: "loom memory reject <fact-id>", run: (inv) => ok(memoryReviewCommand({ ...base(inv), id: inv.args[0]!, status: "rejected" })) },
  {
    words: ["search"],
    args: [1, 100],
    options: ["all", "limit"],
    usage: "loom search <words...> [--all] [--limit <n>]",
    run: (inv) => ok(searchCommand({ ...base(inv), query: inv.args.join(" "), all: inv.values.all === true, limit: requireNumber(inv.values.limit, "limit", 20, 1, 200) })),
  },
  {
    words: ["context"],
    args: [1, 100],
    options: ["max-chars"],
    usage: "loom context <words...> [--max-chars <n>]",
    run: (inv) => ok(contextCommand({ ...base(inv), query: inv.args.join(" "), maxChars: requireNumber(inv.values["max-chars"], "max-chars", 8_000, 200, 1_000_000) })),
  },
  {
    words: ["generate"],
    args: [0, 10],
    options: ["force", "dry-run"],
    usage: "loom generate [facts|vision|plan|status|acceptance|decisions ...] [--force] [--dry-run]",
    run: async (inv) => {
      const result = await generateCommand({ ...base(inv), types: inv.args, force: inv.values.force === true, dryRun: inv.values["dry-run"] === true });
      return { result, ...(Number(result.data.conflicts) > 0 ? { exit: EXIT.failure } : {}) };
    },
  },
  { words: ["assess"], args: 0, options: ["pack"], usage: "loom assess --pack <id>", run: (inv) => ok(assessCommand({ ...base(inv), pack: inv.values.pack })) },
  {
    words: ["questions"],
    args: 0,
    options: ["mode", "limit", "pack"],
    usage: "loom questions [--mode quick|guided|challenge] [--limit <n>]",
    run: (inv) => ok(questionsCommand({ ...base(inv), pack: inv.values.pack, mode: inv.values.mode, limit: requireNumber(inv.values.limit, "limit", 10, 1, 100) })),
  },
  {
    words: ["answer"],
    args: [2, 100],
    options: ["pack", "note"],
    usage: "loom answer <question-id> <value>",
    run: (inv) => ok(answerCommand({ ...base(inv), pack: inv.values.pack, question: inv.args[0]!, value: inv.args.slice(1).join(" "), note: inv.values.note })),
  },
  { words: ["criteria", "list"], args: 0, options: ["pack"], usage: "loom criteria list", run: (inv) => ok(criteriaListCommand({ ...base(inv), pack: inv.values.pack })) },
  {
    words: ["evidence", "add"],
    args: 1,
    options: ["pack", "result", "revision", "env", "description", "ref"],
    usage: "loom evidence add <criterion> --result <r> --env <kind> [--revision <rev>]",
    run: (inv) =>
      ok(
        evidenceAddCommand({
          ...base(inv),
          pack: inv.values.pack,
          criterion: inv.args[0]!,
          result: inv.values.result,
          revision: inv.values.revision,
          environment: inv.values.env,
          description: inv.values.description,
          ref: inv.values.ref,
        }),
      ),
  },
  {
    words: ["waive"],
    args: 1,
    options: ["pack", "reason"],
    usage: "loom waive <criterion> --reason <text>",
    run: (inv) => ok(dispositionCommand({ ...base(inv), pack: inv.values.pack, action: "waive", criterion: inv.args[0]!, reason: inv.values.reason })),
  },
  {
    words: ["accept"],
    args: 1,
    options: ["pack", "note"],
    usage: "loom accept <criterion> [--note <text>]",
    run: (inv) => ok(dispositionCommand({ ...base(inv), pack: inv.values.pack, action: "accept", criterion: inv.args[0]!, note: inv.values.note })),
  },
  { words: ["reopen"], args: 1, options: ["pack"], usage: "loom reopen <criterion>", run: (inv) => ok(dispositionCommand({ ...base(inv), pack: inv.values.pack, action: "reopen", criterion: inv.args[0]! })) },
  { words: ["revision", "set"], args: 1, options: [], usage: "loom revision set <rev>", run: (inv) => ok(revisionCommand({ ...base(inv), value: inv.args[0]! })) },
  { words: ["revision", "show"], args: 0, options: [], usage: "loom revision show", run: (inv) => ok(revisionCommand(base(inv))) },
  {
    words: ["report"],
    args: 0,
    options: ["pack", "require-ready"],
    usage: "loom report [--require-ready]",
    run: async (inv) => {
      const { result, ready } = await reportCommand({ ...base(inv), pack: inv.values.pack, requireReady: inv.values["require-ready"] === true });
      return { result, ...(inv.values["require-ready"] && !ready ? { exit: EXIT.failure } : {}) };
    },
  },
  { words: ["tasks", "init"], args: 0, options: [], usage: "loom tasks init", run: (inv) => ok(tasksInitCommand(base(inv))) },
  { words: ["tasks", "preview"], args: 0, options: [], usage: "loom tasks preview", run: (inv) => ok(tasksPreviewCommand(base(inv))) },
  {
    words: ["tasks", "sync"],
    args: 0,
    options: [],
    usage: "loom tasks sync",
    run: async (inv) => {
      const { result, ok: synced } = await tasksSyncCommand(base(inv));
      return { result, ...(synced ? {} : { exit: EXIT.failure }) };
    },
  },
  { words: ["tasks", "list"], args: 0, options: [], usage: "loom tasks list", run: (inv) => ok(tasksListCommand(base(inv))) },
];

function rejectUnsupported(command: Command, values: Values): void {
  for (const [name, value] of Object.entries(values)) {
    const isSet = value !== undefined && value !== false;
    if (isSet && !GLOBAL_OPTIONS.includes(name as OptionName) && !command.options.includes(name as OptionName)) {
      throw new UsageError(`Option --${name} is not supported by \`loom ${command.words.join(" ")}\`.`);
    }
  }
}

function findCommand(positionals: readonly string[]): Command {
  const match = COMMANDS.filter((c) => c.words.every((w, i) => positionals[i] === w)).sort((a, b) => b.words.length - a.words.length)[0];
  if (match === undefined) {
    const group = COMMANDS.filter((c) => c.words[0] === positionals[0]);
    if (group.length > 0) throw new UsageError(`Usage:\n${group.map((c) => `  ${c.usage}`).join("\n")}`);
    throw new UsageError(`Unknown command: ${positionals[0]}`);
  }
  return match;
}

export async function run(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let json = argv.includes("--json");
  let commandName = "loom";
  try {
    let parsed;
    try {
      parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    } catch (cause) {
      throw new UsageError((cause as Error).message);
    }
    const values = parsed.values as Values;
    const { positionals } = parsed;
    json = values.json === true;

    if (values.version || positionals[0] === "version") {
      return writeSuccess(io, { json }, "version", { data: { version: VERSION }, lines: [VERSION] });
    }
    if (values.help || positionals.length === 0 || positionals[0] === "help") {
      io.stdout(HELP);
      return EXIT.ok;
    }

    commandName = positionals[0] ?? "loom";
    const command = findCommand(positionals);
    commandName = command.words.join(" ");
    const args = positionals.slice(command.words.length);
    const [min, max] = typeof command.args === "number" ? [command.args, command.args] : command.args;
    if (args.length < min || args.length > max) throw new UsageError(`Usage: ${command.usage}`);
    rejectUnsupported(command, values);

    const outcome = await command.run({
      rootDir: path.resolve(io.cwd, values.dir ?? "."),
      cwd: io.cwd,
      env: io.env,
      args,
      values,
      actor: io.env.LOOM_ACTOR ?? io.env.USER ?? "cli",
    });
    const code = writeSuccess(io, { json }, commandName, outcome.result);
    return outcome.exit ?? code;
  } catch (error) {
    return writeFailure(io, { json }, commandName, error);
  }
}
