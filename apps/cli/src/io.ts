import { isLoomError, redactSecrets, redactString, type LoomErrorCode } from "@ai-plugin-toolkit/core";

/** Process boundary, injected so commands run in-process under test. */
export interface CliIo {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  internal: 70,
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface CommandResult {
  /** Machine-readable payload for `--json`. */
  data: Record<string, unknown>;
  /** Human-readable lines for the default output. */
  lines: string[];
}

export interface OutputMode {
  json: boolean;
}

export function writeSuccess(io: CliIo, mode: OutputMode, command: string, result: CommandResult): ExitCode {
  if (mode.json) {
    io.stdout(`${JSON.stringify(redactSecrets({ ok: true, command, data: result.data }), null, 2)}\n`);
  } else if (result.lines.length > 0) {
    io.stdout(`${result.lines.map(redactString).join("\n")}\n`);
  }
  return EXIT.ok;
}

export function writeFailure(io: CliIo, mode: OutputMode, command: string, error: unknown): ExitCode {
  let code: LoomErrorCode | "USAGE";
  let message: string;
  let details: unknown;
  let exit: ExitCode;

  if (error instanceof UsageError) {
    code = "USAGE";
    message = error.message;
    exit = EXIT.usage;
  } else if (isLoomError(error)) {
    code = error.code;
    message = error.message;
    details = error.details;
    exit = EXIT.failure;
  } else {
    code = "INTERNAL";
    message = error instanceof Error ? error.message : String(error);
    exit = EXIT.internal;
  }

  if (mode.json) {
    const payload = { ok: false, command, error: details === undefined ? { code, message } : { code, message, details } };
    io.stdout(`${JSON.stringify(redactSecrets(payload), null, 2)}\n`);
  } else {
    io.stderr(`loom: ${redactString(message)}\n`);
    if (exit === EXIT.usage) io.stderr("Run `loom help` for usage.\n");
  }
  if (exit === EXIT.internal && io.env.LOOM_DEBUG === "1" && error instanceof Error && error.stack) {
    io.stderr(`${redactString(error.stack)}\n`);
  }
  return exit;
}
