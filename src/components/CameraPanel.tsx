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
  Download,
} from "lucide-react";
import type { Observation } from "../../shared/types";
import { Dialog } from "./Dialog";
import { CameraTracker } from "../vision/CameraTracker";
import { NEURAL_FEATURE_COUNT } from "../vision/eye-images";
import type { GestureConfig, GestureKind } from "../vision/gesture";
import type {
  CalibrationModel,
  CalibrationValidation,
} from "../vision/calibration";
import {
  clearGazeProfile,
  compareGazeEnvironment,
  isGazeEnvironment,
  loadGazeProfile,
  saveGazeProfile,
  type GazeActivation,
  type GazeEnvironment,
  type SavedGazeProfile,
} from "../core/gaze-profile";
import {
  GazeCalibrationSession,
  GestureCalibrationSession,
  GAZE_SAMPLE_MAX_AGE_MS,
  GAZE_FRAME_MAX_GAP_MS,
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
  onActivationChange?: (activation: GazeActivation) => void;
  onRememberChange?: (remember: boolean) => void;
  dwellMs?: number;
  onStop: (stop: () => void) => void;
  onError: (message: string) => void;
};

type SignalSummary = {
  windowMs: number;
  usablePerSecond: number;
  lastUsableArrivalAgeMs: number | null;
  meanCaptureDelayMs: number | null;
  lastCaptureLatencyMs: number | null;
  totalResults: number;
  staleResults: number;
  inferenceMs: number;
  usableObservations: number;
  backend: string;
};

const EMPTY_SIGNAL: SignalSummary = {
  windowMs: 2000,
  usablePerSecond: 0,
  lastUsableArrivalAgeMs: null,
  meanCaptureDelayMs: null,
  lastCaptureLatencyMs: null,
  totalResults: 0,
  staleResults: 0,
  inferenceMs: 0,
  usableObservations: 0,
  backend: "off",
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
  const sessionEnvironment = useRef<GazeEnvironment | null>(null);
  const checkedCalibration = useRef<{
    model: CalibrationModel;
    environment: GazeEnvironment;
    validation: CalibrationValidation;
    checkedAt: number;
  } | null>(null);
  const gestureConfig = useRef<GestureConfig | null>(null);
  const switchOptIn = useRef<HTMLButtonElement>(null);
  const signalSamples = useRef<{ capture: number; arrival: number }[]>([]);
  const lastUsableCapture = useRef(-Infinity);
  const lastUsableArrival = useRef(-Infinity);
  const usableObservations = useRef(0);
  const latestSignalUsable = useRef(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [quality, setQuality] = useState(0);
  const [faceStatus, setFaceStatus] = useState("Camera is off.");
  const [kind, setKind] = useState<GestureKind>("jawOpen");
  const [savedLoad] = useState(loadGazeProfile);
  const [savedProfile, setSavedProfile] = useState(savedLoad.profile);
  const [remember, setRemember] = useState(savedLoad.status === "saved");
  const [activation, setActivation] = useState<GazeActivation>(
    savedLoad.profile?.activation ?? "dwell",
  );
  const rememberRef = useRef(remember);
  const activationRef = useRef(activation);
  rememberRef.current = remember;
  activationRef.current = activation;
  const [profileNotice, setProfileNotice] = useState(
    savedLoad.status === "invalid"
      ? "Saved calibration is incompatible or damaged. Calibrate again before using gaze."
      : savedLoad.status === "unavailable"
        ? "Browser storage is unavailable. You can still calibrate for this session."
        : "",
  );
  const [validation, setValidation] = useState<CalibrationValidation | null>(
    null,
  );
  const [gazePassed, setGazePassed] = useState(false);
  const [gesturePassed, setGesturePassed] = useState(false);
  const [gazeState, setGazeState] = useState<GazeCalibrationState | null>(null);
  const [gestureState, setGestureState] =
    useState<GestureCalibrationState | null>(null);
  const [scanId, setScanId] = useState("");
  const [switchScanning, setSwitchScanning] = useState(false);
  const [signal, setSignal] = useState<SignalSummary>(EMPTY_SIGNAL);
  const [diagnosticReport, setDiagnosticReport] = useState<
    | (ReturnType<GazeCalibrationSession["diagnosticReport"]> & {
        cameraSignal: SignalSummary;
      })
    | null
  >(null);
  const scanRef = useRef("");

  const readSignal = useCallback((now: number): SignalSummary => {
    signalSamples.current = signalSamples.current.filter(
      (sample) => now - sample.arrival <= 2000 && now >= sample.arrival,
    );
    const age = Number.isFinite(lastUsableArrival.current)
      ? Math.max(0, now - lastUsableArrival.current)
      : null;
    const available =
      latestSignalUsable.current &&
      age !== null &&
      age <= GAZE_FRAME_MAX_GAP_MS;
    const diagnostics = tracker.current?.getDiagnostics();
    const recent = signalSamples.current;
    return {
      windowMs: 2000,
      usablePerSecond: available
        ? Math.round((recent.length / 2) * 10) / 10
        : 0,
      lastUsableArrivalAgeMs: age === null ? null : Math.round(age),
      meanCaptureDelayMs: recent.length
        ? Math.round(
            recent.reduce(
              (sum, sample) => sum + sample.arrival - sample.capture,
              0,
            ) / recent.length,
          )
        : null,
      inferenceMs: Number.isFinite(diagnostics?.inferenceMs)
        ? Math.round(diagnostics!.inferenceMs)
        : 0,
      lastCaptureLatencyMs:
        diagnostics?.lastCaptureLatencyMs != null &&
        Number.isFinite(diagnostics.lastCaptureLatencyMs)
          ? Math.max(0, Math.round(diagnostics.lastCaptureLatencyMs))
          : null,
      totalResults: Number.isFinite(diagnostics?.totalResults)
        ? Math.max(0, Math.floor(diagnostics!.totalResults))
        : 0,
      staleResults: Number.isFinite(diagnostics?.staleResults)
        ? Math.max(0, Math.floor(diagnostics!.staleResults))
        : 0,
      usableObservations: usableObservations.current,
      backend: diagnostics?.backend ?? "off",
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setSwitchScanning(false);
      return;
    }
    switchOptIn.current?.focus({ preventScroll: true });
    const refresh = () => setSignal(readSignal(performance.now()));
    refresh();
    const signalTimer = setInterval(refresh, 200);
    return () => clearInterval(signalTimer);
  }, [open, readSignal]);

  const clearSession = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    active.current = null;
  }, []);

  const setReady = useCallback((ready: boolean) => {
    readyRef.current = ready;
    callbacks.current.onReady(ready);
  }, []);

  useEffect(() => {
    callbacks.current.onActivationChange?.(activation);
  }, [activation]);

  const persistCalibration = useCallback(() => {
    const checked = checkedCalibration.current;
    if (!rememberRef.current || !checked?.validation.passed) return;
    const now = Date.now();
    const profile: SavedGazeProfile = {
      version: 1,
      model: checked.model,
      gesture: gestureConfig.current,
      activation: activationRef.current,
      dwellMs: callbacks.current.dwellMs ?? 850,
      savedAt: now,
      environment: checked.environment,
      lastValidation: {
        checkedAt: checked.checkedAt,
        meanError: checked.validation.meanError,
        p95Error: checked.validation.p95Error,
        sampleCount: checked.validation.sampleCount,
      },
    };
    if (saveGazeProfile(profile)) {
      setSavedProfile(profile);
      setProfileNotice(
        "Calibration saved on this device. A fresh five-point check is required next time.",
      );
    } else {
      setProfileNotice(
        "Could not save calibration. It remains available for this camera session only.",
      );
    }
  }, []);

  const changeRemember = (enabled: boolean) => {
    rememberRef.current = enabled;
    setRemember(enabled);
    callbacks.current.onRememberChange?.(enabled);
    if (enabled) {
      setProfileNotice(
        "A successfully checked calibration will be saved on this device.",
      );
      persistCalibration();
    } else if (clearGazeProfile()) {
      setSavedProfile(null);
      setProfileNotice(
        "Saved setup and learning removed from this device. The current camera setup and session learning remain available until stopped or reloaded.",
      );
    } else {
      setProfileNotice(
        "Could not remove the saved calibration from browser storage. Clear this site's stored data to remove it.",
      );
    }
  };

  const changeActivation = (mode: GazeActivation) => {
    activationRef.current = mode;
    setActivation(mode);
    tracker.current?.setGesture(
      mode === "gesture" ? gestureConfig.current : null,
    );
    setReady(
      gazePassedRef.current &&
        (mode === "dwell" || Boolean(gestureConfig.current)),
    );
    persistCalibration();
  };

  const invalidateCalibration = useCallback(() => {
    clearSession();
    tracker.current?.setCalibration(null);
    tracker.current?.setGesture(null);
    checkedCalibration.current = null;
    gestureConfig.current = null;
    gazePassedRef.current = false;
    setReady(false);
    if (mounted.current) {
      setGazePassed(false);
      setGesturePassed(false);
      setGazeState(null);
      setGestureState(null);
      setValidation(null);
      setDiagnosticReport(null);
    }
  }, [clearSession, setReady]);

  const stop = useCallback(() => {
    generation.current++;
    startingRef.current = false;
    invalidateCalibration();
    const current = tracker.current;
    tracker.current = null;
    current?.stop();
    sessionEnvironment.current = null;
    latest.current = null;
    signalSamples.current = [];
    lastUsableCapture.current = lastUsableArrival.current = -Infinity;
    usableObservations.current = 0;
    latestSignalUsable.current = false;
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
      setSignal(EMPTY_SIGNAL);
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
      const current = tracker.current?.getEnvironment();
      const previous = sessionEnvironment.current;
      if (
        !previous ||
        !current ||
        compareGazeEnvironment(previous, current).compatible
      )
        return;
      viewport.current = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      invalidateCalibration();
      sessionEnvironment.current = isGazeEnvironment(current) ? current : null;
      const notice =
        "Camera or screen configuration changed. Gaze controls are disabled until you recalibrate.";
      setMessage(notice);
      callbacks.current.onError(notice);
    };
    const preview = video.current;
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    preview?.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      preview?.removeEventListener("resize", resize);
    };
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
          const currentEnvironment = t.getEnvironment();
          const previousEnvironment = sessionEnvironment.current;
          if (
            previousEnvironment &&
            currentEnvironment &&
            !compareGazeEnvironment(previousEnvironment, currentEnvironment)
              .compatible
          ) {
            invalidateCalibration();
            sessionEnvironment.current = isGazeEnvironment(currentEnvironment)
              ? currentEnvironment
              : null;
            const notice =
              "Camera or screen configuration changed. Gaze controls are disabled until you recalibrate.";
            setMessage(notice);
            callbacks.current.onError(notice);
            callbacks.current.onObservation({
              ...observation,
              quality: 0,
              gesture: false,
            });
            return;
          }
          latest.current = observation;
          const arrival = performance.now();
          const valid =
            Number.isFinite(observation.timestamp) &&
            Number.isFinite(observation.quality) &&
            observation.quality >= 0.5 &&
            observation.quality <= 1 &&
            observation.features.length === NEURAL_FEATURE_COUNT &&
            observation.features.every(Number.isFinite);
          if (!valid) latestSignalUsable.current = false;
          else if (observation.timestamp > lastUsableCapture.current) {
            const age = arrival - observation.timestamp;
            latestSignalUsable.current =
              age >= -50 && age <= GAZE_SAMPLE_MAX_AGE_MS;
            if (latestSignalUsable.current) {
              lastUsableCapture.current = observation.timestamp;
              lastUsableArrival.current = arrival;
              usableObservations.current++;
              signalSamples.current = [
                ...signalSamples.current,
                { capture: observation.timestamp, arrival },
              ]
                .filter((sample) => arrival - sample.arrival <= 2000)
                .slice(-120);
            }
          }
          // Admit each capture at its actual arrival. Waiting for the UI timer
          // can make an otherwise fresh, slow inference cross the age limit.
          const calibration = active.current;
          if (calibration?.kind === "gaze")
            calibration.session.update(observation, arrival);
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
      const environment = t.getEnvironment();
      sessionEnvironment.current = isGazeEnvironment(environment)
        ? environment
        : null;
      if (savedProfile && environment) {
        const match = compareGazeEnvironment(
          savedProfile.environment,
          environment,
        );
        setProfileNotice(
          match.compatible
            ? "Saved calibration found. Run the five-point check before using it."
            : `Saved calibration does not match this ${match.reason === "viewport" ? "screen size or zoom" : match.reason === "camera" ? "camera" : "camera configuration"}. Run a new calibration.`,
        );
      }
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

  const beginGaze = (saved?: SavedGazeProfile) => {
    if (!tracker.current?.getDiagnostics().running) return;
    const environment = tracker.current.getEnvironment();
    if (!isGazeEnvironment(environment)) {
      setMessage(
        "Waiting for camera dimensions before calibration. Try again when the preview is visible.",
      );
      return;
    }
    if (
      saved &&
      !compareGazeEnvironment(saved.environment, environment).compatible
    ) {
      setMessage(
        "The saved calibration does not match this camera and screen. Start a new calibration.",
      );
      return;
    }
    invalidateCalibration();
    sessionEnvironment.current = environment;
    const session = new GazeCalibrationSession(
      performance.now(),
      saved ? { validationModel: saved.model } : {},
    );
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
      setDiagnosticReport({
        ...session.diagnosticReport(viewport.current),
        cameraSignal: readSignal(performance.now()),
      });
      const currentEnvironment = tracker.current?.getEnvironment();
      const environmentMatches = Boolean(
        currentEnvironment &&
          compareGazeEnvironment(environment, currentEnvironment).compatible,
      );
      const passed = Boolean(
        session.model && state.validation?.passed && environmentMatches,
      );
      tracker.current?.setCalibration(passed ? session.model : null);
      gazePassedRef.current = passed;
      setGazePassed(passed);
      if (passed && session.model && state.validation) {
        checkedCalibration.current = {
          model: session.model,
          environment,
          validation: state.validation,
          checkedAt: Date.now(),
        };
        gestureConfig.current = saved?.gesture ?? null;
        if (gestureConfig.current) {
          tracker.current?.setGesture(
            activationRef.current === "gesture" ? gestureConfig.current : null,
          );
          setKind(gestureConfig.current.kind);
        }
        setGesturePassed(Boolean(gestureConfig.current));
        setReady(
          activationRef.current === "dwell" || Boolean(gestureConfig.current),
        );
        persistCalibration();
      }
      setMessage(
        passed
          ? activationRef.current === "dwell"
            ? "Independent gaze check passed. Continue to check the large gaze controls. No facial gesture is required."
            : gestureConfig.current
              ? "Saved gaze and gesture settings are ready. Relax your face before selecting a control."
              : "Independent gaze check passed. Teach a deliberate gesture, or choose eyes-only dwell."
          : environmentMatches
            ? state.message
            : "Camera or screen configuration changed during the check. Recalibrate before using gaze.",
      );
    }, 70);
  };

  const startGazeRecording = () => {
    const calibration = active.current;
    if (calibration?.kind !== "gaze") return;
    setGazeState(calibration.session.start(performance.now()));
  };

  const downloadDiagnostics = () => {
    if (!diagnosticReport) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnosticReport, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "nerve-gaze-diagnostics.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const beginGesture = () => {
    if (!gazePassedRef.current || !tracker.current?.getDiagnostics().running)
      return;
    clearSession();
    tracker.current.setGesture(null);
    gestureConfig.current = null;
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
      gestureConfig.current = passed ? session.config : null;
      setGesturePassed(passed);
      setReady(passed);
      if (passed) persistCalibration();
      setMessage(
        passed
          ? "Your input is ready. Relax your face, then look at a control and hold your deliberate gesture to select it."
          : state.message,
      );
    }, 70);
  };

  // Scanning is explicit opt-in. While off, Space retains native button behavior.
  useEffect(() => {
    const clearHighlights = () =>
      document
        .querySelectorAll("[data-camera-highlight]")
        .forEach((item) => item.removeAttribute("data-camera-highlight"));
    if (!open || !switchScanning) {
      setScanId("");
      scanRef.current = "";
      clearHighlights();
      return;
    }
    let index = 0;
    const controls = () =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          "[data-camera-scan]",
        ),
      )
        .filter(
          (button) =>
            !button.disabled &&
            !button.closest("[inert]") &&
            button.getClientRects().length > 0 &&
            (!gazeState ||
              [
                "cancel",
                "emergency-stop",
                "scan-toggle",
                ...(gazeState.phase === "ready" ? ["gaze-ready"] : []),
              ].includes(button.dataset.cameraScan ?? "")),
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
          'input:not([data-camera-scan]),textarea,select,[contenteditable="true"]',
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
      clearHighlights();
    };
  }, [
    open,
    switchScanning,
    running,
    busy,
    Boolean(gazeState),
    gazeState?.phase,
    Boolean(gestureState),
    gazePassed,
    gesturePassed,
  ]);

  const scanning = (id: string) => ({
    "data-camera-scan": id,
    "data-camera-highlight":
      switchScanning && scanId === id ? "true" : undefined,
  });

  const switchToggle = (initialFocus = false) => (
    <button
      {...scanning("scan-toggle")}
      className="secondary camera-scan-toggle"
      ref={initialFocus ? switchOptIn : undefined}
      autoFocus={initialFocus}
      aria-pressed={switchScanning}
      onClick={() => setSwitchScanning((enabled) => !enabled)}
    >
      {switchScanning ? "Disable switch scanning" : "Enable switch scanning"}
    </button>
  );

  const signalReadout = (compact = false) => (
    <div
      className={`camera-signal ${compact ? "compact" : ""}`}
      role="group"
      aria-label="Live eye signal"
    >
      <div className="camera-signal-values">
        <div>
          <span>Usable eye observations</span>
          <output
            aria-live="off"
            aria-label="Usable eye sample rate"
            data-testid="camera-signal-rate"
          >
            {signal.usablePerSecond.toFixed(1)} / sec
          </output>
        </div>
        {gazeState && gazeState.phase !== "ready" && (
          <div>
            <span>Accepted at this point</span>
            <output
              aria-live="off"
              aria-label="Accepted samples at this target"
              data-testid="camera-accepted-samples"
            >
              {gazeState.samplesAtTarget}
            </output>
          </div>
        )}
        <div>
          <span>Latest capture delay</span>
          <output
            aria-live="off"
            aria-label="Latest capture delay"
            data-testid="camera-capture-delay"
          >
            {signal.lastCaptureLatencyMs === null
              ? "Waiting"
              : `${signal.lastCaptureLatencyMs} ms`}
          </output>
        </div>
        <div>
          <span>Stale results</span>
          <output
            aria-live="off"
            aria-label="Stale camera results"
            data-testid="camera-stale-results"
          >
            {signal.staleResults} / {signal.totalResults}
          </output>
        </div>
        {!compact && (
          <div>
            <span>Model inference</span>
            <output aria-live="off" aria-label="Gaze model inference duration">
              {signal.inferenceMs} ms
            </output>
          </div>
        )}
      </div>
      <p className="camera-signal-state" data-testid="camera-signal-state">
        {!running
          ? busy
            ? "Camera is starting. No eye observations yet."
            : "Camera is off."
          : signal.usablePerSecond > 0
            ? "Eye observations are arriving. This does not establish gaze accuracy."
            : "No current usable eye observations. The dot cannot advance without them."}
      </p>
      {running && (!compact || gazeState?.phase === "ready") && (
        <p className="camera-signal-detail">
          {signal.lastUsableArrivalAgeMs === null
            ? "No usable eye observation received yet."
            : `Last usable observation arrived ${signal.lastUsableArrivalAgeMs} ms ago.`}
          {!compact &&
            signal.meanCaptureDelayMs !== null &&
            ` Capture delay ${signal.meanCaptureDelayMs} ms.`}
          {!compact && ` ${signal.backend}.`}
        </p>
      )}
    </div>
  );
  const gestureLabel =
    kind === "jawOpen"
      ? "open your mouth gently"
      : kind === "browInnerUp"
        ? "raise your eyebrows gently"
        : "smile gently";
  const isCalibrating = Boolean(gazeState || gestureState);
  const inputReady = gazePassed && (activation === "dwell" || gesturePassed);
  const rechecking =
    active.current?.kind === "gaze" &&
    active.current.session.kind === "recheck";
  const currentEnvironment = tracker.current?.getEnvironment();
  const savedCompatible = Boolean(
    savedProfile &&
      currentEnvironment &&
      compareGazeEnvironment(savedProfile.environment, currentEnvironment)
        .compatible,
  );

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
          <div
            className="camera-setup-content"
            hidden={Boolean(gazeState)}
            inert={Boolean(gazeState)}
            aria-hidden={gazeState ? true : undefined}
          >
            <div className="camera-scan-choice">
              {switchToggle(true)}
              <p>
                {switchScanning
                  ? "Switch scanning is on. Space selects the moving outlined control."
                  : "Switch scanning is off. Mouse and Tab/Enter work normally. Press Space on this button to enable scanning."}
              </p>
            </div>
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
                        ? "Face detected; gaze needs a separate check"
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
                {!gazeState && signalReadout()}
              </div>
              <div>
                <p className="dialog-intro">
                  A local eye-image model estimates where you look. Personal
                  calibration adjusts it to your camera and posture. Eyes-only
                  dwell selects large controls after a separate control check.
                </p>
                <div
                  className="gesture-options"
                  role="group"
                  aria-label="Gaze activation"
                >
                  <button
                    {...scanning("activation-dwell")}
                    className={activation === "dwell" ? "selected" : ""}
                    aria-pressed={activation === "dwell"}
                    disabled={isCalibrating || busy}
                    onClick={() => changeActivation("dwell")}
                  >
                    Eyes only
                  </button>
                  <button
                    {...scanning("activation-gesture")}
                    className={activation === "gesture" ? "selected" : ""}
                    aria-pressed={activation === "gesture"}
                    disabled={isCalibrating || busy}
                    onClick={() => changeActivation("gesture")}
                  >
                    Gaze + gesture
                  </button>
                </div>
                <p className="subtle">
                  {activation === "dwell"
                    ? "Look steadily at a large control to select it. Look away between selections. No facial gesture is required."
                    : "Look at a control and hold your taught facial gesture to select it."}
                </p>
                <label>
                  <input
                    {...scanning("remember")}
                    type="checkbox"
                    checked={remember}
                    onChange={(event) => changeRemember(event.target.checked)}
                  />{" "}
                  Remember me on this device
                </label>
                <p className="subtle">
                  Save gaze calibration and learn from your confirmed choices
                  across visits.
                </p>
                {profileNotice && (
                  <p className="subtle" role="status">
                    {profileNotice}
                  </p>
                )}
                {(savedProfile || savedLoad.status === "invalid") && (
                  <button
                    {...scanning("forget-calibration")}
                    className="secondary"
                    onClick={() => changeRemember(false)}
                  >
                    Clear saved setup and learning
                  </button>
                )}
                <div className="camera-steps">
                  <div className={running ? "checked" : ""}>
                    <span>{running ? <CheckCircle2 size={17} /> : "1"}</span>
                    <p>Enable your camera</p>
                  </div>
                  <div className={gazePassed ? "checked" : ""}>
                    <span>{gazePassed ? <CheckCircle2 size={17} /> : "2"}</span>
                    <p>Calibrate and independently check gaze</p>
                  </div>
                  {activation === "gesture" && (
                    <div className={gesturePassed ? "checked" : ""}>
                      <span>
                        {gesturePassed ? <CheckCircle2 size={17} /> : "3"}
                      </span>
                      <p>Teach a deliberate gesture</p>
                    </div>
                  )}
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
                  <>
                    {savedProfile && savedCompatible && (
                      <button
                        {...scanning("recheck")}
                        className="primary full"
                        disabled={isCalibrating}
                        onClick={() => beginGaze(savedProfile)}
                      >
                        <CheckCircle2 size={17} />
                        Check saved calibration
                      </button>
                    )}
                    <button
                      {...scanning("gaze")}
                      className="secondary full"
                      disabled={isCalibrating}
                      onClick={() => beginGaze()}
                    >
                      <ScanEye size={17} />
                      {gazePassed ? "Recalibrate gaze" : "Calibrate gaze"}
                    </button>
                  </>
                )}
              </div>
            </div>
            {running && activation === "gesture" && (
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
                        gestureConfig.current = null;
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
              <section
                className="gaze-results"
                aria-labelledby="gaze-results-title"
              >
                <h3 id="gaze-results-title">Your independent gaze check</h3>
                <p className="validation-result">
                  Independent check on 5 targets: mean error{" "}
                  {validation.meanError.toFixed(3)}, 95th percentile{" "}
                  {validation.p95Error.toFixed(3)} in normalized viewport units.{" "}
                  {gazePassed
                    ? "Passed the experimental large-control threshold (mean ≤ 0.150, p95 ≤ 0.255). This is not a confidence or accuracy percentage."
                    : "Not accepted. No gaze actions are enabled."}
                </p>
                {validation.targets && validation.targets.length > 0 && (
                  <>
                    <div className="gaze-results-layout">
                      <svg
                        className="gaze-error-map"
                        viewBox="0 0 300 200"
                        role="img"
                        aria-label="Gaze check map. Numbered circles are the points you looked at. Small hollow circles show the average gaze estimate."
                      >
                        <rect x="1" y="1" width="298" height="198" rx="12" />
                        {validation.targets.map((result, index) => (
                          <g
                            key={index}
                            className={
                              result.meanError > 0.15 || result.p95Error > 0.255
                                ? "outside"
                                : "inside"
                            }
                          >
                            <title>{`Point ${index + 1}: average error ${result.meanError.toFixed(3)}, 95th percentile ${result.p95Error.toFixed(3)}`}</title>
                            <line
                              x1={result.target.x * 300}
                              y1={result.target.y * 200}
                              x2={result.predicted.x * 300}
                              y2={result.predicted.y * 200}
                            />
                            <circle
                              className="gaze-prediction"
                              cx={result.predicted.x * 300}
                              cy={result.predicted.y * 200}
                              r="5"
                            />
                            <circle
                              className="gaze-known-target"
                              cx={result.target.x * 300}
                              cy={result.target.y * 200}
                              r="10"
                            />
                            <text
                              x={result.target.x * 300}
                              y={result.target.y * 200}
                            >
                              {index + 1}
                            </text>
                          </g>
                        ))}
                      </svg>
                      <div className="gaze-table-wrap">
                        <table className="gaze-error-table">
                          <caption>Errors by screen position</caption>
                          <thead>
                            <tr>
                              <th scope="col">Point</th>
                              <th scope="col">Average</th>
                              <th scope="col">95th</th>
                              <th scope="col">Jitter</th>
                            </tr>
                          </thead>
                          <tbody>
                            {validation.targets.map((result, index) => (
                              <tr key={index}>
                                <th scope="row">
                                  {index + 1} (
                                  {result.target.x < 0.4
                                    ? "left"
                                    : result.target.x > 0.6
                                      ? "right"
                                      : "center"}
                                  {result.target.y < 0.4
                                    ? ", top"
                                    : result.target.y > 0.6
                                      ? ", bottom"
                                      : ""}
                                  )
                                </th>
                                <td>{result.meanError.toFixed(3)}</td>
                                <td>{result.p95Error.toFixed(3)}</td>
                                <td>{result.dispersion.toFixed(3)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <p className="gaze-result-explanation">
                      Numbered points are the targets. Hollow points are the
                      average estimates. Long lines mean a consistent offset;
                      large jitter means estimates scattered. Errors use
                      normalized viewport distance, not an accuracy percentage.
                      Estimates outside the viewport may fall beyond the map;
                      the table still includes their full, unclipped errors.
                    </p>
                    {!gazePassed && (
                      <p className="gaze-retry-advice">
                        Try softer front lighting and reduce reflections on
                        glasses. Keep your usual comfortable posture and look at
                        the dot, not the text. A retry collects fresh training
                        and check points. If it fails again, use switch input
                        and optionally share the numeric report so we can
                        diagnose the specific limitation.
                      </p>
                    )}
                  </>
                )}
              </section>
            )}
            {diagnosticReport && (
              <div className="gaze-report-export">
                <button
                  {...scanning("diagnostics")}
                  className="secondary"
                  onClick={downloadDiagnostics}
                >
                  <Download size={16} />
                  Download numeric diagnostics
                </button>
                <p>
                  Optional local file. No video, images, landmarks, eye
                  features, or identity data. Nothing is uploaded.
                </p>
              </div>
            )}
            {message && (
              <div
                className={`camera-message ${inputReady ? "good" : ""}`}
                role="status"
              >
                {inputReady ? (
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
                {inputReady ? "Check gaze controls" : "Back to workspace"}
                <ArrowRight size={16} />
              </button>
            </div>
            <p className="subtle">
              Tab and Enter work throughout setup. Switch scanning starts only
              when enabled; then Space selects the outlined control. Closing
              unfinished setup stops the camera. Recalibrate after changing
              posture or screen position. This is experimental access, not
              clinical eye tracking.
            </p>
          </div>
          {gazeState && (
            <div
              className="calibration-screen"
              role="region"
              aria-label="Gaze calibration"
            >
              {gazeState.phase === "ready" ? (
                <div className="gaze-ready-card">
                  <span className="section-kicker">BEFORE WE START</span>
                  <h3>
                    {rechecking
                      ? "Check your saved calibration."
                      : "Teach the camera where you look."}
                  </h3>
                  <p>
                    {rechecking
                      ? "These points check your saved gaze model in your current position. The model stays fixed throughout the check."
                      : "A pretrained local model reads eye images; these points personalize its estimates to you."}
                  </p>
                  <ol>
                    <li>
                      <strong>Get comfortable.</strong> Keep your face visible,
                      with soft light in front of you. Stay in the posture you
                      will use afterward.
                    </li>
                    <li>
                      <strong>
                        Follow the small green dot with your eyes.
                      </strong>{" "}
                      Look at its center until it moves. No clicks, gestures, or
                      reading the instructions while a point is recording.
                    </li>
                    <li>
                      <strong>
                        {rechecking
                          ? "5 points check your saved model."
                          : "9 points teach, then 5 points check."}
                      </strong>{" "}
                      The ring fills only after the signal settles. Blink
                      normally.
                      {rechecking
                        ? " Nothing retrains during this check."
                        : " Allow about one minute; points wait when tracking pauses."}
                    </li>
                  </ol>
                  <p className="gaze-ready-note">
                    Nothing is recording yet. The independent check can reject
                    an inaccurate setup. You can always use a single switch
                    instead.
                  </p>
                  {signalReadout(true)}
                  <div className="gaze-ready-actions">
                    <button
                      {...scanning("gaze-ready")}
                      className="primary"
                      autoFocus
                      onClick={startGazeRecording}
                    >
                      {rechecking
                        ? "Start saved gaze check"
                        : "Start gaze calibration"}{" "}
                      <ArrowRight size={16} />
                    </button>
                    <button
                      {...scanning("cancel")}
                      className="secondary"
                      onClick={cancelCalibration}
                    >
                      Cancel calibration
                    </button>
                    {switchToggle()}
                  </div>
                </div>
              ) : (
                <>
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
                    <p>
                      Keep a comfortable, steady position. No clicking needed.
                    </p>
                    <span aria-live="polite">
                      {gazeState.pointIndex + 1} of {gazeState.targetCount}
                    </span>
                    {gazeState.message && (
                      <p role="status">{gazeState.message}</p>
                    )}
                    {signalReadout(true)}
                    <progress
                      aria-label="Current gaze point progress"
                      value={gazeState.progress}
                      max={1}
                    />
                    <div className="calibration-copy-actions">
                      <button
                        {...scanning("cancel")}
                        className="secondary"
                        autoFocus
                        onClick={cancelCalibration}
                      >
                        Cancel calibration
                      </button>
                      {switchToggle()}
                    </div>
                  </div>
                  <div
                    className="calibration-target"
                    data-collection-status={gazeState.status}
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
                </>
              )}
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
