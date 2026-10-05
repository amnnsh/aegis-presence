import test from "node:test";
import assert from "node:assert/strict";
import { inspectCamera } from "../lib/injection.ts";
const normal = { label: "Integrated Camera", width: 640, height: 480, declaredFps: 24, observedFps: 24 };
test("no device means missing, not good", () => assert.equal(inspectCamera(null).risk, null));
test("normal metadata has low heuristic risk, not attested provenance", () => {
  assert.equal(inspectCamera(normal).risk, 8); assert.equal(inspectCamera(normal).provenance, "heuristic");
});
test("virtual label raises concern but acknowledges legitimate usage", () => {
  const result = inspectCamera({ ...normal, label: "OBS Virtual Camera" });
  assert.ok(result.risk! >= 70); assert.match(result.detail, /legitimate/);
});
test("resolution and cadence flags are visible", () => {
  const result = inspectCamera({ ...normal, width: 160, height: 120, observedFps: 5 });
  assert.match(result.detail, /resolution/); assert.match(result.detail, /cadence/); assert.ok(result.risk! > 30);
});
test("unreported measured FPS is not made up", () => assert.doesNotMatch(inspectCamera({ ...normal, observedFps: null }).detail, /low observed/));
