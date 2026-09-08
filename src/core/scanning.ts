/** Deterministic single-switch scanning. A tick highlights; only activate selects. */
export class SwitchScanner {
  private items: string[] = [];
  private index = 0;
  private lastAdvance: number | null = null;
  private lastActivation = -Infinity;
  private paused = false;
  constructor(
    private readonly intervalMs = 1400,
    private readonly debounceMs = 350,
  ) {
    if (
      !Number.isFinite(intervalMs) ||
      intervalMs < 400 ||
      intervalMs > 10000 ||
      !Number.isFinite(debounceMs) ||
      debounceMs < 100 ||
      debounceMs > 3000
    )
      throw new Error("Invalid switch timing.");
  }
  configure(items: string[], timestamp: number): void {
    if (
      items.length > 100 ||
      new Set(items).size !== items.length ||
      items.some((id) => !id) ||
      !Number.isFinite(timestamp)
    )
      throw new Error("Invalid scanning targets.");
    this.items = [...items];
    this.index = 0;
    this.lastAdvance = timestamp;
    this.lastActivation = -Infinity;
  }
  get current(): string | null {
    return this.items[this.index] ?? null;
  }
  setPaused(paused: boolean, timestamp: number): void {
    this.paused = paused;
    this.lastAdvance = timestamp;
  }
  tick(timestamp: number): string | null {
    if (!Number.isFinite(timestamp)) return null;
    if (!this.items.length) return null;
    if (this.lastAdvance === null || timestamp < this.lastAdvance)
      this.lastAdvance = timestamp;
    if (!this.paused && timestamp - this.lastAdvance >= this.intervalMs) {
      // Do not jump across unseen items after background throttling.
      this.index = (this.index + 1) % this.items.length;
      this.lastAdvance = timestamp;
    }
    return this.current;
  }
  activate(timestamp: number): string | null {
    if (
      this.paused ||
      !Number.isFinite(timestamp) ||
      timestamp - this.lastActivation < this.debounceMs
    )
      return null;
    this.lastActivation = timestamp;
    this.lastAdvance = timestamp;
    return this.current;
  }
}
