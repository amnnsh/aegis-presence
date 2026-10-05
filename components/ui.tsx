import * as React from "react";
import type { Decision, DecisionResult, Provenance } from "../lib/types.ts";
import { SIGNALS } from "../lib/risk.ts";

export type IconName = "shield" | "arrow" | "camera" | "eye" | "sun" | "scan" | "audio" | "lock" | "layers" | "check" | "close" | "activity" | "code" | "refresh" | "info" | "play" | "search" | "chevron" | "globe";
const paths: Record<IconName, React.ReactNode> = {
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z" /><path d="m8.5 12 2.3 2.3 4.7-4.8" /></>,
  arrow: <><path d="M4 12h15m-6-6 6 6-6 6" /></>,
  camera: <><path d="M8 6 9.5 4h5L16 6h4v14H4V6z" /><circle cx="12" cy="12" r="3.5" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  scan: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18" /><path d="M8 8h8v8H8z" /></>,
  audio: <path d="M3 10v4m4-7v10m5-14v18m5-15v12m4-8v4" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  layers: <><path d="m12 3 10 5-10 5L2 8zm-9 9 9 5 9-5m-18 5 9 5 9-5" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  code: <><path d="m7 6-5 6 5 6m10-12 5 6-5 6m-4-14-2 16" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.5 7a7.5 7.5 0 0 1 13-2l1.5 2M4 17l1.5 2a7.5 7.5 0 0 0 13-2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
  play: <path d="m8 4 12 8-12 8z" />,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  globe: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
};
export function Icon({ name, size = 20, className = "" }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{paths[name]}</svg>;
}
export function Brand() { return <a className="brand" href="/" aria-label="Aegis home"><span className="brand-mark"><Icon name="shield" size={23} /></span><span>aegis<span className="brand-period">.</span></span></a>; }
export function Header({ active = "overview" }: { active?: "overview" | "verify" | "admin" }) {
  return <header className="site-header"><div className="header-inner"><Brand /><nav aria-label="Main navigation">
    <a href="/" aria-current={active === "overview" ? "page" : undefined}>Overview</a>
    <a href="/verify/" aria-current={active === "verify" ? "page" : undefined}>Verification</a>
    <a href="/admin/" aria-current={active === "admin" ? "page" : undefined}>Activity <span className="nav-demo">demo</span></a>
  </nav><span className="header-status"><span className="dot" /> Browser-only prototype</span></div></header>;
}
export function Footer() {
  return <footer className="site-footer"><div><Brand /><span>Presence, not just appearance.</span></div><p>Hackathon prototype <span aria-hidden="true">/</span> Not a production identity check</p></footer>;
}
const sourceLabels: Record<Provenance, string> = { observed: "Observed", heuristic: "Heuristic", simulated: "Simulated", unavailable: "Unavailable" };
export function SourceBadge({ source }: { source: Provenance }) { return <span className={`source-badge source-${source}`}>{sourceLabels[source]}</span>; }
export function DecisionBadge({ decision }: { decision: Decision }) { return <span className={`decision-badge decision-${decision}`}><span className="dot" />{decision === "step-up" ? "Step-up" : decision === "approve" ? "Approve" : "Reject"}</span>; }
export function PrivacyNote() {
  return <div className="privacy-note"><Icon name="lock" size={15} /><span>Frames stay in this tab. No biometric uploads, recordings, or persistent session storage.</span></div>;
}
export function PrototypeNotice() {
  return <div className="notice notice-blue"><Icon name="info" size={18} /><p><strong>A transparent prototype, not a security guarantee.</strong> Browser heuristics can be fooled. Model-based checks are simulated and clearly marked. No score is an accuracy claim.</p></div>;
}
export const signalIcons: IconName[] = ["camera", "eye", "sun", "scan", "audio"];
export function ResultView({ result, onReset, sessionLabel, compact = false }: { result: DecisionResult; onReset?: () => void; sessionLabel?: string; compact?: boolean }) {
  const title = result.decision === "approve" ? "Low-risk demo outcome" : result.decision === "reject" ? "Do not continue this attempt" : "One more layer is needed";
  return <section className={`result-view ${compact ? "result-compact" : ""}`} aria-label="Verification result">
    <div className={`result-mode ${result.mode === "simulation" ? "mode-sim" : "mode-live"}`}><Icon name={result.mode === "simulation" ? "code" : "lock"} size={16} />{result.mode === "simulation" ? "ATTACK LAB / ALL INPUTS ARE SIMULATED" : "LIVE SESSION / CAMERA STOPPED"}{sessionLabel && <span className="mono">{sessionLabel}</span>}</div>
    <div className="result-hero"><div><DecisionBadge decision={result.decision} /><h2>{title}</h2><p>{result.explanation}</p><span className="microcopy">Illustrative policy v0.1 <span aria-hidden="true">&middot;</span> Not an identity assertion</span></div><div className={`risk-dial risk-${result.decision}`} style={{ "--risk": `${result.risk * 3.6}deg` } as React.CSSProperties}><div><strong>{result.risk}<small>/100</small></strong><span>risk index</span></div></div></div>
    <div className="result-body"><div className="signal-section"><div className="section-heading"><h3>Five signals. One decision.</h3><span className="microcopy">Higher score = higher risk</span></div>
      {SIGNALS.map((meta, i) => { const signal = result.signals.find(s => s.id === meta.id)!; const used = result.contributions.find(s => s.id === meta.id)!;
        return <div className="signal-result" key={meta.id}><div className="signal-result-top"><span className="signal-icon"><Icon name={signalIcons[i]} /></span><div className="signal-result-label"><h4>{meta.title}</h4><span>{meta.weight}% policy weight</span></div><SourceBadge source={signal.provenance} /><strong className="signal-number">{signal.risk === null ? "N/A" : <>{signal.risk}<small>/100</small></>}</strong></div>
          <div className="risk-track" aria-hidden="true"><span className={signal.risk === null ? "bar-unknown" : signal.risk < 30 ? "bar-low" : signal.risk < 65 ? "bar-mid" : "bar-high"} style={{ width: `${signal.risk ?? 60}%` }} /></div><p>{signal.detail}{used.substituted && <strong> Excluded / missing: the engine uses risk 60 here.</strong>}</p></div>;
      })}
    </div><aside className="decision-explanation"><span className="eyebrow">DECISION TRACE</span><h3>Why this outcome?</h3><ol>{result.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ol><div className="coverage"><span>{result.mode === "simulation" ? "Usable fixture weight" : "Usable local-signal weight"}</span><strong>{result.coverage}<small>/100</small></strong></div><p className="microcopy">Coverage describes policy inputs, not confidence or detection accuracy. Camera-derived signals share failure modes; their independence is not established.</p></aside></div>
    <details className="policy-details"><summary>Inspect the scoring formula and thresholds</summary><p>Risk = sum of each input risk &times; its fixed weight. Missing or excluded evidence contributes 60 at its original weight. The displayed score is rounded; thresholds use the unrounded value.</p><table><thead><tr><th>Signal</th><th>Weight</th><th>Risk used</th><th>Contribution</th></tr></thead><tbody>{result.contributions.map(c => <tr key={c.id}><td>{SIGNALS.find(s => s.id === c.id)!.title}{c.substituted ? " (fallback)" : ""}</td><td>{c.weight}%</td><td>{c.usedRisk}</td><td>{(c.usedRisk * c.weight / 100).toFixed(1)}</td></tr>)}</tbody></table><p>Demo thresholds: approve below 30; step-up from 30 to below 65; reject at 65 or above. A camera risk of 70 or more vetoes approval. Missing evidence vetoes approval. Live sessions never approve; a live reject additionally requires two usable signals at 70+ and at least 50/100 usable weight.</p></details>
    {onReset && <div className="result-actions"><button className="button button-primary" onClick={onReset}><Icon name="refresh" size={17} />Start a fresh session</button><a className="button button-secondary" href="/admin/">Explore mock activity<Icon name="arrow" size={17} /></a><PrivacyNote /></div>}
  </section>;
}
