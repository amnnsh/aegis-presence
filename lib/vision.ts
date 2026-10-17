
import type { RGBSample } from "./rppg.ts";
import type {
  DeviceEvidence,
  CameraProbes,
  FeedStats,
  FaceMetrics,
  Point
} from "./types.ts";

import { extractHeadPose } from "./head-pose.ts";
import { lockCamera, unlockCamera } from "./reflection.ts";
import { compareBackgroundPatches, dHash, detectLoop, frameTimingStats, frozenMedian, grayHash, hashDistance, nativeModeDecision, sensorResponseDecision, summarizeCapabilities } from "./injection.ts";
import type { FrameSample, HashedFrame } from "./injection.ts";
import type { CameraLockKey } from "./reflection.ts";

type Detector = {
  detectForVideo(
    video: HTMLVideoElement,
    timestamp: number
  ): {
    faceLandmarks: Point[][];
    faceBlendshapes: {
      categories: {
        categoryName: string;
        score: number;
      }[];
    }[];
    facialTransformationMatrixes: {
      rows: number;
      columns: number;
      data: number[];
    }[];
  };
  close(): void;
};

interface Callbacks {
  device: (d: DeviceEvidence) => void;
  metrics: (m: FaceMetrics) => void;
  model: (
    status: "loading" | "ready" | "unavailable",
    message?: string
  ) => void;
  interrupted: (message: string) => void;
}

export function cameraError(error: unknown): string {
  const name =
    error instanceof DOMException || error instanceof Error
      ? error.name
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera permission was denied. Open the address-bar site controls, allow Camera, and try again. Check your operating system's camera privacy settings too.";
  }

  if (name === "NotFoundError") {
    return "No camera was found. Connect a webcam or use the clearly labeled attack lab instead.";
  }

  if (name === "NotReadableError" || name === "AbortError") {
    return "The camera is busy or unavailable. Close other video apps, then retry.";
  }

  if (name === "OverconstrainedError") {
    return "This camera could not provide the requested stream. Try another camera or browser.";
  }

  return error instanceof Error
    ? error.message
    : "Camera could not start. Use HTTPS or localhost and open the site directly, not inside a preview frame.";
}

/**
 * Owns webcam, MediaPipe and pulse-sampling resources.
 * No video frames are persisted or uploaded.
 * Microphone handling remains in lib/audio.ts.
 */
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

  // Frame-timing sample for camera integrity: first ~3 s only, then one summary.
  private timingSamples: FrameSample[] | null = [];
  private timingCanvas: HTMLCanvasElement | null = null;

  private feedFrames: HashedFrame[] = [];
  private feedCanvas: HTMLCanvasElement | null = null;
  private backgroundCanvas: HTMLCanvasElement | null = null;
  private previousBackground: Uint8ClampedArray | null = null;
  private previousBackgroundCorner = -1;
  private previousFeedHash: Uint32Array | null = null;
  private frozenHistogram = new Uint32Array(1001);
  private frozenPairs = 0;
  private faceCenter: { x: number; y: number } | null = null;
  private modeProbeActive = false;
  private sensorRestore: (() => Promise<void>) | null = null;

  // rPPG sampling state
  private pulseSamples: RGBSample[] | null = null;
  private pulseCanvas: HTMLCanvasElement | null = null;
  private pulsePoints: Point[] = [];
  private pulseAnchors: { x: number; y: number; boxX: number; boxY: number }[] | null = null;
  private pulseFaceCount = 0;
  private pulseMotion = false;
  private previousNose: Point | null = null;

  // Inference performance
  private fast = false;
  private lastCost = 0;

  // Exposure / white balance switched to manual for the light check.
  private locked: CameraLockKey[] = [];

  constructor(callbacks: Callbacks) {
    this.callbacks = callbacks;
  }

  /** The live camera track, or null before start() and after stop(). */
  get videoTrack(): MediaStreamTrack | null {
    const track = this.stream?.getVideoTracks()[0] ?? null;
    return track?.readyState === "live" ? track : null;
  }

  private async restoreCameraMode(track: MediaStreamTrack): Promise<void> {
    let restored = false;
    try {
      if (track.readyState === "live") { await track.applyConstraints({
        width: { ideal: 640 }, height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 }, resizeMode: "crop-and-scale"
      } as MediaTrackConstraints); restored = true; }
    } catch { /* A stopped or limited camera may reject restoration. */ }
    if (restored) this.modeProbeActive = false;
    if (this.metadata && track.readyState === "live") {
      const settings = track.getSettings();
      this.metadata.width = settings.width ?? null;
      this.metadata.height = settings.height ?? null;
      this.metadata.declaredFps = settings.frameRate ?? null;
    }
  }

  /** A timeout cannot cancel applyConstraints; its late completion restores the camera again. */
  private async applyProbeConstraints(track: MediaStreamTrack, constraints: MediaTrackConstraints,
    timeoutMs: number, restore: () => Promise<void>): Promise<"accepted" | "rejected" | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const operation = track.applyConstraints(constraints);
    const result = await Promise.race<"accepted" | "rejected" | "timeout">([
      operation.then(() => "accepted" as const, () => "rejected" as const),
      new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), timeoutMs); })
    ]);
    if (timer) clearTimeout(timer);
    if (result === "timeout") operation.then(() => void restore(), () => void restore());
    return result;
  }

  private async probeNativeModes(track: MediaStreamTrack, deadline: number) {
    const unavailable = nativeModeDecision(0, 0);
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      !(navigator.mediaDevices.getSupportedConstraints?.() as Record<string, unknown> | undefined)?.resizeMode) return unavailable;
    let attempted = 0, supported = 0;
    this.modeProbeActive = true;
    const restore = () => this.restoreCameraMode(track);
    try {
      for (const [width, height] of [[320, 240], [640, 480], [1280, 720]]) {
        if (this.cancelled || track.readyState !== "live" || performance.now() >= deadline - 100) break;
        attempted++;
        const result = await this.applyProbeConstraints(track,
          { width: { exact: width }, height: { exact: height }, resizeMode: "none" } as MediaTrackConstraints,
          Math.min(1500, Math.max(100, deadline - performance.now())), restore);
        if (result === "timeout") break;
        if (result === "accepted") {
          const settings = track.getSettings();
          if (settings.width === width && settings.height === height) supported++;
        }
      }
    } finally { await restore(); }
    return nativeModeDecision(attempted, supported);
  }

  private async readLumas(video: HTMLVideoElement, count: number, deadline: number): Promise<number[]> {
    const values: number[] = [];
    if (typeof video.requestVideoFrameCallback !== "function") return values;
    const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 24;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return values;
    for (let sample = 0; sample < count && !this.cancelled; sample++) {
      const remaining = deadline - performance.now();
      if (remaining < 50) break;
      const frameReady = await new Promise<boolean>(resolve => {
        let id = 0;
        const timer = setTimeout(() => { video.cancelVideoFrameCallback?.(id); resolve(false); }, Math.min(500, remaining));
        id = video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(true); });
      });
      if (!frameReady || this.cancelled) break;
      ctx.drawImage(video, 0, 0, 32, 24);
      const rgba = ctx.getImageData(0, 0, 32, 24).data;
      let sum = 0;
      for (let i = 0; i < rgba.length; i += 4) sum += (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2]) / 256;
      values.push(sum / (32 * 24));
    }
    return values;
  }

  private async probeSensorResponse(track: MediaStreamTrack, video: HTMLVideoElement, deadline: number) {
    const unavailable = sensorResponseDecision(null, null, null, [], []);
    if (this.cancelled || performance.now() >= deadline - 800 || typeof track.getCapabilities !== "function") return unavailable;
    let capabilities: Record<string, unknown>;
    try { capabilities = track.getCapabilities() as Record<string, unknown>; } catch { return unavailable; }
    const settings = track.getSettings() as Record<string, unknown>;
    const controls = ["brightness", "exposureCompensation", "exposureTime"] as const;
    const control = controls.find(name => {
      if (name === "exposureTime" && !(Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes("manual"))) return false;
      const range = capabilities[name] as { min?: number; max?: number } | undefined;
      return range && Number.isFinite(range.min) && Number.isFinite(range.max) && range.max! > range.min! && typeof settings[name] === "number";
    });
    if (!control) return unavailable;
    const range = capabilities[control] as { min: number; max: number; step?: number };
    const original = settings[control] as number;
    const target = Math.min(range.max, Math.max(range.min, original + 0.35 * (range.max - range.min)));
    const requested = range.step && range.step > 0
      ? Math.min(range.max, range.min + Math.round((target - range.min) / range.step) * range.step) : target;
    if (requested === original) return unavailable;
    const baseline = await this.readLumas(video, 4, deadline);
    if (baseline.length < 4 || this.cancelled || performance.now() >= deadline - 600) return unavailable;
    const originalMode = settings.exposureMode;
    const restore = async () => {
      try {
        if (track.readyState === "live") await track.applyConstraints({ advanced: [{
          [control]: original,
          ...(control === "exposureTime" && typeof originalMode === "string" ? { exposureMode: originalMode } : {})
        }] } as MediaTrackConstraints);
      } catch { /* Another restoration attempt runs in stop(). */ }
    };
    this.sensorRestore = restore;
    try {
      const accepted = await this.applyProbeConstraints(track, { advanced: [{
        [control]: requested,
        ...(control === "exposureTime" ? { exposureMode: "manual" } : {})
      }] } as MediaTrackConstraints, Math.min(1000, Math.max(100, deadline - performance.now())), restore);
      if (accepted !== "accepted" || this.cancelled) return unavailable;
      const actual = (track.getSettings() as Record<string, unknown>)[control];
      if (typeof actual !== "number" || Math.abs(actual - requested) > 0.001) return unavailable;
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))));
      const after = await this.readLumas(video, 6, deadline);
      return sensorResponseDecision(control, requested, actual, baseline, after);
    } finally {
      await restore();
      const restored = track.readyState === "live" &&
        Math.abs(Number((track.getSettings() as Record<string, unknown>)[control]) - original) < 0.001;
      if (restored && this.sensorRestore === restore) this.sensorRestore = null;
    }
  }

  private async runHardwareProbes(track: MediaStreamTrack, video: HTMLVideoElement): Promise<void> {
    const deadline = performance.now() + 3000;
    let nativeModes = nativeModeDecision(0, 0);
    let sensorResponse = sensorResponseDecision(null, null, null, [], []);
    try {
      nativeModes = await this.probeNativeModes(track, deadline);
      sensorResponse = await this.probeSensorResponse(track, video, deadline);
    } catch { /* Unsupported controls supply no evidence. */ }
    if (this.cancelled || !this.metadata) return;
    const probes: CameraProbes = { nativeModes, sensorResponse };
    this.metadata.probes = probes;
    this.callbacks.device({ ...this.metadata });
  }

  feedStats(): FeedStats {
    const loop = detectLoop(this.feedFrames);
    return { frames: this.feedFrames.length, loopFound: loop.loopFound, loopPeriodMs: loop.periodMs,
      loopRunFrames: loop.runFrames, frozenIdenticalShare: frozenMedian(this.frozenHistogram), frozenPairs: this.frozenPairs };
  }

  /** Holds exposure and white balance where the camera supports it. Returns what was locked. */
  async lockForLight(): Promise<CameraLockKey[]> {
    if (this.cancelled) return [];
    const track = this.videoTrack;
    const keys = await lockCamera(track);
    if (this.cancelled) { await unlockCamera(track, keys); return []; }
    this.locked = keys;
    return keys;
  }

  /** Back to automatic exposure / white balance. Safe to call when nothing is locked. */
  unlockAfterLight(): Promise<void> {
    const keys = this.locked;
    this.locked = [];
    return unlockCamera(this.videoTrack, keys);
  }

  /**
   * Begin collecting facial skin-color samples.
   */
  startPulse(): void {
    this.pulseSamples = [];

    this.pulseCanvas = document.createElement("canvas");
    this.pulseCanvas.width = 320;
    this.pulseCanvas.height = 240;

    this.pulseAnchors = null;
    this.previousNose = null;
    this.pulseMotion = false;
  }

  /**
   * Stop collecting pulse samples and return RGB means.
   */
  stopPulse(): RGBSample[] {
    const samples = this.pulseSamples ?? [];

    this.pulseSamples = null;
    this.pulseCanvas = null;
    this.pulsePoints = [];
    this.pulseAnchors = null;
    this.previousNose = null;
    this.pulseMotion = false;

    return samples;
  }

  getPulseSamples(): RGBSample[] {
    return this.pulseSamples
      ? [...this.pulseSamples]
      : [];
  }

  /** Sample stable forehead and cheek RGB regions without storing video. */
  private samplePulse(t: number): void {
    const canvas = this.pulseCanvas;
    const video = this.video;
    const points = this.pulsePoints;

    if (
      !this.pulseSamples ||
      !canvas ||
      !video ||
      this.pulseFaceCount !== 1 ||
      points.length < 468
    ) {
      return;
    }

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true
    });

    if (!ctx) return;

    ctx.drawImage(video, 0, 0, 320, 240);

    const rawRegions = [
      {
        x: (points[109].x + points[338].x) / 2,
        y: (points[10].y + points[9].y) / 2
      },
      {
        x: (points[50].x + (points[101]?.x ?? points[50].x)) / 2,
        y: (points[50].y + (points[101]?.y ?? points[50].y)) / 2
      },
      {
        x: (points[280].x + (points[330]?.x ?? points[280].x)) / 2,
        y: (points[280].y + (points[330]?.y ?? points[280].y)) / 2
      }
    ];

    const patchSize = 16;
    const halfPatch = patchSize / 2;

    if (!this.pulseAnchors || this.pulseAnchors.length !== rawRegions.length) {
      this.pulseAnchors = rawRegions.map(point => {
        const x = Math.max(0, Math.min(320 - patchSize, point.x * 320 - halfPatch));
        const y = Math.max(0, Math.min(240 - patchSize, point.y * 240 - halfPatch));
        return { x, y, boxX: Math.round(x), boxY: Math.round(y) };
      });
    } else {
      for (let i = 0; i < rawRegions.length; i++) {
        const point = rawRegions[i];
        const targetX = Math.max(0, Math.min(320 - patchSize, point.x * 320 - halfPatch));
        const targetY = Math.max(0, Math.min(240 - patchSize, point.y * 240 - halfPatch));
        const anchor = this.pulseAnchors[i];
        const distance = Math.hypot(targetX - anchor.x, targetY - anchor.y);
        const alpha = distance < 1.5 ? 0.08 : 0.35;
        anchor.x += (targetX - anchor.x) * alpha;
        anchor.y += (targetY - anchor.y) * alpha;

        if (Math.abs(anchor.x - anchor.boxX) > 0.85) {
          anchor.boxX = Math.round(anchor.x);
        }
        if (Math.abs(anchor.y - anchor.boxY) > 0.85) {
          anchor.boxY = Math.round(anchor.y);
        }
      }
    }

    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (const anchor of this.pulseAnchors) {
      const pixels = ctx.getImageData(
        anchor.boxX,
        anchor.boxY,
        patchSize,
        patchSize
      ).data;

      for (let i = 0; i < pixels.length; i += 4) {
        const rr = pixels[i];
        const gg = pixels[i + 1];
        const bb = pixels[i + 2];

        if (
          Math.min(rr, gg, bb) < 5 ||
          Math.max(rr, gg, bb) > 250
        ) {
          continue;
        }

        r += rr;
        g += gg;
        b += bb;
        count++;
      }
    }

    if (count > 0) {
      this.pulseSamples.push({
        t,
        r: r / count,
        g: g / count,
        b: b / count,
        motion: this.pulseMotion
      });
    }
  }

  /**
   * Cancel verification when camera or tab is interrupted.
   */
  private interrupt = (): void => {
    if (this.cancelled) return;

    this.stop();

    this.callbacks.interrupted(
      "The camera stopped or this tab was hidden. The session was cancelled and its evidence discarded. Start a fresh session."
    );
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.interrupt();
    }
  };

  private onPageHide = (): void => {
    this.interrupt();
  };

  /**
   * Request webcam access and initialize MediaPipe.
   */
  async start(video: HTMLVideoElement): Promise<void> {
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error(
        "Camera access requires a secure context. Use http://localhost:3000 locally or the HTTPS deployed URL."
      );
    }

    this.video = video;

    document.addEventListener(
      "visibilitychange",
      this.onVisibility
    );

    window.addEventListener(
      "pagehide",
      this.onPageHide
    );

    const stream =
      await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 }
        }
      });

    if (this.cancelled) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    this.stream = stream;

    const track = stream.getVideoTracks()[0];

    track.addEventListener(
      "ended",
      this.interrupt
    );

    const settings = track.getSettings();

    // A count of video inputs only: deviceId and labels of other devices are never read.
    const videoInputCount = await navigator.mediaDevices.enumerateDevices()
      .then(devices => devices.filter(d => d.kind === "videoinput").length)
      .catch(() => null);

    if (this.cancelled) return;

    let capabilities: DeviceEvidence["capabilities"] = null;
    try {
      capabilities = summarizeCapabilities(track.getCapabilities?.());
    } catch {
      capabilities = null;
    }

    this.metadata = {
      label: track.label || "",
      width: settings.width ?? null,
      height: settings.height ?? null,
      declaredFps: settings.frameRate ?? null,
      observedFps: null,
      capabilities,
      videoInputCount,
      frameTiming: null,
      probes: null,
      feed: null
    };

    this.callbacks.device({ ...this.metadata });

    video.srcObject = stream;

    await video.play();

    if (this.cancelled) return;

    this.callbacks.model("loading");
    await this.runHardwareProbes(track, video);
    if (this.cancelled) return;

    // Hardware mode changes are complete before the cadence baseline begins.
    this.firstFrameAt = 0;
    this.firstFrameNumber = 0;
    this.measureFrames();

    try {
      const {
        FaceLandmarker,
        FilesetResolver
      } = await import("@mediapipe/tasks-vision");

      if (this.cancelled) return;

      const files =
        await FilesetResolver.forVisionTasks(
          "/mediapipe/wasm"
        );

      if (this.cancelled) return;

      const detector =
        await FaceLandmarker.createFromOptions(files, {
          baseOptions: {
            modelAssetPath:
              "/models/face_landmarker.task",
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numFaces: 2,
          outputFaceBlendshapes: true,

          // Enable 3D head orientation.
          outputFacialTransformationMatrixes: true,

          minFaceDetectionConfidence: 0.55,
          minFacePresenceConfidence: 0.55,
          minTrackingConfidence: 0.55
        });

      if (this.cancelled) {
        detector.close();
        return;
      }

      this.detector = detector;

      this.callbacks.model("ready");

      this.raf = requestAnimationFrame(
        this.loop
      );

    } catch {
      if (!this.cancelled) {
        this.callbacks.model(
          "unavailable",
          "Face landmarks could not load. Run npm run assets, check model/WASM requests, or try a current desktop Chrome browser."
        );
      }
    }
  }

  /**
   * Measure camera frame rate and sample rPPG data.
   */
  private measureFrames(): void {
    const video = this.video;

    if (
      !video ||
      typeof video.requestVideoFrameCallback !== "function" ||
      this.cancelled
    ) {
      return;
    }

    this.frameCallback =
      video.requestVideoFrameCallback((now, frame) => {
        if (this.cancelled) return;

        if (!this.firstFrameAt) {
          this.firstFrameAt = now;
          this.firstFrameNumber = frame.presentedFrames;
        }

        if (
          now - this.firstFrameAt > 1500 &&
          now - this.lastDeviceAt > 1000 &&
          this.metadata
        ) {
          this.metadata.observedFps =
            Math.round(
              (frame.presentedFrames -
                this.firstFrameNumber) *
              1000 /
              (now - this.firstFrameAt) *
              10
            ) / 10;

          this.callbacks.device({
            ...this.metadata
          });

          this.lastDeviceAt = now;
        }

        if (this.timingSamples) {
          this.sampleTiming(now, frame.mediaTime);
        }

        this.sampleFeed(frame.mediaTime * 1000);

        if (this.pulseSamples) {
          this.samplePulse(now);
        }

        this.measureFrames();
      });
  }

  /**
   * Hash a 16x12 grayscale thumbnail of the current frame and record its media time.
   * After ~3 s (at least 60 frames, at most 5 s) publish ONE summary through the device callback.
   */
  private sampleTiming(now: number, mediaTime: number): void {
    const video = this.video;
    const samples = this.timingSamples;
    if (!video || !samples) return;

    this.timingCanvas ??= Object.assign(document.createElement("canvas"), { width: 16, height: 12 });
    const ctx = this.timingCanvas.getContext("2d", { willReadFrequently: true });
    if (ctx && Number.isFinite(mediaTime)) {
      ctx.drawImage(video, 0, 0, 16, 12);
      samples.push({ mediaTimeMs: mediaTime * 1000, hash: grayHash(ctx.getImageData(0, 0, 16, 12).data) });
    }

    const elapsed = now - this.firstFrameAt;
    if ((elapsed >= 3000 && samples.length >= 60) || elapsed >= 5000) {
      this.timingSamples = null;
      this.timingCanvas = null;
      if (this.metadata) {
        this.metadata.frameTiming = frameTimingStats(samples);
        this.callbacks.device({ ...this.metadata });
      }
    }
  }

  /** One compact motion hash and one native-resolution corner patch per presented frame. */
  private sampleFeed(mediaTimeMs: number): void {
    const video = this.video;
    if (!video || !Number.isFinite(mediaTimeMs) || video.videoWidth < 32 || video.videoHeight < 32) return;
    this.feedCanvas ??= Object.assign(document.createElement("canvas"), { width: 17, height: 16 });
    const hashCtx = this.feedCanvas.getContext("2d", { willReadFrequently: true });
    if (!hashCtx) return;
    hashCtx.drawImage(video, 0, 0, 17, 16);
    const hash = dHash(hashCtx.getImageData(0, 0, 17, 16).data);
    if (this.feedFrames.length < 4000) this.feedFrames.push({ t: mediaTimeMs, hash });

    const w = video.videoWidth, h = video.videoHeight;
    const corners = [[0, 0], [w - 32, 0], [0, h - 32], [w - 32, h - 32]];
    let corner = 0;
    if (this.faceCenter) {
      let farthest = -Infinity;
      for (let i = 0; i < corners.length; i++) {
        const x = (corners[i][0] + 16) / w - this.faceCenter.x;
        const y = (corners[i][1] + 16) / h - this.faceCenter.y;
        const distance = x * x + y * y;
        if (distance > farthest) { farthest = distance; corner = i; }
      }
    }
    this.backgroundCanvas ??= Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
    const backgroundCtx = this.backgroundCanvas.getContext("2d", { willReadFrequently: true });
    if (!backgroundCtx) return;
    backgroundCtx.drawImage(video, corners[corner][0], corners[corner][1], 32, 32, 0, 0, 32, 32);
    const patch = new Uint8ClampedArray(backgroundCtx.getImageData(0, 0, 32, 32).data);
    if (this.previousBackground && this.previousBackgroundCorner === corner && this.previousFeedHash &&
      hashDistance(this.previousFeedHash, hash) > 0) {
      const compared = compareBackgroundPatches(this.previousBackground, patch);
      if (compared.eligible && compared.identicalShare !== null) {
        this.frozenPairs++;
        this.frozenHistogram[Math.round(compared.identicalShare * 1000)]++;
      }
    }
    this.previousBackground = patch;
    this.previousBackgroundCorner = corner;
    this.previousFeedHash = hash;
  }

  /**
   * Request faster inference during digit recognition.
   */
  setFast(fast: boolean): void {
    this.fast = fast;
  }

  /**
   * Main MediaPipe processing loop.
   */
  private loop = (now: number): void => {
    if (
      this.cancelled ||
      !this.video ||
      !this.detector
    ) {
      return;
    }

    const interval =
      this.fast && this.lastCost < 30
        ? 50
        : 100;

    if (
      this.video.readyState >= 2 &&
      now - this.lastInfer >= interval &&
      this.video.currentTime !== this.lastMediaTime
    ) {
      this.lastInfer = now;
      this.lastMediaTime = this.video.currentTime;

      try {
        const started = performance.now();

        const result =
          this.detector.detectForVideo(
            this.video,
            now
          );

        this.lastCost =
          performance.now() - started;

        const faceCount =
          result.faceLandmarks.length;

        const points =
          faceCount === 1
            ? result.faceLandmarks[0]
            : [];
        this.faceCenter = points.length ? {
          x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
          y: points.reduce((sum, point) => sum + point.y, 0) / points.length
        } : null;

        // Preserve pulse sampling.
        this.pulseFaceCount = faceCount;
        this.pulsePoints = points;

        const nose = points[1];

        this.pulseMotion = Boolean(
          nose &&
          this.previousNose &&
          Math.hypot(
            nose.x - this.previousNose.x,
            nose.y - this.previousNose.y
          ) > 0.012
        );

        this.previousNose =
          nose ? { ...nose } : null;

        // Facial expression scores.
        const categories =
          result.faceBlendshapes?.[0]?.categories ?? [];

        const score = (name: string) =>
          categories.find(
            category =>
              category.categoryName === name
          )?.score ?? 0;

        let yaw = 0;
        let mouthOpen = 0;

        if (points.length >= 468) {
          mouthOpen =
            Math.abs(
              points[13].y - points[14].y
            ) /
            Math.max(
              0.01,
              Math.abs(
                points[10].y - points[152].y
              )
            );

          const left = points[33];
          const right = points[263];
          const nosePoint = points[1];

          // Existing nose-offset heuristic.
          yaw =
            -(
              nosePoint.x -
              (left.x + right.x) / 2
            ) /
            Math.max(
              0.01,
              Math.abs(right.x - left.x)
            );
        }

        // 3D head pose in degrees from the 4x4 column-major transform.
        // Shown live by the ?debug=1 overlay in components/verification.tsx.
        const matrix =
          result.facialTransformationMatrixes?.[0]?.data;

        const pose =
          faceCount === 1 && matrix
            ? extractHeadPose(matrix)
            : null;

        // Publish measurements.
        this.callbacks.metrics({
          timestamp: now,
          faceCount,
          yaw,
          yawDeg: pose?.yawDeg,
          pitchDeg: pose?.pitchDeg,
          rollDeg: pose?.rollDeg,
          mouthOpen,
          points,
          blinkLeft: score("eyeBlinkLeft"),
          blinkRight: score("eyeBlinkRight"),
          jawOpen: score("jawOpen")
        });

      } catch {
        this.callbacks.model(
          "unavailable",
          "Landmark inference stopped. The affected evidence is unavailable."
        );

        this.detector?.close();
        this.detector = null;
        return;
      }
    }

    this.raf = requestAnimationFrame(
      this.loop
    );
  };

  /**
   * Release webcam and model resources.
   */
  stop(): void {
    this.cancelled = true;

    cancelAnimationFrame(this.raf);

    if (
      this.frameCallback &&
      this.video?.cancelVideoFrameCallback
    ) {
      this.video.cancelVideoFrameCallback(
        this.frameCallback
      );
    }

    document.removeEventListener(
      "visibilitychange",
      this.onVisibility
    );

    window.removeEventListener(
      "pagehide",
      this.onPageHide
    );

    // Restore automatic exposure first: some webcams keep manual mode in firmware after
    // the track closes. Bounded, so a slow driver only delays the camera light briefly.
    const tracks = this.stream?.getTracks() ?? [];
    const videoTrack = this.videoTrack;
    const restorers: Promise<unknown>[] = [];
    if (this.locked.length) restorers.push(this.unlockAfterLight());
    if (this.modeProbeActive && videoTrack) restorers.push(this.restoreCameraMode(videoTrack));
    if (this.sensorRestore) restorers.push(this.sensorRestore());
    const restoring = restorers.length
      ? Promise.race([Promise.allSettled(restorers), new Promise(resolve => setTimeout(resolve, 800))])
      : null;
    const stopTracks = () => tracks.forEach(track => {
      track.removeEventListener(
        "ended",
        this.interrupt
      );
      track.stop();
    });
    if (restoring) restoring.finally(stopTracks); else stopTracks();

    this.stream = null;

    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }

    this.video = null;

    this.detector?.close();
    this.detector = null;

    this.metadata = null;
    this.timingSamples = null;
    this.timingCanvas = null;
    this.feedFrames = [];
    this.feedCanvas = null;
    this.backgroundCanvas = null;
    this.previousBackground = null;
    this.previousFeedHash = null;
    this.frozenHistogram = new Uint32Array(1001);
    this.frozenPairs = 0;
    this.faceCenter = null;

    this.stopPulse();
  }
}
