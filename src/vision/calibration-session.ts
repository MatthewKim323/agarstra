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
  phase: "gaze" | "validation" | "done" | "failed";
  pointIndex: number;
  target: Point;
  targetCount: number;
  progress: number;
  samplesAtTarget: number;
  message: string;
  validation: CalibrationValidation | null;
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
    now - observation.timestamp <= 350 &&
    observation.quality >= 0.5 &&
    observation.quality <= 1 &&
    observation.features.length === 8 &&
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
  private pointSamples: CalibrationSample[] = [];
  private training: CalibrationSample[] = [];
  private heldOut: CalibrationSample[] = [];
  private fitted: CalibrationModel | null = null;
  readonly minimumSamples = 8;
  readonly settleMs = 650;
  readonly collectMs = 1150;
  readonly targetTimeoutMs = 15000;

  constructor(now: number) {
    if (!Number.isFinite(now))
      throw new Error("Invalid calibration timestamp.");
    this.epoch = this.targetStarted = this.lastNow = now;
    this.state = {
      phase: "gaze",
      pointIndex: 0,
      target: GAZE_TRAIN_TARGETS[0],
      targetCount: GAZE_TRAIN_TARGETS.length,
      progress: 0,
      samplesAtTarget: 0,
      message: "",
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
  update(observation: Observation | null, now: number): GazeCalibrationState {
    if (this.state.phase === "done" || this.state.phase === "failed")
      return this.current;
    if (!Number.isFinite(now) || now < this.lastNow)
      return this.fail("The calibration clock changed. Please start again.");
    this.lastNow = now;
    if (now - this.targetStarted > this.targetTimeoutMs)
      return this.fail(
        "Not enough stable samples at this point. Reposition if comfortable, retry, or use switch input.",
      );
    if (!freshObservation(observation, now)) {
      this.epoch = now;
      this.pointSamples = [];
      this.state = {
        ...this.state,
        progress: 0,
        samplesAtTarget: 0,
        message:
          "Face not clearly visible. This point will restart when tracking returns.",
      };
      return this.current;
    }
    const elapsed = now - this.epoch;
    this.state.message = "";
    this.state.progress = Math.min(
      1,
      elapsed / (this.settleMs + this.collectMs),
    );
    if (
      elapsed >= this.settleMs &&
      observation.timestamp > this.lastSample &&
      observation.timestamp >= this.epoch + this.settleMs
    ) {
      this.lastSample = observation.timestamp;
      this.pointSamples.push({
        features: [...observation.features],
        target: { ...this.state.target },
      });
      this.state.samplesAtTarget = this.pointSamples.length;
    }
    if (
      elapsed < this.settleMs + this.collectMs ||
      this.pointSamples.length < this.minimumSamples
    )
      return this.current;
    const targets =
      this.state.phase === "gaze"
        ? GAZE_TRAIN_TARGETS
        : GAZE_VALIDATION_TARGETS;
    if (this.state.phase === "gaze") this.training.push(...this.pointSamples);
    else this.heldOut.push(...this.pointSamples);
    this.pointSamples = [];
    this.epoch = this.targetStarted = now;
    if (this.state.pointIndex + 1 < targets.length) {
      const pointIndex = this.state.pointIndex + 1;
      this.state = {
        ...this.state,
        pointIndex,
        target: targets[pointIndex],
        progress: 0,
        samplesAtTarget: 0,
      };
      return this.current;
    }
    if (this.state.phase === "gaze") {
      try {
        this.fitted = fitCalibration(this.training);
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
        pointIndex: 0,
        target: GAZE_VALIDATION_TARGETS[0],
        targetCount: GAZE_VALIDATION_TARGETS.length,
        progress: 0,
        samplesAtTarget: 0,
      };
      return this.current;
    }
    try {
      const validation = validateCalibration(this.fitted!, this.heldOut);
      this.state = {
        ...this.state,
        phase: "done",
        validation,
        progress: 1,
        message: validation.passed
          ? "Independent check passed for this experimental large-control threshold."
          : "Gaze estimates were too variable. No gaze actions are enabled. Retry or use switch input.",
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
    this.state = { ...this.state, phase: "failed", message, progress: 0 };
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
