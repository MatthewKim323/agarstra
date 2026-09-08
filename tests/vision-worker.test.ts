import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({
  face: {
    detector: { close: vi.fn(), detectForVideo: vi.fn() },
    delegate: "CPU",
  },
  neural: { close: vi.fn(), predict: vi.fn(), images: { mirror: vi.fn() } },
  createFace: vi.fn(),
  createNeural: vi.fn(),
}));
vi.mock("../src/vision/runtime", () => ({
  createFaceDetector: models.createFace,
}));
vi.mock("../src/vision/neural-gaze", () => ({
  createNeuralGazeRuntime: models.createNeural,
}));

type Scope = {
  onmessage: ((event: MessageEvent) => Promise<void>) | null;
  postMessage: ReturnType<typeof vi.fn>;
};
let scope: Scope;
const result = { faceLandmarks: [], faceBlendshapes: [] };
const gaze = {
  raw: { x: 0.4, y: 0.6 },
  keypoints: Array(8).fill(0),
  inferenceMs: 1,
};

function bitmap() {
  return { width: 640, height: 480, close: vi.fn() };
}
function dispatch(message: {
  type: "init" | "frame";
  bitmap?: ReturnType<typeof bitmap>;
  timestamp?: number;
}) {
  return scope.onmessage!({ data: message } as MessageEvent);
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  models.createFace.mockResolvedValue(models.face);
  models.createNeural.mockResolvedValue(models.neural);
  models.face.detector.detectForVideo.mockReturnValue(result);
  models.neural.predict.mockResolvedValue(gaze);
  models.neural.images.mirror.mockReturnValue({ mirrored: true });
  scope = { onmessage: null, postMessage: vi.fn() };
  vi.stubGlobal("self", scope);
  await import("../src/vision/face.worker");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vision worker frame ownership", () => {
  it("closes frames received before initialization without emitting a result", async () => {
    const frame = bitmap();
    await dispatch({ type: "frame", bitmap: frame, timestamp: 1 });
    expect(frame.close).toHaveBeenCalledOnce();
    expect(models.face.detector.detectForVideo).not.toHaveBeenCalled();
    expect(scope.postMessage).not.toHaveBeenCalled();
  });

  it("does not let a dropped concurrent frame unlock the active inference", async () => {
    await dispatch({ type: "init" });
    let resolve!: (value: typeof gaze) => void;
    models.neural.predict.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const frames = [bitmap(), bitmap(), bitmap()];
    const pending = dispatch({
      type: "frame",
      bitmap: frames[0],
      timestamp: 1,
    });
    await dispatch({ type: "frame", bitmap: frames[1], timestamp: 2 });
    await dispatch({ type: "frame", bitmap: frames[2], timestamp: 3 });
    const inferencesBeforeCompletion = models.neural.predict.mock.calls.length;
    const firstFrameClosedEarly = frames[0].close.mock.calls.length;
    resolve(gaze);
    await pending;
    expect(inferencesBeforeCompletion).toBe(1);
    expect(firstFrameClosedEarly).toBe(0);
    frames.forEach((frame) => expect(frame.close).toHaveBeenCalledOnce());
    expect(
      scope.postMessage.mock.calls.filter(
        ([message]) => message.type === "result",
      ),
    ).toHaveLength(1);
  });

  it("passes the original frame to neural prediction and closes it after the result", async () => {
    await dispatch({ type: "init" });
    const frame = bitmap();
    await dispatch({ type: "frame", bitmap: frame, timestamp: 100 });
    expect(models.neural.images.mirror).toHaveBeenCalledExactlyOnceWith(
      frame,
      640,
      480,
    );
    expect(models.face.detector.detectForVideo).toHaveBeenCalledExactlyOnceWith(
      { mirrored: true },
      100,
    );
    expect(models.neural.predict).toHaveBeenCalledExactlyOnceWith(
      frame,
      640,
      480,
      result,
    );
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: "result",
      result,
      neural: gaze,
      timestamp: 100,
    });
    expect(frame.close).toHaveBeenCalledOnce();
  });

  it("releases the busy guard after a failed prediction", async () => {
    await dispatch({ type: "init" });
    models.neural.predict.mockRejectedValueOnce(new Error("Inference failed."));
    const rejected = bitmap();
    const next = bitmap();
    await dispatch({ type: "frame", bitmap: rejected, timestamp: 1 });
    await dispatch({ type: "frame", bitmap: next, timestamp: 2 });
    expect(models.neural.predict).toHaveBeenCalledTimes(2);
    expect(scope.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "Inference failed.",
    });
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: "result",
      result,
      neural: gaze,
      timestamp: 2,
    });
    expect(rejected.close).toHaveBeenCalledOnce();
    expect(next.close).toHaveBeenCalledOnce();
  });

  it("does not replace live models when initialization is requested twice", async () => {
    await dispatch({ type: "init" });
    await dispatch({ type: "init" });
    expect(models.createFace).toHaveBeenCalledOnce();
    expect(models.createNeural).toHaveBeenCalledOnce();
    expect(scope.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "ready",
      delegate: "CPU",
    });
  });

  it("keeps initialization owned while duplicate init and early frames are dropped", async () => {
    let resolve!: (value: typeof models.face) => void;
    models.createFace.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = dispatch({ type: "init" });
    await dispatch({ type: "init" });
    const earlyFrame = bitmap();
    await dispatch({ type: "frame", bitmap: earlyFrame, timestamp: 1 });
    await dispatch({ type: "init" });
    const creationsBeforeReady = models.createFace.mock.calls.length;
    resolve(models.face);
    await pending;
    expect(creationsBeforeReady).toBe(1);
    expect(models.createNeural).toHaveBeenCalledOnce();
    expect(earlyFrame.close).toHaveBeenCalledOnce();
    expect(models.neural.predict).not.toHaveBeenCalled();
  });

  it("closes a partially initialized face model and permits an explicit retry", async () => {
    models.createNeural.mockRejectedValueOnce(new Error("Model unavailable."));
    await dispatch({ type: "init" });
    expect(models.face.detector.close).toHaveBeenCalledOnce();
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: "error",
      message: "Model unavailable.",
    });
    await dispatch({ type: "init" });
    expect(models.createFace).toHaveBeenCalledTimes(2);
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: "ready",
      delegate: "CPU",
    });
  });

  it("preserves an initialization failure and releases ownership when cleanup also throws", async () => {
    models.createNeural.mockRejectedValueOnce(new Error("Gaze model failed."));
    models.face.detector.close.mockImplementationOnce(() => {
      throw new Error("Face close failed.");
    });
    await expect(dispatch({ type: "init" })).resolves.toBeUndefined();
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: "error",
      message: "Gaze model failed.",
    });
    await dispatch({ type: "init" });
    expect(models.createFace).toHaveBeenCalledTimes(2);
    expect(scope.postMessage).toHaveBeenLastCalledWith({
      type: "ready",
      delegate: "CPU",
    });
  });
});
