import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraTracker } from "../src/vision/CameraTracker";

const mockRuntime = vi.hoisted(() => ({
  detector: { close: vi.fn(), detectForVideo: vi.fn() },
  delegate: "CPU" as const,
}));
vi.mock("../src/vision/runtime", () => ({
  createFaceDetector: vi.fn(async () => mockRuntime),
}));

describe("camera consent and lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", undefined);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("document", { hidden: false });
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not request the camera merely by constructing a tracker", () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const tracker = new CameraTracker();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(tracker.getDiagnostics().running).toBe(false);
  });
  it("reports permission denial without leaving active resources", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    const tracker = new CameraTracker();
    const onError = vi.fn();
    const video = {
      srcObject: null,
      play: vi.fn(),
    } as unknown as HTMLVideoElement;
    await expect(tracker.start(video, vi.fn(), onError)).rejects.toThrow(
      /permission was denied/,
    );
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("permission was denied"),
    );
    expect(tracker.getDiagnostics().running).toBe(false);
    expect(video.srcObject).toBe(null);
  });
  it("requests no audio and releases tracks, detector and video on stop", async () => {
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const tracker = new CameraTracker();
    const video = {
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    await tracker.start(video, vi.fn(), vi.fn());
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false }),
    );
    expect(tracker.getDiagnostics().running).toBe(true);
    tracker.stop();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(mockRuntime.detector.close).toHaveBeenCalledOnce();
    expect(video.srcObject).toBe(null);
  });
  it("stops a late permission response after cancellation", async () => {
    let resolve!: (stream: unknown) => void;
    const getUserMedia = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const tracker = new CameraTracker();
    const video = {
      srcObject: null,
      play: vi.fn(),
    } as unknown as HTMLVideoElement;
    const pending = tracker.start(video, vi.fn(), vi.fn());
    tracker.stop();
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] });
    await pending;
    expect(stop).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(tracker.getDiagnostics().running).toBe(false);
  });
  it("cancels and terminates a worker while its model is still initializing", async () => {
    const instances: { terminate: ReturnType<typeof vi.fn> }[] = [];
    class PendingWorker {
      onmessage: unknown = null;
      onerror: unknown = null;
      postMessage = vi.fn();
      terminate = vi.fn();
      constructor() {
        instances.push(this);
      }
    }
    vi.stubGlobal("Worker", PendingWorker);
    vi.stubGlobal("createImageBitmap", vi.fn());
    const track = { stop: vi.fn(), addEventListener: vi.fn() };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue({
            getTracks: () => [track],
            getVideoTracks: () => [track],
          }),
      },
    });
    const tracker = new CameraTracker();
    const video = {
      srcObject: null,
      play: vi.fn().mockResolvedValue(undefined),
    } as unknown as HTMLVideoElement;
    const pending = tracker.start(video, vi.fn(), vi.fn());
    await vi.waitFor(() => expect(instances).toHaveLength(1));
    tracker.stop();
    await pending;
    expect(instances[0].terminate).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(tracker.getDiagnostics().running).toBe(false);
  });
});
