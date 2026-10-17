import type { Signal } from "./types.ts";

/** PURE lip / voice timing heuristic: no DOM, audio, or model APIs.
 * It asks one narrow question: does mouth opening rise and fall together with loudness in THIS session?
 * It is an unvalidated correlation, not a lip-sync model. A dubbed or generated face that tracks the
 * audio envelope will pass; a real speaker in poor light, with a covered mouth, or beside a loud room can fail.
 */
export interface Sample { t: number; v: number } // t in milliseconds on a shared clock
export interface SyncResult { peakCorr: number; lagMs: number; voicedFraction: number }

export const SYNC = { hz: 50, maxLagMs: 300, minOverlapMs: 1000, minVoiced: 0.1, strongCorr: 0.5, weakCorr: 0.3, maxAbsLagMs: 200, voiceFloor: 0.001, voiceRatio: 3 } as const;

/** Loudness above this is treated as voice: three times the quiet floor (10th percentile), never below a fixed minimum.
 * A steady loud room therefore reads as "no voice" instead of as speech.
 */
export function voiceThreshold(levels: ArrayLike<number>): number {
  if (levels.length === 0) return SYNC.voiceFloor;
  const sorted = Array.from(levels).sort((a, b) => a - b);
  return Math.max(SYNC.voiceFloor, SYNC.voiceRatio * sorted[Math.floor(sorted.length * 0.1)]);
}

/** Puts a timestamped series on a regular grid starting at t0. Dense input is bin-averaged, sparse input is interpolated. */
export function resample(series: Sample[], t0: number, count: number, stepMs: number): Float64Array {
  const out = new Float64Array(count);
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const center = t0 + i * stepMs;
    let sum = 0, n = 0;
    while (cursor < series.length && series[cursor].t < center - stepMs / 2) cursor++;
    for (let j = cursor; j < series.length && series[j].t < center + stepMs / 2; j++) { sum += series[j].v; n++; }
    if (n > 0) { out[i] = sum / n; continue; }
    const after = series[cursor], before = series[cursor - 1];
    out[i] = !before ? after?.v ?? 0 : !after ? before.v
      : before.v + (after.v - before.v) * (center - before.t) / Math.max(1e-9, after.t - before.t);
  }
  return out;
}

function zNormalize(values: Float64Array): boolean {
  let mean = 0;
  for (const v of values) mean += v;
  mean /= values.length;
  let variance = 0;
  for (const v of values) variance += (v - mean) ** 2;
  const deviation = Math.sqrt(variance / values.length);
  if (!(deviation > 1e-9)) { values.fill(0); return false; }
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - mean) / deviation;
  return true;
}

/** Normalized cross-correlation over lags of -300..+300 ms. lagMs > 0 means the audio trails the mouth.
 * Returns null when the two series do not overlap for at least one second.
 */
export function crossCorrelate(mouth: Sample[], audio: Sample[]): SyncResult | null {
  if (mouth.length < 2 || audio.length < 2) return null;
  const step = 1000 / SYNC.hz;
  const t0 = Math.max(mouth[0].t, audio[0].t), t1 = Math.min(mouth[mouth.length - 1].t, audio[audio.length - 1].t);
  if (!(t1 - t0 >= SYNC.minOverlapMs)) return null;
  const count = Math.floor((t1 - t0) / step) + 1;
  const a = resample(mouth, t0, count, step), b = resample(audio, t0, count, step);
  const threshold = voiceThreshold(b);
  let voiced = 0;
  for (const level of b) if (level > threshold) voiced++;
  const voicedFraction = voiced / count;
  if (!zNormalize(a) || !zNormalize(b)) return { peakCorr: 0, lagMs: 0, voicedFraction };
  const maxLag = Math.round(SYNC.maxLagMs / step);
  const corr = new Float64Array(2 * maxLag + 1);
  let best = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0, n = 0;
    for (let i = Math.max(0, -lag); i < count - Math.max(0, lag); i++) { sum += a[i] * b[i + lag]; n++; }
    corr[lag + maxLag] = n ? sum / n : 0;
    if (corr[lag + maxLag] > corr[best]) best = lag + maxLag;
  }
  // Parabolic refinement between 20 ms grid points.
  let offset = 0;
  if (best > 0 && best < corr.length - 1) {
    const curve = corr[best - 1] - 2 * corr[best] + corr[best + 1];
    if (curve < 0) offset = Math.max(-0.5, Math.min(0.5, 0.5 * (corr[best - 1] - corr[best + 1]) / curve));
  }
  return { peakCorr: Math.max(-1, Math.min(1, corr[best])), lagMs: Math.round((best - maxLag + offset) * step), voicedFraction };
}

const round2 = (value: number) => Math.round(value * 100) / 100;
/** Thresholds are STARTING POINTS, not measured operating points. Tune them with recordings; see docs/QA_REPORT.md. */
export function syncSignal(result: SyncResult | null, reason = "Not enough overlapping mouth and audio samples to compare."): Signal {
  if (!result) return { id: "sync", risk: null, provenance: "unavailable", detail: `${reason} Missing evidence is not a pass.` };
  if (result.voicedFraction < SYNC.minVoiced) return { id: "sync", risk: null, provenance: "unavailable", detail: "No voice was detected during the digits prompt, so lip / voice timing could not be compared." };
  const risk = result.peakCorr >= SYNC.strongCorr && Math.abs(result.lagMs) <= SYNC.maxAbsLagMs ? 15
    : result.peakCorr >= SYNC.weakCorr && result.peakCorr < SYNC.strongCorr ? 40 : 80;
  return { id: "sync", risk, provenance: "heuristic",
    detail: `Mouth opening and loudness: peak correlation ${round2(result.peakCorr)} at ${result.lagMs} ms lag, voice in ${Math.round(result.voicedFraction * 100)}% of the window. On-device correlation heuristic with untuned thresholds; not a lip-sync model and not proof of a live speaker.` };
}

