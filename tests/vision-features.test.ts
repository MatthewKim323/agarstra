import { describe, expect, it } from "vitest";
import { extractFaceFeatures, type Landmark } from "../src/vision/features";

function visibleFace(): Landmark[] {
  const face = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const put = (i: number, x: number, y: number) => {
    face[i] = { x, y };
  };
  put(234, 0.25, 0.5);
  put(454, 0.75, 0.5);
  put(10, 0.5, 0.2);
  put(152, 0.5, 0.8);
  put(1, 0.5, 0.5);
  put(33, 0.3, 0.4);
  put(133, 0.43, 0.4);
  put(159, 0.365, 0.38);
  put(145, 0.365, 0.42);
  put(468, 0.365, 0.4);
  put(263, 0.7, 0.4);
  put(362, 0.57, 0.4);
  put(386, 0.635, 0.38);
  put(374, 0.635, 0.42);
  put(473, 0.635, 0.4);
  return face;
}

describe("face geometry features", () => {
  it("produces eight finite iris/head features and raw gesture coefficients", () => {
    const features = extractFaceFeatures(visibleFace(), [
      { categoryName: "jawOpen", score: 0.8 },
    ]);
    expect(features?.features).toHaveLength(8);
    expect(features?.features.every(Number.isFinite)).toBe(true);
    expect(features?.quality).toBeGreaterThan(0.5);
    expect(features?.gestures.jawOpen).toBe(0.8);
  });
  it("rejects absent or incomplete iris landmarks", () => {
    expect(extractFaceFeatures([])).toBe(null);
    expect(extractFaceFeatures(visibleFace().slice(0, 468))).toBe(null);
  });
  it("reduces quality when eyes are closed instead of producing a click", () => {
    const face = visibleFace();
    face[159] = face[145];
    const features = extractFaceFeatures(face, [
      { categoryName: "eyeBlinkLeft", score: 1 },
    ]);
    expect(features?.quality).toBe(0);
    expect(features?.gestures.jawOpen).toBe(0);
  });
  it("gates faces leaving the frame", () => {
    const face = visibleFace();
    face[234].x = -0.02;
    expect(extractFaceFeatures(face)?.quality).toBeLessThan(0.5);
  });
  it("rejects nonfinite coordinates", () => {
    const face = visibleFace();
    face[468].x = NaN;
    expect(extractFaceFeatures(face)).toBe(null);
  });
});
