import type { Decision, DecisionResult, Signal, SignalId } from "./types.ts";

export const SIGNALS: { id: SignalId; title: string; weight: number; short: string }[] = [
  { id: "injection", title: "Camera integrity", weight: 20, short: "Device metadata" },
  { id: "liveness", title: "Active liveness", weight: 30, short: "Random gestures" },
  { id: "reflection", title: "Light response", weight: 15, short: "Screen / face response" },
  { id: "artifacts", title: "Deepfake artifacts", weight: 20, short: "Model placeholder" },
  { id: "sync", title: "Audio-visual sync", weight: 15, short: "Model placeholder" },
];
export const POLICY = { stepUp: 30, reject: 65, unknownRisk: 60, injectionVeto: 70 } as const;

export function finiteRisk(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Illustrative policy, NOT a calibrated fraud probability or an authorization boundary.
 * Live mode excludes ALL simulated scores. Missing/invalid evidence costs a fixed 60.
 * Never renormalize away a missing weight. Never trust client-side decisions in production.
 */
export function evaluateRisk(input: Signal[], mode: "live" | "simulation"): DecisionResult {
  const signals = SIGNALS.map(({ id }) => {
    const matches = input.filter(s => s.id === id);
    const s = matches.length === 1 ? matches[0] : undefined;
    if (!s || !finiteRisk(s.risk) || s.provenance === "unavailable") {
      return { id, risk: null, provenance: "unavailable", detail: s?.detail || "No usable evidence; step-up required." } as Signal;
    }
    return { ...s };
  });
  const contributions = SIGNALS.map(({ id, weight }) => {
    const s = signals.find(item => item.id === id)!;
    const usable = finiteRisk(s.risk) && s.provenance !== "unavailable" &&
      (mode === "simulation" || s.provenance === "observed" || s.provenance === "heuristic");
    return { id, weight, usedRisk: usable ? s.risk! : POLICY.unknownRisk, substituted: !usable };
  });
  const rawRisk = contributions.reduce((sum, item) => sum + item.usedRisk * item.weight / 100, 0);
  const risk = Math.round(rawRisk);
  const coverage = contributions.filter(s => !s.substituted).reduce((sum, s) => sum + s.weight, 0);
  const camera = contributions.find(s => s.id === "injection")!;
  const flagged = contributions.filter(s => !s.substituted && s.usedRisk >= 70);
  const reasons: string[] = [];
  let decision: Decision = rawRisk >= POLICY.reject ? "reject" : rawRisk >= POLICY.stepUp ? "step-up" : "approve";
  if (decision === "approve" && camera.usedRisk >= POLICY.injectionVeto) {
    decision = "step-up";
    reasons.push("Camera metadata needs review; a device label alone cannot prove an attack.");
  }
  if (coverage < 100) {
    reasons.push(`Only ${coverage}/100 of policy weight has usable ${mode === "live" ? "local" : "fixture"} evidence. Missing or excluded inputs use risk 60, not zero.`);
    if (decision === "approve") decision = "step-up";
  }
  if (mode === "live") {
    // Conservative demo guard: a failed gesture, low light, or a missing model is NOT proof of fraud.
    decision = rawRisk >= POLICY.reject && flagged.length >= 2 && coverage >= 50 ? "reject" : "step-up";
    reasons.push("Live sessions cannot approve: digit recognition, deepfake detection, and audio-visual synchronization are not implemented.");
    reasons.push("Scores are uncalibrated browser heuristics. This is not identity verification or an access-control decision.");
  } else {
    reasons.push("Every input in this attack-lab session is a deterministic, simulated fixture. No attack was executed or detected.");
  }
  const concerning = contributions.filter(s => !s.substituted && s.usedRisk >= 60)
    .sort((a, b) => b.usedRisk * b.weight - a.usedRisk * a.weight);
  for (const s of concerning.slice(0, 2)) {
    reasons.push(`${SIGNALS.find(m => m.id === s.id)!.title}: ${s.usedRisk}/100 risk. ${signals.find(m => m.id === s.id)!.detail}`);
  }
  const explanation = decision === "approve"
    ? "This synthetic normal-user example falls below the demo threshold. It does not establish anyone's identity."
    : decision === "reject"
      ? (mode === "simulation" ? "Several fixture signals exceed the demo risk threshold; the illustrative policy rejects this scenario." : "Multiple local heuristics raised risk. Stop this attempt and use a trusted alternative; this is not proof of fraud.")
      : (mode === "live" ? "Some evidence is missing or unverified. Use a trusted second factor or a human-assisted check; this prototype performs neither." : "The fixture has ambiguous evidence. The illustrative policy requests an additional verification method.");
  return { decision, risk, mode, coverage, explanation, reasons, signals, contributions };
}
