import { execFileSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { VERSION } from "@ai-plugin-toolkit/core";
import {
  answerCommand,
  assessCommand,
  criteriaListCommand,
  dispositionCommand,
  evidenceAddCommand,
  evidenceImportCommand,
  questionsCommand,
  reportCommand,
  revisionCommand,
} from "./commands/acceptance.js";
import { configValidateCommand } from "./commands/config.js";
import { findProjectRoot } from "./config-file.js";
import { mcpCommand } from "./commands/mcp.js";
import { inspectCommand } from "./commands/inspect.js";
import {
  correctCommand,
  exportCommand,
  forgetCommand,
  importCommand,
  retentionCommand,
  reviewListCommand,
  reviewResolveCommand,
} from "./commands/lifecycle.js";
import { ingestCommand } from "./commands/ingest.js";
import { initCommand } from "./commands/init.js";
import {
  contextCommand,
  extractCommand,
  memoryListCommand,
  memoryReviewCommand,
  memoryShowCommand,
  cacheCommand,
  embedCommand,
  normalizeCommand,
  requireNumber,
  searchCommand,
} from "./commands/memory.js";
import {
  dbCommand,
  generateCommand,
  tasksConflictsCommand,
  tasksInitCommand,
  tasksListCommand,
  tasksPreviewCommand,
  tasksPullCommand,
  tasksResolveCommand,
  tasksSyncCommand,
} from "./commands/output.js";
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
  context <words...>         Assemble a bounded, cited context (--max-chars); cached per memory revision
  embed                      Compute missing embeddings (routing.embedding); search --semantic uses them
  cache stats | clear        Retrieval/context/embedding cache sizes and hits
  normalize <text...>        Experimental plain-English rewrite with meaning checks (--file, --via-model)

Corrections and lifecycle
  correct <topic> <choice>   Record a person's decision (--reason); supersedes the current one
  review list | resolve <id> Possible contradictions and cross-source supersessions
  forget <source-id...>      Delete a source and everything derived from it (--yes)
  export --out <file>        Portable JSON of memory and acceptance state
  import <file>              Load an export into an empty project
  retention show | apply     Apply retention.sourceMaxAgeDays (--yes)

Artifacts
  generate [types...]        Write FACTS, VISION, PLAN, STATUS, ACCEPTANCE and decision records

Acceptance
  assess --pack <id>         Activate a topic pack and summarize (built-in: mobile-release,
                             open-source-release, web-release, ai-feature; or --pack-file <path>)
  questions                  What to answer next (--mode quick|guided|challenge)
  answer <question> <value>  Record a stated answer
  criteria list              Applicability, verification and disposition of every criterion
  evidence add <criterion>   Attach evidence (--result, --env, --revision, --description, --ref)
  evidence import <file>     Import JUnit XML, loom-build/1 JSON or loom-review/1 Markdown results
  waive <criterion>          Waive with --reason (recorded with actor; never shown as passed)
  accept | reopen <criterion> Record or clear human acceptance
  revision set <rev> | show  Current source/build revision (older evidence becomes stale);
                             --from-git uses the current commit (suffix "-dirty" if uncommitted changes)
  report                     Readiness report (--require-ready exits 1 when not ready)

Tasks
  tasks init                 Initialize the configured task system (Beads database or .taskmaster/)
  tasks preview              Show the task change set; writes nothing
  tasks sync                 Publish the change set (requires tasks.allowWrites: true)
  tasks list                 Local tasks and their external IDs
  tasks pull                 Read remote status and edits back (status is owned by the task system)
  tasks conflicts            Remote edits waiting for a decision
  tasks resolve <task-id>    --keep remote (stop updating it) | --keep local (publish over the edit)

Agents and inspection
  mcp                        MCP server over stdio for this project (read tools; writes if mcp.allowWrites)
  inspect [--port <n>]       Read-only web inspector on 127.0.0.1 (token-protected URL)

Database
  db status | backup         Schema version and backups; write a backup now
  db restore <file> --yes    Replace the database with a backup (previous file kept)

Global options
  --dir <path>   Project directory (default: current directory)
  --json         Machine-readable output on stdout
  -h, --help     Show help;  -v, --version  Print the version

Command options
  init:      --project-id <id> --name <name> --dry-run --provider anthropic|ollama|fixture --fixture <path>
             --model <name> --embeddings hashing|ollama
             --tasks beads|taskmaster --allow-task-writes
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
  action: { type: "string" },
  keep: { type: "string" },
  yes: { type: "boolean", default: false },
  out: { type: "string" },
  semantic: { type: "boolean", default: false },
  model: { type: "string" },
  embeddings: { type: "string" },
  "pack-file": { type: "string" },
  normalize: { type: "boolean", default: false },
  "via-model": { type: "boolean", default: false },
  port: { type: "string" },
  "from-git": { type: "boolean", default: false },
  file: { type: "string" },
  format: { type: "string" },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = { [K in OptionName]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };
const GLOBAL_OPTIONS: readonly OptionName[] = ["dir", "json", "help", "version"];

interface Invocation {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
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
    options: ["project-id", "name", "dry-run", "provider", "fixture", "tasks", "allow-task-writes", "model", "embeddings"],
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
          model: inv.values.model,
          embeddings: inv.values.embeddings,
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
    options: ["all", "limit", "semantic"],
    usage: "loom search <words...> [--all] [--limit <n>] [--semantic]",
    run: (inv) =>
      ok(searchCommand({ ...base(inv), query: inv.args.join(" "), all: inv.values.all === true, limit: requireNumber(inv.values.limit, "limit", 20, 1, 200), semantic: inv.values.semantic === true })),
  },
  {
    words: ["context"],
    args: [1, 100],
    options: ["max-chars", "normalize"],
    usage: "loom context <words...> [--max-chars <n>] [--normalize]",
    run: (inv) =>
      ok(contextCommand({ ...base(inv), query: inv.args.join(" "), maxChars: requireNumber(inv.values["max-chars"], "max-chars", 8_000, 200, 1_000_000), normalize: inv.values.normalize === true })),
  },
  {
    words: ["normalize"],
    args: [0, 10_000],
    options: ["file", "via-model"],
    usage: "loom normalize <text...> | --file <path> [--via-model]",
    run: (inv) => ok(normalizeCommand({ ...base(inv), text: inv.args.join(" "), file: inv.values.file, model: inv.values["via-model"] === true, cwd: inv.cwd })),
  },
  { words: ["embed"], args: 0, options: [], usage: "loom embed", run: (inv) => ok(embedCommand(base(inv))) },
  { words: ["cache", "stats"], args: 0, options: [], usage: "loom cache stats", run: (inv) => ok(cacheCommand({ ...base(inv), clear: false })) },
  { words: ["cache", "clear"], args: 0, options: [], usage: "loom cache clear", run: (inv) => ok(cacheCommand({ ...base(inv), clear: true })) },
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
  {
    words: ["correct"],
    args: [2, 100],
    options: ["reason"],
    usage: "loom correct <topic> <choice...> --reason <why>",
    run: (inv) => ok(correctCommand({ ...base(inv), topic: inv.args[0]!, choice: inv.args.slice(1).join(" "), reason: inv.values.reason })),
  },
  { words: ["review", "list"], args: 0, options: ["all"], usage: "loom review list [--all]", run: (inv) => ok(reviewListCommand({ ...base(inv), all: inv.values.all === true })) },
  {
    words: ["review", "resolve"],
    args: 1,
    options: ["action", "keep"],
    usage: "loom review resolve <id> --action accept|revert|dismiss | --keep <record-id>",
    run: (inv) => ok(reviewResolveCommand({ ...base(inv), id: inv.args[0]!, action: inv.values.action, keep: inv.values.keep })),
  },
  {
    words: ["forget"],
    args: [1, 1_000],
    options: ["yes"],
    usage: "loom forget <source-id...> --yes",
    run: (inv) => ok(forgetCommand({ ...base(inv), sources: inv.args, yes: inv.values.yes === true })),
  },
  { words: ["export"], args: 0, options: ["out"], usage: "loom export --out <file.json>", run: (inv) => ok(exportCommand({ ...base(inv), out: inv.values.out, cwd: inv.cwd })) },
  { words: ["import"], args: 1, options: [], usage: "loom import <export.json>", run: (inv) => ok(importCommand({ ...base(inv), file: inv.args[0]!, cwd: inv.cwd })) },
  { words: ["retention", "show"], args: 0, options: [], usage: "loom retention show", run: (inv) => ok(retentionCommand({ ...base(inv), apply: false, yes: false })) },
  {
    words: ["retention", "apply"],
    args: 0,
    options: ["yes"],
    usage: "loom retention apply --yes",
    run: (inv) => ok(retentionCommand({ ...base(inv), apply: true, yes: inv.values.yes === true })),
  },
  {
    words: ["assess"],
    args: 0,
    options: ["pack", "pack-file"],
    usage: "loom assess --pack <id> | --pack-file <path>",
    run: (inv) => ok(assessCommand({ ...base(inv), cwd: inv.cwd, pack: inv.values.pack, packFile: inv.values["pack-file"] })),
  },
  {
    words: ["evidence", "import"],
    args: 1,
    options: ["pack", "format", "revision", "env", "dry-run"],
    usage: "loom evidence import <file> [--format junit-xml/1|loom-build/1|loom-review/1] [--revision <rev>] [--env <kind>] [--dry-run]",
    run: (inv) =>
      ok(
        evidenceImportCommand({
          ...base(inv),
          cwd: inv.cwd,
          pack: inv.values.pack,
          file: inv.args[0]!,
          format: inv.values.format,
          revision: inv.values.revision,
          environment: inv.values.env,
          dryRun: inv.values["dry-run"] === true,
        }),
      ),
  },
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
  {
    words: ["revision", "set"],
    args: [0, 1],
    options: ["from-git"],
    usage: "loom revision set <rev> | --from-git",
    run: async (inv) => {
      if ((inv.args[0] === undefined) === (inv.values["from-git"] !== true)) throw new UsageError("Usage: loom revision set <rev> | --from-git");
      const value = inv.values["from-git"] ? gitRevision(inv.rootDir) : inv.args[0]!;
      return ok(revisionCommand({ ...base(inv), value }));
    },
  },
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
  {
    words: ["inspect"],
    args: 0,
    options: ["port"],
    usage: "loom inspect [--port <n>]",
    run: (inv) => ok(inspectCommand({ ...base(inv), port: requireNumber(inv.values.port, "port", 0, 0, 65_535), stdout: inv.stdout })),
  },
  { words: ["mcp"], args: 0, options: [], usage: "loom mcp", run: (inv) => ok(mcpCommand({ ...base(inv), stderr: inv.stderr })) },
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
  { words: ["tasks", "pull"], args: 0, options: [], usage: "loom tasks pull", run: (inv) => ok(tasksPullCommand(base(inv))) },
  { words: ["tasks", "conflicts"], args: 0, options: [], usage: "loom tasks conflicts", run: (inv) => ok(tasksConflictsCommand(base(inv))) },
  {
    words: ["tasks", "resolve"],
    args: 1,
    options: ["keep"],
    usage: "loom tasks resolve <task-id> --keep local|remote",
    run: (inv) => ok(tasksResolveCommand({ ...base(inv), taskId: inv.args[0]!, keep: inv.values.keep })),
  },
  { words: ["db", "status"], args: 0, options: [], usage: "loom db status", run: (inv) => ok(dbCommand({ ...base(inv), action: "status", yes: false, cwd: inv.cwd })) },
  { words: ["db", "backup"], args: 0, options: [], usage: "loom db backup", run: (inv) => ok(dbCommand({ ...base(inv), action: "backup", yes: false, cwd: inv.cwd })) },
  {
    words: ["db", "restore"],
    args: 1,
    options: ["yes"],
    usage: "loom db restore <backup.db> --yes",
    run: (inv) => ok(dbCommand({ ...base(inv), action: "restore", file: inv.args[0]!, yes: inv.values.yes === true, cwd: inv.cwd })),
  },
];

/** Current git commit of the project (short hash), with "-dirty" when the work tree has changes. */
function gitRevision(rootDir: string): string {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    return dirty ? `${hash}-dirty` : hash;
  } catch {
    throw new UsageError("--from-git needs a git repository with at least one commit (and git on PATH).");
  }
}

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
    if (command.words[0] === "mcp" && json) throw new UsageError("`loom mcp` speaks MCP on stdout; --json is not supported.");

    const outcome = await command.run({
      // --dir is explicit; otherwise search upward from the working directory (init always uses cwd).
      rootDir: values.dir !== undefined || command.words[0] === "init" ? path.resolve(io.cwd, values.dir ?? ".") : findProjectRoot(io.cwd),
      stderr: io.stderr,
      stdout: io.stdout,
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
