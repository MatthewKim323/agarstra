import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Observation } from "../../shared/types";
import {
  isCalibrationModel,
  PointSmoother,
  predictCalibration,
  type CalibrationModel,
} from "./calibration";
import { extractFaceFeatures } from "./features";
import {
  GestureDetector,
  type GestureConfig,
  type GestureKind,
} from "./gesture";
import { createFaceDetector, type DetectorRuntime } from "./runtime";

export interface CameraDiagnostics {
  running: boolean;
  backend: string;
  calibrated: boolean;
  gestureConfigured: boolean;
  gestureArmed: boolean;
  reason: string;
  frames: number;
}

/** Explicit start only. One owned camera stream, no frame storage or network uploads. */
export class CameraTracker {
  private generation = 0;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private worker: Worker | null = null;
  private cancelInitialization: (() => void) | null = null;
  private runtime: DetectorRuntime | null = null;
  private frame = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastVideoTime = -1;
  private lastRequest = -Infinity;
  private lastResult = -Infinity;
  private calibration: CalibrationModel | null = null;
  private gestureConfig: GestureConfig | null = null;
  private gestureKind: GestureKind = "jawOpen";
  private gesture = new GestureDetector();
  private smoother = new PointSmoother();
  private onObservation: ((observation: Observation) => void) | null = null;
  private onError: ((message: string) => void) | null = null;
  private diagnostics: CameraDiagnostics = {
    running: false,
    backend: "off",
    calibrated: false,
    gestureConfigured: false,
    gestureArmed: false,
    reason: "Camera is off.",
    frames: 0,
  };

  getDiagnostics(): CameraDiagnostics {
    return { ...this.diagnostics, gestureArmed: this.gesture.isArmed };
  }

  setCalibration(model: CalibrationModel | null): void {
    if (model && !isCalibrationModel(model))
      throw new Error("Invalid gaze calibration.");
    if (model && model.featureCount !== 8)
      throw new Error(
        "This camera profile uses an incompatible feature layout.",
      );
    this.calibration = model;
    this.diagnostics.calibrated = Boolean(model);
    this.smoother.reset();
    this.gesture.reset();
  }

  setGestureKind(kind: GestureKind): void {
    if (!["jawOpen", "browInnerUp", "mouthSmile"].includes(kind))
      throw new Error("Unsupported gesture.");
    if (kind !== this.gestureKind) this.setGesture(null);
    this.gestureKind = kind;
  }

  setGesture(config: GestureConfig | null): void {
    this.gesture.configure(config);
    this.gestureConfig = config;
    if (config) this.gestureKind = config.kind;
    this.diagnostics.gestureConfigured = Boolean(config);
  }

  async start(
    video: HTMLVideoElement,
    onObservation: (observation: Observation) => void,
    onError: (message: string) => void,
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.onObservation = onObservation;
    this.onError = onError;
    this.video = video;
    this.diagnostics.reason = "Requesting camera permission.";
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error(
          "Camera requires localhost or HTTPS and a browser with webcam support. Switch input is available without a camera.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 20, max: 30 },
        },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      if (generation !== this.generation) return;
      this.diagnostics.reason = "Loading the local face model.";
      await this.initializeDetector(generation);
      if (generation !== this.generation) return;
      this.diagnostics.running = true;
      this.diagnostics.reason =
        "Find a comfortable position with your face visible.";
      this.lastResult = performance.now();
      stream.getVideoTracks().forEach((track) =>
        track.addEventListener(
          "ended",
          () => {
            if (generation !== this.generation) return;
            const report = this.onError;
            this.stop();
            report?.(
              "Camera stream ended. Controls are paused. Restart the camera or use switch input.",
            );
          },
          { once: true },
        ),
      );
      this.watchdog = setInterval(() => {
        if (
          generation === this.generation &&
          performance.now() - this.lastResult > 450
        )
          this.invalidate(
            performance.now(),
            "Camera observations are stale. Controls paused.",
          );
      }, 150);
      const tick = (timestamp: number) => {
        if (generation !== this.generation) return;
        this.frame = requestAnimationFrame(tick);
        if (document.hidden) {
          this.invalidate(timestamp, "Window is hidden. Controls paused.");
          return;
        }
        if (
          !this.busy &&
          video.readyState >= 2 &&
          video.currentTime !== this.lastVideoTime &&
          timestamp - this.lastRequest >= 65
        ) {
          this.lastVideoTime = video.currentTime;
          this.lastRequest = timestamp;
          void this.processFrame(video, timestamp, generation);
        }
      };
      this.frame = requestAnimationFrame(tick);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = this.cameraError(error);
      this.stop();
      onError(message);
      throw new Error(message);
    }
  }

  stop(): void {
    this.generation++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.cancelInitialization?.();
    this.cancelInitialization = null;
    this.worker?.terminate();
    this.worker = null;
    this.runtime?.detector.close();
    this.runtime = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.busy = false;
    this.lastVideoTime = -1;
    this.lastRequest = -Infinity;
    this.lastResult = -Infinity;
    this.smoother.reset();
    this.gesture.reset();
    this.onObservation?.({
      x: 0.5,
      y: 0.5,
      quality: 0,
      timestamp: performance.now(),
      gesture: false,
      gestureStrength: 0,
      features: [],
    });
    this.onObservation = null;
    this.onError = null;
    this.diagnostics = {
      ...this.diagnostics,
      running: false,
      backend: "off",
      gestureArmed: false,
      reason: "Camera is off.",
      frames: 0,
    };
  }

  private async initializeDetector(generation: number): Promise<void> {
    // Worker inference keeps synchronous MediaPipe detection off the interaction thread.
    if (
      typeof Worker !== "undefined" &&
      typeof createImageBitmap === "function"
    ) {
      let worker: Worker | null = null;
      try {
        worker = new Worker(new URL("./face.worker.ts", import.meta.url), {
          type: "module",
        });
        this.worker = worker;
        const delegate = await new Promise<string>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            this.cancelInitialization = null;
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Worker initialization timed out."));
          }, 25000);
          this.cancelInitialization = () => {
            cleanup();
            reject(new Error("Camera initialization cancelled."));
          };
          worker!.onerror = () => {
            cleanup();
            reject(new Error("Worker initialization failed."));
          };
          worker!.onmessage = (
            event: MessageEvent<{
              type: string;
              delegate?: string;
              message?: string;
            }>,
          ) => {
            if (event.data.type === "ready") {
              cleanup();
              resolve(event.data.delegate ?? "CPU");
            }
            if (event.data.type === "error") {
              cleanup();
              reject(new Error(event.data.message));
            }
          };
          worker!.postMessage({ type: "init" });
        });
        if (generation !== this.generation) {
          worker.terminate();
          return;
        }
        this.worker = worker;
        worker.onmessage = (
          event: MessageEvent<{
            type: string;
            result?: FaceLandmarkerResult;
            timestamp?: number;
            message?: string;
          }>,
        ) => {
          if (generation !== this.generation) return;
          this.busy = false;
          if (
            event.data.type === "result" &&
            event.data.result &&
            event.data.timestamp !== undefined
          )
            this.handleResult(event.data.result, event.data.timestamp);
          else if (event.data.type === "error")
            this.failRuntime(event.data.message ?? "Face detection failed.");
        };
        worker.onerror = () => {
          if (generation === this.generation)
            this.failRuntime(
              "The camera worker stopped. Restart the camera or use switch input.",
            );
        };
        this.diagnostics.backend = `worker-${delegate.toLowerCase()}`;
        return;
      } catch {
        worker?.terminate();
        if (this.worker === worker) this.worker = null;
        if (generation !== this.generation) return;
      }
    }
    // Browser compatibility fallback. Runs at a bounded frame rate, never per paint.
    let runtime: DetectorRuntime;
    try {
      runtime = await createFaceDetector();
    } catch {
      throw new Error(
        "The local face model could not load. Run npm run setup to install vision assets, then retry in a current browser. Switch input remains available.",
      );
    }
    if (generation !== this.generation) {
      runtime.detector.close();
      return;
    }
    this.runtime = runtime;
    this.diagnostics.backend = `main-${runtime.delegate.toLowerCase()}`;
  }

  private async processFrame(
    video: HTMLVideoElement,
    timestamp: number,
    generation: number,
  ): Promise<void> {
    this.busy = true;
    try {
      if (this.worker) {
        const bitmap = await createImageBitmap(video);
        if (generation !== this.generation || !this.worker) {
          bitmap.close();
          return;
        }
        this.worker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
      } else if (this.runtime) {
        const result = this.runtime.detector.detectForVideo(video, timestamp);
        if (generation === this.generation)
          this.handleResult(result, timestamp);
        this.busy = false;
      }
    } catch (error) {
      this.busy = false;
      if (generation === this.generation)
        this.failRuntime(this.cameraError(error));
    }
  }

  private handleResult(result: FaceLandmarkerResult, timestamp: number): void {
    const now = performance.now();
    this.lastResult = now;
    this.diagnostics.frames++;
    if (now - timestamp > 450 || document.hidden) {
      this.invalidate(now, "Camera observations are stale. Controls paused.");
      return;
    }
    if (result.faceLandmarks.length !== 1) {
      this.invalidate(
        timestamp,
        result.faceLandmarks.length > 1
          ? "More than one face is visible. Controls paused."
          : "Face not visible. Controls paused.",
      );
      return;
    }
    const face = extractFaceFeatures(
      result.faceLandmarks[0],
      result.faceBlendshapes[0]?.categories,
    );
    if (!face) {
      this.invalidate(
        timestamp,
        "Face landmarks are incomplete. Controls paused.",
      );
      return;
    }
    this.diagnostics.reason = face.reason;
    const valid = face.quality >= 0.5;
    const rawPoint =
      this.calibration && valid
        ? predictCalibration(this.calibration, face.features)
        : { x: 0.5, y: 0.5 };
    if (!valid) this.smoother.reset();
    const point = valid
      ? this.smoother.update(rawPoint, timestamp)
      : { x: 0.5, y: 0.5 };
    const gestureStrength = face.gestures[this.gestureKind];
    const gesture = this.gesture.update(
      gestureStrength,
      timestamp,
      valid && Boolean(this.gestureConfig),
    );
    this.onObservation?.({
      ...point,
      quality: face.quality,
      timestamp,
      gesture,
      gestureStrength,
      features: face.features,
    });
  }

  private invalidate(timestamp: number, reason: string): void {
    this.gesture.reset();
    this.smoother.reset();
    this.diagnostics.reason = reason;
    this.onObservation?.({
      x: 0.5,
      y: 0.5,
      quality: 0,
      timestamp,
      gesture: false,
      gestureStrength: 0,
      features: [],
    });
  }

  private failRuntime(message: string): void {
    const report = this.onError;
    this.stop();
    report?.(message);
  }

  private cameraError(error: unknown): string {
    if (error instanceof Error && error.name === "NotAllowedError")
      return "Camera permission was denied. Nothing was recorded. You can enable it in browser settings or use switch input.";
    if (error instanceof Error && error.name === "NotFoundError")
      return "No camera was found. Switch input works without a camera.";
    if (error instanceof Error && error.name === "NotReadableError")
      return "The camera is busy or unavailable. Close other camera apps, or use switch input.";
    return error instanceof Error
      ? error.message
      : "Camera setup failed. Run npm run setup to install local vision assets, or use switch input.";
  }
}
