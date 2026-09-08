import type { Point } from "../../shared/types";

export interface ImageBounds extends Point {
  width: number;
  height: number;
}

/** Maps a viewport pixel to the actual object-fit: contain image, excluding bars. */
export function imagePoint(
  point: Point,
  bounds: ImageBounds,
  imageWidth: number,
  imageHeight: number,
): Point | null {
  if (
    ![
      point.x,
      point.y,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      imageWidth,
      imageHeight,
    ].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  )
    return null;
  const scale = Math.min(
    bounds.width / imageWidth,
    bounds.height / imageHeight,
  );
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  const x = (point.x - bounds.x - (bounds.width - width) / 2) / width;
  const y = (point.y - bounds.y - (bounds.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export interface GazeFixationState {
  progress: number;
  point: Point | null;
  fired: boolean;
}

/** Read-only attention evidence. It never labels intent or activates a control. */
export class GazeFixation {
  private previous: number | null = null;
  private previousNow: number | null = null;
  private rejectedTimestamp: number | null = null;
  private lastAcceptedAt: number | null = null;
  private since: number | null = null;
  private count = 0;
  private sumX = 0;
  private sumY = 0;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  private frozen: Point | null = null;
  private progress = 0;

  reset(): void {
    this.previous = this.previousNow = this.lastAcceptedAt = null;
    this.rejectedTimestamp = null;
    this.frozen = null;
    this.clear();
  }

  private clear(): void {
    this.since = null;
    this.count = this.sumX = this.sumY = this.progress = 0;
  }

  update(
    point: Point | null,
    timestamp: number,
    quality: number,
    now: number,
  ): GazeFixationState {
    const snapshot = (fired = false): GazeFixationState => ({
      progress: this.frozen ? 1 : this.progress,
      point: this.frozen
        ? { ...this.frozen }
        : this.count
          ? { x: this.sumX / this.count, y: this.sumY / this.count }
          : null,
      fired,
    });
    if (this.frozen) return snapshot();
    const valid =
      point &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= 0 &&
      point.x <= 1 &&
      point.y >= 0 &&
      point.y <= 1 &&
      Number.isFinite(timestamp) &&
      timestamp >= 0 &&
      Number.isFinite(now) &&
      now >= timestamp &&
      Number.isFinite(quality) &&
      quality >= 0.5 &&
      quality <= 1;
    if (
      !valid ||
      (this.previousNow !== null && now < this.previousNow) ||
      (this.previous !== null && timestamp < this.previous)
    ) {
      this.clear();
      if (Number.isFinite(timestamp) && timestamp >= 0)
        this.rejectedTimestamp = timestamp;
      if (
        Number.isFinite(timestamp) &&
        timestamp >= 0 &&
        timestamp <= now &&
        (this.previous === null || timestamp >= this.previous)
      )
        this.previous = timestamp;
      if (
        Number.isFinite(now) &&
        (this.previousNow === null || now >= this.previousNow)
      )
        this.previousNow = now;
      return snapshot();
    }
    this.previousNow = now;
    if (timestamp === this.rejectedTimestamp) {
      this.previous = timestamp;
      this.clear();
      return snapshot();
    }
    if (timestamp === this.previous) {
      if (this.lastAcceptedAt === null || now - this.lastAcceptedAt > 350)
        this.clear();
      return snapshot();
    }
    if (now - timestamp > 350) {
      this.previous = timestamp;
      this.clear();
      return snapshot();
    }
    if (
      (this.previous !== null && timestamp - this.previous > 350) ||
      (this.lastAcceptedAt !== null && now - this.lastAcceptedAt > 350)
    )
      this.clear();
    this.previous = timestamp;
    this.lastAcceptedAt = now;
    if (
      this.count &&
      Math.hypot(
        Math.max(this.maxX, point!.x) - Math.min(this.minX, point!.x),
        Math.max(this.maxY, point!.y) - Math.min(this.minY, point!.y),
      ) > 0.08
    )
      this.clear();
    if (!this.count) {
      this.since = timestamp;
      this.minX = this.maxX = point!.x;
      this.minY = this.maxY = point!.y;
    }
    this.minX = Math.min(this.minX, point!.x);
    this.maxX = Math.max(this.maxX, point!.x);
    this.minY = Math.min(this.minY, point!.y);
    this.maxY = Math.max(this.maxY, point!.y);
    this.sumX += point!.x;
    this.sumY += point!.y;
    this.count++;
    this.progress = Math.min(
      1,
      (timestamp - this.since!) / 600,
      this.count / 4,
    );
    if (this.progress >= 1) {
      this.frozen = { x: this.sumX / this.count, y: this.sumY / this.count };
      return snapshot(true);
    }
    return snapshot();
  }
}
