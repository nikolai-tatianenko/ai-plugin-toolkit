import { createHash, randomBytes } from "node:crypto";
import { LoomError } from "./errors.js";

/** Short, readable prefixes so an ID's entity type is obvious in logs and exports. */
export const ID_PREFIXES = {
  project: "prj",
  source: "src",
  fact: "fct",
  decision: "dec",
  question: "qst",
  artifact: "art",
  criterion: "crt",
  evidence: "evd",
  task: "tsk",
  syncMapping: "syn",
  auditEvent: "aud",
  job: "job",
} as const;

export type EntityKind = keyof typeof ID_PREFIXES;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const STABLE_HASH_LENGTH = 26;
const ID_BODY = /^[0-9A-HJKMNP-TV-Z]{26}$|^[0-9a-f]{26}$/;

/** SHA-256 hex digest of text (UTF-8) or bytes. */
export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Deterministic ID derived from its parts. Parts are length-prefixed so
 * ("ab", "c") and ("a", "bc") never collide. Use for anything that must be
 * identical across re-imports (e.g. a source scoped to a project + content hash).
 */
export function stableId(kind: EntityKind, ...parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new LoomError("VALIDATION_FAILED", `stableId(${kind}) requires at least one part.`);
  }
  const hash = createHash("sha256");
  hash.update(kind);
  for (const part of parts) {
    hash.update(`\u0000${Buffer.byteLength(part, "utf8")}:`);
    hash.update(part, "utf8");
  }
  return `${ID_PREFIXES[kind]}_${hash.digest("hex").slice(0, STABLE_HASH_LENGTH)}`;
}

function encodeBase32(value: bigint, length: number): string {
  let out = "";
  let remaining = value;
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(remaining & 31n)] + out;
    remaining >>= 5n;
  }
  return out;
}

/**
 * Time-sortable unique ID (ULID layout: 48-bit ms timestamp + 80 random bits).
 * Use for records whose identity is not derived from content (audit events, jobs).
 */
export function newId(kind: EntityKind, now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new LoomError("VALIDATION_FAILED", `newId(${kind}) received an invalid timestamp.`);
  }
  const random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(now), 10)}${encodeBase32(random, 16)}`;
}

/** True when `id` is a well-formed ID of the given kind (stable or time-sortable). */
export function isIdOf(kind: EntityKind, id: string): boolean {
  const prefix = `${ID_PREFIXES[kind]}_`;
  return id.startsWith(prefix) && ID_BODY.test(id.slice(prefix.length));
}
