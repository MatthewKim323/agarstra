import { describe, expect, it } from "vitest";
import { DwellController } from "../src/core/dwell";
import { SwitchScanner } from "../src/core/scanning";

describe("dwell readiness", () => {
  it("emits once at duration and never repeats until leaving", () => {
    const dwell = new DwellController({ dwellMs: 500 });
    const results = Array.from({ length: 20 }, (_, i) =>
      dwell.update("a", i * 100),
    );
    expect(results.filter((result) => result.fired)).toHaveLength(1);
    expect(results[4].progress).toBe(0.8);
    dwell.update(null, 2000);
    expect(dwell.update("a", 2100).progress).toBe(0);
  });
  it("does not carry elapsed time across target changes or missing face", () => {
    const dwell = new DwellController({ dwellMs: 500 });
    dwell.update("a", 0);
    dwell.update("a", 100);
    dwell.update("a", 200);
    expect(dwell.update("b", 300).progress).toBe(0);
    expect(dwell.update("b", 400, false).progress).toBe(0);
    expect(dwell.update("b", 500).progress).toBe(0);
  });
  it("does not complete a hold through stale gaps, hidden tabs or clock reversal", () => {
    const dwell = new DwellController({ dwellMs: 500 });
    dwell.update("a", 0);
    dwell.update("a", 100);
    expect(dwell.update("a", 2000).fired).toBe(false);
    expect(dwell.update("a", 1000).fired).toBe(false);
    expect(dwell.update("a", NaN).id).toBe(null);
  });
});

describe("single-switch scanning", () => {
  it("highlights without activation and selects only on an explicit signal", () => {
    const scanner = new SwitchScanner(1000);
    scanner.configure(["a", "b", "c"], 0);
    expect(scanner.current).toBe("a");
    expect(scanner.tick(1000)).toBe("b");
    expect(scanner.activate(1050)).toBe("b");
    expect(scanner.activate(1100)).toBe(null);
    expect(scanner.tick(2050)).toBe("c");
  });
  it("does not skip unseen items after a background delay", () => {
    const scanner = new SwitchScanner(1000);
    scanner.configure(["a", "b", "c"], 0);
    expect(scanner.tick(10000)).toBe("b");
  });
  it("pauses activation and scanning", () => {
    const scanner = new SwitchScanner(1000);
    scanner.configure(["a", "b"], 0);
    scanner.setPaused(true, 0);
    expect(scanner.tick(3000)).toBe("a");
    expect(scanner.activate(3000)).toBe(null);
    scanner.setPaused(false, 3000);
    expect(scanner.tick(3500)).toBe("a");
    expect(scanner.tick(4000)).toBe("b");
  });
});
