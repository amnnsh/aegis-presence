import test from "node:test";
import assert from "node:assert/strict";
import { CAMERA_FLAGS, describeControls, describeFrameTiming, frameTimingStats, grayHash, inspectCamera, summarizeCapabilities } from "../lib/injection.ts";
import type { FrameSample } from "../lib/injection.ts";
import type { CameraCapabilities, DeviceEvidence, FrameTiming } from "../lib/types.ts";

const normal: DeviceEvidence = { label: "Integrated Camera", width: 640, height: 480, declaredFps: 24, observedFps: 24 };

/** A typical built-in webcam in Chrome: adjustable controls, the scaler's min of 1, real timing jitter. */
const laptopCaps: CameraCapabilities = {
  hasExposureControl: true, hasFocusControl: false, hasWhiteBalanceControl: true,
  width: { min: 1, max: 1280 }, height: { min: 1, max: 720 }, frameRate: { min: 0, max: 30 },
};
const laptopTiming: FrameTiming = { frames: 72, meanIntervalMs: 41.7, stdIntervalMs: 1.3, maxGapMs: 70, duplicateFrameRatio: 0.01 };
const laptop: DeviceEvidence = { ...normal, label: "Integrated Webcam", capabilities: laptopCaps, videoInputCount: 1, frameTiming: laptopTiming };

/** A software camera with only a fixed mode and no controls. */
const fixedNoControls: CameraCapabilities = {
  hasExposureControl: false, hasFocusControl: false, hasWhiteBalanceControl: false,
  width: { min: 1280, max: 1280 }, height: { min: 720, max: 720 }, frameRate: { min: 30, max: 30 },
};
const timing = (overrides: Partial<FrameTiming>) => ({ ...laptopTiming, ...overrides });

// ------------------------------------------
// Existing behavior
// ------------------------------------------

test("no device means missing, not good", () => assert.equal(inspectCamera(null).risk, null));

test("normal metadata has low heuristic risk, not attested provenance", () => {
  assert.equal(inspectCamera(normal).risk, 8);
  assert.equal(inspectCamera(normal).provenance, "heuristic");
});

test("resolution and cadence flags are visible", () => {
  const result = inspectCamera({ ...normal, width: 160, height: 120, observedFps: 5 });
  assert.match(result.detail, /resolution/); assert.match(result.detail, /cadence/); assert.ok(result.risk! > 30);
});

test("unreported measured FPS is not made up", () => assert.doesNotMatch(inspectCamera({ ...normal, observedFps: null }).detail, /low observed/));

// ------------------------------------------
// New flags
// ------------------------------------------

test("a clean built-in laptop camera stays low", () => {
  const result = inspectCamera(laptop);
  assert.equal(result.risk, 8);
  assert.match(result.detail, /No configured metadata or frame-timing anomaly found/);
});

test("virtual-camera label is kept but now adds 35, and says it can be legitimate", () => {
  const result = inspectCamera({ ...laptop, label: "OBS Virtual Camera" });
  assert.equal(result.risk, 8 + CAMERA_FLAGS.virtualLabel);
  assert.match(result.detail, /virtual-camera-like label \(can be legitimate\)/);
});

test("no controls AND one fixed resolution adds 25; either alone does not", () => {
  const flagged = inspectCamera({ ...laptop, capabilities: fixedNoControls });
  assert.equal(flagged.risk, 8 + 25);
  assert.match(flagged.detail, /no exposure \/ focus \/ white-balance control and one fixed 1280x720 mode.*can be legitimate/);

  // Controls present, fixed resolution: a real fixed-mode webcam.
  assert.equal(inspectCamera({ ...laptop, capabilities: { ...fixedNoControls, hasFocusControl: true } }).risk, 8);
  // No controls, but a resolution range: e.g. a browser that does not expose controls.
  assert.equal(inspectCamera({ ...laptop, capabilities: { ...fixedNoControls, width: { min: 1, max: 1280 } } }).risk, 8);
  // Unknown capabilities are not a flag.
  assert.equal(inspectCamera({ ...laptop, capabilities: null }).risk, 8);
  assert.equal(inspectCamera({ ...laptop, capabilities: { ...fixedNoControls, width: null, height: null } }).risk, 8);
});

test("machine-perfect cadence (< 0.2 ms spread over >= 60 frames) adds 20", () => {
  const flagged = inspectCamera({ ...laptop, frameTiming: timing({ frames: 60, stdIntervalMs: 0.19 }) });
  assert.equal(flagged.risk, 8 + 20);
  assert.match(flagged.detail, /machine-perfect frame cadence \(0\.19 ms spread over 60 frames; can be legitimate/);
  assert.equal(inspectCamera({ ...laptop, frameTiming: timing({ frames: 60, stdIntervalMs: 0.2 }) }).risk, 8);
  assert.equal(inspectCamera({ ...laptop, frameTiming: timing({ frames: 59, stdIntervalMs: 0 }) }).risk, 8);
});

test("more than 20% repeated frames adds 25 (frozen or looping feed)", () => {
  const flagged = inspectCamera({ ...laptop, frameTiming: timing({ duplicateFrameRatio: 0.5 }) });
  assert.equal(flagged.risk, 8 + 25);
  assert.match(flagged.detail, /50% repeated identical frames, as from a frozen or looping feed \(can be legitimate/);
  assert.equal(inspectCamera({ ...laptop, frameTiming: timing({ duplicateFrameRatio: 0.2 }) }).risk, 8);
  assert.equal(inspectCamera({ ...laptop, frameTiming: timing({ frames: 10, duplicateFrameRatio: 1 }) }).risk, 8);
});

test("a gap over 500 ms between frames adds 10", () => {
  const flagged = inspectCamera({ ...laptop, frameTiming: timing({ maxGapMs: 640 }) });
  assert.equal(flagged.risk, 8 + 10);
  assert.match(flagged.detail, /640 ms gap between frames \(can be legitimate under heavy CPU load\)/);
  assert.equal(inspectCamera({ ...laptop, frameTiming: timing({ maxGapMs: 500 }) }).risk, 8);
});

test("a renamed virtual camera playing a video scores clearly higher without any label flag", () => {
  const renamed = inspectCamera({ ...laptop, capabilities: fixedNoControls,
    frameTiming: timing({ frames: 90, stdIntervalMs: 0.05, duplicateFrameRatio: 0.2 + 0.05 }) });
  assert.equal(renamed.risk, 8 + 25 + 20 + 25);
  assert.doesNotMatch(renamed.detail, /label/);
  assert.ok(renamed.risk! >= 70, "reaches the policy's camera veto");
});

test("risk is capped at 95 and provenance stays heuristic", () => {
  const worst = inspectCamera({ label: "OBS Virtual Camera", width: 160, height: 120, declaredFps: 5, observedFps: 2,
    capabilities: fixedNoControls, frameTiming: timing({ frames: 90, stdIntervalMs: 0, duplicateFrameRatio: 0.9, maxGapMs: 900 }) });
  assert.equal(worst.risk, 95);
  assert.equal(worst.provenance, "heuristic");
});

// ------------------------------------------
// Measurement helpers
// ------------------------------------------

test("capability summary: switchable modes or adjustable ranges count; ids are never copied", () => {
  // Chromium's fake camera, as reported by getCapabilities().
  const chromiumFake = {
    deviceId: "b6346d18", groupId: "7b1e3653", resizeMode: ["none", "crop-and-scale"],
    exposureMode: ["manual", "continuous"], exposureTime: { min: 10, max: 100, step: 5 },
    focusMode: ["manual", "continuous"], focusDistance: { min: 10, max: 100, step: 5 },
    width: { min: 1, max: 3840 }, height: { min: 1, max: 2160 }, frameRate: { min: 0, max: 20 },
  };
  const summary = summarizeCapabilities(chromiumFake)!;
  assert.deepEqual(summary, {
    hasExposureControl: true, hasFocusControl: true, hasWhiteBalanceControl: false,
    width: { min: 1, max: 3840 }, height: { min: 1, max: 2160 }, frameRate: { min: 0, max: 20 },
  });
  assert.ok(!JSON.stringify(summary).includes("b6346d18"));

  const fixedOnly = summarizeCapabilities({ exposureMode: ["continuous"], colorTemperature: { min: 4000, max: 4000 }, width: { min: 640, max: 640 } })!;
  assert.equal(fixedOnly.hasExposureControl, false);
  assert.equal(fixedOnly.hasWhiteBalanceControl, false);
  assert.equal(fixedOnly.height, null);
  assert.equal(summarizeCapabilities(null), null);
});

test("thumbnail hashes are equal only for identical grayscale frames", () => {
  const frame = Array.from({ length: 16 * 12 * 4 }, (_, i) => (i * 37) % 256);
  const copy = [...frame];
  const changed = [...frame]; changed[401] = (changed[401] + 10) % 256; // green channel of one pixel
  assert.equal(grayHash(frame), grayHash(copy));
  assert.notEqual(grayHash(frame), grayHash(changed));
  // Hashing is on 8-bit grayscale: a change too small to move the gray value is not a new frame.
  const faint = [...frame]; faint[400] = frame[400] ^ 1; // red +-1 moves gray by 77/256 of a level
  assert.equal(grayHash(faint) === grayHash(frame), ((frame[400] * 77 + frame[401] * 150 + frame[402] * 29) >> 8) === ((faint[400] * 77 + frame[401] * 150 + frame[402] * 29) >> 8));
  assert.ok(Number.isInteger(grayHash(frame)) && grayHash(frame) >= 0);
});

const stream = (count: number, interval: (i: number) => number, hash: (i: number) => number): FrameSample[] => {
  const out: FrameSample[] = []; let t = 1000;
  for (let i = 0; i < count; i++) { out.push({ mediaTimeMs: t, hash: hash(i) }); t += interval(i); }
  return out;
};

test("frame statistics: jitter, gaps, and duplicates of consecutive frames", () => {
  // A real camera: 33.3 ms +- 1 ms, every frame different.
  const real = frameTimingStats(stream(90, i => (i % 2 ? 34.3 : 32.3), i => i))!;
  assert.equal(real.frames, 90);
  assert.ok(Math.abs(real.stdIntervalMs - 1) < 0.02);
  assert.equal(real.duplicateFrameRatio, 0);
  assert.equal(inspectCamera({ ...laptop, frameTiming: real }).risk, 8);

  // 15 fps content pushed through a 30 fps software camera: perfect timestamps, every frame shown twice.
  const doubled = frameTimingStats(stream(90, () => 100 / 3, i => Math.floor(i / 2)))!;
  assert.equal(doubled.stdIntervalMs, 0);
  assert.ok(doubled.duplicateFrameRatio > 0.49 && doubled.duplicateFrameRatio < 0.51);
  assert.equal(inspectCamera({ ...laptop, frameTiming: doubled }).risk, 8 + 20 + 25);

  // A frozen feed with one stall.
  const frozen = frameTimingStats(stream(30, i => (i === 10 ? 700 : 40), () => 7))!;
  assert.equal(frozen.duplicateFrameRatio, 1);
  assert.equal(frozen.maxGapMs, 700);

  assert.equal(frameTimingStats(stream(1, () => 33, i => i)), null);
});

test("sidebar text summarizes controls, inputs, and timing", () => {
  assert.equal(describeControls(laptop), "Exposure, white balance · up to 1280x720 · 1 video input");
  assert.equal(describeControls({ ...laptop, capabilities: fixedNoControls, videoInputCount: 2 }), "None exposed · fixed 1280x720 · 2 video inputs");
  assert.equal(describeControls(normal), "Not reported");
  assert.equal(describeFrameTiming(laptopTiming), "1.3 ms jitter · 1% repeated · max gap 70 ms (72 frames)");
  assert.equal(describeFrameTiming(null), "Sampling / unavailable");
});
