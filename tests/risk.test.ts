import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk, SIGNALS } from "../lib/risk.ts";
import { scenarioResult, SCENARIOS } from "../lib/scenarios.ts";
import type { Signal } from "../lib/types.ts";
const observed = (score: number): Signal[] => SIGNALS.map(s => ({ id: s.id, risk: score, provenance: "heuristic", detail: "Unit-test input" }));
test("weights sum to 100", () => assert.equal(SIGNALS.reduce((sum, s) => sum + s.weight, 0), 100));
test("normal fixture approves, replay and deepfake reject, virtual feed steps up", () => {
  assert.equal(scenarioResult("normal").decision, "approve");
  assert.equal(scenarioResult("replay").decision, "reject");
  assert.equal(scenarioResult("virtual").decision, "step-up");
  assert.equal(scenarioResult("deepfake").decision, "reject");
});
test("all four scenarios have distinct risk indices and simulated provenance", () => {
  assert.equal(new Set(SCENARIOS.map(s => scenarioResult(s.id).risk)).size, 4);
  for (const s of SCENARIOS) assert.ok(scenarioResult(s.id).signals.every(row => row.provenance === "simulated"));
});
test("empty live session never approves", () => {
  const result = evaluateRisk([], "live");
  assert.equal(result.risk, 60); assert.equal(result.coverage, 0); assert.equal(result.decision, "step-up");
});
test("simulated clean evidence never approves a live user", () => {
  const signals = scenarioResult("normal").signals;
  const result = evaluateRisk(signals, "live");
  assert.equal(result.risk, 60); assert.equal(result.coverage, 0); assert.equal(result.decision, "step-up");
});
test("all low observed scores still cannot approve in the prototype", () => assert.equal(evaluateRisk(observed(0), "live").decision, "step-up"));
test("invalid, missing, duplicate, and non-finite scores cost 60", () => {
  const rows = observed(0); rows[0].risk = NaN; rows[1].risk = -1; rows[2].risk = 101; rows[3].risk = Infinity; rows.push({ ...rows[4] });
  const result = evaluateRisk(rows, "live");
  assert.equal(result.risk, 60); assert.equal(result.coverage, 0); assert.equal(result.decision, "step-up");
});
test("no renormalization: missing 30% liveness weight contributes 18 risk", () => {
  const result = evaluateRisk(observed(0).filter(s => s.id !== "liveness"), "simulation");
  assert.equal(result.risk, 18); assert.equal(result.coverage, 70); assert.equal(result.decision, "step-up");
});
test("threshold boundaries use the unrounded score", () => {
  assert.equal(evaluateRisk(observed(29.6), "simulation").decision, "approve");
  assert.equal(evaluateRisk(observed(30), "simulation").decision, "step-up");
  assert.equal(evaluateRisk(observed(64.9), "simulation").decision, "step-up");
  assert.equal(evaluateRisk(observed(65), "simulation").decision, "reject");
});
test("virtual label alone vetoes approval but cannot reject", () => {
  const rows = observed(0); rows[0].risk = 82;
  assert.equal(evaluateRisk(rows, "simulation").decision, "step-up");
  assert.equal(evaluateRisk(rows, "live").decision, "step-up");
});
test("multiple high usable signals can yield an illustrative live reject", () => {
  const rows = observed(80);
  assert.equal(evaluateRisk(rows, "live").decision, "reject");
});
test("input objects are not mutated", () => {
  const rows = observed(12); const before = structuredClone(rows); evaluateRisk(rows, "live"); assert.deepEqual(rows, before);
});
