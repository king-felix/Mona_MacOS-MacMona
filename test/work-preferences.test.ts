import { describe, expect, it } from "vitest";
import { defaultPolishPreferences } from "../src/shared/contracts/polish";
import { PolishPreferencesStore, normalizeIdentity } from "../src/main/work/preferences";
import { ProjectService } from "../src/main/projects/service";
import type { RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import { openTestStore, tempDir } from "./helpers/state";

const status: RuntimeStatus = {
  state: "disconnected",
  reason: "none",
  since: "2026-11-12T00:00:00.000Z",
  workspace: null,
  ownershipId: null,
  port: null,
  engine: null,
  external: false,
  restarts: 0,
  lastFailure: null,
  pendingRestartInMs: null,
};

describe("polish preferences", () => {
  it("starts conservative: generic notifications, no quiet hours, no login item", async () => {
    const { store } = await openTestStore();
    const prefs = new PolishPreferencesStore({ store, timeZone: () => "Europe/Berlin" });
    const value = await prefs.get();
    expect(value).toEqual(defaultPolishPreferences("Europe/Berlin"));
    expect(value.notifications.showDetails).toBe(false);
    expect(value.notifications.quietHours.enabled).toBe(false);
    expect(value.launchAtLogin).toBe(false);
    expect(value.keepAwakeDuringWork).toBe(false);
  });

  it("merges a patch without dropping unrelated values", async () => {
    const { store } = await openTestStore();
    const prefs = new PolishPreferencesStore({ store, timeZone: () => "UTC" });
    await prefs.update({ dockBadge: false });
    const value = await prefs.update({
      notifications: {
        enabled: true,
        completion: true,
        blocker: true,
        limit: true,
        showDetails: true,
        quietHours: { enabled: true, start: "21:30", end: "06:30", timeZone: "America/New_York" },
      },
      launchAtLogin: true,
    });
    expect(value.dockBadge).toBe(false);
    expect(value.notifications.showDetails).toBe(true);
    expect(value.notifications.quietHours).toEqual({
      enabled: true,
      start: "21:30",
      end: "06:30",
      timeZone: "America/New_York",
    });
    expect(value.launchAtLogin).toBe(true);
    expect((await prefs.get()).notifications.showDetails).toBe(true);
  });

  it("rejects an unknown zone instead of silently evaluating the wrong window", async () => {
    const { store } = await openTestStore();
    const prefs = new PolishPreferencesStore({ store, timeZone: () => "UTC" });
    await expect(
      prefs.update({
        notifications: {
          enabled: true,
          completion: true,
          blocker: true,
          limit: true,
          showDetails: false,
          quietHours: { enabled: true, start: "22:00", end: "07:00", timeZone: "Mars/Olympus" },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("stores prompt favorites as inert, bounded, validated text", async () => {
    const { store } = await openTestStore();
    let counter = 0;
    const prefs = new PolishPreferencesStore({
      store,
      timeZone: () => "UTC",
      newId: () => `fav_${(counter += 1).toString(16).padStart(8, "0")}`,
    });
    const first = await prefs.saveFavorite({ label: "Review", text: "Review the diff." });
    expect(first.label).toBe("Review");
    expect(await prefs.favorites()).toHaveLength(1);

    // Saving the same text again updates the label rather than duplicating.
    const updated = await prefs.saveFavorite({
      label: "Review carefully",
      text: "Review the diff.",
    });
    expect(updated.id).toBe(first.id);
    expect((await prefs.favorites())[0]?.label).toBe("Review carefully");

    for (let index = 0; index < 49; index += 1) {
      await prefs.saveFavorite({ label: `Prompt ${index}`, text: `Prompt body ${index}` });
    }
    expect(await prefs.favorites()).toHaveLength(50);
    await expect(
      prefs.saveFavorite({ label: "Overflow", text: "one too many" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await prefs.removeFavorite(first.id)).toEqual({ removed: true });
    expect(await prefs.removeFavorite(first.id)).toEqual({ removed: false });
    await expect(prefs.saveFavorite({ label: "", text: "x" })).rejects.toThrow();
    await expect(prefs.saveFavorite({ label: "x", text: "y", run: true })).rejects.toThrow();
  });

  it("normalizes project identity and rejects markup or unknown colors", () => {
    expect(normalizeIdentity({ accent: "mint", monogram: " ab " })).toEqual({
      accent: "mint",
      monogram: "AB",
    });
    expect(normalizeIdentity({ accent: null, monogram: "" })).toEqual({
      accent: null,
      monogram: null,
    });
    expect(() => normalizeIdentity({ accent: "neon", monogram: null })).toThrow(/accent/);
    expect(() => normalizeIdentity({ accent: null, monogram: "<b>" })).toThrow(/monogram/);
    expect(() => normalizeIdentity({ accent: null, monogram: "ABC" })).toThrow(/monogram/);
  });

  it("persists a per-project layout, including Focus Mode and density", async () => {
    const { store } = await openTestStore();
    const root = tempDir("mona-layout-project-");
    const projects = new ProjectService({
      store,
      status: () => status,
      chooseFolder: async () => null,
      reveal: () => undefined,
    });
    const opened = await projects.open(root);
    if (!opened) throw new Error("project was not opened");
    await projects.saveView(opened.project.id, {
      screen: "studio",
      inspectorTab: "context",
      studioMode: "plan",
      focusMode: true,
      density: "dense",
    });
    const detail = await projects.detail(opened.project.id);
    expect(detail.view).toMatchObject({
      screen: "studio",
      focusMode: true,
      density: "dense",
    });
  });
});
