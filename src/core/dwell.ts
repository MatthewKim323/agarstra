export interface DwellState {
  id: string | null;
  progress: number;
  fired: boolean;
}
export interface DwellOptions {
  dwellMs?: number;
  staleMs?: number;
}

/** A readiness signal only. Callers must separately require deliberate confirmation. */
export class DwellController {
  private id: string | null = null;
  private since: number | null = null;
  private previous: number | null = null;
  private latched = false;
  private readonly dwellMs: number;
  private readonly staleMs: number;
  constructor(options: DwellOptions = {}) {
    this.dwellMs = options.dwellMs ?? 900;
    this.staleMs = options.staleMs ?? 350;
    if (
      !Number.isFinite(this.dwellMs) ||
      this.dwellMs < 200 ||
      this.dwellMs > 10000 ||
      !Number.isFinite(this.staleMs) ||
      this.staleMs < 50 ||
      this.staleMs > 2000
    )
      throw new Error("Invalid dwell timing.");
  }
  reset(): void {
    this.id = null;
    this.since = null;
    this.previous = null;
    this.latched = false;
  }
  update(id: string | null, timestamp: number, valid = true): DwellState {
    if (!valid || !id || !Number.isFinite(timestamp)) {
      this.reset();
      return { id: null, progress: 0, fired: false };
    }
    if (
      this.previous !== null &&
      (timestamp <= this.previous || timestamp - this.previous > this.staleMs)
    ) {
      this.reset();
      // A gap never counts toward a hold; this frame starts a fresh dwell.
      this.id = id;
      this.since = timestamp;
      this.previous = timestamp;
      return { id, progress: 0, fired: false };
    }
    if (id !== this.id) {
      this.id = id;
      this.since = timestamp;
      this.latched = false;
    }
    this.previous = timestamp;
    this.since ??= timestamp;
    const progress = Math.min(1, (timestamp - this.since) / this.dwellMs);
    const fired = progress >= 1 && !this.latched;
    if (fired) this.latched = true;
    return { id, progress, fired };
  }
}
