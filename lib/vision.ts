
import type { RGBSample } from "./rppg.ts";
import type {
  DeviceEvidence,
  FaceMetrics,
  Point
} from "./types.ts";

import { extractHeadPose } from "./head-pose.ts";
import { lockCamera, unlockCamera } from "./reflection.ts";
import { frameTimingStats, grayHash, summarizeCapabilities } from "./injection.ts";
import type { FrameSample } from "./injection.ts";
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

  // rPPG sampling state
  private pulseSamples: RGBSample[] | null = null;
  private pulseCanvas: HTMLCanvasElement | null = null;
  private pulsePoints: Point[] = [];
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
    this.previousNose = null;
    this.pulseMotion = false;

    return samples;
  }

  getPulseSamples(): RGBSample[] {
    return this.pulseSamples
      ? [...this.pulseSamples]
      : [];
  }

  /**
   * Sample forehead and cheek RGB values.
   * The canvas is temporary and never stores video.
   */
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

    const regions = [
      {
        x: (points[109].x + points[338].x) / 2,
        y: (points[10].y + points[9].y) / 2
      },
      points[50],
      points[280]
    ];

    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;

    for (const pt of regions) {
      const x = Math.max(
        0,
        Math.min(306, Math.round(pt.x * 320) - 7)
      );

      const y = Math.max(
        0,
        Math.min(226, Math.round(pt.y * 240) - 7)
      );

      const pixels = ctx.getImageData(
        x,
        y,
        14,
        14
      ).data;

      for (let i = 0; i < pixels.length; i += 4) {
        const rr = pixels[i];
        const gg = pixels[i + 1];
        const bb = pixels[i + 2];

        if (
          Math.min(rr, gg, bb) < 12 ||
          Math.max(rr, gg, bb) > 245
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
      frameTiming: null
    };

    this.callbacks.device({ ...this.metadata });

    video.srcObject = stream;

    await video.play();

    if (this.cancelled) return;

    this.measureFrames();

    this.callbacks.model("loading");

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
    const restoring = this.locked.length
      ? Promise.race([this.unlockAfterLight(), new Promise(resolve => setTimeout(resolve, 800))])
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

    this.stopPulse();
  }
}
