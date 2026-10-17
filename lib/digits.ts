import type { ChallengeResult } from "./types.ts";

/** PURE transcript handling for the spoken-digit prompt. */
const WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", won: "1", two: "2", to: "2", too: "2", three: "3", tree: "3",
  four: "4", for: "4", five: "5", six: "6", seven: "7", eight: "8", ate: "8", nine: "9",
};

/** Lowercase, map number words and common mishearings to digits, keep raw digits, drop everything else. */
export function normalizeDigits(transcript: string): string {
  return transcript.toLowerCase().split(/[^a-z0-9]+/).map(token => /^\d+$/.test(token) ? token : WORDS[token] ?? "").join("");
}

/** Digits heard in the expected ORDER (longest common subsequence), minus one for every extra digit.
 * Without the penalty, a long recording of many digits would contain any four-digit prompt.
 */
export function matchedDigits(expected: string, heard: string): number {
  const row = new Array<number>(heard.length + 1).fill(0);
  for (let i = 1; i <= expected.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= heard.length; j++) {
      const above = row[j];
      row[j] = expected[i - 1] === heard[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = above;
    }
  }
  return Math.max(0, row[heard.length] - Math.max(0, heard.length - expected.length));
}

/** 4/4 -> risk 10, 3/4 -> 40, fewer -> 75, nothing heard -> unavailable. Speech content only: it says nothing about WHO spoke. */
export function scoreDigits(expected: string, transcript: string): ChallengeResult {
  const heard = normalizeDigits(transcript);
  if (!heard) return { kind: "digits", status: "unavailable", risk: null, heard: "", matched: 0, detail: "Audio was received, but no digits were recognized. Try reading each digit separately at your normal volume, then pause. Missing evidence is not a pass." };
  const matched = matchedDigits(expected, heard);
  const risk = matched >= expected.length ? 10 : matched === expected.length - 1 ? 40 : 75;
  return { kind: "digits", status: "observed", risk, heard, matched,
    detail: `${matched}/${expected.length} prompted digits recognized by an on-device speech model. This checks the words, not the speaker's identity.` };
}

