import test from "node:test";
import assert from "node:assert/strict";
import { COLOR_HOLD_MS, COLORS, contrastRatio, CROSSFADE_MS, lightSequence, lockCamera, PLATEAUS, reflectionSignal, skinPatches, unlockCamera } from "../lib/reflection.ts";
import type { ColorSample, LockableTrack, RGB } from "../lib/reflection.ts";

test("light sequence: six plateaus, each color twice, never the same color twice in a row", () => {
  const orders = new Set<string>();
  for (let run = 0; run < 500; run++) {
    const s = lightSequence();
    assert.equal(s.length, PLATEAUS);
    for (let i = 1; i < s.length; i++) assert.notEqual(s[i].name, s[i - 1].name);
    for (const c of COLORS) assert.equal(s.filter(x => x.name === c.name).length, 2);
    orders.add(s.map(x => x.name[0]).join(""));
  }
  assert.ok(orders.size >= 12, `only ${orders.size} orders`);
});

test("plateaus are slow and crossfaded, not a strobe", () => {
  assert.ok(1000 / COLOR_HOLD_MS < 3, "under three changes per second");
  assert.ok(CROSSFADE_MS > 0 && CROSSFADE_MS < COLOR_HOLD_MS / 4);
});

test("stimuli are saturated and bright, and the black text panels stay readable on each", () => {
  for (const c of COLORS) {
    assert.ok(Math.max(...c.rgb) === 255 && Math.max(...c.rgb) - Math.min(...c.rgb) >= 190, `${c.name} saturation`);
    assert.ok(contrastRatio(c.hex, "#000000") >= 4.5, `${c.name}: ${contrastRatio(c.hex, "#000000").toFixed(2)}`);
  }
  assert.equal(contrastRatio("#ffffff", "#000000").toFixed(0), "21");
});

test("forehead and both cheeks are sampled; faces at the frame edge are refused", () => {
  const points = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5 }));
  assert.equal(skinPatches(points)?.length, 3);
  points[50] = { x: 0.03, y: 0.5 };
  assert.equal(skinPatches(points), null);
  assert.equal(skinPatches([]), null);
});

const samplesFrom = (observed: (step: number) => RGB): ColorSample[] =>
  Array.from({ length: 6 }, (_, step) => Array.from({ length: 4 }, () => ({ step, expected: COLORS[step % 3].rgb, observed: observed(step) }))).flat();

test("no light evidence stays unavailable", () => assert.equal(reflectionSignal([]).risk, null));

test("flat observed colors are insufficient evidence, not a pass", () => {
  const result = reflectionSignal(samplesFrom(() => [110, 90, 80]));
  assert.equal(result.risk, null);
  assert.match(result.detail, /too weak to measure \(chroma RMS 0\.0000\)/);
});

test("correlated color means get a heuristic score, not a simulated/validated pass", () => {
  const result = reflectionSignal(samplesFrom(step => COLORS[step % 3].rgb), ["exposureMode", "whiteBalanceMode"]);
  assert.equal(result.risk, 25);
  assert.equal(result.provenance, "heuristic");
  assert.match(result.detail, /correlation 1\.00/);
  assert.match(result.detail, /Exposure and white balance locked/);
});

test("a faint tint on skin still correlates; an unrelated tint scores high risk", () => {
  // Skin tone plus 4% of the screen color: what a lit face looks like.
  const skin: RGB = [150, 110, 95];
  const tinted = reflectionSignal(samplesFrom(step => skin.map((v, c) => v + 0.04 * COLORS[step % 3].rgb[c]) as RGB));
  assert.equal(tinted.risk, 25);
  // A replay whose colors follow its own schedule, not the one on this screen.
  const shifted = reflectionSignal(samplesFrom(step => skin.map((v, c) => v + 0.04 * COLORS[(step + 1) % 3].rgb[c]) as RGB));
  assert.equal(shifted.risk, 80);
  assert.match(shifted.detail, /Auto exposure and white balance, weaker test/);
});

/** A fake camera track that records constraint calls. */
function fakeTrack(modes: Record<string, string[]>, opts: { ignore?: boolean; reject?: boolean } = {}) {
  const calls: unknown[] = [];
  const settings: Record<string, string> = Object.fromEntries(Object.keys(modes).map(k => [k, "continuous"]));
  const track: LockableTrack = {
    readyState: "live",
    getCapabilities: () => modes,
    getSettings: () => ({ ...settings }),
    applyConstraints: async constraints => {
      calls.push(constraints);
      if (opts.reject) throw new Error("OverconstrainedError");
      if (!opts.ignore) Object.assign(settings, (constraints.advanced ?? [])[0]);
    },
  };
  return { track, calls, settings };
}

test("camera lock requests manual only for supported keys, then restores continuous", async () => {
  const both = fakeTrack({ exposureMode: ["manual", "continuous"], whiteBalanceMode: ["manual", "continuous"] });
  const keys = await lockCamera(both.track);
  assert.deepEqual(keys, ["whiteBalanceMode", "exposureMode"]);
  assert.deepEqual(both.calls[0], { advanced: [{ whiteBalanceMode: "manual", exposureMode: "manual" }] });
  await unlockCamera(both.track, keys);
  assert.deepEqual(both.settings, { exposureMode: "continuous", whiteBalanceMode: "continuous" });

  const exposureOnly = fakeTrack({ exposureMode: ["manual", "continuous"], whiteBalanceMode: ["continuous"] });
  assert.deepEqual(await lockCamera(exposureOnly.track), ["exposureMode"]);
  assert.deepEqual(exposureOnly.calls[0], { advanced: [{ exposureMode: "manual" }] });
});

test("camera lock reports nothing when the camera cannot or will not lock", async () => {
  const none = fakeTrack({ exposureMode: ["continuous"] });
  assert.deepEqual(await lockCamera(none.track), []);
  assert.equal(none.calls.length, 0);

  assert.deepEqual(await lockCamera(fakeTrack({ exposureMode: ["manual"] }, { ignore: true }).track), []);
  assert.deepEqual(await lockCamera(fakeTrack({ exposureMode: ["manual"] }, { reject: true }).track), []);
  assert.deepEqual(await lockCamera({ readyState: "live", applyConstraints: async () => undefined }), []);
  assert.deepEqual(await lockCamera(null), []);

  const ended = fakeTrack({ exposureMode: ["manual"] });
  ended.track.readyState = "ended";
  await unlockCamera(ended.track, ["exposureMode"]);
  assert.equal(ended.calls.length, 0);
});
