
import type {
  Challenge,
  ChallengeResult,
  FaceMetrics,
  Signal
} from "./types.ts";

export function randomInt(max: number): number {
  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 0x100000000
  ) {
    throw new Error("Invalid random range");
  }

  const limit =
    Math.floor(0x100000000 / max) * max;

  const data = new Uint32Array(1);

  do {
    globalThis.crypto.getRandomValues(data);
  } while (data[0] >= limit);

  return data[0] % max;
}

export function shuffle<T>(items: T[]): T[] {
  const result = [...items];

  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);

    [result[i], result[j]] = [
      result[j],
      result[i]
    ];
  }

  return result;
}

export function createChallenges(): Challenge[] {
  return shuffle<Challenge>([
    {
      kind: "head",
      direction: randomInt(2) ? "left" : "right"
    },
    {
      kind: "blink"
    },
    {
      kind: "digits",
      digits: Array.from(
        { length: 4 },
        () => randomInt(10)
      ).join("")
    }
  ]);
}

export function challengeTitle(c: Challenge): string {
  if (c.kind === "head") {
    return `Turn ${c.direction}, then face forward`;
  }

  if (c.kind === "blink") {
    return "Blink twice, naturally";
  }

  return `Read ${c.digits?.split("").join(" ")} aloud`;
}

export function challengeHint(
  c: Challenge,
  microphone = false
): string {
  if (c.kind === "head") {
    return `Look straight ahead to calibrate. Turn your head ${c.direction}, hold briefly, then return to center. Keep your face visible.`;
  }

  if (c.kind === "blink") {
    return "Keep both eyes visible. Fully open your eyes between each blink.";
  }

  if (microphone) {
    return "Read all four digits aloud at a steady pace, then pause. Your voice is transcribed and compared with your lip movement on this device. No audio is uploaded or kept.";
  }

  return "Only mouth movement is observed. The digits and your voice are NOT recognized or verified. The microphone is off.";
}

/**
 * Head-pose calibration and movement thresholds.
 *
 * Calibrated webcam direction mapping:
 * Physical LEFT  = positive yaw
 * Physical RIGHT = negative yaw
 */
const HEAD_CALIBRATION_FRAMES = 8;
const HEAD_TURN_THRESHOLD_DEG = 15;
const HEAD_CALIBRATION_MAX_RANGE_DEG = 8;
const HEAD_CALIBRATION_MAX_ABS_YAW_DEG = 12;
const HEAD_CENTER_THRESHOLD_DEG = 6;
const HEAD_STABLE_FRAMES = 3;

// Reject obvious sideways head tilts during yaw detection.
const MAX_ROLL_DEG = 25;

// Prevent excessively tilted up/down poses from
// being counted as clean left/right turns.
const MAX_PITCH_CHANGE_DEG = 30;

/**
 * Stateful gesture tracker.
 *
 * Head challenge:
 * 1. Calibrate neutral pose.
 * 2. Detect correct direction.
 * 3. Require stable rotation.
 * 4. Require return to center.
 *
 * Blink and digits behavior remains compatible
 * with the existing implementation.
 */
export class GestureTracker {
  private baseline: number[] = [];
  private pitchBaseline: number[] = [];
  private rollBaseline: number[] = [];

  private turned = false;
  private stable = 0;
  private recentHeadMatches: boolean[] = [];

  private openSeen = false;
  private closedAt: number | null = null;
  private lastCycle = -Infinity;
  private cycles = 0;

  private lastValid = -Infinity;
  private validFrames = 0;
  private completed = false;

  private challenge: Challenge;

  constructor(challenge: Challenge) {
    this.challenge = challenge;
  }

  get progress(): string {
    if (this.challenge.kind === "head") {
      if (
        this.baseline.length <
        HEAD_CALIBRATION_FRAMES
      ) {
        return "Center your face to calibrate";
      }

      return this.turned
        ? "Now return to center"
        : "Turn your head in the indicated direction";
    }

    if (this.challenge.kind === "blink") {
      return `${this.cycles}/2 blinks observed`;
    }

    return `${this.cycles}/2 mouth movements observed`;
  }

private resetHead(): void {
  this.baseline = [];
  this.pitchBaseline = [];
  this.rollBaseline = [];

  this.turned = false;
  this.stable = 0;
  this.recentHeadMatches = [];
}

  update(m: FaceMetrics): ChallengeResult | null {
    if (this.completed) return null;

    // Require exactly one visible face.
    if (m.faceCount !== 1) {
      this.resetHead();

      this.openSeen = false;
      this.closedAt = null;
      this.cycles = 0;
      this.lastCycle = -Infinity;
      this.lastValid = -Infinity;

      return null;
    }

    // Reject stale tracking data.
    if (
      m.timestamp - this.lastValid > 1200
    ) {
      this.closedAt = null;
      this.openSeen = false;
      this.stable = 0;

      if (this.challenge.kind === "head") {
        this.resetHead();
      }
    }

    this.lastValid = m.timestamp;
    this.validFrames++;

    if (this.challenge.kind === "head") {
      return this.updateHead(m);
    }

    return this.updateBlinkOrDigits(m);
  }

  /**
   * 3D head-pose challenge.
   */

private updateHead(m: FaceMetrics): ChallengeResult | null {
  const yaw = m.yawDeg;
  const pitch = m.pitchDeg;
  const roll = m.rollDeg;

  // Require valid 3D head-pose measurements.
  if (
    yaw === undefined ||
    pitch === undefined ||
    roll === undefined ||
    !Number.isFinite(yaw) ||
    !Number.isFinite(pitch) ||
    !Number.isFinite(roll)
  ) {
    this.resetHead();
    return null;
  }

  // Initial neutral-position calibration.
 // Collect only reasonably forward-facing, stable poses.
if (this.baseline.length < HEAD_CALIBRATION_FRAMES) {
  if (
    Math.abs(yaw) > HEAD_CALIBRATION_MAX_ABS_YAW_DEG ||
    Math.abs(roll) > MAX_ROLL_DEG
  ) {
    this.baseline = [];
    this.pitchBaseline = [];
    this.rollBaseline = [];
    this.recentHeadMatches = [];
    this.stable = 0;
    return null;
  }

  this.baseline.push(yaw);
  this.pitchBaseline.push(pitch);
  this.rollBaseline.push(roll);

  const range = (values: number[]) =>
    Math.max(...values) - Math.min(...values);

  if (
    range(this.baseline) > HEAD_CALIBRATION_MAX_RANGE_DEG ||
    range(this.pitchBaseline) > 10 ||
    range(this.rollBaseline) > 10
  ) {
    // Discard unstable calibration and restart.
    this.baseline = [];
    this.pitchBaseline = [];
    this.rollBaseline = [];
  }

  return null;
}


const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const neutralYaw = median(this.baseline);
const neutralPitch = median(this.pitchBaseline);
const neutralRoll = median(this.rollBaseline);

  const yawDelta = yaw - neutralYaw;
  const pitchDelta = pitch - neutralPitch;
  const rollDelta = roll - neutralRoll;

  // Debug logging.
  if (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search)
      .get("debug") === "1"
  ) {
    console.log("HEAD CHALLENGE:", {
      requestedDirection: this.challenge.direction,
      neutralYaw: neutralYaw.toFixed(1),
      yawDelta: yawDelta.toFixed(1),
      pitchDelta: pitchDelta.toFixed(1),
      rollDelta: rollDelta.toFixed(1),
      turned: this.turned,
      stableFrames: this.stable,
      matchingFrames:
        this.recentHeadMatches.filter(Boolean).length,
      progress: this.progress
    });
  }

  // Reject excessive vertical movement or sideways tilt.
  if (
    Math.abs(rollDelta) > MAX_ROLL_DEG ||
    Math.abs(pitchDelta) > MAX_PITCH_CHANGE_DEG
  ) {
    this.stable = 0;
    this.recentHeadMatches = [];
    return null;
  }

  // Calibrated mapping:
  // Physical LEFT  = positive yaw
  // Physical RIGHT = negative yaw.
  const direction =
    this.challenge.direction === "left" ? 1 : -1;

  if (!this.turned) {
    const directedYaw = yawDelta * direction;

    const correctTurn =
      directedYaw >= HEAD_TURN_THRESHOLD_DEG;

    const wrongTurn =
      directedYaw <= -HEAD_TURN_THRESHOLD_DEG;

    // Wrong-direction movement resets the candidate window.
    if (wrongTurn) {
      this.stable = 0;
      this.recentHeadMatches = [];
      return null;
    }

    // Maintain the last five observations.
    this.recentHeadMatches.push(correctTurn);

    if (this.recentHeadMatches.length > 5) {
      this.recentHeadMatches.shift();
    }

    const matchingFrames =
      this.recentHeadMatches.filter(Boolean).length;

    // Require 3 valid frames out of 5.
    if (
      this.recentHeadMatches.length === 5 &&
      matchingFrames >= 3
    ) {
      this.turned = true;
      this.stable = 0;
      this.recentHeadMatches = [];
    }

    return null;
  }

  // Require the user to return to the neutral pose.
  const returnedToCenter =
    Math.abs(yawDelta) <= HEAD_CENTER_THRESHOLD_DEG &&
    Math.abs(pitchDelta) <= 12 &&
    Math.abs(rollDelta) <= 12;

  this.stable = returnedToCenter
    ? this.stable + 1
    : 0;

  if (this.stable >= HEAD_STABLE_FRAMES) {
    this.completed = true;

    return {
      kind: "head",
      status: "observed",
      risk: 10,
      detail:
        `3D head pose followed the ${this.challenge.direction} prompt ` +
        `and returned to neutral. Experimental MediaPipe ` +
        `orientation heuristic; not proof of identity.`
    };
  }

  return null;
}


  /**
   * Existing blink and mouth-motion tracking.
   */
  private updateBlinkOrDigits(
    m: FaceMetrics
  ): ChallengeResult | null {
    const blinking =
      this.challenge.kind === "blink";

    const isClosed = blinking
      ? m.blinkLeft > 0.55 &&
        m.blinkRight > 0.55
      : m.jawOpen > 0.22;

    const isOpen = blinking
      ? m.blinkLeft < 0.3 &&
        m.blinkRight < 0.3
      : m.jawOpen < 0.12;

    if (isOpen) {
      if (
        this.openSeen &&
        this.closedAt !== null
      ) {
        const duration =
          m.timestamp - this.closedAt;

        if (
          duration >= 70 &&
          duration <= 1400 &&
          m.timestamp - this.lastCycle > 180
        ) {
          this.cycles++;
          this.lastCycle = m.timestamp;
        }
      }

      this.openSeen = true;
      this.closedAt = null;
    } else if (
      isClosed &&
      this.openSeen &&
      this.closedAt === null
    ) {
      this.closedAt = m.timestamp;
    }

    if (this.cycles >= 2) {
      this.completed = true;

      if (blinking) {
        return {
          kind: "blink",
          status: "observed",
          risk: 10,
          detail:
            "Two bilateral close / reopen cycles observed; not certified liveness."
        };
      }

      return {
        kind: "digits",
        status: "partial",
        risk: 60,
        detail:
          "Mouth motion observed; the random digits and audio were NOT verified."
      };
    }

    return null;
  }

  unavailable(): ChallengeResult {
    return {
      kind: this.challenge.kind,
      status: "unavailable",
      risk: null,
      detail: this.validFrames
        ? "Prompt not completed or skipped. This may be a capability, accessibility, or lighting issue, not fraud."
        : "No usable single-face evidence. Missing evidence is not a pass."
    };
  }
}

/**
 * Existing weighted liveness signal.
 * Preserves spoken-digit scoring.
 */
export function livenessSignal(
  results: ChallengeResult[]
): Signal {
  const measured = results.filter(
    r => r.status === "observed"
  );

  if (measured.length === 0) {
    return {
      id: "liveness",
      risk: null,
      provenance: "unavailable",
      detail:
        "No completed head / blink / spoken-digit evidence."
    };
  }

  const values = [
    "head",
    "blink",
    "digits"
  ].map(
    kind =>
      results.find(
        r => r.kind === kind
      )?.risk ?? 60
  );

  const gestures = measured.filter(
    r => r.kind !== "digits"
  ).length;

  const digits = results.find(
    r => r.kind === "digits"
  );

  const spoken =
    digits?.status === "observed" &&
    typeof digits.matched === "number"
      ? `Spoken digits: ${digits.matched}/4 recognized on-device, contributing risk ${digits.risk}.`
      : "Digit content is unverified and contributes risk 60.";

  return {
    id: "liveness",
    risk: Math.round(
      values.reduce(
        (sum, value) => sum + value,
        0
      ) / 3
    ),
    provenance: "heuristic",
    detail:
      `${gestures}/2 head / blink gestures observed. ` +
      `${spoken} These are motion and speech-content heuristics, ` +
      `not proof of liveness or identity.`
  };
}
