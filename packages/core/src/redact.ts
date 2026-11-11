/**
 * Redaction for anything that leaves the process: CLI output, logs, audit payloads.
 * Conservative by design — false positives are acceptable, leaked secrets are not.
 */
export const REDACTED = "[REDACTED]";

const SECRET_KEY = /(api[-_]?key|secret|token|password|passwd|authorization|credential|private[-_]?key)/i;
/** Key names that merely *reference* a secret (e.g. an env var name) are safe to show. */
const SECRET_REFERENCE_KEY = /(env|envvar|variable)$/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key IDs
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export function redactString(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

export function redactSecrets<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

function redactValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[Circular]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactValue(item, ancestors));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) && !SECRET_REFERENCE_KEY.test(key) && inner != null ? REDACTED : redactValue(inner, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
