// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CONTRAST_PAIRS,
  THEMES,
  applyDensity,
  applyIntensity,
  applyTheme,
  auditContrast,
  contrastRatio,
  relativeLuminance,
  themeVariables,
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

describe("R06 decorative roles", () => {
  it("exposes the aurora ornament as CSS variables in both themes", () => {
    for (const theme of ["daybreak", "afterglow"] as const) {
      const variables = themeVariables(theme);
      for (const name of [
        "--aurora-a",
        "--aurora-b",
        "--aurora-c",
        "--selection",
        "--selection-ink",
        "--glow",
      ]) {
        expect(variables[name], `${theme} ${name}`).toMatch(/^(#|rgba?\()/);
      }
    }
    expect(themeVariables("daybreak")["--aurora-a"]).not.toBe(
      themeVariables("afterglow")["--aurora-a"],
    );
  });

  it("never uses an ornament role as a text foreground", () => {
    // Intensity is decoration only, and the invariant that makes that true is
    // structural: no contrast pair names an ornament role as its foreground. A
    // pair added later that did would fail here rather than in a screenshot.
    const ornament = new Set(["auroraA", "auroraB", "auroraC", "selection", "glow"] as const);
    for (const pair of CONTRAST_PAIRS) {
      expect(ornament.has(pair.foreground as never), pair.name).toBe(false);
    }
    // `selectionInk` is the one role allowed to carry text on an ornament fill,
    // and it is measured like any other pair.
    expect(
      CONTRAST_PAIRS.some(
        (pair) => pair.foreground === "selectionInk" && pair.background === "selection",
      ),
    ).toBe(true);
  });

  it("switches intensity without touching the theme or density attributes", () => {
    const root = document.createElement("div");
    applyTheme("afterglow", root);
    applyIntensity("quiet", root);
    expect(root.dataset.intensity).toBe("quiet");
    expect(root.dataset.theme).toBe("afterglow");
    applyIntensity("vivid", root);
    expect(root.dataset.intensity).toBe("vivid");
    applyDensity("dense", root);
    expect(root.dataset.density).toBe("dense");
    expect(root.dataset.theme).toBe("afterglow");
  });
});
