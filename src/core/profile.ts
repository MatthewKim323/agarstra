import type { InputMode } from "../../shared/types";
import {
  isCalibrationModel,
  type CalibrationModel,
} from "../vision/calibration";
import { isGestureConfig, type GestureConfig } from "../vision/gesture";

export interface LocalProfile {
  version: 1;
  inputMode: InputMode;
  dwellMs: number;
  scanMs: number;
  calibration: CalibrationModel | null;
  gesture: GestureConfig | null;
  /** Calibration is posture/device specific, so every load requires validation before control. */
  viewport: { width: number; height: number };
}
export const PROFILE_KEY = "nerve.input-profile.v1";
type ProfileStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function isLocalProfile(value: unknown): value is LocalProfile {
  if (!value || typeof value !== "object") return false;
  const v = value as LocalProfile;
  return (
    v.version === 1 &&
    ["pointer", "switch", "camera"].includes(v.inputMode) &&
    Number.isFinite(v.dwellMs) &&
    v.dwellMs >= 300 &&
    v.dwellMs <= 5000 &&
    Number.isFinite(v.scanMs) &&
    v.scanMs >= 500 &&
    v.scanMs <= 5000 &&
    (v.calibration === null || isCalibrationModel(v.calibration)) &&
    (v.gesture === null || isGestureConfig(v.gesture)) &&
    Boolean(v.viewport) &&
    Number.isFinite(v.viewport.width) &&
    Number.isFinite(v.viewport.height) &&
    v.viewport.width >= 200 &&
    v.viewport.width <= 16000 &&
    v.viewport.height >= 200 &&
    v.viewport.height <= 16000
  );
}

/** Invalid or corrupted local values never silently become control settings. */
export function loadProfile(
  storage: ProfileStorage = localStorage,
): LocalProfile | null {
  try {
    const raw = storage.getItem(PROFILE_KEY);
    if (!raw || raw.length > 100000) return null;
    const value: unknown = JSON.parse(raw);
    return isLocalProfile(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveProfile(
  profile: LocalProfile,
  storage: ProfileStorage = localStorage,
): boolean {
  if (!isLocalProfile(profile)) throw new Error("Invalid local input profile.");
  try {
    storage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function clearProfile(storage: ProfileStorage = localStorage): boolean {
  try {
    storage.removeItem(PROFILE_KEY);
    return true;
  } catch {
    return false;
  }
}
