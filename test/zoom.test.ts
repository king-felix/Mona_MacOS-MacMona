import { describe, expect, it } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
  normalizeZoom,
  stepZoom,
  zoomPercent,
  zoomView,
} from "../src/shared/zoom";
import { ZOOM_SCOPE, ZoomController, type ZoomStore, type ZoomTarget } from "../src/main/zoom";

function fakeStore(initial: unknown = null): ZoomStore & { writes: unknown[] } {
  const writes: unknown[] = [];
  let value: unknown = initial;
  return {
    writes,
    getSettings: async (scope: string) => {
      expect(scope).toBe(ZOOM_SCOPE);
      return value === null ? null : { value, version: 1 };
    },
    putSettings: async (scope: string, next: unknown) => {
      expect(scope).toBe(ZOOM_SCOPE);
      value = next;
      writes.push(next);
      return { version: 2 };
    },
  };
}

function fakeWindow(): ZoomTarget & { applied: number[] } {
  const applied: number[] = [];
  return {
    applied,
    webContents: {
      setZoomFactor: (factor: number) => {
        applied.push(factor);
      },
    },
  };
}

describe("interface scale ladder", () => {
  it("is ascending, bounded, and contains 100%", () => {
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b));
    expect(ZOOM_STEPS).toContain(1);
    expect(ZOOM_MIN).toBe(0.8);
    expect(ZOOM_MAX).toBe(2);
  });

  it("snaps arbitrary values onto the ladder and falls back to 100%", () => {
    expect(normalizeZoom(1)).toBe(1);
    expect(normalizeZoom(1.24)).toBe(1.25);
    expect(normalizeZoom(1.6)).toBe(1.5);
    expect(normalizeZoom(0.1)).toBe(ZOOM_MIN);
    expect(normalizeZoom(9)).toBe(ZOOM_MAX);
    expect(normalizeZoom(Number.NaN)).toBe(1);
    expect(normalizeZoom("1.5")).toBe(1);
    expect(normalizeZoom(undefined)).toBe(1);
  });

  it("steps one rung and stops at both ends", () => {
    expect(stepZoom(1, "in")).toBe(1.1);
    expect(stepZoom(1, "out")).toBe(0.9);
    expect(stepZoom(ZOOM_MAX, "in")).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, "out")).toBe(ZOOM_MIN);
    // An off-ladder value is normalized before stepping, not stepped from raw.
    expect(stepZoom(1.02, "in")).toBe(1.1);
  });

  it("reports the view as a percentage the renderer can show", () => {
    expect(zoomPercent(1)).toBe("100%");
    expect(zoomPercent(1.25)).toBe("125%");
    expect(zoomView(1.5)).toMatchObject({ factor: 1.5, percent: "150%", min: 0.8, max: 2 });
  });
});

describe("ZoomController", () => {
  it("loads the saved scale, applies it, and never trusts an off-ladder value", async () => {
    const store = fakeStore({ factor: 1.35 });
    const window = fakeWindow();
    const controller = new ZoomController({ store, window: () => window });
    expect(await controller.load()).toBe(1.25);
    expect(controller.apply()).toBe(1.25);
    expect(window.applied).toEqual([1.25]);
  });

  it("persists every change and applies it to the live window", async () => {
    const store = fakeStore();
    const window = fakeWindow();
    const controller = new ZoomController({ store, window: () => window });
    await controller.load();

    expect((await controller.step("in")).factor).toBe(1.1);
    expect((await controller.step("out")).factor).toBe(1);
    expect((await controller.set(1.75)).percent).toBe("175%");
    expect(window.applied).toEqual([1.1, 1, 1.75]);
    expect(store.writes).toEqual([{ factor: 1.1 }, { factor: 1 }, { factor: 1.75 }]);

    expect((await controller.reset()).factor).toBe(1);
    expect(window.applied[window.applied.length - 1]).toBe(1);
  });

  it("survives an unreadable or unwritable store instead of refusing to start", async () => {
    const warnings: string[] = [];
    const broken: ZoomStore = {
      getSettings: async () => {
        throw new Error("database is locked");
      },
      putSettings: async () => {
        throw new Error("disk is full");
      },
    };
    const window = fakeWindow();
    const controller = new ZoomController({
      store: broken,
      window: () => window,
      warn: (message) => warnings.push(message),
    });
    expect(await controller.load()).toBe(1);
    expect((await controller.set(1.5)).factor).toBe(1.5);
    expect(window.applied).toEqual([1.5]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("unreadable");
    expect(warnings[1]).toContain("could not be saved");
  });

  it("works with no window yet, and applies later to a new one", async () => {
    let window: ZoomTarget | null = null;
    const controller = new ZoomController({ store: fakeStore(), window: () => window });
    expect((await controller.set(1.25)).factor).toBe(1.25);
    window = fakeWindow();
    controller.apply();
    expect((window as unknown as { applied: number[] }).applied).toEqual([1.25]);
  });
});
