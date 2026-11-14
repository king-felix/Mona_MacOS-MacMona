import { describe, expect, it } from "vitest";
import { anchorKeyAt, computeWindow, type WindowInput } from "../src/renderer/shell/virtual-window";

/**
 * R11 — the console's bounded-render arithmetic.
 *
 * These assert the two invariants the DOM relies on: the rendered slice covers
 * the viewport, and the spacers account for every card that is not mounted. Both
 * are exact, so a wrong window is a failing test rather than a scroll jump a
 * reader has to discover.
 */

const ESTIMATE = 100;

function keys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `card-${index}`);
}

function uniform(count: number, height = ESTIMATE): Map<string, number> {
  return new Map(keys(count).map((key) => [key, height]));
}

function window(
  input: Partial<WindowInput> & { keys: readonly string[] },
): ReturnType<typeof computeWindow> {
  return computeWindow({
    heights: new Map(),
    scrollTop: 0,
    viewportHeight: 800,
    estimate: ESTIMATE,
    overscan: 0,
    ...input,
  });
}

describe("computeWindow", () => {
  it("renders the visible band of a uniform list and accounts for the rest", () => {
    const range = window({ keys: keys(1_000), heights: uniform(1_000), viewportHeight: 500 });
    expect(range.start).toBe(0);
    expect(range.end).toBe(5);
    expect(range.top).toBe(0);
    expect(range.bottom).toBe(99_500);
    expect(range.total).toBe(100_000);
    expect(range.complete).toBe(false);
  });

  it("moves the band with the scroll position and keeps the spacers exact", () => {
    const range = window({
      keys: keys(1_000),
      heights: uniform(1_000),
      scrollTop: 20_000,
      viewportHeight: 500,
    });
    // Scroll 20,000 / 100 = card 200 at the top; five 100 px cards fit.
    expect(range.start).toBe(200);
    expect(range.end).toBe(205);
    expect(range.top).toBe(20_000);
    expect(range.bottom).toBe(100_000 - 20_500);
  });

  it("uses measured heights, not the estimate, once a card is measured", () => {
    const heights = uniform(10, 50);
    heights.set("card-0", 400);
    const range = window({ keys: keys(10), heights, viewportHeight: 500 });
    expect(range.total).toBe(400 + 9 * 50);
    // Card 0 is 400 px tall: the 500 px viewport therefore also shows cards 1–2.
    expect(range.end).toBe(3);
  });

  it("adds overscan on both sides without leaving the list", () => {
    const first = window({
      keys: keys(500),
      heights: uniform(500),
      viewportHeight: 500,
      overscan: 4,
    });
    expect(first.start).toBe(0);
    expect(first.end).toBe(9);

    const middle = window({
      keys: keys(500),
      heights: uniform(500),
      scrollTop: 10_000,
      viewportHeight: 500,
      overscan: 4,
    });
    expect(middle.start).toBe(96);
    expect(middle.end).toBe(109);
  });

  it("reports a complete slice when the whole list is rendered", () => {
    const range = window({ keys: keys(5), heights: uniform(5), viewportHeight: 800 });
    expect(range).toMatchObject({ start: 0, end: 5, top: 0, bottom: 0, complete: true });
  });

  it("renders the tail when the scroll position is past the content", () => {
    // A shrink, a zoom change or a height correction can leave scrollTop beyond
    // the list; the window still has to render something.
    const range = window({
      keys: keys(100),
      heights: uniform(100),
      scrollTop: 999_999,
      viewportHeight: 400,
    });
    expect(range.end).toBe(100);
    expect(range.start).toBeLessThan(100);
    expect(range.bottom).toBe(0);
  });

  it("estimates unmeasured cards from the caller's estimate", () => {
    const range = window({ keys: keys(10), viewportHeight: 350, estimate: 200 });
    expect(range.total).toBe(2_000);
    expect(range.end).toBe(2);
  });

  it("forces an off-screen anchor into the slice", () => {
    const range = window({
      keys: keys(1_000),
      heights: uniform(1_000),
      viewportHeight: 500,
      includeKey: "card-900",
      overscan: 2,
    });
    expect(range.start).toBeLessThanOrEqual(900);
    expect(range.end).toBeGreaterThan(900);
  });

  it("keeps a forced anchor bounded instead of stretching to the live edge", () => {
    // The reader sits at the live edge (card 990) and a search hit is in an old
    // page (card 40). Rendering everything between them would mount ~950 cards:
    // the unbounded render this module exists to prevent.
    const atEdge = window({
      keys: keys(1_000),
      heights: uniform(1_000),
      scrollTop: 99_000,
      viewportHeight: 500,
      overscan: 6,
      includeKey: "card-40",
    });
    expect(atEdge.start).toBeLessThanOrEqual(40);
    expect(atEdge.end).toBeGreaterThan(40);
    expect(atEdge.end - atEdge.start).toBeLessThanOrEqual(40);

    // The symmetric case: the reader at the top, the anchor in a later page.
    const atTop = window({
      keys: keys(1_000),
      heights: uniform(1_000),
      scrollTop: 0,
      viewportHeight: 500,
      overscan: 6,
      includeKey: "card-900",
    });
    expect(atTop.start).toBeLessThanOrEqual(900);
    expect(atTop.end).toBeGreaterThan(900);
    expect(atTop.end - atTop.start).toBeLessThanOrEqual(40);
  });

  it("reports the first card actually on screen separately from the overscan", () => {
    const range = window({
      keys: keys(500),
      heights: uniform(500),
      scrollTop: 10_000,
      viewportHeight: 500,
      overscan: 6,
    });
    // Card 100 is the first visible one; the slice starts 6 cards earlier.
    expect(range.start).toBe(94);
    expect(range.visibleStart).toBe(100);
    // A correction to a card in [94, 100) is off screen and must not scroll.
    expect(range.visibleStart).toBeGreaterThan(range.start);
  });

  it("is empty for an empty conversation", () => {
    expect(window({ keys: [] })).toEqual({
      start: 0,
      end: 0,
      visibleStart: 0,
      top: 0,
      bottom: 0,
      total: 0,
      complete: true,
    });
  });

  it("never lets a zero or negative measurement collapse the list", () => {
    const heights = new Map<string, number>([
      ["card-0", 0],
      ["card-1", -40],
    ]);
    const range = window({ keys: keys(4), heights, scrollTop: 0, viewportHeight: 3_000 });
    expect(range.total).toBeGreaterThanOrEqual(4 * 24);
    expect(range.end).toBe(4);
  });
});

describe("anchorKeyAt", () => {
  it("names the card at the top edge of the viewport", () => {
    expect(anchorKeyAt(keys(50), uniform(50), 1_050, ESTIMATE)).toBe("card-10");
    expect(anchorKeyAt(keys(50), uniform(50), 0, ESTIMATE)).toBe("card-0");
  });

  it("falls back to the last card past the end and reports null when empty", () => {
    expect(anchorKeyAt(keys(5), uniform(5), 99_999, ESTIMATE)).toBe("card-4");
    expect(anchorKeyAt([], new Map(), 0, ESTIMATE)).toBeNull();
  });
});
