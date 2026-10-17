import test from "node:test";
import assert from "node:assert/strict";

import {
  BLINK,
  challengeHint,
  createPlan,
  createTracker,
  CuedBlinkTracker,
  HeadSequenceTracker,
  livenessSignal,
  randomInt
} from "../lib/challenges.ts";
import { describePose, extractHeadPose } from "../lib/head-pose.ts";
import { scoreDigits } from "../lib/digits.ts";

import type {
  Challenge,
  ChallengeResult,
  FaceMetrics,
  HeadMove
} from "../lib/types.ts";

// ------------------------------------------
// SYNTHETIC STREAMS
// ------------------------------------------

const m = (timestamp: number, overrides: Partial<FaceMetrics> = {}): FaceMetrics => ({
  timestamp,
  faceCount: 1,
  yaw: 0,
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  blinkLeft: 0,
  blinkRight: 0,
  jawOpen: 0,
  mouthOpen: 0,
  points: [],
  ...overrides
});

/** Raw pose for a move, using the documented sign convention (+yaw = user's left, +pitch = down). */
const POSE: Record<HeadMove | "center", { yawDeg: number; pitchDeg: number }> = {
  center: { yawDeg: 0, pitchDeg: 0 },
  left: { yawDeg: 25, pitchDeg: 0 },
  right: { yawDeg: -25, pitchDeg: 0 },
  up: { yawDeg: 0, pitchDeg: -20 },
  down: { yawDeg: 0, pitchDeg: 20 }
};

/** Drives a tracker with 100 ms frames and records the results. */
class Stream {
  t = 0;
  results: ChallengeResult[] = [];
  tracker: { update(m: FaceMetrics): ChallengeResult | null };
  constructor(tracker: { update(m: FaceMetrics): ChallengeResult | null }, start = 0) {
    this.tracker = tracker;
    this.t = start;
  }
  frame(overrides: Partial<FaceMetrics> = {}, step = 100) {
    const result = this.tracker.update(m(this.t, overrides));
    if (result) this.results.push(result);
    this.t += step;
    return result;
  }
  hold(pose: keyof typeof POSE, frames: number) {
    for (let i = 0; i < frames; i++) this.frame(POSE[pose]);
  }
  /** Turn toward `move`, hold, and come back to center. */
  gesture(move: HeadMove) {
    this.hold(move, 4);
    this.hold("center", 3);
  }
}

const sequence = (...moves: HeadMove[]): Extract<Challenge, { kind: "head_sequence" }> =>
  ({ id: "c_head", kind: "head_sequence", moves });

const calibrated = (moves: HeadMove[]) => {
  const tracker = new HeadSequenceTracker(sequence(...moves), 0, 0);
  const s = new Stream(tracker);
  s.hold("center", 8);
  return { tracker, s };
};

// ------------------------------------------
// LOCAL PLAN
// ------------------------------------------

test("local plan matches the server shape with fresh randomness", () => {
  const seen = new Set<HeadMove>();
  const signatures = new Set<string>();

  for (let i = 0; i < 300; i++) {
    const plan = createPlan();
    assert.equal(plan.challenges.length, 3);
    assert.equal(plan.pulse_hold_ms, 12000);
    assert.deepEqual(plan.challenges.map(c => c.kind).sort(), ["cued_blink", "digits", "head_sequence"]);
    assert.equal(new Set(plan.challenges.map(c => c.id)).size, 3);
    for (const c of plan.challenges) {
      assert.match(c.id, /^c_[0-9a-f]{8}$/);
      if (c.kind === "head_sequence") {
        assert.equal(c.moves.length, 3);
        for (let k = 1; k < c.moves.length; k++) assert.notEqual(c.moves[k], c.moves[k - 1], "immediate repeat");
        c.moves.forEach(move => seen.add(move));
      } else if (c.kind === "cued_blink") {
        assert.equal(c.cue_offsets_ms.length, 3);
        c.cue_offsets_ms.forEach((offset, k) => {
          const gap = offset - (k ? c.cue_offsets_ms[k - 1] : 0);
          assert.ok(gap >= 1500 && gap <= 4000, `gap ${gap}`);
        });
      } else {
        assert.match(c.digits, /^\d{4}$/);
      }
    }
    signatures.add(JSON.stringify(plan.challenges.map(c => c.kind === "head_sequence" ? c.moves : c.kind)));
  }

  assert.deepEqual([...seen].sort(), ["down", "left", "right", "up"]);
  assert.ok(signatures.size > 20);
});

test("random ranges are checked", () => {
  assert.throws(() => randomInt(0));
  assert.throws(() => randomInt(1.5));
  for (let i = 0; i < 50; i++) assert.ok(randomInt(3) < 3);
});

// ------------------------------------------
// HEAD POSE MATH
// ------------------------------------------

/** Column-major 4x4 from a 3x3 row-major rotation. */
const columnMajor = (r: number[][]) => [
  r[0][0], r[1][0], r[2][0], 0,
  r[0][1], r[1][1], r[2][1], 0,
  r[0][2], r[1][2], r[2][2], 0,
  0, 0, -50, 1
];
const rad = (deg: number) => deg * Math.PI / 180;
const rotY = (deg: number) => [[Math.cos(rad(deg)), 0, Math.sin(rad(deg))], [0, 1, 0], [-Math.sin(rad(deg)), 0, Math.cos(rad(deg))]];
const rotX = (deg: number) => [[1, 0, 0], [0, Math.cos(rad(deg)), -Math.sin(rad(deg))], [0, Math.sin(rad(deg)), Math.cos(rad(deg))]];
/** Where the canonical face's nose axis (+Z) points after rotation r. */
const nose = (r: number[][]) => [r[0][2], r[1][2], r[2][2]];

test("matrix decomposition: nose toward camera +X is positive yaw, nose toward +Y is negative pitch", () => {
  // MediaPipe metric space: +X = image right of the unmirrored frame (the user's LEFT), +Y = up, +Z = toward camera.
  const turnedLeft = rotY(20);
  assert.ok(nose(turnedLeft)[0] > 0);
  const left = extractHeadPose(columnMajor(turnedLeft))!;
  assert.ok(Math.abs(left.yawDeg - 20) < 1e-9 && Math.abs(left.pitchDeg) < 1e-9);
  assert.match(describePose(left.yawDeg, left.pitchDeg), /user's LEFT/);

  const lookingUp = rotX(-15);
  assert.ok(nose(lookingUp)[1] > 0);
  const up = extractHeadPose(columnMajor(lookingUp))!;
  assert.ok(Math.abs(up.pitchDeg + 15) < 1e-9 && Math.abs(up.yawDeg) < 1e-9);
  assert.match(describePose(up.yawDeg, up.pitchDeg), /pitch -15\.0° \(user's UP\)/);

  // Scale (a similarity transform) does not change the angles.
  const scaled = columnMajor(rotY(-30)).map((v, i) => i < 12 ? v * 1.7 : v);
  assert.ok(Math.abs(extractHeadPose(scaled)!.yawDeg + 30) < 1e-9);
  assert.equal(extractHeadPose([1, 2, 3]), null);
});

// ------------------------------------------
// HEAD SEQUENCE
// ------------------------------------------

test("sequence completes only when moves follow the plan in order", () => {
  const { tracker, s } = calibrated(["down", "left", "up"]);
  assert.deepEqual(tracker.cue, { type: "arrow", move: "down", step: 0, total: 3, wrong: false });

  s.gesture("down");
  assert.match(tracker.progress, /Move 2 of 3: Turn your head to your LEFT/);
  s.gesture("left");
  s.gesture("up");

  const [result] = s.results;
  assert.equal(s.results.length, 1);
  assert.equal(result.status, "observed");
  assert.equal(result.risk, 10);
  assert.equal(result.wrongDirection, 0);
  assert.deepEqual(result.moves!.map(x => x.move), ["down", "left", "up"]);
  for (const x of result.moves!) assert.ok(x.cue_ts <= x.onset_ts && x.onset_ts <= x.done_ts);

  const responses = tracker.events.filter(e => e.type === "response");
  assert.deepEqual(responses.map(e => [e.payload.index, e.payload.move]), [[0, "down"], [1, "left"], [2, "up"]]);
  assert.equal(tracker.events.filter(e => e.type === "cue").length, 3);
  assert.equal(tracker.events[0].type, "challenge_start");
});

test("moves performed out of order do not advance the sequence", () => {
  const { tracker, s } = calibrated(["down", "left", "up"]);
  s.gesture("left");
  s.gesture("up");
  s.gesture("down");
  assert.equal(s.results.length, 0);
  assert.match(tracker.progress, /Move 2 of 3/);
  assert.equal(tracker.incomplete("timeout").wrongDirection, 2);
});

test("a wrong direction resets the step and is counted as an error", () => {
  const { tracker, s } = calibrated(["left", "up", "right"]);
  s.hold("right", 4);
  assert.match(tracker.progress, /Wrong direction/);
  assert.deepEqual(tracker.cue, { type: "arrow", move: "left", step: 0, total: 3, wrong: true });

  // Still turned: no repeat error, and turning the right way without returning first does not count.
  s.hold("right", 5);
  s.hold("left", 4);
  assert.match(tracker.progress, /Wrong direction/);

  s.hold("center", 3);
  s.gesture("left");
  s.gesture("up");
  s.gesture("right");

  const [result] = s.results;
  assert.equal(result.status, "observed");
  assert.equal(result.wrongDirection, 1);
  assert.equal(tracker.events.find(e => e.type === "challenge_end"), undefined);
  const final = tracker.end(result, s.t);
  assert.equal(final.id, "c_head");
  assert.equal(tracker.events.at(-1)!.payload.wrong_direction, 1);
});

test("return to center is required before the next arrow", () => {
  const { tracker, s } = calibrated(["left", "down", "right"]);
  s.hold("left", 10);
  assert.match(tracker.progress, /return to center/);
  assert.deepEqual(tracker.cue, { type: "center" });

  // Easing back to 10 degrees is not center.
  for (let i = 0; i < 10; i++) s.frame({ yawDeg: 10 });
  assert.equal(tracker.events.filter(e => e.type === "cue").length, 1);

  // One centered frame (passing through) is not enough either.
  s.frame({ yawDeg: 2 });
  s.frame({ yawDeg: 10 });
  assert.equal(tracker.events.filter(e => e.type === "cue").length, 1);

  s.hold("center", 2);
  assert.equal(tracker.events.filter(e => e.type === "cue").length, 2);
  assert.match(tracker.progress, /Move 2 of 3: Tilt your head DOWN/);
});

test("a turn must be held for three frames; single spikes do not count", () => {
  const { tracker, s } = calibrated(["right", "up", "left"]);
  for (let i = 0; i < 6; i++) { s.frame(POSE.right); s.frame(POSE.center); }
  s.frame(POSE.right); s.frame(POSE.right); s.frame(POSE.center);
  assert.match(tracker.progress, /Move 1 of 3: Turn your head to your RIGHT/);
  assert.equal(tracker.incomplete("timeout").wrongDirection, 0);
});

test("onset is the first frame beyond 5 degrees in the requested direction", () => {
  const { tracker, s } = calibrated(["up", "left", "down"]);
  const cue = tracker.events.find(e => e.type === "cue")!.client_ts_ms;
  s.hold("center", 3);
  const onset = s.t;
  s.frame({ pitchDeg: -7 });
  s.hold("up", 3);
  s.hold("center", 2);
  const response = tracker.events.find(e => e.type === "response")!;
  assert.equal(response.client_ts_ms, onset);
  assert.equal(response.payload.latency_ms, onset - cue);
});

test("a pre-recorded 'left then right' clip fails a 'down, left, up' plan", () => {
  const { tracker, s } = calibrated(["down", "left", "up"]);
  s.gesture("left");
  s.gesture("right");
  s.hold("center", 50);
  assert.equal(s.results.length, 0);

  const result = tracker.incomplete("timeout");
  assert.equal(result.moves!.length, 0);
  assert.equal(result.wrongDirection, 2);
  assert.notEqual(result.status, "observed");

  const signal = livenessSignal([result]);
  assert.ok(signal.risk! >= 70);
  assert.match(signal.detail, /did not follow the live prompts/);
});

test("two of three moves on timeout is partial credit", () => {
  const { tracker, s } = calibrated(["left", "right", "up"]);
  s.gesture("left");
  s.gesture("right");
  const result = tracker.incomplete("timeout");
  assert.equal(result.status, "partial");
  assert.equal(result.risk, 40);
  assert.match(result.detail, /2\/3 head moves followed \(left, right\) before the timeout/);
});

test("head calibration needs a steady, single, forward face with 3D pose", () => {
  const unstable = new Stream(new HeadSequenceTracker(sequence("left", "up", "right"), 0, 0));
  [0, -15, 3, -18, 2, -20, 1, -16].forEach(yawDeg => unstable.frame({ yawDeg }));
  assert.match((unstable.tracker as HeadSequenceTracker).progress, /calibrate/);

  const interrupted = new HeadSequenceTracker(sequence("left", "up", "right"), 0, 0);
  const s = new Stream(interrupted);
  s.hold("center", 7);
  s.frame({ faceCount: 2 });
  s.hold("center", 1);
  assert.match(interrupted.progress, /calibrate/);

  const blind = new HeadSequenceTracker(sequence("left", "up", "right"), 0, 0);
  const b = new Stream(blind);
  for (let i = 0; i < 40; i++) b.frame({ yawDeg: undefined, pitchDeg: undefined, rollDeg: undefined });
  assert.equal(blind.incomplete("timeout").status, "unavailable");
  assert.match(blind.incomplete("timeout").detail, /No usable single-face evidence/);
});

test("excessive sideways tilt does not count as a head turn", () => {
  const { tracker, s } = calibrated(["left", "up", "right"]);
  for (let i = 0; i < 8; i++) s.frame({ yawDeg: 25, rollDeg: 35 });
  assert.match(tracker.progress, /Move 1 of 3/);
});

test("events carry epoch timestamps from the supplied clock origin", () => {
  const tracker = createTracker(sequence("left", "up", "right"), 1000, 1_700_000_000_000);
  assert.equal(tracker.events[0].client_ts_ms, 1_700_000_001_000);
  assert.equal(tracker.events[0].challenge_id, "c_head");
  assert.deepEqual(tracker.takeEvents().map(e => e.type), ["challenge_start"]);
  assert.deepEqual(tracker.takeEvents(), []);
});

// ------------------------------------------
// CUED BLINK
// ------------------------------------------

const cued: Extract<Challenge, { kind: "cued_blink" }> = { id: "c_blink", kind: "cued_blink", cue_offsets_ms: [2000, 4500, 7000] };
// startedAt 0 + 1 s settle: cues at 3000, 5500 and 8000 ms.
const CUES = [3000, 5500, 8000];

/** 50 ms frames, eyes open except for 150 ms closures starting at each blink time. */
const runBlinks = (blinkStarts: number[], until = 11000) => {
  const tracker = new CuedBlinkTracker(cued, 0, 0);
  const s = new Stream(tracker);
  while (s.t <= until && s.results.length === 0) {
    const closed = blinkStarts.some(b => s.t >= b && s.t < b + 150);
    s.frame(closed ? { blinkLeft: 0.9, blinkRight: 0.85 } : { blinkLeft: 0.05, blinkRight: 0.05 }, 50);
  }
  return { tracker, s, result: s.results[0] };
};

test("blinks inside the cue windows count and log latencies", () => {
  const { tracker, result } = runBlinks(CUES.map(c => c + 300));
  assert.equal(result.status, "observed");
  assert.equal(result.risk, 10);
  assert.deepEqual(result.blinks!.map(b => b.latency), [300, 300, 300]);
  assert.deepEqual(tracker.events.filter(e => e.type === "cue").map(e => e.client_ts_ms), CUES);
  assert.deepEqual(tracker.events.filter(e => e.type === "response").map(e => [e.payload.index, e.payload.latency_ms]),
    [[0, 300], [1, 300], [2, 300]]);
});

test("blinks outside the windows are ignored, not failed", () => {
  // A spontaneous blink before any cue, one 1.8 s after cue 0, then two answered cues.
  const { result } = runBlinks([1200, CUES[0] + 1800, CUES[1] + 400, CUES[2] + 900]);
  assert.equal(result.status, "observed");
  assert.deepEqual(result.blinks!.map(b => b.latency), [400, 900]);
  assert.match(result.detail, /2\/3 ring cues answered/);
});

test("latency below 150 ms is rejected as anticipation", () => {
  const { result } = runBlinks(CUES.map(c => c + 100));
  assert.equal(result.status, "unavailable");
  assert.equal(result.risk, null);
  assert.equal(result.blinks!.length, 0);
  assert.match(result.detail, /3 blinks came under 150 ms/);
});

test("one answered cue is not enough; the tracker finishes after the last window", () => {
  const { s, result } = runBlinks([CUES[0] + 500]);
  assert.equal(result.status, "unavailable");
  assert.ok(s.t > CUES[2] + BLINK.windowMaxMs);
  assert.ok(s.t < 11000);
});

test("the ring shows only briefly after each cue", () => {
  const tracker = new CuedBlinkTracker(cued, 0, 0);
  tracker.update(m(2950));
  assert.equal(tracker.cue, null);
  tracker.update(m(3000));
  assert.deepEqual(tracker.cue, { type: "ring", index: 0 });
  tracker.update(m(3400));
  assert.deepEqual(tracker.cue, { type: "ring", index: 0 });
  tracker.update(m(3550));
  assert.equal(tracker.cue, null);
});

test("closed eyes held throughout never count as blinks", () => {
  const tracker = new CuedBlinkTracker(cued, 0, 0);
  const s = new Stream(tracker);
  for (let i = 0; i < 220; i++) s.frame({ blinkLeft: 0.9, blinkRight: 0.9 }, 50);
  assert.equal(s.results[0]?.status, "unavailable");
});

// ------------------------------------------
// DIGITS (mouth motion only)
// ------------------------------------------

test("without a microphone, mouth motion is partial, NEVER digit verification", () => {
  const tracker = createTracker({ id: "c_dig", kind: "digits", digits: "1234" }, 0, 0);
  tracker.update(m(0));
  tracker.update(m(100, { jawOpen: 0.8 }));
  tracker.update(m(200));
  tracker.update(m(400, { jawOpen: 0.8 }));
  const result = tracker.update(m(500))!;
  assert.equal(result.status, "partial");
  assert.equal(result.risk, 60);
  assert.match(result.detail, /NOT verified/);

  const final = tracker.end(result, 600, { digitsMatched: null });
  assert.equal(final.id, "c_dig");
  assert.deepEqual(tracker.events.map(e => e.type), ["challenge_start", "challenge_end"]);
  assert.equal(tracker.events[1].payload.mouth_cycles, 2);
});

test("the digits hint says truthfully whether the microphone is used", () => {
  const c: Challenge = { id: "c_dig", kind: "digits", digits: "1234" };
  assert.match(challengeHint(c), /microphone is off/);
  assert.match(challengeHint(c, true), /on this device/);
});

// ------------------------------------------
// LIVENESS SIGNAL
// ------------------------------------------

const head = (done: number, wrong = 0): ChallengeResult => ({
  kind: "head_sequence", status: done === 3 ? "observed" : "partial", risk: null, detail: "",
  moves: (["left", "up", "right"] as HeadMove[]).slice(0, done).map(move => ({ move, cue_ts: 0, onset_ts: 300, done_ts: 900 })),
  movesTotal: 3, wrongDirection: wrong
});
const blinks = (matched: number): ChallengeResult => ({
  kind: "cued_blink", status: matched >= 2 ? "observed" : "unavailable", risk: null, detail: "",
  blinks: Array.from({ length: matched }, (_, i) => ({ cue_ts: i, blink_ts: i + 350, latency: 350 })), cuesTotal: 3
});
const mouthOnly: ChallengeResult = { kind: "digits", status: "partial", risk: 60, detail: "" };

test("no completed challenge means unavailable liveness", () => {
  assert.equal(livenessSignal([]).risk, null);
  assert.equal(livenessSignal([mouthOnly]).risk, null);
  assert.equal(livenessSignal([head(1), blinks(1), mouthOnly]).provenance, "unavailable");
});

test("3/3 head moves and answered cues score 10 each; mouth-only digits stay at 60", () => {
  const signal = livenessSignal([head(3), blinks(2), mouthOnly]);
  assert.equal(signal.risk, 27);
  assert.match(signal.detail, /Head sequence: 3\/3 moves passed in order \(left, up, right\), risk 10/);
  assert.match(signal.detail, /Cued blinks: 2\/3 cues answered \(350 ms, 350 ms\), risk 10/);
  assert.match(signal.detail, /content unverified, counts as 60/);
});

test("2/3 head moves score 40; fewer are unavailable", () => {
  assert.equal(livenessSignal([head(2), blinks(3), mouthOnly]).risk, 37);
  const missing = livenessSignal([head(1), blinks(3), mouthOnly]);
  assert.equal(missing.risk, 43);
  assert.match(missing.detail, /1\/3 moves, unavailable/);
});

test("two wrong-direction head moves raise liveness risk to at least 70", () => {
  const right = scoreDigits("4071", "four oh seven one");
  assert.equal(livenessSignal([head(3, 1), blinks(3), right]).risk, 10);
  const flagged = livenessSignal([head(3, 2), blinks(3), right]);
  assert.equal(flagged.risk, 70);
  assert.match(flagged.detail, /2 wrong-direction head moves/);
});

test("recognized digits replace the fixed 60; wrong digits raise liveness risk", () => {
  const right = livenessSignal([head(3), blinks(3), scoreDigits("4071", "four oh seven one")]);
  assert.equal(right.risk, 10);
  assert.match(right.detail, /4\/4 recognized on-device/);
  assert.equal(livenessSignal([head(3), blinks(3), scoreDigits("4071", "four oh seven")]).risk, 20);
  assert.equal(livenessSignal([head(3), blinks(3), scoreDigits("4071", "nine two five three")]).risk, 32);
});

test("digits heard but gestures skipped: digits count, missing gestures cost 60 each", () => {
  assert.equal(livenessSignal([scoreDigits("4071", "4 0 7 1")]).risk, 43);
  const none = scoreDigits("4071", "");
  assert.equal(none.status, "unavailable");
  assert.equal(livenessSignal([head(3), blinks(3), none]).risk, 27);
});
