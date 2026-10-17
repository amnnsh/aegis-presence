export interface RGBSample {
  t: number; // Milliseconds, monotonic clock
  r: number;
  g: number;
  b: number;
  motion?: boolean;
}

export interface PulseQuality {
  fps: number;
  usableSeconds: number;
  motionFraction: number;
}

export interface PulseResult {
  bpm: number | null;
  snrDb: number | null;
  quality: PulseQuality;
  waveform: number[];
  risk: number | null;
  detail: string;
}

const SAMPLE_RATE = 30;
const MIN_SECONDS = 7.5;
const PREVIEW_MIN_SECONDS = 3.5;
const LOW_HZ = 0.7;
const HIGH_HZ = 3.0;
const PHYSIOLOGICAL_LOW_HZ = 0.75;  // 45 BPM
const PHYSIOLOGICAL_HIGH_HZ = 2.5;  // 150 BPM
const WINDOW_SECONDS = 1.6;

/**
 * Calibrated anti-spoofing thresholds.
 *
 * Real facial skin in 8-bit webcam video exhibits subtle cardiac pulsatile
 * fluctuations (~0.1–1.5 RGB units around a 90–180 DC level, i.e. ~0.08%–1.5%
 * green-channel coefficient of variation and ~0.001–0.015 POS amplitude).
 *
 * A still image (printed photo or static screen) lacks chromatic blood-flow
 * oscillation: stationary photos only have uncorrelated camera sensor noise,
 * while hand-held photos modulate R, G, and B proportionally (which cancels
 * in the Plane-Orthogonal-to-Skin projection).
 */
const SNR_CONFIDENT_DB = 5;
const SNR_MARGINAL_DB = 1;
const GREEN_VARIANCE_FLOOR = 0.00048;
const AMPLITUDE_FLOOR = 0.00075;
const SPECTRAL_PURITY_MIN = 0.35;
const SPECTRAL_PURITY_CONFIDENT = 0.50;
const IBI_REGULARITY_MIN = 0.52;
const IBI_REGULARITY_CONFIDENT = 0.65;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) /
    Math.max(1, values.length);
}

function std(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finiteSample(s: RGBSample): boolean {
  return Number.isFinite(s.t) &&
    [s.r, s.g, s.b].every(v =>
      Number.isFinite(v) && v > 0
    );
}

/** Resample irregular RGB observations onto a uniform time grid. */
export function resample(
  samples: RGBSample[],
  fps = SAMPLE_RATE
): RGBSample[] {
  if (!Number.isFinite(fps) || fps <= 0) return [];

  const valid = samples.filter(finiteSample)
    .sort((a, b) => a.t - b.t);

  if (valid.length < 2) return [];

  const output: RGBSample[] = [];
  const step = 1000 / fps;
  let j = 0;

  for (
    let t = valid[0].t;
    t <= valid[valid.length - 1].t;
    t += step
  ) {
    while (
      j + 1 < valid.length - 1 &&
      valid[j + 1].t < t
    ) j++;

    const a = valid[j];
    const b = valid[j + 1];
    const fraction = Math.max(
      0,
      Math.min(1, (t - a.t) / Math.max(0.001, b.t - a.t))
    );

    output.push({
      t,
      r: a.r + (b.r - a.r) * fraction,
      g: a.g + (b.g - a.g) * fraction,
      b: a.b + (b.b - a.b) * fraction,
      motion: Boolean(a.motion || b.motion)
    });
  }

  return output;
}

/**
 * Zero-phase cardiac bandpass filter (~0.8–2.8 Hz at 30 FPS).
 * 1. Subtracts a 1.1s moving average to remove slow baseline drift (<0.8 Hz)
 *    from breathing and camera auto-exposure.
 * 2. Applies two symmetric 5-tap triangular smoothing passes to attenuate
 *    high-frequency camera sensor noise (>3 Hz) and 10 Hz landmark jitter.
 */
export function bandpassCardiac(
  signal: number[],
  fps = SAMPLE_RATE
): number[] {
  const n = signal.length;
  if (n < 5) return signal.slice();

  const hpWindow = Math.max(5, Math.round(fps * 1.1) | 1);
  const halfHp = Math.floor(hpWindow / 2);
  const detrended = new Array<number>(n);
  let sum = 0;
  let count = 0;

  for (let i = 0; i < Math.min(n, halfHp); i++) {
    sum += signal[i];
    count++;
  }

  for (let i = 0; i < n; i++) {
    if (i + halfHp < n) {
      sum += signal[i + halfHp];
      count++;
    }
    if (i - halfHp - 1 >= 0) {
      sum -= signal[i - halfHp - 1];
      count--;
    }
    detrended[i] = signal[i] - sum / Math.max(1, count);
  }

  const smooth5 = (arr: number[]): number[] => {
    const out = new Array<number>(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const m2 = arr[Math.max(0, i - 2)];
      const m1 = arr[Math.max(0, i - 1)];
      const c = arr[i];
      const p1 = arr[Math.min(arr.length - 1, i + 1)];
      const p2 = arr[Math.min(arr.length - 1, i + 2)];
      out[i] = (m2 + 2 * m1 + 3 * c + 2 * p1 + p2) / 9;
    }
    return out;
  };

  return smooth5(smooth5(detrended));
}

/** POS: Plane-Orthogonal-to-Skin pulse extraction with outlier-window suppression and cardiac bandpass filtering. */
export function extractPOS(samples: RGBSample[]): number[] {
  const length = samples.length;
  const output = new Array<number>(length).fill(0);
  const counts = new Array<number>(length).fill(0);

  const windowSize = Math.round(
    WINDOW_SECONDS * SAMPLE_RATE
  );
  const stride = Math.max(1, Math.floor(windowSize / 2));

  if (length < windowSize) return output;

  const windows: { start: number; centered: number[]; sigma: number }[] = [];

  for (
    let start = 0;
    start + windowSize <= length;
    start += stride
  ) {
    const window = samples.slice(start, start + windowSize);

    const channels = (["r", "g", "b"] as const).map(key => {
      const values = window.map(s => s[key]);
      const average = mean(values);
      return values.map(v => v / Math.max(1e-9, average));
    });

    const [r, g, b] = channels;
    const s1 = g.map((v, i) => v - b[i]);
    const s2 = r.map((v, i) => -2 * v + g[i] + b[i]);

    const alpha = std(s1) / Math.max(1e-9, std(s2));
    const pulse = s1.map((v, i) => v + alpha * s2[i]);
    const center = mean(pulse);
    const centered = pulse.map(v => v - center);

    windows.push({
      start,
      centered,
      sigma: std(centered)
    });
  }

  // Downweight transient motion/blink outlier windows so a brief twitch
  // does not dominate the overlap-added waveform.
  const medSigma = median(windows.map(w => w.sigma));
  const capSigma = medSigma * 1.35;

  for (const w of windows) {
    const scale =
      w.sigma > capSigma && w.sigma > 1e-9
        ? (medSigma / w.sigma) ** 2
        : 1;

    for (let i = 0; i < windowSize; i++) {
      output[w.start + i] += w.centered[i] * scale;
      counts[w.start + i] += 1;
    }
  }

  const raw = output.map((v, i) =>
    counts[i] ? v / counts[i] : 0
  );

  const filtered = bandpassCardiac(raw, SAMPLE_RATE);

  // Soft-clip isolated sample spikes using MAD scale estimation
  const madSigma = median(filtered.map(v => Math.abs(v))) * 1.4826;
  if (madSigma > 1e-9) {
    const limit = madSigma * 1.8;
    for (let i = 0; i < filtered.length; i++) {
      if (filtered[i] > limit) filtered[i] = limit;
      else if (filtered[i] < -limit) filtered[i] = -limit;
    }
  }

  return filtered;
}

/**
 * Hann-windowed frequency analysis.
 * Computes the equivalent positive-frequency DFT bins.
 */
export function estimateFrequency(
  signal: number[],
  fps = SAMPLE_RATE,
  minSeconds = MIN_SECONDS
): { bpm: number; snrDb: number; spectralPurity: number } | null {
  const n = signal.length;
  if (n < fps * minSeconds) return null;

  const center = mean(signal);
  const windowed = signal.map((v, i) =>
    (v - center) *
    (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)))
  );

  const fftSize = 2 ** Math.ceil(Math.log2(n * 4));
  const bins: { hz: number; power: number }[] = [];

  for (
    let k = Math.ceil(LOW_HZ * fftSize / fps);
    k <= Math.floor(HIGH_HZ * fftSize / fps);
    k++
  ) {
    let real = 0;
    let imag = 0;

    for (let i = 0; i < n; i++) {
      const angle = -2 * Math.PI * k * i / fftSize;
      real += windowed[i] * Math.cos(angle);
      imag += windowed[i] * Math.sin(angle);
    }

    bins.push({
      hz: k * fps / fftSize,
      power: real * real + imag * imag
    });
  }

  if (!bins.length) return null;

  // Search for the primary cardiac fundamental within [0.75, 2.5 Hz] (45-150 BPM)
  const physBins = bins.filter(
    b => b.hz >= PHYSIOLOGICAL_LOW_HZ && b.hz <= PHYSIOLOGICAL_HIGH_HZ
  );
  const searchBins = physBins.length ? physBins : bins;

  const peak = searchBins.reduce((a, b) =>
    b.power > a.power ? b : a
  );

  const totalPower = bins.reduce(
    (sum, b) => sum + b.power, 0
  );

  if (totalPower < 1e-12) return null;

  // Fundamental lobe (±0.12 Hz accommodates normal breathing HRV over 12s)
  const fundamentalPower = bins
    .filter(b => Math.abs(b.hz - peak.hz) <= 0.12)
    .reduce((sum, b) => sum + b.power, 0);

  // Second harmonic lobe (±0.08 Hz), capped at 40% of fundamental power so
  // an unrelated high-frequency tone cannot masquerade as a harmonic
  const harmonicPower = bins
    .filter(
      b =>
        Math.abs(b.hz - 2 * peak.hz) <= 0.08 &&
        Math.abs(b.hz - peak.hz) > 0.12
    )
    .reduce((sum, b) => sum + b.power, 0);

  const signalPower =
    fundamentalPower + Math.min(harmonicPower, 0.4 * fundamentalPower);

  const noisePower = Math.max(
    1e-12,
    totalPower - signalPower
  );

  const spectralPurity = signalPower / totalPower;

  return {
    bpm: peak.hz * 60,
    snrDb: 10 * Math.log10(
      Math.max(1e-12, signalPower) / noisePower
    ),
    spectralPurity
  };
}

/**
 * Check that the green channel has enough coherent temporal variance.
 * Averaging 3 consecutive frames (~100 ms) retains >96% of a physiological
 * cardiac wave while suppressing uncorrelated frame-to-frame camera sensor
 * noise on a static image by √3.
 */
function greenChannelVariance(samples: RGBSample[]): number {
  if (samples.length < 3) return 0;
  const greens = samples.map(s => s.g);
  const avg = mean(greens);
  if (avg < 1e-9) return 0;
  const smoothed = greens.map((_, i) =>
    (
      greens[Math.max(0, i - 1)] +
      greens[i] +
      greens[Math.min(greens.length - 1, i + 1)]
    ) / 3
  );
  return std(smoothed) / avg;
}

/**
 * Measure inter-beat interval (IBI) regularity on the bandpass-filtered
 * POS pulse waveform.
 *
 * Uses negative-trough hysteresis (-0.20 σ) and a physiological refractory
 * period (0.30 s, max 200 BPM) so camera noise ripples or dicrotic notches
 * do not trigger false zero-crossings, and verifies both deviation from the
 * median IBI (±28%) and beat-to-beat smoothness (≤35% jump between adjacent
 * beats).
 */
function interBeatRegularity(pulse: number[], fps: number): number {
  const sigma = std(pulse);
  if (sigma < 1e-9) return 0;

  const crossings: number[] = [];
  let armed = true;
  const minRefractorySec = 0.30;

  for (let i = 1; i < pulse.length; i++) {
    if (pulse[i] < -0.20 * sigma) {
      armed = true;
    }
    if (armed && pulse[i - 1] <= 0 && pulse[i] > 0) {
      const frac = -pulse[i - 1] / Math.max(1e-9, pulse[i] - pulse[i - 1]);
      const tSec = (i - 1 + frac) / fps;
      if (
        crossings.length === 0 ||
        tSec - crossings[crossings.length - 1] >= minRefractorySec
      ) {
        crossings.push(tSec);
        armed = false;
      }
    }
  }
  if (crossings.length < 3) return 0;

  const intervals: number[] = [];
  for (let i = 1; i < crossings.length; i++) {
    intervals.push(crossings[i] - crossings[i - 1]);
  }

  const medianIBI = median(intervals);
  if (medianIBI < 60 / 180 || medianIBI > 60 / 40) return 0;

  const tolerance = medianIBI * 0.28;
  const maxStep = medianIBI * 0.35;
  const consistent = intervals.filter(
    (ibi, i) =>
      Math.abs(ibi - medianIBI) <= tolerance &&
      (i === 0 || Math.abs(ibi - intervals[i - 1]) <= maxStep)
  ).length;

  return consistent / intervals.length;
}

function evaluateSegment(
  valid: RGBSample[],
  qualityOverride?: PulseQuality
): PulseResult {
  const duration = valid.length >= 2
    ? (valid[valid.length - 1].t - valid[0].t) / 1000
    : 0;

  const fps = duration > 0
    ? (valid.length - 1) / duration
    : 0;

  const motionFraction = valid.length
    ? valid.filter(s => s.motion).length / valid.length
    : 1;

  const quality = qualityOverride ?? {
    fps,
    usableSeconds: duration,
    motionFraction
  };

  const unavailable = (detail: string): PulseResult => ({
    bpm: null,
    snrDb: null,
    quality,
    waveform: [],
    risk: null,
    detail
  });

  if (
    duration < MIN_SECONDS ||
    fps < 12 ||
    motionFraction > 0.35
  ) {
    return unavailable(
      "Insufficient stable facial video. Hold still and retry."
    );
  }

  // Anti-spoof check 1: coherent green channel temporal variance.
  const greenVar = greenChannelVariance(valid);
  if (greenVar < GREEN_VARIANCE_FLOOR) {
    return unavailable(
      "Skin color variance too low — no physiological fluctuation detected. " +
      "A live face is required."
    );
  }

  const uniform = resample(valid);
  const pulse = extractPOS(uniform);

  // Anti-spoof check 2: bandpass-filtered POS waveform amplitude.
  const pulseAmplitude = std(pulse);
  if (pulseAmplitude < AMPLITUDE_FLOOR) {
    return unavailable(
      "Pulse signal amplitude too weak — consistent with a static image. " +
      "A live face is required."
    );
  }

  const frequency = estimateFrequency(pulse);

  if (!frequency) {
    return unavailable(
      "No measurable pulse-frequency peak was found."
    );
  }

  const { bpm, snrDb, spectralPurity } = frequency;

  // Anti-spoof check 3: spectral purity.
  // A real heartbeat concentrates energy at the pulse frequency and its
  // harmonic. Camera noise on a photo spreads power across all frequencies.
  if (spectralPurity < SPECTRAL_PURITY_MIN || snrDb < SNR_MARGINAL_DB) {
    return unavailable(
      "Spectral energy is spread across all frequencies — no dominant pulse. " +
      "This is consistent with sensor noise on a static image."
    );
  }

  // Anti-spoof check 4: inter-beat interval regularity.
  // A real heartbeat produces rhythmic, evenly-spaced peaks. Random noise
  // from a still image produces irregularly spaced zero-crossings.
  const regularity = interBeatRegularity(pulse, SAMPLE_RATE);
  if (regularity < IBI_REGULARITY_MIN) {
    return unavailable(
      "Pulse rhythm is irregular — inter-beat intervals are inconsistent " +
      "with a physiological heartbeat. A live face is required."
    );
  }

  // Risk scoring with raised SNR thresholds.
  const risk =
    snrDb >= SNR_CONFIDENT_DB &&
    bpm >= 45 &&
    bpm <= 150 &&
    spectralPurity >= SPECTRAL_PURITY_CONFIDENT &&
    regularity >= IBI_REGULARITY_CONFIDENT
      ? 15
      : snrDb >= SNR_MARGINAL_DB
        ? 45
        : 80;

  const lastSixSeconds = pulse.slice(-SAMPLE_RATE * 6);
  const average = mean(lastSixSeconds);
  const scale = Math.max(1e-9, std(lastSixSeconds));

  return {
    bpm: Math.round(bpm * 10) / 10,
    snrDb: Math.round(snrDb * 10) / 10,
    quality,
    waveform: lastSixSeconds.map(v =>
      (v - average) / scale
    ),
    risk,
    detail:
      `Experimental skin-color pulse estimate: ` +
      `${Math.round(bpm)} BPM, ` +
      `SNR ${snrDb.toFixed(1)} dB, ` +
      `spectral purity ${(spectralPurity * 100).toFixed(0)}%, ` +
      `rhythm regularity ${(regularity * 100).toFixed(0)}%. ` +
      `Not medical-grade or validated spoof detection.`
  };
}

export function analyzePulse(samples: RGBSample[]): PulseResult {
  const valid = samples.filter(finiteSample)
    .sort((a, b) => a.t - b.t);

  const primary = evaluateSegment(valid);
  if (primary.risk !== null) {
    return primary;
  }

  // If the user moved slightly during the first 1-3 seconds while settling
  // after clicking the prompt button, evaluate the trailing stable window
  // (provided overall motion is not excessive).
  if (valid.length >= 2 && primary.quality.motionFraction <= 0.4) {
    const endT = valid[valid.length - 1].t;
    const trailingStart = endT - 9000;
    const trailing = valid.filter(s => s.t >= trailingStart && !s.motion);
    if (trailing.length >= 2) {
      const trailingDuration =
        (trailing[trailing.length - 1].t - trailing[0].t) / 1000;
      if (trailingDuration >= MIN_SECONDS) {
        const fallback = evaluateSegment(trailing, primary.quality);
        if (fallback.risk !== null) {
          return fallback;
        }
      }
    }
  }

  return primary;
}

/**
 * Lightweight live preview used during the 12-second countdown UI so the user
 * can see their pulse waveform and preliminary BPM estimate after ~4 seconds
 * while continuing to hold still for the full verification window.
 */
export function previewPulse(samples: RGBSample[]): {
  bpm: number | null;
  waveform: number[];
} {
  const full = analyzePulse(samples);
  if (full.bpm !== null && full.waveform.length > 0) {
    return { bpm: full.bpm, waveform: full.waveform };
  }

  const valid = samples.filter(finiteSample)
    .sort((a, b) => a.t - b.t);

  if (valid.length < 2) return { bpm: null, waveform: [] };

  const duration = (valid[valid.length - 1].t - valid[0].t) / 1000;
  const fps = duration > 0 ? (valid.length - 1) / duration : 0;
  const motionFraction =
    valid.filter(s => s.motion).length / valid.length;

  if (
    duration < PREVIEW_MIN_SECONDS ||
    fps < 12 ||
    motionFraction > 0.45 ||
    greenChannelVariance(valid) < GREEN_VARIANCE_FLOOR
  ) {
    return { bpm: null, waveform: [] };
  }

  const uniform = resample(valid);
  const pulse = extractPOS(uniform);
  if (std(pulse) < AMPLITUDE_FLOOR) {
    return { bpm: null, waveform: [] };
  }

  const freq = estimateFrequency(pulse, SAMPLE_RATE, PREVIEW_MIN_SECONDS);
  const slice = pulse.slice(-SAMPLE_RATE * 6);
  const avg = mean(slice);
  const scale = Math.max(1e-9, std(slice));
  const waveform = slice.map(v => (v - avg) / scale);

  if (
    !freq ||
    freq.spectralPurity < SPECTRAL_PURITY_MIN ||
    freq.snrDb < SNR_MARGINAL_DB
  ) {
    return { bpm: null, waveform };
  }

  return {
    bpm: Math.round(freq.bpm * 10) / 10,
    waveform
  };
}