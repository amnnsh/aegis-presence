import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTexture, cropBox, landmarkBox, median } from "../lib/texture.ts";
import { evaluateRisk, SIGNALS } from "../lib/risk.ts";
import type { Signal } from "../lib/types.ts";

const repeat = (value: number, n = 6) => Array.from({ length: n }, () => value);

test("fewer than six scores is insufficient, not a pass", () => {
  assert.deepEqual(analyzeTexture([]), { risk: null, detail: "Insufficient frames" });
  assert.deepEqual(analyzeTexture(repeat(0.99, 5)), { risk: null, detail: "Insufficient frames" });
  assert.equal(analyzeTexture(repeat(0.99, 6)).risk, 15);
});
test("median thresholds: >= 0.70 is 15, >= 0.40 is 45, lower is 80", () => {
  assert.equal(analyzeTexture(repeat(0.7)).risk, 15);
  assert.equal(analyzeTexture(repeat(0.6999)).risk, 45);
  assert.equal(analyzeTexture(repeat(0.4)).risk, 45);
  assert.equal(analyzeTexture(repeat(0.3999)).risk, 80);
  assert.equal(analyzeTexture(repeat(0)).risk, 80);
});
test("the median, not the mean, decides: a few outliers do not flip the result", () => {
  assert.equal(analyzeTexture([0.9, 0.9, 0.9, 0.9, 0.05, 0.05]).risk, 15); // mean 0.62, median 0.9
  assert.equal(analyzeTexture([0.1, 0.1, 0.1, 0.1, 1, 1]).risk, 80);
  assert.equal(median([0.2, 0.8, 0.4, 0.6]), 0.5);
  assert.equal(median([]), null);
});
test("the detail names the median and says it is not validated", () => {
  assert.equal(analyzeTexture([0.81, 0.83, 0.85, 0.79, 0.9, 0.88]).detail,
    "Experimental texture check: median real-face score 0.84. Not validated.");
});

test("landmark box is the min/max extent in pixels", () => {
  assert.deepEqual(landmarkBox([{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.25 }, { x: 0.5, y: 0.75 }], 640, 480), [160, 120, 320, 240]);
  assert.equal(landmarkBox([], 640, 480), null);
  assert.equal(landmarkBox([{ x: 0.5, y: 0.5 }], 640, 480), null);
});
test("crop box is scaled about the box centre when it fits", () => {
  // 100x100 face centred at (320, 240): 2.7x gives 270x270.
  assert.deepEqual(cropBox(640, 480, [270, 190, 100, 100], 2.7), [185, 105, 455, 375]);
});
test("crop box scale is capped by the frame, as upstream does", () => {
  // 4.0 would be 800 px; capped to (480 - 1) / 200 = 2.395, i.e. 479 px. Top edge shifts down by 39.5.
  assert.deepEqual(cropBox(640, 480, [200, 100, 200, 200], 4.0), [60, 0, 539, 479]);
});
test("crop box is shifted, not shrunk, at the left and top edges", () => {
  const [x1, y1, x2, y2] = cropBox(640, 480, [0, 0, 100, 100], 2.7);
  assert.deepEqual([x1, y1, x2, y2], [0, 0, 270, 270]);
});
test("crop box is shifted, not shrunk, at the right and bottom edges", () => {
  // 80x80 face at the bottom-right corner: 216x216 box, pushed back by 69 px on each axis.
  assert.deepEqual(cropBox(640, 480, [560, 400, 80, 80], 2.7), [423, 263, 639, 479]);
});

const heuristic = (risk: number): Signal[] => SIGNALS.map(s => ({ id: s.id, risk, provenance: "heuristic", detail: "Unit-test input" }));
test("texture carries 15% of the policy and missing texture costs 60 at that weight", () => {
  assert.equal(SIGNALS.find(s => s.id === "texture")!.weight, 15);
  const missing = evaluateRisk(heuristic(0).filter(s => s.id !== "texture"), "simulation");
  assert.equal(missing.risk, 9); assert.equal(missing.coverage, 85);
  const insufficient = analyzeTexture(repeat(0.9, 3));
  const unavailable = evaluateRisk([...heuristic(0).filter(s => s.id !== "texture"),
    { id: "texture", risk: insufficient.risk, provenance: "unavailable", detail: insufficient.detail }], "simulation");
  assert.equal(unavailable.risk, 9); assert.equal(unavailable.contributions.find(c => c.id === "texture")!.usedRisk, 60);
});
