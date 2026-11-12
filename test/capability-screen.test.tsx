// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityRowView, CapabilitySnapshot } from "../src/shared/contracts/capability";
import { CapabilitiesScreen } from "../src/renderer/shell/Capabilities";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

const row = (overrides: Partial<CapabilityRowView>): CapabilityRowView => ({
  id: "MONA-CAP-001",
  name: "run",
  description: "Run an interactive or non-interactive task",
  scope: "cli",
  upstreamSource: "codewhale-hq/Codewhale@v0.10.2",
  upstreamVersion: "0.10.2",
  platform: "macOS 26.5.1, arm64 (native)",
  classification: "write",
  permission: "ask/full-access per profile",
  cost: "May call the model once per turn.",
  arguments: "none",
  invocation: "codewhale run",
  helpSource: "codewhale run --help",
  integration: "integrated_terminal",
  entryPoint: { kind: "terminal", target: "shell", label: "Terminal · shell", tested: true },
  uiLocation: "Terminal · shell",
  tests: "P18 terminal smoke",
  status: "unqualified",
  gap: "The TUI runs in the integrated terminal.",
  evidence: [],
  ...overrides,
});

function snapshot(): CapabilitySnapshot {
  const rows = [
    row({}),
    row({
      id: "MONA-CAP-018",
      name: "workflow",
      description: "Run checked-in Workflows",
      classification: "write",
      integration: "blocked_gap",
      entryPoint: { kind: "none", target: null, label: "No in-app route", tested: false },
      status: "blocked_gap",
      gap: "No /v1/workflow route exists on the pinned build.",
      invocation: "codewhale workflow",
    }),
    row({
      id: "MONA-CAP-002",
      name: "doctor",
      description: "Run Codewhale diagnostics",
      classification: "read",
      integration: "native_view",
      entryPoint: {
        kind: "settings_tab",
        target: "route",
        label: "Settings › Providers & route",
        tested: true,
      },
      status: "verified",
      gap: null,
      invocation: "codewhale doctor --json",
    }),
  ];
  return {
    source: "live",
    unavailableReason: "Required gaps remain; full parity is not claimed.",
    inventoryPath: "docs/codewhale-capabilities-macos.json",
    loadedAt: "2026-11-12T10:00:00.000Z",
    rows,
    coverage: {
      rowsTotal: rows.length,
      verified: 1,
      unqualified: 1,
      unavailable: 0,
      blockedGaps: 1,
      withEntryPoint: 2,
      testedEntryPoint: 2,
      byEntryKind: { terminal: 1, settings_tab: 1, none: 1 },
      terminalOnly: 1,
      nativeControls: 1,
      advancedActions: 0,
      complete: false,
      gaps: rows
        .filter((entry) => entry.status !== "verified")
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          status: entry.status,
          reason: entry.gap ?? "",
        })),
      summary: "3 rows",
    },
    drift: {
      checked: true,
      checkedAt: "2026-11-12T10:00:00.000Z",
      error: null,
      engineVersion: "0.10.2",
      engineCommit: "ff466b2ed0bf",
      inventoryVersion: "0.10.2",
      inventoryCommit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e",
      versionMatch: true,
      commitMatch: true,
      additions: [],
      removals: [],
      note: "The installed engine matches the recorded surface.",
    },
    engineCapabilities: null,
    features: [{ name: "shell_tool", stage: "stable", enabled: true }],
    notes: [],
  };
}

function installBridge(value: CapabilitySnapshot) {
  const bridge = {
    capabilitySnapshot: vi.fn(async () => ({ ok: true, value })),
    refreshCapabilities: vi.fn(async () => ({ ok: true, value })),
    capabilityReport: vi.fn(async () => ({
      ok: true,
      value: { json: "{}", markdown: "# Mona capability coverage\n", filename: "coverage" },
    })),
  };
  (globalThis as unknown as { window: { mona: unknown } }).window.mona = bridge;
  return bridge;
}

async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    });
  }
}

describe("CapabilitiesScreen", () => {
  it("shows computed coverage and refuses to claim parity", async () => {
    installBridge(snapshot());
    act(() =>
      root!.render(
        <CapabilitiesScreen onOpenEntry={() => undefined} onTerminal={() => undefined} />,
      ),
    );
    await settle();
    const summary =
      container!.querySelector('[data-testid="capability-summary"]')?.textContent ?? "";
    expect(summary).toContain("3");
    expect(summary).toContain("blocked gaps");
    expect(container!.querySelector('[data-testid="capability-verdict"]')?.textContent).toContain(
      "Full parity is not claimed",
    );
    expect(container!.querySelector('[data-testid="capability-count"]')?.textContent).toContain(
      "3 of 3 rows",
    );
  });

  it("lists every row, including the blocked one, and filters by status", async () => {
    installBridge(snapshot());
    act(() =>
      root!.render(
        <CapabilitiesScreen onOpenEntry={() => undefined} onTerminal={() => undefined} />,
      ),
    );
    await settle();
    expect(container!.querySelectorAll(".capability-row")).toHaveLength(3);
    const select = container!.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by status"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    act(() => {
      setter?.call(select, "blocked_gap");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container!.querySelectorAll(".capability-row")).toHaveLength(1);
    expect(container!.textContent).toContain("workflow");
  });

  it("shows the exact route, cost class, and gap in the row detail", async () => {
    installBridge(snapshot());
    act(() =>
      root!.render(
        <CapabilitiesScreen onOpenEntry={() => undefined} onTerminal={() => undefined} />,
      ),
    );
    await settle();
    const blocked = [...container!.querySelectorAll<HTMLButtonElement>(".capability-row")].find(
      (button) => button.textContent?.includes("workflow"),
    );
    act(() => blocked!.click());
    const detail = container!.querySelector('[data-testid="capability-detail"]')?.textContent ?? "";
    expect(detail).toContain("codewhale workflow");
    expect(detail).toContain("No /v1/workflow route exists");
    expect(detail).toContain("No in-app route for this row");
  });

  it("opens a terminal route by prefilling the command, never by running it", async () => {
    installBridge(snapshot());
    const onTerminal = vi.fn();
    const onOpenEntry = vi.fn();
    act(() =>
      root!.render(<CapabilitiesScreen onOpenEntry={onOpenEntry} onTerminal={onTerminal} />),
    );
    await settle();
    const runRow = [...container!.querySelectorAll<HTMLButtonElement>(".capability-row")].find(
      (button) => button.textContent?.includes("run"),
    );
    act(() => runRow!.click());
    const action = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Open terminal with the command"),
    );
    act(() => action!.click());
    expect(onTerminal).toHaveBeenCalledWith("codewhale run");
    expect(onOpenEntry).not.toHaveBeenCalled();
  });

  it("navigates a native-view row to its settings tab", async () => {
    installBridge(snapshot());
    const onOpenEntry = vi.fn();
    act(() =>
      root!.render(<CapabilitiesScreen onOpenEntry={onOpenEntry} onTerminal={() => undefined} />),
    );
    await settle();
    const doctorRow = [...container!.querySelectorAll<HTMLButtonElement>(".capability-row")].find(
      (button) => button.textContent?.includes("doctor"),
    );
    act(() => doctorRow!.click());
    const action = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Open Settings › Providers & route"),
    );
    act(() => action!.click());
    expect(onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "settings_tab", target: "route", rowId: "MONA-CAP-002" }),
    );
  });

  it("shows drift and feature flags from the probe", async () => {
    installBridge(snapshot());
    act(() =>
      root!.render(
        <CapabilitiesScreen onOpenEntry={() => undefined} onTerminal={() => undefined} />,
      ),
    );
    await settle();
    expect(container!.textContent).toContain("matches the inventory");
    expect(container!.querySelector('[data-testid="feature-flags"]')?.textContent).toContain(
      "shell_tool",
    );
  });
});
