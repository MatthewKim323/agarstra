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
import {
  createNeuralGazeRuntime,
  type NeuralGaze,
  type NeuralGazeRuntime,
} from "./neural-gaze";
import { NEURAL_FEATURE_COUNT } from "./eye-images";

export interface CameraDiagnostics {
  running: boolean;
  backend: string;
  calibrated: boolean;
  gestureConfigured: boolean;
  gestureArmed: boolean;
  reason: string;
  frames: number;
  gazeModel: string;
  inferenceMs: number;
}

/** Explicit start only. One owned camera stream, no frame storage or network uploads. */
export class CameraTracker {
  private generation = 0;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private worker: Worker | null = null;
  private cancelInitialization: (() => void) | null = null;
  private runtime: DetectorRuntime | null = null;
  private neural: NeuralGazeRuntime | null = null;
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
    gazeModel: "Peekr CNN + personal calibration",
    inferenceMs: 0,
  };

  getDiagnostics(): CameraDiagnostics {
    return { ...this.diagnostics, gestureArmed: this.gesture.isArmed };
  }

  setCalibration(model: CalibrationModel | null): void {
    if (model && !isCalibrationModel(model))
      throw new Error("Invalid gaze calibration.");
    if (model && model.featureCount !== NEURAL_FEATURE_COUNT)
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
          width: { ideal: 1280 },
          height: { ideal: 720 },
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
      this.diagnostics.reason =
        "Loading local face and pretrained gaze models.";
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
    const frame = this.frame;
    const watchdog = this.watchdog;
    const cancel = this.cancelInitialization;
    const worker = this.worker;
    const runtime = this.runtime;
    const neural = this.neural;
    const stream = this.stream;
    const video = this.video;
    const observe = this.onObservation;
    // Detach ownership before disposal, so an exception or reentrant stop cannot
    // leave old resources attached to a new session.
    this.frame = 0;
    this.watchdog = null;
    this.cancelInitialization = null;
    this.worker = null;
    this.runtime = null;
    this.neural = null;
    this.calibration = null;
    this.gestureConfig = null;
    this.stream = null;
    this.video = null;
    this.onObservation = null;
    this.onError = null;
    this.busy = false;
    this.lastVideoTime = -1;
    this.lastRequest = -Infinity;
    this.lastResult = -Infinity;
    this.smoother.reset();
    this.gesture.reset();
    this.diagnostics = {
      ...this.diagnostics,
      running: false,
      backend: "off",
      gestureArmed: false,
      reason: "Camera is off.",
      frames: 0,
      calibrated: false,
      gestureConfigured: false,
      inferenceMs: 0,
    };
    const release = (dispose: () => void) => {
      try {
        dispose();
      } catch {
        /* One teardown failure cannot block the rest. */
      }
    };
    if (frame) release(() => cancelAnimationFrame(frame));
    if (watchdog) release(() => clearInterval(watchdog));
    // Stop hardware before closing WASM/model resources, even if their close throws.
    release(() =>
      stream?.getTracks().forEach((track) => release(() => track.stop())),
    );
    if (video)
      release(() => {
        video.srcObject = null;
      });
    if (cancel) release(cancel);
    if (worker) release(() => worker.terminate());
    if (runtime) release(() => runtime.detector.close());
    if (neural) release(() => neural.close());
    if (observe)
      release(() =>
        observe({
          x: 0.5,
          y: 0.5,
          quality: 0,
          timestamp: performance.now(),
          gesture: false,
          gestureStrength: 0,
          features: [],
        }),
      );
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
            if (this.cancelInitialization === cancel)
              this.cancelInitialization = null;
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error("Worker initialization timed out."));
          }, 45000);
          const cancel = () => {
            cleanup();
            reject(new Error("Camera initialization cancelled."));
          };
          this.cancelInitialization = cancel;
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
            neural?: NeuralGaze | null;
            message?: string;
          }>,
        ) => {
          if (generation !== this.generation) return;
          this.busy = false;
          try {
            if (
              event.data.type === "result" &&
              event.data.result &&
              event.data.timestamp !== undefined
            )
              this.handleResult(
                event.data.result,
                event.data.timestamp,
                event.data.neural ?? null,
              );
            else if (event.data.type === "error")
              this.failRuntime(event.data.message ?? "Face detection failed.");
          } catch (error) {
            this.failRuntime(this.cameraError(error));
          }
        };
        worker.onerror = () => {
          if (generation === this.generation)
            this.failRuntime(
              "The camera worker stopped. Restart the camera or use switch input.",
            );
        };
        this.diagnostics.backend = `worker-${delegate.toLowerCase()} + Peekr ONNX`;
        return;
      } catch {
        worker?.terminate();
        if (this.worker === worker) this.worker = null;
        if (generation !== this.generation) return;
      }
    }
    // Browser compatibility fallback. Runs at a bounded frame rate, never per paint.
    const { runtime, neural } = await this.initializeFallback(generation);
    if (generation !== this.generation) {
      runtime.detector.close();
      neural.close();
      return;
    }
    this.runtime = runtime;
    this.neural = neural;
    this.diagnostics.backend = `main-${runtime.delegate.toLowerCase()} + Peekr ONNX`;
  }

  /** Stop settles start immediately, even when a model factory cannot abort its own load. */
  private initializeFallback(generation: number): Promise<{
    runtime: DetectorRuntime;
    neural: NeuralGazeRuntime;
  }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ownedRuntime: DetectorRuntime | null = null;
      let ownedNeural: NeuralGazeRuntime | null = null;
      const cleanup = () => {
        clearTimeout(timer);
        if (this.cancelInitialization === cancel)
          this.cancelInitialization = null;
      };
      const releaseOwned = () => {
        const runtime = ownedRuntime;
        const neural = ownedNeural;
        ownedRuntime = null;
        ownedNeural = null;
        // A model cleanup error must not prevent cancellation or track cleanup.
        try {
          runtime?.detector.close();
        } catch {
          /* Already closing. */
        }
        try {
          neural?.close();
        } catch {
          /* Already closing. */
        }
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        releaseOwned();
        reject(error);
      };
      const cancel = () => fail(new Error("Camera initialization cancelled."));
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              "Local vision model initialization timed out. Restart the camera or use switch input.",
            ),
          ),
        45000,
      );
      this.cancelInitialization = cancel;

      void (async () => {
        try {
          const runtime = await createFaceDetector();
          if (settled || generation !== this.generation) {
            runtime.detector.close();
            return;
          }
          ownedRuntime = runtime;
          const neural = await createNeuralGazeRuntime();
          if (settled || generation !== this.generation) {
            neural.close();
            return;
          }
          ownedNeural = neural;
          settled = true;
          cleanup();
          ownedRuntime = null;
          ownedNeural = null;
          resolve({ runtime, neural });
        } catch (error) {
          fail(
            new Error(
              "The local face or gaze model could not load. Run npm run setup to install vision assets, then retry in a current browser. Switch input remains available.",
              { cause: error },
            ),
          );
        }
      })();
    });
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
      } else if (this.runtime && this.neural) {
        const neural = this.neural;
        const mirrored = neural.images.mirror(
          video,
          video.videoWidth,
          video.videoHeight,
        );
        const result = this.runtime.detector.detectForVideo(
          mirrored,
          timestamp,
        );
        const gaze = await neural.predict(
          video,
          video.videoWidth,
          video.videoHeight,
          result,
        );
        if (generation === this.generation)
          this.handleResult(result, timestamp, gaze);
        if (generation === this.generation) this.busy = false;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.busy = false;
        this.failRuntime(this.cameraError(error));
      }
    }
  }

  private handleResult(
    result: FaceLandmarkerResult,
    timestamp: number,
    neural: NeuralGaze | null,
  ): void {
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
    if (!neural) {
      this.invalidate(
        timestamp,
        "Eye images are not usable yet. Face the screen with both eyes visible.",
      );
      return;
    }
    const features = [
      ...face.features,
      neural.raw.x,
      neural.raw.y,
      ...neural.keypoints,
    ];
    if (
      features.length !== NEURAL_FEATURE_COUNT ||
      features.some((value) => !Number.isFinite(value))
    ) {
      this.invalidate(
        timestamp,
        "The gaze model returned invalid features. Controls paused.",
      );
      return;
    }
    this.diagnostics.inferenceMs = neural.inferenceMs;
    this.diagnostics.reason = face.reason;
    const valid = face.quality >= 0.5;
    const rawPoint =
      this.calibration && valid
        ? predictCalibration(this.calibration, features)
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
      features,
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
