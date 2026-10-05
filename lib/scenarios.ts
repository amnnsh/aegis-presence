import type { ScenarioId, Signal } from "./types.ts";
import { evaluateRisk, SIGNALS } from "./risk.ts";

// SIMULATED: curated examples, not recordings, measurements, detections, or benchmarks.
export const SCENARIOS: { id: ScenarioId; title: string; description: string; scores: number[]; details: string[] }[] = [
  { id: "normal", title: "Normal user", description: "Consistent signals across all layers.", scores: [8, 5, 9, 7, 5],
    details: ["Fixture: ordinary camera metadata.", "Fixture: requested gestures match.", "Fixture: plausible light response.", "Simulated, real model in the full build.", "Simulated, real model in the full build."] },
  { id: "replay", title: "Replayed video", description: "A recording cannot follow this session.", scores: [35, 94, 88, 62, 82],
    details: ["Fixture: unusual frame cadence.", "Fixture: random challenges not followed.", "Fixture: no timely color response.", "Simulated replay artifacts; real model in the full build.", "Simulated timing mismatch; real model in the full build."] },
  { id: "virtual", title: "Virtual-camera feed", description: "Ambiguous device evidence needs review.", scores: [82, 12, 24, 24, 16],
    details: ["Fixture: a virtual-camera label. Legitimate virtual cameras exist.", "Fixture: gestures appear responsive.", "Fixture: modest color response.", "Simulated, real model in the full build.", "Simulated, real model in the full build."] },
  { id: "deepfake", title: "Deepfake sample", description: "Model placeholders flag synthetic evidence.", scores: [24, 62, 70, 95, 93],
    details: ["Fixture: metadata appears ordinary.", "Fixture: inconsistent facial motion.", "Fixture: weak challenge response.", "Simulated synthetic artifacts; real model in the full build.", "Simulated lip/audio mismatch; real model in the full build."] },
];
export function scenarioResult(id: ScenarioId) {
  const scenario = SCENARIOS.find(s => s.id === id)!;
  const signals: Signal[] = SIGNALS.map((s, i) => ({ id: s.id, risk: scenario.scores[i], provenance: "simulated", detail: scenario.details[i] }));
  return evaluateRisk(signals, "simulation");
}
export const MOCK_ATTEMPTS = [
  ["AX-1048", "14:42:18", "normal"], ["AX-1047", "14:39:05", "deepfake"],
  ["AX-1046", "14:35:41", "virtual"], ["AX-1045", "14:31:22", "normal"],
  ["AX-1044", "14:27:10", "replay"], ["AX-1043", "14:22:49", "normal"],
  ["AX-1042", "14:18:03", "virtual"], ["AX-1041", "14:14:26", "normal"],
  ["AX-1040", "14:09:12", "deepfake"], ["AX-1039", "14:03:50", "replay"],
  ["AX-1038", "13:58:34", "normal"], ["AX-1037", "13:52:09", "normal"],
].map(([id, time, scenario]) => ({ id, time, scenario: scenario as ScenarioId, result: scenarioResult(scenario as ScenarioId) }));
