import type { DeviceEvidence, FaceMetrics, Point } from "./types.ts";

type Detector = {
  detectForVideo(video: HTMLVideoElement, timestamp: number): {
    faceLandmarks: Point[][];
    faceBlendshapes: { categories: { categoryName: string; score: number }[] }[];
  };
  close(): void;
};
interface Callbacks {
  device: (d: DeviceEvidence) => void;
  metrics: (m: FaceMetrics) => void;
  model: (status: "loading" | "ready" | "unavailable", message?: string) => void;
  interrupted: (message: string) => void;
}
export function cameraError(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Open the address-bar site controls, allow Camera, and try again. Check your operating system's camera privacy settings too.";
  if (name === "NotFoundError") return "No camera was found. Connect a webcam or use the clearly labeled attack lab instead.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy or unavailable. Close other video apps, then retry.";
  if (name === "OverconstrainedError") return "This camera could not provide the requested stream. Try another camera or browser.";
  return error instanceof Error ? error.message : "Camera could not start. Use HTTPS or localhost and open the site directly, not inside a preview frame.";
}

/** Owns every hardware/model resource. No persistence, uploads, audio, or recording APIs. */
export class BrowserVision {
  private callbacks: Callbacks;
  private cancelled = false;
  private stream: MediaStream | null = null;
  private detector: Detector | null = null;
  private video: HTMLVideoElement | null = null;
  private raf = 0;
  private frameCallback = 0;
  private lastInfer = -Infinity;
  private lastMediaTime = -1;
  private firstFrameAt = 0;
  private firstFrameNumber = 0;
  private lastDeviceAt = 0;
  private metadata: DeviceEvidence | null = null;
  constructor(callbacks: Callbacks) { this.callbacks = callbacks; }
  private interrupt = () => {
    if (this.cancelled) return;
    this.stop();
    this.callbacks.interrupted("The camera stopped or this tab was hidden. The session was cancelled and its evidence discarded. Start a fresh session.");
  };
  private onVisibility = () => { if (document.hidden) this.interrupt(); };
  private onPageHide = () => this.interrupt();
  async start(video: HTMLVideoElement): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires a secure context. Use http://localhost:3000 locally or the HTTPS deployed URL.");
    this.video = video;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onPageHide);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
    });
    // Permission dialogs can outlive navigation or cancellation. Close late streams immediately.
    if (this.cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    track.addEventListener("ended", this.interrupt);
    const settings = track.getSettings();
    this.metadata = { label: track.label || "", width: settings.width ?? null, height: settings.height ?? null,
      declaredFps: settings.frameRate ?? null, observedFps: null };
    this.callbacks.device({ ...this.metadata });
    video.srcObject = stream;
    await video.play();
    if (this.cancelled) return;
    this.measureFrames();
    this.callbacks.model("loading");
    try {
      // All assets are same-origin. The package is dynamically imported only after camera consent.
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      if (this.cancelled) return;
      const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      if (this.cancelled) return;
      const detector = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: "CPU" },
        runningMode: "VIDEO", numFaces: 2, outputFaceBlendshapes: true,
        minFaceDetectionConfidence: 0.55, minFacePresenceConfidence: 0.55, minTrackingConfidence: 0.55,
      });
      if (this.cancelled) { detector.close(); return; }
      this.detector = detector;
      this.callbacks.model("ready");
      this.raf = requestAnimationFrame(this.loop);
    } catch {
      if (!this.cancelled) this.callbacks.model("unavailable", "Face landmarks could not load. Run npm run assets, check model/WASM requests, or try a current desktop Chrome browser. No liveness pass is substituted.");
    }
  }
  private measureFrames(): void {
    const video = this.video;
    if (!video || typeof video.requestVideoFrameCallback !== "function" || this.cancelled) return;
    this.frameCallback = video.requestVideoFrameCallback((now, frame) => {
      if (this.cancelled) return;
      if (!this.firstFrameAt) { this.firstFrameAt = now; this.firstFrameNumber = frame.presentedFrames; }
      if (now - this.firstFrameAt > 1500 && now - this.lastDeviceAt > 1000 && this.metadata) {
        this.metadata.observedFps = Math.round((frame.presentedFrames - this.firstFrameNumber) * 1000 / (now - this.firstFrameAt) * 10) / 10;
        this.callbacks.device({ ...this.metadata }); this.lastDeviceAt = now;
      }
      this.measureFrames();
    });
  }
  private loop = (now: number) => {
    if (this.cancelled || !this.video || !this.detector) return;
    if (this.video.readyState >= 2 && now - this.lastInfer >= 100 && this.video.currentTime !== this.lastMediaTime) {
      this.lastInfer = now; this.lastMediaTime = this.video.currentTime;
      try {
        const result = this.detector.detectForVideo(this.video, now);
        const faceCount = result.faceLandmarks.length;
        const points = faceCount === 1 ? result.faceLandmarks[0] : [];
        const categories = result.faceBlendshapes?.[0]?.categories ?? [];
        const score = (name: string) => categories.find(c => c.categoryName === name)?.score ?? 0;
        let yaw = 0;
        if (points.length >= 468) {
          const left = points[33], right = points[263], nose = points[1];
          yaw = -(nose.x - (left.x + right.x) / 2) / Math.max(0.01, Math.abs(right.x - left.x));
        }
        this.callbacks.metrics({ timestamp: now, faceCount, yaw, points,
          blinkLeft: score("eyeBlinkLeft"), blinkRight: score("eyeBlinkRight"), jawOpen: score("jawOpen") });
      } catch {
        this.callbacks.model("unavailable", "Landmark inference stopped. The affected evidence is unavailable; this session cannot approve.");
        this.detector.close(); this.detector = null; return;
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };
  stop(): void {
    this.cancelled = true;
    cancelAnimationFrame(this.raf);
    if (this.frameCallback && this.video?.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.frameCallback);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onPageHide);
    this.stream?.getTracks().forEach(t => { t.removeEventListener("ended", this.interrupt); t.stop(); });
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.video = null;
    this.detector?.close(); this.detector = null;
    this.metadata = null;
  }
}
