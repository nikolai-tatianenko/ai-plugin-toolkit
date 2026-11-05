/**
 * Typed errors shared by every module. Callers branch on `code`, never on message text.
 */
export const LOOM_ERROR_CODES = [
  "CONFIG_NOT_FOUND",
  "CONFIG_INVALID",
  "VALIDATION_FAILED",
  "UNSUPPORTED_CAPABILITY",
  "ALREADY_EXISTS",
  "INVALID_PATH",
  "POLICY_VIOLATION",
  "NOT_FOUND",
  "CONFLICT",
  "CREDENTIALS_MISSING",
  "PROVIDER_FAILED",
  "TIMEOUT",
  "BUDGET_EXCEEDED",
  "CANCELLED",
  "INVALID_OUTPUT",
  "EXTERNAL_TOOL_FAILED",
  "INTERNAL",
] as const;

export type LoomErrorCode = (typeof LOOM_ERROR_CODES)[number];

export class LoomError extends Error {
  readonly code: LoomErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: LoomErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LoomError";
    this.code = code;
    this.details = options?.details;
  }

  toJSON(): { code: LoomErrorCode; message: string; details?: Readonly<Record<string, unknown>> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Raised when a plugin is asked for an operation it did not declare (or declared but did not implement).
 * Never replaced by a silent no-op or fabricated success.
 */
export class UnsupportedCapabilityError extends LoomError {
  readonly plugin: string;
  readonly capability: string;

  constructor(plugin: string, capability: string, reason = "not declared by the plugin") {
    super("UNSUPPORTED_CAPABILITY", `Plugin "${plugin}" does not support "${capability}": ${reason}.`, {
      details: { plugin, capability },
    });
    this.name = "UnsupportedCapabilityError";
    this.plugin = plugin;
    this.capability = capability;
  }
}

export function isLoomError(value: unknown): value is LoomError {
  return value instanceof LoomError;
}
