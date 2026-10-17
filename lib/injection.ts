import type { CameraCapabilities, DeviceEvidence, FeedStats, FrameTiming, NumberRange, Signal } from "./types.ts";
import { fuseAttack } from "./attacks.ts";

// ------------------------------------------
// PURE MEASUREMENT HELPERS (used by lib/vision.ts; no DOM access here)
// ------------------------------------------

const range = (value: unknown): NumberRange | null => {
  const r = value as { min?: unknown; max?: unknown } | null;
  return r && typeof r === "object" && typeof r.min === "number" && typeof r.max === "number" &&
    Number.isFinite(r.min) && Number.isFinite(r.max) ? { min: r.min, max: r.max } : null;
};
const adjustable = (value: unknown) => { const r = range(value); return r !== null && r.max > r.min; };
/** A mode list counts as a control only if the user-facing mode can actually change. */
const switchable = (value: unknown) => Array.isArray(value) && (value.includes("manual") || value.length > 1);

/** Summarizes track.getCapabilities(). deviceId and groupId are deliberately not read. */
export function summarizeCapabilities(capabilities: object | null | undefined): CameraCapabilities | null {
  if (!capabilities || typeof capabilities !== "object") return null;
  const c = capabilities as Record<string, unknown>;
  return {
    hasExposureControl: switchable(c.exposureMode) || adjustable(c.exposureTime) || adjustable(c.exposureCompensation),
    hasFocusControl: switchable(c.focusMode) || adjustable(c.focusDistance),
    hasWhiteBalanceControl: switchable(c.whiteBalanceMode) || adjustable(c.colorTemperature),
    width: range(c.width),
    height: range(c.height),
    frameRate: range(c.frameRate),
  };
}

/** 32-bit FNV-1a over the grayscale values of an RGBA thumbnail. Equal hashes = identical thumbnails. */
export function grayHash(rgba: ArrayLike<number>): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i + 2 < rgba.length; i += 4) {
    hash ^= (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A 256-bit difference hash from a 17x16 RGBA thumbnail; only the hash is retained. */
export function dHash(rgba: ArrayLike<number>): Uint32Array {
  if (rgba.length < 17 * 16 * 4) throw new RangeError("dHash needs a 17x16 RGBA thumbnail");
  const bits = new Uint32Array(8);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const at = 4 * (y * 17 + x);
    const left = rgba[at] * 77 + rgba[at + 1] * 150 + rgba[at + 2] * 29;
    const right = rgba[at + 4] * 77 + rgba[at + 5] * 150 + rgba[at + 6] * 29;
    if (right > left) bits[(y * 16 + x) >>> 5] |= 1 << ((y * 16 + x) & 31);
  }
  return bits;
}

export interface HashedFrame { t: number; hash: Uint32Array }

/** Number of changed bits between two 256-bit hashes. */
export function hashDistance(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== 8 || b.length !== 8) throw new RangeError("Expected two 256-bit hashes");
  let distance = 0;
  for (let i = 0; i < 8; i++) {
    let n = a[i] ^ b[i];
    n -= (n >>> 1) & 0x55555555;
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    distance += (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return distance;
}

export const LOOP = { minPeriodMs: 2000, runFrames: 30, maxDistance: 8, matchedShare: 0.85, minMotion: 4 } as const;

/** Find an ordered, moving sequence repeated after >=2 s. Static images do not qualify. */
export function detectLoop(frames: HashedFrame[]): { loopFound: boolean; periodMs: number | null; runFrames: number } {
  const none = { loopFound: false, periodMs: null, runFrames: 0 };
  const n = Math.min(frames.length, 4000);
  const L = LOOP.runFrames;
  if (n < 2 * L) return none;
  for (let i = 0; i + L < n; i++) {
    let j = i + L;
    while (j + L <= n && frames[j].t - frames[i].t < LOOP.minPeriodMs) j++;
    for (; j + L <= n; j++) {
      if (hashDistance(frames[i].hash, frames[j].hash) > LOOP.maxDistance) continue;
      let matches = 0, motion = 0;
      for (let k = 0; k < L; k++) {
        if (hashDistance(frames[i + k].hash, frames[j + k].hash) <= LOOP.maxDistance) matches++;
        if (k > 0) motion += hashDistance(frames[i + k - 1].hash, frames[i + k].hash);
        if (matches + L - k - 1 < Math.ceil(L * LOOP.matchedShare)) break;
      }
      if (matches >= Math.ceil(L * LOOP.matchedShare) && motion / (L - 1) >= LOOP.minMotion) {
        return { loopFound: true, periodMs: Math.round(frames[j].t - frames[i].t), runFrames: L };
      }
    }
  }
  return none;
}

export const FROZEN = { minPairs: 30, minStaticShare: 0.5, identicalShare: 0.9 } as const;

/** Compare consecutive native-resolution 32x32 patches; pixels are not retained here. */
export function compareBackgroundPatches(previous: ArrayLike<number>, current: ArrayLike<number>): { eligible: boolean; identicalShare: number | null } {
  if (previous.length !== 32 * 32 * 4 || current.length !== previous.length) return { eligible: false, identicalShare: null };
  let staticPixels = 0, identical = 0;
  for (let i = 0; i < previous.length; i += 4) {
    let valid = true, same = true;
    for (let channel = 0; channel < 3; channel++) {
      const a = previous[i + channel], b = current[i + channel];
      if (a < 16 || a > 240 || b < 16 || b > 240 || Math.abs(a - b) > 6) valid = false;
      if (a !== b) same = false;
    }
    if (valid) { staticPixels++; if (same) identical++; }
  }
  return staticPixels >= 32 * 32 * FROZEN.minStaticShare
    ? { eligible: true, identicalShare: identical / staticPixels }
    : { eligible: false, identicalShare: null };
}

/** Fixed-size histogram permits a median without retaining any patch history. */
export function frozenMedian(histogram: ArrayLike<number>): number | null {
  const total = Array.from(histogram).reduce((sum, n) => sum + n, 0);
  if (total < FROZEN.minPairs) return null;
  let seen = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    seen += histogram[bin];
    if (seen > Math.floor((total - 1) / 2)) return bin / (histogram.length - 1);
  }
  return null;
}

export const PROBE = { minDeltaLevels: 6, baselineMaxStd: 3, minMean: 20, maxMean: 235 } as const;

export function nativeModeDecision(attempted: number, supported: number) {
  const ran = attempted >= 3;
  return { ran, modes: ran ? supported : null, fired: ran && supported === 1 };
}

export function sensorResponseDecision(control: string | null, requested: number | null, accepted: number | null,
  baseline: number[], after: number[]) {
  const unavailable = { ran: false, control, deltaLevels: null, fired: false };
  if (!control || requested === null || accepted === null || Math.abs(accepted - requested) > 0.001 || baseline.length < 4 || after.length < 6) return unavailable;
  const mean = (values: number[]) => values.reduce((sum, n) => sum + n, 0) / values.length;
  const beforeMean = mean(baseline);
  const std = Math.sqrt(mean(baseline.map(value => (value - beforeMean) ** 2)));
  if (std > PROBE.baselineMaxStd || beforeMean < PROBE.minMean || beforeMean > PROBE.maxMean) return unavailable;
  const deltaLevels = Math.round(Math.abs(mean(after) - beforeMean) * 10) / 10;
  return { ran: true, control, deltaLevels, fired: deltaLevels < PROBE.minDeltaLevels };
}

export interface FrameSample {
  /** requestVideoFrameCallback metadata.mediaTime, in milliseconds. */
  mediaTimeMs: number;
  /** grayHash of the frame's 16x12 thumbnail. */
  hash: number;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

/** Cadence and repetition statistics over consecutive frames. Null with fewer than two frames. */
export function frameTimingStats(samples: FrameSample[]): FrameTiming | null {
  if (samples.length < 2) return null;
  const deltas = samples.slice(1).map((s, i) => s.mediaTimeMs - samples[i].mediaTimeMs);
  const mean = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  const std = Math.sqrt(deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deltas.length);
  const duplicates = samples.slice(1).filter((s, i) => s.hash === samples[i].hash).length;
  return {
    frames: samples.length,
    meanIntervalMs: round(mean, 2),
    stdIntervalMs: round(std, 3),
    maxGapMs: round(Math.max(...deltas), 1),
    duplicateFrameRatio: round(duplicates / deltas.length, 3),
  };
}

// ------------------------------------------
// SCORING
// ------------------------------------------

export const CAMERA_FLAGS = {
  base: 8,
  noLabel: 20,
  virtualLabel: 35,
  noControlsFixedResolution: 25,
  perfectCadence: 20,
  perfectCadenceStdMs: 0.2,
  perfectCadenceMinFrames: 60,
  duplicateFrames: 25,
  duplicateFrameRatio: 0.2,
  duplicateMinFrames: 20,
  frameGap: 10,
  frameGapMs: 500,
  feedLoop: 30,
  noSensorResponse: 30,
  frozenBackground: 25,
  singleNativeMode: 10,
  cap: 95,
} as const;

const VIRTUAL_LABEL = /\b(obs|virtual|manycam|xsplit|snap camera|droidcam|ndi|unity video capture|e2esoft|vcam|splitcam|camtwist|iriun|epoccam|deepfacelive)\b/i;

/** Metadata and frame timing are spoofable. These flags are troubleshooting heuristics, NOT attestation. PURE. */
export function inspectCamera(device: DeviceEvidence | null): Signal {
  if (!device) return { id: "injection", risk: null, provenance: "unavailable", detail: "Camera permission or metadata was unavailable." };
  const F = CAMERA_FLAGS;
  let risk: number = F.base;
  const flags: string[] = [];
  if (!device.label.trim()) { risk += F.noLabel; flags.push("camera label unavailable"); }
  if (VIRTUAL_LABEL.test(device.label)) {
    risk += F.virtualLabel; flags.push("virtual-camera-like label (can be legitimate)");
  }
  if (!device.width || !device.height) { risk += 15; flags.push("resolution not reported"); }
  else if (device.width < 320 || device.height < 240) { risk += 20; flags.push("low capture resolution"); }
  if (device.declaredFps !== null && (device.declaredFps < 12 || device.declaredFps > 90)) {
    risk += 18; flags.push("unusual declared frame rate");
  }
  if (device.observedFps !== null && device.observedFps < 10) { risk += 15; flags.push("low observed frame cadence"); }
  if (device.observedFps !== null && device.declaredFps && Math.abs(device.observedFps - device.declaredFps) / device.declaredFps > 0.6) {
    risk += 10; flags.push("observed / declared cadence differs");
  }

  const caps = device.capabilities;
  if (caps && !caps.hasExposureControl && !caps.hasFocusControl && !caps.hasWhiteBalanceControl &&
    caps.width && caps.height && caps.width.min === caps.width.max && caps.height.min === caps.height.max) {
    risk += F.noControlsFixedResolution;
    flags.push(`no exposure / focus / white-balance control and one fixed ${caps.width.max}x${caps.height.max} mode, like software cameras (can be legitimate: basic webcams expose none)`);
  }

  const timing = device.frameTiming;
  if (timing) {
    if (timing.frames >= F.perfectCadenceMinFrames && timing.stdIntervalMs < F.perfectCadenceStdMs) {
      risk += F.perfectCadence;
      flags.push(`machine-perfect frame cadence (${timing.stdIntervalMs} ms spread over ${timing.frames} frames; can be legitimate on some capture hardware)`);
    }
    if (timing.frames >= F.duplicateMinFrames && timing.duplicateFrameRatio > F.duplicateFrameRatio) {
      risk += F.duplicateFrames;
      flags.push(`${Math.round(timing.duplicateFrameRatio * 100)}% repeated identical frames, as from a frozen or looping feed (can be legitimate: covered lens or a very dark, still scene)`);
    }
    if (timing.maxGapMs > F.frameGapMs) {
      risk += F.frameGap;
      flags.push(`${Math.round(timing.maxGapMs)} ms gap between frames (can be legitimate under heavy CPU load)`);
    }
  }

  if (device.probes?.nativeModes.fired) {
    risk += F.singleNativeMode;
    flags.push("only one tested native resolution was accepted (can be legitimate: a basic or restricted webcam)");
  }
  if (device.probes?.sensorResponse.fired) {
    risk += F.noSensorResponse;
    flags.push(`camera accepted ${device.probes.sensorResponse.control} but the image changed only ${device.probes.sensorResponse.deltaLevels} luma levels (can be legitimate in a clipped or processed scene)`);
  }
  if (device.feed?.loopFound) {
    risk += F.feedLoop;
    flags.push(`a moving frame sequence repeated after ${device.feed.loopPeriodMs} ms (can be legitimate when camera software replays a feed)`);
  }
  if (device.feed?.frozenIdenticalShare !== null && device.feed?.frozenIdenticalShare !== undefined &&
    device.feed.frozenPairs >= FROZEN.minPairs && device.feed.frozenIdenticalShare >= FROZEN.identicalShare) {
    risk += F.frozenBackground;
    flags.push(`${Math.round(device.feed.frozenIdenticalShare * 100)}% bit-identical static background pixels (can be legitimate with NVIDIA Broadcast, Windows Studio Effects, or background blur)`);
  }

  return { id: "injection", risk: Math.min(F.cap, risk), provenance: "heuristic",
    detail: `${flags.length ? flags.join("; ") : "No configured metadata or frame-timing anomaly found"}. Browser metadata cannot authenticate the camera; lighting, load, and legitimate software can trigger flags.` };
}

/** Combine independently measured camera indicators. No device ID or pixels enter the check. */
export function virtualCameraCheck(device: DeviceEvidence | null, reflection: Signal) {
  const timing = device?.frameTiming;
  const modes = device?.probes?.nativeModes;
  const sensor = device?.probes?.sensorResponse;
  const feed = device?.feed;
  const reflected = reflection.risk !== null && Number.isFinite(reflection.risk) &&
    reflection.provenance !== "unavailable" && reflection.provenance !== "simulated";
  return fuseAttack("virtual_camera", [
    { id: "feed_loop", kind: "strong", ran: Boolean(feed && feed.frames >= 60), fired: Boolean(feed?.loopFound),
      detail: feed?.loopFound ? `Moving sequence repeated after ${feed.loopPeriodMs} ms; a camera application may replay a feed.` : "No moving repeated sequence measured." },
    { id: "no_sensor_response", kind: "strong", ran: Boolean(sensor?.ran), fired: Boolean(sensor?.fired),
      detail: sensor?.ran ? `Camera accepted ${sensor.control}, but the image changed ${sensor.deltaLevels} luma levels; clipping or processing can also suppress the response.` : "No usable sensor-control response probe." },
    { id: "frozen_background", kind: "strong", ran: feed?.frozenIdenticalShare !== null && feed?.frozenIdenticalShare !== undefined && (feed?.frozenPairs ?? 0) >= FROZEN.minPairs,
      fired: feed?.frozenIdenticalShare !== null && feed?.frozenIdenticalShare !== undefined &&
        (feed?.frozenPairs ?? 0) >= FROZEN.minPairs && feed.frozenIdenticalShare >= FROZEN.identicalShare,
      detail: feed?.frozenIdenticalShare === null || feed?.frozenIdenticalShare === undefined ? "No stable background patch measured."
        : `${Math.round(feed.frozenIdenticalShare * 100)}% bit-identical static background; camera effects can also cause this.` },
    { id: "single_native_mode", kind: "supporting", ran: Boolean(modes?.ran), fired: Boolean(modes?.fired),
      detail: modes?.ran ? `${modes.modes} of 3 tested native modes accepted; a restricted webcam can also expose one.` : "Native-mode probe unavailable." },
    { id: "virtual_label", kind: "supporting", ran: Boolean(device?.label), fired: Boolean(device?.label && VIRTUAL_LABEL.test(device.label)),
      detail: "Camera label resembles a software camera; labels are editable and legitimate tools use virtual cameras." },
    { id: "perfect_cadence", kind: "supporting", ran: Boolean(timing && timing.frames >= CAMERA_FLAGS.perfectCadenceMinFrames),
      fired: Boolean(timing && timing.frames >= CAMERA_FLAGS.perfectCadenceMinFrames && timing.stdIntervalMs < CAMERA_FLAGS.perfectCadenceStdMs),
      detail: "Unusually even frame cadence; some capture hardware also has even timing." },
    { id: "repeated_frames", kind: "supporting", ran: Boolean(timing && timing.frames >= CAMERA_FLAGS.duplicateMinFrames),
      fired: Boolean(timing && timing.frames >= CAMERA_FLAGS.duplicateMinFrames && timing.duplicateFrameRatio > CAMERA_FLAGS.duplicateFrameRatio),
      detail: "Repeated identical thumbnails; a covered lens or still scene can also cause this." },
    { id: "light_response", kind: "supporting", ran: reflected, fired: reflected && reflection.risk! >= 80,
      detail: "Face did not follow the screen-light sequence; ambient light can also hide the response." }
  ]);
}

// ------------------------------------------
// SIDEBAR TEXT
// ------------------------------------------

/** e.g. "Exposure, focus · up to 1920x1080 · 2 video inputs". */
export function describeControls(device: DeviceEvidence): string {
  const c = device.capabilities;
  const parts: string[] = [];
  if (c) {
    const names = [c.hasExposureControl && "exposure", c.hasFocusControl && "focus", c.hasWhiteBalanceControl && "white balance"].filter(Boolean) as string[];
    parts.push(names.length ? names.join(", ").replace(/^./, ch => ch.toUpperCase()) : "None exposed");
    if (c.width && c.height) {
      parts.push(c.width.min === c.width.max && c.height.min === c.height.max
        ? `fixed ${c.width.max}x${c.height.max}` : `up to ${c.width.max}x${c.height.max}`);
    }
  } else {
    parts.push("Not reported");
  }
  if (typeof device.videoInputCount === "number") {
    parts.push(`${device.videoInputCount} video input${device.videoInputCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/** e.g. "1.2 ms jitter · 0% repeated · max gap 68 ms (72 frames)". */
export function describeFrameTiming(timing: FrameTiming | null | undefined): string {
  if (!timing) return "Sampling / unavailable";
  return `${timing.stdIntervalMs} ms jitter · ${Math.round(timing.duplicateFrameRatio * 100)}% repeated · max gap ${Math.round(timing.maxGapMs)} ms (${timing.frames} frames)`;
}

export function describeHardwareProbe(device: DeviceEvidence): string {
  const probes = device.probes;
  if (!probes) return "Not run / unavailable";
  const modes = probes.nativeModes.ran ? `${probes.nativeModes.modes} of 3 native modes` : "native modes unavailable";
  const response = probes.sensorResponse.ran
    ? `${probes.sensorResponse.control}: ${probes.sensorResponse.deltaLevels} luma levels`
    : "sensor response unavailable";
  return `${modes} · ${response}`;
}

export function describeFeedForensics(feed: FeedStats | null | undefined): string {
  if (!feed) return "Sampling / unavailable";
  const loop = feed.loopFound ? `loop ${feed.loopPeriodMs} ms / ${feed.loopRunFrames} frames` : "no moving loop found";
  const frozen = feed.frozenIdenticalShare === null ? "background unavailable"
    : `${Math.round(feed.frozenIdenticalShare * 100)}% identical background (${feed.frozenPairs} pairs)`;
  return `${loop} · ${frozen} · ${feed.frames} frames`;
}
