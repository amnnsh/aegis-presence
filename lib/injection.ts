import type { DeviceEvidence, Signal } from "./types.ts";

/** Metadata is spoofable. These flags are troubleshooting heuristics, NOT attestation. */
export function inspectCamera(device: DeviceEvidence | null): Signal {
  if (!device) return { id: "injection", risk: null, provenance: "unavailable", detail: "Camera permission or metadata was unavailable." };
  let risk = 8;
  const flags: string[] = [];
  if (!device.label.trim()) { risk += 20; flags.push("camera label unavailable"); }
  if (/\b(obs|virtual|manycam|xsplit|snap camera|droidcam|ndi)\b/i.test(device.label)) {
    risk += 62; flags.push("virtual-camera-like label (can be legitimate)");
  }
  if (!device.width || !device.height) { risk += 15; flags.push("resolution not reported"); }
  else if (device.width < 320 || device.height < 240) { risk += 20; flags.push("low capture resolution"); }
  if (device.declaredFps !== null && (device.declaredFps < 12 || device.declaredFps > 90)) {
    risk += 18; flags.push("unusual declared frame rate");
  }
  if (device.observedFps !== null && device.observedFps < 10) { risk += 15; flags.push("low observed frame cadence"); }
  if (device.observedFps !== null && device.declaredFps && Math.abs(device.observedFps - device.declaredFps) / device.declaredFps > 0.6) {
    risk += 10; flags.push("observed / declared cadence differs");
  }
  return { id: "injection", risk: Math.min(95, risk), provenance: "heuristic",
    detail: `${flags.length ? flags.join("; ") : "No configured metadata anomaly found"}. Browser metadata cannot authenticate the camera; lighting, load, and legitimate software can trigger flags.` };
}
