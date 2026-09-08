import { describe, expect, it } from "vitest";
import type { Observation } from "../shared/types";
import {
  GazeActivationController,
  GazeZoneCheck,
  gazeZoneCenter,
  type GazeZone,
} from "../src/core/gaze-activation";

const capture = (zone: GazeZone, timestamp: number): Observation => ({
  ...gazeZoneCenter(zone),
  timestamp,
  quality: 1,
  gesture: false,
  features: [],
});

/** Three fresh captures per second, each delivered at the configured latency. */
function pendingChoice(latency = 350) {
  const controller = new GazeActivationController();
  for (const timestamp of [0, 333, 666])
    controller.update(
      capture("neutral", timestamp),
      timestamp + latency,
      "choice",
    );
  for (const timestamp of [999, 1332, 1665, 1998])
    controller.update(
      capture("primary", timestamp),
      timestamp + latency,
      "choice",
    );
  const state = controller.update(
    capture("primary", 1998),
    1998 + latency,
    "choice",
  );
  expect(state.armed).toBe(true);
  expect(state.progress).toBeGreaterThan(0.9);
  expect(state.fired).toBeNull();
  return controller;
}

/** The next distinct capture can satisfy both the sample minimum and the hold. */
function pendingZoneCheck(latency = 350) {
  const check = new GazeZoneCheck(0);
  for (const timestamp of [0, 333, 666, 999, 1332])
    check.update(capture("primary", timestamp), timestamp + latency);
  expect(check.current.step).toBe(1);
  expect(check.current.progress).toBeGreaterThan(0.9);
  expect(check.current.results).toEqual([]);
  return check;
}

describe("new gaze capture freshness boundary", () => {
  it.each([349, 350])(
    "allows a new action-completing capture delivered at %i ms age",
    (latency) => {
      const controller = pendingChoice(latency);
      const result = controller.update(
        capture("primary", 2331),
        2331 + latency,
        "choice",
      );
      expect(result.reliable).toBe(true);
      expect(result.fired).toBe("primary");
      expect(result.armed).toBe(false);
      expect(
        controller.update(
          capture("primary", 2331),
          2331 + latency + 1,
          "choice",
        ).fired,
      ).toBeNull();
    },
  );

  it("rejects a distinct action-completing capture at 351 ms instead of crediting its hold", () => {
    const controller = pendingChoice();
    const result = controller.update(capture("primary", 2331), 2682, "choice");
    expect(result.reliable).toBe(false);
    expect(result.progress).toBe(0);
    expect(result.armed).toBe(false);
    expect(result.fired).toBeNull();
    // Fresh captures may resume, but an old armed hold cannot survive the stale result.
    for (let timestamp = 2664; timestamp <= 4662; timestamp += 333)
      expect(
        controller.update(
          capture("primary", timestamp),
          timestamp + 350,
          "choice",
        ).fired,
      ).toBeNull();
  });

  it("cannot keep an almost-complete action alive with a stream of new stale captures", () => {
    const controller = pendingChoice();
    for (let timestamp = 2331; timestamp <= 4995; timestamp += 333) {
      const result = controller.update(
        capture("primary", timestamp),
        timestamp + 351,
        "choice",
      );
      expect(result).toMatchObject({
        armed: false,
        reliable: false,
        progress: 0,
        fired: null,
      });
    }
    const recovered = controller.update(
      capture("primary", 5328),
      5678,
      "choice",
    );
    expect(recovered.reliable).toBe(true);
    expect(recovered.armed).toBe(false);
    expect(recovered.progress).toBe(0);
    expect(recovered.fired).toBeNull();
  });

  it.each([349, 350])(
    "allows an independently checked zone to complete with a new capture at %i ms age",
    (latency) => {
      const check = pendingZoneCheck(latency);
      const result = check.update(capture("primary", 1665), 1665 + latency);
      expect(result.step).toBe(2);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toEqual({
        zone: "primary",
        samples: 5,
        hits: 5,
        hitFraction: 1,
        heldMs: 1332,
      });
    },
  );

  it("does not admit a fifth independent-check capture at 351 ms age", () => {
    const check = pendingZoneCheck();
    const stale = check.update(capture("primary", 1665), 2016);
    expect(stale.step).toBe(1);
    expect(stale.progress).toBe(0);
    expect(stale.results).toEqual([]);
    // A genuinely fresh return begins a new contiguous hold, not the old 999 ms.
    const resumed = check.update(capture("primary", 1998), 2348);
    expect(resumed.step).toBe(1);
    expect(resumed.progress).toBe(0);
    expect(resumed.results).toEqual([]);
  });

  it("does not refresh the held-out check deadline or hold with newly delivered stale frames", () => {
    const check = pendingZoneCheck();
    for (let timestamp = 1665; timestamp + 351 < 9000; timestamp += 333) {
      const result = check.update(
        capture("primary", timestamp),
        timestamp + 351,
      );
      expect(result.status).toBe("checking");
      expect(result.step).toBe(1);
      expect(result.progress).toBe(0);
      expect(result.results).toEqual([]);
    }
    const expired = check.update(capture("primary", 8649), 9000);
    expect(expired.status).toBe("failed");
    expect(expired.results).toEqual([]);
  });
});
