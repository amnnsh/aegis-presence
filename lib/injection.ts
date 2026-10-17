import type { CameraCapabilities, DeviceEvidence, FrameTiming, NumberRange, Signal } from "./types.ts";

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
  cap: 95,
} as const;

const VIRTUAL_LABEL = /\b(obs|virtual|manycam|xsplit|snap camera|droidcam|ndi)\b/i;

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

  return { id: "injection", risk: Math.min(F.cap, risk), provenance: "heuristic",
    detail: `${flags.length ? flags.join("; ") : "No configured metadata or frame-timing anomaly found"}. Browser metadata cannot authenticate the camera; lighting, load, and legitimate software can trigger flags.` };
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
