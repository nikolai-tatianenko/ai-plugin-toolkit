import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoomStore } from "@ai-plugin-toolkit/storage-sqlite";
import {
  acceptCriterion,
  activatePack,
  addEvidence,
  answerQuestion,
  criterionId,
  evaluatePack,
  loadBuiltinPack,
  parsePack,
  selectQuestions,
  setRevision,
  waiveCriterion,
  type TopicPack,
} from "../src/index.js";

let dir: string;
let store: LoomStore;
let pack: TopicPack;
const P = "habit";
const actor = "pat";

const answer = (question: string, value: string) => answerQuestion(store, P, pack, { question, value, actor });
const evidence = (criterion: string, result: "passed" | "failed" | "inconclusive", environment: string, revision = "r1") =>
  addEvidence(store, P, pack, { criterion, result, revision, environment: environment as never, actor });
const criterion = (key: string) => evaluatePack(store, P, pack).criteria.find((c) => c.key === key)!;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "loom-acceptance-"));
  store = await LoomStore.open({ storageDir: dir });
  store.ensureProject(P, "Habit");
  pack = await loadBuiltinPack("mobile-release");
  activatePack(store, P, pack, actor);
  setRevision(store, P, "r1", actor);
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("mobile-release pack", () => {
  it("is valid, versioned and advisory about platform rules", () => {
    expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pack.advisory).toMatch(/NOT been reviewed/);
    expect(pack.criteria.every((c) => !(c.verification.environments as string[]).includes("mock"))).toBe(true);
  });

  it("rejects packs that reference unknown questions, answers or criteria, or accept mock evidence", () => {
    const base = structuredClone(pack) as Record<string, any>;
    base.criteria[0].applicableWhen = { question: "nope", equals: "yes" };
    expect(() => parsePack(base)).toThrow(/Unknown question "nope"/);
    const badValue = structuredClone(pack) as Record<string, any>;
    badValue.criteria[0].applicableWhen = { question: "platforms", equals: "windows" };
    expect(() => parsePack(badValue)).toThrow(/not a possible answer/);
    const mock = structuredClone(pack) as Record<string, any>;
    mock.criteria[0].verification.environments = ["mock"];
    expect(() => parsePack(mock)).toThrow();
  });
});

describe("applicability and questions", () => {
  it("A09: no purchases makes purchase criteria not-applicable with a recorded rationale", () => {
    answer("purchases", "no");
    const restore = criterion("purchases.restore");
    expect(restore.applicability).toBe("not-applicable");
    expect(restore.applicabilityRationale).toMatch(/"purchases" was answered "no" by pat/);
    expect(restore.basis[0]).toMatchObject({ question: "purchases", value: "no", answeredBy: "pat" });
  });

  it("unanswered questions leave criteria unresolved and block readiness", () => {
    const evaluation = evaluatePack(store, P, pack);
    expect(criterion("purchases.flow").applicability).toBe("unresolved");
    expect(evaluation.readiness.status).toBe("not-ready");
    expect(evaluation.readiness.blocking).toContainEqual({ criterion: "purchases.flow", reason: "applicability unresolved (unanswered question)" });
  });

  it("A08: an existing valid answer is not asked again; a reworded question is", () => {
    answer("purchases", "no");
    for (const mode of ["quick", "guided"] as const) {
      expect(selectQuestions(store, P, evaluatePack(store, P, pack), mode, 50).map((q) => q.id)).not.toContain("purchases");
    }
    const reworded = parsePack({
      ...pack,
      version: "0.2.0",
      questions: pack.questions.map((q) => (q.id === "purchases" ? { ...q, text: "Does this release sell anything?" } : q)),
    });
    const evaluation = evaluatePack(store, P, reworded);
    expect(evaluation.questions.find((q) => q.question.id === "purchases")!.state).toBe("stale");
    expect(evaluation.criteria.find((c) => c.key === "purchases.flow")!.applicability).toBe("unresolved");
    const asked = selectQuestions(store, P, evaluation, "guided", 50).find((q) => q.id === "purchases");
    expect(asked?.reason).toBe("the question changed since it was answered");
  });

  it("quick mode asks only high-impact or blocker-deciding questions, highest priority first", () => {
    const quick = selectQuestions(store, P, evaluatePack(store, P, pack), "quick");
    expect(quick.length).toBeLessThanOrEqual(5);
    const ids = new Set(pack.questions.filter((q) => q.impact === "high").map((q) => q.id));
    for (const item of quick) expect(ids.has(item.id) || item.reason.startsWith("decides")).toBe(true);
    const priorities = quick.map((q) => q.priority);
    expect([...priorities].sort((a, b) => b - a)).toEqual(priorities);
  });

  it("rejects answers outside the allowed values", () => {
    expect(() => answer("platforms", "windows")).toThrow(/expects one of: ios, android, both/);
    expect(answer("accounts", "Y").value).toBe("yes");
  });
});

describe("verification and disposition", () => {
  beforeEach(() => {
    answer("offline", "yes");
  });

  it("A10: a closed task is not evidence — the criterion stays not-checked/open", () => {
    const id = criterionId(P, pack.id, "offline.core-flows");
    store.tasks.upsert(P, { id: "tsk_00000000000000000000000001", origin: "test", title: "Offline", criterionIds: [id], dependsOn: [] });
    store.tasks.setStatusFromRemote(P, "tsk_00000000000000000000000001", "closed");
    expect(criterion("offline.core-flows")).toMatchObject({ verification: "not-checked", disposition: "open" });
    const challenge = selectQuestions(store, P, evaluatePack(store, P, pack), "challenge");
    expect(challenge.some((c) => c.reason === "completion claim without evidence")).toBe(true);
  });

  it("A11: emulator or mock evidence does not verify a physical-device requirement", () => {
    evidence("offline.core-flows", "passed", "emulator");
    evidence("offline.core-flows", "passed", "mock");
    const c = criterion("offline.core-flows");
    expect(c.verification).toBe("not-checked");
    expect(c.notes.join("\n")).toMatch(/emulator evidence does not satisfy/);
    expect(c.notes.join("\n")).toMatch(/mock evidence does not satisfy/);

    evidence("offline.core-flows", "passed", "physical-device");
    expect(criterion("offline.core-flows").verification).toBe("passed");
  });

  it("A12: a pass becomes stale when the build revision changes", () => {
    evidence("offline.core-flows", "passed", "physical-device", "r1");
    expect(criterion("offline.core-flows").verification).toBe("passed");
    setRevision(store, P, "r2", actor);
    const c = criterion("offline.core-flows");
    expect(c.verification).toBe("stale");
    expect(c.evidenceIds).toEqual([]);
    expect(c.notes[0]).toMatch(/passed at revision r1, but the current revision is r2/);
  });

  it("the latest decisive result at the current revision wins; inconclusive does not count", () => {
    evidence("offline.core-flows", "passed", "physical-device");
    evidence("offline.core-flows", "failed", "physical-device");
    expect(criterion("offline.core-flows").verification).toBe("failed");
    evidence("offline.core-flows", "inconclusive", "physical-device");
    expect(criterion("offline.core-flows").verification).toBe("failed");
  });

  it("A13: a waiver records actor and reason and is never shown as passed", () => {
    evidence("offline.core-flows", "failed", "physical-device");
    expect(() => waiveCriterion(store, P, pack, { criterion: "offline.core-flows", actor, reason: " " })).toThrow(/reason/);
    waiveCriterion(store, P, pack, { criterion: "offline.core-flows", actor: "lead", reason: "Offline sync ships in 1.1" });
    const c = criterion("offline.core-flows");
    expect(c).toMatchObject({ verification: "failed", disposition: "waived", waiver: { actor: "lead", reason: "Offline sync ships in 1.1" } });
    expect(evaluatePack(store, P, pack).readiness.waived).toContain("offline.core-flows");
  });

  it("acceptance by a person is separate from technical verification", () => {
    acceptCriterion(store, P, pack, { criterion: "offline.core-flows", actor: "lead" });
    expect(criterion("offline.core-flows")).toMatchObject({ disposition: "accepted", verification: "not-checked" });
    expect(evaluatePack(store, P, pack).readiness.blocking.map((b) => b.criterion)).toContain("offline.core-flows");
  });

  it("is ready only when every applicable blocker and major criterion passed or was waived", () => {
    for (const [q, v] of [["platforms", "android"], ["accounts", "no"], ["purchases", "no"], ["ads", "no"], ["children", "no"], ["personal-data", "no"], ["remote-data", "no"], ["notifications", "no"]] as const) {
      answer(q, v);
    }
    const env: Record<string, string> = {};
    for (const c of evaluatePack(store, P, pack).criteria.filter((c) => c.applicability === "applicable" && c.severity !== "minor")) {
      env[c.key] = c.acceptedEnvironments[0]!;
      evidence(c.key, "passed", c.acceptedEnvironments[0]!);
    }
    const evaluation = evaluatePack(store, P, pack);
    expect(evaluation.readiness).toMatchObject({ status: "ready", blocking: [], minorGaps: ["store.assets"] });
    setRevision(store, P, "r2", actor);
    expect(evaluatePack(store, P, pack).readiness.status).toBe("not-ready");
  });
});

describe("condition rationale", () => {
  it("cites only the answers that decided a not-applicable result", () => {
    answer("personal-data", "yes");
    answer("remote-data", "no");
    const c = criterion("privacy.server-deletion");
    expect(c.applicability).toBe("not-applicable");
    expect(c.basis.map((b) => b.question)).toEqual(["remote-data"]);
    expect(c.applicabilityRationale).not.toContain("personal-data");
  });
});
