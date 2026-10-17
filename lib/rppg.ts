
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

/**
 * Anti-spoofing thresholds.
 * A still image (photo/printout) held in front of the camera lacks real
 * blood-flow-driven skin-color oscillation. These checks reject such fakes.
 */
const SNR_CONFIDENT_DB = 5;       // raised from 3; noise on a photo can hit ~3 dB
const SNR_MARGINAL_DB = 1;        // below this = no detectable pulse
const GREEN_VARIANCE_FLOOR = 0.06; // minimum σ of normalized green channel
const AMPLITUDE_FLOOR = 0.002;     // minimum σ of the POS pulse waveform
const SPECTRAL_PURITY_MIN = 0.25;  // peak-band must carry ≥25 % of in-band power
const IBI_REGULARITY_MIN = 0.65;   // min ratio of consistent inter-beat intervals

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
): { bpm: number; snrDb: number; spectralPurity: number } | null {
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
 * Check that the green channel has enough temporal variance.
 * Real skin under blood flow produces measurable green-channel oscillation.
 * A printed photo or static screen image has near-constant pixel values;
 * any variance comes only from camera sensor noise, which is much smaller.
 */
function greenChannelVariance(samples: RGBSample[]): number {
  if (samples.length < 2) return 0;
  const greens = samples.map(s => s.g);
  const avg = mean(greens);
  if (avg < 1e-9) return 0;
  // Normalized standard deviation (coefficient of variation)
  return std(greens) / avg;
}

/**
 * Count zero-crossings in the POS pulse waveform and check that
 * the inter-beat intervals are regular (a real heartbeat is rhythmic;
 * random noise peaks are not).
 *
 * Returns a regularity score between 0 and 1, where 1 means perfectly
 * uniform intervals and 0 means chaotic/random.
 */
function interBeatRegularity(pulse: number[], fps: number): number {
  // Find positive zero-crossings (rising edges)
  const crossings: number[] = [];
  for (let i = 1; i < pulse.length; i++) {
    if (pulse[i - 1] <= 0 && pulse[i] > 0) {
      crossings.push(i / fps); // time in seconds
    }
  }
  if (crossings.length < 3) return 0;

  // Compute inter-beat intervals
  const intervals: number[] = [];
  for (let i = 1; i < crossings.length; i++) {
    intervals.push(crossings[i] - crossings[i - 1]);
  }

  // Reject if intervals are outside the physiological range (40-180 BPM)
  const medianIBI = intervals.slice().sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
  if (medianIBI < 60 / 180 || medianIBI > 60 / 40) return 0;

  // Check consistency: fraction of intervals within ±25% of the median
  const tolerance = medianIBI * 0.25;
  const consistent = intervals.filter(ibi =>
    Math.abs(ibi - medianIBI) <= tolerance
  ).length;

  return consistent / intervals.length;
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

  // Anti-spoof check 1: green channel temporal variance.
  // A still image has near-zero variance; real skin has measurable oscillation.
  const greenVar = greenChannelVariance(valid);
  if (greenVar < GREEN_VARIANCE_FLOOR) {
    return unavailable(
      "Skin color variance too low — no physiological fluctuation detected. " +
      "A live face is required."
    );
  }

  const uniform = resample(valid);
  const pulse = extractPOS(uniform);

  // Anti-spoof check 2: POS waveform amplitude.
  // The extracted pulse signal must have meaningful oscillation, not just
  // sub-pixel sensor noise amplified by the POS algorithm.
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
  if (spectralPurity < SPECTRAL_PURITY_MIN) {
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
    snrDb >= SNR_CONFIDENT_DB && bpm >= 45 && bpm <= 150 &&
    spectralPurity >= SPECTRAL_PURITY_MIN && regularity >= IBI_REGULARITY_MIN
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
