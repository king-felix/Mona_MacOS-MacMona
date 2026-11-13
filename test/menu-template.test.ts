import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { applicationMenuTemplate } from "../src/main/menu-template";

function viewItems(developerTools: boolean): MenuItemConstructorOptions[] {
  const template = applicationMenuTemplate({ appName: "Mona", developerTools });
  const view = template.find((item) => item.label === "View");
  if (!view || !Array.isArray(view.submenu)) throw new Error("no View menu");
  return view.submenu as MenuItemConstructorOptions[];
}

describe("application menu zoom entries", () => {
  it("binds both the shifted plus key and the plain equals key", () => {
    const items = viewItems(false);
    const zoomIn = items.filter((item) => item.label === "Zoom In");
    expect(zoomIn.map((item) => item.accelerator)).toEqual(["CmdOrCtrl+Plus", "CmdOrCtrl+="]);
    // The equals alias stays out of the visible menu so Zoom In is not listed twice.
    expect(zoomIn.map((item) => item.visible)).toEqual([undefined, false]);
  });

  it("binds zoom out and actual size, matching what people press", () => {
    const items = viewItems(false);
    expect(items.find((item) => item.label === "Zoom Out")?.accelerator).toBe("CmdOrCtrl+-");
    expect(items.find((item) => item.label === "Actual Size")?.accelerator).toBe("CmdOrCtrl+0");
  });

  it("routes every zoom item to its handler", () => {
    const calls: string[] = [];
    const template = applicationMenuTemplate({
      appName: "Mona",
      developerTools: false,
      onZoomIn: () => calls.push("in"),
      onZoomOut: () => calls.push("out"),
      onZoomReset: () => calls.push("reset"),
    });
    const view = template.find((item) => item.label === "View");
    const items = view?.submenu as MenuItemConstructorOptions[];
    for (const item of items) {
      if (["Zoom In", "Zoom Out", "Actual Size"].includes(String(item.label))) {
        (item.click as () => void)?.();
      }
    }
    expect(calls).toEqual(["reset", "in", "in", "out"]);
  });

  it("only offers Developer Tools when the build enables them", () => {
    expect(viewItems(true).some((item) => item.role === "toggleDevTools")).toBe(true);
    expect(viewItems(false).some((item) => item.role === "toggleDevTools")).toBe(false);
  });
});
