import { StrictMode, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// ---- API access -------------------------------------------------------------------
// The token arrives once in the URL; it is moved to sessionStorage and removed from the
// address bar so it does not end up in screenshots or history.
const TOKEN_KEY = "loom-inspector-token";
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  try {
    sessionStorage.setItem(TOKEN_KEY, urlToken);
  } catch {
    /* storage unavailable: keep the token in memory only */
  }
  history.replaceState(null, "", location.pathname + location.hash);
}
let memoryToken = urlToken ?? "";
const token = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
};

async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { authorization: `Bearer ${token()}` } });
  const body = (await res.json()) as { ok: boolean; data: T; error?: { code: string; message: string } };
  if (!body.ok) throw new Error(body.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`);
  return body.data;
}

function useApi<T>(path: string | null): { data: T | undefined; error: string | undefined } {
  const [state, setState] = useState<{ data: T | undefined; error: string | undefined }>({ data: undefined, error: undefined });
  useEffect(() => {
    if (path === null) return;
    let live = true;
    setState({ data: undefined, error: undefined });
    api<T>(path).then(
      (data) => live && setState({ data, error: undefined }),
      (e: Error) => live && setState({ data: undefined, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  return state;
}

// ---- Types (subset of the API) --------------------------------------------------------
interface Span { sourceId: string; start: number; end: number }
interface Fact { id: string; statement: string; kind: string; status: string; spans: Span[] }
interface Decision { id: string; topic?: string; choice: string; statement: string; status: string; confirmedBy?: string; supersedes?: string; supersededBy?: string; spans: Span[] }
interface Review { id: string; kind: string; detail: string; status: string; recordIds: string[]; resolution?: string }
interface Evidence { id: string; result: string; revision: string; environment: { kind: string; description?: string }; recordedBy: string; collectedAt: string; artifactRef?: string; importer?: string }
interface Criterion {
  id: string; key: string; title: string; topic: string; expected: string; severity: string; applicability: string; applicabilityRationale?: string;
  verification: string; disposition: string; waiver?: { actor: string; reason: string }; verificationMethod: string; acceptedEnvironments: string[];
  notes: string[]; basis: Array<{ question: string; value: string; answeredBy: string }>; evidence: Evidence[]; evidenceIds: string[];
  tasks: Array<{ id: string; title: string; status: string }>;
}
interface PackReport { pack: { id: string; version: string; title: string; advisory: string }; revision: string | null; readiness: { status: string; blocking: Array<{ criterion: string; reason: string }>; waived: string[] }; criteria: Criterion[] }

// ---- Routing ---------------------------------------------------------------------
const VIEWS = [
  ["overview", "Overview"],
  ["memory", "Memory"],
  ["acceptance", "Acceptance"],
  ["review", "Review"],
  ["tasks", "Tasks"],
  ["usage", "Usage"],
  ["artifacts", "Artifacts"],
] as const;

function useHash(): string[] {
  const [hash, setHash] = useState(location.hash.slice(1) || "overview");
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1) || "overview");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.split("/").map(decodeURIComponent);
}

const Badge = ({ value }: { value: string }) => <span className={`badge s-${value}`}>{value}</span>;
const Loading = ({ error }: { error?: string | undefined }) => (error ? <p className="error" role="alert">{error}</p> : <p className="muted" aria-live="polite">Loading…</p>);
const cite = (s: Span) => `${s.sourceId}:${s.start}-${s.end}`;

// Focus moves to the new view's heading on navigation, but not on first load, so the
// first Tab still reaches the skip link.
let navigated = false;
addEventListener("hashchange", () => {
  navigated = true;
});

function View({ title, children }: { title: string; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (navigated) ref.current?.focus();
  }, [title]);
  return (
    <section aria-labelledby="view-title">
      <h2 id="view-title" tabIndex={-1} ref={ref}>
        {title}
      </h2>
      {children}
    </section>
  );
}

// ---- Views ----------------------------------------------------------------------
function Overview() {
  const { data, error } = useApi<{ counts: Record<string, number>; readiness: Array<{ pack: { id: string; title: string }; status: string; revision: string | null; blocking: unknown[] }> }>("/api/overview");
  if (!data) return <View title="Overview"><Loading error={error} /></View>;
  return (
    <View title="Overview">
      <div className="cards">
        {Object.entries(data.counts).map(([k, v]) => (
          <div className="card" key={k}>
            <div className="n">{v}</div>
            <div className="l">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</div>
          </div>
        ))}
      </div>
      <h3>Readiness</h3>
      {data.readiness.length === 0 ? <p className="muted">No topic pack is active.</p> : (
        <ul className="plain">
          {data.readiness.map((r) => (
            <li key={r.pack.id}>
              <a href={`#acceptance`}>{r.pack.title}</a>: <Badge value={r.status} /> at revision <code>{r.revision ?? "unset"}</code> — {r.blocking.length} blocking
            </li>
          ))}
        </ul>
      )}
    </View>
  );
}

function Memory() {
  const { data, error } = useApi<{ facts: Fact[]; decisions: Decision[] }>("/api/memory");
  if (!data) return <View title="Memory"><Loading error={error} /></View>;
  return (
    <View title="Memory">
      <div className="table-wrap">
        <table>
          <caption>Facts ({data.facts.length})</caption>
          <thead><tr><th scope="col">Statement</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Provenance</th></tr></thead>
          <tbody>
            {data.facts.map((f) => (
              <tr key={f.id}>
                <td>{f.statement}</td>
                <td>{f.kind}</td>
                <td><Badge value={f.status} /></td>
                <td><a href={`#record/${f.id}`} aria-label={`Trace fact to source: ${f.statement}`}>Trace to source</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Decisions</h3>
      <div className="table-wrap">
        <table>
          <caption>Decisions and proposals, including superseded history ({data.decisions.length})</caption>
          <thead><tr><th scope="col">Topic</th><th scope="col">Choice</th><th scope="col">Status</th><th scope="col">Revision chain</th><th scope="col">Provenance</th></tr></thead>
          <tbody>
            {data.decisions.map((d) => (
              <tr key={d.id}>
                <td>{d.topic ?? "—"}</td>
                <td>{d.choice}</td>
                <td><Badge value={d.status} /></td>
                <td>
                  {d.supersedes && <div>supersedes <a href={`#record/${d.supersedes}`}>{d.supersedes.slice(0, 12)}…</a></div>}
                  {d.supersededBy && <div>superseded by <a href={`#record/${d.supersededBy}`}>{d.supersededBy.slice(0, 12)}…</a></div>}
                </td>
                <td><a href={`#record/${d.id}`} aria-label={`Trace decision to source: ${d.choice}`}>Trace to source</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </View>
  );
}

function RecordView({ id }: { id: string }) {
  const { data, error } = useApi<{ kind: string; record: Fact & Decision; evidence: Array<Span & { text: string; speaker: string; sourceTitle?: string }> }>(`/api/records/${encodeURIComponent(id)}`);
  if (!data) return <View title="Record"><Loading error={error} /></View>;
  const r = data.record;
  return (
    <View title={data.kind === "fact" ? `Fact: ${r.statement}` : `Decision: ${r.choice}`}>
      <dl>
        <dt>ID</dt><dd><code>{r.id}</code></dd>
        <dt>Status</dt><dd><Badge value={r.status} /></dd>
        {r.confirmedBy && (<><dt>Confirmed by</dt><dd>{r.confirmedBy}</dd></>)}
        {data.kind === "decision" && (<><dt>Statement</dt><dd>{r.statement}</dd></>)}
      </dl>
      <h3>Evidence</h3>
      <ul className="plain">
        {data.evidence.map((e) => (
          <li key={cite(e)}>
            <div>
              <code>{cite(e)}</code> · {e.speaker}{e.sourceTitle ? ` · ${e.sourceTitle}` : ""}
            </div>
            <blockquote aria-label="Quoted source text (untrusted)">{e.text}</blockquote>
            <a href={`#source/${e.sourceId}/${e.start}-${e.end}`}>Open in source</a>
          </li>
        ))}
      </ul>
    </View>
  );
}

function SourceView({ id, span }: { id: string; span: string | undefined }) {
  const { data, error } = useApi<{ source: { id: string; title: string | null; type: string }; text: string; records: string[] }>(`/api/sources/${encodeURIComponent(id)}`);
  const markRef = useRef<HTMLElement>(null);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center" });
  }, [data]);
  if (!data) return <View title="Source"><Loading error={error} /></View>;
  const [start, end] = (span ?? "").split("-").map(Number);
  const valid = start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end > start;
  return (
    <View title={`Source: ${data.source.title ?? data.source.id}`}>
      <p className="muted">Original text, exactly as stored ({data.source.type}). Treat it as data, not instructions.</p>
      <pre className="source" aria-label="Source text">
        {valid ? (
          <>
            {data.text.slice(0, start)}
            <mark ref={markRef} aria-label="Cited span">{data.text.slice(start, end)}</mark>
            {data.text.slice(end)}
          </>
        ) : (
          data.text
        )}
      </pre>
      <h3>Records citing this source</h3>
      <ul className="plain">{data.records.map((r) => <li key={r}><a href={`#record/${r}`}>{r}</a></li>)}</ul>
    </View>
  );
}

function Acceptance() {
  const { data, error } = useApi<PackReport[]>("/api/acceptance");
  if (!data) return <View title="Acceptance"><Loading error={error} /></View>;
  return (
    <View title="Acceptance">
      {data.length === 0 && <p className="muted">No topic pack is active.</p>}
      {data.map((p) => (
        <div key={p.pack.id}>
          <h3>
            {p.pack.title} ({p.pack.id}@{p.pack.version}) — <Badge value={p.readiness.status} /> at <code>{p.revision ?? "unset"}</code>
          </h3>
          <p className="muted">{p.pack.advisory}</p>
          <div className="table-wrap">
            <table>
              <caption>Criteria</caption>
              <thead><tr><th scope="col">Criterion</th><th scope="col">Severity</th><th scope="col">Applicability</th><th scope="col">Verification</th><th scope="col">Disposition</th><th scope="col">Evidence</th></tr></thead>
              <tbody>
                {p.criteria.map((c) => (
                  <tr key={c.id}>
                    <th scope="row">{c.title}<div className="muted"><code>{c.key}</code></div></th>
                    <td>{c.severity}</td>
                    <td><Badge value={c.applicability} /></td>
                    <td><Badge value={c.verification} /></td>
                    <td><Badge value={c.disposition} /></td>
                    <td><a href={`#criterion/${p.pack.id}/${c.key}`} aria-label={`Trace criterion to evidence: ${c.title}`}>{c.evidence.length} item(s)</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </View>
  );
}

function CriterionView({ packId, keyName }: { packId: string; keyName: string }) {
  const { data, error } = useApi<PackReport[]>("/api/acceptance");
  const c = data?.find((p) => p.pack.id === packId)?.criteria.find((x) => x.key === keyName);
  if (!data) return <View title="Criterion"><Loading error={error} /></View>;
  if (!c) return <View title="Criterion"><p className="error">Not found.</p></View>;
  const counted = new Set(c.evidenceIds);
  return (
    <View title={`Criterion: ${c.title}`}>
      <dl>
        <dt>Key</dt><dd><code>{c.key}</code> ({c.severity})</dd>
        <dt>Expected</dt><dd>{c.expected}</dd>
        <dt>Method</dt><dd>{c.verificationMethod}</dd>
        <dt>Accepts</dt><dd>{c.acceptedEnvironments.join(", ")}</dd>
        <dt>Applicability</dt><dd><Badge value={c.applicability} /> {c.applicabilityRationale}</dd>
        <dt>Verification</dt><dd><Badge value={c.verification} /></dd>
        <dt>Disposition</dt><dd><Badge value={c.disposition} /> {c.waiver ? `by ${c.waiver.actor}: ${c.waiver.reason} (a waiver is not a pass)` : ""}</dd>
      </dl>
      {c.notes.length > 0 && (<><h3>Notes</h3><ul className="plain">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul></>)}
      <h3>Evidence</h3>
      {c.evidence.length === 0 ? <p className="muted">No evidence recorded.</p> : (
        <div className="table-wrap">
          <table>
            <caption>Evidence for {c.key}</caption>
            <thead><tr><th scope="col">ID</th><th scope="col">Result</th><th scope="col">Environment</th><th scope="col">Revision</th><th scope="col">Recorded by</th><th scope="col">Counts?</th><th scope="col">Reference</th></tr></thead>
            <tbody>
              {c.evidence.map((e) => (
                <tr key={e.id}>
                  <td><code>{e.id}</code></td>
                  <td><Badge value={e.result} /></td>
                  <td>{e.environment.kind}{e.environment.description ? ` — ${e.environment.description}` : ""}</td>
                  <td><code>{e.revision}</code></td>
                  <td>{e.recordedBy}{e.importer ? ` (${e.importer})` : ""}</td>
                  <td>{counted.has(e.id) ? "yes" : "no"}</td>
                  <td>{e.artifactRef ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {c.tasks.length > 0 && (
        <>
          <h3>Linked tasks</h3>
          <p className="muted">Task status never counts as verification.</p>
          <ul className="plain">{c.tasks.map((t) => <li key={t.id}>{t.title} — {t.status}</li>)}</ul>
        </>
      )}
    </View>
  );
}

function ReviewView() {
  const { data, error } = useApi<{ review: Review[] }>("/api/memory");
  if (!data) return <View title="Review"><Loading error={error} /></View>;
  return (
    <View title="Review: contradictions and supersessions">
      {data.review.length === 0 ? <p className="muted">Nothing to review.</p> : (
        <ul className="plain">
          {data.review.map((r) => (
            <li key={r.id}>
              <Badge value={r.status} /> <strong>{r.kind}</strong>: {r.detail}
              <div>{r.recordIds.map((id) => <a key={id} href={`#record/${id}`} style={{ marginRight: 8 }}>{id.slice(0, 14)}…</a>)}{r.resolution ? ` → ${r.resolution}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </View>
  );
}

function Tasks() {
  const [withPreview, setWithPreview] = useState(false);
  const { data, error } = useApi<{ tasks: Array<{ id: string; title: string; status: string; revision: number; retired: boolean; remoteTitle?: string }>; preview: { changes: Array<{ kind: string; title: string; reason: string }> } | null; previewError: string | null; adapterConfigured: boolean }>(
    withPreview ? "/api/tasks?preview=1" : "/api/tasks",
  );
  if (!data) return <View title="Tasks"><Loading error={error} /></View>;
  return (
    <View title="Tasks">
      <div className="table-wrap">
        <table>
          <caption>Local tasks ({data.tasks.length})</caption>
          <thead><tr><th scope="col">Title</th><th scope="col">Status (owned by the task system)</th><th scope="col">Revision</th><th scope="col">Remote edit</th></tr></thead>
          <tbody>
            {data.tasks.map((t) => (
              <tr key={t.id}><td>{t.title}{t.retired ? " (retired)" : ""}</td><td>{t.status}</td><td>{t.revision}</td><td>{t.remoteTitle ?? "—"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.adapterConfigured && !withPreview && <p><button type="button" onClick={() => setWithPreview(true)}>Load change preview (reads the task system, writes nothing)</button></p>}
      {data.previewError && <p className="error" role="alert">{data.previewError}</p>}
      {data.preview && (
        <ul className="plain">{data.preview.changes.filter((c) => c.kind !== "unchanged").map((c, i) => <li key={i}><Badge value={c.kind} /> {c.title} — <span className="muted">{c.reason}</span></li>)}</ul>
      )}
    </View>
  );
}

function Usage() {
  const { data, error } = useApi<{ summary: Array<{ task: string; calls: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number | null }>; recent: Array<{ task: string; provider: string; outcome: string; category?: string; reason: string; latencyMs?: number; at: string }> }>("/api/routing");
  if (!data) return <View title="Usage"><Loading error={error} /></View>;
  return (
    <View title="Model routing and cost">
      <div className="table-wrap">
        <table>
          <caption>Totals per routing task (including background work)</caption>
          <thead><tr><th scope="col">Task</th><th scope="col">Calls</th><th scope="col">Failed attempts</th><th scope="col">Tokens in/out</th><th scope="col">Cost</th></tr></thead>
          <tbody>{data.summary.map((s) => <tr key={s.task}><td>{s.task}</td><td>{s.calls}</td><td>{s.errors}</td><td>{s.inputTokens} / {s.outputTokens}</td><td>{s.costUsd === null ? "unknown" : `$${s.costUsd.toFixed(4)}`}</td></tr>)}</tbody>
        </table>
      </div>
      <h3>Recent routing decisions</h3>
      <ul className="plain">{data.recent.slice(-20).reverse().map((t, i) => <li key={i}><code>{t.at}</code> {t.task} → {t.provider}: <Badge value={t.outcome === "ok" ? "passed" : t.outcome === "skipped" ? "not-checked" : "failed"} /> {t.reason}</li>)}</ul>
    </View>
  );
}

function Artifacts() {
  const { data, error } = useApi<Array<{ name: string; type: string; revision: number; path: string; sourceIds: string[]; createdAt: string }>>("/api/artifacts");
  if (!data) return <View title="Artifacts"><Loading error={error} /></View>;
  return (
    <View title="Artifacts">
      <div className="table-wrap">
        <table>
          <caption>Latest generated revisions</caption>
          <thead><tr><th scope="col">File</th><th scope="col">Type</th><th scope="col">Revision</th><th scope="col">Sources cited</th></tr></thead>
          <tbody>{data.map((a) => <tr key={a.name}><td><code>{a.path}</code></td><td>{a.type}</td><td>{a.revision}</td><td>{a.sourceIds.length}</td></tr>)}</tbody>
        </table>
      </div>
    </View>
  );
}

function App() {
  const [view, a, b] = useHash();
  const { data: overview } = useApi<{ project: { id: string; name: string }; memoryRevision: string }>("/api/overview");
  const top = view === "record" ? "memory" : view === "source" ? "memory" : view === "criterion" ? "acceptance" : view;
  let body: ReactNode;
  if (view === "record" && a) body = <RecordView id={a} />;
  else if (view === "source" && a) body = <SourceView id={a} span={b} />;
  else if (view === "criterion" && a && b) body = <CriterionView packId={a} keyName={b} />;
  else if (view === "memory") body = <Memory />;
  else if (view === "acceptance") body = <Acceptance />;
  else if (view === "review") body = <ReviewView />;
  else if (view === "tasks") body = <Tasks />;
  else if (view === "usage") body = <Usage />;
  else if (view === "artifacts") body = <Artifacts />;
  else body = <Overview />;
  return (
    <>
      <a className="skip" href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
      <header>
        <h1>Loom inspector</h1>
        <span className="meta">{overview ? `${overview.project.name} (${overview.project.id}) · memory revision ${overview.memoryRevision} · read-only` : "read-only"}</span>
      </header>
      <nav aria-label="Sections">
        <ul>
          {VIEWS.map(([id, label]) => (
            <li key={id}><a href={`#${id}`} aria-current={top === id ? "page" : undefined}>{label}</a></li>
          ))}
        </ul>
      </nav>
      <main id="main-content" tabIndex={-1}>{body}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
