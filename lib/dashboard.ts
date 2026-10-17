import type { AdminSession, AdminSessionDetail, AdminSummary } from "./api.ts";
import type { Decision } from "./types.ts";

/** Labels the team assigns to its own test sessions on /verify/?demo=1. Never used for scoring. */
export const PRESENTER_LABELS = ["genuine", "phone replay", "virtual camera", "face-swap", "other"] as const;
export type PresenterLabel = (typeof PRESENTER_LABELS)[number];

export function presenterLabel(value: string | null | undefined): PresenterLabel | "" {
  const v = (value ?? "").trim().toLowerCase();
  return (PRESENTER_LABELS as readonly string[]).includes(v) ? v as PresenterLabel : "";
}

// ------------------------------------------
// Results table and KPIs, from GET /api/admin/summary
// ------------------------------------------

export interface ResultRow { label: string; n: number; approve: number; stepUp: number; reject: number }
export interface ResultsTable {
  rows: ResultRow[];
  /** Labeled sessions with a decision: the sample size of the table. */
  n: number;
  /** Labeled sessions without a decision yet (in progress, cancelled, or expired). Not in n. */
  undecided: number;
  /** Sessions without a presenter label: real visitors and help-desk links. Not in the table. */
  unlabeled: number;
}

const add = (row: { approve: number; stepUp: number; reject: number }, decision: Decision, count: number) => {
  if (decision === "approve") row.approve += count;
  else if (decision === "step-up") row.stepUp += count;
  else row.reject += count;
};

/** Rows are presenter labels (known labels first, in menu order); n counts only decided sessions, so every row adds up. */
export function resultsTable(summary: AdminSummary | null): ResultsTable {
  const table: ResultsTable = { rows: [], n: 0, undecided: 0, unlabeled: 0 };
  if (!summary) return table;
  const byLabel = new Map<string, ResultRow>();
  for (const { presenter_label, decision, count } of summary.by_presenter_decision) {
    if (!presenter_label) { table.unlabeled += count; continue; }
    if (!decision) { table.undecided += count; continue; }
    const row = byLabel.get(presenter_label) ?? { label: presenter_label, n: 0, approve: 0, stepUp: 0, reject: 0 };
    row.n += count;
    add(row, decision, count);
    byLabel.set(presenter_label, row);
    table.n += count;
  }
  const order = (label: string) => { const i = (PRESENTER_LABELS as readonly string[]).indexOf(label); return i < 0 ? PRESENTER_LABELS.length : i; };
  table.rows = [...byLabel.values()].sort((a, b) => order(a.label) - order(b.label) || a.label.localeCompare(b.label));
  return table;
}

export interface Kpis { total: number; approve: number; stepUp: number; reject: number }

/** Every session in retention, labeled or not. */
export function kpis(summary: AdminSummary | null): Kpis | null {
  if (!summary) return null;
  const k: Kpis = { total: summary.total, approve: 0, stepUp: 0, reject: 0 };
  for (const { decision, count } of summary.by_presenter_decision) if (decision) add(k, decision, count);
  return k;
}

// ------------------------------------------
// Live rows
// ------------------------------------------

export const MAX_ROWS = 100;

/** Inserts or replaces one session and keeps newest first. */
export function mergeSession(rows: AdminSession[], session: AdminSession): AdminSession[] {
  return [session, ...rows.filter(row => row.id !== session.id)]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, MAX_ROWS);
}

/** Parses one SSE frame: {"type": "session.created" | "session.status" | "session.completed", "session": {...}}. */
export function parseStreamMessage(data: string): { type: string; session: AdminSession } | null {
  try {
    const message = JSON.parse(data) as { type?: unknown; session?: AdminSession };
    return typeof message.type === "string" && message.session && typeof message.session.id === "string" &&
      typeof message.session.created_at === "string" ? { type: message.type, session: message.session } : null;
  } catch {
    return null;
  }
}

// ------------------------------------------
// Timing events of one session
// ------------------------------------------

export interface ChallengeTiming { id: string; kind: string; durationMs: number | null; cues: number; latenciesMs: number[]; status: string | null }

/** Per challenge: how long it ran, how many cues fired, and cue -> response latencies by index. */
export function timingSummary(detail: Pick<AdminSessionDetail, "events" | "plan">): ChallengeTiming[] {
  const ids = detail.plan?.challenges.map(c => c.id) ?? [...new Set(detail.events.map(e => e.challenge_id))];
  return ids.map(id => {
    const mine = detail.events.filter(e => e.challenge_id === id);
    const kind = detail.plan?.challenges.find(c => c.id === id)?.kind ?? String(mine.find(e => e.type === "challenge_start")?.payload.kind ?? "unknown");
    const start = mine.find(e => e.type === "challenge_start")?.client_ts_ms;
    const end = mine.find(e => e.type === "challenge_end");
    const cues = new Map<number, number>();
    for (const e of mine) if (e.type === "cue" && typeof e.payload.index === "number" && !cues.has(e.payload.index)) cues.set(e.payload.index, e.client_ts_ms);
    const latenciesMs: number[] = [];
    const answered = new Set<number>();
    for (const e of mine) {
      const index = e.payload.index;
      if (e.type !== "response" || typeof index !== "number" || !cues.has(index) || answered.has(index)) continue;
      answered.add(index);
      latenciesMs.push(e.client_ts_ms - cues.get(index)!);
    }
    return {
      id, kind, cues: cues.size, latenciesMs,
      durationMs: start !== undefined && end ? end.client_ts_ms - start : null,
      status: end && typeof end.payload.status === "string" ? end.payload.status : null,
    };
  }).filter(t => t.kind !== "unknown" || t.cues > 0 || t.durationMs !== null);
}

// ------------------------------------------
// Admin token: sessionStorage (this tab only, cleared when it closes). Never in the bundle.
// ------------------------------------------

const TOKEN_KEY = "aegis.adminToken";

export function loadToken(): string {
  try { return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? ""; } catch { return ""; }
}
export function saveToken(token: string): void {
  try { globalThis.sessionStorage?.setItem(TOKEN_KEY, token); } catch { /* storage blocked: the token stays in memory only */ }
}
export function clearToken(): void {
  try { globalThis.sessionStorage?.removeItem(TOKEN_KEY); } catch { /* nothing stored */ }
}
