import test from "node:test";
import assert from "node:assert/strict";
import { apiConfigured, openSession, parsePlan, planToChallenges, toDecisionResult } from "../lib/api.ts";
import type { CompleteResponse, Plan } from "../lib/api.ts";
import { evaluateRisk, SIGNALS } from "../lib/risk.ts";

const plan: Plan = { pulse_hold_ms: 12000, challenges: [
  { id: "c_1", kind: "digits", digits: "0427" },
  { id: "c_2", kind: "head_sequence", moves: ["up", "right", "down"] },
  { id: "c_3", kind: "cued_blink", cue_offsets_ms: [2000, 4500, 7000] },
] };
test("without NEXT_PUBLIC_API_URL the app stays local-only and never throws", async () => {
  assert.equal(apiConfigured(), false);
  assert.deepEqual(await openSession({ linkId: "anything" }), { session: null, notice: "" });
});
test("server plan keeps its order and digits when mapped onto today's challenges", () => {
  assert.deepEqual(planToChallenges(plan), [{ kind: "digits", digits: "0427" }, { kind: "head", direction: "right" }, { kind: "blink" }]);
});
test("malformed plans are refused", () => {
  assert.equal(parsePlan(plan), plan);
  for (const bad of [null, {}, { ...plan, challenges: plan.challenges.slice(0, 2) }, { ...plan, challenges: [plan.challenges[0], plan.challenges[0], plan.challenges[2]] },
    { ...plan, challenges: [{ id: "c_1", kind: "digits", digits: "12a4" }, plan.challenges[1], plan.challenges[2]] }]) assert.equal(parsePlan(bad), null);
});
test("server provenance is usable in live mode", () => {
  const result = evaluateRisk(SIGNALS.map(s => ({ id: s.id, risk: 10, provenance: "server" as const, detail: "" })), "live");
  assert.equal(result.coverage, 100);
});
test("server result maps to the UI shape with freshness kept out of the weighted signals", () => {
  const local = evaluateRisk([], "live");
  const response: CompleteResponse = { ...local, mode: "live", session_id: "s-1", policy_version: "0.2.0", token: "a.b.c",
    signals: [...local.signals, { id: "freshness", risk: 85, provenance: "server", detail: "flagged" }] };
  const result = toDecisionResult(response)!;
  assert.equal(result.signals.length, 5);
  assert.deepEqual(result.server, { sessionId: "s-1", policyVersion: "0.2.0", token: "a.b.c", freshness: { risk: 85, provenance: "server", detail: "flagged" } });
  assert.equal(toDecisionResult({ ...response, signals: local.signals }), null);
  assert.equal(toDecisionResult({ ...response, decision: "maybe" as never }), null);
});
