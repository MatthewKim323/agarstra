const SMOOTHING_MS = 450;
const MAX_SAMPLE_GAP_MS = 350;
const EXPIRY_MS = 700;
const MAX_IDS = 100;
const MAX_ID_LENGTH = 128;
const MIN_WEIGHT = 1e-6;

const emptyWeights = (): Record<string, number> => Object.create(null);

/**
 * Short-lived attention evidence, never a probability, label, or action.
 * Use one clock and one input mode. Reset when the mode or target layout changes.
 */
export class IntentAttention {
  private evidence = new Map<string, number>();
  private lastSampleTime: number | null = null;
  private lastReadTime: number | null = null;

  observe(id: string | null, timestamp: number, quality: number): void {
    if (
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      !Number.isFinite(quality) ||
      quality < 0.5 ||
      quality > 1 ||
      (id !== null &&
        (typeof id !== "string" || !id.trim() || id.length > MAX_ID_LENGTH)) ||
      (this.lastSampleTime !== null && timestamp <= this.lastSampleTime)
    ) {
      this.reset();
      return;
    }

    if (
      this.lastSampleTime === null ||
      timestamp - this.lastSampleTime > MAX_SAMPLE_GAP_MS
    ) {
      this.reset();
      // A single observation cannot establish sustained attention.
      this.lastSampleTime = timestamp;
      return;
    }

    const decay = Math.exp(-(timestamp - this.lastSampleTime) / SMOOTHING_MS);
    this.lastSampleTime = timestamp;
    for (const [key, value] of this.evidence) {
      const next = value * decay;
      if (next < MIN_WEIGHT) this.evidence.delete(key);
      else this.evidence.set(key, next);
    }
    // A valid null observation means looking elsewhere, not rejecting a goal.
    if (id !== null) {
      this.evidence.set(
        id,
        Math.min(1, (this.evidence.get(id) ?? 0) + (1 - decay) * quality),
      );
    }
    if (this.evidence.size > MAX_IDS) {
      let weakestId: string | null = null;
      let weakestWeight = Infinity;
      for (const [key, value] of this.evidence) {
        if (value < weakestWeight) {
          weakestId = key;
          weakestWeight = value;
        }
      }
      if (weakestId !== null) this.evidence.delete(weakestId);
    }
  }

  weights(now: number): Record<string, number> {
    const result = emptyWeights();
    if (
      !Number.isFinite(now) ||
      now < 0 ||
      (this.lastReadTime !== null && now < this.lastReadTime) ||
      (this.lastSampleTime !== null && now < this.lastSampleTime)
    ) {
      this.reset();
      return result;
    }
    this.lastReadTime = now;
    if (this.lastSampleTime === null) return result;

    const age = now - this.lastSampleTime;
    if (age >= EXPIRY_MS) {
      this.reset();
      return result;
    }
    // Fade smoothly to zero once ordinary input freshness has elapsed.
    const freshness = Math.min(
      1,
      (EXPIRY_MS - age) / (EXPIRY_MS - MAX_SAMPLE_GAP_MS),
    );
    const decay = Math.exp(-age / SMOOTHING_MS) * freshness;
    for (const [id, value] of this.evidence) {
      const weight = Math.min(1, Math.max(0, value * decay));
      if (Number.isFinite(weight) && weight >= MIN_WEIGHT) result[id] = weight;
    }
    return result;
  }

  reset(): void {
    this.evidence.clear();
    this.lastSampleTime = null;
    this.lastReadTime = null;
  }
}
