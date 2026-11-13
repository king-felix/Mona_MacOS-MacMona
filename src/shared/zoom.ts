import type { ZoomView } from "./contracts/bridge";

/**
 * The interface-scale ladder, shared by main (which applies it) and the
 * renderer (which displays and steps it). Pure data and arithmetic: no
 * Electron, no store, no I/O.
 *
 * The ladder is discrete and bounded on purpose. Free-form zoom drifts to
 * unusable factors, and a fractional factor makes pixel-aligned edges blurry.
 */
export const ZOOM_STEPS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
export const ZOOM_MIN = ZOOM_STEPS[0] as number;
export const ZOOM_MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;

/**
 * Map any number onto the ladder. An unknown, out-of-range, or missing value
 * falls back to 100% rather than silently landing on an extreme.
 */
export function normalizeZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  if (value <= ZOOM_MIN) return ZOOM_MIN;
  if (value >= ZOOM_MAX) return ZOOM_MAX;
  let best = 1;
  let distance = Number.POSITIVE_INFINITY;
  for (const step of ZOOM_STEPS) {
    const gap = Math.abs(step - value);
    if (gap < distance) {
      best = step;
      distance = gap;
    }
  }
  return best;
}

/** The next rung, or the current one at the ends. */
export function stepZoom(current: number, direction: "in" | "out"): number {
  const index = ZOOM_STEPS.indexOf(normalizeZoom(current));
  const at = index < 0 ? ZOOM_STEPS.indexOf(1) : index;
  if (direction === "in") return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, at + 1)] as number;
  return ZOOM_STEPS[Math.max(0, at - 1)] as number;
}

export function zoomPercent(factor: number): string {
  return `${Math.round(normalizeZoom(factor) * 100)}%`;
}

export function zoomView(factor: number): ZoomView {
  const normalized = normalizeZoom(factor);
  return {
    factor: normalized,
    percent: zoomPercent(normalized),
    steps: [...ZOOM_STEPS],
    min: ZOOM_MIN,
    max: ZOOM_MAX,
  };
}
