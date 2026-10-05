# Aegis: two-minute demo

**Rehearsal:** run the real production build on the presentation machine, load its model once, and test the camera in the actual browser. Keep the same tab visible during a live session; hiding it cancels capture. Enlarge the browser to a readable size. Leave optional colors off unless the presenter is comfortable with them. Have `/verify/?mode=lab` ready as the explicitly simulated fallback, not as a disguised live detection demo.

| Time | Screen / action | Spoken script |
| --- | --- | --- |
| 0:00-0:20 | Landing page. Point to the problem statistics and their sources. | "A convincing face is no longer enough. Entrust reported a forty-percent rise in injection attacks. In Pindrop's survey, seventy-four percent encountered or suspected a deepfake. Gartner forecast declining trust in standalone checks. These describe the threat, not our accuracy." |
| 0:20-1:05 | Start verification. Give consent, enable webcam, and follow the actual randomized prompts. The order and direction vary. Read the displayed digits. Enable the optional slow-color check only when rehearsed and comfortable; otherwise point out the opt-in and skip. | "Aegis asks for several kinds of evidence. Camera metadata is a weak source-integrity hint. Local MediaPipe landmarks look for a head turn and two blinks. The digits are random, but today we detect mouth movement, not the spoken words. An optional slow-color test compares the screen with cheek-color changes. It is a lighting heuristic, not proof of presence. Frames stay in this tab; there is no recording or microphone." |
| 1:05-1:20 | Result. Show provenance labels and open the scoring formula. | "The important result is honest uncertainty. Missing checks do not become passes. Deepfake and synchronization models are simulated and excluded from live scoring, so a live session cannot approve. The camera has stopped." |
| 1:20-1:42 | Click all four result comparison buttons. Point to risk and decision. | "This attack lab uses fictional fixtures: normal, seven, approve; replay, seventy-three, reject; virtual camera, thirty-one, step-up; deepfake, sixty-seven, reject. We did not detect these attacks. We are demonstrating an explainable policy." |
| 1:42-1:53 | Activity page. Filter Reject; inspect one row. | "The mock dashboard shows how a reviewer could understand an attempt. These rows are sample data, not captured users or a real administrator system." |
| 1:53-2:00 | Return to product headline or end on result. | "Next: a trusted backend, validated models, and accessible step-up. Our principle: make uncertainty visible before granting trust." |

## When the camera or model fails

Say: **"This browser could not supply the live evidence. The product marks it unavailable and requests step-up. I'll now show the separately labeled fixture demonstration."** Click Continue without camera or Get step-up result, then use the attack lab. Do not quietly substitute a recording or describe fixture outcomes as measured detections.

A twenty-five-second challenge timeout can overrun the live segment. During rehearsal, learn the on-screen prompts and transitions; during judging, explicitly skip a stalled check and show the resulting missing-evidence policy. Do not hide the skip or promise that every device supports the model.

## Claims to avoid

Do not say "deepfakes detected with X% accuracy," "these signals are independent," "camera metadata proves authenticity," "we recognized your spoken digits," "production ready," or "the dashboard contains real attempts." No such result is established by this prototype.
