import type { Landmark } from "./features";

// Peekr's MIT-licensed input contract. See THIRD_PARTY_NOTICES.md.
// Detection runs on a mirrored frame. Eye pixels come from the ORIGINAL frame.
export const EYE_IMAGE_SIZE = 128;
export const NEURAL_FEATURE_COUNT = 18;
export type EyeBox = { x: number; y: number; width: number; height: number };
export type EyeInputs = { boxes: [EyeBox, EyeBox]; keypoints: number[] };

export function peekrEyeInputs(landmarks: Landmark[]): EyeInputs | null {
  const groups = [
    [130, 27, 243, 23],
    [463, 257, 359, 253],
  ];
  const boxes: EyeBox[] = [];
  for (const [left, top, right, bottom] of groups) {
    const points = [left, top, right, bottom].map((index) => landmarks[index]);
    if (
      points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
    )
      return null;
    const box = {
      x: points[0].x,
      y: points[1].y,
      width: points[2].x - points[0].x,
      height: points[3].y - points[1].y,
    };
    // Do not silently clamp an invalid crop, which would change the learned input contract.
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.width < 0.005 ||
      box.height < 0.003 ||
      box.x + box.width > 1 ||
      box.y + box.height > 1
    )
      return null;
    boxes.push(box);
  }
  return {
    boxes: boxes as [EyeBox, EyeBox],
    keypoints: boxes.flatMap((b) => [b.x, b.y, b.width, b.height]),
  };
}

export function originalImageCrop(
  box: EyeBox,
  width: number,
  height: number,
): EyeBox {
  return {
    x: (1 - box.x - box.width) * width,
    y: box.y * height,
    width: box.width * width,
    height: box.height * height,
  };
}

/** RGBA pixels to Peekr float32 BGR, channels-first, divided by 255. */
export function rgbaToPeekrTensor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    rgba.length !== width * height * 4
  ) {
    throw new Error("Invalid eye image dimensions.");
  }
  const pixels = width * height;
  const output = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    output[i] = rgba[i * 4 + 2] / 255;
    output[pixels + i] = rgba[i * 4 + 1] / 255;
    output[pixels * 2 + i] = rgba[i * 4] / 255;
  }
  return output;
}

type Canvas = OffscreenCanvas | HTMLCanvasElement;
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function localCanvas(
  width: number,
  height: number,
): { canvas: Canvas; context: Context } {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d", {
    willReadFrequently: true,
  }) as Context | null;
  if (!context)
    throw new Error("Local image processing is unavailable in this browser.");
  return { canvas, context };
}

/** Owns only reusable local canvases. Nothing is attached to the DOM or persisted. */
export class EyeImageProcessor {
  private mirrored = localCanvas(1, 1);
  private eyes = [
    localCanvas(EYE_IMAGE_SIZE, EYE_IMAGE_SIZE),
    localCanvas(EYE_IMAGE_SIZE, EYE_IMAGE_SIZE),
  ];

  mirror(source: CanvasImageSource, width: number, height: number): Canvas {
    const { canvas, context } = this.mirrored;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(-1, 0, 0, 1, width, 0);
    context.drawImage(source, 0, 0, width, height);
    context.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
  }

  tensors(
    source: CanvasImageSource,
    width: number,
    height: number,
    landmarks: Landmark[],
  ) {
    const inputs = peekrEyeInputs(landmarks);
    if (!inputs) return null;
    const images = inputs.boxes.map((box, index) => {
      const crop = originalImageCrop(box, width, height);
      const { context } = this.eyes[index];
      context.drawImage(
        source,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        EYE_IMAGE_SIZE,
        EYE_IMAGE_SIZE,
      );
      return rgbaToPeekrTensor(
        context.getImageData(0, 0, EYE_IMAGE_SIZE, EYE_IMAGE_SIZE).data,
        EYE_IMAGE_SIZE,
        EYE_IMAGE_SIZE,
      );
    });
    return { left: images[0], right: images[1], keypoints: inputs.keypoints };
  }

  clear(): void {
    for (const { canvas, context } of [this.mirrored, ...this.eyes]) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      canvas.width = canvas.height = 1;
    }
  }
}
