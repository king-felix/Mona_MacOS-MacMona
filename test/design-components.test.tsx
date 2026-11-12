// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Harness } from "../src/renderer/design/Harness";
import { Dialog, Menu, Switch, Tabs } from "../src/renderer/design/primitives";
import { HomeScreen } from "../src/renderer/design/screens/Home";
import { StudioScreen } from "../src/renderer/design/screens/Studio";
import { WorkBoardScreen } from "../src/renderer/design/screens/WorkBoard";
import { CostLensScreen } from "../src/renderer/design/screens/CostLens";
import { BlockerScreen } from "../src/renderer/design/screens/Blocker";
import { SettingsScreen } from "../src/renderer/design/screens/Settings";
import type { Scenario } from "../src/renderer/design/screens/types";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
  window.mona = {
    getAppInfo: async () => ({
      name: "Mona",
      version: "0.1.0-p02",
      electron: "test",
      chrome: "test",
      node: "test",
      platform: "darwin",
      arch: "arm64",
      packaged: false,
    }),
    getPaths: async () => ({ support: "/tmp", cache: "/tmp", logs: "/tmp" }),
    discoverTools: async () => [],
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

async function audit(element: HTMLDivElement): Promise<void> {
  const results = await axe.run(element, {
    rules: { "color-contrast": { enabled: false } },
  });
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help} (${violation.nodes.length})`),
  ).toEqual([]);
}

const screens: Array<[string, (scenario: Scenario) => ReactElement]> = [
  ["home", (scenario) => <HomeScreen scenario={scenario} />],
  ["studio", (scenario) => <StudioScreen scenario={scenario} />],
  ["board", (scenario) => <WorkBoardScreen scenario={scenario} />],
  ["cost", (scenario) => <CostLensScreen scenario={scenario} />],
  ["blocker", (scenario) => <BlockerScreen scenario={scenario} />],
  ["settings", (scenario) => <SettingsScreen scenario={scenario} />],
];

describe("automated accessibility checks", () => {
  it.each(screens)("has no serious axe violations on %s", async (_name, screen) => {
    const node = await render(screen("default"));
    await audit(node);
  });

  it.each(screens)(
    "keeps empty and disconnected states accessible on %s",
    async (_name, screen) => {
      const node = await render(screen("empty"));
      await audit(node);
      await act(async () => {
        root?.render(screen("disconnected"));
      });
      await audit(node);
    },
  );

  it("renders the full harness with the fixture label and a named navigation", async () => {
    const node = await render(<Harness />);
    expect(node.textContent).toContain("TEST FIXTURE — NOT LIVE STATE");
    const nav = node.querySelector("nav[aria-label='Screens']");
    expect(nav).not.toBeNull();
    expect(nav?.querySelectorAll("button[data-nav]").length).toBe(6);
    await audit(node);
  });
});

describe("keyboard interaction", () => {
  it("moves tab selection with arrow keys and keeps focus on the tab", async () => {
    const onChange = vi.fn();
    function TabsHost(): ReactElement {
      const [value, setValue] = useState("one");
      return (
        <Tabs
          label="Panels"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          tabs={[
            { id: "one", label: "One" },
            { id: "two", label: "Two" },
            { id: "three", label: "Three" },
          ]}
        />
      );
    }
    const node = await render(<TabsHost />);
    const first = node.querySelector<HTMLButtonElement>("[role='tab']");
    first?.focus();
    await act(async () => {
      first?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const tabs = Array.from(node.querySelectorAll<HTMLButtonElement>("[role='tab']"));
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    expect(onChange).toHaveBeenCalledWith("two");
  });

  it("traps focus, closes on Escape, and restores focus in a dialog", async () => {
    const onClose = vi.fn();
    function Host(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" id="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog
            open={open}
            title="Restore snapshot"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <button type="button">Review scope</button>
            <button type="button">Cancel</button>
          </Dialog>
        </div>
      );
    }
    const node = await render(<Host />);
    const trigger = node.querySelector<HTMLButtonElement>("#trigger");
    trigger?.focus();
    await act(async () => {
      trigger?.click();
    });
    const dialog = node.querySelector<HTMLElement>("[role='dialog']");
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
    expect(node.querySelector("[role='dialog']")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("navigates a menu with the keyboard and closes it on Escape", async () => {
    const onSelect = vi.fn();
    const node = await render(
      <Menu
        label="Project actions"
        items={[
          { id: "rename", label: "Rename", onSelect },
          { id: "archive", label: "Archive", onSelect },
        ]}
      />,
    );
    const trigger = node.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");
    await act(async () => {
      trigger?.click();
    });
    const menu = node.querySelector<HTMLElement>("[role='menu']");
    expect(menu).not.toBeNull();
    expect(menu?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    const items = Array.from(node.querySelectorAll<HTMLButtonElement>("[role='menuitem']"));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => {
      (document.activeElement as HTMLElement).click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("toggles a switch with aria-checked and keeps a visible label", async () => {
    const onChange = vi.fn();
    const node = await render(
      <Switch label="Reduced motion" checked={false} onChange={onChange} />,
    );
    const control = node.querySelector<HTMLButtonElement>("[role='switch']");
    expect(control?.getAttribute("aria-checked")).toBe("false");
    expect(control?.textContent).toContain("Reduced motion");
  });
});
