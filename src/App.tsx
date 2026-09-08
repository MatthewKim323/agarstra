import { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Activity,
  MousePointer2,
  ScanEye,
  Keyboard,
  ShieldCheck,
  SlidersHorizontal,
  Command,
  Pause,
  Play,
  Square,
  Camera,
  Check,
  ChevronRight,
  RotateCcw,
  Download,
  Eye,
  Lock,
  MessageSquare,
  FileText,
  Archive,
  CheckCircle2,
  LoaderCircle,
  Info,
  Monitor,
  Target,
  Plus,
  X,
  HelpCircle,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import type {
  Candidate,
  SessionState,
  InputMode,
  Point,
  Observation,
} from "../shared/types";
import { api } from "./api";
import { Dialog, EMERGENCY_STOP_EVENT } from "./components/Dialog";
import { CameraPanel } from "./components/CameraPanel";
import { EyesIntentFlow } from "./components/EyesIntentFlow";
import {
  IntentLearningDialog,
  IntentLearningStatus,
} from "./components/IntentLearning";
import { useIntentLearning } from "./use-intent-learning";
import { NONE_ID, type IntentSnapshot } from "./core/intent-learning";
import { IntentEngine, DwellController } from "./core";
import {
  scanControls,
  activateControl,
  controlLabel,
  gazeTargets,
  type AccessibleControl,
} from "./input-controls";

const INITIAL: SessionState = {
  mode: "practice",
  status: "idle",
  model: "gpt-6-astra",
  configured: false,
  screenshot: null,
  url: "",
  title: "Your workspace",
  width: 1280,
  height: 800,
  revision: 0,
  proposal: null,
  events: [],
  message: "Ready when you are.",
  goal: "",
  steps: 0,
  maxSteps: 20,
  screenConsent: false,
};
const DEFAULTS: Candidate[] = [
  {
    id: "reply",
    label: "Draft a reply",
    description: "Read this message and prepare a reply. Nothing gets sent.",
    goal: "Draft a friendly reply confirming the time proposed in the open email. Save it as a draft; do not send.",
    probability: 0.45,
    risk: "confirm",
  },
  {
    id: "note",
    label: "Save a note",
    description: "Keep the important details in your workspace.",
    goal: "Create and save a note summarizing the open message. Do not send or publish anything.",
    probability: 0.35,
    risk: "low",
  },
  {
    id: "archive",
    label: "Archive message",
    description: "Move the current message out of the inbox.",
    goal: "Archive the current message. Do not delete it.",
    probability: 0.2,
    risk: "confirm",
  },
];
const NO_CANDIDATES: Candidate[] = [];
type Preferences = {
  scanMs: number;
  voice: boolean;
  contrast: boolean;
  large: boolean;
  dwellMs: number;
};
const PREFS: Preferences = {
  scanMs: 1800,
  voice: false,
  contrast: false,
  large: false,
  dwellMs: 850,
};
function readPreferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem("nerve.preferences") || "{}");
    return {
      scanMs: Math.max(900, Math.min(5000, Number(p.scanMs) || 1800)),
      dwellMs: Math.max(400, Math.min(2500, Number(p.dwellMs) || 850)),
      voice: p.voice === true,
      contrast: p.contrast === true,
      large: p.large === true,
    };
  } catch {
    return PREFS;
  }
}
function humanTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
function actionText(
  a: NonNullable<SessionState["proposal"]>["actions"][number],
) {
  switch (a.type) {
    case "type":
      return `Type: “${a.text || ""}”`;
    case "keypress":
      return `Press ${(a.keys || []).join(" + ")}`;
    case "scroll":
      return `Scroll ${a.scroll_y || 0} pixels vertically`;
    case "click":
    case "double_click":
      return `${a.type === "click" ? "Click" : "Double-click"} at (${a.x}, ${a.y})`;
    case "drag":
      return `Drag through ${a.path?.length || 0} points`;
    case "move":
      return `Move pointer to (${a.x}, ${a.y})`;
    case "wait":
      return "Wait for the interface";
    case "screenshot":
      return "Inspect the current screen";
  }
}

export default function App() {
  const [state, setState] = useState<SessionState>(INITIAL),
    [online, setOnline] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [input, setInput] = useState<InputMode>("pointer"),
    [paused, setPaused] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>(DEFAULTS),
    [candidatesRevision, setCandidatesRevision] = useState(0),
    [source, setSource] = useState("practice"),
    [selected, setSelected] = useState<string | null>(null),
    [focus, setFocus] = useState<Point | null>(null),
    [tab, setTab] = useState<"workspace" | "activity">("workspace");
  const [modal, setModal] = useState<
      | "settings"
      | "camera"
      | "help"
      | "astra"
      | "custom"
      | "intent-learning"
      | null
    >(null),
    [prefs, setPrefs] = useState(readPreferences),
    [scanId, setScanId] = useState(""),
    [cameraObs, setCameraObs] = useState<Observation | null>(null),
    [cameraReady, setCameraReady] = useState(false),
    [cameraActivation, setCameraActivation] = useState<"dwell" | "gesture">(
      "dwell",
    ),
    [cameraTracking, setCameraTracking] = useState(false),
    [custom, setCustom] = useState(""),
    [url, setUrl] = useState(""),
    [consent, setConsent] = useState(false),
    [signals, setSignals] = useState(0),
    [ambiguity, setAmbiguity] = useState("");
  const screen = useRef<HTMLDivElement>(null),
    requestEpoch = useRef(0),
    requestPending = useRef(false),
    stateRef = useRef(state),
    pausedRef = useRef(paused),
    modalRef = useRef(modal),
    inputRef = useRef(input),
    scanRef = useRef(""),
    lastInput = useRef(-Infinity),
    cameraObsRef = useRef<Observation | null>(null),
    cameraActivationRef = useRef(cameraActivation),
    lastGaze = useRef({ id: "", since: 0 }),
    cameraStop = useRef<(() => void) | null>(null),
    pollAlive = useRef(true);
  const selectedDecision = useRef<{
    revision: number;
    id: string;
    snapshot: IntentSnapshot | null;
  } | null>(null);
  const customDecision = useRef<{
    revision: number;
    snapshot: IntentSnapshot | null;
  } | null>(null);
  const working = state.status === "thinking" || state.status === "executing",
    started = !!state.screenshot,
    proposal = state.proposal,
    choice = candidates.find((c) => c.id === selected),
    canAct = started && !busy && !working && !paused && !proposal,
    currentCandidates =
      source === state.mode &&
      (source === "practice" || candidatesRevision === state.revision);
  const intentLearning = useIntentLearning({
    candidates: currentCandidates ? candidates : NO_CANDIDATES,
    context: {
      mode: state.mode,
      input,
      url: state.url,
      title: state.title,
      focus,
    },
    revision: state.revision,
    eligible: canAct && currentCandidates,
    observing: canAct && currentCandidates && !modal && !selected,
  });
  const learningRef = useRef(intentLearning);
  learningRef.current = intentLearning;
  stateRef.current = state;
  pausedRef.current = paused;
  modalRef.current = modal;
  inputRef.current = input;
  scanRef.current = scanId;
  cameraObsRef.current = cameraObs;
  cameraActivationRef.current = cameraActivation;
  const eyesOnly =
    input === "camera" && cameraReady && cameraActivation === "dwell";
  useEffect(() => {
    pollAlive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let ended = false;
    const poll = async () => {
      const epoch = requestEpoch.current;
      try {
        const s = await api.state();
        if (
          !ended &&
          epoch === requestEpoch.current &&
          !requestPending.current
        ) {
          setState((current) => (s.revision >= current.revision ? s : current));
          setOnline(true);
        }
      } catch {
        if (!ended) setOnline(false);
      } finally {
        if (!ended) timer = setTimeout(poll, 650);
      }
    };
    void poll();
    return () => {
      ended = true;
      pollAlive.current = false;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("nerve.preferences", JSON.stringify(prefs));
    } catch {}
    document.documentElement.dataset.contrast = String(prefs.contrast);
    document.documentElement.dataset.large = String(prefs.large);
  }, [prefs]);
  const speak = useCallback(
    (message: string) => {
      if (prefs.voice && "speechSynthesis" in window) {
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance(message));
      }
    },
    [prefs.voice],
  );
  const perform = useCallback(
    async (
      fn: () => Promise<SessionState>,
      notice?: string,
      accepted?: () => void,
    ) => {
      const epoch = ++requestEpoch.current;
      requestPending.current = true;
      setBusy(true);
      setError("");
      try {
        const result = await fn();
        if (
          epoch !== requestEpoch.current ||
          result.revision < stateRef.current.revision
        )
          return;
        accepted?.();
        setState((current) =>
          result.revision >= current.revision ? result : current,
        );
        setOnline(true);
        if (notice) speak(notice);
      } catch (e) {
        if (epoch !== requestEpoch.current) return;
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        if (epoch === requestEpoch.current) {
          requestPending.current = false;
          setBusy(false);
        }
      }
    },
    [speak],
  );
  const stop = useCallback(() => {
    learningRef.current.invalidate();
    selectedDecision.current = null;
    customDecision.current = null;
    setPaused(true);
    setSelected(null);
    setScanId("");
    setFocus(null);
    void perform(api.stop, "Stopped. No further actions are authorized.");
  }, [perform]);
  useEffect(() => {
    const stopFromDialog = () => {
      stop();
      setModal(null);
    };
    window.addEventListener(EMERGENCY_STOP_EVENT, stopFromDialog);
    return () =>
      window.removeEventListener(EMERGENCY_STOP_EVENT, stopFromDialog);
  }, [stop]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stop();
        setModal(null);
        return;
      }
      const target = e.target as HTMLElement;
      const editing = target.closest(
        'input:not([type="checkbox"]):not([type="range"]),textarea,[contenteditable="true"]',
      );
      if (
        e.code === "Space" &&
        !e.repeat &&
        !editing &&
        modalRef.current !== "camera"
      ) {
        if (inputRef.current === "switch" || inputRef.current === "camera") {
          e.preventDefault();
          if (performance.now() - lastInput.current < 650) return;
          lastInput.current = performance.now();
          const el = document.querySelector<AccessibleControl>(
            `[data-scan-id="${scanRef.current}"]`,
          );
          if (el && !el.disabled) {
            setSignals((n) => n + 1);
            activateControl(el);
          }
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [stop]);
  useEffect(() => {
    if (input !== "switch" || modal === "camera") {
      setScanId("");
      return;
    }
    let index = 0;
    const tick = () => {
      const controls = scanControls(paused);
      if (!controls.length) return;
      const current = controls[index % controls.length];
      index++;
      setScanId(current.dataset.scanId!);
      current.scrollIntoView({ block: "nearest", behavior: "instant" });
      speak(controlLabel(current));
    };
    tick();
    const id = setInterval(tick, prefs.scanMs);
    return () => clearInterval(id);
  }, [
    input,
    modal,
    paused,
    prefs.scanMs,
    state.status,
    busy,
    selected,
    candidates.length,
    speak,
  ]);
  useEffect(() => {
    document
      .querySelectorAll("[data-scanning]")
      .forEach((el) => el.removeAttribute("data-scanning"));
    if (scanId)
      document
        .querySelector(`[data-scan-id="${scanId}"]`)
        ?.setAttribute("data-scanning", "true");
  }, [scanId]);
  useEffect(() => {
    if (
      input !== "camera" ||
      !cameraReady ||
      cameraActivation !== "gesture" ||
      modal === "camera"
    )
      return;
    const engine = new IntentEngine({
      sigma: 0.025,
      minimumMargin: 0.12,
      minimumWeight: 0.52,
      maxDistance: 0.035,
      minimumQuality: 0.5,
    });
    const dwell = new DwellController({ dwellMs: prefs.dwellMs });
    let lastTimestamp = -1;
    const timer = setInterval(() => {
      const o = cameraObsRef.current;
      if (!o || performance.now() - o.timestamp > 350 || o.quality < 0.5) {
        setScanId("");
        lastGaze.current = { id: "", since: 0 };
        engine.reset();
        dwell.reset();
        setAmbiguity("Tracking paused. A clear signal is needed.");
        return;
      }
      if (o.timestamp === lastTimestamp) return;
      lastTimestamp = o.timestamp;
      // Attention scopes intent suggestions. It never clicks the remote computer.
      if (!modal && !paused && stateRef.current.screenshot && screen.current) {
        const r = screen.current.getBoundingClientRect();
        const x = o.x * window.innerWidth,
          y = o.y * window.innerHeight;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          setFocus({ x: (x - r.left) / r.width, y: (y - r.top) / r.height });
        }
      }
      const ranking = engine.rank(
        gazeTargets(scanControls(paused)),
        o,
        performance.now(),
      );
      const readiness = dwell.update(ranking.topId, o.timestamp, ranking.valid);
      setAmbiguity(
        ranking.ambiguous
          ? ranking.question || "Look at one of the available controls."
          : "Hold your gaze, then use your deliberate signal.",
      );
      setScanId(readiness.progress >= 1 ? readiness.id || "" : "");
      lastGaze.current = {
        id: readiness.progress >= 1 ? readiness.id || "" : "",
        since: o.timestamp,
      };
    }, 80);
    return () => clearInterval(timer);
  }, [
    input,
    cameraReady,
    cameraActivation,
    paused,
    modal,
    prefs.dwellMs,
    state.proposal?.id,
    selected,
  ]);
  const onObservation = useCallback((o: Observation) => {
    learningRef.current.observeGaze(o);
    setCameraObs(o);
    setCameraTracking(o.quality >= 0.5);
    if (
      o.gesture &&
      inputRef.current === "camera" &&
      cameraActivationRef.current === "gesture" &&
      modalRef.current !== "camera" &&
      o.quality >= 0.5 &&
      performance.now() - lastInput.current > 900
    ) {
      const current = scanRef.current;
      const el = document.querySelector<AccessibleControl>(
        `[data-scan-id="${current}"]`,
      );
      const allowed = scanControls(pausedRef.current).includes(el!);
      if (
        el &&
        !el.disabled &&
        allowed &&
        performance.now() - lastGaze.current.since < 350
      ) {
        lastInput.current = performance.now();
        setSignals((n) => n + 1);
        activateControl(el);
        setScanId("");
        lastGaze.current = { id: "", since: 0 };
      }
    }
  }, []);
  useEffect(() => {
    const lost = () => {
      if (document.hidden) {
        requestEpoch.current++;
        requestPending.current = false;
        learningRef.current.invalidate();
        selectedDecision.current = null;
        customDecision.current = null;
        setPaused(true);
        setBusy(false);
        setSelected(null);
        setScanId("");
        void api.stop().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", lost);
    return () => document.removeEventListener("visibilitychange", lost);
  }, []);
  useEffect(
    () => () => {
      cameraStop.current?.();
    },
    [],
  );
  const start = async (mode: "practice" | "astra") => {
    intentLearning.invalidate();
    selectedDecision.current = null;
    customDecision.current = null;
    setModal(null);
    setPaused(false);
    setSelected(null);
    setCandidates(mode === "practice" ? DEFAULTS : []);
    setSource(mode);
    setFocus(null);
    await perform(() =>
      api.session(mode, mode === "astra" && consent, url || undefined),
    );
  };
  const suggestions = async (attentionPoint?: Point | null) => {
    if (!state.screenshot || busy || paused) return;
    const epoch = ++requestEpoch.current;
    requestPending.current = true;
    intentLearning.invalidate();
    selectedDecision.current = null;
    setBusy(true);
    setError("");
    try {
      const r = await api.candidates(
        attentionPoint === null
          ? undefined
          : (attentionPoint ?? focus ?? undefined),
      );
      if (
        epoch !== requestEpoch.current ||
        pausedRef.current ||
        r.state.revision < stateRef.current.revision
      )
        return;
      setState(r.state);
      setCandidates(r.candidates);
      setCandidatesRevision(r.state.revision);
      setSource(r.source);
      setSelected(null);
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      setError(e instanceof Error ? e.message : "Could not read this screen.");
    } finally {
      if (epoch === requestEpoch.current) {
        requestPending.current = false;
        setBusy(false);
      }
    }
  };
  const choose = (c: Candidate) => {
    if (!canAct || !currentCandidates) return;
    selectedDecision.current = {
      revision: state.revision,
      id: c.id,
      snapshot: intentLearning.snapshot,
    };
    setSelected(c.id);
    speak(`${c.label}. Select Confirm intent to continue.`);
  };
  const confirmIntent = async () => {
    const c = candidates.find((c) => c.id === selected);
    const decision = selectedDecision.current;
    if (!c || !canAct || !decision) return;
    if (
      decision.revision !== stateRef.current.revision ||
      decision.id !== c.id
    ) {
      setSelected(null);
      selectedDecision.current = null;
      setError(
        "The screen changed. Read it again and choose a current intent.",
      );
      return;
    }
    selectedDecision.current = null;
    setSelected(null);
    await perform(
      () => api.intent(c.goal, decision.revision),
      undefined,
      () => {
        intentLearning.record(decision.snapshot, c.id, "confirm");
      },
    );
  };
  const modeChange = (m: InputMode) => {
    if (m !== "camera" && input === "camera") {
      cameraStop.current?.();
      setCameraReady(false);
      setCameraTracking(false);
      setCameraObs(null);
    }
    setInput(m);
    setScanId("");
    if (m === "camera" && !cameraReady) setModal("camera");
  };
  const exportSession = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      model: state.model,
      status: state.status,
      steps: state.steps,
      signals,
      input,
      events: state.events,
      notice:
        "No webcam frames, screenshots, or credentials included. Action labels may contain task details.",
    };
    const objectUrl = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `nerve-session-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(objectUrl);
  };
  const statusText = paused
    ? "Paused"
    : state.status === "approval"
      ? "Your approval needed"
      : state.status === "thinking"
        ? state.mode === "astra"
          ? "Astra is planning"
          : "Preparing your next step"
        : state.status === "executing"
          ? "Action in progress"
          : state.status === "completed"
            ? "Task complete"
            : state.status === "error"
              ? "Needs attention"
              : started
                ? "Ready for your intent"
                : "Ready to connect";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to workspace
      </a>
      <header className="topbar" inert={eyesOnly && !modal}>
        <a href="#main" className="wordmark" aria-label="Nerve home">
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          nerve<span className="beta">RESEARCH PREVIEW</span>
        </a>
        <div className="top-right">
          <span className="privacy-pill">
            <ShieldCheck size={14} /> Local-first, always yours
          </span>
          <button
            className="icon-button"
            aria-label="Help and keyboard shortcuts"
            data-scan-id="help"
            onClick={() => setModal("help")}
          >
            <HelpCircle size={19} />
          </button>
          <button
            className="icon-button"
            aria-label="Settings"
            data-scan-id="settings"
            onClick={() => setModal("settings")}
          >
            <SlidersHorizontal size={19} />
          </button>
          <span className="avatar">m</span>
        </div>
      </header>
      <main id="main" className="main" inert={eyesOnly && !modal}>
        <section className="intro">
          <div>
            <div className="eyebrow">
              <span className="tiny-spark" /> HUMAN INTENT. AMPLIFIED.
            </div>
            <h1>
              A little intent.
              <br />
              <span>A lot more possible.</span>
            </h1>
            <p>
              Your computer, at your pace. Look, choose, and let Nerve handle
              the steps.
            </p>
          </div>
          <div className="intro-note">
            <div className="orbit">
              <ArrowUpRight size={30} />
            </div>
            <span>
              Less effort.
              <br />
              <strong>More agency.</strong>
            </span>
          </div>
        </section>
        <div className="workbench">
          <div className="workspace-column">
            <div className="workspace-top">
              <div className="tabs" role="tablist" aria-label="Workspace views">
                <button
                  role="tab"
                  aria-selected={tab === "workspace"}
                  data-scan-id="workspace-tab"
                  onClick={() => setTab("workspace")}
                >
                  <Monitor size={15} />
                  Workspace
                </button>
                <button
                  role="tab"
                  aria-selected={tab === "activity"}
                  data-scan-id="activity-tab"
                  onClick={() => setTab("activity")}
                >
                  <Activity size={15} />
                  Session log
                  {state.events.length > 0 && (
                    <span className="count">{state.events.length}</span>
                  )}
                </button>
              </div>
              <span className={`connection ${online ? "connected" : ""}`}>
                <i />
                {online
                  ? "Local bridge connected"
                  : "Connecting to local bridge"}
              </span>
            </div>
            {tab === "workspace" ? (
              <section
                className="workspace-card"
                aria-label="Computer workspace"
              >
                <div className="browser-chrome">
                  <div className="window-dots">
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="address">
                    <Lock size={11} />
                    <span>
                      {started
                        ? state.mode === "practice"
                          ? "practice.nerve / personal workspace"
                          : state.url
                        : "Your isolated browser"}
                    </span>
                  </div>
                  <span className={`mode-tag ${state.mode}`}>
                    {state.mode === "practice" ? "PRACTICE" : "ASTRA LIVE"}
                  </span>
                </div>
                <div
                  ref={screen}
                  className={`screen ${started ? "live" : ""}`}
                  data-testid="computer-screen"
                  onPointerDown={(e) => {
                    if (!started || input !== "pointer") return;
                    const r = e.currentTarget.getBoundingClientRect();
                    setFocus({
                      x: (e.clientX - r.left) / r.width,
                      y: (e.clientY - r.top) / r.height,
                    });
                  }}
                >
                  {state.screenshot ? (
                    <>
                      <img
                        src={
                          state.screenshot.startsWith("data:")
                            ? state.screenshot
                            : `data:image/png;base64,${state.screenshot}`
                        }
                        alt="Current isolated browser screenshot"
                        draggable={false}
                      />
                      {focus && (
                        <div
                          className="focus-marker"
                          style={{
                            left: `${focus.x * 100}%`,
                            top: `${focus.y * 100}%`,
                          }}
                        >
                          <span />
                          Focus here
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="empty-workspace">
                      <div className="preview-art" aria-hidden="true">
                        <div className="paper back">
                          <div />
                          <div />
                          <div />
                        </div>
                        <div className="paper front">
                          <div className="paper-icon">
                            <MessageSquare size={25} />
                          </div>
                          <div className="paper-line long" />
                          <div className="paper-line" />
                          <div className="paper-line short" />
                          <span className="paper-check">
                            <Check size={18} />
                          </span>
                        </div>
                        <div className="intent-cursor">
                          <MousePointer2 size={23} fill="currentColor" />
                          <span>Your intent</span>
                        </div>
                      </div>
                      <h2>Make yourself at home.</h2>
                      <p>
                        Try a real browser workspace with sample mail and notes.
                        <br />
                        No camera, account, or API key needed.
                      </p>
                      <button
                        className="primary"
                        data-scan-id="start"
                        disabled={busy || !online}
                        onClick={() => void start("practice")}
                      >
                        {busy ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <Play size={16} />
                        )}
                        Start practice
                        <ArrowRight size={16} />
                      </button>
                      <span className="subtle">
                        Real interactions. Sample data. Nothing sent.
                      </span>
                    </div>
                  )}
                  {paused && started && (
                    <div className="paused-overlay">
                      <div className="pause-icon">
                        <Pause size={26} />
                      </div>
                      <h2>You’re in control.</h2>
                      <p>Input is paused. Pending actions have been stopped.</p>
                      <button
                        className="primary"
                        data-scan-id="resume"
                        onClick={() => {
                          setPaused(false);
                          setError("");
                        }}
                      >
                        Resume
                        <Play size={16} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="workspace-foot">
                  <span>
                    <span className={`status-dot ${working ? "active" : ""}`} />
                    <span data-testid="run-status">{statusText}</span>
                  </span>
                  <button
                    className="text-button"
                    disabled={busy || !online}
                    data-scan-id="connect-astra"
                    onClick={() => setModal("astra")}
                  >
                    {state.mode === "astra"
                      ? "Connection settings"
                      : "Connect Astra"}
                    <ArrowUpRight size={14} />
                  </button>
                </div>
              </section>
            ) : (
              <section className="log-panel" aria-label="Session log">
                <div className="panel-title">
                  <div>
                    <h2>Your session, step by step.</h2>
                    <p>
                      An honest record of proposals, approvals, and outcomes.
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Export session"
                    data-scan-id="export"
                    onClick={exportSession}
                  >
                    <Download size={18} />
                  </button>
                </div>
                {state.events.length === 0 ? (
                  <div className="log-empty">
                    <Activity size={28} />
                    <p>
                      No actions yet. Start a practice session to see the trail.
                    </p>
                  </div>
                ) : (
                  <ol className="event-list">
                    {[...state.events].reverse().map((e) => (
                      <li key={e.id}>
                        <span className={`event-dot ${e.kind}`} />
                        <div>
                          <small>
                            {e.kind.toUpperCase()} · {humanTime(e.time)}
                          </small>
                          <p>{e.message}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
            <div className="input-dock">
              <div className="input-label">
                <div className="section-kicker">YOUR INPUT</div>
                <p>Choose what works for you.</p>
              </div>
              <div className="input-modes" aria-label="Input method">
                {(
                  [
                    { id: "pointer", label: "Pointer", icon: MousePointer2 },
                    { id: "switch", label: "Single switch", icon: Keyboard },
                    { id: "camera", label: "Camera", icon: ScanEye },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    aria-pressed={input === m.id}
                    className={input === m.id ? "selected" : ""}
                    onClick={() => modeChange(m.id)}
                    data-scan-id={`input-${m.id}`}
                  >
                    <m.icon size={19} />
                    <span>{m.label}</span>
                    {input === m.id && <span className="selected-dot" />}
                  </button>
                ))}
              </div>
            </div>
            <div className="input-guidance">
              <Info size={14} />
              {input === "pointer" ? (
                "Click the screen to indicate an area, then choose an intent. Screen clicks only set focus."
              ) : input === "switch" ? (
                <>
                  One key, every choice. Press <kbd>Space</kbd> when your choice
                  is highlighted. <kbd>Esc</kbd> stops everything.
                </>
              ) : cameraReady ? (
                cameraActivation === "dwell" ? (
                  "Use the large eyes-only controls. Look at the center between choices, then hold on your choice."
                ) : (
                  "Look at a control to highlight it. Make your calibrated gesture to select."
                )
              ) : (
                "Set up your gaze once, then use eyes-only controls. Saved calibration gets checked when you return."
              )}
              {input === "camera" && (
                <button
                  className="text-button"
                  onClick={() => setModal("camera")}
                  data-scan-id="calibrate"
                >
                  Calibrate
                  <ArrowUpRight size={13} />
                </button>
              )}
            </div>
          </div>
          <aside
            className="intent-column"
            aria-label="Intent and action controls"
          >
            <section className="intent-card">
              <div className="intent-heading">
                <span className="intent-symbol">
                  <Command size={20} />
                </span>
                <div>
                  <h2>
                    {proposal
                      ? "One more check."
                      : choice
                        ? "Is this your intent?"
                        : "What would you like?"}
                  </h2>
                  <p>
                    {proposal
                      ? "An exact preview, before anything happens."
                      : choice
                        ? "You choose the goal. Nerve handles the steps."
                        : "A small choice can move things forward."}
                  </p>
                </div>
              </div>
              {proposal ? (
                <div className="proposal" data-testid="action-proposal">
                  <div className="section-kicker">PROPOSED COMPUTER ACTION</div>
                  <h3>{proposal.summary}</h3>
                  <ul className="action-list">
                    {proposal.actions.map((a, i) => (
                      <li key={i}>
                        <span>{i + 1}</span>
                        <p>{actionText(a)}</p>
                      </li>
                    ))}
                  </ul>
                  {proposal.safetyWarnings.length > 0 && (
                    <div className="warning">
                      <AlertTriangle size={16} />
                      <p>{proposal.safetyWarnings.join(" ")}</p>
                    </div>
                  )}
                  <div className="approval-note">
                    <ShieldCheck size={14} />
                    Approval applies only to this preview.
                  </div>
                  <button
                    className="primary full"
                    data-scan-id="approve"
                    disabled={busy || paused || Date.now() > proposal.expiresAt}
                    onClick={() =>
                      void perform(() =>
                        api.approve(proposal.id, proposal.revision),
                      )
                    }
                  >
                    <Check size={17} />
                    Approve action
                  </button>
                  <button
                    className="secondary full"
                    data-scan-id="cancel"
                    onClick={() => {
                      setSelected(null);
                      void perform(api.stop);
                    }}
                  >
                    Cancel action
                  </button>
                </div>
              ) : choice ? (
                <div className="intent-confirm">
                  <div className="choice-icon">
                    <Target size={25} />
                  </div>
                  <h3>{choice.label}</h3>
                  <p>{choice.goal}</p>
                  <div className="approval-note">
                    <Lock size={14} />
                    Computer actions are previewed separately.
                  </div>
                  <button
                    className="primary full"
                    data-scan-id="confirm-intent"
                    disabled={!canAct}
                    onClick={() => void confirmIntent()}
                  >
                    Confirm intent
                    <ArrowRight size={16} />
                  </button>
                  <button
                    className="secondary full"
                    data-scan-id="back"
                    onClick={() => {
                      selectedDecision.current = null;
                      setSelected(null);
                    }}
                  >
                    Choose something else
                  </button>
                </div>
              ) : (
                <>
                  <div className="candidate-list">
                    {candidates.map((c, i) => {
                      const Icon =
                        i === 0 ? MessageSquare : i === 1 ? FileText : Archive;
                      return (
                        <button
                          key={c.id}
                          className="candidate"
                          data-scan-id={`intent-${i}`}
                          data-intent-id={c.id}
                          disabled={!canAct || !currentCandidates}
                          onPointerMove={(event) =>
                            intentLearning.observePointer(c.id, event)
                          }
                          onClick={() => choose(c)}
                        >
                          <span className="candidate-icon">
                            <Icon size={20} />
                          </span>
                          <span>
                            <strong>{c.label}</strong>
                            <small>{c.description}</small>
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="other-intent"
                    data-scan-id="custom"
                    disabled={!canAct}
                    onClick={() => {
                      customDecision.current = {
                        revision: state.revision,
                        snapshot: intentLearning.snapshot,
                      };
                      setModal("custom");
                    }}
                  >
                    <Plus size={16} />
                    Something else
                  </button>
                  <div className="candidate-source">
                    <span className="tiny-spark" />
                    {source === "astra"
                      ? "Suggestions from Astra, not a reading of your mind."
                      : "Practice suggestions. You decide what fits."}
                  </div>
                  {!currentCandidates && (
                    <p className="candidate-source">
                      The screen changed. Read this screen for current
                      suggestions.
                    </p>
                  )}
                  <button
                    className="secondary full"
                    data-scan-id="suggest"
                    disabled={!canAct}
                    onClick={() => void suggestions()}
                  >
                    {busy ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <ScanEye size={16} />
                    )}
                    Read this screen
                  </button>
                </>
              )}
              <IntentLearningStatus
                learning={intentLearning}
                candidates={candidates}
                onOpen={() => setModal("intent-learning")}
              />
            </section>
            <section className="signal-card">
              <div className="signal-head">
                <span className="section-kicker">SIGNAL, NOT GUESSWORK</span>
                <span
                  className={`mini-status ${input === "camera" && cameraTracking ? "on" : ""}`}
                >
                  {input === "camera"
                    ? cameraTracking
                      ? "FACE VISIBLE"
                      : "NO SIGNAL"
                    : "READY"}
                </span>
              </div>
              <div className="signal-visual" aria-hidden="true">
                {Array.from({ length: 33 }, (_, i) => (
                  <i
                    key={i}
                    style={{
                      height:
                        input === "camera" && cameraTracking
                          ? `${10 + Math.sin(i * 1.7) * 8 + cameraObs!.quality * 22}px`
                          : `${i > 11 && i < 21 ? 12 + Math.sin(i) * 7 : 4}px`,
                    }}
                  />
                ))}
              </div>
              <div className="signal-copy">
                <strong>
                  {input === "camera"
                    ? cameraReady
                      ? "Calibrated for this session"
                      : "Camera is optional"
                    : input === "switch"
                      ? "One reliable signal is enough."
                      : "Start with what feels familiar."}
                </strong>
                <p>
                  {input === "camera"
                    ? cameraReady
                      ? ambiguity ||
                        "Video is processed on this device. Estimates can drift with lighting or position."
                      : "Video is processed on this device. Estimates can drift with lighting or position."
                    : input === "switch"
                      ? "Automatic scanning turns one deliberate press into a choice."
                      : "Try the complete flow with a pointer, then explore your input options."}
                </p>
              </div>
            </section>
            <div className="safety-note">
              <ShieldCheck size={18} />
              <p>
                <strong>You always have the final say.</strong>
                <br />
                No sending, purchasing, or deleting without a preview and your
                approval.
              </p>
            </div>
          </aside>
        </div>
        {(error || !online) && (
          <div className="error-banner" role="alert">
            <AlertTriangle size={18} />
            <span>
              {error ||
                "Waiting for the local bridge. Start Nerve with npm run dev if it is not running."}
            </span>
            {error && (
              <button
                className="icon-button"
                aria-label="Dismiss error"
                data-scan-id="dismiss-error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        {state.message && started && (
          <div
            className={`session-message ${state.status === "completed" ? "success" : ""}`}
            role="status"
          >
            {state.status === "completed" ? (
              <CheckCircle2 size={17} />
            ) : working ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Info size={17} />
            )}
            <span>{state.message}</span>
          </div>
        )}
        <footer className="bottom-bar">
          <div className="journey">
            <span className={started ? "done" : ""}>
              <i>{started ? <Check size={10} /> : "1"}</i>Connect
            </span>
            <span className={choice || state.goal ? "done" : ""}>
              <i>2</i>Choose intent
            </span>
            <span
              className={proposal || state.status === "completed" ? "done" : ""}
            >
              <i>3</i>Approve & act
            </span>
          </div>
          <div className="session-controls">
            <button
              className="text-button"
              data-scan-id="pause"
              disabled={!started || busy}
              onClick={() => (paused ? setPaused(false) : stop())}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}{" "}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              className="stop-button"
              aria-label="Emergency stop"
              data-scan-id="stop"
              onClick={stop}
            >
              <Square size={12} fill="currentColor" />
              Emergency stop<kbd>esc</kbd>
            </button>
          </div>
        </footer>
        <div className="fineprint">
          <span>Your intent, with less effort.</span>
          <span>Research prototype · Not a medical device</span>
        </div>
      </main>
      {input === "camera" &&
        cameraReady &&
        cameraActivation === "gesture" &&
        cameraTracking &&
        !paused &&
        !modal &&
        cameraObs && (
          <div
            className="gaze-cursor"
            aria-hidden="true"
            style={{
              left: `${cameraObs.x * 100}%`,
              top: `${cameraObs.y * 100}%`,
            }}
          />
        )}
      {eyesOnly && (
        <EyesIntentFlow
          observation={cameraObs}
          active={!modal}
          state={state}
          candidates={candidates}
          currentCandidates={currentCandidates}
          selected={choice}
          busy={busy}
          paused={paused}
          error={error}
          learning={intentLearning}
          actionDescriptions={proposal?.actions.map(actionText) ?? []}
          onChoose={choose}
          onConfirm={() => void confirmIntent()}
          onBack={() => {
            selectedDecision.current = null;
            setSelected(null);
          }}
          onApprove={() => {
            const current = stateRef.current.proposal;
            if (
              !proposal ||
              !current ||
              current.id !== proposal.id ||
              current.revision !== proposal.revision ||
              requestPending.current ||
              busy ||
              pausedRef.current ||
              Date.now() >= current.expiresAt
            )
              return;
            void perform(() => api.approve(proposal.id, proposal.revision));
          }}
          onRefresh={(point) => {
            setFocus(point ?? null);
            void suggestions(point ?? null);
          }}
          onNone={() => {
            if (
              !canAct ||
              !currentCandidates ||
              requestPending.current ||
              state.revision !== stateRef.current.revision
            )
              return false;
            // An explicit rejection labels this slate; passive gaze and Stop never do.
            if (intentLearning.options.enabled)
              intentLearning.record(
                intentLearning.snapshot,
                NONE_ID,
                "confirm",
              );
            return true;
          }}
          onStart={() => void start("practice")}
          onResume={() => setPaused(false)}
          onStop={stop}
          onFinish={() => {
            stop();
            modeChange("pointer");
          }}
          onRecalibrate={() => setModal("camera")}
        />
      )}
      <CameraPanel
        open={modal === "camera"}
        onClose={() => setModal(null)}
        onObservation={onObservation}
        onReady={setCameraReady}
        onActivationChange={setCameraActivation}
        onRememberChange={intentLearning.setRemember}
        onStop={(fn) => {
          cameraStop.current = fn;
        }}
        onError={setError}
      />
      {modal === "intent-learning" && (
        <IntentLearningDialog
          learning={intentLearning}
          candidates={candidates}
          mode={state.mode}
          canTeach={canAct && currentCandidates}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "settings" && (
        <Dialog title="Make Nerve yours." onClose={() => setModal(null)}>
          <p className="dialog-intro">
            Comfort isn’t one-size-fits-all. These preferences stay on this
            device.
          </p>
          <button
            className="secondary"
            onClick={() => setModal("intent-learning")}
          >
            Intent learning
          </button>
          <label className="setting">
            <span>
              <strong>Scan interval</strong>
              <small>Time to choose each highlighted control.</small>
            </span>
            <span>{(prefs.scanMs / 1000).toFixed(1)}s</span>
            <input
              aria-label="Scan interval"
              type="range"
              min="900"
              max="5000"
              step="100"
              value={prefs.scanMs}
              onChange={(e) => setPrefs({ ...prefs, scanMs: +e.target.value })}
            />
          </label>
          <label className="setting">
            <span>
              <strong>Gaze dwell</strong>
              <small>
                Stable attention before a control is highlighted. It does not
                click.
              </small>
            </span>
            <span>{(prefs.dwellMs / 1000).toFixed(2)}s</span>
            <input
              aria-label="Gaze dwell"
              type="range"
              min="400"
              max="2500"
              step="50"
              value={prefs.dwellMs}
              onChange={(e) => setPrefs({ ...prefs, dwellMs: +e.target.value })}
            />
          </label>
          {(
            [
              {
                key: "voice",
                label: "Read choices aloud",
                desc: "Use your browser’s speech synthesis. Voice availability varies.",
              },
              {
                key: "contrast",
                label: "Higher contrast",
                desc: "Stronger boundaries and darker text.",
              },
              {
                key: "large",
                label: "Larger text",
                desc: "Increase type and control sizes.",
              },
            ] as const
          ).map((s) => (
            <label className="toggle-row" key={s.key}>
              <span>
                <strong>{s.label}</strong>
                <small>{s.desc}</small>
              </span>
              <input
                type="checkbox"
                checked={prefs[s.key]}
                onChange={(e) =>
                  setPrefs({ ...prefs, [s.key]: e.target.checked })
                }
              />
            </label>
          ))}
          <div className="dialog-actions">
            <button className="secondary" onClick={exportSession}>
              <Download size={16} />
              Export session
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                intentLearning.invalidate();
                selectedDecision.current = null;
                customDecision.current = null;
                setSelected(null);
                setPaused(false);
                void perform(api.reset);
              }}
            >
              <RotateCcw size={16} />
              Reset workspace
            </button>
          </div>
          <button
            className="text-button danger"
            onClick={() => {
              try {
                localStorage.removeItem("nerve.preferences");
                localStorage.removeItem("nerve.input-profile.v1");
              } catch {
                /* Capture still stops when browser storage is unavailable. */
              }
              setPrefs(PREFS);
              cameraStop.current?.();
              setCameraReady(false);
              setInput("pointer");
            }}
          >
            Clear local preferences and stop camera
          </button>
        </Dialog>
      )}
      {modal === "help" && (
        <Dialog
          title="Small signals. Clear choices."
          onClose={() => setModal(null)}
        >
          <div className="help-steps">
            <div>
              <span>01</span>
              <section>
                <h3>Start with practice.</h3>
                <p>
                  A real isolated browser opens sample mail and notes. Practice
                  actions are deterministic, not Astra-generated.
                </p>
              </section>
            </div>
            <div>
              <span>02</span>
              <section>
                <h3>Choose your input.</h3>
                <p>
                  Pointer, a switch that sends Space, or a calibrated webcam
                  gesture. In switch mode, every main action including Cancel
                  and Stop is scanned.
                </p>
              </section>
            </div>
            <div>
              <span>03</span>
              <section>
                <h3>Choose, then confirm.</h3>
                <p>
                  Attention only highlights. A deliberate selection chooses an
                  intent. Another confirmation authorizes the exact proposed
                  computer action.
                </p>
              </section>
            </div>
          </div>
          <div className="keyboard-guide">
            <span>
              <kbd>Space</kbd>Select highlighted choice
            </span>
            <span>
              <kbd>Esc</kbd>Emergency stop, everywhere
            </span>
            <span>
              <kbd>Tab</kbd>Navigate all controls
            </span>
          </div>
          <p className="muted">
            Webcam estimates are not medical-grade eye tracking. Lighting,
            glasses, head position, and individual movement can affect results.
            No facial identity or emotion inference is performed.
          </p>
        </Dialog>
      )}
      {modal === "astra" && (
        <Dialog
          title="Connect intent to action."
          onClose={() => setModal(null)}
        >
          <div className="model-card">
            <div className="intent-symbol">
              <Command size={24} />
            </div>
            <div>
              <strong>GPT-6 Astra</strong>
              <p>Screenshot-based computer use in an isolated browser.</p>
            </div>
            <span className={`mini-status ${state.configured ? "on" : ""}`}>
              {state.configured ? "KEY CONFIGURED" : "KEY NEEDED"}
            </span>
          </div>
          <p className="dialog-intro">
            Webcam video and eye features stay local. In live mode, browser
            screenshots, your chosen task, an optional coarse attention point,
            and any personal background or preferences configured on this device
            are sent to OpenAI. Only use accounts and data you’re comfortable
            sharing.
          </p>
          {!state.configured && (
            <div className="warning">
              <Info size={17} />
              <p>
                Set OPENAI_API_KEY in the local environment and restart the
                bridge. No key is stored in this interface.
              </p>
            </div>
          )}
          <label className="field-label">
            Starting page <span>optional</span>
            <input
              placeholder="Leave blank to use the safe practice workspace"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              type="url"
            />
            <small>
              External pages require HTTPS. Browser access is restricted to the
              approved origin.
            </small>
          </label>
          <label className="consent-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              I consent to sharing this browser’s screenshots, task content,
              optional coarse attention point, and any configured personal
              background and preferences with OpenAI for this session.
            </span>
          </label>
          <button
            className="primary full"
            disabled={!state.configured || !consent || busy}
            onClick={() => void start("astra")}
          >
            Start Astra session
            <ArrowRight size={17} />
          </button>
          <button
            className="secondary full"
            disabled={busy}
            onClick={() => void start("practice")}
          >
            Use practice without an API key
          </button>
          <p className="subtle">
            No access to your existing browser sessions, personal tabs, or
            desktop.
          </p>
        </Dialog>
      )}
      {modal === "custom" && (
        <Dialog
          title="What would you like to do?"
          onClose={() => {
            customDecision.current = null;
            setModal(null);
          }}
        >
          <p className="dialog-intro">
            A little extra context can help. Nerve will still show each computer
            action before execution.
          </p>
          <label className="field-label">
            Your intent
            <textarea
              autoFocus
              rows={4}
              maxLength={1000}
              placeholder="For example, turn this message into a short note."
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>
          <button
            className="primary full"
            disabled={!custom.trim() || !canAct}
            onClick={() => {
              const decision = customDecision.current;
              if (
                !decision ||
                decision.revision !== stateRef.current.revision
              ) {
                setModal(null);
                setError(
                  "The screen changed. Read it again before entering an intent.",
                );
                return;
              }
              const goal = custom.trim();
              customDecision.current = null;
              setModal(null);
              void perform(
                () => api.intent(goal, decision.revision),
                undefined,
                () => {
                  intentLearning.record(decision.snapshot, NONE_ID, "confirm");
                },
              );
            }}
          >
            Use this intent
            <ArrowRight size={17} />
          </button>
        </Dialog>
      )}
    </div>
  );
}
