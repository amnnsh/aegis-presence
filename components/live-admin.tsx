"use client";
import * as React from "react";
import { adminSession, adminSessions, adminStreamUrl, adminSummary, createLink, toDecisionResult } from "../lib/api.ts";
import type { AdminSession, AdminSessionDetail, AdminSummary, HelpDeskLink } from "../lib/api.ts";
import { DecisionBadge, Icon, ResultView } from "./ui.tsx";

/** Real sessions from the backend. Rendered only when NEXT_PUBLIC_API_URL is set.
 * The admin token is typed by the operator and kept in component memory only: never in the bundle,
 * a NEXT_PUBLIC_* variable, or browser storage. Rows hold outcomes and timing events; there is no media to show.
 */
export function LiveActivity() {
  const [token, setToken] = React.useState("");
  const [connected, setConnected] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState("");
  const [sessions, setSessions] = React.useState<AdminSession[]>([]);
  const [summary, setSummary] = React.useState<AdminSummary | null>(null);
  const [detail, setDetail] = React.useState<AdminSessionDetail | null>(null);
  const [label, setLabel] = React.useState("");
  const [link, setLink] = React.useState<HelpDeskLink | null>(null);

  const connect = () => {
    setError("");
    Promise.all([adminSessions(token), adminSummary(token)]).then(([list, counts]) => {
      setSessions(list.sessions); setSummary(counts); setConnected(true);
    }).catch(e => { setConnected(false); setError(e instanceof Error ? e.message : "Could not load sessions."); });
  };
  React.useEffect(() => {
    if (!connected) return;
    const source = new EventSource(adminStreamUrl(token));
    source.onopen = () => setStreaming(true);
    source.onerror = () => setStreaming(false); // EventSource retries on its own
    source.onmessage = message => {
      try {
        const update = JSON.parse(message.data) as { type: string; session: AdminSession };
        if (!update.session?.id) return;
        setSessions(rows => [update.session, ...rows.filter(row => row.id !== update.session.id)]
          .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 100));
        if (update.type !== "session.status") adminSummary(token).then(setSummary).catch(() => undefined);
      } catch { /* ignore a malformed frame */ }
    };
    return () => { source.close(); setStreaming(false); };
  }, [connected, token]);

  const inspect = (id: string) => {
    if (detail?.id === id) { setDetail(null); return; }
    adminSession(token, id).then(setDetail).catch(e => setError(e instanceof Error ? e.message : "Could not load the session."));
  };
  const makeLink = () => {
    createLink(token, label.trim()).then(created => { setLink(created); setLabel(""); })
      .catch(e => setError(e instanceof Error ? e.message : "Could not create a link."));
  };
  const result = detail?.result ? toDecisionResult({ ...detail.result, session_id: detail.id, policy_version: detail.policy_version ?? "", token: "" }) : null;
  const time = (value: string) => new Date(value).toISOString().slice(11, 19);

  return <section className="panel live-panel" aria-label="Live server sessions">
    <div className="attempts-heading"><div><h2>Live sessions</h2><span className="microcopy">From the verification server &middot; outcomes and event timing only, never media &middot; UTC</span></div><span className="dataset-badge"><span className={`dot ${streaming ? "" : "dot-amber"}`} />{connected ? streaming ? "LIVE STREAM" : "RECONNECTING" : "NOT CONNECTED"}</span></div>
    {!connected ? <div className="live-connect"><label className="search-box"><Icon name="lock" size={16} /><span className="sr-only">Admin token</span><input type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && token) connect(); }} placeholder="Admin token" /></label><button className="button button-secondary" disabled={!token} onClick={connect}>Connect</button><p className="microcopy">The token stays in this tab&apos;s memory and is sent only to the verification server. It is never part of the site bundle.</p></div> : <>
      <div className="live-connect"><label className="search-box"><Icon name="globe" size={16} /><span className="sr-only">Help-desk link label</span><input value={label} maxLength={64} onChange={e => setLabel(e.target.value)} placeholder="Help-desk link label" /></label><button className="button button-secondary" disabled={!label.trim()} onClick={makeLink}>Create single-use link</button><button className="button button-text" onClick={() => { setConnected(false); setToken(""); setSessions([]); setSummary(null); setDetail(null); setLink(null); }}>Disconnect</button></div>
      {link && <p className="live-link microcopy">Single-use, expires {time(link.expires_at)} UTC: <code className="mono token-box">{link.verify_url}</code></p>}
      {summary && <p className="microcopy live-summary">{summary.total} session(s) in retention. {summary.by_presenter_decision.map(row => `${row.presenter_label ?? "unlabeled"} / ${row.decision ?? "no decision"}: ${row.count}`).join(" · ")}</p>}
      <div className="table-scroll"><table className="attempt-table"><thead><tr><th>Session / created</th><th>Label</th><th>Status</th><th>Risk index</th><th>Decision</th><th><span className="sr-only">Inspect</span></th></tr></thead><tbody>{sessions.map(row => <tr key={row.id} className={row.id === detail?.id ? "row-selected" : ""}><td><strong className="mono">{row.id.slice(0, 8)}</strong><span className="table-time">{time(row.created_at)}</span></td><td>{row.presenter_label ?? row.link_label ?? "-"}<span className="table-time">{row.ua_family ?? ""}</span></td><td>{row.status}</td><td>{row.risk === null ? "-" : <span className="mono">{row.risk}<small>/100</small></span>}</td><td>{row.decision ? <DecisionBadge decision={row.decision} /> : "-"}</td><td><button className="icon-button" aria-label={`Inspect session ${row.id.slice(0, 8)}`} onClick={() => inspect(row.id)}><Icon name="chevron" size={17} /></button></td></tr>)}</tbody></table></div>
      {sessions.length === 0 && <p className="microcopy live-summary">No sessions yet. Start one from Verification; it appears here as it happens.</p>}
      {detail && <div className="live-detail"><p className="microcopy"><span className="mono">{detail.id}</span> &middot; {detail.status} &middot; {detail.events.length} timing event(s) stored{detail.events.length > 0 && `: ${detail.events.map(e => e.type).join(", ")}`}</p>{result ? <ResultView result={result} sessionLabel={detail.id.slice(0, 8)} compact /> : <p className="microcopy">No decision recorded for this session.</p>}</div>}
    </>}
    {error && <div className="notice notice-amber" role="alert"><Icon name="info" size={18} /><p>{error}</p></div>}
  </section>;
}
