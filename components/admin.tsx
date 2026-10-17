"use client";
import * as React from "react";
import { MOCK_ATTEMPTS, SCENARIOS } from "../lib/scenarios.ts";
import type { Decision } from "../lib/types.ts";
import { adminSession, adminSessions, adminStreamUrl, adminSummary, ApiError, apiConfigured, apiHealth, createLink, toDecisionResult } from "../lib/api.ts";
import type { AdminSession, AdminSessionDetail, AdminSummary, HelpDeskLink } from "../lib/api.ts";
import { clearToken, kpis, loadToken, mergeSession, parseStreamMessage, resultsTable, saveToken, timingSummary } from "../lib/dashboard.ts";
import { Header, Footer, Icon, DecisionBadge, ResultView } from "./ui.tsx";

type Filter = "all" | Decision;
const FLASH_MS = 1600;
const utc = (value: string) => new Date(value).toISOString().slice(11, 19);
const errorText = (e: unknown, fallback: string) => e instanceof Error ? e.message : fallback;

/** /admin/ is a static page: everything below loads in the browser.
 * Live mode reads the verification server with an operator-typed token kept in sessionStorage
 * (this tab only); sample mode shows fixed mock fixtures so the page still demos offline.
 */
export function AdminDashboard() {
  const configured = apiConfigured();
  const [reachable, setReachable] = React.useState<boolean | null>(configured ? null : false);
  const [sample, setSample] = React.useState(!configured);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");

  const [token, setToken] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState("");
  const [sessions, setSessions] = React.useState<AdminSession[]>([]);
  const [summary, setSummary] = React.useState<AdminSummary | null>(null);
  const [flash, setFlash] = React.useState<Record<string, number>>({});
  const [detail, setDetail] = React.useState<AdminSessionDetail | null>(null);
  const detailId = React.useRef<string | null>(null);

  const connect = React.useCallback((candidate: string) => {
    setError("");
    Promise.all([adminSessions(candidate), adminSummary(candidate)]).then(([list, counts]) => {
      setSessions(list.sessions); setSummary(counts); setConnected(true); setReachable(true); setSample(false);
      saveToken(candidate);
    }).catch(e => {
      setConnected(false);
      if (e instanceof ApiError && e.status === 401) { clearToken(); setToken(""); }
      setError(errorText(e, "Could not load sessions."));
    });
  }, []);

  // Reachability first: sample data stays off only when the server answers.
  React.useEffect(() => {
    if (!configured) return;
    let alive = true;
    apiHealth().then(() => {
      if (!alive) return;
      setReachable(true);
      const stored = loadToken();
      if (stored) { setToken(stored); connect(stored); }
    }).catch(() => { if (alive) { setReachable(false); setSample(true); } });
    return () => { alive = false; };
  }, [configured, connect]);

  // Live updates: one EventSource per connection. Rows flash briefly when created or changed.
  React.useEffect(() => {
    if (!connected || !token) return;
    const source = new EventSource(adminStreamUrl(token));
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let dropped = false;
    source.onopen = () => {
      setStreaming(true);
      // After a reconnect, refetch what the stream may have missed.
      if (dropped) adminSessions(token).then(list => setSessions(list.sessions)).catch(() => undefined);
      dropped = false;
    };
    source.onerror = () => { setStreaming(false); dropped = true; }; // EventSource retries on its own
    source.onmessage = message => {
      const update = parseStreamMessage(message.data);
      if (!update) return;
      const id = update.session.id;
      setSessions(rows => mergeSession(rows, update.session));
      setFlash(current => ({ ...current, [id]: Date.now() }));
      const timer = setTimeout(() => { timers.delete(timer); setFlash(({ [id]: _, ...rest }) => rest); }, FLASH_MS);
      timers.add(timer);
      adminSummary(token).then(setSummary).catch(() => undefined);
      if (detailId.current === id) adminSession(token, id).then(setDetail).catch(() => undefined);
    };
    return () => { source.close(); timers.forEach(clearTimeout); setStreaming(false); };
  }, [connected, token]);

  const disconnect = () => {
    clearToken(); setConnected(false); setToken(""); setSessions([]); setSummary(null); setDetail(null); detailId.current = null;
  };
  const inspect = (id: string) => {
    if (detailId.current === id) { detailId.current = null; setDetail(null); return; }
    detailId.current = id;
    adminSession(token, id).then(d => { if (detailId.current === id) setDetail(d); })
      .catch(e => setError(errorText(e, "Could not load the session.")));
  };

  const live = !sample;
  const k = live ? kpis(summary) : null;
  const mockCounts = [MOCK_ATTEMPTS.length, ...(["approve", "step-up", "reject"] as const).map(d => MOCK_ATTEMPTS.filter(row => row.result.decision === d).length)];
  const kpiValues = live ? (k ? [k.total, k.approve, k.stepUp, k.reject] : null) : mockCounts;

  return <><Header active="admin" /><main id="main-content" className="dashboard page-width"><div className="page-heading"><div><span className="eyebrow">OPERATIONS / {live ? "LIVE WORKSPACE" : "DEMO WORKSPACE"}</span><h1>A clearer view of every decision.</h1><p>{live ? "Server-checked verification sessions, as they happen." : "Inspect the signals behind a fictional verification queue."}</p></div><div className="heading-actions">
      <button className={`sample-toggle ${sample ? "sample-on" : ""}`} aria-pressed={sample} disabled={!configured} title={configured ? undefined : "No verification server is configured for this build."} onClick={() => setSample(on => !on)}><span className="sample-switch" aria-hidden="true" />Sample data</button>
      <a className="button button-primary" href="/verify/">New verification<Icon name="arrow" size={17} /></a></div></div>
    <ModeNotice configured={configured} reachable={reachable} sample={sample} />
    <section className="kpi-grid" aria-label={live ? "Server session totals" : "Mock dataset totals"}>{[live ? "Server sessions" : "Sample attempts", "Approve", "Step-up", "Reject"].map((label, i) => <article className={`kpi-card kpi-${i}`} key={label}><div><span>{label}</span><Icon name={i === 0 ? "activity" : i === 1 ? "check" : i === 2 ? "layers" : "shield"} size={19} /></div><strong>{kpiValues ? kpiValues[i].toString().padStart(2, "0") : "--"}</strong><p>{live ? (i === 0 ? "In retention (24 h), all visitors" : "Server-recomputed decisions") : i === 0 ? "Fixed fictional dataset" : "Illustrative policy decisions"}</p></article>)}</section>
    <div className="dashboard-grid">
      {sample ? <SampleAttempts filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} />
        : <LiveSessions {...{ token, setToken, connected, streaming, sessions, flash, filter, setFilter, query, setQuery, detail, reachable, connect, disconnect, inspect, setError }} />}
      <aside className="dashboard-sidebar">{live && connected && <ResultsCard summary={summary} />}<section className="panel policy-card"><span className="eyebrow">POLICY / V0.1</span><h2>Simple enough<br />to inspect.</h2><p>Fixed weights, visible sources, conservative handling of missing evidence.</p><div className="policy-range"><span><i className="dot" />Approve</span><strong>0 &ndash; &lt;30</strong></div><div className="policy-range"><span><i className="dot dot-amber" />Step-up</span><strong>30 &ndash; &lt;65</strong></div><div className="policy-range"><span><i className="dot dot-red" />Reject</span><strong>65 &ndash; 100</strong></div><p className="microcopy">These are demo thresholds, not fraud probabilities. Missing evidence and virtual-camera flags can veto approval. Live sessions always require another trusted check.</p><a className="text-link" href="/verify/?mode=lab">Test the policy<Icon name="arrow" size={16} /></a></section><section className="panel roadmap-card"><span className="icon-box"><Icon name="lock" /></span><h3>No biometric database.</h3><p>{configured ? "The server keeps outcomes and event timing for up to 24 hours, and never an image, video, or audio. Frames stay in the visitor's tab." : "The real webcam flow is isolated from this dashboard. Closing or refreshing the page discards the session."}</p><span className="source-badge source-simulated">{configured ? "Demo backend / single shared token" : "Admin backend not configured"}</span></section></aside>
    </div>
    {error && <div className="notice notice-amber dashboard-notice" role="alert"><Icon name="info" size={18} /><p>{error}</p></div>}
  </main><Footer /></>;
}

function ModeNotice({ configured, reachable, sample }: { configured: boolean; reachable: boolean | null; sample: boolean }) {
  const [title, body] = !configured
    ? ["Sample data only. No verification server is configured.", "All attempts, times, and scores below are fixed mock fixtures. Actual webcam sessions are not saved here."]
    : sample && reachable === false
      ? ["The verification server is unreachable, so sample data is shown.", "All attempts below are fixed mock fixtures. Live sessions return once the server answers; reload to retry."]
      : sample
        ? ["Sample data is on.", "The KPI cards and the attempts table are fixed mock fixtures, not server sessions. Turn Sample data off for live sessions."]
        : ["Live sessions from the verification server.", "Rows are real attempts on this server, including visitors'. They hold outcomes and timing events only, never media. Decisions are illustrative heuristics, not measured detection rates."];
  return <div className={`notice ${sample ? "notice-amber" : "notice-blue"} dashboard-notice`}><Icon name="info" size={18} /><p><strong>{title}</strong> {body}</p></div>;
}

function FilterBar({ filter, setFilter, query, setQuery, searchLabel }: { filter: Filter; setFilter: (f: Filter) => void; query: string; setQuery: (q: string) => void; searchLabel: string }) {
  return <div className="table-toolbar"><div className="filter-tabs" aria-label="Filter decisions">{(["all", "approve", "step-up", "reject"] as const).map(option => <button key={option} className={filter === option ? "filter-selected" : ""} onClick={() => setFilter(option)} aria-pressed={filter === option}>{option === "all" ? "All attempts" : option === "step-up" ? "Step-up" : option[0].toUpperCase() + option.slice(1)}</button>)}</div><label className="search-box"><Icon name="search" size={16} /><span className="sr-only">{searchLabel}</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search attempts" /></label></div>;
}

function SampleAttempts({ filter, setFilter, query, setQuery }: { filter: Filter; setFilter: (f: Filter) => void; query: string; setQuery: (q: string) => void }) {
  const [selected, setSelected] = React.useState<string | null>(null);
  const rows = MOCK_ATTEMPTS.filter(row => (filter === "all" || row.result.decision === filter) && `${row.id} ${row.scenario} ${SCENARIOS.find(s => s.id === row.scenario)!.title}`.toLowerCase().includes(query.toLowerCase().trim()));
  const selectedRow = MOCK_ATTEMPTS.find(row => row.id === selected);
  return <section className="panel attempts-panel"><div className="attempts-heading"><div><h2>Verification attempts</h2><span className="microcopy">Mock timeline &middot; 05 Oct 2026 &middot; UTC</span></div><span className="dataset-badge"><span className="dot dot-amber" />MOCK DATA</span></div>
    <FilterBar {...{ filter, setFilter, query, setQuery }} searchLabel="Search mock attempt ID or scenario" />
    <div className="table-scroll"><table className="attempt-table"><thead><tr><th>Attempt / time</th><th>Scenario</th><th>Risk index</th><th>Decision</th><th><span className="sr-only">Inspect</span></th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className={row.id === selected ? "row-selected" : ""}><td><strong className="mono">{row.id}</strong><span className="table-time">{row.time}</span></td><td><span className={`table-scenario-icon scenario-icon-${row.scenario}`}><Icon name={row.scenario === "normal" ? "shield" : row.scenario === "virtual" ? "camera" : row.scenario === "replay" ? "play" : "scan"} size={15} /></span>{SCENARIOS.find(s => s.id === row.scenario)!.title}</td><td><div className="table-risk"><span className={`mini-risk mini-${row.result.decision}`}><i style={{ width: `${row.result.risk}%` }} /></span><span className="mono">{row.result.risk}<small>/100</small></span></div></td><td><DecisionBadge decision={row.result.decision} /></td><td><button className="icon-button" aria-label={`Inspect ${row.id}`} onClick={() => setSelected(selected === row.id ? null : row.id)}><Icon name="chevron" size={17} /></button></td></tr>)}</tbody></table></div>
    {rows.length === 0 && <div className="empty-table"><Icon name="search" size={26} /><h3>No matching fixtures.</h3><p>Try another attempt ID or remove the decision filter.</p><button className="button button-secondary" onClick={() => { setQuery(""); setFilter("all"); }}>Reset filters</button></div>}
    <div className="table-footer"><span>Showing {rows.length} of {MOCK_ATTEMPTS.length} mock attempts</span><span>Nothing here is a measured detection rate.</span></div>
    {selectedRow && <section className="inspector" aria-label={`Mock details for ${selectedRow.id}`}><div className="section-heading"><h2>Inspecting {selectedRow.id}</h2><button className="button button-secondary" onClick={() => setSelected(null)}><Icon name="close" size={16} />Close details</button></div><ResultView result={selectedRow.result} sessionLabel={selectedRow.id} compact /></section>}
  </section>;
}

interface LiveProps {
  token: string; setToken: (t: string) => void; connected: boolean; streaming: boolean; sessions: AdminSession[]; flash: Record<string, number>;
  filter: Filter; setFilter: (f: Filter) => void; query: string; setQuery: (q: string) => void; detail: AdminSessionDetail | null; reachable: boolean | null;
  connect: (token: string) => void; disconnect: () => void; inspect: (id: string) => void; setError: (e: string) => void;
}

function LiveSessions(p: LiveProps) {
  const [linkLabel, setLinkLabel] = React.useState("");
  const [link, setLink] = React.useState<HelpDeskLink | null>(null);
  const q = p.query.toLowerCase().trim();
  const rows = p.sessions.filter(row => (p.filter === "all" || row.decision === p.filter) &&
    `${row.id} ${row.presenter_label ?? ""} ${row.link_label ?? ""} ${row.status}`.toLowerCase().includes(q));
  const makeLink = () => createLink(p.token, linkLabel.trim()).then(created => { setLink(created); setLinkLabel(""); })
    .catch(e => p.setError(errorText(e, "Could not create a link.")));

  return <section className="panel attempts-panel live-panel" aria-label="Live server sessions"><div className="attempts-heading"><div><h2>Verification sessions</h2><span className="microcopy">From the verification server &middot; outcomes and event timing only, never media &middot; UTC</span></div><span className="dataset-badge"><span className={`dot ${p.streaming ? "" : "dot-amber"}`} />{p.connected ? p.streaming ? "LIVE STREAM" : "RECONNECTING" : "NOT CONNECTED"}</span></div>
    {!p.connected ? <div className="live-connect"><label className="search-box"><Icon name="lock" size={16} /><span className="sr-only">Admin token</span><input type="password" autoComplete="off" spellCheck={false} value={p.token} disabled={p.reachable === false} onChange={e => p.setToken(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && p.token) p.connect(p.token); }} placeholder="Admin token" /></label><button className="button button-secondary" disabled={!p.token || p.reachable === false} onClick={() => p.connect(p.token)}>Connect</button><p className="microcopy">{p.reachable === false ? "The verification server is not answering." : "The token is kept in this tab's session storage until you disconnect or close the tab, and is sent only to the verification server. It is never part of the site bundle."}</p></div> : <>
      <div className="live-connect"><label className="search-box"><Icon name="globe" size={16} /><span className="sr-only">Help-desk link label</span><input value={linkLabel} maxLength={64} onChange={e => setLinkLabel(e.target.value)} placeholder="Help-desk link label" /></label><button className="button button-secondary" disabled={!linkLabel.trim()} onClick={makeLink}>Create single-use link</button><button className="button button-text" onClick={p.disconnect}>Disconnect and forget token</button></div>
      {link && <p className="live-link microcopy">Single-use, expires {utc(link.expires_at)} UTC: <code className="mono token-box">{link.verify_url}</code></p>}
      <FilterBar filter={p.filter} setFilter={p.setFilter} query={p.query} setQuery={p.setQuery} searchLabel="Search session ID or presenter label" />
      <div className="table-scroll"><table className="attempt-table live-table"><thead><tr><th>Time</th><th>Session</th><th>Presenter label</th><th>Risk</th><th>Decision</th><th>Coverage</th><th>Policy</th><th><span className="sr-only">Inspect</span></th></tr></thead><tbody>{rows.map(row => <tr key={`${row.id}-${p.flash[row.id] ?? 0}`} className={`${row.id === p.detail?.id ? "row-selected" : ""} ${p.flash[row.id] ? "row-flash" : ""}`} onClick={() => p.inspect(row.id)}>
        <td className="mono">{utc(row.created_at)}</td>
        <td><strong className="mono">{row.id.slice(0, 8)}</strong><span className="table-time">{row.status}</span></td>
        <td>{row.presenter_label ?? (row.link_label ? `link: ${row.link_label}` : "-")}<span className="table-time">{row.ua_family ?? ""}</span></td>
        <td>{row.risk === null ? "-" : <span className="mono">{row.risk}<small>/100</small></span>}</td>
        <td>{row.decision ? <DecisionBadge decision={row.decision} /> : "-"}</td>
        <td className="mono">{row.coverage === null ? "-" : `${row.coverage}/100`}</td>
        <td className="mono">{row.policy_version ?? "-"}</td>
        <td><button className="icon-button" aria-label={`Inspect session ${row.id.slice(0, 8)}`} onClick={e => { e.stopPropagation(); p.inspect(row.id); }}><Icon name="chevron" size={17} /></button></td></tr>)}</tbody></table></div>
      {p.sessions.length === 0 ? <div className="empty-table"><Icon name="activity" size={26} /><h3>No sessions yet.</h3><p>Start one from Verification. It appears here as it happens.</p></div>
        : rows.length === 0 && <div className="empty-table"><Icon name="search" size={26} /><h3>No matching sessions.</h3><button className="button button-secondary" onClick={() => { p.setQuery(""); p.setFilter("all"); }}>Reset filters</button></div>}
      <div className="table-footer"><span>Showing {rows.length} of {p.sessions.length} recent sessions</span><span>Nothing here is a measured detection rate.</span></div>
      {p.detail && <SessionDetail detail={p.detail} onClose={() => p.inspect(p.detail!.id)} />}
    </>}
  </section>;
}

function SessionDetail({ detail, onClose }: { detail: AdminSessionDetail; onClose: () => void }) {
  const result = detail.result ? toDecisionResult({ ...detail.result, session_id: detail.id, policy_version: detail.policy_version ?? "", token: "" }) : null;
  const timings = timingSummary(detail);
  return <section className="inspector live-detail" aria-label={`Details for session ${detail.id.slice(0, 8)}`}><div className="section-heading"><h2>Inspecting <span className="mono">{detail.id.slice(0, 8)}</span></h2><button className="button button-secondary" onClick={onClose}><Icon name="close" size={16} />Close details</button></div>
    <p className="microcopy">{detail.presenter_label ? `Presenter label: ${detail.presenter_label} (demo only, not used for scoring)` : "No presenter label"} &middot; {detail.status} &middot; {detail.events.length} timing event(s)</p>
    {timings.length > 0 && <table className="timing-table"><thead><tr><th>Challenge</th><th>Ran</th><th>Cues</th><th>Cue to response</th><th>End</th></tr></thead><tbody>{timings.map(t => <tr key={t.id}><td>{t.kind.replace("_", " ")}</td><td className="mono">{t.durationMs === null ? "-" : `${(t.durationMs / 1000).toFixed(1)} s`}</td><td className="mono">{t.cues || "-"}</td><td className="mono">{t.latenciesMs.length ? t.latenciesMs.map(ms => `${ms} ms`).join(", ") : "-"}</td><td>{t.status ?? "-"}</td></tr>)}</tbody></table>}
    {result ? <ResultView result={result} sessionLabel={detail.id.slice(0, 8)} compact /> : <p className="microcopy">No decision recorded for this session.</p>}
  </section>;
}

function ResultsCard({ summary }: { summary: AdminSummary | null }) {
  const table = resultsTable(summary);
  return <section className="panel results-card" aria-labelledby="team-results-heading"><span className="eyebrow">LABELED BY PRESENTER</span><h2 id="team-results-heading">Team test sessions</h2><p className="microcopy">Small sample on our own devices &mdash; not a benchmark.</p>
    <div className="results-n"><strong>n = {table.n}</strong><span>labeled sessions with a decision</span></div>
    {table.rows.length > 0 ? <table className="results-table"><thead><tr><th scope="col">Presenter label</th><th scope="col">n</th><th scope="col">Approve</th><th scope="col">Step-up</th><th scope="col">Reject</th></tr></thead><tbody>{table.rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.n}</td><td>{row.approve}</td><td>{row.stepUp}</td><td>{row.reject}</td></tr>)}</tbody></table>
      : <p className="microcopy">No labeled sessions yet. Run them from <span className="mono">/verify/?demo=1</span>.</p>}
    <p className="microcopy">Labels are typed by the presenter and never used for scoring.{table.undecided ? ` ${table.undecided} labeled session(s) have no decision yet and are not counted.` : ""}{table.unlabeled ? ` ${table.unlabeled} unlabeled session(s), such as visitors, are excluded.` : ""}</p>
  </section>;
}
