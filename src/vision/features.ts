import { clamp } from "./calibration";
import type { GestureKind } from "./gesture";

export type Landmark = { x: number; y: number; z?: number };
export type Blendshape = { categoryName: string; score: number };
export interface FaceFeatures {
  features: number[];
  quality: number;
  gestures: Record<GestureKind, number>;
  reason: string;
}

const midpoint = (a: Landmark, b: Landmark): Landmark => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});
const distance = (a: Landmark, b: Landmark) => Math.hypot(a.x - b.x, a.y - b.y);

/** Iris position in an eye-local basis cancels translation and some head roll. */
function irisCoordinate(
  iris: Landmark,
  outer: Landmark,
  inner: Landmark,
  upper: Landmark,
  lower: Landmark,
): [number, number, number] {
  const center = midpoint(outer, inner);
  const width = distance(outer, inner);
  if (width < 0.005) return [0, 0, 0];
  const dx = (inner.x - outer.x) / width;
  const dy = (inner.y - outer.y) / width;
  const ix = iris.x - center.x;
  const iy = iris.y - center.y;
  return [
    (ix * dx + iy * dy) / width,
    (-ix * dy + iy * dx) / width,
    distance(upper, lower) / width,
  ];
}

/** This quality is a geometric visibility gate, never a gaze-accuracy probability. */
export function extractFaceFeatures(
  landmarks: Landmark[],
  blendshapes: Blendshape[] = [],
): FaceFeatures | null {
  const indices = [
    1, 10, 33, 133, 159, 145, 263, 362, 386, 374, 152, 234, 454, 468, 473,
  ];
  if (
    indices.some(
      (i) =>
        !landmarks[i] ||
        !Number.isFinite(landmarks[i].x) ||
        !Number.isFinite(landmarks[i].y),
    )
  )
    return null;
  const left = irisCoordinate(
    landmarks[468],
    landmarks[33],
    landmarks[133],
    landmarks[159],
    landmarks[145],
  );
  const right = irisCoordinate(
    landmarks[473],
    landmarks[263],
    landmarks[362],
    landmarks[386],
    landmarks[374],
  );
  const faceWidth = distance(landmarks[234], landmarks[454]);
  const faceHeight = distance(landmarks[10], landmarks[152]);
  if (faceWidth < 0.04 || faceHeight < 0.04) return null;
  const headCenter = midpoint(landmarks[234], landmarks[454]);
  const verticalCenter = midpoint(landmarks[10], landmarks[152]);
  const nose = landmarks[1];
  const yaw = (nose.x - headCenter.x) / faceWidth;
  const pitch = (nose.y - verticalCenter.y) / faceHeight;
  const inFrame = indices.every(
    (i) =>
      landmarks[i].x >= 0.015 &&
      landmarks[i].x <= 0.985 &&
      landmarks[i].y >= 0.015 &&
      landmarks[i].y <= 0.985,
  );
  const sizeQuality = clamp((Math.min(faceWidth, faceHeight) - 0.08) / 0.13);
  const eyeQuality = clamp((Math.min(left[2], right[2]) - 0.06) / 0.12);
  const poseQuality = clamp(1 - Math.max(0, Math.abs(yaw) - 0.12) * 4);
  const quality = clamp(
    Math.min(sizeQuality, eyeQuality, poseQuality, inFrame ? 1 : 0.2),
  );
  const blend = (name: string) =>
    clamp(blendshapes.find((v) => v.categoryName === name)?.score ?? 0);
  return {
    features: [
      left[0],
      left[1],
      right[0],
      right[1],
      yaw,
      pitch,
      headCenter.x,
      headCenter.y,
    ],
    quality,
    gestures: {
      jawOpen: blend("jawOpen"),
      browInnerUp: blend("browInnerUp"),
      mouthSmile: (blend("mouthSmileLeft") + blend("mouthSmileRight")) / 2,
    },
    reason: !inFrame
      ? "Keep your face inside the camera frame."
      : sizeQuality < 0.5
        ? "Move closer if comfortable."
        : eyeQuality < 0.5
          ? "Eyes are not clearly visible."
          : poseQuality < 0.5
            ? "Face the screen if comfortable."
            : "Face landmarks visible.",
  };
}
