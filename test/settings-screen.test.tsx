// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SettingsScreen } from "../src/renderer/shell/Settings";
import { zoomView } from "../src/shared/zoom";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // Settings mounts every tab, and some tabs read the bridge on mount. A stub
  // that answers "unavailable" keeps this test about the scale control.
  const unavailable = async () => ({
    ok: false as const,
    error: { code: "UNAVAILABLE", message: "not available in this test" },
  });
  Object.defineProperty(window, "mona", {
    writable: true,
    value: new Proxy(
      {},
      {
        get: () => unavailable,
      },
    ),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(onZoom: (factor: number) => void, factor = 1.25): void {
  act(() => {
    root?.render(
      <SettingsScreen
        app={null}
        paths={null}
        facts={null}
        runtime={null}
        detail={null}
        tools={[]}
        theme="daybreak"
        density="comfortable"
        zoom={zoomView(factor)}
        onTheme={() => undefined}
        onDensity={() => undefined}
        onZoom={onZoom}
        polish={null}
        onPatchPreferences={() => undefined}
        onTestNotification={() => undefined}
        onQuit={() => undefined}
        onOpenStudio={() => undefined}
        openTab="appearance"
      />,
    );
  });
}

describe("interface scale control", () => {
  it("shows the current percentage from the main process", () => {
    render(() => undefined);
    const scale = container?.querySelector('[data-testid="settings-scale"]');
    expect(scale?.textContent).toContain("125%");
  });

  it("steps up and down one rung and can return to actual size", () => {
    const requested: number[] = [];
    render((factor) => requested.push(factor));

    const buttons = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[data-testid="settings-scale"] button') ?? [],
    );
    expect(buttons).toHaveLength(3);
    act(() => buttons[1]?.click()); // +
    act(() => buttons[0]?.click()); // −
    act(() => buttons[2]?.click()); // Actual size
    expect(requested).toEqual([1.5, 1.1, 1]);
  });

  it("disables the end stops instead of pretending they do something", () => {
    render(() => undefined, 2);
    const buttons = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[data-testid="settings-scale"] button') ?? [],
    );
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[0]?.disabled).toBe(false);
  });
});
