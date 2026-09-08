import { afterEach, describe, expect, it, vi } from "vitest";
import * as calibration from "../src/vision/calibration";
import {
  GazeCalibrationSession,
  GAZE_VALIDATION_TARGETS,
} from "../src/vision/calibration-session";
import type { Observation, Point } from "../shared/types";

const model = (): calibration.CalibrationModel => ({
  version: 1,
  featureCount: 2,
  means: [0, 0],
  scales: [1, 1],
  weightsX: [0, 1, 0],
  weightsY: [0, 0, 1],
  samples: 90,
  createdAt: 1,
});
const observation = (point: Point, timestamp: number): Observation => ({
  // Raw eye features, not already-smoothed x/y, must be used to validate.
  x: 0.5,
  y: 0.5,
  quality: 1,
  timestamp,
  gesture: false,
  features: [point.x, point.y],
});

function finish(session: GazeCalibrationSession, reverse = false) {
  const points = new Set<number>();
  for (
    let now = 0;
    now <= 15000 && session.current.phase !== "done";
    now += 100
  ) {
    const state = session.current;
    expect(state.phase).toBe("validation");
    expect(session.model).toBeNull();
    points.add(state.pointIndex);
    const target = reverse
      ? { x: 1 - state.target.x, y: 1 - state.target.y }
      : state.target;
    session.update(observation(target, now), now);
  }
  expect(points.size).toBe(GAZE_VALIDATION_TARGETS.length);
}

afterEach(() => vi.restoreAllMocks());

describe("independent saved gaze model recheck", () => {
  it("collects five fresh targets without fitting or changing the saved model", () => {
    const fit = vi.spyOn(calibration, "fitCalibration");
    const saved = model();
    const before = structuredClone(saved);
    const session = new GazeCalibrationSession(0, { validationModel: saved });
    expect(session.kind).toBe("recheck");
    expect(session.current.targetCount).toBe(5);
    expect(session.model).toBeNull();
    expect(session.start(0).phase).toBe("validation");
    finish(session);
    expect(session.current.validation?.passed).toBe(true);
    expect(session.current.validation?.meanError).toBeCloseTo(0, 10);
    expect(session.model).toEqual(before);
    expect(saved).toEqual(before);
    expect(session.counts.training).toBe(0);
    expect(session.counts.heldOut).toBeGreaterThanOrEqual(50);
    expect(fit).not.toHaveBeenCalled();
  });

  it("takes an immutable snapshot before check observations arrive", () => {
    const saved = model();
    const session = new GazeCalibrationSession(0, { validationModel: saved });
    saved.weightsX[1] = -10;
    saved.means[0] = 100;
    session.start(0);
    finish(session);
    expect(session.current.validation?.passed).toBe(true);
    expect(session.model).toEqual(model());
  });

  it("rejects an inaccurate saved mapping and never exposes it as ready", () => {
    const fit = vi.spyOn(calibration, "fitCalibration");
    const saved = model();
    const session = new GazeCalibrationSession(0, { validationModel: saved });
    session.start(0);
    finish(session, true);
    expect(session.current.phase).toBe("done");
    expect(session.current.validation?.passed).toBe(false);
    expect(session.model).toBeNull();
    expect(saved).toEqual(model());
    expect(session.counts.training).toBe(0);
    expect(fit).not.toHaveBeenCalled();
  });

  it("cannot reuse the previous check or one repeated capture", () => {
    const session = new GazeCalibrationSession(0, { validationModel: model() });
    session.start(0);
    const frame = observation(session.current.target, 700);
    for (let now = 700; now <= 26000; now += 100) session.update(frame, now);
    expect(session.current.phase).toBe("failed");
    expect(session.model).toBeNull();
    expect(session.counts).toEqual({ training: 0, heldOut: 0 });
  });

  it("rejects corrupt models and changes in feature format", () => {
    expect(
      () =>
        new GazeCalibrationSession(0, {
          validationModel: { ...model(), weightsX: [] },
        }),
    ).toThrow("saved gaze calibration is invalid");
    const session = new GazeCalibrationSession(0, { validationModel: model() });
    session.start(0);
    session.update(
      { ...observation(session.current.target, 100), features: [0, 0, 0] },
      100,
    );
    expect(session.current.phase).toBe("failed");
    expect(session.current.message).toContain("feature format changed");
    expect(session.model).toBeNull();
  });
});
