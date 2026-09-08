import { describe, expect, it } from "vitest";
import {
  GazeCalibrationSession,
  GestureCalibrationSession,
  GAZE_TRAIN_TARGETS,
  GAZE_VALIDATION_TARGETS,
} from "../src/vision/calibration-session";
import type { Observation, Point } from "../shared/types";

const observation = (
  point: Point,
  timestamp: number,
  strength = 0.1,
  quality = 1,
): Observation => ({
  x: point.x,
  y: point.y,
  timestamp,
  quality,
  gesture: false,
  gestureStrength: strength,
  features: [
    point.x * 0.3,
    point.y * 0.2,
    point.x + point.y,
    point.x - point.y,
    0.1,
    0.1,
    0.5,
    0.5,
  ],
});

describe("complete gaze calibration workflow", () => {
  it("requires every training target and all separate validation targets before exposing a model", () => {
    const session = new GazeCalibrationSession(0);
    const seenTraining = new Set<number>();
    const seenValidation = new Set<number>();
    for (let now = 0; now <= 30000; now += 100) {
      const state = session.current;
      if (state.phase === "done") break;
      if (state.phase === "gaze") seenTraining.add(state.pointIndex);
      if (state.phase === "validation") seenValidation.add(state.pointIndex);
      expect(session.model).toBe(null);
      session.update(observation(state.target, now), now);
    }
    expect(seenTraining.size).toBe(GAZE_TRAIN_TARGETS.length);
    expect(seenValidation.size).toBe(GAZE_VALIDATION_TARGETS.length);
    expect(session.current.phase).toBe("done");
    expect(session.current.validation?.passed).toBe(true);
    expect(session.model).not.toBe(null);
    expect(session.counts.training).toBeGreaterThanOrEqual(9 * 8);
    expect(session.counts.heldOut).toBeGreaterThanOrEqual(5 * 8);
  });
  it("cannot complete from a single reused frame", () => {
    const session = new GazeCalibrationSession(0);
    const frame = observation(session.current.target, 700);
    for (let now = 700; now <= 16000; now += 100) session.update(frame, now);
    expect(session.current.phase).toBe("failed");
    expect(session.counts.training).toBe(0);
    expect(session.model).toBe(null);
  });
  it("never skips a target with insufficient distinct samples", () => {
    const session = new GazeCalibrationSession(0);
    session.update(observation(session.current.target, 0), 0);
    session.update(observation(session.current.target, 900), 900);
    session.update(observation(session.current.target, 1900), 1900);
    expect(session.current.pointIndex).toBe(0);
    expect(session.current.samplesAtTarget).toBe(2);
  });
  it("clears the current point on missing face and times out safely", () => {
    const session = new GazeCalibrationSession(0);
    for (let now = 0; now <= 1000; now += 100)
      session.update(observation(session.current.target, now), now);
    expect(session.current.samplesAtTarget).toBeGreaterThan(0);
    session.update(null, 1100);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.update(null, 16000).phase).toBe("failed");
    expect(session.model).toBe(null);
  });
  it("does not leak a fitted model when held-out validation fails", () => {
    const session = new GazeCalibrationSession(0);
    for (
      let now = 0;
      now <= 30000 && session.current.phase !== "done";
      now += 100
    ) {
      const state = session.current;
      const point =
        state.phase === "validation"
          ? { x: 1 - state.target.x, y: 1 - state.target.y }
          : state.target;
      session.update(observation(point, now), now);
    }
    expect(session.current.phase).toBe("done");
    expect(session.current.validation?.passed).toBe(false);
    expect(session.model).toBe(null);
  });
  it("rejects a nonmonotonic clock instead of carrying elapsed dwell", () => {
    const session = new GazeCalibrationSession(1000);
    expect(session.update(null, 900).phase).toBe("failed");
  });
});

describe("complete gesture calibration workflow", () => {
  it("collects rest and deliberate action separately and only then exposes thresholds", () => {
    const session = new GestureCalibrationSession("jawOpen", 0);
    for (
      let now = 0;
      now <= 9000 && session.current.phase !== "done";
      now += 100
    ) {
      expect(session.config).toBe(null);
      session.update(
        observation(
          { x: 0.5, y: 0.5 },
          now,
          session.current.phase === "neutral" ? 0.1 : 0.8,
        ),
        now,
      );
    }
    expect(session.current.phase).toBe("done");
    expect(session.config?.activate).toBeGreaterThan(0.1);
  });
  it("lets natural blinking pause recording without contaminating samples", () => {
    const session = new GestureCalibrationSession("mouthSmile", 0);
    for (
      let now = 0;
      now <= 10000 && session.current.phase !== "done";
      now += 100
    ) {
      const blink = now === 2200 || now === 2300 || now === 7000;
      session.update(
        observation(
          { x: 0.5, y: 0.5 },
          now,
          session.current.phase === "neutral" ? 0.1 : 0.8,
          blink ? 0 : 1,
        ),
        now,
      );
    }
    expect(session.current.phase).toBe("done");
    expect(session.config?.kind).toBe("mouthSmile");
  });
  it("times out for missing face and rejects indistinct recordings", () => {
    const missing = new GestureCalibrationSession("jawOpen", 0);
    expect(missing.update(null, 21000).phase).toBe("failed");
    expect(missing.config).toBe(null);
    const indistinct = new GestureCalibrationSession("jawOpen", 0);
    for (let now = 0; now <= 9000; now += 100)
      indistinct.update(observation({ x: 0.5, y: 0.5 }, now, 0.1), now);
    expect(indistinct.current.phase).toBe("failed");
    expect(indistinct.config).toBe(null);
  });
});
