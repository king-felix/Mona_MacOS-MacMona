import { describe, expect, it } from "vitest";
import { isAllowedNavigation, shouldQuitOnWindowAllClosed } from "../src/main/navigation";

const ROOT = "/Applications/Mona.app/Contents/Resources/app.asar/dist/renderer";

describe("navigation policy", () => {
  it("allows the local renderer document and its assets", () => {
    expect(isAllowedNavigation(`file://${ROOT}/index.html`, ROOT)).toBe(true);
    expect(isAllowedNavigation(`file://${ROOT}/assets/main-abc.js`, ROOT)).toBe(true);
  });

  it("refuses remote navigation", () => {
    expect(isAllowedNavigation("https://example.com/", ROOT)).toBe(false);
    expect(isAllowedNavigation("http://127.0.0.1:5173/", ROOT)).toBe(false);
    expect(isAllowedNavigation("javascript:alert(1)", ROOT)).toBe(false);
  });

  it("refuses local files outside the renderer root", () => {
    expect(isAllowedNavigation("file:///etc/passwd", ROOT)).toBe(false);
    expect(isAllowedNavigation(`file://${ROOT}-evil/index.html`, ROOT)).toBe(false);
    expect(isAllowedNavigation(`file://${ROOT}/../main/index.js`, ROOT)).toBe(false);
  });

  it("refuses a malformed URL", () => {
    expect(isAllowedNavigation("not a url", ROOT)).toBe(false);
    expect(isAllowedNavigation("", ROOT)).toBe(false);
  });
});

describe("close-versus-quit policy", () => {
  it("keeps the app alive when the last window closes on macOS", () => {
    expect(shouldQuitOnWindowAllClosed("darwin")).toBe(false);
  });

  it("quits on other platforms", () => {
    expect(shouldQuitOnWindowAllClosed("win32")).toBe(true);
    expect(shouldQuitOnWindowAllClosed("linux")).toBe(true);
  });
});
