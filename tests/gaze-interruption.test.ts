import { describe, expect, it } from "vitest";
import type { Observation } from "../shared/types";
import { GazeCalibrationSession } from "../src/vision/calibration-session";

function frame(
  session: GazeCalibrationSession,
  timestamp: number,
  quality = 1,
): Observation {
  const { x, y } = session.current.target;
  return {
    x,
    y,
    timestamp,
    quality,
    gesture: false,
    features: [x * 0.1, y * 0.08, -x * 0.1, y * 0.08, 0.01, 0.01, 0.5, 0.5],
  };
}
function collecting(interval = 100, until = 1000) {
  const session = new GazeCalibrationSession(0);
  session.start(0);
  for (let now = 0; now <= until; now += interval)
    session.update(frame(session, now), now);
  expect(session.current.pointIndex).toBe(0);
  expect(session.current.samplesAtTarget).toBeGreaterThan(0);
  return session;
}

describe("bounded interruptions during gaze calibration", () => {
  it("keeps accepted samples through a brief blink at slow frame rates, then requires a new fixation", () => {
    const session = collecting(300, 1500);
    const samples = session.current.samplesAtTarget;
    const progress = session.current.progress;
    session.update(frame(session, 1800, 0), 1800);
    expect(session.current.status).toBe("paused");
    expect(session.current.samplesAtTarget).toBe(samples);
    expect(session.current.progress).toBe(progress);
    for (const now of [2100, 2400, 2700, 3000]) {
      session.update(frame(session, now), now);
      expect(session.current.status).toBe("settling");
      expect(session.current.samplesAtTarget).toBe(samples);
      expect(session.current.progress).toBe(progress);
    }
    session.update(frame(session, 3300), 3300);
    expect(session.current.samplesAtTarget).toBe(samples + 1);
    expect(session.current.progress).toBe(
      Math.min(300 / session.collectMs, (samples + 1) / session.minimumSamples),
    );
    for (
      let now = 3600;
      now <= 6000 && session.current.pointIndex === 0;
      now += 300
    )
      session.update(frame(session, now), now);
    expect(session.current.pointIndex).toBe(1);
    const target = session.diagnosticReport({ width: 1000, height: 800 })
      .collections[0];
    expect(target.samples).toBeGreaterThanOrEqual(10);
    expect(target.trackingLosses).toBe(1);
  });

  it.each([700, 701])(
    "bounds retained evidence to %i ms since the last usable frame",
    (gap) => {
      const session = collecting();
      const samples = session.current.samplesAtTarget;
      session.update(null, 1100);
      session.update(frame(session, 1000 + gap), 1000 + gap);
      expect(session.current.samplesAtTarget).toBe(gap <= 700 ? samples : 0);
      expect(session.current.status).toBe("settling");
    },
  );

  it("discards retained samples during a long loss even if no replacement frame arrives", () => {
    const session = collecting();
    session.update(null, 1100);
    expect(session.current.samplesAtTarget).toBeGreaterThan(0);
    session.update(null, 1701);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.progress).toBe(0);
    expect(session.current.pointIndex).toBe(0);
    expect(session.counts.training).toBe(0);
  });

  it("does not append a delayed stale frame or let it extend the retention deadline", () => {
    const session = collecting();
    const samples = session.current.samplesAtTarget;
    const progress = session.current.progress;
    session.update(frame(session, 1100), 1460);
    session.update(frame(session, 1200), 1560);
    expect(session.current.samplesAtTarget).toBe(samples);
    expect(session.current.progress).toBe(progress);
    session.update(frame(session, 1300), 1701);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.progress).toBe(0);
  });

  it.each([false, true])(
    "discards real eye motion immediately, including after a blink (%s)",
    (interrupted) => {
      const session = collecting();
      if (interrupted) session.update(null, 1100);
      const moved = frame(session, 1200);
      moved.features[0] += 1;
      session.update(moved, 1200);
      expect(session.current.samplesAtTarget).toBe(0);
      expect(session.current.progress).toBe(0);
      expect(session.current.status).toBe("paused");
    },
  );

  it("retains the original stable eye geometry through interruptions while settling", () => {
    const session = collecting();
    session.update(null, 1100);
    session.update(frame(session, 1200), 1200);
    session.update(null, 1300);
    const moved = frame(session, 1400);
    moved.features[0] += 1;
    session.update(moved, 1400);
    expect(session.current.samplesAtTarget).toBe(0);
    expect(session.current.progress).toBe(0);
  });

  it("excludes interruption and renewed settling time from the required collection duration", () => {
    const session = collecting();
    const samples = session.current.samplesAtTarget;
    const progress = session.current.progress;
    session.update(null, 1100);
    for (let now = 1400; now <= 2000; now += 100) {
      session.update(frame(session, now), now);
      expect(session.current.samplesAtTarget).toBe(samples);
      expect(session.current.progress).toBe(progress);
    }
    session.update(frame(session, 2100), 2100);
    expect(session.current.samplesAtTarget).toBe(samples + 1);
    expect(session.current.progress).toBe(progress);
    for (let now = 2200; now <= 2900; now += 100)
      session.update(frame(session, now), now);
    expect(session.current.samplesAtTarget).toBeGreaterThanOrEqual(10);
    expect(session.current.pointIndex).toBe(0);
    session.update(frame(session, 3000), 3000);
    expect(session.current.pointIndex).toBe(1);
  });

  it("never carries accepted samples, geometry, or collection time to another target", () => {
    const session = collecting();
    for (let now = 1100; now <= 1900; now += 100)
      session.update(frame(session, now), now);
    expect(session.current.pointIndex).toBe(1);
    const completedSamples = session.counts.training;
    expect(completedSamples).toBeGreaterThanOrEqual(10);
    expect(session.current.samplesAtTarget).toBe(0);
    session.update(null, 2000);
    for (let now = 2100; now <= 2700; now += 100) {
      session.update(frame(session, now), now);
      expect(session.current.samplesAtTarget).toBe(0);
      expect(session.current.progress).toBe(0);
      expect(session.counts.training).toBe(completedSamples);
    }
    session.update(frame(session, 2800), 2800);
    expect(session.current.samplesAtTarget).toBe(1);
    expect(session.current.progress).toBe(0);
  });
});
