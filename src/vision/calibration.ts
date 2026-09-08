import type { CalibrationSample, Point } from "../../shared/types";

/** Screen coordinates and validation errors use 0..1 viewport units. */
export interface CalibrationModel {
  version: 1;
  featureCount: number;
  means: number[];
  scales: number[];
  weightsX: number[];
  weightsY: number[];
  samples: number;
  createdAt: number;
}

export interface CalibrationValidation {
  meanError: number;
  p95Error: number;
  maxError: number;
  passed: boolean;
  sampleCount: number;
}

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));
const finiteVector = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) &&
  (length === undefined || value.length === length) &&
  value.every((v) => typeof v === "number" && Number.isFinite(v));

/** Gaussian elimination with pivoting. Ridge keeps the feature matrix nonsingular. */
function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const augmented = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col]))
        pivot = row;
    }
    if (Math.abs(augmented[pivot][col]) < 1e-12)
      throw new Error(
        "Calibration is degenerate. Move between all targets and try again.",
      );
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const scale = augmented[col][col];
    for (let k = col; k <= n; k++) augmented[col][k] /= scale;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let k = col; k <= n; k++)
        augmented[row][k] -= factor * augmented[col][k];
    }
  }
  return augmented.map((row) => row[n]);
}

/** Fit only on calibration samples. Validation must use separately collected samples. */
export function fitCalibration(
  samples: CalibrationSample[],
  ridge = 0.1,
): CalibrationModel {
  if (samples.length < 9)
    throw new Error("Calibration requires at least 9 valid observations.");
  if (!Number.isFinite(ridge) || ridge <= 0)
    throw new Error("Ridge regularization must be positive.");
  const featureCount = samples[0]?.features.length ?? 0;
  if (featureCount < 2 || featureCount > 32)
    throw new Error("Calibration needs 2 to 32 numeric features.");
  for (const sample of samples) {
    if (
      !finiteVector(sample.features, featureCount) ||
      !Number.isFinite(sample.target.x) ||
      !Number.isFinite(sample.target.y) ||
      sample.target.x < 0 ||
      sample.target.x > 1 ||
      sample.target.y < 0 ||
      sample.target.y > 1
    ) {
      throw new Error("Invalid calibration sample.");
    }
  }
  const spanX =
    Math.max(...samples.map((s) => s.target.x)) -
    Math.min(...samples.map((s) => s.target.x));
  const spanY =
    Math.max(...samples.map((s) => s.target.y)) -
    Math.min(...samples.map((s) => s.target.y));
  if (spanX < 0.35 || spanY < 0.35)
    throw new Error(
      "Calibration targets must cover the screen in both directions.",
    );
  const n = samples.length;
  const means = Array.from(
    { length: featureCount },
    (_, j) => samples.reduce((sum, s) => sum + s.features[j], 0) / n,
  );
  const scales = means.map((mean, j) =>
    Math.max(
      0.0001,
      Math.sqrt(
        samples.reduce((sum, s) => sum + (s.features[j] - mean) ** 2, 0) / n,
      ),
    ),
  );
  const rows = samples.map((s) => [
    1,
    ...s.features.map((v, j) => (v - means[j]) / scales[j]),
  ]);
  const size = featureCount + 1;
  const xtx = Array.from({ length: size }, (_, a) =>
    Array.from(
      { length: size },
      (_, b) =>
        rows.reduce((sum, row) => sum + row[a] * row[b], 0) +
        (a === b && a !== 0 ? ridge : 0),
    ),
  );
  const xty = (axis: "x" | "y") =>
    Array.from({ length: size }, (_, a) =>
      rows.reduce((sum, row, i) => sum + row[a] * samples[i].target[axis], 0),
    );
  return {
    version: 1,
    featureCount,
    means,
    scales,
    weightsX: solve(xtx, xty("x")),
    weightsY: solve(xtx, xty("y")),
    samples: n,
    createdAt: Date.now(),
  };
}

export function isCalibrationModel(value: unknown): value is CalibrationModel {
  if (!value || typeof value !== "object") return false;
  const m = value as CalibrationModel;
  return (
    m.version === 1 &&
    Number.isInteger(m.featureCount) &&
    m.featureCount >= 2 &&
    m.featureCount <= 32 &&
    finiteVector(m.means, m.featureCount) &&
    m.means.every((v) => Math.abs(v) <= 1e6) &&
    finiteVector(m.scales, m.featureCount) &&
    m.scales.every((v) => v >= 0.0001 && v <= 1e6) &&
    finiteVector(m.weightsX, m.featureCount + 1) &&
    m.weightsX.every((v) => Math.abs(v) <= 1e6) &&
    finiteVector(m.weightsY, m.featureCount + 1) &&
    m.weightsY.every((v) => Math.abs(v) <= 1e6) &&
    Number.isInteger(m.samples) &&
    m.samples >= 9 &&
    m.samples <= 1e6 &&
    Number.isFinite(m.createdAt) &&
    m.createdAt > 0
  );
}

export function predictCalibration(
  model: CalibrationModel,
  features: number[],
): Point {
  if (!isCalibrationModel(model) || !finiteVector(features, model.featureCount))
    throw new Error("Calibration features do not match this profile.");
  const row = [
    1,
    ...features.map((v, j) => (v - model.means[j]) / model.scales[j]),
  ];
  return {
    x: clamp(row.reduce((sum, v, j) => sum + v * model.weightsX[j], 0)),
    y: clamp(row.reduce((sum, v, j) => sum + v * model.weightsY[j], 0)),
  };
}

/** A 0.15 error means 15% of a viewport side, not 85% tracking accuracy. */
export function validateCalibration(
  model: CalibrationModel,
  heldOut: CalibrationSample[],
  maxMeanError = 0.15,
): CalibrationValidation {
  if (!Number.isFinite(maxMeanError) || maxMeanError <= 0 || maxMeanError > 1)
    throw new Error("Invalid validation threshold.");
  if (heldOut.length < 3)
    return {
      meanError: 1,
      p95Error: 1,
      maxError: 1,
      passed: false,
      sampleCount: heldOut.length,
    };
  const errors = heldOut
    .map(({ features, target }) => {
      if (
        !Number.isFinite(target.x) ||
        !Number.isFinite(target.y) ||
        target.x < 0 ||
        target.x > 1 ||
        target.y < 0 ||
        target.y > 1
      )
        throw new Error("Invalid validation target.");
      const predicted = predictCalibration(model, features);
      return Math.hypot(predicted.x - target.x, predicted.y - target.y);
    })
    .sort((a, b) => a - b);
  const meanError =
    errors.reduce((sum, error) => sum + error, 0) / errors.length;
  const p95Error = errors[Math.ceil(errors.length * 0.95) - 1];
  return {
    meanError,
    p95Error,
    maxError: errors.at(-1)!,
    passed: meanError <= maxMeanError && p95Error <= maxMeanError * 1.7,
    sampleCount: errors.length,
  };
}

/** Timestamp-aware exponential smoother. Missing/stale samples reset its history. */
export class PointSmoother {
  private point: Point | null = null;
  private timestamp: number | null = null;
  constructor(
    private readonly tauMs = 90,
    private readonly staleMs = 350,
  ) {}
  reset(): void {
    this.point = null;
    this.timestamp = null;
  }
  update(point: Point, timestamp: number): Point {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      !Number.isFinite(timestamp)
    ) {
      this.reset();
      return { x: 0.5, y: 0.5 };
    }
    const dt = this.timestamp === null ? Infinity : timestamp - this.timestamp;
    if (!this.point || dt <= 0 || dt > this.staleMs)
      this.point = { x: clamp(point.x), y: clamp(point.y) };
    else {
      const alpha = 1 - Math.exp(-dt / Math.max(1, this.tauMs));
      this.point = {
        x: clamp(this.point.x + alpha * (point.x - this.point.x)),
        y: clamp(this.point.y + alpha * (point.y - this.point.y)),
      };
    }
    this.timestamp = timestamp;
    return { ...this.point };
  }
}
