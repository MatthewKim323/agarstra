import { describe, expect, it } from "vitest";
import { IntentAttention } from "../src/core/intent-attention";

function attend(step = 100, duration = 1000, id = "read", quality = 1) {
  const attention = new IntentAttention();
  for (let time = 0; time <= duration; time += step)
    attention.observe(id, time, quality);
  return attention;
}

describe("temporal intent attention", () => {
  it("requires advancing observations to accumulate attention", () => {
    const attention = new IntentAttention();
    expect(attention.weights(0)).toEqual({});
    attention.observe("read", 0, 1);
    expect(attention.weights(0)).toEqual({});
    attention.observe("read", 100, 1);
    expect(attention.weights(100).read).toBeGreaterThan(0);
  });

  it("measures elapsed attention equally at different sample rates", () => {
    const fast = attend(10).weights(1000).read;
    const slow = attend(100).weights(1000).read;
    expect(fast).toBeCloseTo(slow, 12);
    expect(fast).toBeCloseTo(1 - Math.exp(-1000 / 450), 12);
  });

  it("recovers when the user changes their mind", () => {
    const attention = attend();
    for (let time = 1100; time <= 1700; time += 100)
      attention.observe("reply", time, 1);
    const result = attention.weights(1700);
    expect(result.reply).toBeGreaterThan(0.75);
    expect(result.read).toBeLessThan(0.2);
  });

  it("decays while looking elsewhere without boosting a target", () => {
    const attention = attend();
    const before = attention.weights(1000).read;
    attention.observe(null, 1200, 1);
    const result = attention.weights(1200);
    expect(Object.keys(result)).toEqual(["read"]);
    expect(result.read).toBeCloseTo(before * Math.exp(-200 / 450));
  });

  it("expires evidence when no new input arrives", () => {
    const attention = attend();
    const before = attention.weights(1000).read;
    expect(attention.weights(1200).read).toBeLessThan(before);
    expect(attention.weights(1690).read).toBeLessThan(0.01);
    expect(attention.weights(1700)).toEqual({});
    expect(attention.weights(1800)).toEqual({});
  });

  it("does not accumulate attention from a parked pointer across a long gap", () => {
    const attention = attend();
    attention.observe("read", 1351, 1);
    expect(attention.weights(1351)).toEqual({});
    attention.observe("read", 1451, 1);
    expect(attention.weights(1451).read).toBeLessThan(0.25);
  });

  it.each([NaN, Infinity, -1, 0, 0.49, 1.01])(
    "clears evidence for invalid or insufficient quality %s",
    (quality) => {
      const attention = attend();
      attention.observe("read", 1100, quality);
      expect(attention.weights(1100)).toEqual({});
    },
  );

  it("bounds the contribution of lower quality observations", () => {
    const attention = attend(100, 1000, "read", 0.5);
    expect(attention.weights(1000).read).toBeGreaterThan(0);
    expect(attention.weights(1000).read).toBeLessThanOrEqual(0.5);
  });

  it.each([NaN, Infinity, -1, 900, 1000])(
    "clears evidence for corrupt or non-advancing input time %s",
    (timestamp) => {
      const attention = attend();
      attention.observe("read", timestamp, 1);
      expect(attention.weights(1100)).toEqual({});
    },
  );

  it.each([NaN, Infinity, -1, 999])(
    "rejects invalid read times and future-dated samples at time %s",
    (now) => {
      const attention = attend();
      expect(attention.weights(now)).toEqual({});
      expect(attention.weights(1100)).toEqual({});
    },
  );

  it("rejects a clock moving backwards between reads", () => {
    const attention = attend();
    expect(attention.weights(1200).read).toBeGreaterThan(0);
    expect(attention.weights(1100)).toEqual({});
  });

  it.each(["", "   ", "x".repeat(129)])("rejects invalid target ids", (id) => {
    const attention = attend();
    attention.observe(id, 1100, 1);
    expect(attention.weights(1100)).toEqual({});
  });

  it("returns independent finite bounded snapshots without inherited ids", () => {
    const attention = attend(100, 1000, "__proto__");
    const result = attention.weights(1000);
    expect(result.__proto__).toBeGreaterThan(0);
    expect(result.constructor).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(null);
    result.__proto__ = 100;
    result.other = NaN;
    const next = attention.weights(1000);
    expect(next.other).toBeUndefined();
    for (const weight of Object.values(next)) {
      expect(Number.isFinite(weight)).toBe(true);
      expect(weight).toBeGreaterThanOrEqual(0);
      expect(weight).toBeLessThanOrEqual(1);
    }
  });

  it("keeps memory bounded when many different targets are observed", () => {
    const attention = new IntentAttention();
    for (let time = 0; time <= 1000; time++)
      attention.observe(`target-${time}`, time, 1);
    expect(Object.keys(attention.weights(1000)).length).toBeLessThanOrEqual(
      100,
    );
  });

  it("reading snapshots does not change accumulation", () => {
    const attention = new IntentAttention();
    for (let time = 0; time <= 1000; time += 100) {
      attention.observe("read", time, 1);
      attention.weights(time + 50);
    }
    expect(attention.weights(1050).read).toBeCloseTo(
      attend().weights(1050).read,
      12,
    );
  });

  it("reset clears evidence and permits a fresh input clock", () => {
    const attention = attend();
    attention.reset();
    expect(attention.weights(0)).toEqual({});
    attention.observe("reply", 0, 1);
    attention.observe("reply", 100, 1);
    expect(Object.keys(attention.weights(100))).toEqual(["reply"]);
  });
});
