/**
 * R11 — the bounded render window for the agent console.
 *
 * The console is a variable-height list: a tool card is two lines, an answer is
 * a page of Markdown. Virtualising that honestly means measuring what is on
 * screen and estimating only what is not. This module is the arithmetic half of
 * that contract: given the ordered keys, whatever heights have been measured,
 * and the current scroll position, it returns the slice that must exist in the
 * DOM plus the two spacer sizes that keep the scrollbar telling the truth.
 *
 * It is pure on purpose. The Studio measures and observes; this decides. A
 * window that depends on a browser layout engine cannot be tested in jsdom, and
 * the invariant that matters — the rendered slice covers the viewport, the
 * spacers account for every unrendered card — can be asserted exactly.
 */

export interface WindowRange {
  /** First rendered index (inclusive). */
  start: number;
  /** Last rendered index (exclusive). */
  end: number;
  /**
   * First index that is actually on screen — the rendered slice minus its leading
   * overscan. A measured height correction only moves content under the viewport
   * when it belongs to a card *before* this index; cards in the overscan band are
   * mounted but off screen, so correcting them must not scroll the reader.
   */
  visibleStart: number;
  /** Height of everything above the rendered slice, in CSS pixels. */
  top: number;
  /** Height of everything below the rendered slice, in CSS pixels. */
  bottom: number;
  /** Estimated full height of the list, spacers included. */
  total: number;
  /** True when the slice is the whole list. */
  complete: boolean;
}

export interface WindowInput {
  keys: readonly string[];
  /** Measured heights by key. Absent keys use `estimate`. */
  heights: ReadonlyMap<string, number>;
  scrollTop: number;
  viewportHeight: number;
  /**
   * The height used for a card nobody has measured yet. It is deliberately a
   * plain number rather than a per-kind guess: a wrong guess is corrected by
   * the first measurement, and pretending to know an answer's height would make
   * the first scroll jump.
   */
  estimate: number;
  /** Cards rendered beyond the viewport on each side. */
  overscan?: number;
  /** Clamp the slice to start at this key even if it is outside the viewport. */
  includeKey?: string | null;
}

/** A sane floor so a zero measurement cannot make the list collapse. */
const MIN_CARD = 24;

function heightOf(key: string, heights: ReadonlyMap<string, number>, estimate: number): number {
  const measured = heights.get(key);
  if (measured === undefined || !Number.isFinite(measured)) return estimate;
  return Math.max(MIN_CARD, measured);
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Decide the rendered slice.
 *
 * Ordering is the caller's: the keys are the conversation's display order, so a
 * measurement carried over from a previous page is still about the same card.
 */
export function computeWindow(input: WindowInput): WindowRange {
  const { keys, heights, includeKey = null } = input;
  const estimate = Math.max(MIN_CARD, positive(input.estimate, 96));
  const overscan = Math.max(0, Math.floor(input.overscan ?? 6));
  const count = keys.length;
  if (count === 0) {
    return { start: 0, end: 0, visibleStart: 0, top: 0, bottom: 0, total: 0, complete: true };
  }

  const viewport = Math.max(1, positive(input.viewportHeight, estimate * 8));
  const scrollTop = positive(input.scrollTop, 0);

  // One pass builds the prefix heights the spacers need, and finds the visible
  // band. The list is bounded by the renderer's retention cap, so this is a
  // small O(n) over loaded cards; it allocates one number per card.
  const offsets = new Array<number>(count + 1);
  offsets[0] = 0;
  let cumulative = 0;
  for (let index = 0; index < count; index += 1) {
    cumulative += heightOf(keys[index] as string, heights, estimate);
    offsets[index + 1] = cumulative;
  }
  const total = cumulative;

  // First card whose bottom edge is below the viewport's top edge.
  let start = 0;
  while (start < count && (offsets[start + 1] as number) <= scrollTop) start += 1;
  // Last card whose top edge is above the viewport's bottom edge.
  let end = start;
  const bottomEdge = scrollTop + viewport;
  while (end < count && (offsets[end] as number) < bottomEdge) end += 1;

  // A scroll position below the end of the list (a shrink, or a height
  // correction) still needs a rendered slice; show the tail.
  if (start >= count) {
    start = count - 1;
    end = count;
  }

  const firstVisible = start;
  start = Math.max(0, start - overscan);
  end = Math.min(count, Math.max(end, start + 1) + overscan);

  if (includeKey !== null) {
    const forced = keys.indexOf(includeKey);
    if (forced >= 0 && (forced < start || forced >= end)) {
      // A forced card is rendered *with* the reader's current window trimmed to
      // the same size, never by stretching from the anchor to the edge. Stretching
      // would mount every card between a search hit in an old page and the live
      // edge — the unbounded render this module exists to prevent, in exactly the
      // state the forced key was added for.
      const span = Math.max(1, end - start);
      if (forced < start) {
        start = Math.max(0, forced - overscan);
        end = Math.min(count, start + span);
      } else {
        end = Math.min(count, forced + 1 + overscan);
        start = Math.max(0, end - span);
      }
    }
  }

  // An included key can pull the slice outward; if it landed above the old first
  // visible card, the band the reader is looking at begins after it. Bounded so a
  // forced key cannot silently declare a hundreds-of-cards region "visible".
  const visibleStart = Math.min(Math.max(firstVisible, start), Math.max(start, end - 1));

  return {
    start,
    end,
    visibleStart,
    top: offsets[start] as number,
    bottom: total - (offsets[end] as number),
    total,
    complete: start === 0 && end === count,
  };
}

/**
 * The key of the card nearest the top edge of the viewport. The Studio uses it
 * as a scroll anchor when an older page is prepended: the reader stays on the
 * message they were reading, not on a pixel offset that just changed meaning.
 * Returns null when the list is empty.
 */
export function anchorKeyAt(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  scrollTop: number,
  estimate: number,
): string | null {
  if (keys.length === 0) return null;
  const step = Math.max(MIN_CARD, positive(estimate, 96));
  const target = positive(scrollTop, 0);
  let cumulative = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const height = heightOf(keys[index] as string, heights, step);
    if (cumulative + height > target) return keys[index] as string;
    cumulative += height;
  }
  return keys[keys.length - 1] as string;
}
