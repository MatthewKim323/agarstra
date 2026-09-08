import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { Landmark } from "../src/vision/features";
import {
  EYE_IMAGE_SIZE,
  EyeImageProcessor,
  localCanvas,
  originalImageCrop,
  peekrEyeInputs,
  rgbaToPeekrTensor,
} from "../src/vision/eye-images";
import {
  createNeuralGazeRuntime,
  type NeuralGazeRuntime,
} from "../src/vision/neural-gaze";

const ort = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
  wasm: { wasmPaths: "", numThreads: 0, proxy: true },
  tensorAttempts: 0,
  failTensorAt: 0,
  tensors: [] as {
    type: string;
    data: Float32Array;
    dims: number[];
    dispose: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("onnxruntime-web/wasm", () => ({
  env: { wasm: ort.wasm },
  InferenceSession: { create: ort.create },
  Tensor: class {
    dispose = vi.fn();
    constructor(
      readonly type: string,
      readonly data: Float32Array,
      readonly dims: number[],
    ) {
      ort.tensorAttempts += 1;
      if (ort.tensorAttempts === ort.failTensorAt)
        throw new Error("Tensor allocation failed.");
      ort.tensors.push(this);
    }
  },
}));

function landmarks(): Landmark[] {
  const points = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  points[130] = { x: 0.2, y: 0.35 };
  points[27] = { x: 0.25, y: 0.3 };
  points[243] = { x: 0.4, y: 0.35 };
  points[23] = { x: 0.25, y: 0.4 };
  points[463] = { x: 0.6, y: 0.37 };
  points[257] = { x: 0.65, y: 0.31 };
  points[359] = { x: 0.8, y: 0.37 };
  points[253] = { x: 0.65, y: 0.43 };
  return points;
}

function detection(faces: Landmark[][] = [landmarks()]): FaceLandmarkerResult {
  return { faceLandmarks: faces } as unknown as FaceLandmarkerResult;
}

function output(values: number[] = [0.42, 0.17]) {
  return {
    output: {
      data: new Float32Array(values),
      dispose: vi.fn(),
    },
  };
}

let canDraw = true;
const canvases: FakeCanvas[] = [];
const runtimes: NeuralGazeRuntime[] = [];
class FakeCanvas {
  readonly context = {
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn(
      (_x: number, _y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        // Each eye has distinguishable pixels and noninterchangeable color channels.
        data.set([this.index * 10, this.index * 20, this.index * 30, 255]);
        data.set([77, 123, 241, 0], data.length - 4);
        return { data };
      },
    ),
  };
  readonly index: number;
  getContext = vi.fn(() => (canDraw ? this.context : null));
  constructor(
    public width: number,
    public height: number,
  ) {
    this.index = canvases.length;
    canvases.push(this);
  }
}

const source = {} as CanvasImageSource;

async function loadRuntime() {
  const runtime = await createNeuralGazeRuntime();
  runtimes.push(runtime);
  return runtime;
}

beforeEach(() => {
  canDraw = true;
  canvases.length = 0;
  runtimes.length = 0;
  ort.tensors.length = 0;
  ort.tensorAttempts = 0;
  ort.failTensorAt = 0;
  ort.create.mockReset();
  ort.run.mockReset().mockImplementation(async () => output());
  ort.release.mockReset().mockResolvedValue(undefined);
  ort.create.mockResolvedValue({
    inputNames: ["input1", "input2", "kps"],
    outputNames: ["output"],
    run: ort.run,
    release: ort.release,
  });
  ort.wasm.wasmPaths = "";
  ort.wasm.numThreads = 0;
  ort.wasm.proxy = true;
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("document", {
    createElement: vi.fn(() => new FakeCanvas(1, 1)),
    body: { appendChild: vi.fn() },
  });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  runtimes.forEach((runtime) => runtime.close());
  vi.unstubAllGlobals();
});

describe("Peekr pixel and landmark contract", () => {
  it("preserves row-major pixel order while converting asymmetric RGBA to planar BGR", () => {
    const rgba = new Uint8ClampedArray([
      0, 64, 255, 255, 17, 128, 33, 0, 250, 10, 99, 127, 42, 11, 201, 255, 8,
      77, 166, 19, 123, 222, 31, 200,
    ]);
    const original = rgba.slice();
    const tensor = rgbaToPeekrTensor(rgba, 3, 2);
    const expected = [
      255, 33, 99, 201, 166, 31, 64, 128, 10, 11, 77, 222, 0, 17, 250, 42, 8,
      123,
    ].map((value) => value / 255);
    expect(tensor).toBeInstanceOf(Float32Array);
    expect(tensor).toHaveLength(18);
    tensor.forEach((value, index) =>
      expect(value).toBeCloseTo(expected[index], 6),
    );
    expect(rgba).toEqual(original);
  });

  it("accepts a single pixel and excludes alpha regardless of transparency", () => {
    expect(
      rgbaToPeekrTensor(new Uint8ClampedArray([255, 0, 255, 0]), 1, 1),
    ).toEqual(new Float32Array([1, 0, 1]));
  });

  it.each([
    [0, 1, 0],
    [1, 0, 0],
    [-1, 1, 4],
    [1.5, 1, 4],
    [1, 1.5, 4],
    [Number.NaN, 1, 4],
    [1, Number.POSITIVE_INFINITY, 4],
    [4097, 1, 4],
    [1, 4097, 4],
    [2, 2, 15],
    [2, 2, 17],
  ])(
    "rejects invalid or oversized tensor dimensions %s x %s with %s bytes",
    (width, height, length) => {
      expect(() =>
        rgbaToPeekrTensor(new Uint8ClampedArray(length), width, height),
      ).toThrow("Invalid eye image dimensions.");
    },
  );

  it("accepts the dimension limit without permitting a larger allocation", () => {
    expect(
      rgbaToPeekrTensor(new Uint8ClampedArray(4096 * 4), 4096, 1),
    ).toHaveLength(4096 * 3);
  });

  it("builds two positive eye boxes in the upstream landmark order", () => {
    const points = landmarks();
    const original = structuredClone(points);
    const inputs = peekrEyeInputs(points)!;
    expect(inputs.boxes[0]).toEqual({
      x: 0.2,
      y: 0.3,
      width: 0.2,
      height: expect.closeTo(0.1),
    });
    expect(inputs.boxes[1]).toEqual({
      x: 0.6,
      y: 0.31,
      width: expect.closeTo(0.2),
      height: expect.closeTo(0.12),
    });
    expect(inputs.keypoints).toHaveLength(8);
    [0.2, 0.3, 0.2, 0.1, 0.6, 0.31, 0.2, 0.12].forEach((value, index) => {
      expect(inputs.keypoints[index]).toBeCloseTo(value, 10);
    });
    expect(points).toEqual(original);
  });

  it.each([
    [130, "x", -0.01],
    [27, "y", -0.01],
    [243, "x", 1.01],
    [23, "y", 1.01],
    [243, "x", 0.19],
    [23, "y", 0.29],
    [243, "x", 0.204],
    [23, "y", 0.302],
    [463, "x", Number.NaN],
    [257, "y", Number.POSITIVE_INFINITY],
    [359, "x", Number.NEGATIVE_INFINITY],
    [253, "y", Number.NaN],
  ] as const)(
    "rejects invalid landmark %s.%s=%s without changing the input",
    (index, axis, value) => {
      const points = landmarks();
      points[index][axis] = value;
      const original = structuredClone(points);
      expect(peekrEyeInputs(points)).toBeNull();
      expect(points).toEqual(original);
    },
  );

  it("rejects absent eye landmarks rather than guessing their position", () => {
    expect(peekrEyeInputs([])).toBeNull();
    expect(peekrEyeInputs(landmarks().slice(0, 463))).toBeNull();
  });

  it("allows valid crops that exactly meet the image border", () => {
    const points = landmarks();
    points[130].x = 0;
    points[27].y = 0;
    points[359].x = 1;
    points[253].y = 1;
    expect(peekrEyeInputs(points)).not.toBeNull();
  });

  it("maps mirrored detection boxes back to distinct original-image eye crops", () => {
    const inputs = peekrEyeInputs(landmarks())!;
    const left = originalImageCrop(inputs.boxes[0], 1000, 500);
    const right = originalImageCrop(inputs.boxes[1], 1000, 500);
    expect(left).toEqual({
      x: expect.closeTo(600),
      y: 150,
      width: 200,
      height: expect.closeTo(50),
    });
    expect(right).toEqual({
      x: expect.closeTo(200),
      y: 155,
      width: expect.closeTo(200),
      height: expect.closeTo(60),
    });
    expect(left.x).toBeGreaterThan(right.x);
  });
});

describe("local reusable eye canvases", () => {
  it("creates local offscreen surfaces without camera, network, storage, or DOM attachment", () => {
    const images = new EyeImageProcessor();
    expect(canvases.map(({ width, height }) => [width, height])).toEqual([
      [1, 1],
      [128, 128],
      [128, 128],
    ]);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(document.createElement).not.toHaveBeenCalled();
    expect(document.body.appendChild).not.toHaveBeenCalled();
    images.clear();
  });

  it("mirrors the source before inference and restores the identity transform", () => {
    const images = new EyeImageProcessor();
    const mirrored = images.mirror(source, 1280, 720);
    expect(mirrored).toBe(canvases[0]);
    expect([mirrored.width, mirrored.height]).toEqual([1280, 720]);
    expect(canvases[0].context.setTransform.mock.calls).toEqual([
      [-1, 0, 0, 1, 1280, 0],
      [1, 0, 0, 1, 0, 0],
    ]);
    expect(canvases[0].context.drawImage).toHaveBeenCalledWith(
      source,
      0,
      0,
      1280,
      720,
    );
    expect(images.mirror(source, 640, 480)).toBe(mirrored);
    expect(canvases).toHaveLength(3);
    expect([mirrored.width, mirrored.height]).toEqual([640, 480]);
  });

  it("reads original-source crops into fixed-size eyes and reuses canvas allocations", () => {
    const images = new EyeImageProcessor();
    const tensors = images.tensors(source, 1000, 500, landmarks())!;
    expect(canvases[1].context.drawImage).toHaveBeenCalledWith(
      source,
      expect.closeTo(600),
      150,
      200,
      expect.closeTo(50),
      0,
      0,
      128,
      128,
    );
    expect(canvases[2].context.drawImage).toHaveBeenCalledWith(
      source,
      expect.closeTo(200),
      155,
      expect.closeTo(200),
      expect.closeTo(60),
      0,
      0,
      128,
      128,
    );
    expect(tensors.left).toHaveLength(3 * EYE_IMAGE_SIZE ** 2);
    expect(tensors.right).toHaveLength(3 * EYE_IMAGE_SIZE ** 2);
    expect(tensors.left[0]).toBeCloseTo(30 / 255);
    expect(tensors.right[0]).toBeCloseTo(60 / 255);
    images.tensors(source, 1000, 500, landmarks());
    expect(canvases).toHaveLength(3);
  });

  it("does not read image pixels when required landmarks are invalid", () => {
    const images = new EyeImageProcessor();
    expect(images.tensors(source, 1000, 500, [])).toBeNull();
    canvases.forEach(({ context }) => {
      expect(context.drawImage).not.toHaveBeenCalled();
      expect(context.getImageData).not.toHaveBeenCalled();
    });
  });

  it("supports an unattached HTML canvas when OffscreenCanvas is unavailable", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { canvas, context } = localCanvas(80, 40);
    expect(document.createElement).toHaveBeenCalledWith("canvas");
    expect([canvas.width, canvas.height]).toEqual([80, 40]);
    expect(context).toBe(canvases[0].context);
    expect(document.body.appendChild).not.toHaveBeenCalled();
    expect(canvases[0].getContext).toHaveBeenCalledWith("2d", {
      willReadFrequently: true,
    });
  });

  it("reports an unavailable 2D context without requesting a camera", () => {
    canDraw = false;
    expect(() => localCanvas(128, 128)).toThrow(
      "Local image processing is unavailable",
    );
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("erases every owned pixel surface on clear, including the mirrored full frame", () => {
    const images = new EyeImageProcessor();
    images.mirror(source, 640, 480);
    images.clear();
    expect(canvases[0].context.clearRect).toHaveBeenCalledWith(0, 0, 640, 480);
    expect(canvases[1].context.clearRect).toHaveBeenCalledWith(0, 0, 128, 128);
    expect(canvases[2].context.clearRect).toHaveBeenCalledWith(0, 0, 128, 128);
    expect(
      canvases.every(({ width, height }) => width === 1 && height === 1),
    ).toBe(true);
    expect(() => images.clear()).not.toThrow();
  });
});

describe("local ONNX gaze runtime lifecycle", () => {
  it("loads only the local model with single-threaded WASM and never requests a camera", async () => {
    await loadRuntime();
    expect(ort.create).toHaveBeenCalledWith("/vision/peekr.onnx", {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    expect(ort.wasm).toEqual({
      wasmPaths: { wasm: "/vision/onnx/ort-wasm-simd-threaded.wasm" },
      numThreads: 1,
      proxy: false,
    });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("feeds the exact named tensor shapes and preserves unbounded learned outputs", async () => {
    const result = output([-1.25, 1.75]);
    ort.run.mockResolvedValue(result);
    const runtime = await loadRuntime();
    const prediction = await runtime.predict(source, 1000, 500, detection());
    const feeds = ort.run.mock.calls[0][0];
    expect(Object.keys(feeds)).toEqual(["input1", "input2", "kps"]);
    expect(feeds.input1.dims).toEqual([1, 3, 128, 128]);
    expect(feeds.input2.dims).toEqual([1, 3, 128, 128]);
    expect(feeds.kps.dims).toEqual([1, 8]);
    expect(ort.tensors.every((tensor) => tensor.type === "float32")).toBe(true);
    expect(feeds.input1.data[0]).toBeCloseTo(30 / 255);
    expect(feeds.input2.data[0]).toBeCloseTo(60 / 255);
    expect(prediction?.raw).toEqual({ x: -1.25, y: 1.75 });
    expect(prediction?.keypoints).toEqual(
      peekrEyeInputs(landmarks())!.keypoints,
    );
    expect(prediction?.inferenceMs).toBeGreaterThanOrEqual(0);
    ort.tensors.forEach((tensor) =>
      expect(tensor.dispose).toHaveBeenCalledOnce(),
    );
    expect(result.output.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["input1", "input2"],
    ["input1", "kps"],
    ["input2", "kps"],
  ])("releases a model missing a required input: %j", async (...inputNames) => {
    ort.create.mockResolvedValue({
      inputNames,
      outputNames: ["output"],
      release: ort.release,
    });
    await expect(createNeuralGazeRuntime()).rejects.toThrow(
      "incompatible inputs",
    );
    expect(ort.release).toHaveBeenCalledOnce();
    expect(canvases).toHaveLength(0);
  });

  it("releases a model with no expected output name", async () => {
    ort.create.mockResolvedValue({
      inputNames: ["input1", "input2", "kps"],
      outputNames: ["prediction"],
      release: ort.release,
    });
    await expect(createNeuralGazeRuntime()).rejects.toThrow(
      "incompatible inputs",
    );
    expect(ort.release).toHaveBeenCalledOnce();
  });

  it("propagates a model-load failure without creating image surfaces", async () => {
    ort.create.mockRejectedValue(new Error("Pinned model unavailable."));
    await expect(createNeuralGazeRuntime()).rejects.toThrow(
      "Pinned model unavailable",
    );
    expect(canvases).toHaveLength(0);
    expect(ort.release).not.toHaveBeenCalled();
  });

  it("releases the loaded session when canvas initialization fails", async () => {
    canDraw = false;
    await expect(createNeuralGazeRuntime()).rejects.toThrow(
      "Local image processing is unavailable",
    );
    expect(ort.release).toHaveBeenCalledOnce();
  });

  it("refuses absent, multiple, or incomplete faces without allocating tensors", async () => {
    const runtime = await loadRuntime();
    expect(await runtime.predict(source, 640, 480, detection([]))).toBeNull();
    expect(
      await runtime.predict(
        source,
        640,
        480,
        detection([landmarks(), landmarks()]),
      ),
    ).toBeNull();
    expect(await runtime.predict(source, 640, 480, detection([[]]))).toBeNull();
    expect(ort.run).not.toHaveBeenCalled();
    expect(ort.tensors).toHaveLength(0);
  });

  it.each([
    [],
    [0.5],
    [0.1, 0.2, 0.3],
    [Number.NaN, 0.5],
    [0.5, Number.POSITIVE_INFINITY],
  ])(
    "rejects invalid outputs %j and disposes every tensor",
    async (...values) => {
      const result = output(values);
      ort.run.mockResolvedValue(result);
      const runtime = await loadRuntime();
      await expect(
        runtime.predict(source, 640, 480, detection()),
      ).rejects.toThrow("invalid coordinates");
      ort.tensors.forEach((tensor) =>
        expect(tensor.dispose).toHaveBeenCalledOnce(),
      );
      expect(result.output.dispose).toHaveBeenCalledOnce();
    },
  );

  it("rejects a missing result tensor and disposes unexpected model outputs", async () => {
    const unexpected = { data: new Float32Array([0.2, 0.4]), dispose: vi.fn() };
    ort.run.mockResolvedValue({ unexpected });
    const runtime = await loadRuntime();
    await expect(
      runtime.predict(source, 640, 480, detection()),
    ).rejects.toThrow("invalid coordinates");
    expect(unexpected.dispose).toHaveBeenCalledOnce();
    ort.tensors.forEach((tensor) =>
      expect(tensor.dispose).toHaveBeenCalledOnce(),
    );
  });

  it("disposes input tensors after inference failure and permits a later frame", async () => {
    ort.run.mockRejectedValueOnce(new Error("Inference failed."));
    const runtime = await loadRuntime();
    await expect(
      runtime.predict(source, 640, 480, detection()),
    ).rejects.toThrow("Inference failed");
    ort.tensors.forEach((tensor) =>
      expect(tensor.dispose).toHaveBeenCalledOnce(),
    );
    expect(await runtime.predict(source, 640, 480, detection())).not.toBeNull();
    expect(ort.run).toHaveBeenCalledTimes(2);
  });

  it("cleans up partial tensor allocation and permits a later frame", async () => {
    // Regression anchor: constructing feeds outside try/finally leaks partial allocations.
    ort.failTensorAt = 2;
    const runtime = await loadRuntime();
    await expect(
      runtime.predict(source, 640, 480, detection()),
    ).rejects.toThrow("Tensor allocation failed");
    expect(ort.tensors).toHaveLength(1);
    expect(ort.tensors[0].dispose).toHaveBeenCalledOnce();
    ort.failTensorAt = 0;
    expect(await runtime.predict(source, 640, 480, detection())).not.toBeNull();
    expect(ort.run).toHaveBeenCalledOnce();
  });

  it("drops overlapping frames instead of running concurrent model inference", async () => {
    let resolve!: (value: ReturnType<typeof output>) => void;
    ort.run.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const runtime = await loadRuntime();
    const first = runtime.predict(source, 640, 480, detection());
    expect(await runtime.predict(source, 640, 480, detection())).toBeNull();
    expect(ort.run).toHaveBeenCalledOnce();
    expect(ort.tensors).toHaveLength(3);
    resolve(output());
    expect(await first).not.toBeNull();
    expect(await runtime.predict(source, 640, 480, detection())).not.toBeNull();
    expect(ort.run).toHaveBeenCalledTimes(2);
  });

  it("suppresses late predictions and releases once after a pending inference settles", async () => {
    let resolve!: (value: ReturnType<typeof output>) => void;
    ort.run.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const runtime = await loadRuntime();
    const pending = runtime.predict(source, 640, 480, detection());
    runtime.close();
    runtime.close();
    expect(ort.release).not.toHaveBeenCalled();
    expect(await runtime.predict(source, 640, 480, detection())).toBeNull();
    const result = output();
    resolve(result);
    expect(await pending).toBeNull();
    expect(result.output.dispose).toHaveBeenCalledOnce();
    ort.tensors.forEach((tensor) =>
      expect(tensor.dispose).toHaveBeenCalledOnce(),
    );
    expect(ort.release).toHaveBeenCalledOnce();
    expect(
      canvases.every(({ width, height }) => width === 1 && height === 1),
    ).toBe(true);
    runtime.close();
    expect(ort.release).toHaveBeenCalledOnce();
  });

  it("releases after a stopped in-flight inference rejects", async () => {
    let reject!: (reason: Error) => void;
    ort.run.mockReturnValueOnce(
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
    );
    const runtime = await loadRuntime();
    const pending = runtime.predict(source, 640, 480, detection());
    runtime.close();
    reject(new Error("Stopped inference failed."));
    await expect(pending).rejects.toThrow("Stopped inference failed");
    expect(ort.release).toHaveBeenCalledOnce();
    ort.tensors.forEach((tensor) =>
      expect(tensor.dispose).toHaveBeenCalledOnce(),
    );
  });

  it("makes close idempotent and prevents any future image read or inference", async () => {
    const runtime = await loadRuntime();
    runtime.close();
    runtime.close();
    expect(ort.release).toHaveBeenCalledOnce();
    expect(await runtime.predict(source, 640, 480, detection())).toBeNull();
    expect(ort.run).not.toHaveBeenCalled();
    canvases.forEach(({ context }) =>
      expect(context.getImageData).not.toHaveBeenCalled(),
    );
  });
});
