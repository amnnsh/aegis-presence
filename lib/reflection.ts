import { shuffle } from "./challenges.ts";
import type { Point, Signal } from "./types.ts";
export type RGB = [number, number, number];
export interface Stimulus { name: string; hex: string; rgb: RGB }
export interface ColorSample { step: number; expected: RGB; observed: RGB }

/** Saturated, high-luminance stimuli so the screen acts as a real light source on the face.
 * Each keeps at least 4.5:1 contrast against the black text panels drawn on top (see contrastRatio and its test).
 */
export const COLORS: Stimulus[] = [
  { name: "Red", hex: "#ff3b30", rgb: [255, 59, 48] },
  { name: "Green", hex: "#34ff6a", rgb: [52, 255, 106] },
  { name: "Blue", hex: "#3a6bff", rgb: [58, 107, 255] },
];
export const PLATEAUS = 6;
/** Slow plateaus (0.67 changes per second), well under the 3-per-second flash limit. Explicit consent required. */
export const COLOR_HOLD_MS = 1500;
/** CSS crossfade between plateaus. Removed under prefers-reduced-motion. */
export const CROSSFADE_MS = 250;
/** Time after each transition before sampling: the crossfade plus the camera's own adaptation. */
export const COLOR_SETTLE_MS = 500;
/** Correlation cut-offs. UNTUNED starting points: see docs/QA_REPORT.md before quoting them. */
export const REFLECTION = { strong: 0.4, weak: 0.15, minChromaRms: 0.003 } as const;

/** Six plateaus: each color twice, shuffled, never the same color twice in a row. */
export function lightSequence(): Stimulus[] {
  const first = shuffle(COLORS), second = shuffle(COLORS);
  if (first[2].name === second[0].name) [second[0], second[1]] = [second[1], second[0]];
  return [...first, ...second];
}

/** WCAG 2 contrast ratio between two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function chroma(rgb: RGB): RGB {
  const sum = rgb[0] + rgb[1] + rgb[2];
  return sum > 0 ? [rgb[0] / sum, rgb[1] / sum, rgb[2] / sum] : [0, 0, 0];
}

const SAMPLE_W = 160, SAMPLE_H = 120, PATCH = 12;

/** Forehead and both cheeks, as normalized points. Null if the face is too close to the frame edge. */
export function skinPatches(points: Point[]): Point[] | null {
  if (points.length < 468) return null;
  const forehead = { x: (points[109].x + points[338].x) / 2, y: (points[10].y + points[9].y) / 2 };
  const patches = [forehead, points[50], points[280]];
  return patches.every(p => p.x >= 0.08 && p.x <= 0.92 && p.y >= 0.08 && p.y <= 0.92) ? patches : null;
}

/** Mean RGB of 12x12 patches (at 160x120) on the forehead and both cheeks. NO frames or pixels are retained. */
export function readCheekColor(video: HTMLVideoElement, points: Point[], canvas: HTMLCanvasElement): RGB | null {
  const patches = skinPatches(points);
  if (!patches || video.readyState < 2 || !video.videoWidth) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  canvas.width = SAMPLE_W; canvas.height = SAMPLE_H;
  ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
  const sums: RGB = [0, 0, 0]; let count = 0;
  for (const p of patches) {
    const x = Math.max(0, Math.min(SAMPLE_W - PATCH, Math.round(p.x * SAMPLE_W) - PATCH / 2));
    const y = Math.max(0, Math.min(SAMPLE_H - PATCH, Math.round(p.y * SAMPLE_H) - PATCH / 2));
    const data = ctx.getImageData(x, y, PATCH, PATCH).data;
    for (let i = 0; i < data.length; i += 4) {
      // Ignore nearly black or saturated pixels; this is only a rough quality check.
      if (data[i] + data[i + 1] + data[i + 2] < 45 || Math.max(data[i], data[i + 1], data[i + 2]) > 250) continue;
      sums[0] += data[i]; sums[1] += data[i + 1]; sums[2] += data[i + 2]; count++;
    }
  }
  ctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
  return count >= 60 ? sums.map(s => s / count) as RGB : null;
}

// --- Camera auto-correction. Auto exposure and white balance cancel out exactly the tint this check looks for. ---

export type CameraLockKey = "whiteBalanceMode" | "exposureMode";
/** The few MediaStreamTrack members used here; the Image Capture keys are missing from TypeScript's DOM types. */
export interface LockableTrack {
  readyState: MediaStreamTrackState;
  getCapabilities?: () => object;
  getSettings?: () => object;
  applyConstraints(constraints: MediaTrackConstraints): Promise<void>;
}
const LOCK_KEYS: CameraLockKey[] = ["whiteBalanceMode", "exposureMode"];
const constraint = (keys: CameraLockKey[], mode: "manual" | "continuous") =>
  ({ advanced: [Object.fromEntries(keys.map(key => [key, mode]))] }) as MediaTrackConstraints;

/** Switches whichever of white balance / exposure the camera can hold to "manual".
 * Returns the keys the camera actually reports as manual afterwards; [] means nothing was locked.
 */
export async function lockCamera(track: LockableTrack | null): Promise<CameraLockKey[]> {
  if (!track || track.readyState !== "live" || typeof track.getCapabilities !== "function") return [];
  let capabilities: Record<string, unknown>;
  try { capabilities = track.getCapabilities() as Record<string, unknown>; } catch { return []; }
  const keys = LOCK_KEYS.filter(key => {
    const modes = capabilities[key];
    return Array.isArray(modes) && modes.includes("manual");
  });
  if (keys.length === 0) return [];
  try { await track.applyConstraints(constraint(keys, "manual")); } catch { return []; }
  // Advanced constraints are best effort: trust only what the track reports back.
  const settings = (track.getSettings?.() ?? {}) as Record<string, unknown>;
  return keys.filter(key => settings[key] === undefined || settings[key] === "manual");
}

/** Puts the locked keys back to "continuous". Never throws. */
export async function unlockCamera(track: LockableTrack | null, keys: CameraLockKey[]): Promise<void> {
  if (!track || keys.length === 0 || track.readyState !== "live") return;
  try { await track.applyConstraints(constraint(keys, "continuous")); } catch { /* the track is closing anyway */ }
}

export function lockDescription(keys: CameraLockKey[]): string {
  const exposure = keys.includes("exposureMode"), balance = keys.includes("whiteBalanceMode");
  return exposure && balance ? "Exposure and white balance locked."
    : exposure ? "Exposure locked; white balance automatic."
      : balance ? "White balance locked; auto exposure, weaker test."
        : "Auto exposure and white balance, weaker test.";
}

export function reflectionSignal(samples: ColorSample[], locked: CameraLockKey[] = []): Signal {
  const camera = lockDescription(locked);
  const missing = (detail: string): Signal => ({ id: "reflection", risk: null, provenance: "unavailable", detail: `${detail} ${camera}` });
  const groups = [...new Set(samples.map(s => s.step))].map(step => samples.filter(s => s.step === step));
  if (groups.length < PLATEAUS || groups.some(g => g.length < 3)) return missing("Skipped, insufficient single-face samples, or unsuitable light. No liveness claim is made.");
  const expected = groups.map(g => chroma(g[0].expected));
  const observed = groups.map(g => chroma([0, 1, 2].map(c => g.reduce((sum, s) => sum + s.observed[c], 0) / g.length) as RGB));
  const mean = (rows: RGB[], c: number) => rows.reduce((sum, row) => sum + row[c], 0) / rows.length;
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < groups.length; i++) for (let c = 0; c < 3; c++) {
    x.push(expected[i][c] - mean(expected, c)); y.push(observed[i][c] - mean(observed, c));
  }
  const xx = x.reduce((s, a) => s + a * a, 0), yy = y.reduce((s, a) => s + a * a, 0);
  const rms = Math.sqrt(yy / y.length);
  if (rms < REFLECTION.minChromaRms || xx < 1e-8) return missing(`Color variation was too weak to measure (chroma RMS ${rms.toFixed(4)}). Raise screen brightness and dim other lights.`);
  const correlation = x.reduce((sum, a, i) => sum + a * y[i], 0) / Math.sqrt(xx * yy);
  const risk = correlation > REFLECTION.strong ? 25 : correlation > REFLECTION.weak ? 50 : 80;
  return { id: "reflection", risk, provenance: "heuristic",
    detail: `Face chromaticity / screen-color correlation ${correlation.toFixed(2)} (chroma RMS ${rms.toFixed(4)}) across six full-screen plateaus. ${camera} Experimental, uncalibrated thresholds; lighting, motion, skin reflectance and the camera affect it. Not proof of physical presence.` };
}
