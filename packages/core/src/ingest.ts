import { z } from "zod";
import { LoomError } from "./errors.js";
import { SourceTypeSchema, parseWith } from "./schemas.js";

/** Untrusted ingest input. Validated in full before anything is written. */
export const SourceInputSchema = z.strictObject({
  type: SourceTypeSchema,
  text: z.string().min(1, "Source text is empty"),
  title: z.string().trim().min(1).max(500).optional(),
  mediaType: z.string().min(1).default("text/plain"),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  /** Where the input came from (e.g. a file name), used only in error messages. */
  label: z.string().optional(),
});
export type SourceInput = z.input<typeof SourceInputSchema>;
export type ValidSourceInput = z.output<typeof SourceInputSchema>;

/**
 * Synthetic/exported conversation format accepted by `loom ingest`.
 * The file is stored verbatim; this schema only decides whether it is well-formed.
 */
export const ConversationFileSchema = z.strictObject({
  title: z.string().trim().min(1).max(500).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant", "system", "tool"]),
        content: z.string(),
        at: z.iso.datetime({ offset: true }).optional(),
      }),
    )
    .min(1, "A conversation needs at least one message"),
});
export type ConversationFile = z.infer<typeof ConversationFileSchema>;

const TEXT_EXTENSIONS: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
};

/**
 * Turn a file's raw bytes into a validated SourceInput without any IO.
 * - `.json`: must match ConversationFileSchema; stored verbatim as a conversation.
 * - `.md` / `.txt` / `.log`: stored verbatim; type defaults to `document`.
 * Content must be valid UTF-8 and non-empty. Bytes are never normalized, so the
 * stored hash and source spans always refer to the original material.
 */
export function parseIngestPayload(
  fileName: string,
  bytes: Uint8Array,
  options: { type?: z.infer<typeof SourceTypeSchema>; title?: string } = {},
): ValidSourceInput {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new LoomError("VALIDATION_FAILED", `${fileName} is not valid UTF-8 text.`, { cause, details: { file: fileName } });
  }
  if (text.trim().length === 0) {
    throw new LoomError("VALIDATION_FAILED", `${fileName} is empty.`, { details: { file: fileName } });
  }

  const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
  if (extension === ".json") {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw new LoomError("VALIDATION_FAILED", `${fileName} is not valid JSON: ${(cause as Error).message}`, {
        cause,
        details: { file: fileName },
      });
    }
    const conversation = parseWith(ConversationFileSchema, raw, `conversation file ${fileName}`);
    if (options.type !== undefined && options.type !== "conversation") {
      throw new LoomError("VALIDATION_FAILED", `${fileName} is a conversation file; --type ${options.type} does not apply.`);
    }
    return parseWith(
      SourceInputSchema,
      {
        type: "conversation",
        text,
        mediaType: "application/json",
        title: options.title ?? conversation.title ?? baseName(fileName),
        ...(conversation.createdAt === undefined ? {} : { createdAt: conversation.createdAt }),
        label: fileName,
      },
      fileName,
    );
  }

  const mediaType = TEXT_EXTENSIONS[extension];
  if (mediaType === undefined) {
    throw new LoomError(
      "VALIDATION_FAILED",
      `${fileName}: unsupported file type "${extension}". Supported: .json (conversation), ${Object.keys(TEXT_EXTENSIONS).join(", ")}.`,
      { details: { file: fileName } },
    );
  }
  return parseWith(
    SourceInputSchema,
    { type: options.type ?? "document", text, mediaType, title: options.title ?? baseName(fileName), label: fileName },
    fileName,
  );
}

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}
