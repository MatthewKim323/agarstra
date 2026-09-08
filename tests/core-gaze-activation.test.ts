import { describe, expect, it } from "vitest";
import type { Observation } from "../shared/types";
import {
  GAZE_ZONES,
  GazeActivationController,
  GazeZoneCheck,
  gazeZone,
  gazeZoneCenter,
  type GazeZone,
} from "../src/core/gaze-activation";

const observation = (
  zone: GazeZone | null,
  timestamp: number,
  quality = 1,
): Observation => ({
  ...(zone ? gazeZoneCenter(zone) : { x: 0.5, y: 0.35 }),
  timestamp,
  quality,
  gesture: false,
  features: [],
});

function hold(
  controller: GazeActivationController,
  zone: GazeZone | null,
  from: number,
  to: number,
  stage = "choice",
  step = 100,
) {
  const states = [];
  for (let time = from; time <= to; time += step)
    states.push(controller.update(observation(zone, time), time, stage));
  return states;
}

describe("eyes-only activation", () => {
  it("only recognizes the four separated visible control zones", () => {
    for (const zone of Object.keys(GAZE_ZONES) as GazeZone[])
      expect(gazeZone(gazeZoneCenter(zone))).toBe(zone);
    expect(gazeZone({ x: 0.5, y: 0.35 })).toBeNull();
    expect(gazeZone({ x: NaN, y: 0.5 })).toBeNull();
    expect(gazeZone({ x: -0.01, y: 0.6 })).toBeNull();
  });

  it("does not select without a deliberate neutral hold first", () => {
    const controller = new GazeActivationController();
    expect(
      hold(controller, "primary", 0, 3000).some((state) => state.fired),
    ).toBe(false);
    expect(hold(controller, null, 3100, 3800).at(-1)?.armed).toBe(false);
    expect(hold(controller, "neutral", 3900, 4300).at(-1)?.armed).toBe(true);
    const states = hold(controller, "primary", 4400, 6200);
    expect(states.filter((state) => state.fired === "primary")).toHaveLength(1);
  });

  it("uses elapsed fresh capture time at three frames per second", () => {
    const controller = new GazeActivationController();
    expect(
      hold(controller, "neutral", 0, 666, "choice", 333).at(-1)?.armed,
    ).toBe(true);
    const states = hold(controller, "primary", 999, 2997, "choice", 333);
    expect(states.filter((state) => state.fired === "primary")).toHaveLength(1);
    expect(states.findIndex((state) => state.fired)).toBe(4);
  });

  it("cannot chain a stationary gaze into replacement confirmation and approval", () => {
    const controller = new GazeActivationController();
    hold(controller, "neutral", 0, 400);
    expect(hold(controller, "primary", 500, 1600).at(-1)?.fired).toBe(
      "primary",
    );
    expect(
      hold(controller, "primary", 1700, 3500, "confirm").some(
        (state) => state.fired,
      ),
    ).toBe(false);
    hold(controller, "neutral", 3600, 4000, "confirm");
    expect(
      hold(controller, "primary", 4100, 5200, "confirm").at(-1)?.fired,
    ).toBe("primary");
    expect(
      hold(controller, "primary", 5300, 6800, "approval").some(
        (state) => state.fired,
      ),
    ).toBe(false);
  });

  it("can change target but starts a new hold on that target", () => {
    const controller = new GazeActivationController();
    hold(controller, "neutral", 0, 400);
    hold(controller, "primary", 500, 1400);
    expect(
      hold(controller, "secondary", 1500, 2500).some((state) => state.fired),
    ).toBe(false);
    expect(
      controller.update(observation("secondary", 2600), 2600, "choice").fired,
    ).toBe("secondary");
  });

  it("requires neutral again when a disabled target becomes available", () => {
    const controller = new GazeActivationController();
    hold(controller, "neutral", 0, 400);
    hold(controller, "primary", 500, 1300);
    controller.update(observation("primary", 1400), 1400, "choice", {
      primary: false,
      secondary: true,
    });
    expect(
      hold(controller, "primary", 1500, 3000).some((state) => state.fired),
    ).toBe(false);
  });

  it("Stop works while unarmed and cannot repeat until gaze leaves Stop", () => {
    const controller = new GazeActivationController();
    const first = hold(controller, "stop", 0, 1500);
    expect(first.filter((state) => state.fired === "stop")).toHaveLength(1);
    expect(
      hold(controller, "stop", 1600, 2400, "paused").some(
        (state) => state.fired,
      ),
    ).toBe(false);
    controller.update(null, 2500, "paused");
    expect(
      hold(controller, "stop", 2600, 3500, "paused").some(
        (state) => state.fired,
      ),
    ).toBe(false);
    controller.update(observation(null, 3600), 3600, "paused");
    expect(hold(controller, "stop", 3700, 4400, "paused").at(-1)?.fired).toBe(
      "stop",
    );
  });

  it("does not treat the final Stop check as a real command after handoff", () => {
    const controller = new GazeActivationController();
    controller.reset({ stopLatched: true });
    expect(hold(controller, "stop", 0, 2000).some((state) => state.fired)).toBe(
      false,
    );
    controller.update(null, 2100, "choice");
    expect(
      hold(controller, "stop", 2200, 3300).some((state) => state.fired),
    ).toBe(false);
    controller.update(observation("neutral", 3400), 3400, "choice");
    expect(hold(controller, "stop", 3500, 4200).at(-1)?.fired).toBe("stop");
  });

  it("tracking loss and large capture gaps never count as rearming", () => {
    const controller = new GazeActivationController();
    hold(controller, "neutral", 0, 400);
    hold(controller, "primary", 500, 1400);
    controller.update(observation("primary", 1500, 0.49), 1500, "choice");
    expect(
      hold(controller, "primary", 1600, 3000).some((state) => state.fired),
    ).toBe(false);
    hold(controller, "neutral", 3100, 3500);
    expect(
      controller.update(observation("primary", 3900), 3900, "choice").armed,
    ).toBe(false);
  });

  it("replayed captures do not progress a dwell", () => {
    const controller = new GazeActivationController();
    hold(controller, "neutral", 0, 400);
    controller.update(observation("primary", 500), 500, "choice");
    for (let now = 550; now < 850; now += 50)
      expect(
        controller.update(observation("primary", 500), now, "choice").progress,
      ).toBe(0);
    expect(
      controller.update(observation("primary", 500), 900, "choice").reliable,
    ).toBe(false);
  });

  it.each([NaN, Infinity, -1, 3000])(
    "rejects invalid or future capture time %s",
    (timestamp) => {
      const controller = new GazeActivationController();
      hold(controller, "neutral", 0, 400);
      expect(
        controller.update(observation("primary", timestamp), 500, "choice")
          .reliable,
      ).toBe(false);
    },
  );

  it("rejects backwards captures and clocks without preserving a hold", () => {
    const controller = new GazeActivationController();
    hold(controller, "neutral", 0, 400);
    hold(controller, "primary", 500, 1000);
    expect(
      controller.update(observation("primary", 900), 1100, "choice").armed,
    ).toBe(false);
    expect(
      controller.update(observation("neutral", 1100), 1000, "choice").reliable,
    ).toBe(false);
  });

  it("reset drops readiness and returned snapshots cannot mutate its state", () => {
    const controller = new GazeActivationController();
    const state = hold(controller, "neutral", 0, 400).at(-1)!;
    state.armed = false;
    expect(
      controller.update(observation("primary", 500), 500, "choice").armed,
    ).toBe(true);
    controller.reset();
    expect(
      controller.update(observation("primary", 600), 600, "choice").armed,
    ).toBe(false);
  });
});

describe("independent gaze control check", () => {
  it("checks all four actual zones at three frames per second", () => {
    const check = new GazeZoneCheck(0);
    for (
      let time = 0;
      time < 20_000 && check.current.status === "checking";
      time += 333
    )
      check.update(observation(check.current.zone, time), time);
    expect(check.current.status).toBe("passed");
    expect(check.current.results.map((result) => result.zone)).toEqual([
      "primary",
      "secondary",
      "neutral",
      "stop",
    ]);
    for (const result of check.current.results) {
      expect(result.samples).toBeGreaterThanOrEqual(5);
      expect(result.hitFraction).toBeGreaterThanOrEqual(0.8);
      expect(result.heldMs).toBeGreaterThanOrEqual(1100);
    }
  });

  it("ignores target transition settling frames", () => {
    const check = new GazeZoneCheck(0);
    for (let time = 0; time <= 500; time += 100)
      check.update(observation("secondary", time), time);
    for (let time = 600; time <= 1800; time += 100)
      check.update(observation("primary", time), time);
    expect(check.current.results[0].hitFraction).toBe(1);
  });

  it("fails a collapsed constant prediction instead of blessing it as a control signal", () => {
    const check = new GazeZoneCheck(0);
    for (let time = 0; time <= 9500; time += 100)
      check.update(observation("neutral", time), time);
    expect(check.current.status).toBe("failed");
    expect(check.current.results).toEqual([]);
  });

  it("accounts for misses across the whole trial, not only the eventual successful hold", () => {
    const check = new GazeZoneCheck(0);
    for (let time = 0; time <= 6000; time += 100)
      check.update(observation("secondary", time), time);
    for (let time = 6100; time <= 9000; time += 100)
      check.update(observation("primary", time), time);
    expect(check.current.status).toBe("failed");
  });

  it("does not count a repeated frame or tracking loss as a successful hold", () => {
    const check = new GazeZoneCheck(0);
    for (let time = 600; time <= 9500; time += 100)
      check.update(observation("primary", 600), time);
    expect(check.current.status).toBe("failed");
  });

  it("requires a contiguous hold even with a high hit fraction", () => {
    const check = new GazeZoneCheck(0);
    for (let time = 0; time <= 9000; time += 100)
      check.update(
        observation(time % 900 === 0 ? "secondary" : "primary", time),
        time,
      );
    expect(check.current.status).toBe("failed");
  });

  it("returns independent check results and rejects clock regression", () => {
    const check = new GazeZoneCheck(0);
    for (let time = 0; time <= 1800; time += 100)
      check.update(observation("primary", time), time);
    check.current.results[0].hitFraction = 0;
    expect(check.current.results[0].hitFraction).toBe(1);
    expect(check.update(observation("secondary", 1900), 1000).status).toBe(
      "failed",
    );
  });
});

describe("slow inference with faster UI polling", () => {
  it.each([0, 100, 300, 330])(
    "admits 3fps captures with %i ms latency without painting duplicate frames into the dwell",
    (latency) => {
      const controller = new GazeActivationController();
      let latest: Observation | null = null;
      let fires = 0;
      const deliver = (now: number) => {
        if (controller.update(latest, now, "choice").fired === "primary")
          fires++;
      };
      for (let now = 0; now <= 4000; now++) {
        if (now >= latency && (now - latency) % 333 === 0) {
          const capture = now - latency;
          latest = observation(capture <= 666 ? "neutral" : "primary", capture);
          deliver(now);
        }
        if (now % 70 === 0) deliver(now);
      }
      expect(fires).toBe(1);
    },
  );

  it.each([0, 100, 300, 330])(
    "completes the zone check with 3fps captures and %i ms latency",
    (latency) => {
      const check = new GazeZoneCheck(0);
      const captured = new Map<number, Observation>();
      let latest: Observation | null = null;
      for (
        let now = 0;
        now <= 20_000 && check.current.status === "checking";
        now++
      ) {
        if (now % 333 === 0)
          captured.set(now, observation(check.current.zone, now));
        if (captured.has(now - latency)) {
          latest = captured.get(now - latency)!;
          check.update(latest, now);
        }
        if (now % 70 === 0) check.update(latest, now);
      }
      expect(check.current.status).toBe("passed");
      expect(check.current.results).toHaveLength(4);
    },
  );
});
