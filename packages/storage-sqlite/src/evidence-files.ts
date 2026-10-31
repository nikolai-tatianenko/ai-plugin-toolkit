import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LoomError, contentHash } from "@ai-plugin-toolkit/core";

/**
 * Content-addressed evidence payloads under `<storageDir>/evidence/`.
 * Files are written before the database row that references them, so a crash can
 * leave an unreferenced file (harmless, collectable) but never a row pointing at
 * a missing file.
 */
export const EVIDENCE_DIR = "evidence";

export function evidenceRelativePath(hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new LoomError("INVALID_PATH", "Evidence hash must be 64 hex characters.");
  return path.posix.join(EVIDENCE_DIR, hash.slice(0, 2), `${hash}.txt`);
}

/** Resolve a stored relative path, refusing anything that escapes the storage directory. */
export function resolveEvidencePath(storageDir: string, relativePath: string): string {
  const root = path.resolve(storageDir);
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(path.join(root, EVIDENCE_DIR), resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || relativePath.includes("\0")) {
    throw new LoomError("INVALID_PATH", `Evidence path escapes the storage directory: ${relativePath}`);
  }
  return resolved;
}

/** Idempotent atomic write (temp file + rename). Returns the storage-relative path. */
export async function writeEvidenceFile(storageDir: string, text: string, hash: string): Promise<string> {
  const relativePath = evidenceRelativePath(hash);
  const target = resolveEvidencePath(storageDir, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
  return relativePath;
}

/** Read a payload and verify it still matches its recorded hash. */
export async function readEvidenceFile(storageDir: string, relativePath: string, expectedHash: string): Promise<string> {
  const text = await readFile(resolveEvidencePath(storageDir, relativePath), "utf8");
  if (contentHash(text) !== expectedHash) {
    throw new LoomError("INTERNAL", `Evidence file ${relativePath} does not match its recorded hash.`, {
      details: { path: relativePath },
    });
  }
  return text;
}
