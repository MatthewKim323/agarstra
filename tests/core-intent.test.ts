import { describe, expect, it } from "vitest";
import { IntentEngine, type IntentTarget } from "../src/core/intent";
import type { Observation } from "../shared/types";

const targets: IntentTarget[] = [
  { id: "left", label: "Read", point: { x: 0.25, y: 0.5 } },
  { id: "right", label: "Write", point: { x: 0.75, y: 0.5 } },
];
const observation = (x: number, timestamp = 0, quality = 1): Observation => ({
  x,
  y: 0.5,
  timestamp,
  quality,
  gesture: false,
  features: [],
});

describe("intent inference", () => {
  it("selects a spatially distinct candidate without claiming calibrated confidence", () => {
    const result = new IntentEngine().rank(targets, observation(0.25));
    expect(result.topId).toBe("left");
    expect(
      result.candidates.reduce(
        (sum, candidate) => sum + candidate.probability,
        0,
      ),
    ).toBeCloseTo(1);
  });
  it("asks for a choice when spatial evidence is ambiguous", () => {
    const result = new IntentEngine().rank(targets, observation(0.5));
    expect(result.topId).toBe(null);
    expect(result.ambiguous).toBe(true);
    expect(result.question).toBe("Read or Write?");
    expect(result.entropy).toBeCloseTo(1);
  });
  it("does not choose a distant target merely because it is the only one", () => {
    expect(
      new IntentEngine().rank(targets.slice(0, 1), observation(0.99)).topId,
    ).toBe(null);
  });
  it("caps a contextual prior so it cannot overpower an explicit spatial signal", () => {
    const result = new IntentEngine().rank(
      [targets[0], { ...targets[1], prior: 10000 }],
      observation(0.25),
    );
    expect(result.topId).toBe("left");
  });
  it("decays previous evidence when attention changes", () => {
    const engine = new IntentEngine();
    engine.rank(targets, observation(0.25, 0));
    for (let time = 100; time <= 600; time += 100)
      engine.rank(targets, observation(0.75, time));
    expect(engine.rank(targets, observation(0.75, 700)).topId).toBe("right");
  });
  it("clears evidence for missing face, stale and out-of-order observations", () => {
    const engine = new IntentEngine();
    engine.rank(targets, observation(0.25, 0));
    expect(engine.rank(targets, observation(0.25, 100, 0)).valid).toBe(false);
    expect(engine.rank(targets, observation(0.75, 200)).topId).toBe("right");
    expect(engine.rank(targets, observation(0.75, 200)).valid).toBe(false);
    expect(engine.rank(targets, observation(0.75, 300), 1000).valid).toBe(
      false,
    );
  });
  it("rejects corrupted coordinates or layouts", () => {
    expect(new IntentEngine().rank(targets, observation(NaN)).valid).toBe(
      false,
    );
    expect(
      new IntentEngine().rank([targets[0], targets[0]], observation(0.25))
        .valid,
    ).toBe(false);
    expect(new IntentEngine().rank([], observation(0.25)).valid).toBe(false);
  });
  it("supports normalized rectangular candidate hit regions", () => {
    const result = new IntentEngine().rank(
      [
        { ...targets[0], rect: { x: 0.1, y: 0.3, width: 0.3, height: 0.4 } },
        targets[1],
      ],
      observation(0.39),
    );
    expect(result.topId).toBe("left");
    expect(result.candidates[0].distance).toBe(0);
  });
});

describe("application gaze settings with stacked 82px controls", () => {
  const settings = {
    sigma: 0.025,
    minimumMargin: 0.12,
    minimumWeight: 0.52,
    maxDistance: 0.035,
    minimumQuality: 0.5,
  };
  // Adjacent controls are deliberately harder to distinguish than spaced cards.
  const stacked: IntentTarget[] = Array.from({ length: 3 }, (_, index) => ({
    id: `control-${index}`,
    label: `Choice ${index + 1}`,
    point: { x: 0.5, y: (200 + index * 82 + 41) / 1000 },
    rect: {
      x: 0.3,
      y: (200 + index * 82) / 1000,
      width: 0.4,
      height: 82 / 1000,
    },
  }));
  it.each([0, 1, 2])("selects the center of control %i", (index) => {
    const target = stacked[index];
    const result = new IntentEngine(settings).rank(stacked, {
      ...observation(target.point.x),
      y: target.point.y,
    });
    expect(result.valid).toBe(true);
    expect(result.ambiguous).toBe(false);
    expect(result.topId).toBe(target.id);
    expect(result.margin).toBeGreaterThanOrEqual(settings.minimumMargin);
  });
  it.each([0, 1])(
    "does not select at the shared boundary below control %i",
    (index) => {
      const y = (200 + (index + 1) * 82) / 1000;
      const result = new IntentEngine(settings).rank(stacked, {
        ...observation(0.5),
        y,
      });
      expect(result.valid).toBe(true);
      expect(result.ambiguous).toBe(true);
      expect(result.topId).toBe(null);
      expect(result.margin).toBeLessThan(settings.minimumMargin);
      expect(result.question).toBeTruthy();
    },
  );
  it("rejects quality 0.49 even with an otherwise unambiguous centered gaze", () => {
    const target = stacked[1];
    const result = new IntentEngine(settings).rank(stacked, {
      ...observation(target.point.x, 0, 0.49),
      y: target.point.y,
    });
    expect(result.valid).toBe(false);
    expect(result.topId).toBe(null);
    expect(result.candidates).toEqual([]);
  });
});
