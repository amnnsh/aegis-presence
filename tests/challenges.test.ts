import test from "node:test";
import assert from "node:assert/strict";
import { challengeHint, createChallenges, GestureTracker, randomInt, livenessSignal } from "../lib/challenges.ts";
import { scoreDigits } from "../lib/digits.ts";
import type { ChallengeResult, FaceMetrics } from "../lib/types.ts";
const m = (timestamp: number, overrides: Partial<FaceMetrics> = {}): FaceMetrics => ({ timestamp, faceCount: 1, yaw: 0, blinkLeft: 0, blinkRight: 0, jawOpen: 0, mouthOpen: 0, points: [], ...overrides });
test("sessions include all three shuffled prompts and four random digits", () => {
  const signatures = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const c = createChallenges();
    assert.deepEqual(c.map(s => s.kind).sort(), ["blink", "digits", "head"]);
    assert.match(c.find(s => s.kind === "digits")!.digits!, /^\d{4}$/);
    signatures.add(JSON.stringify(c));
  }
  assert.ok(signatures.size > 1);
});
test("random ranges are checked", () => {
  assert.throws(() => randomInt(0)); assert.throws(() => randomInt(1.5));
  for (let i = 0; i < 50; i++) assert.ok(randomInt(3) < 3);
});
test("head prompt requires calibration, turn, AND return", () => {
  const tracker = new GestureTracker({ kind: "head", direction: "right" });
  for (let i = 0; i < 8; i++) assert.equal(tracker.update(m(i * 100)), null);
  for (let i = 8; i < 11; i++) assert.equal(tracker.update(m(i * 100, { yaw: .2 })), null);
  assert.equal(tracker.update(m(1100)), null); assert.equal(tracker.update(m(1200)), null);
  assert.equal(tracker.update(m(1300))?.status, "observed");
});
test("wrong head direction never completes", () => {
  const tracker = new GestureTracker({ kind: "head", direction: "left" });
  for (let i = 0; i < 8; i++) tracker.update(m(i * 100));
  for (let i = 8; i < 20; i++) assert.equal(tracker.update(m(i * 100, { yaw: .3 })), null);
});
test("two genuine open/closed/open cycles are needed for blinks", () => {
  const tracker = new GestureTracker({ kind: "blink" });
  tracker.update(m(0)); tracker.update(m(100, { blinkLeft: .9, blinkRight: .9 }));
  assert.equal(tracker.update(m(200)), null);
  tracker.update(m(400, { blinkLeft: .9, blinkRight: .9 }));
  assert.equal(tracker.update(m(500))?.status, "observed");
});
test("constant closed eyes and multiple faces cannot pass", () => {
  const tracker = new GestureTracker({ kind: "blink" });
  for (let i = 0; i < 20; i++) assert.equal(tracker.update(m(i * 100, { blinkLeft: .9, blinkRight: .9 })), null);
  assert.equal(tracker.update(m(2100, { faceCount: 2 })), null);
  assert.equal(tracker.unavailable().status, "unavailable");
});
test("without a microphone, mouth motion is partial, NEVER digit verification", () => {
  const tracker = new GestureTracker({ kind: "digits", digits: "1234" });
  tracker.update(m(0)); tracker.update(m(100, { jawOpen: .8 })); tracker.update(m(200));
  tracker.update(m(400, { jawOpen: .8 })); const result = tracker.update(m(500));
  assert.equal(result?.status, "partial"); assert.equal(result?.risk, 60); assert.match(result!.detail, /NOT verified/);
});
test("no completed gestures means unavailable liveness", () => assert.equal(livenessSignal([]).risk, null));
const gesture = (kind: "head" | "blink"): ChallengeResult => ({ kind, status: "observed", risk: 10, detail: "" });
test("mouth-only digits still contribute a fixed 60 to liveness", () => {
  const partial: ChallengeResult = { kind: "digits", status: "partial", risk: 60, detail: "" };
  const signal = livenessSignal([gesture("head"), gesture("blink"), partial]);
  assert.equal(signal.risk, 27); assert.match(signal.detail, /2\/2 head \/ blink/); assert.match(signal.detail, /unverified and contributes risk 60/);
  assert.equal(livenessSignal([partial]).risk, null);
});
test("recognized digits replace the fixed 60; wrong digits raise liveness risk", () => {
  const right = livenessSignal([gesture("head"), gesture("blink"), scoreDigits("4071", "four oh seven one")]);
  assert.equal(right.risk, 10); assert.match(right.detail, /4\/4 recognized on-device/);
  assert.equal(livenessSignal([gesture("head"), gesture("blink"), scoreDigits("4071", "four oh seven")]).risk, 20);
  const wrong = livenessSignal([gesture("head"), gesture("blink"), scoreDigits("4071", "nine two five three")]);
  assert.equal(wrong.risk, 32); assert.match(wrong.detail, /0\/4 recognized/);
});
test("digits heard but gestures skipped: digits count, missing gestures cost 60 each", () => {
  const signal = livenessSignal([scoreDigits("4071", "4 0 7 1")]);
  assert.equal(signal.risk, 43); assert.match(signal.detail, /0\/2 head \/ blink/);
});
test("an empty transcript is unavailable and costs 60, never a pass", () => {
  const none = scoreDigits("4071", "");
  assert.equal(none.status, "unavailable");
  assert.equal(livenessSignal([gesture("head"), gesture("blink"), none]).risk, 27);
});
test("the digits hint says truthfully whether the microphone is used", () => {
  assert.match(challengeHint({ kind: "digits", digits: "1234" }), /microphone is off/);
  assert.match(challengeHint({ kind: "digits", digits: "1234" }, true), /on this device/);
});
