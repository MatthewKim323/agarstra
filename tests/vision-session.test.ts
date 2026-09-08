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

const startedGaze = (now = 0) => {
  const session = new GazeCalibrationSession(now);
  session.start(now);
  return session;
};

describe("complete gaze calibration workflow", () => {
  it("waits for an explicit ready action without using up collection time", () => {
    const session = new GazeCalibrationSession(0);
    session.update(observation(session.current.target, 60000), 60000);
    expect(session.current.phase).toBe("ready");
    expect(session.counts).toEqual({ training: 0, heldOut: 0 });
    expect(session.model).toBe(null);
    expect(session.start(60000).phase).toBe("gaze");
    session.update(observation(session.current.target, 60100), 60100);
    expect(session.current.phase).toBe("gaze");
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.start(60200).pointIndex).toBe(0);
  });
  it("requires every training target and all separate validation targets before exposing a model", () => {
    const session = startedGaze();
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
    const session = startedGaze();
    const frame = observation(session.current.target, 700);
    for (let now = 700; now <= 26000; now += 100) session.update(frame, now);
    expect(session.current.phase).toBe("failed");
    expect(session.counts.training).toBe(0);
    expect(session.model).toBe(null);
  });
  it("never skips a target with insufficient distinct samples", () => {
    const session = startedGaze();
    session.update(observation(session.current.target, 0), 0);
    session.update(observation(session.current.target, 900), 900);
    session.update(observation(session.current.target, 1900), 1900);
    expect(session.current.pointIndex).toBe(0);
    expect(session.current.samplesAtTarget).toBe(0);
  });
  it("clears the current point on missing face and times out safely", () => {
    const session = startedGaze();
    for (let now = 0; now <= 1000; now += 100)
      session.update(observation(session.current.target, now), now);
    expect(session.current.samplesAtTarget).toBeGreaterThan(0);
    session.update(null, 1100);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.update(null, 26000).phase).toBe("failed");
    expect(session.model).toBe(null);
  });
  it("does not leak a fitted model when held-out validation fails", () => {
    const session = startedGaze();
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
    expect(session.current.validation?.targets).toHaveLength(5);
    expect(session.current.message).toContain("exceeds");
    expect(session.current.message).not.toContain("too variable");
    expect(session.model).toBe(null);
  });
  it("does not treat visible but alternating eye fixations as stable", () => {
    const session = startedGaze();
    for (let now = 0; now <= 5000; now += 100) {
      const frame = observation(session.current.target, now);
      frame.features = frame.features.map(
        (value, index) => value + (index < 4 ? (now % 200 ? 0.09 : -0.09) : 0),
      );
      session.update(frame, now);
    }
    expect(session.current.phase).toBe("gaze");
    expect(session.current.pointIndex).toBe(0);
    expect(session.current.status).toBe("paused");
    expect(session.counts.training).toBe(0);
  });
  it("explains a passing average with a failed tail without falsely calling it jitter", () => {
    const session = startedGaze();
    for (
      let now = 0;
      now <= 30000 && session.current.phase !== "done";
      now += 100
    ) {
      const state = session.current;
      const point =
        state.phase === "validation" && state.pointIndex === 0
          ? { x: state.target.x + 0.3, y: state.target.y }
          : state.target;
      session.update(observation(point, now), now);
    }
    expect(session.current.validation?.meanError).toBeLessThan(0.15);
    expect(session.current.validation?.p95Error).toBeGreaterThan(0.255);
    expect(session.current.validation?.failureReason).toBe("tail-error");
    expect(session.current.message).toMatch(/average error [0-9.]+ passes/);
    expect(session.current.message).toMatch(
      /95th-percentile error [0-9.]+ exceeds 0.255/,
    );
    expect(session.current.validation?.targets[0].dispersion).toBeLessThan(
      0.001,
    );
    expect(session.model).toBe(null);
  });
  it("discards an isolated saccade and restarts the current point without training on it", () => {
    const session = startedGaze();
    for (let now = 0; now <= 1100; now += 100)
      session.update(observation(session.current.target, now), now);
    expect(session.current.samplesAtTarget).toBeGreaterThan(0);
    const outlier = observation(session.current.target, 1200);
    outlier.features[0] += 1;
    session.update(outlier, 1200);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.status).toBe("paused");
    for (
      let now = 1300;
      now <= 3000 && session.current.pointIndex === 0;
      now += 100
    )
      session.update(observation(session.current.target, now), now);
    expect(session.current.pointIndex).toBe(1);
    const report = session.diagnosticReport({ width: 1200, height: 800 });
    expect(report.collections[0].rejectedFrames).toBeGreaterThanOrEqual(1);
    expect(report.collections[0].samples).toBeGreaterThanOrEqual(10);
  });
  it("does not accumulate stable time across a camera frame gap", () => {
    const session = startedGaze();
    for (let now = 0; now <= 1000; now += 100)
      session.update(observation(session.current.target, now), now);
    session.update(observation(session.current.target, 1600), 1600);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.progress).toBe(0);
  });
  it("collects a stable fixation with ordinary small camera noise", () => {
    const session = startedGaze();
    for (
      let now = 0;
      now <= 2200 && session.current.pointIndex === 0;
      now += 100
    ) {
      const frame = observation(session.current.target, now);
      frame.features = frame.features.map(
        (value, index) => value + Math.sin(now + index) * 0.002,
      );
      session.update(frame, now);
    }
    expect(session.current.pointIndex).toBe(1);
  });
  it("does not let high frame rates collapse the fixation window's duration", () => {
    const session = startedGaze();
    for (
      let now = 0;
      now <= 2500 && session.current.pointIndex === 0;
      now += 10
    )
      session.update(observation(session.current.target, now), now);
    expect(session.current.pointIndex).toBe(1);
    expect(session.counts.training).toBeGreaterThanOrEqual(10);
  });
  it.each([165, 200, 300, 333])(
    "collects a genuinely stable target when frames arrive every %i ms",
    (interval) => {
      const session = startedGaze();
      for (
        let now = 0;
        now <= 6000 && session.current.pointIndex === 0;
        now += interval
      ) {
        session.update(observation(session.current.target, now), now);
      }
      expect(session.current.pointIndex).toBe(1);
      expect(session.counts.training).toBeGreaterThanOrEqual(10);
      expect(session.model).toBeNull();
    },
  );
  it("does not reset collection when repeated UI polls age the previous delivered frame", () => {
    const session = startedGaze();
    // Model results arrive every 200 ms, with their original capture timestamp
    // 200 ms earlier. The UI polls every 70 ms, including between results.
    for (
      let now = 0;
      now <= 6000 && session.current.pointIndex === 0;
      now += 70
    ) {
      const timestamp = Math.floor((now - 200) / 200) * 200;
      session.update(
        timestamp < 0 ? null : observation(session.current.target, timestamp),
        now,
      );
    }
    expect(session.current.pointIndex).toBe(1);
    expect(session.counts.training).toBeGreaterThanOrEqual(10);
  });
  it("does not recount a recent delivery and still clears collection on a real arrival stall", () => {
    const session = startedGaze();
    for (let captured = 0; captured <= 1600; captured += 200)
      session.update(
        observation(session.current.target, captured),
        captured + 200,
      );
    const held = observation(session.current.target, 1600);
    const count = session.current.samplesAtTarget;
    const progress = session.current.progress;
    expect(count).toBeGreaterThan(0);
    session.update(held, 2020);
    expect(session.current.samplesAtTarget).toBe(count);
    expect(session.current.progress).toBe(progress);
    session.update(held, 2160);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.progress).toBe(0);
    expect(session.current.status).toBe("paused");
  });
  it("still rejects genuinely new captures that arrive too old", () => {
    const session = startedGaze();
    for (let now = 0; now <= 1000; now += 100)
      session.update(observation(session.current.target, now), now);
    expect(session.current.samplesAtTarget).toBeGreaterThan(0);
    session.update(observation(session.current.target, 1100), 1460);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.status).toBe("paused");
  });
  it("explains insufficient frame delivery without falsely blaming eye movement", () => {
    const session = startedGaze();
    for (let now = 0; now <= 26_000; now += 500)
      session.update(observation(session.current.target, now), now);
    expect(session.current.phase).toBe("failed");
    expect(session.current.message).toContain(
      "Not enough usable camera frames",
    );
    expect(session.current.message).not.toContain("steady eye signal");
    expect(session.model).toBeNull();
  });
  it("still clears slow-frame collection for an actual lost face or saccade", () => {
    for (const failure of ["face", "saccade"] as const) {
      const session = startedGaze();
      for (let now = 0; now <= 1500; now += 300)
        session.update(observation(session.current.target, now), now);
      expect(session.current.samplesAtTarget).toBeGreaterThan(0);
      const lost = observation(session.current.target, 1800);
      if (failure === "face") lost.quality = 0;
      else lost.features[0] += 1;
      session.update(lost, 1800);
      expect(session.current.samplesAtTarget).toBe(0);
      expect(session.current.progress).toBe(0);
      expect(session.current.status).toBe("paused");
    }
  });
  it("completes all fourteen independent targets with slow inference and frequent UI polling", () => {
    const session = startedGaze();
    let latest: Observation | null = null;
    let nextCapture = 0;
    for (
      let now = 0;
      now <= 100_000 && session.current.phase !== "done";
      now += 70
    ) {
      while (nextCapture + 200 <= now) {
        latest = observation(session.current.target, nextCapture);
        nextCapture += 300;
      }
      session.update(latest, now);
    }
    const report = session.diagnosticReport({ width: 1440, height: 900 });
    expect(session.current.phase).toBe("done");
    expect(session.current.validation?.passed).toBe(true);
    expect(report.collections).toHaveLength(14);
    expect(report.collections.every((target) => target.samples >= 10)).toBe(
      true,
    );
    expect(report.validation?.targets).toHaveLength(5);
    expect(report.thresholds).toEqual({ meanError: 0.15, p95Error: 0.255 });
  });
  it("accepts bounded expanded eye features but fails if their shape changes mid-run", () => {
    const session = startedGaze();
    for (let now = 0; now <= 1100; now += 100) {
      const frame = observation(session.current.target, now);
      frame.features.push(...Array(10).fill(now % 200 ? 1 : -1));
      session.update(frame, now);
    }
    expect(session.current.samplesAtTarget).toBeGreaterThan(0);
    session.update(observation(session.current.target, 1200), 1200);
    expect(session.current.phase).toBe("failed");
    expect(session.model).toBe(null);
  });
  it("exports target-level diagnostics without any biometric input arrays", () => {
    const session = startedGaze();
    for (
      let now = 0;
      now <= 30000 && session.current.phase !== "done";
      now += 100
    )
      session.update(observation(session.current.target, now), now);
    const report = session.diagnosticReport({ width: 1280, height: 800 });
    expect(report.collections).toHaveLength(14);
    expect(report.validation?.targets).toHaveLength(5);
    expect(report.passed).toBe(true);
    const serialized = JSON.stringify(report);
    for (const field of [
      "features",
      "landmarks",
      "image",
      "video",
      "weightsX",
      "means",
      "scales",
    ])
      expect(serialized).not.toContain(`"${field}"`);
    expect(report.thresholds).toEqual({ meanError: 0.15, p95Error: 0.255 });
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
