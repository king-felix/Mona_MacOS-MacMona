import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { computeWindow, type WindowRange } from "./virtual-window";

/**
 * R11 — measured windowing for the agent console.
 *
 * The console is a variable-height list, so "virtualized" here means: measure the
 * cards that are actually painted, estimate the ones that are not, and render
 * only the slice the reader can see plus a small overscan. Two spacers keep the
 * scrollbar honest.
 *
 * Three rules make that safe rather than clever:
 *
 * 1. **No measurement, no window.** A pane with no height (server render, jsdom,
 *    a hidden screen, a collapsed split) reports the whole list. A window built
 *    on a guessed viewport would hide content from a reader who cannot scroll it.
 * 2. **A short list is not worth windowing.** Below `MIN_WINDOWED` cards the
 *    whole list renders; the cost of the machinery would exceed the cost of the
 *    DOM, and ordinary conversations stay byte-for-byte as they were.
 * 3. **A measurement never moves what you are reading.** When a card above the
 *    viewport is measured taller or shorter than the estimate, the scroll
 *    position is corrected by exactly that difference, so the viewport stays on
 *    the same message.
 */

/** Below this many cards the list renders in full. */
export const MIN_WINDOWED = 80;

/** How many extra cards render beyond the viewport on each side. */
const OVERSCAN = 6;

/** The height assumed for a card nobody has measured yet. */
const DEFAULT_ESTIMATE = 96;

export interface TimelineWindow {
  start: number;
  end: number;
  /** First card actually on screen; see `WindowRange.visibleStart`. */
  visibleStart: number;
  top: number;
  bottom: number;
  total: number;
  /** True when the DOM is a slice of the list rather than all of it. */
  virtualized: boolean;
  /** Cards currently in the DOM. */
  rendered: number;
  /** Average measured card height, or the default estimate when nothing is measured. */
  estimate: number;
}

export interface TimelineWindowInput {
  /** Display keys, in the order the console renders them. */
  keys: readonly string[];
  /** The scrolling element. */
  containerRef: RefObject<HTMLElement | null>;
  /** A card that must be rendered even when it is off screen (a search anchor). */
  includeKey?: string | null;
  /** Bumped by the caller when card content changes in a way that affects height. */
  revision?: number;
  /**
   * True while new frames should keep the view pinned to the bottom. The hook
   * re-pins after a measurement changes the list's height, so "follow the live
   * edge" does not stop working once estimated heights are corrected.
   */
  followRef?: RefObject<boolean>;
}

export function useTimelineWindow(input: TimelineWindowInput): TimelineWindow {
  const { keys, containerRef, includeKey = null, revision = 0, followRef } = input;
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [geometry, setGeometry] = useState({ scrollTop: 0, viewport: 0, version: 0 });
  const versionRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  const bump = useCallback(() => {
    versionRef.current += 1;
    setGeometry((previous) => ({ ...previous, version: versionRef.current }));
  }, []);

  // Read the pane's height. A ResizeObserver catches window resize, interface
  // scale, a layout change between Focus and the normal shell, and a splitter —
  // a window `resize` event sees none of those.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const read = (): void => {
      const viewport = node.clientHeight;
      const scrollTop = node.scrollTop;
      setGeometry((previous) =>
        previous.viewport === viewport && previous.scrollTop === scrollTop
          ? previous
          : { ...previous, viewport, scrollTop },
      );
    };
    read();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(read) : null;
    observer?.observe(node);
    window.addEventListener("resize", read);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [containerRef]);

  // Track the scroll position, coalesced to one read per frame: a fast scroll
  // must not cost a React commit per event.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onScroll = (): void => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const current = containerRef.current;
        if (!current) return;
        const scrollTop = current.scrollTop;
        setGeometry((previous) =>
          previous.scrollTop === scrollTop ? previous : { ...previous, scrollTop },
        );
      });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [containerRef]);

  const estimate = useMemo(() => {
    const values = [...heightsRef.current.values()].filter((value) => value > 0);
    if (values.length === 0) return DEFAULT_ESTIMATE;
    const total = values.reduce((sum, value) => sum + value, 0);
    return Math.max(24, Math.round(total / values.length));
  }, [geometry.version, keys.length]);

  // The band the reader can actually see. A corrected height only shifts the
  // viewport when the card it belongs to sits above *that* band — cards in the
  // leading overscan are mounted but off screen, so correcting one of them must
  // not move the content the reader is looking at.
  const visibleStartRef = useRef(0);

  const range: WindowRange = useMemo(() => {
    if (geometry.viewport <= 0 || keys.length < MIN_WINDOWED) {
      return {
        start: 0,
        end: keys.length,
        visibleStart: 0,
        top: 0,
        bottom: 0,
        total: 0,
        complete: true,
      };
    }
    return computeWindow({
      keys,
      heights: heightsRef.current,
      scrollTop: geometry.scrollTop,
      viewportHeight: geometry.viewport,
      estimate,
      overscan: OVERSCAN,
      includeKey,
    });
    // `geometry.version` is the measurement epoch: a new measurement changes the
    // spacers even when the scroll position and the key list did not move.
  }, [keys, geometry.scrollTop, geometry.viewport, geometry.version, estimate, includeKey]);
  visibleStartRef.current = range.visibleStart;

  // Observe the cards that are actually mounted. One observer for the list, with
  // the currently rendered cards attached, so a measurement costs a map write and
  // one coalesced commit rather than a React state update per card.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver !== "function") return;
    const cards = Array.from(node.querySelectorAll<HTMLElement>("[data-card-key]"));
    if (cards.length === 0) return;

    const flush = new Map<string, number>();
    let frame: number | null = null;
    const apply = (): void => {
      frame = null;
      if (flush.size === 0) return;
      const heights = heightsRef.current;
      const changes: Array<{ index: number; delta: number }> = [];
      const indexOf = new Map<string, number>();
      keys.forEach((key, index) => indexOf.set(key, index));
      for (const [key, height] of flush) {
        const before = heights.get(key);
        const next = Math.max(24, Math.round(height));
        if (before !== undefined && Math.abs(before - next) < 0.5) continue;
        const index = indexOf.get(key);
        if (index === undefined) continue;
        heights.set(key, next);
        changes.push({ index, delta: next - (before ?? DEFAULT_ESTIMATE) });
      }
      flush.clear();
      if (changes.length === 0) return;
      const current = containerRef.current;
      if (current && followRef?.current === true) {
        current.scrollTop = current.scrollHeight;
      } else if (current) {
        // Keep the reader on the message they are reading. Only a card *above*
        // the rendered window moves the content under the viewport; measuring a
        // card the reader is looking at cannot change where it sits.
        const shift = changes.reduce(
          (sum, change) => (change.index < visibleStartRef.current ? sum + change.delta : sum),
          0,
        );
        if (shift !== 0 && current.scrollTop > 0) {
          current.scrollTop = Math.max(0, current.scrollTop + shift);
        }
      }
      bump();
    };

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const key = target.dataset.cardKey;
        if (!key) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? target.getBoundingClientRect().height;
        if (!Number.isFinite(height) || height <= 0) continue;
        flush.set(key, height);
      }
      if (flush.size > 0 && frame === null) frame = requestAnimationFrame(apply);
    });
    for (const card of cards) observer.observe(card);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [containerRef, range.start, range.end, keys, revision, bump, followRef]);

  // A window that grows or shrinks changes the list's height without any card
  // being measured — the spacers alone move it. When the reader is following the
  // live edge, that must re-pin; otherwise "Jump to latest" lands short by exactly
  // the spacer delta and is immediately replaced by the button that asked for it.
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node || followRef?.current !== true) return;
    const pin = (): void => {
      if (containerRef.current && followRef?.current === true) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    };
    pin();
    // Once more after the new slice has been laid out, so a card that mounts
    // with its real height cannot leave the view short either.
    const frame = requestAnimationFrame(() => requestAnimationFrame(pin));
    return () => cancelAnimationFrame(frame);
  }, [containerRef, range.start, range.end, range.top, range.bottom, followRef]);

  const rendered = Math.max(0, range.end - range.start);
  return {
    start: range.start,
    end: range.end,
    visibleStart: range.visibleStart,
    top: range.top,
    bottom: range.bottom,
    total: range.total,
    virtualized: range.end - range.start < keys.length,
    rendered,
    estimate,
  };
}
