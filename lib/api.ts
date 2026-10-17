
import type {
  Challenge,
  ChallengeResult,
  Decision,
  DecisionResult,
  Signal,
} from "./types.ts";

import { SIGNALS } from "./risk.ts";

/**
 * Typed client for the optional Aegis Presence backend.
 *
 * NEXT_PUBLIC_API_URL is public configuration.
 * Never place secrets in NEXT_PUBLIC_* variables.
 *
 * Verification data contains numerical signals and events.
 * No raw camera frames or audio are uploaded.
 */

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "")
  .trim()
  .replace(/\/+$/, "");

const TIMEOUT_MS = 6000;
const GEMINI_TIMEOUT_MS = 30000;

export const apiConfigured = (): boolean => API_URL !== "";

// --------------------------------------------------
// Verification types
// --------------------------------------------------

export type Move = "left" | "right" | "up" | "down";

export type PlanChallenge =
  | {
      id: string;
      kind: "head_sequence";
      moves: Move[];
    }
  | {
      id: string;
      kind: "cued_blink";
      cue_offsets_ms: number[];
    }
  | {
      id: string;
      kind: "digits";
      digits: string;
    };

export interface Plan {
  challenges: PlanChallenge[];
  pulse_hold_ms: number;
}

export interface SessionStart {
  session_id: string;
  expires_at: string;
  server_now_ms: number;
  plan: Plan;
}

export type EventType =
  | "challenge_start"
  | "cue"
  | "response"
  | "challenge_end"
  | "pulse_result";

export interface ClientEvent {
  challenge_id: string;
  type: EventType;
  client_ts_ms: number;
  payload: Record<string, number | string | boolean | null>;
}

export interface ServerSignal {
  id: string;
  risk: number | null;
  provenance: Signal["provenance"];
  detail: string;
}

export interface CompleteResponse {
  session_id: string;
  decision: Decision;
  risk: number;
  coverage: number;
  mode: "live";
  explanation: string;
  reasons: string[];
  signals: ServerSignal[];
  contributions: DecisionResult["contributions"];
  policy_version: string;
  token: string;
}

// --------------------------------------------------
// Admin dashboard types
// --------------------------------------------------

export interface AdminSession {
  id: string;
  created_at: string;
  expires_at: string;
  status: string;
  plan_consumed: boolean;
  decision: Decision | null;
  risk: number | null;
  coverage: number | null;
  policy_version: string | null;
  presenter_label: string | null;
  link_label: string | null;
  ua_family: string | null;
}

export interface AdminSessionDetail extends AdminSession {
  events: (
    ClientEvent & {
      id: number;
      server_ts_ms: number;
    }
  )[];

  result:
    | Omit<
        CompleteResponse,
        "session_id" | "policy_version" | "token"
      >
    | null;
}

export interface AdminSummary {
  total: number;

  by_presenter_decision: {
    presenter_label: string | null;
    decision: Decision | null;
    count: number;
  }[];
}

export interface HelpDeskLink {
  session_id: string;
  verify_url: string;
  expires_at: string;
}

// --------------------------------------------------
// Gemini Security Analyst types
// --------------------------------------------------

export type GeminiSignalId =
  | "injection"
  | "liveness"
  | "reflection"
  | "pulse"
  | "sync"
  | "freshness";

export type GeminiConcern =
  | "low"
  | "medium"
  | "high"
  | "unavailable";

export interface GeminiFinding {
  signal_id: GeminiSignalId;
  observation: string;
  concern: GeminiConcern;
  explanation: string;
}

export interface GeminiAnalystReport {
  summary: string;
  findings: GeminiFinding[];
  missing_evidence: string[];
  recommended_next_steps: string[];
  confidence: "low" | "medium" | "high";
  limitations: string;
}

export interface GeminiAnalysisResponse {
  session_id: string;
  policy_decision: Decision;
  policy_risk: number;
  analyst: GeminiAnalystReport;
  advisory_only: true;
}

// --------------------------------------------------
// API request handling
// --------------------------------------------------

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  timeoutMs?: number;
}

async function request<T>(
  path: string,
  init: RequestOptions = {}
): Promise<T> {
  if (!API_URL) {
    throw new ApiError(0, "No API configured");
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? TIMEOUT_MS
  );

  try {
    const headers: Record<string, string> = {};

    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (init.token) {
      headers.Authorization = `Bearer ${init.token}`;
    }

    const response = await fetch(API_URL + path, {
      method: init.method || "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      body:
        init.body === undefined
          ? undefined
          : JSON.stringify(init.body),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new ApiError(
        response.status,
        typeof data?.detail === "string"
          ? data.detail
          : `Request failed (${response.status})`
      );
    }

    return data as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (controller.signal.aborted) {
      throw new ApiError(
        0,
        "The verification server request timed out."
      );
    }

    throw new ApiError(
      0,
      "The verification server is unreachable."
    );
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------
// Challenge plan validation
// --------------------------------------------------

const MOVES: Move[] = ["left", "right", "up", "down"];

/**
 * Validate a server-generated challenge plan.
 * Invalid plans are rejected rather than trusted.
 */
export function parsePlan(value: unknown): Plan | null {
  const plan = value as Plan | null;

  if (
    !plan ||
    !Array.isArray(plan.challenges) ||
    plan.challenges.length !== 3 ||
    !Number.isFinite(plan.pulse_hold_ms)
  ) {
    return null;
  }

  const valid = plan.challenges.every(
    (c) =>
      c &&
      typeof c.id === "string" &&
      c.id.length > 0 &&
      c.id.length <= 64 &&
      (c.kind === "head_sequence"
        ? Array.isArray(c.moves) &&
          c.moves.length > 0 &&
          c.moves.every((m) => MOVES.includes(m))
        : c.kind === "cued_blink"
          ? Array.isArray(c.cue_offsets_ms) &&
            c.cue_offsets_ms.every((n) =>
              Number.isFinite(n)
            )
          : c.kind === "digits" &&
            typeof c.digits === "string" &&
            /^\d{4}$/.test(c.digits))
  );

  return (
    valid &&
    new Set(plan.challenges.map((c) => c.kind)).size === 3
  )
    ? plan
    : null;
}

/**
 * Interim mapping onto the current Challenge type.
 *
 * Server-selected order and digits are honored.
 * Head sequences use the first left/right move.
 * Up/down and blink timing offsets are not yet supported.
 */
export function planToChallenges(plan: Plan): Challenge[] {
  return plan.challenges.map((c): Challenge => {
    if (c.kind === "head_sequence") {
      return {
        kind: "head",
        direction:
          c.moves.find(
            (m): m is "left" | "right" =>
              m === "left" || m === "right"
          ) ?? "left",
      };
    }

    if (c.kind === "cued_blink") {
      return { kind: "blink" };
    }

    return {
      kind: "digits",
      digits: c.digits,
    };
  });
}

// --------------------------------------------------
// Session API
// --------------------------------------------------

export function createSession(
  presenterLabel?: string
): Promise<SessionStart> {
  return request<SessionStart>("/api/sessions", {
    method: "POST",
    body: {
      client_now_ms: Date.now(),
      ...(presenterLabel
        ? { presenter_label: presenterLabel.slice(0, 64) }
        : {}),
    },
  });
}

/** Fetch a single-use help-desk session plan. */
export function getPlan(
  sessionId: string
): Promise<SessionStart> {
  return request<SessionStart>(
    `/api/sessions/${encodeURIComponent(
      sessionId
    )}/plan?client_now_ms=${Date.now()}`
  );
}

export function postEvents(
  sessionId: string,
  events: ClientEvent[]
): Promise<{ accepted: number }> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    {
      method: "POST",
      body: { events },
    }
  );
}

export function complete(
  sessionId: string,
  signals: Signal[],
  challengeResults: ChallengeResult[]
): Promise<CompleteResponse> {
  const short = (text: string) => text.slice(0, 400);

  return request<CompleteResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/complete`,
    {
      method: "POST",
      body: {
        signals: signals.map((s) => ({
          id: s.id,
          risk: s.risk,
          provenance: s.provenance,
          detail: short(s.detail),
        })),

        challenge_results: challengeResults.map((r) => ({
          kind: r.kind,
          status: r.status,
          risk: r.risk,
          detail: short(r.detail),
        })),
      },
    }
  );
}

export function cancelSession(
  sessionId: string
): Promise<unknown> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: "POST",
    }
  );
}

// --------------------------------------------------
// Server result validation
// --------------------------------------------------

/**
 * Convert the server response into the DecisionResult
 * consumed by the verification UI.
 */
export function toDecisionResult(
  data: CompleteResponse
): DecisionResult | null {
  const decisions: Decision[] = [
    "approve",
    "step-up",
    "reject",
  ];

  if (
    !data ||
    !decisions.includes(data.decision) ||
    !Number.isFinite(data.risk) ||
    !Number.isFinite(data.coverage) ||
    typeof data.token !== "string" ||
    !Array.isArray(data.reasons) ||
    !Array.isArray(data.signals) ||
    !Array.isArray(data.contributions)
  ) {
    return null;
  }

  const freshness = data.signals.find(
    (s) => s.id === "freshness"
  );

  const signals = data.signals.filter((s) =>
    SIGNALS.some((meta) => meta.id === s.id)
  ) as Signal[];

  const complete = SIGNALS.every(
    (meta) =>
      signals.some((s) => s.id === meta.id) &&
      data.contributions.some(
        (c) => c.id === meta.id
      )
  );

  if (
    !complete ||
    !freshness ||
    typeof freshness.risk !== "number"
  ) {
    return null;
  }

  return {
    decision: data.decision,
    risk: data.risk,
    mode: "live",
    coverage: data.coverage,
    explanation: String(data.explanation ?? ""),
    reasons: data.reasons.map(String),
    signals,
    contributions: data.contributions,

    server: {
      sessionId: data.session_id,
      policyVersion: data.policy_version,
      token: data.token,

      freshness: {
        risk: freshness.risk,
        provenance: "server",
        detail: freshness.detail,
      },
    },
  };
}

// --------------------------------------------------
// Server-backed verification session
// --------------------------------------------------

export class ServerSession {
  readonly id: string;
  readonly plan: Plan;
  readonly challenges: Challenge[];

  private queue: ClientEvent[] = [];
  private sending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(start: SessionStart, plan: Plan) {
    this.id = start.session_id;
    this.plan = plan;
    this.challenges = planToChallenges(plan);
  }

  record(
    challengeIndex: number,
    type: EventType,
    payload: ClientEvent["payload"] = {}
  ) {
    const challenge = this.plan.challenges[challengeIndex];

    if (!challenge || this.closed) {
      return;
    }

    this.queue.push({
      challenge_id: challenge.id,
      type,
      client_ts_ms: Date.now(),
      payload,
    });

    if (type === "challenge_end") {
      this.flush();
    }
  }

  flush(): Promise<void> {
    const batch = this.queue.splice(0);

    if (batch.length) {
      this.sending = this.sending
        .then(() => postEvents(this.id, batch))
        .then(
          () => undefined,
          () => undefined
        );
    }

    return this.sending;
  }

  /**
   * Request a signed, server-recomputed result.
   * Returns null if the server cannot complete the session.
   */
  async complete(
    signals: Signal[],
    results: ChallengeResult[]
  ): Promise<DecisionResult | null> {
    if (this.closed) {
      return null;
    }

    await this.flush();
    this.closed = true;

    try {
      const response = await complete(
        this.id,
        signals,
        results
      );

      return toDecisionResult(response);
    } catch {
      return null;
    }
  }

  cancel() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.queue = [];

    cancelSession(this.id).catch(() => undefined);
  }
}

// --------------------------------------------------
// Session opening and local-only fallback
// --------------------------------------------------

export async function openSession(
  options: {
    linkId?: string | null;
    presenterLabel?: string | null;
  } = {}
): Promise<{
  session: ServerSession | null;
  notice: string;
}> {
  if (!apiConfigured()) {
    return {
      session: null,
      notice: "",
    };
  }

  try {
    const start = options.linkId
      ? await getPlan(options.linkId)
      : await createSession(
          options.presenterLabel || undefined
        );

    const plan = parsePlan(start?.plan);

    return plan && typeof start.session_id === "string"
      ? {
          session: new ServerSession(start, plan),
          notice: "",
        }
      : {
          session: null,
          notice: "",
        };
  } catch (error) {
    const status =
      error instanceof ApiError ? error.status : 0;

    const notice = !options.linkId
      ? ""
      : status === 409
        ? "This verification link was already opened. Ask for a new link. Continuing in local-only mode."
        : status === 410 || status === 404
          ? "This verification link has expired or is unknown. Ask for a new link. Continuing in local-only mode."
          : "The verification server could not be reached. Continuing in local-only mode.";

    return {
      session: null,
      notice,
    };
  }
}

// --------------------------------------------------
// Admin dashboard API
// --------------------------------------------------

/**
 * Admin credentials remain in component memory.
 * They must never be embedded in the public bundle.
 */

export const adminSessions = (
  token: string,
  limit = 100
) =>
  request<{ sessions: AdminSession[] }>(
    `/api/admin/sessions?limit=${limit}`,
    { token }
  );

export const adminSession = (
  token: string,
  id: string
) =>
  request<AdminSessionDetail>(
    `/api/admin/sessions/${encodeURIComponent(id)}`,
    { token }
  );

export const adminSummary = (token: string) =>
  request<AdminSummary>(
    "/api/admin/summary",
    { token }
  );

export const createLink = (
  token: string,
  label: string
) =>
  request<HelpDeskLink>(
    "/api/links",
    {
      method: "POST",
      token,
      body: { label },
    }
  );

/**
 * EventSource cannot send Authorization headers.
 * The existing stream endpoint uses a token query parameter.
 */
export const adminStreamUrl = (token: string) =>
  `${API_URL}/api/admin/stream?token=${encodeURIComponent(
    token
  )}`;

// --------------------------------------------------
// Gemini Security Analyst API
// --------------------------------------------------

/**
 * Generate an advisory Gemini report for a completed session.
 *
 * - Requires the existing admin bearer token.
 * - The backend retrieves stored verification evidence.
 * - No raw media or browser-supplied risk scores are sent.
 * - Gemini cannot modify the authoritative policy decision.
 * - Uses a longer timeout than ordinary API requests.
 */
export function analyzeSessionWithGemini(
  token: string,
  sessionId: string
): Promise<GeminiAnalysisResponse> {
  return request<GeminiAnalysisResponse>(
    `/api/admin/sessions/${encodeURIComponent(
      sessionId
    )}/analyze`,
    {
      method: "POST",
      token,
      timeoutMs: GEMINI_TIMEOUT_MS,
    }
  );
}
