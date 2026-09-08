import { describe, expect, it } from "vitest";
import type { Point } from "../shared/types";
import { GazeFixation, imagePoint } from "../src/core/gaze-fixation";

const CENTER: Point = { x: 0.5, y: 0.5 };

describe("contained screenshot coordinates", () => {
  it("maps the displayed image instead of the horizontal letterbox", () => {
    const box = { x: 100, y: 50, width: 800, height: 400 };
    expect(imagePoint({ x: 500, y: 250 }, box, 400, 400)).toEqual(CENTER);
    expect(imagePoint({ x: 300, y: 50 }, box, 400, 400)).toEqual({
      x: 0,
      y: 0,
    });
    expect(imagePoint({ x: 700, y: 450 }, box, 400, 400)).toEqual({
      x: 1,
      y: 1,
    });
    expect(imagePoint({ x: 299, y: 250 }, box, 400, 400)).toBeNull();
    expect(imagePoint({ x: 701, y: 250 }, box, 400, 400)).toBeNull();
  });

  it("excludes vertical letterboxing for a wide screenshot", () => {
    const box = { x: 10, y: 20, width: 400, height: 400 };
    expect(imagePoint({ x: 210, y: 220 }, box, 1600, 400)).toEqual(CENTER);
    expect(imagePoint({ x: 110, y: 195 }, box, 1600, 400)).toEqual({
      x: 0.25,
      y: 0.25,
    });
    expect(imagePoint({ x: 210, y: 169 }, box, 1600, 400)).toBeNull();
    expect(imagePoint({ x: 210, y: 271 }, box, 1600, 400)).toBeNull();
    expect(imagePoint({ x: 9, y: 220 }, box, 1600, 400)).toBeNull();
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects invalid image or container dimensions %s",
    (bad) => {
      const box = { x: 0, y: 0, width: 400, height: 300 };
      expect(imagePoint({ x: 200, y: 150 }, box, bad, 300)).toBeNull();
      expect(imagePoint({ x: 200, y: 150 }, box, 400, bad)).toBeNull();
      expect(
        imagePoint({ x: 200, y: 150 }, { ...box, width: bad }, 400, 300),
      ).toBeNull();
      expect(
        imagePoint({ x: 200, y: 150 }, { ...box, height: bad }, 400, 300),
      ).toBeNull();
    },
  );

  it("rejects nonfinite coordinates without producing a normalized target", () => {
    const box = { x: 0, y: 0, width: 400, height: 300 };
    expect(imagePoint({ x: NaN, y: 150 }, box, 400, 300)).toBeNull();
    expect(imagePoint({ x: 200, y: Infinity }, box, 400, 300)).toBeNull();
    expect(
      imagePoint({ x: 200, y: 150 }, { ...box, x: NaN }, 400, 300),
    ).toBeNull();
  });
});

describe("screenshot gaze fixation", () => {
  it("requires both four distinct captures and a 600 ms capture span", () => {
    const fixation = new GazeFixation();
    for (const time of [0, 200, 400])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 600, 1, 600)).toMatchObject({
      fired: true,
      point: CENTER,
    });

    fixation.reset();
    for (const time of [0, 300, 600])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 650, 1, 650).fired).toBe(true);

    fixation.reset();
    for (const time of [0, 100, 200, 300, 400, 500])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 600, 1, 600).fired).toBe(true);
  });

  it.each([0, 100, 300, 330])(
    "accepts 333 ms captures with %s ms latency despite duplicate UI polls",
    (latency) => {
      const fixation = new GazeFixation();
      const events: { now: number; capture?: number }[] = [];
      for (let capture = 0; capture <= 1998; capture += 333)
        events.push({ now: capture + latency, capture });
      for (let now = 0; now <= 2400; now += 70) events.push({ now });
      events.sort(
        (a, b) =>
          a.now - b.now ||
          Number(b.capture !== undefined) - Number(a.capture !== undefined),
      );
      let latest: number | null = null;
      const fired: number[] = [];
      for (const event of events) {
        if (event.capture !== undefined) latest = event.capture;
        if (latest === null) continue;
        const state = fixation.update(CENTER, latest, 1, event.now);
        if (state.fired) fired.push(latest);
      }
      expect(fired).toEqual([999]);
    },
  );

  it("never admits a newly arrived capture older than 350 ms", () => {
    const fixation = new GazeFixation();
    for (let capture = 0; capture <= 2000; capture += 200) {
      const state = fixation.update(CENTER, capture, 1, capture + 351);
      expect(state.fired).toBe(false);
      expect(state.progress).toBe(0);
    }
  });

  it("does not count repeated timestamps toward the sample minimum", () => {
    const fixation = new GazeFixation();
    for (const capture of [0, 300, 600]) {
      expect(fixation.update(CENTER, capture, 1, capture).fired).toBe(false);
      for (const delay of [20, 40, 60, 80])
        expect(fixation.update(CENTER, capture, 1, capture + delay).fired).toBe(
          false,
        );
    }
    expect(fixation.update(CENTER, 700, 1, 700).fired).toBe(true);
  });

  it("starts a fresh hold when gaze moves to another screenshot region", () => {
    const fixation = new GazeFixation();
    for (const time of [0, 200, 400]) fixation.update(CENTER, time, 1, time);
    const moved = { x: 0.8, y: 0.5 };
    for (const time of [600, 800, 1000])
      expect(fixation.update(moved, time, 1, time).fired).toBe(false);
    expect(fixation.update(moved, 1200, 1, 1200)).toMatchObject({
      fired: true,
      point: moved,
    });
  });

  it("uses the two-dimensional bounding spread, not separate per-axis tolerance", () => {
    const fixation = new GazeFixation();
    fixation.update(CENTER, 0, 1, 0);
    fixation.update({ x: 0.56, y: 0.5 }, 200, 1, 200);
    const moved = { x: 0.5, y: 0.56 };
    // Width and height are each 0.06, but their diagonal exceeds 0.08.
    for (const time of [400, 600, 800])
      expect(fixation.update(moved, time, 1, time).fired).toBe(false);
    expect(fixation.update(moved, 1000, 1, 1000).fired).toBe(true);
  });

  it.each([0, 0.49, -1, 1.01, NaN, Infinity])(
    "clears an unfinished hold on invalid quality %s without rehabilitating the capture",
    (quality) => {
      const fixation = new GazeFixation();
      fixation.update(CENTER, 0, 1, 0);
      fixation.update(CENTER, 200, 1, 200);
      expect(fixation.update(CENTER, 400, quality, 400).fired).toBe(false);
      // The same timestamp cannot become a fresh sample just by changing its quality.
      expect(fixation.update(CENTER, 400, 1, 450).fired).toBe(false);
      for (const time of [600, 800, 1000])
        expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
      expect(fixation.update(CENTER, 1200, 1, 1200).fired).toBe(true);
    },
  );

  it.each([
    null,
    { x: NaN, y: 0.5 },
    { x: 0.5, y: Infinity },
    { x: -0.01, y: 0.5 },
    { x: 0.5, y: 1.01 },
  ])("clears an unfinished hold on invalid point %j", (point) => {
    const fixation = new GazeFixation();
    for (const time of [0, 200, 400]) fixation.update(CENTER, time, 1, time);
    expect(fixation.update(point, 600, 1, 600).fired).toBe(false);
    for (const time of [800, 1000, 1200])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 1400, 1, 1400).fired).toBe(true);
  });

  it("clears a hold on backward captures or future timestamps", () => {
    const fixation = new GazeFixation();
    for (const time of [0, 200, 400]) fixation.update(CENTER, time, 1, time);
    expect(fixation.update(CENTER, 300, 1, 500).fired).toBe(false);
    for (const time of [600, 800, 1000])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 1200, 1, 1200).fired).toBe(true);

    fixation.reset();
    for (const time of [0, 200, 400]) fixation.update(CENTER, time, 1, time);
    expect(fixation.update(CENTER, 600, 1, 599).fired).toBe(false);
    expect(fixation.update(CENTER, 600, 1, 650).fired).toBe(false);
    for (const time of [800, 1000, 1200])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 1400, 1, 1400).fired).toBe(true);
  });

  it("resets across a capture gap even when the new sample is fresh", () => {
    const fixation = new GazeFixation();
    for (const time of [0, 200, 400]) fixation.update(CENTER, time, 1, time);
    for (const time of [751, 951, 1151])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 1351, 1, 1351).fired).toBe(true);
  });

  it("resets across an arrival gap even when capture spacing stays below the limit", () => {
    const fixation = new GazeFixation();
    for (const time of [0, 100, 200]) fixation.update(CENTER, time, 1, time);
    expect(fixation.update(CENTER, 500, 1, 551).fired).toBe(false);
    expect(fixation.update(CENTER, 700, 1, 751).fired).toBe(false);
    expect(fixation.update(CENTER, 900, 1, 951).fired).toBe(false);
    expect(fixation.update(CENTER, 1100, 1, 1151).fired).toBe(true);
  });

  it("freezes one emitted target until reset and protects it from caller mutation", () => {
    const fixation = new GazeFixation();
    for (const time of [0, 200, 400]) fixation.update(CENTER, time, 1, time);
    const result = fixation.update(CENTER, 600, 1, 600);
    expect(result.fired).toBe(true);
    result.point!.x = 0;
    for (const time of [800, 1000, 1200, 1400])
      expect(fixation.update({ x: 0.1, y: 0.9 }, time, 1, time)).toMatchObject({
        fired: false,
        point: CENTER,
      });
    expect(fixation.update(null, 1500, 0, 1500)).toMatchObject({
      fired: false,
      point: CENTER,
    });
    fixation.reset();
    for (const time of [1600, 1800, 2000])
      expect(fixation.update(CENTER, time, 1, time).fired).toBe(false);
    expect(fixation.update(CENTER, 2200, 1, 2200).fired).toBe(true);
  });
});
