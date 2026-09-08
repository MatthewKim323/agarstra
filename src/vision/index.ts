/**
 * Nerve local vision API. CameraTracker requires an explicit start(video,...).
 * Observation.x/y are normalized screen coordinates AFTER calibration, otherwise center.
 * Observation.quality is geometry/visibility, not confidence or measured gaze accuracy.
 * Observation.gesture is a one-shot event only after explicit neutral/action calibration.
 * Observation.gestureStrength exposes the selected raw blendshape for calibration.
 * Eight iris/head features feed fitCalibration; validate on separate held-out targets.
 */
export { CameraTracker, type CameraDiagnostics } from "./CameraTracker";
export {
  fitCalibration,
  predictCalibration,
  validateCalibration,
  isCalibrationModel,
  PointSmoother,
  type CalibrationModel,
  type CalibrationValidation,
} from "./calibration";
export {
  calibrateGesture,
  isGestureConfig,
  GestureDetector,
  type GestureConfig,
  type GestureKind,
} from "./gesture";
export {
  extractFaceFeatures,
  type FaceFeatures,
  type Landmark,
} from "./features";
export {
  GazeCalibrationSession,
  GestureCalibrationSession,
  GAZE_TRAIN_TARGETS,
  GAZE_VALIDATION_TARGETS,
  type GazeCalibrationState,
  type GestureCalibrationState,
} from "./calibration-session";
