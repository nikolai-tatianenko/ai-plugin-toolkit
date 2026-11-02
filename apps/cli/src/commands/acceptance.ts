import {
  BUILTIN_PACKS,
  ENVIRONMENT_KINDS,
  REVISION_KEY,
  acceptCriterion,
  activatePack,
  addEvidence,
  answerQuestion,
  evaluatePack,
  loadBuiltinPack,
  reopenCriterion,
  selectQuestions,
  setRevision,
  waiveCriterion,
  type Evaluation,
  type QuestionMode,
} from "@ai-plugin-toolkit/acceptance";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { IMPORT_FORMATS, importEvidence, loadPackFile, type ImportFormat } from "@ai-plugin-toolkit/acceptance";
import { LoomError, resolveProjectPath } from "@ai-plugin-toolkit/core";
import { withProject } from "../context.js";
import { UsageError, type CommandResult } from "../io.js";

interface Base {
  rootDir: string;
  env: Readonly<Record<string, string | undefined>>;
  pack?: string | undefined;
  cwd?: string;
}

export async function evidenceImportCommand(
  options: Base & { file: string; format?: string | undefined; revision?: string | undefined; environment?: string | undefined; dryRun: boolean },
): Promise<CommandResult> {
  const format = (options.format ?? (options.file.endsWith(".xml") ? "junit-xml/1" : options.file.endsWith(".md") ? "loom-review/1" : "loom-build/1")) as ImportFormat;
  if (!IMPORT_FORMATS.includes(format)) throw new UsageError(`--format must be one of: ${IMPORT_FORMATS.join(", ")}`);
  const absolute = path.resolve(options.cwd ?? options.rootDir, options.file);
  const text = await readFile(absolute, "utf8");
  return withProject(options.rootDir, options, async (ctx) => {
    const pack = await ctx.pack(options.pack);
    const result = importEvidence(ctx.store, ctx.projectId, pack, {
      format,
      text,
      ref: path.relative(ctx.loaded.rootDir, absolute) || absolute,
      actor: ctx.actor,
      dryRun: options.dryRun,
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      ...(options.environment === undefined ? {} : { environment: options.environment as "ci" }),
    });
    return {
      data: result as unknown as Record<string, unknown>,
      lines: [
        `${options.dryRun ? "Would import" : "Imported"} ${format} at revision ${result.revision} (${result.environment}):`,
        ...result.items.map((i) => `  ${i.criterion.padEnd(28)} ${i.result.padEnd(12)} ${i.reason}${"skipped" in i && i.skipped ? ` (${i.skipped})` : ""}`),
        ...(result.items.length === 0 ? ["  no result matched a criterion of this pack"] : []),
        ...(result.unmatched.length > 0 ? [`  ${result.unmatched.length} result(s) matched no criterion (not counted)`] : []),
      ],
    };
  });
}

function summaryLines(e: Evaluation): string[] {
  const count = (pred: (c: Evaluation["criteria"][number]) => boolean) => e.criteria.filter(pred).length;
  return [
    `${e.pack.title} (${e.pack.id}@${e.pack.version}) at revision ${e.revision ?? "(unset — run \`loom revision set <rev>\`)"}`,
    `  readiness: ${e.readiness.status.toUpperCase()}`,
    `  criteria: ${count((c) => c.applicability === "applicable")} applicable, ${count((c) => c.applicability === "not-applicable")} not applicable, ${count((c) => c.applicability === "unresolved")} unresolved`,
    `  verification: ${count((c) => c.verification === "passed")} passed, ${count((c) => c.verification === "failed")} failed, ${count((c) => c.verification === "stale")} stale, ${count((c) => c.applicability === "applicable" && c.verification === "not-checked")} not checked`,
    `  open questions: ${e.questions.filter((q) => q.state === "open" || q.state === "stale").length} (see \`loom questions\`)`,
    `  note: ${e.pack.advisory}`,
  ];
}

export async function assessCommand(options: Base & { packFile?: string | undefined }): Promise<CommandResult> {
  const id = options.pack;
  if ((id === undefined) === (options.packFile === undefined)) {
    throw new UsageError(`Usage: loom assess --pack <id> | --pack-file <path>. Built-in packs: ${BUILTIN_PACKS.join(", ")}.`);
  }
  return withProject(options.rootDir, options, async (ctx) => {
    let pack;
    let source = "builtin";
    if (options.packFile !== undefined) {
      const file = resolveProjectPath(ctx.loaded.rootDir, path.relative(ctx.loaded.rootDir, path.resolve(options.cwd ?? ctx.loaded.rootDir, options.packFile)), "--pack-file");
      pack = await loadPackFile(file);
      source = path.relative(ctx.loaded.rootDir, file).split(path.sep).join("/");
    } else {
      pack = await loadBuiltinPack(id!);
    }
    activatePack(ctx.store, ctx.projectId, pack, ctx.actor, source);
    const evaluation = evaluatePack(ctx.store, ctx.projectId, pack);
    return { data: { evaluation }, lines: [`Activated ${pack.id}@${pack.version}.`, ...summaryLines(evaluation), "Next: `loom questions --mode quick`"] };
  });
}

export async function questionsCommand(options: Base & { mode?: string | undefined; limit: number }): Promise<CommandResult> {
  const mode = (options.mode ?? "quick") as QuestionMode;
  if (!["quick", "guided", "challenge"].includes(mode)) throw new UsageError("--mode must be quick, guided or challenge.");
  return withProject(options.rootDir, options, async (ctx) => {
    const pack = await ctx.pack(options.pack);
    const evaluation = evaluatePack(ctx.store, ctx.projectId, pack);
    const items = selectQuestions(ctx.store, ctx.projectId, evaluation, mode, options.limit);
    const answered = evaluation.questions.filter((q) => q.state === "answered").length;
    return {
      data: { mode, pack: evaluation.pack, items, answered, total: evaluation.questions.length },
      lines:
        items.length === 0
          ? [`Nothing to ask in ${mode} mode (${answered}/${evaluation.questions.length} questions answered).`]
          : [
              `${mode} mode — ${items.length} item(s), ${answered}/${evaluation.questions.length} questions answered:`,
              ...items.flatMap((item) => [
                item.kind === "question" ? `  ? ${item.id}  ${item.text}  [${item.answerFormat}]` : `  ! ${item.text}`,
                `      why: ${item.reason}`,
                ...(item.suggestions ?? []).map((s) => `      memory (unconfirmed suggestion, not an answer): ${s.text}  ← ${s.recordId}`),
              ]),
              ...(items.some((i) => i.kind === "question") ? ["Answer with: loom answer <question-id> <value>"] : []),
            ],
    };
  });
}

export async function answerCommand(options: Base & { question: string; value: string; note?: string | undefined }): Promise<CommandResult> {
  if (options.value.trim() === "") throw new UsageError("Usage: loom answer <question-id> <value>");
  return withProject(options.rootDir, options, async (ctx) => {
    const pack = await ctx.pack(options.pack);
    const answer = answerQuestion(ctx.store, ctx.projectId, pack, {
      question: options.question,
      value: options.value,
      actor: ctx.actor,
      ...(options.note === undefined ? {} : { note: options.note }),
    });
    const evaluation = evaluatePack(ctx.store, ctx.projectId, pack);
    const affected = evaluation.criteria.filter((c) => c.basis.some((b) => b.question === answer.questionKey));
    return {
      data: { answer, affected: affected.map((c) => ({ key: c.key, applicability: c.applicability })) },
      lines: [
        `Recorded ${answer.questionKey} = ${answer.value} (stated by ${answer.answeredBy})`,
        ...affected.map((c) => `  ${c.key}: ${c.applicability}${c.applicabilityRationale ? ` — ${c.applicabilityRationale}` : ""}`),
      ],
    };
  });
}

export async function criteriaListCommand(options: Base): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    const evaluation = evaluatePack(ctx.store, ctx.projectId, await ctx.pack(options.pack));
    return {
      data: { evaluation },
      lines: [
        ...summaryLines(evaluation),
        "",
        ...evaluation.criteria.map(
          (c) =>
            `  ${c.key.padEnd(28)} ${c.severity.padEnd(7)} ${c.applicability.padEnd(14)} ${c.verification.padEnd(11)} ${c.disposition}${c.notes.length > 0 ? `  (${c.notes.length} note${c.notes.length > 1 ? "s" : ""})` : ""}`,
        ),
      ],
    };
  });
}

export async function evidenceAddCommand(
  options: Base & { criterion: string; result?: string | undefined; revision?: string | undefined; environment?: string | undefined; description?: string | undefined; ref?: string | undefined },
): Promise<CommandResult> {
  if (options.result === undefined || options.environment === undefined) {
    throw new UsageError(`Usage: loom evidence add <criterion> --result passed|failed|inconclusive --env <${ENVIRONMENT_KINDS.join("|")}> [--revision <rev>] [--description <text>] [--ref <path-or-url>]`);
  }
  return withProject(options.rootDir, options, async (ctx) => {
    const pack = await ctx.pack(options.pack);
    const revision = options.revision ?? ctx.store.state.get(ctx.projectId, REVISION_KEY);
    if (revision === undefined) throw new LoomError("VALIDATION_FAILED", "Evidence must name a revision: pass --revision or run `loom revision set <rev>` first.");
    const evidence = addEvidence(ctx.store, ctx.projectId, pack, {
      criterion: options.criterion,
      result: options.result as "passed",
      revision,
      environment: options.environment as "manual",
      actor: ctx.actor,
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.ref === undefined ? {} : { artifactRef: options.ref }),
    });
    const c = evaluatePack(ctx.store, ctx.projectId, pack).criteria.find((x) => x.id === evidence.criterionId)!;
    return {
      data: { evidence, criterion: { key: c.key, verification: c.verification, notes: c.notes } },
      lines: [
        `Recorded ${evidence.id}: ${evidence.result} on ${evidence.environment.kind} at revision ${evidence.revision}`,
        `  ${c.key}: verification ${c.verification}`,
        ...c.notes.map((n) => `  ! ${n}`),
      ],
    };
  });
}

export async function dispositionCommand(
  options: Base & { action: "waive" | "accept" | "reopen"; criterion: string; reason?: string | undefined; note?: string | undefined },
): Promise<CommandResult> {
  if (options.action === "waive" && (options.reason === undefined || options.reason.trim() === "")) {
    throw new UsageError("Usage: loom waive <criterion> --reason <text>  (a waiver always records who and why)");
  }
  return withProject(options.rootDir, options, async (ctx) => {
    const pack = await ctx.pack(options.pack);
    const input = { criterion: options.criterion, actor: ctx.actor };
    if (options.action === "waive") waiveCriterion(ctx.store, ctx.projectId, pack, { ...input, reason: options.reason! });
    else if (options.action === "accept") acceptCriterion(ctx.store, ctx.projectId, pack, { ...input, ...(options.note === undefined ? {} : { note: options.note }) });
    else reopenCriterion(ctx.store, ctx.projectId, pack, input);
    const c = evaluatePack(ctx.store, ctx.projectId, pack).criteria.find((x) => x.key === options.criterion || x.id === options.criterion)!;
    return {
      data: { criterion: c.key, disposition: c.disposition, verification: c.verification, waiver: c.waiver ?? null },
      lines: [`${c.key}: disposition ${c.disposition} by ${ctx.actor}; verification remains ${c.verification}`],
    };
  });
}

export async function revisionCommand(options: Base & { value?: string | undefined }): Promise<CommandResult> {
  return withProject(options.rootDir, options, async (ctx) => {
    if (options.value !== undefined) setRevision(ctx.store, ctx.projectId, options.value, ctx.actor);
    const revision = ctx.store.state.get(ctx.projectId, REVISION_KEY) ?? null;
    return { data: { revision }, lines: [revision === null ? "No revision set." : `Current revision: ${revision}`] };
  });
}

export async function reportCommand(options: Base & { requireReady: boolean }): Promise<{ result: CommandResult; ready: boolean }> {
  return withProject(options.rootDir, options, async (ctx) => {
    const packs = options.pack === undefined ? await ctx.activePacks() : [await ctx.pack(options.pack)];
    if (packs.length === 0) throw new LoomError("NOT_FOUND", "No topic pack is active. Run `loom assess --pack mobile-release` first.");
    const evaluations = packs.map((p) => evaluatePack(ctx.store, ctx.projectId, p));
    const ready = evaluations.every((e) => e.readiness.status !== "not-ready");
    const lines = evaluations.flatMap((e) => [
      ...summaryLines(e),
      ...(e.readiness.blocking.length > 0 ? ["  blocking:", ...e.readiness.blocking.map((b) => `    - ${b.criterion}: ${b.reason}`)] : []),
      ...(e.readiness.waived.length > 0 ? [`  waived (not passed): ${e.readiness.waived.join(", ")}`] : []),
      ...(e.readiness.minorGaps.length > 0 ? [`  minor gaps: ${e.readiness.minorGaps.join(", ")}`] : []),
    ]);
    return { result: { data: { ready, evaluations }, lines }, ready };
  });
}
