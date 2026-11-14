// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SettingsScreen } from "../src/renderer/shell/Settings";
import type { ServiceStatus } from "../src/shared/contracts/open";
import { zoomView } from "../src/shared/zoom";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  // Settings mounts every tab, and some tabs read the bridge on mount. The stub
  // answers each API's documented "nothing here" shape rather than one invented
  // envelope: an `IpcResult` refusal is not a `ServiceStatus`, and handing a
  // component the wrong shape tests a contract the product never promised.
  const unavailable = async () => ({
    ok: false as const,
    error: { code: "UNAVAILABLE", message: "not available in this test" },
  });
  const notInstalled: ServiceStatus = {
    supported: true,
    installed: false,
    installPath: null,
    installPathDisplay: null,
    scope: null,
    registration: "unknown",
    enabled: "unknown",
    menuTitle: "Start new DS project with Mona",
    message: "not available in this test",
    appIdentity: "com.mona.workbench",
    packaged: false,
    lastHandoff: null,
    recovery: [],
    detail: [],
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
  const overrides: Record<string, () => Promise<unknown>> = {
    serviceStatus: async () => notInstalled,
    refreshService: async () => notInstalled,
  };
  Object.defineProperty(window, "mona", {
    writable: true,
    value: new Proxy(
      {},
      {
        get: (_target, property) => overrides[String(property)] ?? unavailable,
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

// Settings mounts every tab, and FinderIntegration and UpdateSettings read the
// bridge from an effect. Their promises settle one microtask *after* a
// synchronous `act()` returns, so a sync render leaves those state updates
// outside the act scope and React warns. Awaiting an async act flushes them
// inside it — the boundary moves, nothing is silenced.
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(onZoom: (factor: number) => void, factor = 1.25): Promise<void> {
  await act(async () => {
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
  await settle();
}

describe("interface scale control", () => {
  it("shows the current percentage from the main process", async () => {
    await render(() => undefined);
    const scale = container?.querySelector('[data-testid="settings-scale"]');
    expect(scale?.textContent).toContain("125%");
  });

  it("steps up and down one rung and can return to actual size", async () => {
    const requested: number[] = [];
    await render((factor) => requested.push(factor));

    const buttons = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[data-testid="settings-scale"] button') ?? [],
    );
    expect(buttons).toHaveLength(3);
    act(() => buttons[1]?.click()); // +
    act(() => buttons[0]?.click()); // −
    act(() => buttons[2]?.click()); // Actual size
    expect(requested).toEqual([1.5, 1.1, 1]);
  });

  it("disables the end stops instead of pretending they do something", async () => {
    await render(() => undefined, 2);
    const buttons = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[data-testid="settings-scale"] button') ?? [],
    );
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[0]?.disabled).toBe(false);
  });
});

describe("R06 decoration intensity", () => {
  it("offers Vivid and Quiet and reports the chosen one", async () => {
    const chosen: string[] = [];
    await act(async () => {
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
          intensity="quiet"
          zoom={null}
          onTheme={() => undefined}
          onDensity={() => undefined}
          onIntensity={(value) => chosen.push(value)}
          onZoom={() => undefined}
          polish={null}
          onPatchPreferences={() => undefined}
          onTestNotification={() => undefined}
          onQuit={() => undefined}
          onOpenStudio={() => undefined}
          openTab="appearance"
        />,
      );
    });
    await settle();
    const pressed = Array.from(container?.querySelectorAll('[aria-pressed="true"]') ?? []).map(
      (node) => (node.textContent ?? "").trim(),
    );
    expect(pressed).toContain("Quiet");
    const vivid = Array.from(container?.querySelectorAll("button") ?? []).find(
      (node) => (node.textContent ?? "").trim() === "Vivid",
    );
    act(() => vivid?.click());
    expect(chosen).toEqual(["vivid"]);
    // The hint must not promise a different design or lower contrast.
    expect(container?.textContent).toContain("same measured text colours");
  });
});
