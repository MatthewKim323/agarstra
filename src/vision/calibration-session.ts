import type { CalibrationSample, Observation, Point } from "../../shared/types";
import {
  fitCalibration,
  validateCalibration,
  type CalibrationModel,
  type CalibrationValidation,
} from "./calibration";
import {
  calibrateGesture,
  type GestureConfig,
  type GestureKind,
} from "./gesture";

export const GAZE_TRAIN_TARGETS: Point[] = [
  { x: 0.15, y: 0.15 },
  { x: 0.5, y: 0.15 },
  { x: 0.85, y: 0.15 },
  { x: 0.85, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.15, y: 0.5 },
  { x: 0.15, y: 0.85 },
  { x: 0.5, y: 0.85 },
  { x: 0.85, y: 0.85 },
];
export const GAZE_VALIDATION_TARGETS: Point[] = [
  { x: 0.3, y: 0.3 },
  { x: 0.7, y: 0.3 },
  { x: 0.7, y: 0.7 },
  { x: 0.3, y: 0.7 },
  { x: 0.5, y: 0.5 },
];

export interface GazeCalibrationState {
  phase: "ready" | "gaze" | "validation" | "done" | "failed";
  status: "ready" | "settling" | "collecting" | "paused" | "complete";
  pointIndex: number;
  target: Point;
  targetCount: number;
  progress: number;
  samplesAtTarget: number;
  message: string;
  validation: CalibrationValidation | null;
}

export interface GazeTargetDiagnostic {
  phase: "gaze" | "validation";
  target: Point;
  samples: number;
  rejectedFrames: number;
  trackingLosses: number;
  elapsedMs: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Eye-local iris/head geometry only. Eye appearance dimensions are not motion. */
const MOTION_SCALES = [0.025, 0.02, 0.025, 0.02, 0.02, 0.02, 0.015, 0.015];
export const GAZE_SAMPLE_MAX_AGE_MS = 350;
export const GAZE_FRAME_MAX_GAP_MS = 350;

function fixationWindow(
  window: Observation[],
  current: Observation,
): "settling" | "stable" | "moving" | "outlier" {
  if (window.length < 5 || current.timestamp - window[0].timestamp < 280)
    return "settling";
  const dimensions = Math.min(8, current.features.length);
  let movement = 0;
  let deviation = 0;
  let largestMovement = 0;
  let largestDeviation = 0;
  for (let index = 0; index < dimensions; index++) {
    const values = window.map((frame) => frame.features[index]);
    const center = median(values);
    // Upper-quartile deviation rejects alternating fixations while tolerating
    // one isolated bad frame. Median deviation alone misses bimodal windows.
    const deviations = values
      .map((value) => Math.abs(value - center))
      .sort((a, b) => a - b);
    const spread = deviations[Math.ceil(deviations.length * 0.75) - 1];
    movement += (spread / MOTION_SCALES[index]) ** 2;
    deviation +=
      ((current.features[index] - center) / MOTION_SCALES[index]) ** 2;
    largestMovement = Math.max(largestMovement, spread / MOTION_SCALES[index]);
    largestDeviation = Math.max(
      largestDeviation,
      Math.abs(current.features[index] - center) / MOTION_SCALES[index],
    );
  }
  if (Math.sqrt(deviation / dimensions) > 2 || largestDeviation > 3)
    return "outlier";
  if (Math.sqrt(movement / dimensions) > 0.65 || largestMovement > 1.2)
    return "moving";
  return "stable";
}

function freshObservation(
  observation: Observation | null,
  now: number,
): observation is Observation {
  return (
    observation !== null &&
    Number.isFinite(now) &&
    Number.isFinite(observation.timestamp) &&
    now - observation.timestamp >= -50 &&
    now - observation.timestamp <= GAZE_SAMPLE_MAX_AGE_MS &&
    observation.quality >= 0.5 &&
    observation.quality <= 1 &&
    observation.features.length >= 2 &&
    observation.features.length <= 128 &&
    observation.features.every(Number.isFinite)
  );
}

/** Pure state machine. Every target must have enough distinct, settled, fresh frames. */
export class GazeCalibrationSession {
  private state: GazeCalibrationState;
  private epoch: number;
  private targetStarted: number;
  private lastNow: number;
  private lastSample = -Infinity;
  private lastFrame = -Infinity;
  private lastFrameReceivedAt = -Infinity;
  private featureCount: number | null = null;
  private window: Observation[] = [];
  private collectionStarted: number | null = null;
  private rejectedFrames = 0;
  private trackingLosses = 0;
  private targetDiagnostics: GazeTargetDiagnostic[] = [];
  private pointSamples: CalibrationSample[] = [];
  private training: CalibrationSample[] = [];
  private heldOut: CalibrationSample[] = [];
  private fitted: CalibrationModel | null = null;
  readonly minimumSamples = 10;
  readonly settleMs = 650;
  readonly collectMs = 1150;
  readonly targetTimeoutMs = 25000;

  constructor(now: number) {
    if (!Number.isFinite(now))
      throw new Error("Invalid calibration timestamp.");
    this.epoch = this.targetStarted = this.lastNow = now;
    this.state = {
      phase: "ready",
      status: "ready",
      pointIndex: 0,
      target: GAZE_TRAIN_TARGETS[0],
      targetCount: GAZE_TRAIN_TARGETS.length,
      progress: 0,
      samplesAtTarget: 0,
      message:
        "Read the instructions, then start when you are ready. Nothing is being recorded yet.",
      validation: null,
    };
  }
  get current(): GazeCalibrationState {
    return { ...this.state, target: { ...this.state.target } };
  }
  get model(): CalibrationModel | null {
    return this.state.phase === "done" && this.state.validation?.passed
      ? this.fitted
      : null;
  }
  get counts(): { training: number; heldOut: number } {
    return { training: this.training.length, heldOut: this.heldOut.length };
  }
  /** Explicit user start. Waiting at instructions never consumes target time. */
  start(now: number): GazeCalibrationState {
    if (this.state.phase !== "ready") return this.current;
    if (!Number.isFinite(now) || now < this.lastNow)
      return this.fail("The calibration clock changed. Please start again.");
    this.epoch = this.targetStarted = this.lastNow = now;
    this.state = {
      ...this.state,
      phase: "gaze",
      status: "settling",
      message:
        "Look at the center of the point. The ring fills only while your eye signal is steady.",
    };
    return this.current;
  }
  /** Opt-in export contains only numeric summaries, never images or feature vectors. */
  diagnosticReport(viewport: { width: number; height: number }) {
    const validation = this.state.validation;
    const fit = this.fitted?.trainingDiagnostics;
    return {
      schema: "nerve-gaze-diagnostics-v1",
      viewport: {
        width: Math.round(
          Math.max(0, Number.isFinite(viewport.width) ? viewport.width : 0),
        ),
        height: Math.round(
          Math.max(0, Number.isFinite(viewport.height) ? viewport.height : 0),
        ),
      },
      result: this.state.phase,
      passed: validation?.passed ?? false,
      thresholds: { meanError: 0.15, p95Error: 0.255 },
      counts: this.counts,
      incompleteTarget:
        this.state.phase === "done" || this.state.phase === "ready"
          ? null
          : {
              stage:
                this.state.targetCount === GAZE_TRAIN_TARGETS.length
                  ? "gaze"
                  : "validation",
              index: this.state.pointIndex + 1,
              target: { ...this.state.target },
              samples: this.pointSamples.length,
              rejectedFrames: this.rejectedFrames,
              trackingLosses: this.trackingLosses,
            },
      fit: fit
        ? {
            modelFamily: fit.modelFamily,
            featureSet: fit.featureSet,
            ridge: fit.ridge,
            trainingTargets: fit.trainingTargets,
            trainingSamples: fit.trainingSamples,
            rejectedSamples: fit.rejectedSamples,
            crossValidationError: fit.crossValidationError,
          }
        : null,
      collections: this.targetDiagnostics.map((item) => ({
        ...item,
        target: { ...item.target },
      })),
      validation: validation
        ? {
            meanError: validation.meanError,
            p95Error: validation.p95Error,
            maxError: validation.maxError,
            sampleCount: validation.sampleCount,
            failureReason: validation.failureReason,
            targets: validation.targets?.map((item) => ({
              target: { ...item.target },
              predicted: { ...item.predicted },
              meanError: item.meanError,
              p95Error: item.p95Error,
              maxError: item.maxError,
              sampleCount: item.sampleCount,
              dispersion: item.dispersion,
              bias: { ...item.bias },
            })),
          }
        : null,
    };
  }
  update(observation: Observation | null, now: number): GazeCalibrationState {
    if (this.state.phase === "done" || this.state.phase === "failed")
      return this.current;
    if (!Number.isFinite(now) || now < this.lastNow)
      return this.fail("The calibration clock changed. Please start again.");
    this.lastNow = now;
    if (this.state.phase === "ready") return this.current;
    if (now - this.targetStarted > this.targetTimeoutMs)
      return this.fail(
        this.pointSamples.length === 0 && this.rejectedFrames === 0
          ? `Not enough usable camera frames arrived at ${this.state.phase === "gaze" ? "training" : "check"} point ${this.state.pointIndex + 1}. The camera may be too slow or your face may not be visible. Check the live signal, close other video apps, or use switch input.`
          : `Could not collect a steady eye signal at ${this.state.phase === "gaze" ? "training" : "check"} point ${this.state.pointIndex + 1}. This is a tracking limitation, not a failed instruction. Try softer front lighting, reduce glasses glare, or use switch input.`,
      );
    // The UI polls faster than inference. An already accepted result is not a
    // new stale capture just because another poll sees it between arrivals.
    // This does not record it again, advance time/progress, or change its stamp.
    if (
      observation !== null &&
      observation.timestamp === this.lastFrame &&
      now - this.lastFrameReceivedAt <= GAZE_FRAME_MAX_GAP_MS &&
      freshObservation(observation, this.lastFrameReceivedAt)
    )
      return this.current;
    if (!freshObservation(observation, now)) {
      this.trackingLosses++;
      this.epoch = now;
      this.window = [];
      this.collectionStarted = null;
      this.pointSamples = [];
      this.state = {
        ...this.state,
        progress: 0,
        samplesAtTarget: 0,
        status: "paused",
        message:
          "Tracking paused. Blink naturally; look back at the point when your eyes are visible.",
      };
      return this.current;
    }
    if (observation.timestamp <= this.lastFrame) return this.current;
    // A high-frame-rate camera must not collapse the time span of the window.
    if (observation.timestamp - this.lastFrame < 50) return this.current;
    if (
      Number.isFinite(this.lastFrame) &&
      observation.timestamp - this.lastFrame > GAZE_FRAME_MAX_GAP_MS
    ) {
      this.window = [];
      this.pointSamples = [];
      this.collectionStarted = null;
      this.epoch = now;
      this.state.progress = this.state.samplesAtTarget = 0;
    }
    if (this.featureCount === null)
      this.featureCount = observation.features.length;
    if (observation.features.length !== this.featureCount)
      return this.fail(
        "The camera feature format changed during calibration. Please restart camera setup.",
      );
    this.lastFrame = observation.timestamp;
    this.lastFrameReceivedAt = now;
    this.window = [
      ...this.window,
      {
        ...observation,
        features: [...observation.features],
      },
    ].slice(-7);
    // A count-bounded window supports slower inference. The fresh-capture and
    // capture-gap checks above bound its age without making five frames
    // mathematically impossible below 6.15 FPS.
    const elapsed = now - this.epoch;
    const fixation = fixationWindow(this.window, observation);
    if (fixation === "moving" || fixation === "outlier") {
      this.rejectedFrames++;
      this.pointSamples = [];
      this.collectionStarted = null;
      this.state = {
        ...this.state,
        samplesAtTarget: 0,
        progress: 0,
        status: "paused",
        message:
          "Waiting for a steady eye signal. Keep looking at the point; there is no need to click or hold a gesture.",
      };
      return this.current;
    }
    if (elapsed < this.settleMs || fixation === "settling") {
      this.state.status = "settling";
      this.state.message =
        elapsed > 2000
          ? "Waiting for enough fresh camera frames. Close other camera or video apps if this continues."
          : "Find the center of the point. Recording starts after your eyes settle.";
      return this.current;
    }
    this.state.status = "collecting";
    this.state.message =
      "Signal steady. Keep looking at the point while its ring fills.";
    if (
      elapsed >= this.settleMs &&
      observation.timestamp > this.lastSample &&
      observation.timestamp >= this.epoch + this.settleMs
    ) {
      this.lastSample = observation.timestamp;
      if (this.collectionStarted === null)
        this.collectionStarted = observation.timestamp;
      this.pointSamples.push({
        features: [...observation.features],
        target: { ...this.state.target },
      });
      this.state.samplesAtTarget = this.pointSamples.length;
    }
    const collectedMs =
      this.collectionStarted === null
        ? 0
        : observation.timestamp - this.collectionStarted;
    this.state.progress = Math.min(
      1,
      collectedMs / this.collectMs,
      this.pointSamples.length / this.minimumSamples,
    );
    if (
      collectedMs < this.collectMs ||
      this.pointSamples.length < this.minimumSamples
    )
      return this.current;
    this.targetDiagnostics.push({
      phase: this.state.phase,
      target: { ...this.state.target },
      samples: this.pointSamples.length,
      rejectedFrames: this.rejectedFrames,
      trackingLosses: this.trackingLosses,
      elapsedMs: Math.round(now - this.targetStarted),
    });
    const targets =
      this.state.phase === "gaze"
        ? GAZE_TRAIN_TARGETS
        : GAZE_VALIDATION_TARGETS;
    if (this.state.phase === "gaze") this.training.push(...this.pointSamples);
    else this.heldOut.push(...this.pointSamples);
    this.pointSamples = [];
    this.window = [];
    this.collectionStarted = null;
    this.rejectedFrames = this.trackingLosses = 0;
    this.epoch = this.targetStarted = now;
    if (this.state.pointIndex + 1 < targets.length) {
      const pointIndex = this.state.pointIndex + 1;
      this.state = {
        ...this.state,
        pointIndex,
        target: targets[pointIndex],
        progress: 0,
        samplesAtTarget: 0,
        status: "settling",
        message:
          "Move your eyes to the next point. It will wait for your signal to settle.",
      };
      return this.current;
    }
    if (this.state.phase === "gaze") {
      try {
        this.fitted = fitCalibration(
          this.training,
          0.1,
          this.featureCount === 18
            ? {
                featureSets: [
                  { name: "neural", indices: [8, 9] },
                  {
                    name: "landmarks",
                    indices: Array.from({ length: 8 }, (_, index) => index),
                  },
                  {
                    name: "neural-and-eye-position",
                    indices: Array.from(
                      { length: 10 },
                      (_, index) => index + 8,
                    ),
                  },
                  {
                    name: "fused",
                    indices: Array.from({ length: 18 }, (_, index) => index),
                  },
                ],
              }
            : undefined,
        );
      } catch (error) {
        return this.fail(
          error instanceof Error
            ? error.message
            : "Calibration fitting failed.",
        );
      }
      this.state = {
        ...this.state,
        phase: "validation",
        status: "settling",
        pointIndex: 0,
        target: GAZE_VALIDATION_TARGETS[0],
        targetCount: GAZE_VALIDATION_TARGETS.length,
        progress: 0,
        samplesAtTarget: 0,
        message:
          "Now checking five separate targets. These observations never train the model.",
      };
      return this.current;
    }
    try {
      const validation = validateCalibration(this.fitted!, this.heldOut);
      this.state = {
        ...this.state,
        phase: "done",
        status: "complete",
        validation,
        progress: 1,
        message: validation.passed
          ? "Independent check passed for this experimental large-control threshold."
          : `Gaze check did not pass: ${validation.meanError > 0.15 ? `average error ${validation.meanError.toFixed(3)} exceeds 0.150` : `average error ${validation.meanError.toFixed(3)} passes`}; ${validation.p95Error > 0.255 ? `95th-percentile error ${validation.p95Error.toFixed(3)} exceeds 0.255` : `95th-percentile error ${validation.p95Error.toFixed(3)} passes`}. See the point-by-point results below. Gaze actions remain disabled.`,
      };
    } catch (error) {
      return this.fail(
        error instanceof Error ? error.message : "Validation failed.",
      );
    }
    return this.current;
  }
  private fail(message: string): GazeCalibrationState {
    this.fitted = null;
    this.state = {
      ...this.state,
      phase: "failed",
      status: "paused",
      message,
      progress: 0,
    };
    return this.current;
  }
}

export interface GestureCalibrationState {
  phase: "neutral" | "gesture" | "done" | "failed";
  progress: number;
  sampleCount: number;
  message: string;
}

export class GestureCalibrationSession {
  private state: GestureCalibrationState = {
    phase: "neutral",
    progress: 0,
    sampleCount: 0,
    message: "",
  };
  private stageStarted: number;
  private lastNow: number;
  private lastSample = -Infinity;
  private validMs = 0;
  private lastValidAt: number | null = null;
  private neutral: number[] = [];
  private active: number[] = [];
  private fitted: GestureConfig | null = null;
  constructor(
    readonly kind: GestureKind,
    now: number,
  ) {
    if (!Number.isFinite(now)) throw new Error("Invalid gesture timestamp.");
    this.stageStarted = this.lastNow = now;
  }
  get current(): GestureCalibrationState {
    return { ...this.state };
  }
  get config(): GestureConfig | null {
    return this.fitted;
  }
  update(
    observation: Observation | null,
    now: number,
  ): GestureCalibrationState {
    if (this.state.phase === "done" || this.state.phase === "failed")
      return this.current;
    if (!Number.isFinite(now) || now < this.lastNow)
      return this.fail("The calibration clock changed. Please start again.");
    this.lastNow = now;
    if (now - this.stageStarted > 20000)
      return this.fail(
        "Not enough stable gesture samples. Try another comfortable movement or use switch input.",
      );
    if (
      !freshObservation(observation, now) ||
      observation.gestureStrength === undefined ||
      !Number.isFinite(observation.gestureStrength) ||
      observation.gestureStrength < 0 ||
      observation.gestureStrength > 1
    ) {
      // Natural blinking pauses recording. It never becomes a gesture or forces
      // someone to hold their eyes open for the entire four-second recording.
      this.lastValidAt = null;
      this.state = {
        ...this.state,
        message:
          "Recording paused. Keep your face visible if comfortable; blinking is okay.",
      };
      return this.current;
    }
    if (this.lastValidAt !== null && now - this.lastValidAt <= 350)
      this.validMs += now - this.lastValidAt;
    this.lastValidAt = now;
    const elapsed = this.validMs;
    const samples = this.state.phase === "neutral" ? this.neutral : this.active;
    if (elapsed >= 1000 && observation.timestamp > this.lastSample) {
      this.lastSample = observation.timestamp;
      samples.push(observation.gestureStrength);
    }
    this.state = {
      ...this.state,
      progress: Math.min(1, elapsed / 4000),
      sampleCount: samples.length,
      message: "",
    };
    if (elapsed < 4000 || samples.length < 10) return this.current;
    if (this.state.phase === "neutral") {
      this.state = {
        phase: "gesture",
        progress: 0,
        sampleCount: 0,
        message: "",
      };
      this.stageStarted = now;
      this.validMs = 0;
      this.lastValidAt = null;
      return this.current;
    }
    try {
      this.fitted = calibrateGesture(this.neutral, this.active, this.kind);
      this.state = {
        ...this.state,
        phase: "done",
        progress: 1,
        message:
          "Gesture learned. Relax to arm the first deliberate selection.",
      };
    } catch (error) {
      return this.fail(
        error instanceof Error
          ? error.message
          : "This gesture was not distinct enough.",
      );
    }
    return this.current;
  }
  private fail(message: string): GestureCalibrationState {
    this.fitted = null;
    this.state = { ...this.state, phase: "failed", message, progress: 0 };
    return this.current;
  }
}
