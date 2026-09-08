import type { CalibrationSample, Point } from "../../shared/types";

/** Screen coordinates and validation errors use 0..1 viewport units. */
export interface CalibrationModel {
  version: 1 | 2;
  featureCount: number;
  means: number[];
  scales: number[];
  weightsX: number[];
  weightsY: number[];
  samples: number;
  createdAt: number;
  /** Version 2 uses target landmarks as a compact, regularized kernel basis. */
  basis?: "linear" | "quadratic";
  activeFeatures?: number[];
  centers?: number[][];
  trainingDiagnostics?: CalibrationTrainingDiagnostics;
}

export interface CalibrationCandidateDiagnostic {
  modelFamily: "linear" | "quadratic";
  featureSet: string;
  ridge: number;
  meanError: number | null;
  maxTargetError: number | null;
}

export interface CalibrationTrainingDiagnostics {
  modelFamily: "linear" | "quadratic";
  featureSet: string;
  ridge: number;
  trainingTargets: number;
  trainingSamples: number;
  rejectedSamples: number;
  crossValidationError: number | null;
  /** Every fold excludes a whole training target, including normalization. */
  candidates: CalibrationCandidateDiagnostic[];
}

export interface CalibrationFitOptions {
  featureSets?: { name: string; indices: number[] }[];
}

export interface CalibrationTargetValidation {
  target: Point;
  predicted: Point;
  meanError: number;
  p95Error: number;
  maxError: number;
  sampleCount: number;
  /** RMS radial distance from the mean prediction, not from the target. */
  dispersion: number;
  bias: Point;
}

export interface CalibrationValidation {
  meanError: number;
  p95Error: number;
  maxError: number;
  passed: boolean;
  sampleCount: number;
  targets: CalibrationTargetValidation[];
  failureReason:
    | "insufficient-samples"
    | "mean-error"
    | "tail-error"
    | "mean-and-tail-error"
    | null;
}

export const clamp = (value: number, min = 0, max = 1): number =>
  Math.min(max, Math.max(min, value));
const finiteVector = (value: unknown, length?: number): value is number[] =>
  Array.isArray(value) &&
  (length === undefined || value.length === length) &&
  value.every((v) => typeof v === "number" && Number.isFinite(v));

const MAX_FEATURES = 128;
const MAX_TARGETS = 32;
const MAX_SAMPLES = 10_000;
const boundedVector = (value: unknown, length?: number): value is number[] =>
  finiteVector(value, length) && value.every((v) => Math.abs(v) <= 1e6);
const mean = (values: number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length;
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const percentile95 = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];

function groupSamples(samples: CalibrationSample[]): CalibrationSample[][] {
  const groups = new Map<string, CalibrationSample[]>();
  for (const sample of samples) {
    const key = `${sample.target.x}:${sample.target.y}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Reject isolated within-target excursions, never filter independent validation. */
function robustGroup(group: CalibrationSample[]): CalibrationSample[] {
  if (group.length < 6) return group;
  const dimensions = group[0].features.length;
  const centers = Array.from({ length: dimensions }, (_, j) =>
    median(group.map((sample) => sample.features[j])),
  );
  const scales = centers.map((center, j) =>
    Math.max(
      0.0001,
      1.4826 *
        median(group.map((sample) => Math.abs(sample.features[j] - center))),
    ),
  );
  const distances = group.map((sample) =>
    Math.sqrt(
      sample.features.reduce(
        (sum, value, j) => sum + ((value - centers[j]) / scales[j]) ** 2,
        0,
      ) / dimensions,
    ),
  );
  const typical = median(distances);
  const deviation =
    1.4826 * median(distances.map((value) => Math.abs(value - typical)));
  const limit = Math.max(4, typical + 6 * deviation);
  const retained = group.filter((_, index) => distances[index] <= limit);
  // Robust trimming must never manufacture a target from a tiny minority.
  return retained.length >= Math.ceil(group.length / 2) ? retained : group;
}

function kernel(
  a: number[],
  b: number[],
  basis: "linear" | "quadratic",
): number {
  const dot = a.reduce((sum, value, j) => sum + value * b[j], 0) / a.length;
  return basis === "quadratic" ? dot + dot * dot : dot;
}

function normalizedFeatures(
  model: CalibrationModel,
  features: number[],
): number[] {
  return (
    model.version === 2 ? model.activeFeatures! : features.map((_, j) => j)
  ).map((j) => (features[j] - model.means[j]) / model.scales[j]);
}

function predictUnchecked(model: CalibrationModel, features: number[]): Point {
  const normalized = normalizedFeatures(model, features);
  const row =
    model.version === 2
      ? [
          1,
          ...model.centers!.map((center) =>
            kernel(normalized, center, model.basis!),
          ),
        ]
      : [1, ...normalized];
  const x = row.reduce((sum, value, j) => sum + value * model.weightsX[j], 0);
  const y = row.reduce((sum, value, j) => sum + value * model.weightsY[j], 0);
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error(
      "Calibration prediction was not finite. Recalibrate before control.",
    );
  return { x: clamp(x), y: clamp(y) };
}

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

function fitGroups(
  groups: CalibrationSample[][],
  basis: "linear" | "quadratic",
  ridge: number,
  activeFeatures: number[],
): CalibrationModel {
  const featureCount = groups[0][0].features.length;
  // Each target has equal total weight even if its camera frame rate differed.
  const means = Array.from({ length: featureCount }, (_, j) =>
    mean(
      groups.map((group) => mean(group.map((sample) => sample.features[j]))),
    ),
  );
  const scales = means.map((center, j) =>
    Math.max(
      0.0001,
      Math.sqrt(
        mean(
          groups.map((group) =>
            mean(group.map((sample) => (sample.features[j] - center) ** 2)),
          ),
        ),
      ),
    ),
  );
  const centers = groups.map((group) =>
    activeFeatures.map(
      (j) =>
        (median(group.map((sample) => sample.features[j])) - means[j]) /
        scales[j],
    ),
  );
  const model: CalibrationModel = {
    version: 2,
    featureCount,
    means,
    scales,
    basis,
    activeFeatures: [...activeFeatures],
    centers,
    weightsX: [],
    weightsY: [],
    samples: groups.reduce((sum, group) => sum + group.length, 0),
    createdAt: Date.now(),
  };
  const size = centers.length + 1;
  const xtx = Array.from(
    { length: size },
    () => Array(size).fill(0) as number[],
  );
  const xtxTarget = {
    x: Array(size).fill(0) as number[],
    y: Array(size).fill(0) as number[],
  };
  for (const group of groups) {
    const weight = 1 / group.length;
    for (const sample of group) {
      const normalized = normalizedFeatures(model, sample.features);
      const row = [
        1,
        ...centers.map((center) => kernel(normalized, center, basis)),
      ];
      for (let a = 0; a < size; a++) {
        xtxTarget.x[a] += weight * row[a] * sample.target.x;
        xtxTarget.y[a] += weight * row[a] * sample.target.y;
        for (let b = 0; b < size; b++) xtx[a][b] += weight * row[a] * row[b];
      }
    }
  }
  for (let j = 1; j < size; j++) xtx[j][j] += ridge;
  model.weightsX = solve(xtx, xtxTarget.x);
  model.weightsY = solve(xtx, xtxTarget.y);
  return model;
}

/** Fit and select on training targets only. Independent validation is never refitted. */
export function fitCalibration(
  samples: CalibrationSample[],
  ridge = 0.1,
  options: CalibrationFitOptions = {},
): CalibrationModel {
  if (!Array.isArray(samples) || samples.length < 9)
    throw new Error("Calibration requires at least 9 valid observations.");
  if (samples.length > MAX_SAMPLES)
    throw new Error("Calibration has too many observations.");
  if (!Number.isFinite(ridge) || ridge <= 0 || ridge > 100)
    throw new Error("Ridge regularization must be positive and at most 100.");
  const featureCount = samples[0]?.features?.length ?? 0;
  if (featureCount < 2 || featureCount > MAX_FEATURES)
    throw new Error("Calibration needs 2 to 128 numeric features.");
  for (const sample of samples) {
    if (
      !sample ||
      !boundedVector(sample.features, featureCount) ||
      !sample.target ||
      !Number.isFinite(sample.target.x) ||
      !Number.isFinite(sample.target.y) ||
      sample.target.x < 0 ||
      sample.target.x > 1 ||
      sample.target.y < 0 ||
      sample.target.y > 1
    )
      throw new Error("Invalid calibration sample.");
  }
  const rawGroups = groupSamples(samples);
  if (rawGroups.length > MAX_TARGETS)
    throw new Error("Calibration supports at most 32 distinct targets.");
  const spanX =
    Math.max(...rawGroups.map((g) => g[0].target.x)) -
    Math.min(...rawGroups.map((g) => g[0].target.x));
  const spanY =
    Math.max(...rawGroups.map((g) => g[0].target.y)) -
    Math.min(...rawGroups.map((g) => g[0].target.y));
  if (spanX < 0.35 || spanY < 0.35)
    throw new Error(
      "Calibration targets must cover the screen in both directions.",
    );
  const groups = rawGroups.map(robustGroup);
  const featureSets = options.featureSets ?? [
    { name: "all", indices: Array.from({ length: featureCount }, (_, j) => j) },
  ];
  if (
    !Array.isArray(featureSets) ||
    featureSets.length < 1 ||
    featureSets.length > 4 ||
    featureSets.some(
      (set) =>
        !set ||
        typeof set.name !== "string" ||
        !set.name.length ||
        set.name.length > 40 ||
        !Array.isArray(set.indices) ||
        set.indices.length < 1 ||
        set.indices.length > featureCount ||
        new Set(set.indices).size !== set.indices.length ||
        set.indices.some(
          (j) => !Number.isInteger(j) || j < 0 || j >= featureCount,
        ),
    )
  )
    throw new Error("Invalid calibration feature sets.");

  const candidates: (CalibrationCandidateDiagnostic & { indices: number[] })[] =
    [];
  for (const featureSet of featureSets) {
    for (const basis of ["linear", "quadratic"] as const) {
      for (const multiplier of [0.001, 0.01, 0.1, 1, 10]) {
        const strength = Math.max(1e-6, ridge * multiplier);
        const errors: number[] = [];
        // Holding out frames from the same target would leak the target identity.
        // Refit scaling and all kernel centers without the entire omitted target.
        if (groups.length >= 4) {
          for (let held = 0; held < groups.length; held++) {
            const fold = fitGroups(
              groups.filter((_, j) => j !== held),
              basis,
              strength,
              featureSet.indices,
            );
            errors.push(
              mean(
                groups[held].map((sample) => {
                  const point = predictUnchecked(fold, sample.features);
                  return Math.hypot(
                    point.x - sample.target.x,
                    point.y - sample.target.y,
                  );
                }),
              ),
            );
          }
        }
        candidates.push({
          modelFamily: basis,
          featureSet: featureSet.name,
          indices: featureSet.indices,
          ridge: strength,
          meanError: errors.length ? mean(errors) : null,
          maxTargetError: errors.length ? Math.max(...errors) : null,
        });
      }
    }
  }
  const scored = candidates.filter((candidate) => candidate.meanError !== null);
  let selected = candidates[0];
  if (scored.length) {
    const bestError = Math.min(
      ...scored.map((candidate) => candidate.meanError!),
    );
    // Prefer the simpler family unless curvature improves held-target prediction.
    // Among equivalent candidates, favor stronger regularization and fewer inputs.
    const nearBest = scored.filter(
      (candidate) =>
        candidate.meanError! <= bestError + Math.max(0.001, bestError * 0.05),
    );
    nearBest.sort(
      (a, b) =>
        Number(a.modelFamily === "quadratic") -
          Number(b.modelFamily === "quadratic") ||
        a.indices.length - b.indices.length ||
        b.ridge - a.ridge ||
        a.meanError! - b.meanError!,
    );
    selected = nearBest[0];
  }
  const model = fitGroups(
    groups,
    selected.modelFamily,
    selected.ridge,
    selected.indices,
  );
  model.trainingDiagnostics = {
    modelFamily: selected.modelFamily,
    featureSet: selected.featureSet,
    ridge: selected.ridge,
    trainingTargets: groups.length,
    trainingSamples: samples.length,
    rejectedSamples: samples.length - model.samples,
    crossValidationError: selected.meanError,
    candidates: candidates.map(
      ({ indices: _indices, ...candidate }) => candidate,
    ),
  };
  if (!isCalibrationModel(model))
    throw new Error("Calibration produced an invalid model. Please retry.");
  return model;
}

export function isCalibrationModel(value: unknown): value is CalibrationModel {
  if (!value || typeof value !== "object") return false;
  const m = value as CalibrationModel;
  return (
    (m.version === 1 || m.version === 2) &&
    Number.isInteger(m.featureCount) &&
    m.featureCount >= 2 &&
    m.featureCount <= (m.version === 1 ? 32 : MAX_FEATURES) &&
    finiteVector(m.means, m.featureCount) &&
    m.means.every((v) => Math.abs(v) <= 1e6) &&
    finiteVector(m.scales, m.featureCount) &&
    m.scales.every((v) => v >= 0.0001 && v <= 1e6) &&
    (m.version === 1 ||
      ((m.basis === "linear" || m.basis === "quadratic") &&
        Array.isArray(m.activeFeatures) &&
        m.activeFeatures.length > 0 &&
        m.activeFeatures.length <= m.featureCount &&
        new Set(m.activeFeatures).size === m.activeFeatures.length &&
        m.activeFeatures.every(
          (j) => Number.isInteger(j) && j >= 0 && j < m.featureCount,
        ) &&
        Array.isArray(m.centers) &&
        m.centers.length >= 1 &&
        m.centers.length <= MAX_TARGETS &&
        m.centers.every((center) =>
          boundedVector(center, m.activeFeatures!.length),
        ))) &&
    finiteVector(
      m.weightsX,
      m.version === 1 ? m.featureCount + 1 : m.centers!.length + 1,
    ) &&
    m.weightsX.every((v) => Math.abs(v) <= 1e6) &&
    finiteVector(
      m.weightsY,
      m.version === 1 ? m.featureCount + 1 : m.centers!.length + 1,
    ) &&
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
  if (
    !isCalibrationModel(model) ||
    !boundedVector(features, model.featureCount)
  )
    throw new Error("Calibration features do not match this profile.");
  return predictUnchecked(model, features);
}

/** A 0.15 error means 15% of a viewport side, not 85% tracking accuracy. */
export function validateCalibration(
  model: CalibrationModel,
  heldOut: CalibrationSample[],
  maxMeanError = 0.15,
): CalibrationValidation {
  if (!Number.isFinite(maxMeanError) || maxMeanError <= 0 || maxMeanError > 1)
    throw new Error("Invalid validation threshold.");
  if (!Array.isArray(heldOut) || heldOut.length > MAX_SAMPLES)
    throw new Error("Invalid validation observations.");
  if (!isCalibrationModel(model)) throw new Error("Invalid calibration model.");
  if (heldOut.length < 3)
    return {
      meanError: 1,
      p95Error: 1,
      maxError: 1,
      passed: false,
      sampleCount: heldOut.length,
      targets: [],
      failureReason: "insufficient-samples",
    };
  const predictions = heldOut.map((sample) => {
    if (!sample || !sample.target)
      throw new Error("Invalid validation target.");
    const { features, target } = sample;
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
    return {
      target,
      predicted,
      error: Math.hypot(predicted.x - target.x, predicted.y - target.y),
    };
  });
  const errors = predictions.map((prediction) => prediction.error);
  const targetGroups = new Map<string, typeof predictions>();
  for (const prediction of predictions) {
    const key = `${prediction.target.x}:${prediction.target.y}`;
    const group = targetGroups.get(key) ?? [];
    group.push(prediction);
    targetGroups.set(key, group);
  }
  const targets = [...targetGroups.values()].map(
    (group): CalibrationTargetValidation => {
      const target = { ...group[0].target };
      const predicted = {
        x: mean(group.map((p) => p.predicted.x)),
        y: mean(group.map((p) => p.predicted.y)),
      };
      const targetErrors = group.map((p) => p.error);
      return {
        target,
        predicted,
        meanError: mean(targetErrors),
        p95Error: percentile95(targetErrors),
        maxError: Math.max(...targetErrors),
        sampleCount: group.length,
        dispersion: Math.sqrt(
          mean(
            group.map(
              (p) =>
                (p.predicted.x - predicted.x) ** 2 +
                (p.predicted.y - predicted.y) ** 2,
            ),
          ),
        ),
        bias: { x: predicted.x - target.x, y: predicted.y - target.y },
      };
    },
  );
  const meanError = mean(errors);
  const p95Error = percentile95(errors);
  const meanFailed = meanError > maxMeanError;
  const tailFailed = p95Error > maxMeanError * 1.7;
  return {
    meanError,
    p95Error,
    maxError: Math.max(...errors),
    passed: !meanFailed && !tailFailed,
    sampleCount: errors.length,
    targets,
    failureReason:
      meanFailed && tailFailed
        ? "mean-and-tail-error"
        : meanFailed
          ? "mean-error"
          : tailFailed
            ? "tail-error"
            : null,
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
