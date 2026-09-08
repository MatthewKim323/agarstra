import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  ScanEye,
  CheckCircle2,
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import type { Observation } from "../../shared/types";
import { Dialog } from "./Dialog";
import { CameraTracker } from "../vision/CameraTracker";
import type { GestureKind } from "../vision/gesture";
import type { CalibrationValidation } from "../vision/calibration";
import {
  GazeCalibrationSession,
  GestureCalibrationSession,
  type GazeCalibrationState,
  type GestureCalibrationState,
} from "../vision/calibration-session";
import "./CameraPanel.css";

type ActiveSession =
  | { kind: "gaze"; session: GazeCalibrationSession }
  | { kind: "gesture"; session: GestureCalibrationSession };
type CameraPanelProps = {
  open: boolean;
  onClose: () => void;
  onObservation: (observation: Observation) => void;
  onReady: (ready: boolean) => void;
  onStop: (stop: () => void) => void;
  onError: (message: string) => void;
};

/** Camera consent and calibration UI. The video remains mounted across dialog openings. */
export function CameraPanel(props: CameraPanelProps) {
  const { open } = props;
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tracker = useRef<CameraTracker | null>(null);
  const latest = useRef<Observation | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const mounted = useRef(true);
  const generation = useRef(0);
  const active = useRef<ActiveSession | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const readyRef = useRef(false);
  const startingRef = useRef(false);
  const gazePassedRef = useRef(false);
  const stopRef = useRef<() => void>(() => {});
  const viewport = useRef({ width: 0, height: 0 });
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [quality, setQuality] = useState(0);
  const [faceStatus, setFaceStatus] = useState("Camera is off.");
  const [kind, setKind] = useState<GestureKind>("jawOpen");
  const [validation, setValidation] = useState<CalibrationValidation | null>(
    null,
  );
  const [gazePassed, setGazePassed] = useState(false);
  const [gesturePassed, setGesturePassed] = useState(false);
  const [gazeState, setGazeState] = useState<GazeCalibrationState | null>(null);
  const [gestureState, setGestureState] =
    useState<GestureCalibrationState | null>(null);
  const [scanId, setScanId] = useState("");
  const scanRef = useRef("");

  const clearSession = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    active.current = null;
  }, []);

  const setReady = useCallback((ready: boolean) => {
    readyRef.current = ready;
    callbacks.current.onReady(ready);
  }, []);

  const invalidateCalibration = useCallback(() => {
    clearSession();
    tracker.current?.setCalibration(null);
    tracker.current?.setGesture(null);
    gazePassedRef.current = false;
    setReady(false);
    if (mounted.current) {
      setGazePassed(false);
      setGesturePassed(false);
      setGazeState(null);
      setGestureState(null);
      setValidation(null);
    }
  }, [clearSession, setReady]);

  const stop = useCallback(() => {
    generation.current++;
    startingRef.current = false;
    invalidateCalibration();
    const current = tracker.current;
    tracker.current = null;
    current?.stop();
    latest.current = null;
    if (mounted.current)
      callbacks.current.onObservation({
        x: 0.5,
        y: 0.5,
        quality: 0,
        timestamp: performance.now(),
        gesture: false,
        gestureStrength: 0,
        features: [],
      });
    if (mounted.current) {
      setRunning(false);
      setBusy(false);
      setQuality(0);
      setFaceStatus("Camera is off.");
    }
    const preview = canvas.current;
    if (preview)
      preview.getContext("2d")?.clearRect(0, 0, preview.width, preview.height);
  }, [invalidateCalibration]);
  stopRef.current = stop;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopRef.current();
    };
  }, []);
  useEffect(() => {
    props.onStop(stop);
  }, [props.onStop, stop]);

  useEffect(() => {
    // Closing an unfinished setup also cancels an outstanding permission request.
    if (
      !open &&
      (startingRef.current ||
        active.current ||
        (tracker.current && !readyRef.current))
    )
      stop();
  }, [open, stop]);

  useEffect(() => {
    const resize = () => {
      if (
        !tracker.current ||
        (viewport.current.width === window.innerWidth &&
          viewport.current.height === window.innerHeight)
      )
        return;
      viewport.current = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      invalidateCalibration();
      const notice =
        "Screen dimensions changed. Gaze controls are disabled until you recalibrate.";
      setMessage(notice);
      callbacks.current.onError(notice);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [invalidateCalibration]);

  const close = useCallback(() => {
    if (startingRef.current || active.current || !readyRef.current) stop();
    callbacks.current.onClose();
  }, [stop]);

  const start = async () => {
    if (startingRef.current) return;
    stop();
    const token = generation.current;
    const t = new CameraTracker();
    tracker.current = t;
    startingRef.current = true;
    setBusy(true);
    setMessage("");
    viewport.current = { width: window.innerWidth, height: window.innerHeight };
    try {
      if (!video.current)
        throw new Error("The camera preview is not ready. Please retry.");
      t.setGestureKind(kind);
      await t.start(
        video.current,
        (observation) => {
          if (generation.current !== token || !mounted.current) return;
          latest.current = observation;
          setQuality(observation.quality);
          setFaceStatus(t.getDiagnostics().reason);
          const preview = canvas.current;
          const source = video.current;
          if (
            preview &&
            source &&
            source.readyState >= 2 &&
            callbacks.current.open
          ) {
            const context = preview.getContext("2d", { alpha: false });
            context?.drawImage(source, 0, 0, preview.width, preview.height);
          }
          callbacks.current.onObservation(observation);
        },
        (error) => {
          if (generation.current !== token || !mounted.current) return;
          stop();
          setMessage(error);
          callbacks.current.onError(error);
        },
      );
      if (
        generation.current !== token ||
        !mounted.current ||
        !callbacks.current.open
      ) {
        t.stop();
        return;
      }
      setRunning(t.getDiagnostics().running);
    } catch (error) {
      if (generation.current === token && mounted.current) {
        stop();
        setMessage(
          error instanceof Error ? error.message : "Camera could not start.",
        );
      }
    } finally {
      if (generation.current === token && mounted.current) {
        startingRef.current = false;
        setBusy(false);
      }
    }
  };

  const cancelCalibration = useCallback(() => {
    invalidateCalibration();
    setMessage(
      "Calibration cancelled. Controls remain disabled. Try again or use switch input.",
    );
  }, [invalidateCalibration]);

  const beginGaze = () => {
    if (!tracker.current?.getDiagnostics().running) return;
    invalidateCalibration();
    const session = new GazeCalibrationSession(performance.now());
    active.current = { kind: "gaze", session };
    setGazeState(session.current);
    setMessage("");
    timer.current = setInterval(() => {
      if (active.current?.session !== session) return;
      const state = session.update(latest.current, performance.now());
      setGazeState(state);
      if (state.phase !== "done" && state.phase !== "failed") return;
      clearSession();
      setGazeState(null);
      setValidation(state.validation);
      const passed = Boolean(session.model && state.validation?.passed);
      tracker.current?.setCalibration(passed ? session.model : null);
      gazePassedRef.current = passed;
      setGazePassed(passed);
      setMessage(
        passed
          ? "Independent gaze check passed for large controls. Next, teach your deliberate signal."
          : state.message,
      );
    }, 70);
  };

  const beginGesture = () => {
    if (!gazePassedRef.current || !tracker.current?.getDiagnostics().running)
      return;
    clearSession();
    tracker.current.setGesture(null);
    tracker.current.setGestureKind(kind);
    setGesturePassed(false);
    setReady(false);
    const session = new GestureCalibrationSession(kind, performance.now());
    active.current = { kind: "gesture", session };
    setGestureState(session.current);
    setMessage("");
    timer.current = setInterval(() => {
      if (active.current?.session !== session) return;
      const state = session.update(latest.current, performance.now());
      setGestureState(state);
      if (state.phase !== "done" && state.phase !== "failed") return;
      clearSession();
      setGestureState(null);
      const passed = Boolean(session.config && gazePassedRef.current);
      tracker.current?.setGesture(passed ? session.config : null);
      setGesturePassed(passed);
      setReady(passed);
      setMessage(
        passed
          ? "Your input is ready. Relax your face, then look at a control and hold your deliberate gesture to select it."
          : state.message,
      );
    }, 70);
  };

  // An existing switch can navigate setup before camera input is calibrated.
  // Tab/Enter remain native. Space selects the currently highlighted setup control.
  useEffect(() => {
    if (!open) {
      setScanId("");
      scanRef.current = "";
      return;
    }
    let index = 0;
    const controls = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>("[data-camera-scan]"),
      )
        .filter(
          (button) =>
            !button.disabled &&
            !button.closest("[inert]") &&
            button.getClientRects().length > 0 &&
            (!gazeState ||
              ["cancel", "emergency-stop"].includes(
                button.dataset.cameraScan ?? "",
              )),
        )
        .sort(
          (a, b) =>
            Number(b.dataset.cameraScan === "emergency-stop") -
            Number(a.dataset.cameraScan === "emergency-stop"),
        );
    const tick = () => {
      const buttons = controls();
      if (!buttons.length) return;
      const button = buttons[index % buttons.length];
      index++;
      scanRef.current = button.dataset.cameraScan ?? "";
      setScanId(scanRef.current);
      document
        .querySelectorAll("[data-camera-highlight]")
        .forEach((item) => item.removeAttribute("data-camera-highlight"));
      button.setAttribute("data-camera-highlight", "true");
      button.scrollIntoView({ block: "nearest", behavior: "instant" });
    };
    tick();
    const scanTimer = setInterval(tick, 1800);
    const key = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        (event.target as HTMLElement)?.closest(
          'input,textarea,select,[contenteditable="true"]',
        )
      )
        return;
      const button = controls().find(
        (item) => item.dataset.cameraScan === scanRef.current,
      );
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      button.click();
    };
    window.addEventListener("keydown", key, true);
    return () => {
      clearInterval(scanTimer);
      window.removeEventListener("keydown", key, true);
    };
  }, [
    open,
    running,
    busy,
    Boolean(gazeState),
    Boolean(gestureState),
    gazePassed,
    gesturePassed,
  ]);

  const scanning = (id: string) => ({
    "data-camera-scan": id,
    "data-camera-highlight": scanId === id ? "true" : undefined,
  });
  const gestureLabel =
    kind === "jawOpen"
      ? "open your mouth gently"
      : kind === "browInnerUp"
        ? "raise your eyebrows gently"
        : "smile gently";
  const isCalibrating = Boolean(gazeState || gestureState);

  return (
    <>
      <video
        ref={video}
        className="nerve-camera-source"
        playsInline
        muted
        aria-hidden="true"
        tabIndex={-1}
      />
      {open && (
        <Dialog title="An input that fits you." wide onClose={close}>
          <div inert={Boolean(gazeState)}>
            <div className="camera-layout">
              <div className="camera-space">
                <div className="camera-placeholder nerve-camera-preview">
                  <canvas
                    ref={canvas}
                    width={640}
                    height={480}
                    aria-label="Local camera preview"
                    className={running ? "active" : ""}
                  />
                  {!running && (
                    <div className="nerve-camera-empty">
                      <Camera size={32} />
                      <span>
                        {busy
                          ? "Waiting for camera permission and local model..."
                          : "Your camera preview appears here."}
                      </span>
                    </div>
                  )}
                  {running && (
                    <span
                      className={`nerve-face-status ${quality >= 0.5 ? "visible" : ""}`}
                    >
                      {quality >= 0.5
                        ? "Face landmarks visible"
                        : "Controls paused"}
                    </span>
                  )}
                </div>
                <div className="camera-privacy">
                  <ShieldCheck size={14} />
                  Video stays on this device.
                </div>
                {running && (
                  <p className="nerve-camera-diagnostic" role="status">
                    {faceStatus}
                  </p>
                )}
              </div>
              <div>
                <p className="dialog-intro">
                  Use comfortable movements. Experimental gaze highlights a
                  choice; a deliberate gesture selects it. No emotion or
                  identity recognition.
                </p>
                <div className="camera-steps">
                  <div className={running ? "checked" : ""}>
                    <span>{running ? <CheckCircle2 size={17} /> : "1"}</span>
                    <p>Enable your camera</p>
                  </div>
                  <div className={gazePassed ? "checked" : ""}>
                    <span>{gazePassed ? <CheckCircle2 size={17} /> : "2"}</span>
                    <p>Calibrate and independently check gaze</p>
                  </div>
                  <div className={gesturePassed ? "checked" : ""}>
                    <span>
                      {gesturePassed ? <CheckCircle2 size={17} /> : "3"}
                    </span>
                    <p>Teach a deliberate gesture</p>
                  </div>
                </div>
                {!running ? (
                  <button
                    {...scanning("enable")}
                    className="primary full"
                    disabled={busy}
                    onClick={() => void start()}
                  >
                    {busy ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <Camera size={17} />
                    )}
                    Enable camera
                  </button>
                ) : (
                  <button
                    {...scanning("gaze")}
                    className="secondary full"
                    disabled={isCalibrating}
                    onClick={beginGaze}
                  >
                    <ScanEye size={17} />
                    {gazePassed ? "Recalibrate gaze" : "Calibrate gaze"}
                  </button>
                )}
              </div>
            </div>
            {running && (
              <div className="gesture-setup">
                <h3>Your deliberate signal</h3>
                <p>
                  Pick a movement you can make comfortably. Ordinary blinking is
                  never a click.
                </p>
                <div className="gesture-options">
                  {(
                    [
                      { id: "jawOpen", label: "Mouth open" },
                      { id: "browInnerUp", label: "Eyebrow raise" },
                      { id: "mouthSmile", label: "Smile" },
                    ] as const
                  ).map((gesture) => (
                    <button
                      {...scanning(gesture.id)}
                      className={kind === gesture.id ? "selected" : ""}
                      aria-pressed={kind === gesture.id}
                      key={gesture.id}
                      disabled={isCalibrating}
                      onClick={() => {
                        setKind(gesture.id);
                        tracker.current?.setGestureKind(gesture.id);
                        tracker.current?.setGesture(null);
                        setGesturePassed(false);
                        setReady(false);
                      }}
                    >
                      {gesture.label}
                    </button>
                  ))}
                </div>
                {gestureState ? (
                  <div
                    className="gesture-instruction"
                    role="status"
                    aria-live="polite"
                  >
                    <strong>
                      {gestureState.phase === "neutral"
                        ? "Relax your face."
                        : `Now, ${gestureLabel}.`}
                    </strong>
                    <p>
                      {gestureState.message ||
                        (gestureState.phase === "neutral"
                          ? "Learning your resting signal..."
                          : "Hold comfortably. Stop if there is any discomfort.")}
                    </p>
                    <progress
                      aria-label="Gesture recording progress"
                      value={gestureState.progress}
                      max={1}
                    />
                    <button
                      {...scanning("cancel-gesture")}
                      className="secondary"
                      onClick={cancelCalibration}
                    >
                      Cancel recording
                    </button>
                  </div>
                ) : (
                  <button
                    {...scanning("gesture")}
                    className="secondary"
                    disabled={!gazePassed || Boolean(gazeState)}
                    onClick={beginGesture}
                  >
                    {gesturePassed ? (
                      <RotateCcw size={16} />
                    ) : (
                      <ScanEye size={16} />
                    )}
                    {gesturePassed
                      ? "Recalibrate gesture"
                      : "Calibrate gesture"}
                  </button>
                )}
              </div>
            )}
            {validation && (
              <p className="validation-result">
                Independent check on 5 targets: mean error{" "}
                {validation.meanError.toFixed(3)}, 95th percentile{" "}
                {validation.p95Error.toFixed(3)} in normalized viewport units.{" "}
                {gazePassed
                  ? "Passed the experimental large-control threshold (mean ≤ 0.150, p95 ≤ 0.255). This is not a confidence or accuracy percentage."
                  : "Not accepted. No gaze actions are enabled."}
              </p>
            )}
            {message && (
              <div
                className={`camera-message ${gazePassed && gesturePassed ? "good" : ""}`}
                role="status"
              >
                {gazePassed && gesturePassed ? (
                  <CheckCircle2 size={17} />
                ) : (
                  <AlertTriangle size={17} />
                )}
                <span>{message}</span>
              </div>
            )}
            <div className="dialog-actions">
              <button
                {...scanning("stop")}
                className="secondary"
                onClick={() => {
                  stop();
                  callbacks.current.onClose();
                }}
              >
                <CameraOff size={16} />
                Stop camera
              </button>
              <button {...scanning("back")} className="primary" onClick={close}>
                {gazePassed && gesturePassed
                  ? "Use calibrated input"
                  : "Back to workspace"}
                <ArrowRight size={16} />
              </button>
            </div>
            <p className="subtle">
              Tab and Enter work throughout setup. A single switch mapped to
              Space selects the outlined control. Closing unfinished setup stops
              the camera. Recalibrate after changing posture or screen position.
              This is experimental access, not clinical eye tracking.
            </p>
          </div>
          {gazeState && (
            <div
              className="calibration-screen"
              role="region"
              aria-label="Gaze calibration"
            >
              <div
                className="calibration-copy"
                style={{ top: gazeState.target.y < 0.5 ? "72%" : "23%" }}
              >
                <span className="section-kicker">
                  {gazeState.phase === "gaze"
                    ? "GAZE CALIBRATION"
                    : "INDEPENDENT CHECK"}
                </span>
                <h3>Look at the green point.</h3>
                <p>Keep a comfortable, steady position. No clicking needed.</p>
                <span aria-live="polite">
                  {gazeState.pointIndex + 1} of {gazeState.targetCount}
                </span>
                {gazeState.message && <p role="status">{gazeState.message}</p>}
                <button
                  {...scanning("cancel")}
                  className="secondary"
                  autoFocus
                  onClick={cancelCalibration}
                >
                  Cancel calibration
                </button>
              </div>
              <div
                className="calibration-target"
                style={{
                  left: `${gazeState.target.x * 100}%`,
                  top: `${gazeState.target.y * 100}%`,
                }}
                aria-hidden="true"
              >
                <span
                  style={{
                    transform: `scale(${1 + gazeState.progress * 0.7})`,
                  }}
                />
                <i />
              </div>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
