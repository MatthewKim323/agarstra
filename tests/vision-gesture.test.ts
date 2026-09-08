import { describe, expect, it } from "vitest";
import {
  calibrateGesture,
  GestureDetector,
  isGestureConfig,
  type GestureConfig,
} from "../src/vision/gesture";

const config: GestureConfig = {
  kind: "jawOpen",
  activate: 0.6,
  release: 0.3,
  holdMs: 500,
  releaseMs: 200,
  cooldownMs: 800,
};
function feed(
  detector: GestureDetector,
  score: number,
  from: number,
  through: number,
): boolean[] {
  const results = [];
  for (let t = from; t <= through; t += 100)
    results.push(detector.update(score, t));
  return results;
}

describe("deliberate gesture calibration", () => {
  it("derives separated thresholds from neutral and active distributions", () => {
    const learned = calibrateGesture(
      Array(20).fill(0.1),
      Array(20).fill(0.8),
      "browInnerUp",
    );
    expect(isGestureConfig(learned)).toBe(true);
    expect(learned.release).toBeLessThan(learned.activate);
    expect(learned.activate).toBeGreaterThan(0.1);
    expect(learned.activate).toBeLessThan(0.8);
  });
  it("rejects indistinguishable or insufficient recordings", () => {
    expect(() =>
      calibrateGesture(Array(20).fill(0.2), Array(20).fill(0.25)),
    ).toThrow(/not distinct/);
    expect(() => calibrateGesture([0.1], [0.8])).toThrow(/at least 10/);
    expect(() =>
      calibrateGesture(Array(20).fill(NaN), Array(20).fill(0.8)),
    ).toThrow(/valid/);
  });
  it("does not accept blink activation or malformed thresholds", () => {
    expect(isGestureConfig({ ...config, kind: "eyeBlinkLeft" })).toBe(false);
    expect(isGestureConfig({ ...config, activate: 0.2 })).toBe(false);
  });
});

describe("gesture hysteresis and rearming", () => {
  it("never emits without deliberate calibration", () => {
    expect(feed(new GestureDetector(), 1, 0, 3000).some(Boolean)).toBe(false);
  });
  it("requires neutral before activation, even at startup", () => {
    const detector = new GestureDetector(config);
    expect(feed(detector, 0.9, 0, 3000).some(Boolean)).toBe(false);
    feed(detector, 0.1, 3100, 3400);
    expect(feed(detector, 0.9, 3500, 4100).filter(Boolean)).toHaveLength(1);
  });
  it("fires once for a sustained gesture and does not repeat while held", () => {
    const detector = new GestureDetector(config);
    feed(detector, 0.1, 0, 300);
    expect(feed(detector, 0.9, 400, 3000).filter(Boolean)).toHaveLength(1);
    expect(detector.isArmed).toBe(false);
  });
  it("rearms only after neutral release and cooldown", () => {
    const detector = new GestureDetector(config);
    feed(detector, 0.1, 0, 300);
    feed(detector, 0.9, 400, 900);
    feed(detector, 0.1, 1000, 1200);
    expect(feed(detector, 0.9, 1300, 2100).some(Boolean)).toBe(false);
    feed(detector, 0.1, 2200, 2500);
    expect(feed(detector, 0.9, 2600, 3200).filter(Boolean)).toHaveLength(1);
  });
  it("short incidental expressions cannot trigger", () => {
    const detector = new GestureDetector(config);
    feed(detector, 0.1, 0, 300);
    expect(feed(detector, 0.9, 400, 600).some(Boolean)).toBe(false);
    feed(detector, 0.4, 700, 1000);
    expect(feed(detector, 0.9, 1100, 1400).some(Boolean)).toBe(false);
  });
  it("face loss disarms and discards accumulated hold", () => {
    const detector = new GestureDetector(config);
    feed(detector, 0.1, 0, 300);
    feed(detector, 0.9, 400, 700);
    expect(detector.update(0.9, 800, false)).toBe(false);
    expect(feed(detector, 0.9, 900, 3000).some(Boolean)).toBe(false);
  });
  it("a timestamp gap or reversal cannot complete a hold", () => {
    const detector = new GestureDetector(config);
    feed(detector, 0.1, 0, 300);
    detector.update(0.9, 400);
    expect(detector.update(0.9, 2000)).toBe(false);
    expect(detector.isArmed).toBe(false);
    expect(detector.update(0.9, 1900)).toBe(false);
  });
});
