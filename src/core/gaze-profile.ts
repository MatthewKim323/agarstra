import {
  isCalibrationModel,
  type CalibrationModel,
} from "../vision/calibration";
import { isGestureConfig, type GestureConfig } from "../vision/gesture";

export const GAZE_PROFILE_KEY = "nerve.gaze-profile.v1";
export type GazeActivation = "dwell" | "gesture";
export interface GazeEnvironment {
  pipelineVersion: string;
  featureCount: number;
  deviceId: string | null;
  captureWidth: number;
  captureHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  viewportScale: number;
}
export interface SavedGazeProfile {
  version: 1;
  model: CalibrationModel;
  gesture: GestureConfig | null;
  activation: GazeActivation;
  dwellMs: number;
  savedAt: number;
  environment: GazeEnvironment;
  lastValidation: {
    checkedAt: number;
    meanError: number;
    p95Error: number;
    sampleCount: number;
  };
}
type ProfileStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type GazeProfileLoad =
  | { status: "missing" | "invalid" | "unavailable"; profile: null }
  | { status: "saved"; profile: SavedGazeProfile };

const finite = (
  value: unknown,
  minimum: number,
  maximum: number,
): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= minimum &&
  value <= maximum;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
export function isGazeEnvironment(value: unknown): value is GazeEnvironment {
  if (!object(value)) return false;
  return (
    keys(value, [
      "pipelineVersion",
      "featureCount",
      "deviceId",
      "captureWidth",
      "captureHeight",
      "viewportWidth",
      "viewportHeight",
      "devicePixelRatio",
      "viewportScale",
    ]) &&
    typeof value.pipelineVersion === "string" &&
    value.pipelineVersion.length > 0 &&
    value.pipelineVersion.length <= 128 &&
    finite(value.featureCount, 2, 128) &&
    Number.isInteger(value.featureCount) &&
    (value.deviceId === null ||
      (typeof value.deviceId === "string" &&
        value.deviceId.length > 0 &&
        value.deviceId.length <= 512)) &&
    [
      value.captureWidth,
      value.captureHeight,
      value.viewportWidth,
      value.viewportHeight,
    ].every((size) => finite(size, 1, 16000) && Number.isInteger(size)) &&
    finite(value.devicePixelRatio, 0.1, 10) &&
    finite(value.viewportScale, 0.1, 10)
  );
}

export function isSavedGazeProfile(value: unknown): value is SavedGazeProfile {
  if (!object(value) || !object(value.lastValidation)) return false;
  const check = value.lastValidation;
  return (
    keys(value, [
      "version",
      "model",
      "gesture",
      "activation",
      "dwellMs",
      "savedAt",
      "environment",
      "lastValidation",
    ]) &&
    value.version === 1 &&
    isCalibrationModel(value.model) &&
    isGazeEnvironment(value.environment) &&
    value.model.featureCount === value.environment.featureCount &&
    (value.gesture === null || isGestureConfig(value.gesture)) &&
    (value.activation === "dwell" || value.activation === "gesture") &&
    finite(value.dwellMs, 300, 5000) &&
    finite(value.savedAt, 1, Number.MAX_SAFE_INTEGER) &&
    keys(check, ["checkedAt", "meanError", "p95Error", "sampleCount"]) &&
    finite(check.checkedAt, 1, Number.MAX_SAFE_INTEGER) &&
    finite(check.meanError, 0, 0.15) &&
    finite(check.p95Error, 0, 0.255) &&
    finite(check.sampleCount, 50, 10000) &&
    Number.isInteger(check.sampleCount)
  );
}

/** Only inference fields are persisted, not raw samples or optional diagnostic payloads. */
function canonicalProfile(profile: SavedGazeProfile): SavedGazeProfile {
  const model = profile.model;
  const canonical: CalibrationModel = {
    version: model.version,
    featureCount: model.featureCount,
    means: [...model.means],
    scales: [...model.scales],
    weightsX: [...model.weightsX],
    weightsY: [...model.weightsY],
    samples: model.samples,
    createdAt: model.createdAt,
  };
  if (model.version === 2) {
    canonical.basis = model.basis;
    canonical.activeFeatures = [...model.activeFeatures!];
    canonical.centers = model.centers!.map((center) => [...center]);
  }
  const gesture = profile.gesture;
  return {
    version: 1,
    model: canonical,
    gesture: gesture
      ? {
          kind: gesture.kind,
          activate: gesture.activate,
          release: gesture.release,
          holdMs: gesture.holdMs,
          releaseMs: gesture.releaseMs,
          cooldownMs: gesture.cooldownMs,
        }
      : null,
    activation: profile.activation,
    dwellMs: profile.dwellMs,
    savedAt: profile.savedAt,
    environment: { ...profile.environment },
    lastValidation: { ...profile.lastValidation },
  };
}

/** A stored model is never proof of readiness in the current camera session. */
export function loadGazeProfile(
  storage?: Pick<ProfileStorage, "getItem">,
): GazeProfileLoad {
  let raw: string | null;
  try {
    raw = (storage ?? globalThis.localStorage).getItem(GAZE_PROFILE_KEY);
  } catch {
    return { status: "unavailable", profile: null };
  }
  if (raw === null) return { status: "missing", profile: null };
  if (raw.length > 100000) return { status: "invalid", profile: null };
  try {
    const value: unknown = JSON.parse(raw);
    return isSavedGazeProfile(value)
      ? { status: "saved", profile: canonicalProfile(value) }
      : { status: "invalid", profile: null };
  } catch {
    return { status: "invalid", profile: null };
  }
}

export function saveGazeProfile(
  profile: SavedGazeProfile,
  storage?: Pick<ProfileStorage, "setItem">,
): boolean {
  try {
    if (!isSavedGazeProfile(profile)) return false;
    const raw = JSON.stringify(canonicalProfile(profile));
    if (raw.length > 100000) return false;
    (storage ?? globalThis.localStorage).setItem(GAZE_PROFILE_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

export function clearGazeProfile(
  storage?: Pick<ProfileStorage, "removeItem">,
): boolean {
  try {
    (storage ?? globalThis.localStorage).removeItem(GAZE_PROFILE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function compareGazeEnvironment(
  saved: GazeEnvironment,
  current: GazeEnvironment,
): {
  compatible: boolean;
  identityKnown: boolean;
  reason:
    | "invalid"
    | "pipeline"
    | "camera"
    | "capture-size"
    | "viewport"
    | null;
} {
  const mismatch = (
    reason: "invalid" | "pipeline" | "camera" | "capture-size" | "viewport",
  ) => ({ compatible: false, identityKnown: false, reason });
  if (!isGazeEnvironment(saved) || !isGazeEnvironment(current))
    return mismatch("invalid");
  if (
    saved.pipelineVersion !== current.pipelineVersion ||
    saved.featureCount !== current.featureCount
  )
    return mismatch("pipeline");
  if (saved.deviceId && current.deviceId && saved.deviceId !== current.deviceId)
    return mismatch("camera");
  if (
    saved.captureWidth !== current.captureWidth ||
    saved.captureHeight !== current.captureHeight
  )
    return mismatch("capture-size");
  if (
    saved.viewportWidth !== current.viewportWidth ||
    saved.viewportHeight !== current.viewportHeight ||
    saved.devicePixelRatio !== current.devicePixelRatio ||
    saved.viewportScale !== current.viewportScale
  )
    return mismatch("viewport");
  return {
    compatible: true,
    identityKnown: Boolean(saved.deviceId && current.deviceId),
    reason: null,
  };
}
