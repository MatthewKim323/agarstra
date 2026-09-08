import { describe, expect, it } from "vitest";
import {
  clearProfile,
  isLocalProfile,
  loadProfile,
  PROFILE_KEY,
  saveProfile,
  type LocalProfile,
} from "../src/core/profile";

const profile: LocalProfile = {
  version: 1,
  inputMode: "switch",
  dwellMs: 900,
  scanMs: 1400,
  calibration: null,
  gesture: null,
  viewport: { width: 1200, height: 800 },
};
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

describe("local profile validation", () => {
  it("saves, loads and erases a valid opt-in profile", () => {
    const storage = memoryStorage();
    expect(saveProfile(profile, storage)).toBe(true);
    expect(loadProfile(storage)).toEqual(profile);
    expect(clearProfile(storage)).toBe(true);
    expect(loadProfile(storage)).toBe(null);
  });
  it("rejects unsafe settings or an incompatible schema", () => {
    expect(isLocalProfile({ ...profile, scanMs: 0 })).toBe(false);
    expect(isLocalProfile({ ...profile, dwellMs: 1 })).toBe(false);
    expect(isLocalProfile({ ...profile, version: 2 })).toBe(false);
    expect(isLocalProfile({ ...profile, calibration: {} })).toBe(false);
  });
  it("ignores broken JSON instead of throwing during app startup", () => {
    const storage = memoryStorage();
    storage.setItem(PROFILE_KEY, "{broken");
    expect(loadProfile(storage)).toBe(null);
    storage.setItem(PROFILE_KEY, JSON.stringify({ ...profile, scanMs: -1 }));
    expect(loadProfile(storage)).toBe(null);
  });
  it("handles denied browser storage safely", () => {
    const storage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    expect(loadProfile(storage)).toBe(null);
    expect(saveProfile(profile, storage)).toBe(false);
    expect(clearProfile(storage)).toBe(false);
  });
});
