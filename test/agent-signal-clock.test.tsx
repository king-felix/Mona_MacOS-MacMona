// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSignal } from "../src/renderer/shell/AgentSignal";
import { studioSnapshot } from "./helpers/studio-fixtures";
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function render() {
  const studio = studioSnapshot();
  studio.activeTurnId = "turn-live";
  studio.connection = {
    ...studio.connection,
    state: "running",
    since: new Date().toISOString(),
    lastEventAt: new Date().toISOString(),
  };
  act(() => root.render(<AgentSignal studio={studio} events={[]} />));
}
describe("silent agent clock", () => {
  it("shows loss of recent activity even when no snapshot arrives", () => {
    render();
    expect(host.textContent).toContain("Waiting on agent");
    act(() => vi.advanceTimersByTime(46_000));
    expect(host.textContent).toContain("Waiting · no recent activity");
    expect(host.textContent).toContain("46s ago");
    expect(host.firstElementChild?.getAttribute("data-animated")).toBe("false");
  });
  it("stops the timer and motion while hidden, then recalculates on return", () => {
    render();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(vi.getTimerCount()).toBe(0);
    expect(host.firstElementChild?.getAttribute("data-animated")).toBe("false");
    act(() => vi.advanceTimersByTime(60_000));
    hidden.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(host.textContent).toContain("Waiting · no recent activity");
  });
  it("cleans up its timer on unmount", () => {
    render();
    expect(vi.getTimerCount()).toBe(1);
    act(() => root.render(null));
    expect(vi.getTimerCount()).toBe(0);
  });
});
