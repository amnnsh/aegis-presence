import type { AttackCheck, AttackCheckId, AttackIndicator, Signal } from "./types.ts";

/** Fusion is deliberately conservative: one anomaly can prompt review, two strong ones can reject. */
export function fuseAttack(id: AttackCheckId, indicators: AttackIndicator[]): AttackCheck {
  const strong = indicators.filter(item => item.ran && item.fired && item.kind === "strong").length;
  const supporting = indicators.filter(item => item.ran && item.fired && item.kind === "supporting").length;
  const verdict = strong >= 2 ? "likely" : strong >= 1 || supporting >= 2 ? "suspected" : "not_enough_evidence";
  return { id, verdict, indicators };
}

/** Gesture and screen response can suggest replay, but missing or skipped checks never do. */
export function replayCheck(liveness: Signal, reflection: Signal): AttackCheck {
  const measured = (signal: Signal) => signal.risk !== null && Number.isFinite(signal.risk) &&
    signal.provenance !== "unavailable" && signal.provenance !== "simulated";
  return fuseAttack("screen_replay", [
    { id: "challenge_failure", kind: "strong", ran: measured(liveness), fired: measured(liveness) && liveness.risk! >= 80,
      detail: "Active challenges were inconsistent with a live response; lighting, accessibility, or tracking can also cause this." },
    { id: "light_mismatch", kind: "strong", ran: measured(reflection), fired: measured(reflection) && reflection.risk! >= 80,
      detail: "The face did not follow the screen-light sequence; ambient light and camera processing can also cause this." }
  ]);
}

/** Attack checks can only tighten the illustrative decision, never authorize a session. */
export function applyAttackPolicy<T extends { decision: "approve" | "step-up" | "reject"; reasons: string[]; explanation: string; attackChecks?: AttackCheck[] }>(
  result: T, checks: AttackCheck[], mode: "live" | "simulation"
): T {
  if (mode !== "live") return { ...result, attackChecks: checks };
  const likely = checks.find(check => check.verdict === "likely");
  const suspected = checks.find(check => check.verdict === "suspected");
  const reasons = [...result.reasons];
  let decision = result.decision;
  let explanation = result.explanation;
  if (likely) {
    decision = "reject";
    reasons.push(`${likely.id === "virtual_camera" ? "Virtual camera" : "Screen replay"}: multiple strong local indicators were observed. These are not hardware attestation or proof of fraud.`);
    explanation = "Multiple local attack indicators were observed. Stop this attempt and use a trusted alternative; this is not proof of fraud.";
  } else if (suspected && decision === "approve") {
    decision = "step-up";
    reasons.push("An attack check needs review before this session can continue.");
  }
  return { ...result, decision, reasons, explanation, attackChecks: checks };
}
