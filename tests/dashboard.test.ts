import test from "node:test";
import assert from "node:assert/strict";
import { clearToken, kpis, loadToken, MAX_ROWS, mergeSession, parseStreamMessage, PRESENTER_LABELS, presenterLabel, resultsTable, saveToken, timingSummary } from "../lib/dashboard.ts";
import type { AdminSession, AdminSessionDetail, AdminSummary } from "../lib/api.ts";

const summary: AdminSummary = { total: 11, by_presenter_decision: [
  { presenter_label: null, decision: "step-up", count: 2 },
  { presenter_label: null, decision: null, count: 1 },
  { presenter_label: "phone replay", decision: "reject", count: 2 },
  { presenter_label: "phone replay", decision: "step-up", count: 1 },
  { presenter_label: "genuine", decision: "step-up", count: 3 },
  { presenter_label: "genuine", decision: null, count: 1 },
  { presenter_label: "zz custom", decision: "approve", count: 1 },
] };

test("presenter labels: the five menu values only", () => {
  assert.deepEqual([...PRESENTER_LABELS], ["genuine", "phone replay", "virtual camera", "face-swap", "other"]);
  assert.equal(presenterLabel(" Phone Replay "), "phone replay");
  assert.equal(presenterLabel("attacker"), "");
  assert.equal(presenterLabel(null), "");
});

test("results table: labeled, decided sessions only, so every row adds up", () => {
  const table = resultsTable(summary);
  assert.deepEqual(table.rows, [
    { label: "genuine", n: 3, approve: 0, stepUp: 3, reject: 0 },
    { label: "phone replay", n: 3, approve: 0, stepUp: 1, reject: 2 },
    { label: "zz custom", n: 1, approve: 1, stepUp: 0, reject: 0 },
  ]);
  assert.equal(table.n, 7);
  assert.equal(table.undecided, 1);
  assert.equal(table.unlabeled, 3);
  for (const row of table.rows) assert.equal(row.approve + row.stepUp + row.reject, row.n);
  assert.deepEqual(resultsTable(null), { rows: [], n: 0, undecided: 0, unlabeled: 0 });
});

test("KPIs count every session in retention, labeled or not", () => {
  assert.deepEqual(kpis(summary), { total: 11, approve: 1, stepUp: 6, reject: 2 });
  assert.equal(kpis(null), null);
});

const row = (id: string, created: string, extra: Partial<AdminSession> = {}): AdminSession => ({
  id, created_at: created, expires_at: created, status: "active", plan_consumed: true, decision: null, risk: null, coverage: null,
  policy_version: null, presenter_label: null, link_label: null, ua_family: null, ...extra,
});

test("stream updates insert new sessions on top and replace changed ones in place", () => {
  let rows = [row("b", "2026-10-17T10:00:02Z"), row("a", "2026-10-17T10:00:01Z")];
  rows = mergeSession(rows, row("c", "2026-10-17T10:00:03Z"));
  assert.deepEqual(rows.map(r => r.id), ["c", "b", "a"]);
  rows = mergeSession(rows, row("a", "2026-10-17T10:00:01Z", { status: "completed", decision: "reject", risk: 71 }));
  assert.deepEqual(rows.map(r => r.id), ["c", "b", "a"]);
  assert.equal(rows[2].decision, "reject");
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => row(`s${i}`, new Date(Date.UTC(2026, 9, 17, 10, 0, i)).toISOString()));
  assert.equal(many.reduce(mergeSession, [] as AdminSession[]).length, MAX_ROWS);
});

test("stream frames are parsed defensively", () => {
  const session = row("a", "2026-10-17T10:00:01Z");
  assert.deepEqual(parseStreamMessage(JSON.stringify({ type: "session.completed", session })), { type: "session.completed", session });
  assert.equal(parseStreamMessage("not json"), null);
  assert.equal(parseStreamMessage(JSON.stringify({ type: "session.created" })), null);
  assert.equal(parseStreamMessage(JSON.stringify({ type: 3, session })), null);
});

test("timing summary: duration, cues, and first response per cue", () => {
  const ev = (challenge_id: string, type: AdminSessionDetail["events"][number]["type"], client_ts_ms: number, payload = {}) =>
    ({ id: 0, server_ts_ms: 0, challenge_id, type, client_ts_ms, payload });
  const detail = {
    plan: { pulse_hold_ms: 12000, challenges: [
      { id: "h", kind: "head_sequence" as const, moves: ["left" as const, "up" as const] },
      { id: "d", kind: "digits" as const, digits: "1234" },
    ] },
    events: [
      ev("h", "challenge_start", 1000, { kind: "head_sequence" }), ev("h", "cue", 1800, { index: 0 }), ev("h", "response", 2150, { index: 0 }),
      ev("h", "cue", 3000, { index: 1 }), ev("h", "response", 3420, { index: 1 }), ev("h", "response", 3500, { index: 1 }),
      ev("h", "challenge_end", 4100, { status: "observed" }), ev("d", "challenge_start", 5300, { kind: "digits" }),
    ],
  };
  assert.deepEqual(timingSummary(detail), [
    { id: "h", kind: "head_sequence", cues: 2, latenciesMs: [350, 420], durationMs: 3100, status: "observed" },
    { id: "d", kind: "digits", cues: 0, latenciesMs: [], durationMs: null, status: null },
  ]);
});

test("the admin token lives in sessionStorage and survives blocked storage", () => {
  const store = new Map<string, string>();
  const g = globalThis as { sessionStorage?: unknown };
  g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  saveToken("t0k3n");
  assert.equal(loadToken(), "t0k3n");
  clearToken();
  assert.equal(loadToken(), "");
  g.sessionStorage = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); }, removeItem: () => { throw new Error("SecurityError"); } };
  assert.doesNotThrow(() => saveToken("x"));
  assert.equal(loadToken(), "");
  assert.doesNotThrow(() => clearToken());
  delete g.sessionStorage;
  assert.equal(loadToken(), "");
});
