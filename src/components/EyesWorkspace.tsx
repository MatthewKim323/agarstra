import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Observation } from "../../shared/types";
import {
  GAZE_ZONES,
  GazeActivationController,
  GazeZoneCheck,
  type GazeActivationState,
  type GazeZone,
  type GazeZoneCheckState,
  type GazeZoneCheckResult,
} from "../core/gaze-activation";
import "./EyesWorkspace.css";

export interface EyesWorkspaceAction {
  label: string;
  description?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface EyesWorkspaceProps {
  observation: Observation | null;
  stageKey: string;
  title: string;
  description?: string;
  primary: EyesWorkspaceAction;
  secondary: EyesWorkspaceAction;
  onStop: () => void;
  onExit: () => void;
  onRecalibrate: () => void;
  onCheckPassed?: (results: GazeZoneCheckResult[]) => void;
  active: boolean;
  suspended?: boolean;
  children?: ReactNode;
}

const INITIAL_ACTIVATION: GazeActivationState = {
  zone: null,
  armed: false,
  progress: 0,
  neutralProgress: 0,
  fired: null,
  reliable: false,
};
const ZONE_NAMES: Record<GazeZone, string> = {
  primary: "left",
  secondary: "right",
  neutral: "center",
  stop: "Stop at the top",
};
const zoneStyle = (zone: GazeZone): CSSProperties => {
  const rect = GAZE_ZONES[zone];
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
};

/** A fixed set of large targets. Gaze never activates arbitrary page elements. */
export function EyesWorkspace(props: EyesWorkspaceProps) {
  const current = useRef(props);
  current.current = props;
  const controller = useRef(new GazeActivationController());
  const checker = useRef<GazeZoneCheck | null>(null);
  const [check, setCheck] = useState<GazeZoneCheckState | null>(null);
  const [activation, setActivation] = useState(INITIAL_ACTIVATION);
  const [viewportVersion, setViewportVersion] = useState(0);
  const tickRef = useRef<(() => void) | null>(null);
  const supportedViewport =
    window.innerWidth >= 900 && window.innerHeight >= 650;

  useEffect(() => {
    const resize = () => setViewportVersion((version) => version + 1);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    controller.current.reset();
    setActivation(INITIAL_ACTIVATION);
    checker.current =
      props.active && supportedViewport
        ? new GazeZoneCheck(performance.now())
        : null;
    setCheck(checker.current?.current ?? null);
    tickRef.current = null;
    if (!props.active || !supportedViewport) return;
    const tick = () => {
      const p = current.current;
      if (!p.active || p.suspended || document.hidden) {
        controller.current.reset({ stopLatched: true });
        setActivation(INITIAL_ACTIVATION);
        return;
      }
      const now = performance.now();
      const checkBefore = checker.current?.current;
      if (!checkBefore || checkBefore.status === "failed") return;
      if (checkBefore.status === "checking") {
        const next = checker.current!.update(p.observation, now);
        setCheck(next);
        if (next.status === "passed") {
          // The last check target is Stop. Leaving it must precede a real Stop.
          controller.current.reset({ stopLatched: true });
          p.onCheckPassed?.(next.results);
        }
        return;
      }
      const stage = JSON.stringify([
        p.stageKey,
        p.title,
        p.primary.label,
        p.primary.description,
        p.secondary.label,
        p.secondary.description,
        Boolean(p.primary.disabled),
        Boolean(p.secondary.disabled),
      ]);
      const next = controller.current.update(p.observation, now, stage, {
        primary: !p.primary.disabled,
        secondary: !p.secondary.disabled,
      });
      setActivation(next);
      if (next.fired === "stop") p.onStop();
      else if (next.fired === "primary" && !p.primary.disabled)
        p.primary.onSelect();
      else if (next.fired === "secondary" && !p.secondary.disabled)
        p.secondary.onSelect();
    };
    tickRef.current = tick;
    const timer = window.setInterval(tick, 70);
    return () => {
      tickRef.current = null;
      window.clearInterval(timer);
    };
  }, [props.active, viewportVersion, supportedViewport]);

  useEffect(() => {
    controller.current.reset({ stopLatched: true });
    setActivation(INITIAL_ACTIVATION);
  }, [props.suspended]);

  // Admit a fresh capture when it arrives, before a later paint can make it stale.
  useEffect(() => {
    tickRef.current?.();
  }, [
    props.observation,
    props.stageKey,
    props.primary.label,
    props.secondary.label,
    props.primary.disabled,
    props.secondary.disabled,
    props.suspended,
  ]);

  const passed =
    props.active &&
    !props.suspended &&
    supportedViewport &&
    check?.status === "passed";
  const checking =
    props.active && supportedViewport && check?.status === "checking";
  const failed = props.active && check?.status === "failed";
  const checkingZone = checking ? check.zone : null;
  const hint = !supportedViewport
    ? "Make this window wider and taller so the eye controls stay large."
    : checking
      ? `Look at ${ZONE_NAMES[check.zone]}. Hold until the marker moves.`
      : failed
        ? "The control check did not pass. Your computer controls stay off."
        : !props.active
          ? "Gaze is paused."
          : !activation.reliable
            ? "Waiting for a fresh, clear eye signal."
            : activation.armed
              ? "Ready. Look at a choice and hold to select."
              : "Look at the center to get ready for your next choice.";

  const progress = (zone: GazeZone) =>
    checkingZone === zone
      ? check!.progress
      : passed && activation.zone === zone
        ? zone === "neutral"
          ? activation.neutralProgress
          : activation.progress
        : 0;

  const action = (zone: "primary" | "secondary", item: EyesWorkspaceAction) => (
    <button
      type="button"
      className={`eyes-zone eyes-action eyes-${zone}`}
      style={zoneStyle(zone)}
      data-gaze-zone={zone}
      data-check-target={checkingZone === zone ? "true" : undefined}
      data-dwelling={
        passed && activation.zone === zone && activation.progress > 0
          ? "true"
          : undefined
      }
      disabled={!passed || item.disabled}
      onClick={() => {
        if (passed && !item.disabled) item.onSelect();
      }}
    >
      {checkingZone === zone && (
        <span className="eyes-check-marker" aria-hidden="true">
          Look here
        </span>
      )}
      <strong>{item.label}</strong>
      {item.description && (
        <span className="eyes-action-description">{item.description}</span>
      )}
      <small>
        {checking ? "Checking this area only" : "Hold your gaze to choose"}
      </small>
      <span
        className="eyes-progress"
        style={{ width: `${progress(zone) * 100}%` }}
      />
    </button>
  );

  return (
    <section
      className="eyes-workspace"
      aria-label="Eyes-only workspace"
      data-testid="eyes-workspace"
      data-gaze-check={
        !supportedViewport ? "unsupported" : (check?.status ?? "inactive")
      }
      data-gaze-armed={activation.armed ? "true" : "false"}
      hidden={props.suspended}
      style={props.suspended ? { display: "none" } : undefined}
    >
      <header className="eyes-heading">
        <p className="eyes-eyebrow">EYES ONLY</p>
        <h1>{checking ? "A quick control check" : props.title}</h1>
        {props.description && !checking && <p>{props.description}</p>}
      </header>
      <div className="eyes-status" role="status" aria-live="polite">
        <strong>
          {checking
            ? `Check ${check.step} of ${check.total}`
            : passed
              ? "Eye control"
              : "Controls paused"}
        </strong>
        <p>{hint}</p>
      </div>
      <button
        type="button"
        className="eyes-zone eyes-stop"
        style={zoneStyle("stop")}
        data-gaze-zone="stop"
        data-check-target={checkingZone === "stop" ? "true" : undefined}
        onClick={props.onStop}
      >
        <strong>Stop</strong>
        <span>
          {checkingZone === "stop"
            ? "Look here. This is still a check."
            : "Hold here to stop"}
        </span>
        <span
          className="eyes-progress"
          style={{ width: `${progress("stop") * 100}%` }}
        />
      </button>
      {action("primary", props.primary)}
      {action("secondary", props.secondary)}
      <div className="eyes-center-copy">
        <strong>{checking ? hint : "Read here. Then choose."}</strong>
        <p>
          {checking
            ? "No clicks or facial gestures. This check runs no computer actions and does not change your calibration."
            : "Every selection needs a new look at the center, then a deliberate hold on your choice."}
        </p>
      </div>
      <div
        className="eyes-zone eyes-neutral"
        style={zoneStyle("neutral")}
        data-gaze-zone="neutral"
        data-check-target={checkingZone === "neutral" ? "true" : undefined}
        data-ready={activation.armed ? "true" : undefined}
      >
        {checkingZone === "neutral" && (
          <span className="eyes-check-marker" aria-hidden="true">
            Look here
          </span>
        )}
        <strong>{activation.armed ? "Ready" : "Rest your gaze here"}</strong>
        {!checking && <div className="eyes-preview">{props.children}</div>}
        <span
          className="eyes-progress"
          style={{ width: `${progress("neutral") * 100}%` }}
        />
      </div>
      {(failed || !props.active || !supportedViewport) && (
        <div className="eyes-recovery" role="alert">
          <h2>
            {!supportedViewport
              ? "Make room for larger eye controls."
              : failed
                ? "Let’s check your gaze setup."
                : "Gaze is paused."}
          </h2>
          <p>
            {!supportedViewport
              ? "Widen the browser window or use a larger screen, then run the control check."
              : (check?.message ?? "Return to setup when you are ready.")}
          </p>
          <p>Computer actions are disabled.</p>
          <div>
            <button type="button" onClick={props.onRecalibrate}>
              Return to gaze setup
            </button>
            <button type="button" onClick={props.onExit}>
              Exit eyes-only workspace
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
