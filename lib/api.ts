import type { Challenge, ChallengeResult, Decision, DecisionResult, Signal } from "./types.ts";
import { SIGNALS } from "./risk.ts";

/** Typed client for the optional Aegis backend (see /backend).
 * NEXT_PUBLIC_API_URL is a PUBLIC URL baked into the bundle. Never put a secret in a NEXT_PUBLIC_* variable.
 * Only numbers and short enums are sent: timing events and risk scores. No frame, image, or audio leaves the tab.
 * Every failure degrades to today's local-only behavior; nothing here can turn into an approval.
 */
const API_URL = (process.env.NEXT_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
const TIMEOUT_MS = 6000;
export const apiConfigured = (): boolean => API_URL !== "";

export type Move = "left" | "right" | "up" | "down";
export type PlanChallenge =
  | { id: string; kind: "head_sequence"; moves: Move[] }
  | { id: string; kind: "cued_blink"; cue_offsets_ms: number[] }
  | { id: string; kind: "digits"; digits: string };
export interface Plan { challenges: PlanChallenge[]; pulse_hold_ms: number }
export interface SessionStart { session_id: string; expires_at: string; server_now_ms: number; plan: Plan }
export type EventType = "challenge_start" | "cue" | "response" | "challenge_end";
export interface ClientEvent { challenge_id: string; type: EventType; client_ts_ms: number; payload: Record<string, number | string | boolean | null> }
export interface ServerSignal { id: string; risk: number | null; provenance: Signal["provenance"]; detail: string }
export interface CompleteResponse {
  session_id: string; decision: Decision; risk: number; coverage: number; mode: "live"; explanation: string;
  reasons: string[]; signals: ServerSignal[]; contributions: DecisionResult["contributions"]; policy_version: string; token: string;
}
export interface AdminSession {
  id: string; created_at: string; expires_at: string; status: string; plan_consumed: boolean; decision: Decision | null;
  risk: number | null; coverage: number | null; policy_version: string | null; presenter_label: string | null;
  link_label: string | null; ua_family: string | null;
}
export interface AdminSessionDetail extends AdminSession {
  events: (ClientEvent & { id: number; server_ts_ms: number })[];
  result: Omit<CompleteResponse, "session_id" | "policy_version" | "token"> | null;
}
export interface AdminSummary { total: number; by_presenter_decision: { presenter_label: string | null; decision: Decision | null; count: number }[] }
export interface HelpDeskLink { session_id: string; verify_url: string; expires_at: string }

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function request<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown; token?: string } = {}): Promise<T> {
  if (!API_URL) throw new ApiError(0, "No API configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const response = await fetch(API_URL + path, {
      method: init.method || "GET", headers, signal: controller.signal, cache: "no-store", credentials: "omit",
      referrerPolicy: "no-referrer", body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, typeof data?.detail === "string" ? data.detail : `Request failed (${response.status})`);
    return data as T;
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError(0, "The verification server is unreachable.");
  } finally { clearTimeout(timer); }
}

const MOVES: Move[] = ["left", "right", "up", "down"];
/** Returns null for anything that is not a well-formed plan; the caller then stays local-only. */
export function parsePlan(value: unknown): Plan | null {
  const plan = value as Plan | null;
  if (!plan || !Array.isArray(plan.challenges) || plan.challenges.length !== 3 || !Number.isFinite(plan.pulse_hold_ms)) return null;
  const valid = plan.challenges.every(c => c && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 64 && (
    c.kind === "head_sequence" ? Array.isArray(c.moves) && c.moves.length > 0 && c.moves.every(m => MOVES.includes(m))
      : c.kind === "cued_blink" ? Array.isArray(c.cue_offsets_ms) && c.cue_offsets_ms.every(n => Number.isFinite(n))
        : c.kind === "digits" && typeof c.digits === "string" && /^\d{4}$/.test(c.digits)));
  return valid && new Set(plan.challenges.map(c => c.kind)).size === 3 ? plan : null;
}

/** INTERIM mapping onto today's Challenge type, until lib/challenges.ts consumes the plan directly.
 * The server-chosen ORDER and DIGITS are honored. A head sequence collapses to its first left/right move
 * (up/down is not detectable yet), and blink cue offsets are not used, so no cue/response latencies are reported.
 */
export function planToChallenges(plan: Plan): Challenge[] {
  return plan.challenges.map((c): Challenge => {
    if (c.kind === "head_sequence") return { kind: "head", direction: c.moves.find((m): m is "left" | "right" => m === "left" || m === "right") ?? "left" };
    if (c.kind === "cued_blink") return { kind: "blink" };
    return { kind: "digits", digits: c.digits };
  });
}

export function createSession(presenterLabel?: string): Promise<SessionStart> {
  return request<SessionStart>("/api/sessions", { method: "POST", body: { client_now_ms: Date.now(), ...(presenterLabel ? { presenter_label: presenterLabel.slice(0, 64) } : {}) } });
}
/** Help-desk link flow: the plan of an agent-created session can be fetched exactly once. */
export function getPlan(sessionId: string): Promise<SessionStart> {
  return request<SessionStart>(`/api/sessions/${encodeURIComponent(sessionId)}/plan?client_now_ms=${Date.now()}`);
}
export function postEvents(sessionId: string, events: ClientEvent[]): Promise<{ accepted: number }> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/events`, { method: "POST", body: { events } });
}
export function complete(sessionId: string, signals: Signal[], challengeResults: ChallengeResult[]): Promise<CompleteResponse> {
  const short = (text: string) => text.slice(0, 400);
  return request<CompleteResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/complete`, { method: "POST", body: {
    signals: signals.map(s => ({ id: s.id, risk: s.risk, provenance: s.provenance, detail: short(s.detail) })),
    challenge_results: challengeResults.map(r => ({ kind: r.kind, status: r.status, risk: r.risk, detail: short(r.detail) })),
  } });
}
export function cancelSession(sessionId: string): Promise<unknown> {
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
}

/** Turns the server response into the DecisionResult the UI already renders. Returns null if it is malformed. */
export function toDecisionResult(data: CompleteResponse): DecisionResult | null {
  const decisions: Decision[] = ["approve", "step-up", "reject"];
  if (!data || !decisions.includes(data.decision) || !Number.isFinite(data.risk) || !Number.isFinite(data.coverage)
    || typeof data.token !== "string" || !Array.isArray(data.reasons) || !Array.isArray(data.signals) || !Array.isArray(data.contributions)) return null;
  const freshness = data.signals.find(s => s.id === "freshness");
  const signals = data.signals.filter(s => SIGNALS.some(meta => meta.id === s.id)) as Signal[];
  const complete = SIGNALS.every(meta => signals.some(s => s.id === meta.id) && data.contributions.some(c => c.id === meta.id));
  if (!complete || !freshness || typeof freshness.risk !== "number") return null;
  return {
    decision: data.decision, risk: data.risk, mode: "live", coverage: data.coverage, explanation: String(data.explanation ?? ""),
    reasons: data.reasons.map(String), signals, contributions: data.contributions,
    server: { sessionId: data.session_id, policyVersion: data.policy_version, token: data.token,
      freshness: { risk: freshness.risk, provenance: "server", detail: freshness.detail } },
  };
}

/** One server-backed attempt. Events are batched in memory and flushed when a challenge ends. */
export class ServerSession {
  readonly id: string;
  readonly plan: Plan;
  readonly challenges: Challenge[];
  private queue: ClientEvent[] = [];
  private sending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(start: SessionStart, plan: Plan) { this.id = start.session_id; this.plan = plan; this.challenges = planToChallenges(plan); }

  record(challengeIndex: number, type: EventType, payload: ClientEvent["payload"] = {}) {
    const challenge = this.plan.challenges[challengeIndex];
    if (!challenge || this.closed) return;
    this.queue.push({ challenge_id: challenge.id, type, client_ts_ms: Date.now(), payload });
    if (type === "challenge_end") this.flush();
  }
  flush(): Promise<void> {
    const batch = this.queue.splice(0);
    if (batch.length) this.sending = this.sending.then(() => postEvents(this.id, batch)).then(() => undefined, () => undefined);
    return this.sending;
  }
  /** Server-recomputed, signed result; null means "show the local result with the local-only badge". */
  async complete(signals: Signal[], results: ChallengeResult[]): Promise<DecisionResult | null> {
    if (this.closed) return null;
    await this.flush();
    this.closed = true;
    try { return toDecisionResult(await complete(this.id, signals, results)); } catch { return null; }
  }
  cancel() {
    if (this.closed) return;
    this.closed = true; this.queue = [];
    cancelSession(this.id).catch(() => undefined);
  }
}

/** Never rejects. session === null means local-only; notice explains a dead help-desk link to the user. */
export async function openSession(options: { linkId?: string | null; presenterLabel?: string | null } = {}): Promise<{ session: ServerSession | null; notice: string }> {
  if (!apiConfigured()) return { session: null, notice: "" };
  try {
    const start = options.linkId ? await getPlan(options.linkId) : await createSession(options.presenterLabel || undefined);
    const plan = parsePlan(start?.plan);
    return plan && typeof start.session_id === "string" ? { session: new ServerSession(start, plan), notice: "" } : { session: null, notice: "" };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    const notice = !options.linkId ? "" : status === 409 ? "This verification link was already opened. Ask for a new link. Continuing in local-only mode."
      : status === 410 || status === 404 ? "This verification link has expired or is unknown. Ask for a new link. Continuing in local-only mode."
        : "The verification server could not be reached. Continuing in local-only mode.";
    return { session: null, notice };
  }
}

// --- Operator dashboard. The admin token is typed in by the operator and held in memory only. ---
export const adminSessions = (token: string, limit = 100) => request<{ sessions: AdminSession[] }>(`/api/admin/sessions?limit=${limit}`, { token });
export const adminSession = (token: string, id: string) => request<AdminSessionDetail>(`/api/admin/sessions/${encodeURIComponent(id)}`, { token });
export const adminSummary = (token: string) => request<AdminSummary>("/api/admin/summary", { token });
export const createLink = (token: string, label: string) => request<HelpDeskLink>("/api/links", { method: "POST", token, body: { label } });
/** EventSource cannot send headers, so the stream is the one endpoint that takes the token as a query parameter. */
export const adminStreamUrl = (token: string) => `${API_URL}/api/admin/stream?token=${encodeURIComponent(token)}`;
