import test from "node:test";
import assert from "node:assert/strict";
import { matchedDigits, normalizeDigits, scoreDigits } from "../lib/digits.ts";

test("number words, mishearings, and raw digits normalize to digits", () => {
  assert.equal(normalizeDigits("four oh seven one"), "4071");
  assert.equal(normalizeDigits("for zero seven won"), "4071");
  assert.equal(normalizeDigits(" 4, 0, 7, 1."), "4071");
  assert.equal(normalizeDigits("4071"), "4071");
  assert.equal(normalizeDigits("Tree, ate, TOO, o; nine-six five"), "3820965");
});
test("garbage and silence normalize to nothing", () => {
  for (const text of ["", "hello world", "[BLANK_AUDIO]", "Thank you.", "(music)"]) assert.equal(normalizeDigits(text), "");
});
test("matching follows order and penalizes extra digits", () => {
  assert.equal(matchedDigits("4071", "4071"), 4);
  assert.equal(matchedDigits("4071", "407"), 3);
  assert.equal(matchedDigits("4071", "4091"), 3);
  assert.equal(matchedDigits("4071", "1704"), 1);
  assert.equal(matchedDigits("4071", "40719"), 3);
  assert.equal(matchedDigits("4071", "0123456789"), 0); // a long digit recording contains every prompt as a subsequence
  assert.equal(matchedDigits("4071", ""), 0);
});
test("scores: 4/4 -> 10, 3/4 -> 40, fewer -> 75, nothing -> unavailable", () => {
  const full = scoreDigits("4071", "Four, oh, seven, one.");
  assert.deepEqual([full.status, full.risk, full.heard, full.matched], ["observed", 10, "4071", 4]);
  assert.deepEqual([scoreDigits("4071", "four zero seven").risk, scoreDigits("4071", "nine two five three").risk], [40, 75]);
  assert.equal(scoreDigits("4071", "nine two five three").status, "observed");
  const none = scoreDigits("4071", "hello there");
  assert.deepEqual([none.status, none.risk, none.heard], ["unavailable", null, ""]);
});
test("the transcript never appears in the detail text that may be sent to the server", () => {
  assert.doesNotMatch(scoreDigits("4071", "nine two five three").detail, /9253|nine/);
});
