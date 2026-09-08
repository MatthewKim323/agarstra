import { describe, expect, it } from "vitest";
import {
  GAZE_PROFILE_KEY,
  clearGazeProfile,
  compareGazeEnvironment,
  isSavedGazeProfile,
  loadGazeProfile,
  saveGazeProfile,
  type GazeEnvironment,
  type SavedGazeProfile,
} from "../src/core/gaze-profile";

const environment: GazeEnvironment = {
  pipelineVersion: "test-eye-pipeline-v1",
  featureCount: 2,
  deviceId: "camera-one",
  captureWidth: 640,
  captureHeight: 480,
  viewportWidth: 1280,
  viewportHeight: 800,
  devicePixelRatio: 2,
  viewportScale: 1,
};
const profile = (): SavedGazeProfile => ({
  version: 1,
  model: {
    version: 1,
    featureCount: 2,
    means: [0, 0],
    scales: [1, 1],
    weightsX: [0, 1, 0],
    weightsY: [0, 0, 1],
    samples: 90,
    createdAt: 1,
  },
  gesture: null,
  activation: "dwell",
  dwellMs: 850,
  savedAt: 10,
  environment: { ...environment },
  lastValidation: {
    checkedAt: 9,
    meanError: 0.08,
    p95Error: 0.12,
    sampleCount: 50,
  },
});
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("saved personal gaze calibration", () => {
  it("round-trips eyes-only calibration without treating storage as readiness", () => {
    const storage = memoryStorage();
    expect(loadGazeProfile(storage)).toEqual({
      status: "missing",
      profile: null,
    });
    expect(saveGazeProfile(profile(), storage)).toBe(true);
    expect(loadGazeProfile(storage)).toEqual({
      status: "saved",
      profile: profile(),
    });
    expect(loadGazeProfile(storage)).not.toHaveProperty("ready");
    expect(clearGazeProfile(storage)).toBe(true);
    expect(loadGazeProfile(storage).status).toBe("missing");
  });

  it("distinguishes damaged, missing, and inaccessible storage", () => {
    const storage = memoryStorage();
    storage.setItem(GAZE_PROFILE_KEY, "{broken-json");
    expect(loadGazeProfile(storage)).toEqual({
      status: "invalid",
      profile: null,
    });
    storage.setItem(GAZE_PROFILE_KEY, "x".repeat(100001));
    expect(loadGazeProfile(storage).status).toBe("invalid");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadGazeProfile(broken).status).toBe("unavailable");
    expect(saveGazeProfile(profile(), broken)).toBe(false);
    expect(clearGazeProfile(broken)).toBe(false);
  });

  it("round-trips the current nonlinear model and an optional deliberate gesture", () => {
    const value = profile();
    value.model = {
      ...value.model,
      version: 2,
      basis: "quadratic",
      activeFeatures: [0, 1],
      centers: [
        [0.2, 0.3],
        [0.7, 0.9],
      ],
    };
    value.activation = "gesture";
    value.gesture = {
      kind: "jawOpen",
      activate: 0.4,
      release: 0.15,
      holdMs: 550,
      releaseMs: 300,
      cooldownMs: 1300,
    };
    const storage = memoryStorage();
    expect(saveGazeProfile(value, storage)).toBe(true);
    expect(loadGazeProfile(storage)).toEqual({
      status: "saved",
      profile: value,
    });
    const loaded = loadGazeProfile(storage);
    if (loaded.profile) loaded.profile.model.centers![0][0] = 999;
    expect(loadGazeProfile(storage)).toEqual({
      status: "saved",
      profile: value,
    });
  });

  it("persists only inference fields, stripping attached samples and diagnostics", () => {
    const value = profile();
    Object.assign(value.model, {
      rawSamples: ["private"],
      trainingDiagnostics: { private: true },
    });
    const storage = memoryStorage();
    expect(saveGazeProfile(value, storage)).toBe(true);
    expect(loadGazeProfile(storage)).toEqual({
      status: "saved",
      profile: profile(),
    });
    expect(storage.getItem(GAZE_PROFILE_KEY)).not.toContain("private");
  });

  it.each([
    (value: SavedGazeProfile) => Object.assign(value, { version: 2 }),
    (value: SavedGazeProfile) => {
      value.model.weightsX = [1];
    },
    (value: SavedGazeProfile) => {
      value.environment.featureCount = 18;
    },
    (value: SavedGazeProfile) => {
      value.lastValidation.meanError = 0.151;
    },
    (value: SavedGazeProfile) => {
      value.lastValidation.p95Error = 0.256;
    },
    (value: SavedGazeProfile) => {
      value.lastValidation.sampleCount = 49;
    },
    (value: SavedGazeProfile) => {
      value.dwellMs = NaN;
    },
    (value: SavedGazeProfile) => {
      value.environment.viewportWidth = 0;
    },
    (value: SavedGazeProfile) => Object.assign(value, { ready: true }),
  ])(
    "rejects invalid profile data without overwriting a valid save (%#)",
    (damage) => {
      const storage = memoryStorage();
      saveGazeProfile(profile(), storage);
      const bad = profile();
      damage(bad);
      expect(isSavedGazeProfile(bad)).toBe(false);
      expect(saveGazeProfile(bad, storage)).toBe(false);
      expect(loadGazeProfile(storage)).toEqual({
        status: "saved",
        profile: profile(),
      });
      storage.setItem(GAZE_PROFILE_KEY, JSON.stringify(bad));
      expect(loadGazeProfile(storage).status).toBe("invalid");
    },
  );

  it.each([
    ["pipelineVersion", "different", "pipeline"],
    ["featureCount", 18, "pipeline"],
    ["deviceId", "camera-two", "camera"],
    ["captureWidth", 1280, "capture-size"],
    ["captureHeight", 720, "capture-size"],
    ["viewportWidth", 1440, "viewport"],
    ["viewportHeight", 900, "viewport"],
    ["devicePixelRatio", 1, "viewport"],
    ["viewportScale", 1.25, "viewport"],
  ])("requires a new calibration after %s changes", (key, value, reason) => {
    const changed = { ...environment, [key]: value };
    expect(compareGazeEnvironment(environment, changed)).toMatchObject({
      compatible: false,
      reason,
    });
  });

  it("reports unknown camera identity while allowing an independent fresh check", () => {
    expect(compareGazeEnvironment(environment, { ...environment })).toEqual({
      compatible: true,
      identityKnown: true,
      reason: null,
    });
    expect(
      compareGazeEnvironment(environment, { ...environment, deviceId: null }),
    ).toEqual({ compatible: true, identityKnown: false, reason: null });
    expect(
      compareGazeEnvironment(environment, { ...environment, captureWidth: 0 })
        .compatible,
    ).toBe(false);
  });
});
