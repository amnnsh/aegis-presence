import { shuffle } from "./challenges.ts";
import type { Point, Signal } from "./types.ts";
export type RGB = [number, number, number];
export interface Stimulus { name: string; hex: string; rgb: RGB }
export interface ColorSample { step: number; expected: RGB; observed: RGB }
export const COLORS: Stimulus[] = [
  { name: "Coral", hex: "#ffc1ad", rgb: [255, 193, 173] },
  { name: "Mint", hex: "#a8ebd4", rgb: [168, 235, 212] },
  { name: "Periwinkle", hex: "#c0bfff", rgb: [192, 191, 255] },
];
export const COLOR_HOLD_MS = 1800; // Slow plateaus, not a rapid strobe. Explicit consent required.
export function lightSequence(): Stimulus[] {
  const first = shuffle(COLORS), second = shuffle(COLORS);
  if (first[2].name === second[0].name) [second[0], second[1]] = [second[1], second[0]];
  return [...first, ...second];
}
function chroma(rgb: RGB): RGB {
  const sum = rgb[0] + rgb[1] + rgb[2];
  return sum > 0 ? [rgb[0] / sum, rgb[1] / sum, rgb[2] / sum] : [0, 0, 0];
}
/** Means from two landmark-anchored cheek patches; NO frames or pixels are retained. */
export function readCheekColor(video: HTMLVideoElement, points: Point[], canvas: HTMLCanvasElement): RGB | null {
  if (points.length < 468 || video.readyState < 2 || !video.videoWidth) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  canvas.width = 160; canvas.height = 120;
  ctx.drawImage(video, 0, 0, 160, 120);
  const sums: RGB = [0, 0, 0]; let count = 0;
  for (const index of [50, 280]) {
    const p = points[index];
    if (p.x < 0.08 || p.x > 0.92 || p.y < 0.08 || p.y > 0.92) { ctx.clearRect(0, 0, 160, 120); return null; }
    const x = Math.max(0, Math.min(153, Math.round(p.x * 160) - 3));
    const y = Math.max(0, Math.min(113, Math.round(p.y * 120) - 3));
    const data = ctx.getImageData(x, y, 7, 7).data;
    for (let i = 0; i < data.length; i += 4) {
      // Ignore nearly black or saturated pixels; this is only a rough quality check.
      if (data[i] + data[i + 1] + data[i + 2] < 45 || Math.max(data[i], data[i + 1], data[i + 2]) > 250) continue;
      sums[0] += data[i]; sums[1] += data[i + 1]; sums[2] += data[i + 2]; count++;
    }
  }
  ctx.clearRect(0, 0, 160, 120);
  return count >= 30 ? sums.map(s => s / count) as RGB : null;
}
export function reflectionSignal(samples: ColorSample[]): Signal {
  const missing = (detail: string): Signal => ({ id: "reflection", risk: null, provenance: "unavailable", detail });
  const groups = [...new Set(samples.map(s => s.step))].map(step => samples.filter(s => s.step === step));
  if (groups.length < 6 || groups.some(g => g.length < 3)) return missing("Skipped, insufficient single-face samples, or unsuitable light. No liveness claim is made.");
  const expected = groups.map(g => chroma(g[0].expected));
  const observed = groups.map(g => chroma([0, 1, 2].map(c => g.reduce((sum, s) => sum + s.observed[c], 0) / g.length) as RGB));
  const mean = (rows: RGB[], c: number) => rows.reduce((sum, row) => sum + row[c], 0) / rows.length;
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < groups.length; i++) for (let c = 0; c < 3; c++) {
    x.push(expected[i][c] - mean(expected, c)); y.push(observed[i][c] - mean(observed, c));
  }
  const xx = x.reduce((s, a) => s + a * a, 0), yy = y.reduce((s, a) => s + a * a, 0);
  if (Math.sqrt(yy / y.length) < 0.003 || xx < 1e-8) return missing("Color variation was too weak to measure. Ambient light and camera auto-exposure can hide the response.");
  const correlation = x.reduce((sum, a, i) => sum + a * y[i], 0) / Math.sqrt(xx * yy);
  const risk = correlation > 0.4 ? 25 : correlation > 0.15 ? 50 : 80;
  return { id: "reflection", risk, provenance: "heuristic",
    detail: `Cheek chromaticity / screen-color correlation ${correlation.toFixed(2)} across six slow plateaus. Experimental and uncalibrated; lighting, motion, skin reflectance, and white balance affect it. Not proof of physical presence.` };
}
