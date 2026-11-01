import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  LoomError,
  ProviderError,
  defineProvider,
  parseWith,
  resolveProjectPath,
  type CompletionRequest,
  type CompletionResult,
  type ProviderAdapter,
} from "@ai-plugin-toolkit/core";
import type { ProviderFactory } from "./router.js";

/**
 * Deterministic, local "provider" that replays recorded responses. It exists so CI
 * and the offline demo are reproducible (test plan: "CI uses deterministic provider
 * fixtures"). It is not a model and its results are never evidence of model quality.
 */
export const FixtureFileSchema = z.strictObject({
  version: z.literal(1),
  description: z.string().optional(),
  responses: z
    .array(
      z
        .strictObject({
          /** Every string must occur in the request (system + messages) for this entry to match. */
          match: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
          text: z.string().optional(),
          json: z.unknown().optional(),
        })
        .refine((r) => (r.text === undefined) !== (r.json === undefined), { message: "Provide exactly one of text or json" }),
    )
    .min(1),
});
export type FixtureFile = z.infer<typeof FixtureFileSchema>;

export function createFixtureProvider(fixture: FixtureFile, name = "fixture"): ProviderAdapter {
  const valid = parseWith(FixtureFileSchema, fixture, "provider fixture");
  return defineProvider({
    manifest: { kind: "provider", name: "fixture", version: "0.1.0", location: "local", capabilities: ["complete", "json-output"] },
    async complete(request: CompletionRequest, { signal }: { signal: AbortSignal }): Promise<CompletionResult> {
      if (signal.aborted) throw new ProviderError("cancelled", "fixture request aborted");
      const haystack = [request.system ?? "", ...request.messages.map((m) => m.content)].join("\n");
      const entry = valid.responses.find((r) => (Array.isArray(r.match) ? r.match : [r.match]).every((m) => haystack.includes(m)));
      if (entry === undefined) {
        throw new ProviderError("bad-request", `fixture provider "${name}" has no recorded response for this request`);
      }
      // Source IDs depend on the project ID, so fixtures may write {{sourceId}}: it becomes the
      // first source-id="..." attribute in the request.
      const sourceId = /source-id="([^"]+)"/.exec(haystack)?.[1] ?? "";
      const body = (entry.text ?? JSON.stringify(entry.json)).replaceAll("{{sourceId}}", sourceId);
      return {
        text: body,
        model: `fixture:${name}`,
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      };
    },
  });
}

/** Factory for `adapter: "fixture"` providers. The fixture path must stay inside the project. */
export const fixtureProviderFactory: ProviderFactory = ({ name, config, rootDir }) => {
  if (config.fixture === undefined) {
    throw new LoomError("CONFIG_INVALID", `Provider "${name}" uses the fixture adapter but sets no "fixture" path.`);
  }
  const file = resolveProjectPath(rootDir, config.fixture, `providers.${name}.fixture`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new LoomError("CONFIG_INVALID", `Cannot read fixture for provider "${name}" (${config.fixture}): ${(cause as Error).message}`, {
      cause,
    });
  }
  return createFixtureProvider(parseWith(FixtureFileSchema, raw, `fixture ${config.fixture}`), name);
};
