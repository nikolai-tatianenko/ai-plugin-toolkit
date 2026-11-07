import { z } from "zod";

const Env = z.string().regex(/^[A-Z_][A-Z0-9_]*$/);
export const MemorySettingsSchema = z.strictObject({
  /** Optional separate private user database directory; never exported to a server. */
  userStoreDir: z.string().min(1).optional(),
  checkpointPercent: z.number().min(1).max(100).default(70),
  server: z.strictObject({
    url: z.url(),
    tokenEnv: Env,
    allowWrites: z.boolean().default(false),
    timeoutMs: z.int().min(100).max(120000).default(10000),
  }).optional(),
});
export const ReviewTargetSchema = z.strictObject({
  provider: z.enum(["github", "gitlab"]),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
  base: z.string().min(1).max(200),
  head: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  body: z.string().max(100000).default(""),
  draft: z.boolean().default(true),
  tokenEnv: Env,
  apiUrl: z.url().optional(),
  number: z.int().positive().optional(),
  allowWrites: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.provider === "github" && value.repository.split("/").length !== 2) ctx.addIssue({ code: "custom", path: ["repository"], message: "GitHub repositories use owner/name" });
  if (value.head === value.base) ctx.addIssue({ code: "custom", path: ["head"], message: "Source and target branches must differ" });
});
export type ReviewTarget = z.infer<typeof ReviewTargetSchema>;
