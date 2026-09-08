import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Observation, Point } from "../../shared/types";
import { GazeFixation, imagePoint } from "../core/gaze-fixation";
import { GAZE_ZONES, GazeActivationController } from "../core/gaze-activation";
import "./GazeAttentionView.css";

export interface GazeAttentionViewProps {
  observation: Observation | null;
  screenshot: string;
  screenWidth: number;
  screenHeight: number;
  onAttention: (point: Point) => void;
  onStop: () => void;
  onBack: () => void;
  onShowChoices?: () => void;
  active: boolean;
}

export function GazeAttentionView(props: GazeAttentionViewProps) {
  const current = useRef(props);
  current.current = props;
  const image = useRef<HTMLImageElement>(null);
  const fallback = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const stopController = useRef(new GazeActivationController());
  const stopped = useRef(false);
  const emitted = useRef(false);
  const fixation = useRef(new GazeFixation());
  const tick = useRef<(() => void) | null>(null);
  const geometry = useRef("");
  const [progress, setProgress] = useState(0);
  const [stopProgress, setStopProgress] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const source = /^(data:|https?:|blob:)/.test(props.screenshot)
    ? props.screenshot
    : `data:image/png;base64,${props.screenshot}`;

  const stop = useCallback(() => {
    if (stopped.current) return;
    stopped.current = true;
    fixation.current.reset();
    current.current.onStop();
  }, []);

  useEffect(() => {
    fixation.current.reset();
    emitted.current = false;
    stopped.current = false;
    stopController.current.reset({ stopLatched: true });
    setStopProgress(0);
    geometry.current = "";
    setProgress(0);
    setTimedOut(false);
    setLoaded(Boolean(image.current?.complete && image.current.naturalWidth));
    if (!props.active) return;
    const process = () => {
      if (stopped.current) return;
      const p = current.current;
      const element = image.current;
      if (!p.active || document.hidden) {
        fixation.current.reset();
        stopController.current.reset({ stopLatched: true });
        setStopProgress(0);
        setProgress(0);
        return;
      }
      const stopState = stopController.current.update(
        p.observation,
        performance.now(),
        "attention-stop",
        { primary: false, secondary: false },
      );
      setStopProgress(stopState.zone === "stop" ? stopState.progress : 0);
      if (stopState.fired === "stop") {
        stop();
        return;
      }
      if (emitted.current) return;
      if (!element?.complete || !element.naturalWidth) {
        fixation.current.reset();
        setProgress(0);
        return;
      }
      const bounds = element.getBoundingClientRect();
      const width = element.naturalWidth || p.screenWidth;
      const height = element.naturalHeight || p.screenHeight;
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${width}:${height}`;
      if (geometry.current !== key) {
        geometry.current = key;
        fixation.current.reset();
      }
      const observation = p.observation;
      let point = observation
        ? imagePoint(
            {
              x: observation.x * window.innerWidth,
              y: observation.y * window.innerHeight,
            },
            bounds,
            width,
            height,
          )
        : null;
      for (const overlayElement of [
        fallback.current,
        header.current,
        stopButton.current,
      ]) {
        const overlay = overlayElement?.getBoundingClientRect();
        if (observation && overlay) {
          const x = observation.x * window.innerWidth;
          const y = observation.y * window.innerHeight;
          if (
            x >= overlay.left &&
            x <= overlay.right &&
            y >= overlay.top &&
            y <= overlay.bottom
          )
            point = null;
        }
      }
      const next = fixation.current.update(
        point,
        observation?.timestamp ?? NaN,
        observation?.quality ?? 0,
        performance.now(),
      );
      setProgress(next.progress);
      if (next.fired && next.point) {
        emitted.current = true;
        p.onAttention(next.point);
      }
    };
    tick.current = process;
    const timer = window.setInterval(process, 70);
    const timeout = window.setTimeout(() => {
      if (
        emitted.current ||
        stopped.current ||
        !current.current.active ||
        document.hidden
      )
        return;
      const showChoices = current.current.onShowChoices;
      if (showChoices) {
        emitted.current = true;
        fixation.current.reset();
        showChoices();
      } else setTimedOut(true);
    }, 8000);
    const invalidate = () => {
      fixation.current.reset();
      stopController.current.reset({ stopLatched: true });
      setStopProgress(0);
      geometry.current = "";
      setProgress(0);
    };
    window.addEventListener("resize", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      tick.current = null;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [props.active, source, props.screenWidth, props.screenHeight, stop]);

  useLayoutEffect(() => {
    tick.current?.();
  }, [props.observation, loaded]);

  if (!props.active) return null;
  return (
    <section
      className="gaze-attention-view"
      aria-label="Look at your workspace"
      data-testid="gaze-attention-view"
    >
      <header ref={header} className="gaze-attention-header">
        <div>
          <h1>Look at what you want to work on</h1>
          <p role="status">
            {progress >= 1
              ? "Finding choices for this area..."
              : !loaded
                ? "Loading your workspace..."
                : "Hold your gaze on one area. Nerve will suggest what to do next."}
          </p>
        </div>
        <nav aria-label="Attention view controls">
          <button type="button" onClick={props.onBack}>
            Back to choices
          </button>
        </nav>
        <div
          className="gaze-attention-progress"
          role="progressbar"
          aria-label="Steady gaze"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      </header>
      <button
        ref={stopButton}
        type="button"
        className="gaze-attention-stop"
        data-gaze-zone="stop"
        aria-label="Stop"
        onClick={stop}
        style={{
          left: `${GAZE_ZONES.stop.x * 100}%`,
          top: `${GAZE_ZONES.stop.y * 100}%`,
          width: `${GAZE_ZONES.stop.width * 100}%`,
          height: `${GAZE_ZONES.stop.height * 100}%`,
        }}
      >
        <strong>Stop</strong>
        <span>Hold here to stop</span>
        <i style={{ width: `${stopProgress * 100}%` }} />
      </button>
      <img
        ref={image}
        className="gaze-attention-screen"
        src={source}
        alt="Your isolated browser workspace. Look at the area you want help with."
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
      {timedOut && progress < 1 && (
        <div ref={fallback} className="gaze-attention-fallback" role="status">
          <p>No steady area yet. You can still browse available choices.</p>
          <button type="button" onClick={props.onShowChoices ?? props.onBack}>
            Show choices
          </button>
        </div>
      )}
    </section>
  );
}
