import test from "node:test";
import assert from "node:assert/strict";
import { COLORS, lightSequence, reflectionSignal } from "../lib/reflection.ts";
import type { ColorSample } from "../lib/reflection.ts";
test("light schedule has six slow plateaus without adjacent identical colors", () => {
  const s = lightSequence(); assert.equal(s.length, 6);
  for (let i = 1; i < s.length; i++) assert.notEqual(s[i].name, s[i - 1].name);
});
test("no light evidence stays unavailable", () => assert.equal(reflectionSignal([]).risk, null));
test("flat observed colors are insufficient evidence, not a pass", () => {
  const samples: ColorSample[] = Array.from({ length: 6 }, (_, step) => Array.from({ length: 4 }, () => ({ step, expected: COLORS[step % 3].rgb, observed: [110, 90, 80] as [number, number, number] }))).flat();
  assert.equal(reflectionSignal(samples).risk, null);
});
test("correlated color means get a heuristic score, not a simulated/validated pass", () => {
  const samples: ColorSample[] = Array.from({ length: 6 }, (_, step) => Array.from({ length: 4 }, () => ({ step, expected: COLORS[step % 3].rgb, observed: COLORS[step % 3].rgb }))).flat();
  const result = reflectionSignal(samples); assert.equal(result.risk, 25); assert.equal(result.provenance, "heuristic");
});
