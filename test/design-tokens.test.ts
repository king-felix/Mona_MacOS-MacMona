import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  THEMES,
  auditContrast,
  contrastRatio,
  relativeLuminance,
} from "../src/renderer/design/tokens";

describe("design tokens", () => {
  it("computes known luminance and contrast values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 2);
  });

  it("defines both themes with the same semantic roles", () => {
    expect(Object.keys(THEMES.daybreak).sort()).toEqual(Object.keys(THEMES.afterglow).sort());
  });

  it.each(["daybreak", "afterglow"] as const)(
    "meets WCAG AA for every used pair in %s",
    (theme) => {
      const results = auditContrast(theme);
      const failures = results.filter((result) => !result.pass);
      expect(
        failures.map((result) => `${result.name}: ${result.ratio.toFixed(2)} < ${result.minimum}`),
      ).toEqual([]);
      // Every semantic pair is exercised, not a hand-picked subset.
      expect(results).toHaveLength(CONTRAST_PAIRS.length);
    },
  );

  it("keeps the coral highlight out of normal-text roles", () => {
    for (const theme of ["daybreak", "afterglow"] as const) {
      const tokens = THEMES[theme];
      for (const pair of CONTRAST_PAIRS.filter((entry) => entry.minimum === 4.5)) {
        expect(tokens[pair.foreground]).not.toBe(tokens.accent);
      }
    }
  });
});
