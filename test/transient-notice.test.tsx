// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientNotice } from "../src/renderer/shell/TransientNotice";
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
function tick(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}
describe("routine notices", () => {
  it("fades at five seconds and dismisses without shifting focus", () => {
    const dismiss = vi.fn();
    act(() => root.render(<TransientNotice title="Copied" tone="success" onDismiss={dismiss} />));
    tick(4999);
    expect(dismiss).not.toHaveBeenCalled();
    tick(1);
    expect(host.querySelector(".toast--leaving")).not.toBeNull();
    tick(180);
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it("pauses the remaining budget while keyboard focus is inside", () => {
    const dismiss = vi.fn();
    act(() => root.render(<TransientNotice title="Copied" tone="success" onDismiss={dismiss} />));
    tick(3000);
    act(() => host.querySelector("button")!.focus());
    tick(10000);
    expect(dismiss).not.toHaveBeenCalled();
    act(() => host.querySelector("button")!.blur());
    tick(2000);
    tick(180);
    expect(dismiss).toHaveBeenCalledOnce();
  });
  it("gives a replacement notice its own full timeout and cancels on unmount", () => {
    const dismiss = vi.fn();
    act(() => root.render(<TransientNotice title="First" tone="success" onDismiss={dismiss} />));
    tick(4000);
    act(() => root.render(<TransientNotice title="Second" tone="success" onDismiss={dismiss} />));
    tick(4500);
    expect(dismiss).not.toHaveBeenCalled();
    act(() => root.render(null));
    tick(1000);
    expect(dismiss).not.toHaveBeenCalled();
  });
  it("keeps attention and errors until acknowledged", () => {
    const dismiss = vi.fn();
    act(() =>
      root.render(
        <TransientNotice title="Submission outcome unknown" tone="attention" onDismiss={dismiss} />,
      ),
    );
    tick(60000);
    expect(dismiss).not.toHaveBeenCalled();
    act(() => host.querySelector("button")!.click());
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
