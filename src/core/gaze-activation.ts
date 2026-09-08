import type { Observation, Point } from "../../shared/types";

export type GazeZone = "primary" | "secondary" | "neutral" | "stop";
export type GazeCommand = Exclude<GazeZone, "neutral">;
export type GazeRect = Point & { width: number; height: number };

/** The same normalized rectangles position the visible controls and their hit regions. */
export const GAZE_ZONES: Record<GazeZone, GazeRect> = {
  primary: { x: 0.03, y: 0.29, width: 0.31, height: 0.65 },
  secondary: { x: 0.66, y: 0.29, width: 0.31, height: 0.65 },
  neutral: { x: 0.39, y: 0.46, width: 0.22, height: 0.42 },
  stop: { x: 0.36, y: 0.025, width: 0.28, height: 0.165 },
};

const FRESH_MS = 350;
const NEUTRAL_MS = 350;
const COMMAND_MS = 1100;
const STOP_MS = 650;

export function gazeZone(point: Point): GazeZone | null {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    point.x < 0 ||
    point.x > 1 ||
    point.y < 0 ||
    point.y > 1
  )
    return null;
  for (const zone of Object.keys(GAZE_ZONES) as GazeZone[]) {
    const r = GAZE_ZONES[zone];
    if (
      point.x >= r.x &&
      point.x <= r.x + r.width &&
      point.y >= r.y &&
      point.y <= r.y + r.height
    )
      return zone;
  }
  return null;
}

export function gazeZoneCenter(zone: GazeZone): Point {
  const r = GAZE_ZONES[zone];
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

function fresh(
  observation: Observation | null,
  now: number,
  maxAge = FRESH_MS,
): observation is Observation {
  return Boolean(
    observation &&
      Number.isFinite(now) &&
      now >= 0 &&
      Number.isFinite(observation.timestamp) &&
      observation.timestamp >= 0 &&
      observation.timestamp <= now &&
      now - observation.timestamp <= maxAge &&
      Number.isFinite(observation.quality) &&
      observation.quality >= 0.5 &&
      observation.quality <= 1 &&
      Number.isFinite(observation.x) &&
      observation.x >= 0 &&
      observation.x <= 1 &&
      Number.isFinite(observation.y) &&
      observation.y >= 0 &&
      observation.y <= 1,
  );
}

export interface GazeActivationState {
  zone: GazeZone | null;
  armed: boolean;
  progress: number;
  neutralProgress: number;
  fired: GazeCommand | null;
  reliable: boolean;
}

const emptyActivation = (): GazeActivationState => ({
  zone: null,
  armed: false,
  progress: 0,
  neutralProgress: 0,
  fired: null,
  reliable: false,
});

/** Persists between views: a changed control can never inherit the previous hold. */
export class GazeActivationController {
  private stage: string | null = null;
  private previous: number | null = null;
  private previousNow: number | null = null;
  private lastAcceptedAt: number | null = null;
  private armed = false;
  private neutralSince: number | null = null;
  private command: GazeCommand | null = null;
  private commandSince: number | null = null;
  private stopLatched = false;
  private state = emptyActivation();

  reset(options: { stopLatched?: boolean } = {}): void {
    this.stage = null;
    this.previous = this.previousNow = null;
    this.lastAcceptedAt = null;
    this.stopLatched = options.stopLatched ?? false;
    this.clearProgress();
  }

  private clearProgress(): void {
    this.armed = false;
    this.neutralSince = this.commandSince = null;
    this.command = null;
    this.state = emptyActivation();
  }

  update(
    observation: Observation | null,
    now: number,
    stageKey: string,
    enabled: { primary: boolean; secondary: boolean } = {
      primary: true,
      secondary: true,
    },
  ): GazeActivationState {
    const stage = JSON.stringify([
      stageKey,
      enabled.primary,
      enabled.secondary,
    ]);
    if (this.stage !== stage) {
      this.stage = stage;
      this.clearProgress();
    }
    if (
      !fresh(observation, now, Infinity) ||
      (this.previousNow !== null && now < this.previousNow) ||
      (observation &&
        this.previous !== null &&
        observation.timestamp < this.previous)
    ) {
      this.clearProgress();
      return { ...this.state };
    }
    this.previousNow = now;
    if (observation.timestamp === this.previous) {
      // Repainting a previously admitted capture never adds time or fires.
      // Slow inference must get its full inter-arrival window to deliver the next capture.
      if (this.lastAcceptedAt !== null && now - this.lastAcceptedAt > FRESH_MS)
        this.clearProgress();
      return {
        ...this.state,
        fired: null,
        reliable: this.state.reliable && fresh(observation, now),
      };
    }
    if (!fresh(observation, now)) {
      this.clearProgress();
      return { ...this.state };
    }
    if (
      this.previous !== null &&
      (observation.timestamp - this.previous > FRESH_MS ||
        (this.lastAcceptedAt !== null && now - this.lastAcceptedAt > FRESH_MS))
    )
      this.clearProgress();
    this.previous = observation.timestamp;
    this.lastAcceptedAt = now;
    const zone = gazeZone(observation);
    const timestamp = observation.timestamp;
    if (zone !== "stop") this.stopLatched = false;
    let fired: GazeCommand | null = null;
    let progress = 0;
    let neutralProgress = 0;

    if (zone === "neutral") {
      this.command = null;
      this.commandSince = null;
      this.neutralSince ??= timestamp;
      neutralProgress = Math.min(
        1,
        (timestamp - this.neutralSince) / NEUTRAL_MS,
      );
      if (neutralProgress >= 1) this.armed = true;
    } else {
      this.neutralSince = null;
      const canHold =
        zone === "stop"
          ? !this.stopLatched
          : zone !== null && this.armed && enabled[zone];
      if (canHold && zone !== null) {
        if (this.command !== zone) {
          this.command = zone;
          this.commandSince = timestamp;
        }
        const duration = zone === "stop" ? STOP_MS : COMMAND_MS;
        progress = Math.min(1, (timestamp - this.commandSince!) / duration);
        if (progress >= 1) {
          fired = zone;
          this.armed = false;
          this.neutralSince = this.commandSince = null;
          this.command = null;
          if (zone === "stop") this.stopLatched = true;
        }
      } else {
        this.command = null;
        this.commandSince = null;
      }
    }
    this.state = {
      zone,
      armed: this.armed,
      progress,
      neutralProgress,
      fired,
      reliable: true,
    };
    return { ...this.state };
  }
}

const CHECK_ORDER: GazeZone[] = ["primary", "secondary", "neutral", "stop"];
const CHECK_SETTLE_MS = 600;
const CHECK_TIMEOUT_MS = 9000;
const CHECK_MIN_SAMPLES = 5;
const CHECK_MIN_HIT_FRACTION = 0.8;

export interface GazeZoneCheckResult {
  zone: GazeZone;
  samples: number;
  hits: number;
  hitFraction: number;
  heldMs: number;
}

export interface GazeZoneCheckState {
  status: "checking" | "passed" | "failed";
  zone: GazeZone;
  step: number;
  total: number;
  progress: number;
  message: string;
  results: GazeZoneCheckResult[];
}

/** Independent control-zone test. It never fits or changes calibration. */
export class GazeZoneCheck {
  private step = 0;
  private started: number;
  private previousNow: number;
  private previous: number | null = null;
  private lastAcceptedAt: number | null = null;
  private since: number | null = null;
  private samples = 0;
  private hits = 0;
  private results: GazeZoneCheckResult[] = [];
  private state: GazeZoneCheckState;

  constructor(now: number) {
    this.started = this.previousNow = now;
    this.state = {
      status: Number.isFinite(now) && now >= 0 ? "checking" : "failed",
      zone: CHECK_ORDER[0],
      step: 1,
      total: CHECK_ORDER.length,
      progress: 0,
      message:
        "Look at the marked area and hold. This checks gaze without running anything.",
      results: [],
    };
  }

  get current(): GazeZoneCheckState {
    return {
      ...this.state,
      results: this.results.map((result) => ({ ...result })),
    };
  }

  update(observation: Observation | null, now: number): GazeZoneCheckState {
    if (this.state.status !== "checking") return this.current;
    if (!Number.isFinite(now) || now < this.previousNow)
      return this.fail("The input clock changed. Restart gaze setup.");
    this.previousNow = now;
    if (now - this.started >= CHECK_TIMEOUT_MS)
      return this.fail(
        "Gaze did not reliably reach this control. Recalibrate before using eyes-only controls.",
      );
    if (
      !fresh(observation, now, Infinity) ||
      (observation &&
        this.previous !== null &&
        observation.timestamp < this.previous)
    ) {
      this.since = null;
      this.state.progress = 0;
      return this.current;
    }
    if (observation.timestamp === this.previous) {
      if (
        this.lastAcceptedAt !== null &&
        now - this.lastAcceptedAt > FRESH_MS
      ) {
        this.since = null;
        this.state.progress = 0;
      }
      return this.current;
    }
    if (!fresh(observation, now)) {
      this.since = null;
      this.state.progress = 0;
      return this.current;
    }
    if (
      this.previous !== null &&
      (observation.timestamp - this.previous > FRESH_MS ||
        (this.lastAcceptedAt !== null && now - this.lastAcceptedAt > FRESH_MS))
    )
      this.since = null;
    this.previous = observation.timestamp;
    this.lastAcceptedAt = now;
    if (now - this.started < CHECK_SETTLE_MS) return this.current;
    this.samples++;
    const hit = gazeZone(observation) === this.state.zone;
    if (hit) {
      this.hits++;
      this.since ??= observation.timestamp;
    } else this.since = null;
    const heldMs = this.since === null ? 0 : observation.timestamp - this.since;
    this.state.progress = hit ? Math.min(1, heldMs / COMMAND_MS) : 0;
    if (
      this.samples < CHECK_MIN_SAMPLES ||
      heldMs < COMMAND_MS ||
      this.hits / this.samples < CHECK_MIN_HIT_FRACTION
    )
      return this.current;
    this.results.push({
      zone: this.state.zone,
      samples: this.samples,
      hits: this.hits,
      hitFraction: this.hits / this.samples,
      heldMs,
    });
    this.step++;
    if (this.step === CHECK_ORDER.length) {
      this.state.status = "passed";
      this.state.message =
        "Control check passed. Look at the center to get ready.";
      return this.current;
    }
    this.started = now;
    this.since = null;
    this.samples = this.hits = 0;
    this.state = {
      ...this.state,
      zone: CHECK_ORDER[this.step],
      step: this.step + 1,
      progress: 0,
    };
    return this.current;
  }

  private fail(message: string): GazeZoneCheckState {
    this.state = { ...this.state, status: "failed", progress: 0, message };
    return this.current;
  }
}
