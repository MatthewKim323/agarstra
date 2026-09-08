export type GestureKind = "jawOpen" | "browInnerUp" | "mouthSmile";
export interface GestureConfig {
  kind: GestureKind;
  activate: number;
  release: number;
  holdMs: number;
  releaseMs: number;
  cooldownMs: number;
}

function quantile(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * percentile)];
}

export function isGestureConfig(value: unknown): value is GestureConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as GestureConfig;
  return (
    ["jawOpen", "browInnerUp", "mouthSmile"].includes(v.kind) &&
    Number.isFinite(v.activate) &&
    Number.isFinite(v.release) &&
    v.release >= 0 &&
    v.activate <= 1 &&
    v.activate - v.release >= 0.02 &&
    Number.isFinite(v.holdMs) &&
    v.holdMs >= 200 &&
    v.holdMs <= 3000 &&
    Number.isFinite(v.releaseMs) &&
    v.releaseMs >= 150 &&
    v.releaseMs <= 3000 &&
    Number.isFinite(v.cooldownMs) &&
    v.cooldownMs >= 500 &&
    v.cooldownMs <= 10000
  );
}

/** Explicit neutral + deliberate-activation recordings are required. No default click threshold. */
export function calibrateGesture(
  neutral: number[],
  active: number[],
  kind: GestureKind = "jawOpen",
): GestureConfig {
  if (
    neutral.length < 10 ||
    active.length < 10 ||
    [...neutral, ...active].some((v) => !Number.isFinite(v) || v < 0 || v > 1)
  ) {
    throw new Error(
      "Record at least 10 valid neutral and deliberate gesture samples.",
    );
  }
  const baseline = quantile(neutral, 0.9);
  const activation = quantile(active, 0.25);
  const separation = activation - baseline;
  if (separation < 0.12)
    throw new Error(
      "This gesture is not distinct enough from rest. Try another comfortable gesture or use switch input.",
    );
  return {
    kind,
    release: baseline + separation * 0.25,
    activate: baseline + separation * 0.65,
    holdMs: 550,
    releaseMs: 300,
    cooldownMs: 1300,
  };
}

/** One event per intentional hold, then neutral release is required to arm again. */
export class GestureDetector {
  private config: GestureConfig | null = null;
  private previousTime: number | null = null;
  private neutralSince: number | null = null;
  private activeSince: number | null = null;
  private firedAt = -Infinity;
  private armed = false;

  constructor(config: GestureConfig | null = null) {
    this.configure(config);
  }
  configure(config: GestureConfig | null): void {
    if (config !== null && !isGestureConfig(config))
      throw new Error("Invalid gesture configuration.");
    this.config = config ? { ...config } : null;
    this.reset();
  }
  reset(): void {
    this.previousTime = null;
    this.neutralSince = null;
    this.activeSince = null;
    this.firedAt = -Infinity;
    this.armed = false;
  }
  get isArmed(): boolean {
    return this.armed;
  }
  update(score: number, timestamp: number, valid = true): boolean {
    const config = this.config;
    if (
      !config ||
      !valid ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1 ||
      !Number.isFinite(timestamp)
    ) {
      this.reset();
      return false;
    }
    if (
      this.previousTime !== null &&
      (timestamp <= this.previousTime || timestamp - this.previousTime > 350)
    ) {
      this.reset();
      this.previousTime = timestamp;
      return false;
    }
    this.previousTime = timestamp;
    if (score <= config.release) {
      this.activeSince = null;
      this.neutralSince ??= timestamp;
      if (
        timestamp - this.neutralSince >= config.releaseMs &&
        timestamp - this.firedAt >= config.cooldownMs
      )
        this.armed = true;
      return false;
    }
    this.neutralSince = null;
    if (!this.armed || score < config.activate) {
      this.activeSince = null;
      return false;
    }
    this.activeSince ??= timestamp;
    if (timestamp - this.activeSince < config.holdMs) return false;
    this.firedAt = timestamp;
    this.armed = false;
    this.activeSince = null;
    return true;
  }
}
