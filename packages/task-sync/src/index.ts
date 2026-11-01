import type { Evaluation } from "@ai-plugin-toolkit/acceptance";
import {
  LoomError,
  contentHash,
  isLoomError,
  requireTaskCapability,
  stableId,
  supportsTaskCapability,
  type ExternalTask,
  type TaskAdapter,
} from "@ai-plugin-toolkit/core";
import type { LocalTask, LoomStore, SyncMappingRecord } from "@ai-plugin-toolkit/storage-sqlite";

/**
 * Task change sets and one-way publishing (CL-010, plan §8). Loom owns task titles and
 * descriptions it generated; the external system owns status. Remote edits are never
 * overwritten: they are reported. Nothing here closes a task.
 */

export interface PlannedTask {
  id: string;
  origin: string;
  title: string;
  description: string;
  criterionIds: string[];
  dependsOn: string[];
}

export const taskIdFor = (projectId: string, criterionId: string) => stableId("task", projectId, "criterion", criterionId);
export const idempotencyKeyFor = (projectId: string, taskId: string) => `loom:${projectId}:${taskId}`;

/** Derive tasks from criteria that are applicable, not passed and not waived. Pure: no writes. */
export function derivePlannedTasks(projectId: string, evaluations: readonly Evaluation[]): PlannedTask[] {
  const planned: PlannedTask[] = [];
  for (const evaluation of evaluations) {
    const open = evaluation.criteria.filter((c) => c.applicability === "applicable" && c.verification !== "passed" && c.disposition !== "waived");
    const byKey = new Map(open.map((c) => [c.key, c]));
    for (const c of open) {
      const id = taskIdFor(projectId, c.id);
      planned.push({
        id,
        origin: `criterion:${evaluation.pack.id}:${c.key}`,
        title: c.taskTitle,
        description: [
          c.taskDescription,
          "",
          `Acceptance criterion: ${c.key} (${c.severity}) — ${c.expected}`,
          `Verify with: ${c.verificationMethod} Accepted evidence: ${c.acceptedEnvironments.join(", ")}.`,
          `Managed by Context Loom (${id}). Closing this task does not mark the criterion as passed; record evidence with \`loom evidence add\`.`,
        ].join("\n"),
        criterionIds: [c.id],
        dependsOn: c.dependsOn.filter((k) => byKey.has(k)).map((k) => taskIdFor(projectId, byKey.get(k)!.id)),
      });
    }
  }
  return planned;
}

export type ChangeKind = "create" | "adopt" | "update" | "link" | "unchanged" | "conflict" | "remote-edited" | "missing-remote" | "retire";

export interface Change {
  kind: ChangeKind;
  taskId: string;
  title: string;
  externalId?: string;
  dependsOnTaskId?: string;
  dependsOnExternalId?: string;
  reason: string;
}

export interface ChangeSet {
  adapter: { name: string; version: string; upstream: string };
  changes: Change[];
  counts: Partial<Record<ChangeKind, number>>;
  pendingIntents: number;
}

function plannedHash(t: PlannedTask): string {
  return contentHash(JSON.stringify([t.title, t.description, t.criterionIds, t.dependsOn]));
}

interface Comparison {
  planned: PlannedTask;
  local: LocalTask | undefined;
  /** Revision the local task has, or will have once the plan is persisted. */
  revision: number;
}

function compareWithLocal(store: LoomStore, projectId: string, planned: readonly PlannedTask[]): Comparison[] {
  return planned.map((p) => {
    const local = store.tasks.get(projectId, p.id);
    const revision = local === undefined ? 1 : local.contentHash === plannedHash(p) ? local.revision : local.revision + 1;
    return { planned: p, local, revision };
  });
}

async function readRemote(adapter: TaskAdapter): Promise<Map<string, ExternalTask> | undefined> {
  if (!supportsTaskCapability(adapter, "readTasks")) return undefined;
  const tasks = await requireTaskCapability(adapter, "readTasks")();
  return new Map(tasks.map((t) => [t.externalId, t]));
}

function buildChanges(
  store: LoomStore,
  projectId: string,
  adapter: TaskAdapter,
  comparisons: readonly Comparison[],
  remote: Map<string, ExternalTask> | undefined,
): Change[] {
  const name = adapter.manifest.name;
  const changes: Change[] = [];
  const byKey = new Map([...(remote?.values() ?? [])].filter((t) => t.idempotencyKey !== undefined).map((t) => [t.idempotencyKey!, t]));
  const externalOf = new Map<string, string | undefined>();

  for (const { planned, revision } of comparisons) {
    const mapping = store.tasks.mapping(projectId, name, planned.id);
    const base = { taskId: planned.id, title: planned.title };
    if (mapping === undefined) {
      const adopted = byKey.get(idempotencyKeyFor(projectId, planned.id));
      if (adopted !== undefined) {
        externalOf.set(planned.id, adopted.externalId);
        changes.push({ ...base, kind: "adopt", externalId: adopted.externalId, reason: "remote task with this idempotency key exists but was not recorded (interrupted run); adopting it instead of creating a duplicate" });
      } else {
        externalOf.set(planned.id, undefined);
        changes.push({ ...base, kind: "create", reason: "no remote task yet" });
      }
      continue;
    }
    externalOf.set(planned.id, mapping.externalId);
    const current = remote?.get(mapping.externalId);
    if (remote !== undefined && current === undefined) {
      changes.push({ ...base, kind: "missing-remote", externalId: mapping.externalId, reason: "mapped remote task no longer exists; not recreated automatically" });
      continue;
    }
    const remoteChanged = current !== undefined && mapping.lastRemoteRevision !== undefined && current.revision !== mapping.lastRemoteRevision;
    const localChanged = revision > mapping.lastLocalRevision;
    if (localChanged && remoteChanged) {
      changes.push({ ...base, kind: "conflict", externalId: mapping.externalId, reason: "both the local plan and the remote task changed since the last sync; remote edits are kept" });
    } else if (localChanged) {
      changes.push({ ...base, kind: "update", externalId: mapping.externalId, reason: `local revision ${mapping.lastLocalRevision} → ${revision}` });
    } else if (remoteChanged) {
      changes.push({ ...base, kind: "remote-edited", externalId: mapping.externalId, reason: "remote task was edited outside Loom; edits are kept and not overwritten" });
    } else {
      changes.push({ ...base, kind: "unchanged", externalId: mapping.externalId, reason: "in sync" });
    }
  }

  for (const { planned } of comparisons) {
    const mapping = store.tasks.mapping(projectId, name, planned.id);
    const externalId = externalOf.get(planned.id);
    const remoteDeps = new Set(externalId === undefined ? [] : (remote?.get(externalId)?.dependsOn ?? []));
    for (const dep of planned.dependsOn) {
      const depExternal = externalOf.get(dep);
      if (depExternal !== undefined && (mapping?.linkedDeps.includes(depExternal) || remoteDeps.has(depExternal))) continue;
      changes.push({
        kind: "link",
        taskId: planned.id,
        title: planned.title,
        ...(externalId === undefined ? {} : { externalId }),
        dependsOnTaskId: dep,
        ...(depExternal === undefined ? {} : { dependsOnExternalId: depExternal }),
        reason: "dependency not yet linked remotely",
      });
    }
  }

  const plannedIds = new Set(comparisons.map((c) => c.planned.id));
  for (const task of store.tasks.list(projectId)) {
    if (!plannedIds.has(task.id)) changes.push({ kind: "retire", taskId: task.id, title: task.title, reason: "criterion passed, waived or no longer applicable; remote task is left as is" });
  }
  return changes;
}

function summarize(adapter: TaskAdapter, changes: Change[], pendingIntents: number): ChangeSet {
  const counts: ChangeSet["counts"] = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  const m = adapter.manifest;
  return { adapter: { name: m.name, version: m.version, upstream: `${m.upstream.name} ${m.upstream.versionRange}` }, changes, counts, pendingIntents };
}

/** CL-010/A14: compute the change set. Reads local state and the remote; writes nothing anywhere. */
export async function previewSync(store: LoomStore, projectId: string, adapter: TaskAdapter, evaluations: readonly Evaluation[]): Promise<ChangeSet> {
  const comparisons = compareWithLocal(store, projectId, derivePlannedTasks(projectId, evaluations));
  const remote = await readRemote(adapter);
  return summarize(adapter, buildChanges(store, projectId, adapter, comparisons, remote), store.tasks.pendingIntents(projectId, adapter.manifest.name).length);
}

export interface SyncResult extends ChangeSet {
  runId: string;
  status: "ok" | "partial" | "error";
  applied: Change[];
  failures: Array<{ change: Change; code: string; message: string }>;
}

export interface SyncOptions {
  allowWrites: boolean;
  actor: string;
  /** Test seam: called after each successful remote create, before its mapping is saved. */
  afterRemoteCreate?: (task: ExternalTask) => void;
}

/**
 * Publish the change set (one-way). Requires explicit project policy for writes.
 * Every remote create is preceded by a durable intent and followed by its mapping, so
 * an interrupted run is reconciled by idempotency key instead of creating duplicates (A15, A17).
 */
export async function applySync(
  store: LoomStore,
  projectId: string,
  adapter: TaskAdapter,
  evaluations: readonly Evaluation[],
  options: SyncOptions,
): Promise<SyncResult> {
  if (!options.allowWrites) {
    throw new LoomError("POLICY_VIOLATION", "Publishing tasks is disabled for this project. Set tasks.allowWrites to true in loom.config.json, or use `loom tasks preview`.");
  }
  const name = adapter.manifest.name;
  const pending = store.tasks.pendingIntents(projectId, name);
  if (pending.some((i) => i.operation === "create") && !supportsTaskCapability(adapter, "readTasks")) {
    throw new LoomError("CONFLICT", `${pending.length} interrupted create(s) cannot be reconciled: adapter "${name}" cannot read remote tasks. Resolve manually before retrying.`);
  }

  // Persist the plan locally (internal state only), then compute the change set against it.
  const planned = derivePlannedTasks(projectId, evaluations);
  store.transaction(() => {
    for (const p of planned) store.tasks.upsert(projectId, p);
    const ids = new Set(planned.map((p) => p.id));
    for (const t of store.tasks.list(projectId)) if (!ids.has(t.id)) store.tasks.retire(projectId, t.id);
  });
  const remote = await readRemote(adapter);
  const runId = store.tasks.startRun(projectId, name);
  const comparisons = compareWithLocal(store, projectId, planned);
  const changes = buildChanges(store, projectId, adapter, comparisons, remote);
  const local = new Map(store.tasks.list(projectId).map((t) => [t.id, t]));
  const applied: Change[] = [];
  const failures: SyncResult["failures"] = [];
  const touched = new Set<string>();
  const version = adapter.manifest.version;

  const fail = (change: Change, error: unknown) =>
    failures.push({ change, code: isLoomError(error) ? error.code : "INTERNAL", message: error instanceof Error ? error.message : String(error) });

  for (const change of changes.filter((c) => c.kind === "adopt" || c.kind === "create")) {
    const task = local.get(change.taskId)!;
    const key = idempotencyKeyFor(projectId, task.id);
    try {
      if (change.kind === "adopt") {
        const existing = remote!.get(change.externalId!)!;
        store.transaction(() => {
          store.tasks.saveMapping(projectId, { taskId: task.id, adapter: name, adapterVersion: version, externalId: existing.externalId, idempotencyKey: key, lastLocalRevision: task.revision, lastRemoteRevision: existing.revision, linkedDeps: existing.dependsOn ?? [] });
          store.tasks.finishIntent(projectId, name, key, "create", "done");
        });
        // Content that differs may hold manual edits made after the interrupted run: report, never overwrite.
        if (existing.title !== task.title || (existing.description ?? "") !== (task.description ?? "")) {
          changes.push({ ...change, kind: "conflict", reason: "adopted remote task differs from the local plan; remote content kept" });
        }
      } else {
        const create = requireTaskCapability(adapter, "createTask");
        store.tasks.beginIntent(projectId, name, { idempotencyKey: key, operation: "create", taskId: task.id });
        const created = await create({ title: task.title, ...(task.description === undefined ? {} : { description: task.description }), idempotencyKey: key });
        options.afterRemoteCreate?.(created);
        store.transaction(() => {
          store.tasks.saveMapping(projectId, { taskId: task.id, adapter: name, adapterVersion: version, externalId: created.externalId, idempotencyKey: key, lastLocalRevision: task.revision, lastRemoteRevision: created.revision, linkedDeps: [] });
          store.tasks.finishIntent(projectId, name, key, "create", "done");
        });
        change.externalId = created.externalId;
      }
      touched.add(task.id);
      applied.push(change);
    } catch (error) {
      fail(change, error);
    }
  }

  for (const change of changes.filter((c) => c.kind === "update")) {
    const task = local.get(change.taskId)!;
    const mapping = store.tasks.mapping(projectId, name, task.id)!;
    try {
      const update = requireTaskCapability(adapter, "updateTask");
      const key = mapping.idempotencyKey;
      store.tasks.beginIntent(projectId, name, { idempotencyKey: key, operation: `update:${task.revision}`, taskId: task.id });
      const updated = await update(mapping.externalId, { title: task.title, ...(task.description === undefined ? {} : { description: task.description }) }, mapping.lastRemoteRevision ?? "");
      store.transaction(() => {
        store.tasks.saveMapping(projectId, { ...mappingInput(mapping), lastLocalRevision: task.revision, lastRemoteRevision: updated.revision });
        store.tasks.finishIntent(projectId, name, key, `update:${task.revision}`, "done");
      });
      touched.add(task.id);
      applied.push(change);
    } catch (error) {
      store.tasks.finishIntent(projectId, name, mapping.idempotencyKey, `update:${task.revision}`, "failed");
      if (isLoomError(error) && error.code === "CONFLICT") {
        changes.push({ ...change, kind: "conflict", reason: `remote changed during sync: ${error.message}` });
      } else {
        fail(change, error);
      }
    }
  }

  for (const change of changes.filter((c) => c.kind === "link")) {
    const from = store.tasks.mapping(projectId, name, change.taskId);
    const to = change.dependsOnTaskId === undefined ? undefined : store.tasks.mapping(projectId, name, change.dependsOnTaskId);
    if (from === undefined || to === undefined) {
      failures.push({ change, code: "CONFLICT", message: "dependency endpoint was not created; will retry next run" });
      continue;
    }
    try {
      await requireTaskCapability(adapter, "linkDependency")(from.externalId, to.externalId);
      store.tasks.saveMapping(projectId, { ...mappingInput(from), linkedDeps: [...new Set([...from.linkedDeps, to.externalId])] });
      touched.add(change.taskId);
      applied.push({ ...change, externalId: from.externalId, dependsOnExternalId: to.externalId });
    } catch (error) {
      fail(change, error);
    }
  }

  // Refresh remote revisions of tasks we wrote (our own writes must not look like remote edits),
  // and pull status, which the external system owns.
  const after = await readRemote(adapter).catch(() => undefined);
  if (after !== undefined) {
    store.transaction(() => {
      for (const mapping of store.tasks.mappings(projectId, name)) {
        const current = after.get(mapping.externalId);
        if (current === undefined) continue;
        if (touched.has(mapping.taskId)) store.tasks.saveMapping(projectId, { ...mappingInput(mapping), lastRemoteRevision: current.revision });
        store.tasks.setStatusFromRemote(projectId, mapping.taskId, current.status);
      }
    });
  }

  const status = failures.length === 0 ? "ok" : applied.length > 0 ? "partial" : "error";
  const summary = summarize(adapter, changes, store.tasks.pendingIntents(projectId, name).length);
  store.tasks.finishRun(runId, status, { counts: summary.counts, applied: applied.length, failures: failures.map((f) => ({ taskId: f.change.taskId, kind: f.change.kind, code: f.code })) });
  store.audit(projectId, "tasks.sync", options.actor, applied.map((c) => c.taskId), status === "error" ? "EXTERNAL_TOOL_FAILED" : undefined);
  return { ...summary, runId, status, applied, failures };
}

function mappingInput(m: SyncMappingRecord): Omit<SyncMappingRecord, "id" | "syncedAt"> {
  return {
    taskId: m.taskId,
    adapter: m.adapter,
    adapterVersion: m.adapterVersion,
    externalId: m.externalId,
    idempotencyKey: m.idempotencyKey,
    lastLocalRevision: m.lastLocalRevision,
    lastRemoteRevision: m.lastRemoteRevision,
    linkedDeps: m.linkedDeps,
  };
}
