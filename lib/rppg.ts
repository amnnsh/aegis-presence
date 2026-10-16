
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
const MIN_SECONDS = 8;
const LOW_HZ = 0.7;
const HIGH_HZ = 3.0;
const WINDOW_SECONDS = 1.6;

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) /
    Math.max(1, values.length);
}

function std(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map(v => (v - m) ** 2)));
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

/** POS: Plane-Orthogonal-to-Skin pulse extraction. */
export function extractPOS(samples: RGBSample[]): number[] {
  const length = samples.length;
  const output = new Array<number>(length).fill(0);
  const counts = new Array<number>(length).fill(0);

  const windowSize = Math.round(
    WINDOW_SECONDS * SAMPLE_RATE
  );
  const stride = Math.max(1, Math.floor(windowSize / 2));

  if (length < windowSize) return output;

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

    for (let i = 0; i < windowSize; i++) {
      output[start + i] += pulse[i] - center;
      counts[start + i]++;
    }
  }

  return output.map((v, i) =>
    counts[i] ? v / counts[i] : 0
  );
}

/**
 * Hann-windowed frequency analysis.
 * Computes the equivalent positive-frequency DFT bins.
 * For a 12-second sample this is inexpensive enough
 * for occasional processing, not per-frame execution.
 */
export function estimateFrequency(
  signal: number[],
  fps = SAMPLE_RATE
): { bpm: number; snrDb: number } | null {
  const n = signal.length;
  if (n < fps * MIN_SECONDS) return null;

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

  const peak = bins.reduce((a, b) =>
    b.power > a.power ? b : a
  );

  const totalPower = bins.reduce(
    (sum, b) => sum + b.power, 0
  );

  if (totalPower < 1e-12) return null;

  const signalPower = bins
    .filter(b =>
      Math.abs(b.hz - peak.hz) <= 0.1 ||
      Math.abs(b.hz - 2 * peak.hz) <= 0.1
    )
    .reduce((sum, b) => sum + b.power, 0);

  const noisePower = Math.max(
    1e-12,
    totalPower - signalPower
  );

  return {
    bpm: peak.hz * 60,
    snrDb: 10 * Math.log10(
      Math.max(1e-12, signalPower) / noisePower
    )
  };
}

export function analyzePulse(samples: RGBSample[]): PulseResult {
  const valid = samples.filter(finiteSample)
    .sort((a, b) => a.t - b.t);

  const duration = valid.length >= 2
    ? (valid[valid.length - 1].t - valid[0].t) / 1000
    : 0;

  const fps = duration > 0
    ? (valid.length - 1) / duration
    : 0;

  const motionFraction = valid.length
    ? valid.filter(s => s.motion).length / valid.length
    : 1;

  const quality = {
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
    fps < 15 ||
    motionFraction > 0.3
  ) {
    return unavailable(
      "Insufficient stable facial video. Hold still and retry."
    );
  }

  const uniform = resample(valid);
  const pulse = extractPOS(uniform);
  const frequency = estimateFrequency(pulse);

  if (!frequency) {
    return unavailable(
      "No measurable pulse-frequency peak was found."
    );
  }

  const { bpm, snrDb } = frequency;

  const risk =
    snrDb >= 3 && bpm >= 45 && bpm <= 150
      ? 15
      : snrDb >= 0
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
      `SNR ${snrDb.toFixed(1)} dB. ` +
      `Not medical-grade or validated spoof detection.`
  };
}
