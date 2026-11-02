import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluatePack, type TopicPack } from "@ai-plugin-toolkit/acceptance";
import { LoomError, contentHash } from "@ai-plugin-toolkit/core";
import { resolveSpans } from "@ai-plugin-toolkit/memory";
import type { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import {
  renderAcceptance,
  renderDecision,
  renderFacts,
  renderPlan,
  renderStatus,
  renderVision,
  type ProjectSnapshot,
  type Rendered,
} from "./render.js";

export const GENERATOR = { name: "loom-artifacts", version: "0.1.0" } as const;
export const ARTIFACT_TYPES = ["facts", "vision", "plan", "status", "acceptance", "decisions"] as const;
export type ArtifactKind = (typeof ARTIFACT_TYPES)[number];

const BEGIN = "<!-- loom:generated:begin — edits between these markers are detected and not overwritten -->";
const END = "<!-- loom:generated:end -->";
const DEFAULT_TAIL = "\n\n## Notes\n\n<!-- Manual notes below this line are kept when the file is regenerated. -->\n";

export interface ArtifactOutcome {
  name: string;
  type: string;
  path: string;
  status: "created" | "updated" | "unchanged" | "restored" | "conflict";
  revision: number | undefined;
  reason?: string;
}

export async function buildSnapshot(store: LoomStore, projectId: string, projectName: string, packs: readonly TopicPack[]): Promise<ProjectSnapshot> {
  const decisions = store.memory.listDecisions(projectId, { includeInactive: true }).filter((d) => d.status !== "rejected");
  const decisionEvidence: ProjectSnapshot["decisionEvidence"] = {};
  for (const d of decisions) decisionEvidence[d.id] = await resolveSpans(store, projectId, d.spans);
  const runs = store.memory.listRuns(projectId);
  const syncRuns = store.tasks.runs(projectId);
  const lastSync = syncRuns.at(-1);
  return {
    project: { id: projectId, name: projectName },
    facts: store.memory.listFacts(projectId),
    decisions,
    evaluations: packs.map((p) => evaluatePack(store, projectId, p)),
    tasks: store.tasks.list(projectId),
    extraction: {
      sources: store.countSources(projectId),
      runsOk: runs.filter((r) => r.status === "ok").length,
      runsFailed: runs.filter((r) => r.status === "error").length,
      rejected: store.memory.listRejected(projectId).length,
    },
    sync: lastSync === undefined ? undefined : { adapter: lastSync.adapter, lastStatus: lastSync.status, mapped: store.tasks.mappings(projectId, lastSync.adapter).length },
    routing: store.routing.summary(projectId),
    review: store.memory.reviewItems(projectId).map((r) => ({ id: r.id, kind: r.kind, detail: r.detail })),
    decisionEvidence,
  };
}

function plannedArtifacts(snapshot: ProjectSnapshot, types: readonly ArtifactKind[]): Array<{ name: string; type: string; rendered: Rendered }> {
  const out: Array<{ name: string; type: string; rendered: Rendered }> = [];
  const add = (type: ArtifactKind, name: string, rendered: Rendered) => types.includes(type) && out.push({ name, type, rendered });
  add("facts", "FACTS.md", renderFacts(snapshot));
  add("vision", "VISION.md", renderVision(snapshot));
  add("plan", "PLAN.md", renderPlan(snapshot));
  add("status", "STATUS.md", renderStatus(snapshot));
  add("acceptance", "ACCEPTANCE.md", renderAcceptance(snapshot));
  if (types.includes("decisions")) {
    for (const d of snapshot.decisions) out.push({ name: `decisions/${d.id}.md`, type: "decision-record", rendered: renderDecision(snapshot, d) });
  }
  return out;
}

/** Split a file into its generated region and everything after it. Undefined when the markers are missing or damaged. */
export function splitManaged(text: string): { generated: string; tail: string } | undefined {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (begin === -1 || end === -1 || end < begin || text.indexOf(BEGIN, begin + 1) !== -1) return undefined;
  return { generated: text.slice(begin + BEGIN.length + 1, end).replace(/\n$/, ""), tail: text.slice(end + END.length) };
}

function compose(name: string, type: string, revision: number, inputHash: string, body: string, tail: string): string {
  const header = `<!-- loom:artifact name=${name} type=${type} revision=${revision} input=${inputHash.slice(0, 16)} generator=${GENERATOR.name}@${GENERATOR.version} -->`;
  return `${header}\n${BEGIN}\n${body}\n${END}${tail}`;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export interface GenerateOptions {
  store: LoomStore;
  projectId: string;
  projectName: string;
  /** Absolute output directory, already validated to lie inside the project. */
  outDir: string;
  packs: readonly TopicPack[];
  types?: readonly ArtifactKind[];
  /** Replace a manually edited generated region (text outside the markers is still kept). */
  force?: boolean;
  dryRun?: boolean;
  actor: string;
}

/**
 * Generate or refresh artifacts (CL-006, A07). Each file keeps its generated region
 * between markers; manual notes after the end marker survive regeneration. A manual
 * edit inside the region is reported as a conflict and the file is left untouched.
 */
export async function generateArtifacts(options: GenerateOptions): Promise<ArtifactOutcome[]> {
  const { store, projectId } = options;
  const snapshot = await buildSnapshot(store, projectId, options.projectName, options.packs);
  const outcomes: ArtifactOutcome[] = [];

  for (const { name, type, rendered } of plannedArtifacts(snapshot, options.types ?? ARTIFACT_TYPES)) {
    const file = path.resolve(options.outDir, name);
    if (path.relative(options.outDir, file).startsWith("..")) throw new LoomError("INVALID_PATH", `Artifact path escapes the output directory: ${name}`);
    const relative = path.relative(options.outDir, file).split(path.sep).join("/");
    const inputHash = contentHash(JSON.stringify([GENERATOR, type, rendered.body]));
    const bodyHash = contentHash(rendered.body);
    const previous = store.artifacts.latest(projectId, name);
    const existing = await readIfExists(file);
    const managed = existing === undefined ? undefined : splitManaged(existing);

    let tail = DEFAULT_TAIL;
    let status: ArtifactOutcome["status"];
    if (existing !== undefined && managed === undefined) {
      if (!options.force) {
        outcomes.push({ name, type, path: relative, status: "conflict", revision: previous?.revision, reason: "file exists without intact loom markers; not overwritten (use --force)" });
        continue;
      }
      tail = `\n\n## Previous content\n\n${existing}`;
      status = previous === undefined ? "created" : "updated";
    } else if (managed !== undefined && previous !== undefined && contentHash(managed.generated) !== previous.contentHash) {
      if (!options.force) {
        outcomes.push({ name, type, path: relative, status: "conflict", revision: previous.revision, reason: "generated section was edited by hand; not overwritten (move edits below the end marker, or use --force)" });
        continue;
      }
      tail = managed.tail;
      status = "updated";
    } else if (managed !== undefined && previous === undefined) {
      tail = managed.tail;
      status = "created";
    } else if (managed !== undefined && previous !== undefined) {
      tail = managed.tail;
      if (previous.inputHash === inputHash) {
        outcomes.push({ name, type, path: relative, status: "unchanged", revision: previous.revision });
        continue;
      }
      status = "updated";
    } else {
      status = previous === undefined ? "created" : previous.inputHash === inputHash ? "restored" : "updated";
    }

    const revision = status === "restored" ? previous!.revision : (previous?.revision ?? 0) + 1;
    if (!options.dryRun) {
      await atomicWrite(file, compose(name, type, revision, inputHash, rendered.body, tail));
      if (status !== "restored") {
        store.transaction(() => {
          store.artifacts.insert(projectId, {
            type,
            name,
            revision,
            path: relative,
            inputHash,
            contentHash: bodyHash,
            sourceIds: rendered.sourceIds,
            recordIds: rendered.recordIds,
            generator: { ...GENERATOR },
          });
          store.audit(projectId, "artifacts.generate", options.actor, [name]);
        });
      }
    }
    outcomes.push({ name, type, path: relative, status, revision });
  }
  return outcomes;
}
