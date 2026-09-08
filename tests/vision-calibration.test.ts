import { describe, expect, it } from "vitest";
import {
  fitCalibration,
  isCalibrationModel,
  PointSmoother,
  predictCalibration,
  validateCalibration,
  type CalibrationModel,
} from "../src/vision/calibration";
import type { CalibrationSample } from "../shared/types";

const sample = (x: number, y: number): CalibrationSample => ({
  features: [x * 0.4 + 0.1, y * 0.3 - 0.2, x + y, 0.1],
  target: { x, y },
});
const training = [0.1, 0.5, 0.9].flatMap((x) =>
  [0.1, 0.5, 0.9].map((y) => sample(x, y)),
);
const heldOut = [
  [0.25, 0.3],
  [0.7, 0.2],
  [0.8, 0.75],
  [0.35, 0.8],
].map(([x, y]) => sample(x, y));

describe("ridge calibration", () => {
  it("learns screen mapping with collinear and constant features", () => {
    const model = fitCalibration(training);
    expect(isCalibrationModel(model)).toBe(true);
    const prediction = predictCalibration(model, sample(0.7, 0.3).features);
    expect(prediction.x).toBeCloseTo(0.7, 2);
    expect(prediction.y).toBeCloseTo(0.3, 2);
  });
  it("passes independently collected held-out samples", () => {
    const validation = validateCalibration(fitCalibration(training), heldOut);
    expect(validation.passed).toBe(true);
    expect(validation.meanError).toBeLessThan(0.02);
    expect(validation.sampleCount).toBe(4);
  });
  it("fails holdout when posture or mapping changes", () => {
    const shifted = heldOut.map((s) => ({
      features: s.features,
      target: { x: 1 - s.target.x, y: 1 - s.target.y },
    }));
    expect(validateCalibration(fitCalibration(training), shifted).passed).toBe(
      false,
    );
  });
  it("does not mistake fitting a constant feature for validated gaze", () => {
    const constants = training.map((s) => ({ ...s, features: [1, 1] }));
    const model = fitCalibration(constants);
    const validation = validateCalibration(
      model,
      training.map((s) => ({ ...s, features: [1, 1] })),
    );
    expect(validation.passed).toBe(false);
  });
  it("requires target coverage, finite observations and sufficient samples", () => {
    expect(() => fitCalibration(training.slice(0, 3))).toThrow(/at least 9/);
    expect(() =>
      fitCalibration(
        training.map((s) => ({ ...s, target: { x: 0.5, y: 0.5 } })),
      ),
    ).toThrow(/cover/);
    expect(() =>
      fitCalibration(training.map((s) => ({ ...s, features: [NaN, 1] }))),
    ).toThrow(/Invalid/);
    expect(() => fitCalibration(training, 0)).toThrow(/positive/);
  });
  it("rejects corrupt profiles and feature mismatch", () => {
    const model = fitCalibration(training);
    expect(isCalibrationModel({ ...model, scales: [0, 0, 0, 0] })).toBe(false);
    expect(isCalibrationModel({ ...model, weightsX: [Infinity] })).toBe(false);
    expect(() => predictCalibration(model, [1, 2])).toThrow(/match/);
  });
  it("clamps extrapolation to the viewport", () => {
    const model = fitCalibration(training);
    const point = predictCalibration(model, sample(4, -4).features);
    expect(point.x).toBe(1);
    expect(point.y).toBe(0);
  });
  it("refuses to validate on too few held-out samples", () => {
    expect(
      validateCalibration(fitCalibration(training), heldOut.slice(0, 2)).passed,
    ).toBe(false);
  });
});

describe("smoothing", () => {
  it("smooths motion but resets after a stale gap", () => {
    const smoother = new PointSmoother(100, 350);
    expect(smoother.update({ x: 0, y: 0 }, 0)).toEqual({ x: 0, y: 0 });
    const smoothed = smoother.update({ x: 1, y: 1 }, 50);
    expect(smoothed.x).toBeGreaterThan(0);
    expect(smoothed.x).toBeLessThan(1);
    expect(smoother.update({ x: 1, y: 1 }, 1000)).toEqual({ x: 1, y: 1 });
  });
  it("clears invalid coordinates", () => {
    const smoother = new PointSmoother();
    expect(smoother.update({ x: NaN, y: 0 }, 0)).toEqual({ x: 0.5, y: 0.5 });
    expect(smoother.update({ x: 0.9, y: 0.1 }, 1)).toEqual({ x: 0.9, y: 0.1 });
  });
});

describe("robust calibration regressions", () => {
  // Synthetic geometry only: these fixtures are not evidence of human gaze accuracy.
  const curved = (u: number, v: number): CalibrationSample => ({
    features: [u, v, u + v, 0.2],
    target: {
      x: 0.43 + 0.35 * u + 0.14 * u * u,
      y: 0.43 + 0.35 * v + 0.14 * v * v,
    },
  });
  const curvedTraining = [-1, 0, 1].flatMap((u) =>
    [-1, 0, 1].map((v) => curved(u, v)),
  );
  const curvedHoldout = [
    [-0.6, -0.4],
    [0.5, -0.7],
    [0.7, 0.6],
    [-0.3, 0.5],
  ].map(([u, v]) => curved(u, v));

  it("learns a curved mapping without fitting on validation targets", () => {
    const model = fitCalibration(curvedTraining);
    const validation = validateCalibration(model, curvedHoldout);
    expect(validation.meanError).toBeLessThan(0.015);
    expect(model.trainingDiagnostics?.modelFamily).toBe("quadratic");
    expect(model.trainingDiagnostics?.trainingTargets).toBe(9);
  });

  it("does not let a transient feature spike dominate a calibration target", () => {
    const repeated = training.flatMap((s) =>
      Array.from({ length: 12 }, () => ({
        features: [...s.features],
        target: { ...s.target },
      })),
    );
    repeated.push({
      ...training[0],
      features: [12, -10, 20, 0.1],
    });
    const model = fitCalibration(repeated);
    expect(validateCalibration(model, heldOut).meanError).toBeLessThan(0.025);
    expect(model.trainingDiagnostics?.rejectedSamples).toBe(1);
  });

  it("reports each validation target's bias separately from jitter", () => {
    const model = fitCalibration(training);
    const validation = validateCalibration(model, heldOut);
    expect(validation.targets).toHaveLength(4);
    expect(validation.targets[0].target).toEqual(heldOut[0].target);
    expect(validation.targets[0].sampleCount).toBe(1);
    expect(validation.targets[0].dispersion).toBe(0);
    expect(validation.failureReason).toBeNull();
  });

  it("accepts bounded appearance features instead of rejecting more than 32", () => {
    const expanded = training.map((s) => ({
      ...s,
      features: Array.from({ length: 64 }, (_, i) => s.features[i % 4]),
    }));
    const model = fitCalibration(expanded);
    expect(isCalibrationModel(model)).toBe(true);
    expect(model.featureCount).toBe(64);
    expect(() =>
      fitCalibration(
        training.map((s) => ({ ...s, features: Array(129).fill(0) })),
      ),
    ).toThrow(/128/);
  });

  it("weights each target equally regardless of duplicated frames", () => {
    const baseline = fitCalibration(training);
    const uneven = fitCalibration([
      ...training,
      ...Array.from({ length: 200 }, () => ({ ...training[0] })),
    ]);
    for (const sample of heldOut) {
      const a = predictCalibration(baseline, sample.features);
      const b = predictCalibration(uneven, sample.features);
      expect(a.x).toBeCloseTo(b.x, 8);
      expect(a.y).toBeCloseTo(b.y, 8);
    }
    expect(uneven.trainingDiagnostics?.trainingTargets).toBe(9);
  });

  it("compares feature views using whole-target training cross-validation", () => {
    // View zero is deliberately uninformative; view one has the real mapping.
    const augmented = training.map((sample) => ({
      ...sample,
      features: [0.2, 0.7, ...sample.features],
    }));
    const model = fitCalibration(augmented, 0.1, {
      featureSets: [
        { name: "uninformative", indices: [0, 1] },
        { name: "informative", indices: [2, 3] },
        { name: "fused", indices: [0, 1, 2, 3, 4, 5] },
      ],
    });
    expect(model.trainingDiagnostics?.featureSet).toBe("informative");
    expect(model.trainingDiagnostics?.modelFamily).toBe("linear");
    expect(model.activeFeatures).toEqual([2, 3]);
    expect(model.trainingDiagnostics?.candidates).toHaveLength(30);
  });

  it("never refits a failed independent check or mutates the training samples", () => {
    const original = JSON.stringify(training);
    const model = fitCalibration(training);
    const before = JSON.stringify(model);
    const failed = heldOut.map((sample) => ({
      ...sample,
      target: { x: 1 - sample.target.x, y: 1 - sample.target.y },
    }));
    expect(validateCalibration(model, failed).passed).toBe(false);
    expect(JSON.stringify(model)).toBe(before);
    expect(JSON.stringify(training)).toBe(original);
  });

  it("does not report target memorization as good cross-validation", () => {
    // A random frame split would leak these one-hot target identities into both sets.
    const memorized = training.flatMap((sample, targetIndex) =>
      Array.from({ length: 12 }, () => ({
        target: { ...sample.target },
        features: Array.from({ length: 9 }, (_, featureIndex) =>
          targetIndex === featureIndex ? 1 : 0,
        ),
      })),
    );
    const model = fitCalibration(memorized);
    expect(model.trainingDiagnostics?.crossValidationError).toBeGreaterThan(
      0.25,
    );
    expect(model.trainingDiagnostics?.trainingTargets).toBe(9);
    expect(model.trainingDiagnostics?.trainingSamples).toBe(108);
  });

  it("rejects malformed feature views and oversized inputs", () => {
    for (const indices of [[], [0, 0], [-1], [4], [0.5]]) {
      expect(() =>
        fitCalibration(training, 0.1, {
          featureSets: [{ name: "invalid", indices }],
        }),
      ).toThrow(/feature sets/);
    }
    expect(() => fitCalibration(Array(10_001).fill(training[0]))).toThrow(
      /too many/,
    );
    expect(() =>
      fitCalibration(training.map((s) => ({ ...s, features: [1e100, 1] }))),
    ).toThrow(/Invalid/);
    const model = fitCalibration(training);
    expect(() => predictCalibration(model, [1e100, 0, 0, 0])).toThrow(/match/);
  });

  it("rejects corrupt version-two kernel metadata", () => {
    const model = fitCalibration(training);
    expect(isCalibrationModel({ ...model, centers: [[NaN]] })).toBe(false);
    expect(isCalibrationModel({ ...model, activeFeatures: [0, 0] })).toBe(
      false,
    );
    expect(isCalibrationModel({ ...model, activeFeatures: [200] })).toBe(false);
    expect(isCalibrationModel({ ...model, basis: "unknown" })).toBe(false);
    expect(isCalibrationModel({ ...model, centers: undefined })).toBe(false);
  });

  const legacyIdentity: CalibrationModel = {
    version: 1,
    featureCount: 2,
    means: [0, 0],
    scales: [1, 1],
    weightsX: [0, 1, 0],
    weightsY: [0, 0, 1],
    samples: 9,
    createdAt: 1,
  };

  it("keeps version-one profiles readable with their original linear semantics", () => {
    expect(isCalibrationModel(legacyIdentity)).toBe(true);
    expect(predictCalibration(legacyIdentity, [0.3, 0.7])).toEqual({
      x: 0.3,
      y: 0.7,
    });
    expect(
      predictCalibration(
        { ...legacyIdentity, activeFeatures: [1] },
        [0.3, 0.7],
      ),
    ).toEqual({ x: 0.3, y: 0.7 });
  });

  it("still rejects the reported .138 mean and .295 tail failure", () => {
    const samples = [0.295, 0.09875, 0.09875, 0.09875, 0.09875].map(
      (error) => ({
        features: [0.5 + error, 0.5],
        target: { x: 0.5, y: 0.5 },
      }),
    );
    const validation = validateCalibration(legacyIdentity, samples);
    expect(validation.meanError).toBeCloseTo(0.138, 6);
    expect(validation.p95Error).toBeCloseTo(0.295, 6);
    expect(validation.passed).toBe(false);
    expect(validation.failureReason).toBe("tail-error");
  });

  it("distinguishes a stable offset from a shaky target", () => {
    const stable = [0, 1, 2].map(() => ({
      features: [0.7, 0.5],
      target: { x: 0.5, y: 0.5 },
    }));
    const shaky = [-0.2, 0, 0.2].map((offset) => ({
      features: [0.5 + offset, 0.5],
      target: { x: 0.5, y: 0.5 },
    }));
    const stableResult = validateCalibration(legacyIdentity, stable).targets[0];
    const shakyResult = validateCalibration(legacyIdentity, shaky).targets[0];
    expect(stableResult.bias.x).toBeCloseTo(0.2);
    expect(stableResult.dispersion).toBeCloseTo(0);
    expect(shakyResult.bias.x).toBeCloseTo(0);
    expect(shakyResult.dispersion).toBeGreaterThan(0.15);
  });

  it("identifies aggregate error separately from the worst-case tail", () => {
    const validationForError = (error: number) =>
      validateCalibration(
        legacyIdentity,
        [0, 1, 2].map(() => ({
          features: [0.5 + error, 0.5],
          target: { x: 0.5, y: 0.5 },
        })),
      );
    expect(validationForError(0.2).failureReason).toBe("mean-error");
    expect(validationForError(0.3).failureReason).toBe("mean-and-tail-error");
    expect(validateCalibration(legacyIdentity, []).failureReason).toBe(
      "insufficient-samples",
    );
  });

  it("refuses malformed validation inputs without changing the model", () => {
    expect(() => validateCalibration(legacyIdentity, heldOut, 0)).toThrow(
      /threshold/,
    );
    expect(() =>
      validateCalibration(legacyIdentity, Array(10_001).fill(heldOut[0])),
    ).toThrow(/observations/);
    expect(() =>
      validateCalibration(legacyIdentity, [
        null,
        null,
        null,
      ] as unknown as CalibrationSample[]),
    ).toThrow(/target/);
    expect(() =>
      validateCalibration({ ...legacyIdentity, scales: [0, 0] }, []),
    ).toThrow(/model/);
  });
});
