import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzePulse,
  previewPulse,
  resample,
  type RGBSample
} from "../lib/rppg.ts";

/**
 * Generate synthetic facial RGB measurements.
 * Supports both strong synthetic amplitudes and realistic physiological
 * webcam amplitudes (~0.2-0.6 RGB units around 115-150 DC).
 * No real camera or biometric data is involved.
 */
function generateSamples(
  durationSeconds: number,
  bpm = 72,
  noisy = false
): RGBSample[] {
  const samples: RGBSample[] = [];
  const frequency = bpm / 60;

  let t = 0;
  let index = 0;

  while (t < durationSeconds * 1000) {
    const seconds = t / 1000;

    const pulse = Math.sin(
      2 * Math.PI * frequency * seconds
    );

    const noise = noisy
      ? 0.8 * Math.sin(2 * Math.PI * 2.7 * seconds) +
        0.7 * Math.sin(2 * Math.PI * 1.8 * seconds)
      : 0.02 * Math.sin(2 * Math.PI * 3.7 * seconds);

    samples.push({
      t,
      r: 120 + 4 * pulse + noise,
      g: 150 + 15 * pulse + noise,
      b: 100 + 2 * pulse + noise,
      motion: false
    });

    // Deterministic uneven sampling around 30 FPS.
    const fps = 28 + (index % 4);
    t += 1000 / fps;
    index++;
  }

  return samples;
}

/**
 * Simulate a real human face in front of an 8-bit webcam:
 * - Subtle physiological cardiac oscillation in green (~0.20-0.55 RGB units out of ~118),
 *   with smaller red/blue pulsatile components and a dicrotic harmonic
 * - Respiratory baseline modulation (~0.27 Hz) and heart rate variability (RSA)
 * - Camera sensor noise on every frame
 */
function generateRealisticHumanWebcamSamples(opts: {
  durationSeconds?: number;
  bpm?: number;
  greenPulseAmp?: number;
  sensorNoise?: number;
  initialMotionSeconds?: number;
  seed?: number;
} = {}): RGBSample[] {
  const {
    durationSeconds = 12,
    bpm = 74,
    greenPulseAmp = 0.45,
    sensorNoise = 0.35,
    initialMotionSeconds = 0,
    seed = 101
  } = opts;

  let s = seed;
  const pseudoRandom = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) - 0.5;
  };

  const f0 = bpm / 60;
  const samples: RGBSample[] = [];
  let t = 0;
  let prevT = 0;
  let phase = 0;
  let index = 0;

  while (t < durationSeconds * 1000) {
    const dt = (t - prevT) / 1000;
    const seconds = t / 1000;
    // Natural respiratory sinus arrhythmia (±2.5% HRV)
    const instFreq = f0 * (1 + 0.025 * Math.sin(2 * Math.PI * 0.25 * seconds));
    phase += 2 * Math.PI * instFreq * dt;
    prevT = t;

    const cardiacWave = Math.sin(phase) + 0.25 * Math.sin(2 * phase - 0.8);
    const respirationLuminance =
      1 + 0.003 * Math.sin(2 * Math.PI * 0.27 * seconds);

    const motion = seconds < initialMotionSeconds;
    const motionArtifact = motion
      ? 4.0 * Math.sin(2 * Math.PI * 1.9 * seconds)
      : 0;

    samples.push({
      t,
      r:
        (145 + motionArtifact) * respirationLuminance -
        greenPulseAmp * 0.25 * cardiacWave +
        pseudoRandom() * sensorNoise,
      g:
        (118 + motionArtifact) * respirationLuminance -
        greenPulseAmp * cardiacWave +
        pseudoRandom() * sensorNoise,
      b:
        (96 + motionArtifact) * respirationLuminance -
        greenPulseAmp * 0.15 * cardiacWave +
        pseudoRandom() * sensorNoise,
      motion
    });

    const fps = 28 + (index % 3);
    t += 1000 / fps;
    index++;
  }

  return samples;
}

test("resampling produces approximately 30 samples per second", () => {
  const input = generateSamples(10);
  const output = resample(input, 30);

  assert.ok(output.length >= 295);
  assert.ok(output.length <= 301);
});

test("synthetic 72 BPM pulse is recovered", () => {
  const result = analyzePulse(generateSamples(12, 72));

  assert.notEqual(result.bpm, null);
  assert.ok(
    Math.abs(result.bpm! - 72) <= 3,
    `Expected approximately 72 BPM, got ${result.bpm}`
  );

  assert.notEqual(result.snrDb, null);
  assert.ok(
    result.snrDb! >= 5,
    `Expected SNR >= 5 dB, got ${result.snrDb}`
  );
  assert.equal(result.risk, 15);
});

test("realistic human webcam pulse with subtle physiological amplitude passes", () => {
  const samples = generateRealisticHumanWebcamSamples({
    durationSeconds: 12,
    bpm: 74,
    greenPulseAmp: 0.45,
    sensorNoise: 0.35
  });
  const result = analyzePulse(samples);

  assert.notEqual(result.bpm, null, "Real human pulse must be detected");
  assert.ok(
    Math.abs(result.bpm! - 74) <= 3,
    `Expected approximately 74 BPM, got ${result.bpm}`
  );
  assert.equal(
    result.risk,
    15,
    `Expected confident low risk (15) for real human, got ${result.risk} (${result.detail})`
  );
  assert.ok(result.waveform.length > 0);
});

test("realistic human in low light / low contrast still passes", () => {
  const samples = generateRealisticHumanWebcamSamples({
    durationSeconds: 12,
    bpm: 66,
    greenPulseAmp: 0.18,
    sensorNoise: 0.22
  });
  const result = analyzePulse(samples);

  assert.notEqual(result.bpm, null, "Low-contrast human pulse must be detected");
  assert.ok(
    Math.abs(result.bpm! - 66) <= 3,
    `Expected approximately 66 BPM, got ${result.bpm}`
  );
  assert.equal(result.risk, 15);
});

test("realistic human with initial settling motion recovers from trailing stable window", () => {
  const samples = generateRealisticHumanWebcamSamples({
    durationSeconds: 12,
    bpm: 78,
    greenPulseAmp: 0.45,
    sensorNoise: 0.35,
    initialMotionSeconds: 2.0
  });
  const result = analyzePulse(samples);

  assert.notEqual(result.bpm, null);
  assert.ok(
    Math.abs(result.bpm! - 78) <= 3,
    `Expected approximately 78 BPM, got ${result.bpm}`
  );
  assert.equal(result.risk, 15);
});

test("previewPulse provides early live BPM and waveform feedback after 5 seconds", () => {
  const samples = generateRealisticHumanWebcamSamples({
    durationSeconds: 5,
    bpm: 72,
    greenPulseAmp: 0.45,
    sensorNoise: 0.3
  });
  const preview = previewPulse(samples);

  assert.notEqual(preview.bpm, null);
  assert.ok(Math.abs(preview.bpm! - 72) <= 4);
  assert.ok(preview.waveform.length > 0);
});

test("five seconds of data is unavailable", () => {
  const result = analyzePulse(generateSamples(5));

  assert.equal(result.risk, null);
  assert.equal(result.bpm, null);
});

test("excessive motion makes evidence unavailable", () => {
  const samples = generateSamples(12);

  for (let i = 0; i < samples.length; i++) {
    samples[i].motion = i % 2 === 0;
  }

  const result = analyzePulse(samples);

  assert.equal(result.risk, null);
  assert.equal(result.bpm, null);
});

test("low frame rate makes evidence unavailable", () => {
  const samples = generateSamples(12)
    .filter((_, index) => index % 4 === 0);

  const result = analyzePulse(samples);

  assert.equal(result.risk, null);
});

test("flat RGB signal cannot produce a valid pulse", () => {
  const samples = generateSamples(12).map(sample => ({
    ...sample,
    r: 120,
    g: 150,
    b: 100
  }));

  const result = analyzePulse(samples);

  assert.equal(result.risk, null);
  assert.equal(result.bpm, null);
});

// ── Anti-spoofing tests ──────────────────────────────────────────────

test("still image with tiny sensor noise is rejected", () => {
  // Simulates a printed photo or screen replay: constant color with
  // only sub-pixel camera sensor noise (no blood-flow oscillation).
  let seed = 42;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5; // range [-0.5, 0.5]
  };

  const samples: RGBSample[] = [];
  let t = 0;
  while (t < 12000) {
    samples.push({
      t,
      r: 120 + pseudoRandom() * 0.3,
      g: 150 + pseudoRandom() * 0.3,
      b: 100 + pseudoRandom() * 0.3,
      motion: false
    });
    t += 1000 / 30;
  }

  const result = analyzePulse(samples);

  assert.equal(result.risk, null, "A still image must not produce a pulse risk score");
  assert.equal(result.bpm, null, "A still image must not produce a BPM reading");
});

test("hand-held still photo with lighting sway is rejected", () => {
  // Simulates holding a printed photo or phone in front of the webcam:
  // hand tremor modulates luminance proportionally across R, G, and B,
  // without chromatic hemoglobin absorption.
  let seed = 202;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5;
  };

  const samples: RGBSample[] = [];
  let t = 0;
  while (t < 12000) {
    const sec = t / 1000;
    const shading =
      1 +
      0.012 *
        (0.6 * Math.sin(2 * Math.PI * 0.35 * sec) +
          0.3 * Math.sin(2 * Math.PI * 0.9 * sec + 0.5) +
          0.2 * Math.sin(2 * Math.PI * 1.8 * sec + 1.2));

    samples.push({
      t,
      r: 140 * shading + pseudoRandom() * 0.25,
      g: 120 * shading + pseudoRandom() * 0.25,
      b: 95 * shading + pseudoRandom() * 0.25,
      motion: false
    });
    t += 1000 / 30;
  }

  const result = analyzePulse(samples);

  assert.equal(result.risk, null, "Hand-held still photo must be rejected");
  assert.equal(result.bpm, null, "Hand-held still photo must not produce a BPM reading");
});

test("random noise without a rhythmic pulse is rejected", () => {
  // Larger variance but no coherent heartbeat frequency.
  // This catches the case where a screen replay adds noise but no real pulse.
  let seed = 137;
  const pseudoRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) - 0.5;
  };

  const samples: RGBSample[] = [];
  let t = 0;
  while (t < 12000) {
    samples.push({
      t,
      r: 120 + pseudoRandom() * 5,
      g: 150 + pseudoRandom() * 5,
      b: 100 + pseudoRandom() * 5,
      motion: false
    });
    t += 1000 / 30;
  }

  const result = analyzePulse(samples);

  // May or may not find a BPM, but risk must be null or high (≥45)
  // because spectral purity or IBI regularity will fail.
  if (result.risk !== null) {
    assert.ok(
      result.risk >= 45,
      `Random noise should not get a confident pulse. Risk: ${result.risk}`
    );
  }
});

test("irregular rhythm is rejected even with strong amplitude", () => {
  // Strong green-channel oscillation but at random, non-rhythmic intervals.
  // This mimics e.g. flickering lighting on a static subject.
  const samples: RGBSample[] = [];
  let t = 0;
  let index = 0;

  while (t < 12000) {
    const seconds = t / 1000;
    // Mix of incommensurate frequencies → no single dominant peak
    const signal =
      1.5 * Math.sin(2 * Math.PI * 1.1 * seconds) +
      1.5 * Math.sin(2 * Math.PI * 1.7 * seconds) +
      1.0 * Math.sin(2 * Math.PI * 2.3 * seconds);

    samples.push({
      t,
      r: 120 + 0.1 * signal,
      g: 150 + 2.0 * signal,
      b: 100 + 0.1 * signal,
      motion: false
    });

    const fps = 28 + (index % 4);
    t += 1000 / fps;
    index++;
  }

  const result = analyzePulse(samples);

  // Either completely rejected (risk null) or penalized (risk ≥ 45)
  if (result.risk !== null) {
    assert.ok(
      result.risk >= 45,
      `Irregular rhythm should not get a confident pulse. Risk: ${result.risk}`
    );
  }
});