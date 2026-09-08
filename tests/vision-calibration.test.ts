import { describe, expect, it } from "vitest";
import {
  fitCalibration,
  isCalibrationModel,
  PointSmoother,
  predictCalibration,
  validateCalibration,
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
