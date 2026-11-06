import { expect, it } from "vitest";
import { httpReviewAdapter, publishReview } from "../src/index.js";
import { ReviewTargetSchema } from "@ai-plugin-toolkit/core";

it.each(["github", "gitlab"] as const)("%s creates once, then updates the matching request with the selected branches", async provider => {
  const target = ReviewTargetSchema.parse({ provider, repository: "owner/project", head: "feature/checklists", base: "develop", title: "Checklist delivery", tokenEnv: "HOST_TOKEN", allowWrites: true });
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let exists = false;
  const wire = provider === "github" ? { number: 5, html_url: "https://github.com/owner/project/pull/5", head: { ref: target.head }, base: { ref: target.base } } : { iid: 5, web_url: "https://gitlab.com/owner/project/-/merge_requests/5", source_branch: target.head, target_branch: target.base };
  const transport = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null });
    if (method === "GET") return Response.json(exists ? [wire] : []);
    exists = true; return Response.json(wire);
  }) as typeof fetch;
  const adapter = httpReviewAdapter(target, "secret-token", transport);
  expect((await publishReview(target, "First checklist", adapter)).action).toBe("created");
  expect((await publishReview(target, "Updated checklist", adapter)).action).toBe("updated");
  expect(calls.filter(c => c.method === "POST")).toHaveLength(1);
  expect(calls.at(-1)!.method).toBe(provider === "github" ? "PATCH" : "PUT");
  expect(JSON.stringify(calls.at(-1)!.body)).toContain("Updated checklist");
  if (provider === "github") expect(calls[1]!.body).toMatchObject({ base: "develop", head: "feature/checklists", draft: true });
  else expect(calls[1]!.body).toMatchObject({ target_branch: "develop", source_branch: "feature/checklists", title: "Draft: Checklist delivery" });
});

it("refuses writes before consulting the host when target policy is read-only", async () => {
  const target = ReviewTargetSchema.parse({ provider: "github", repository: "o/r", base: "main", head: "feature", title: "Title", tokenEnv: "TOKEN" });
  let called = false;
  const adapter = { find: async () => { called = true; return undefined; }, create: async () => { throw new Error(); }, update: async () => { throw new Error(); } };
  await expect(publishReview(target, "Body", adapter)).rejects.toThrow(/disabled/);
  expect(called).toBe(false);
});

it("validates explicit review numbers against branches before updating", async () => {
  const target = ReviewTargetSchema.parse({ provider: "github", repository: "o/r", base: "main", head: "feature", title: "Title", tokenEnv: "TOKEN", number: 5, allowWrites: true });
  const transport = (async () => Response.json({ number: 5, html_url: "https://github.com/o/r/pull/5", head: { ref: "other" }, base: { ref: "main" } })) as typeof fetch;
  await expect(publishReview(target, "Body", httpReviewAdapter(target, "token", transport))).rejects.toThrow(/different/);
});

it("does not fabricate publication when the host rejects a request", async () => {
  const target = ReviewTargetSchema.parse({ provider: "github", repository: "o/r", base: "main", head: "feature", title: "Title", tokenEnv: "TOKEN", allowWrites: true });
  const transport = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  await expect(publishReview(target, "Body", httpReviewAdapter(target, "token", transport))).rejects.toThrow(/401/);
});
