import type { Observation, Point } from "../../shared/types";

export interface IntentTarget {
  id: string;
  label?: string;
  point: Point;
  prior?: number;
  rect?: { x: number; y: number; width: number; height: number };
}
export interface ScoredIntent {
  id: string;
  score: number;
  probability: number;
  distance: number;
}
export interface IntentRanking {
  /** Normalized heuristic weights. These are NOT calibrated intent probabilities. */
  candidates: ScoredIntent[];
  topId: string | null;
  ambiguous: boolean;
  margin: number;
  valid: boolean;
  reason: string;
  entropy: number;
  question: string | null;
}
export interface IntentOptions {
  sigma?: number;
  evidenceTauMs?: number;
  staleMs?: number;
  minimumQuality?: number;
  minimumMargin?: number;
  minimumWeight?: number;
  maxDistance?: number;
}
const clamp = (v: number, low: number, high: number) =>
  Math.min(high, Math.max(low, v));
const validPoint = (point: Point) =>
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  point.x >= 0 &&
  point.x <= 1 &&
  point.y >= 0 &&
  point.y <= 1;

function targetDistance(target: IntentTarget, point: Point): number {
  if (target.rect) {
    const r = target.rect;
    return Math.hypot(
      Math.max(r.x - point.x, 0, point.x - r.x - r.width),
      Math.max(r.y - point.y, 0, point.y - r.y - r.height),
    );
  }
  return Math.hypot(target.point.x - point.x, target.point.y - point.y);
}

/** Spatial evidence accumulation with a conservative ambiguity gate, never an action executor. */
export class IntentEngine {
  private evidence = new Map<string, number>();
  private previousTime: number | null = null;
  private readonly options: Required<IntentOptions>;
  constructor(options: IntentOptions = {}) {
    this.options = {
      sigma: 0.11,
      evidenceTauMs: 180,
      staleMs: 350,
      minimumQuality: 0.5,
      minimumMargin: 0.18,
      minimumWeight: 0.55,
      maxDistance: 0.3,
      ...options,
    };
    const o = this.options;
    if (
      Object.values(o).some((value) => !Number.isFinite(value)) ||
      o.sigma <= 0 ||
      o.evidenceTauMs <= 0 ||
      o.staleMs <= 0 ||
      o.minimumQuality < 0 ||
      o.minimumQuality > 1 ||
      o.minimumMargin < 0 ||
      o.minimumMargin > 1 ||
      o.minimumWeight < 0 ||
      o.minimumWeight > 1 ||
      o.maxDistance <= 0
    )
      throw new Error("Invalid intent settings.");
  }
  reset(): void {
    this.evidence.clear();
    this.previousTime = null;
  }
  rank(
    targets: IntentTarget[],
    observation: Observation,
    now = observation.timestamp,
  ): IntentRanking {
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(observation.timestamp) ||
      observation.timestamp > now + 50 ||
      now - observation.timestamp > this.options.staleMs
    )
      return this.invalid("Input is stale.");
    if (
      !validPoint(observation) ||
      !Number.isFinite(observation.quality) ||
      observation.quality < this.options.minimumQuality ||
      observation.quality > 1
    )
      return this.invalid("Input is not reliable enough to select.");
    if (
      this.previousTime !== null &&
      observation.timestamp <= this.previousTime
    )
      return this.invalid("Input timestamps must advance.");
    if (!targets.length || targets.length > 100)
      return this.invalid("No selectable targets.");
    const ids = new Set<string>();
    for (const target of targets) {
      if (
        !target.id ||
        ids.has(target.id) ||
        !validPoint(target.point) ||
        (target.prior !== undefined &&
          (!Number.isFinite(target.prior) || target.prior <= 0))
      )
        return this.invalid("Invalid target layout.");
      if (
        target.rect &&
        (Object.values(target.rect).some((value) => !Number.isFinite(value)) ||
          target.rect.width <= 0 ||
          target.rect.height <= 0 ||
          target.rect.x < 0 ||
          target.rect.y < 0 ||
          target.rect.x + target.rect.width > 1.001 ||
          target.rect.y + target.rect.height > 1.001)
      )
        return this.invalid("Invalid target layout.");
      ids.add(target.id);
    }
    const dt =
      this.previousTime === null
        ? this.options.evidenceTauMs
        : observation.timestamp - this.previousTime;
    if (dt > this.options.staleMs) this.evidence.clear();
    this.previousTime = observation.timestamp;
    for (const id of this.evidence.keys())
      if (!ids.has(id)) this.evidence.delete(id);
    const alpha = 1 - Math.exp(-dt / this.options.evidenceTauMs);
    const candidates = targets.map((target) => {
      const distance = targetDistance(target, observation);
      // Clamp contextual priors so they cannot overwhelm an explicit spatial signal.
      const spatial = Math.exp(-0.5 * (distance / this.options.sigma) ** 2);
      const incoming =
        spatial * Math.pow(clamp(target.prior ?? 1, 0.25, 4), 0.2);
      const previous = this.evidence.get(target.id) ?? 0;
      const score = previous + alpha * (incoming - previous);
      this.evidence.set(target.id, score);
      return { id: target.id, score, probability: 0, distance };
    });
    const total = candidates.reduce(
      (sum, candidate) => sum + candidate.score,
      0,
    );
    for (const candidate of candidates)
      candidate.probability =
        total > 1e-12 ? candidate.score / total : 1 / candidates.length;
    candidates.sort(
      (a, b) => b.probability - a.probability || a.id.localeCompare(b.id),
    );
    const first = candidates[0];
    const margin = first.probability - (candidates[1]?.probability ?? 0);
    const ambiguous =
      first.probability < this.options.minimumWeight ||
      margin < this.options.minimumMargin ||
      first.distance > this.options.maxDistance;
    const entropy = candidates.reduce(
      (sum, candidate) =>
        sum -
        (candidate.probability
          ? candidate.probability * Math.log2(candidate.probability)
          : 0),
      0,
    );
    const names = candidates
      .slice(0, 2)
      .map(
        (candidate) =>
          targets.find((target) => target.id === candidate.id)?.label ??
          candidate.id,
      );
    return {
      candidates,
      topId: ambiguous ? null : first.id,
      ambiguous,
      margin,
      valid: true,
      entropy,
      reason: ambiguous
        ? "More than one intent is plausible. Ask for a choice."
        : "One candidate has enough spatial evidence.",
      question:
        ambiguous && names.length === 2 ? `${names[0]} or ${names[1]}?` : null,
    };
  }
  private invalid(reason: string): IntentRanking {
    this.reset();
    return {
      candidates: [],
      topId: null,
      ambiguous: true,
      margin: 0,
      valid: false,
      reason,
      entropy: 0,
      question: null,
    };
  }
}
