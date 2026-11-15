// @vitest-environment jsdom
import { act, useState, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { emptyStudioUsageView } from "../src/shared/contracts/usage-hud";
import type { WindowFullscreenView } from "../src/shared/contracts/bridge";
import { StudioScreen } from "../src/renderer/shell/Studio";

/**
 * R05 at the component boundary: the immersive layout, the observed-state
 * fullscreen control, and the bounded composer. The full screen *transition*
 * is Electron's and is proven by the real-window smoke; here the rule is that
 * the UI follows the view it was handed and never the request it made.
 */

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
});

function detail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    project: {
      id: "prj_0123456789abcdef",
      name: "Studio project",
      rootPath: "/Users/example/projects/studio",
      canonicalPath: "/Users/example/projects/studio",
      repositoryKind: "none",
      repositoryRoot: null,
      worktreeName: null,
      accent: null,
      monogram: null,
      archived: false,
      pinned: false,
      removedAt: null,
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
      revision: 1,
    },
    tasks: [],
    dependencies: [],
    threads: [],
    currentThreadId: "thr_0123456789abcdef",
    draft: null,
    events: [],
    history: { olderCursor: null, hasMore: false, storedTotal: 0, pageSize: 0 },
    usage: {
      turns: 2,
      inputTokens: 1234,
      outputTokens: 340,
      cachedTokens: 96,
      reasoningTokens: 0,
      costUsd: 0.0012,
      costComplete: true,
      observed: true,
      byModel: [],
    },
    evidence: [],
    view: null,
    branch: "main",
    engine: {
      state: "connected",
      reason: "connected",
      owned: true,
      external: false,
      workspace: "/Users/example/projects/studio",
      port: 51234,
      engineVersion: "0.10.2",
      engineCommit: "ff466b2ed0bf",
      executable: "/opt/codewhale",
      executablePresent: true,
      canExecute: true,
      blockedReason: null,
      binding: null,
    },
    ...overrides,
  };
}

function studio(overrides: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return {
    projectId: "prj_0123456789abcdef",
    connection: {
      state: "connected",
      reason: "authenticated loopback runtime is ready",
      since: "2026-11-11T00:00:00.000Z",
      port: 51234,
      engine: { version: "0.10.2", commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e" },
      owned: true,
      external: false,
      lastEventAt: null,
      silentForMs: null,
      missing: [],
    },
    threadId: "thr_0123456789abcdef",
    engineThreadId: "thr_engine_0123456789abcdef",
    activeTurnId: null,
    lastMode: "work",
    pauseAfterTask: false,
    queued: 0,
    profile: {
      provider: "deepseek",
      exactId: null,
      model: "deepseek-flash",
      reasoningEffort: null,
      permissionPosture: "full_access",
      autoApprove: true,
      trustMode: true,
      allowShell: true,
      source: "configured",
      effective: {
        provider: "deepseek",
        model: "deepseek-flash",
        permissionPosture: "full_access",
        usedFallback: false,
      },
      effectiveTurnId: "turn_0123456789abcdef",
    },
    cost: {
      observed: true,
      costUsd: 0.0012,
      costComplete: true,
      turns: 2,
      label: "$0.0012 across 2 turns",
    },
    submission: null,
    diagnostics: [],
    followUps: [],
    steering: { available: false, reason: "test fixture: no steer route", requiredRoute: null },
    usage: emptyStudioUsageView(),
    pendingRequests: [],
    canSubmit: true,
    cannotSubmitReason: null,
    controls: { canInterrupt: false, canPause: true, canCancelQueued: false, canStop: true },
    ...overrides,
  };
}

const WINDOWED: WindowFullscreenView = {
  fullscreen: false,
  pending: false,
  available: true,
  epoch: 0,
};

function render(
  props: Partial<Parameters<typeof StudioScreen>[0]> = {},
  options: { detail?: Partial<ProjectDetail>; studio?: Partial<StudioSnapshot> } = {},
): void {
  act(() => {
    root?.render(
      <StudioScreen
        detail={detail(options.detail)}
        studio={studio(options.studio)}
        studioBusy={false}
        mode="work"
        draft=""
        draftStatus="idle"
        inspectorTab="task"
        onInspectorTab={() => undefined}
        onDraft={() => undefined}
        onMode={() => undefined}
        onOpenFolder={() => undefined}
        onShowBoard={() => undefined}
        onStart={() => undefined}
        onSubmit={() => undefined}
        onInterrupt={() => undefined}
        onPause={() => undefined}
        onResumeQueue={() => undefined}
        onCancelQueued={() => undefined}
        onStop={() => undefined}
        onReconcile={() => undefined}
        focusMode={false}
        favorites={[]}
        onToggleFocus={() => undefined}
        onUseFavorite={() => undefined}
        onRequestSaveFavorite={() => undefined}
        onRemoveFavorite={() => undefined}
        {...props}
      />,
    );
  });
}

function button(testId: string): HTMLButtonElement {
  const element = container!.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`${testId} is not rendered`);
  return element;
}

function grip(): HTMLElement {
  const element = container!.querySelector<HTMLElement>('[data-testid="composer-grip"]');
  if (!element) throw new Error("composer grip is not rendered");
  return element;
}

function key(element: HTMLElement, name: string, shift = false): void {
  act(() => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, shiftKey: shift, bubbles: true, cancelable: true }),
    );
  });
}

describe("Focus Studio dashboard", () => {
  it("keeps identity, honest activity, elapsed, model and scoped spend in one bar", () => {
    render({ focusMode: true, windowFullscreen: WINDOWED });
    const bar = container!.querySelector('[data-testid="studio-focus-bar"]');
    expect(bar).not.toBeNull();
    const text = bar?.textContent ?? "";
    expect(text).toContain("Studio project");
    expect(text).toContain("STUDIO");
    expect(container!.querySelector('[data-testid="agent-signal"]')?.textContent).toContain(
      "Ready for your next idea",
    );
    // Elapsed comes from the snapshot's own `since`, never from a guess.
    expect(container!.querySelector('[data-testid="focus-elapsed"]')?.textContent).toMatch(
      /\d+[smh:]/,
    );
    expect(container!.querySelector('[data-testid="focus-model"]')?.textContent).toContain(
      "deepseek-flash",
    );
    expect(container!.querySelector('[data-testid="focus-cost"]')?.textContent).toContain(
      "$0.0012",
    );
    expect(container!.querySelector('[data-testid="focus-tokens"]')?.textContent).toContain(
      "1.2K in",
    );
    // The ordinary context bar is still in the tree but the layout class is
    // what hides it, so a capture can prove it takes no space.
    expect(container!.querySelector(".screen--studio-focus")).not.toBeNull();
  });

  it("labels the elapsed clock by the state it measures", () => {
    render(
      {
        focusMode: true,
        windowFullscreen: WINDOWED,
      },
      {
        studio: {
          connection: { ...studio().connection, state: "running" },
          activeTurnId: "turn_1",
        },
      },
    );
    const elapsed = container!.querySelector('[data-testid="focus-elapsed"]');
    expect(elapsed?.textContent).toContain("Turn");
    expect(container!.querySelector('[data-testid="agent-signal"]')?.textContent).toContain(
      "Waiting · no recent activity",
    );
  });

  it("keeps pause and interrupt reachable and disabled only when the engine says so", () => {
    const onPause = vi.fn();
    const onInterrupt = vi.fn();
    render({ focusMode: true, windowFullscreen: WINDOWED, onPause, onInterrupt });
    const pause = Array.from(container!.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Pause after task",
    );
    const interrupt = Array.from(container!.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Interrupt now",
    );
    expect(pause?.disabled).toBe(false);
    // No active turn: interrupt is visibly unavailable rather than silently dead.
    expect(interrupt?.disabled).toBe(true);
    act(() => pause?.click());
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("offers Start engine in the bar when no runtime is attached", () => {
    render(
      { focusMode: true, windowFullscreen: WINDOWED },
      { studio: { connection: { ...studio().connection, state: "not_started" } } },
    );
    // Secondary engine control: inside the on-demand panel that the bar opens.
    const more = container!.querySelector('[data-testid="composer-more"]') as HTMLElement | null;
    expect(more).not.toBeNull();
    expect(more!.closest(".composer__command-bar")).not.toBeNull();
    act(() => more!.click());
    const start = Array.from(container!.querySelectorAll("button")).find(
      (node) => node.textContent?.trim() === "Start engine",
    );
    expect(start).toBeDefined();
    expect(start?.disabled).toBe(false);
  });

  it("puts execution controls above the prompt and leaves exact totals in telemetry", () => {
    render({ focusMode: true, windowFullscreen: WINDOWED });
    const drawer = container!.querySelector(".focus-bar__drawer");
    const controls = container!.querySelector(".composer__command-bar");
    // The primary controls are always in the bar; the secondary ones are one
    // disclosure away, still above the prompt and still real.
    expect(controls?.textContent).toContain("Submit");
    expect(controls?.textContent).toContain("Interrupt now");
    act(() =>
      (controls?.querySelector('[data-testid="composer-more"]') as HTMLElement | null)?.click(),
    );
    const panel = controls?.querySelector(".composer__utilities");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("Stop engine");
    expect(panel?.textContent).toContain("Cancel queued");
    expect(panel?.textContent).toContain("Needs the Human");
    const prompt = container!.querySelector("textarea")!;
    expect(
      controls!.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container!.querySelector(".studio__inspector")).toBeNull();
    expect(container!.querySelector(".control-strip")).toBeNull();
    expect(drawer?.textContent).toContain("project totals from stored turn receipts");
  });
});

describe("native full screen control", () => {
  it("shows the observed state, not the request", () => {
    render({ focusMode: true, windowFullscreen: WINDOWED });
    const control = button("focus-fullscreen");
    expect(control.getAttribute("aria-label")).toBe("Enter Full Screen");
    expect(control.getAttribute("aria-pressed")).toBe("false");
    expect(control.disabled).toBe(false);

    render({
      focusMode: true,
      windowFullscreen: { fullscreen: true, pending: false, available: true, epoch: 1 },
    });
    expect(button("focus-fullscreen").getAttribute("aria-label")).toBe("Exit Full Screen");
    expect(button("focus-fullscreen").getAttribute("aria-pressed")).toBe("true");
  });

  it("says it is waiting instead of claiming the transition happened", () => {
    const onToggleFullscreen = vi.fn();
    render({
      focusMode: true,
      onToggleFullscreen,
      windowFullscreen: { fullscreen: false, pending: true, available: true, epoch: 0 },
    });
    const control = button("focus-fullscreen");
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.getAttribute("aria-label")).toBe("Enter Full Screen");
    act(() => control.click());
    expect(onToggleFullscreen).not.toHaveBeenCalled();
    expect(
      container!.querySelector('[data-testid="focus-fullscreen-state"]')?.textContent,
    ).toContain("waiting for macOS");
  });

  it("offers Enter Full Screen from the ordinary Studio too", () => {
    const onToggleFullscreen = vi.fn();
    render({ focusMode: false, windowFullscreen: WINDOWED, onToggleFullscreen });
    const control = button("focus-fullscreen");
    expect(control.getAttribute("aria-label")).toBe("Enter Full Screen");
    expect(control.disabled).toBe(false);
    act(() => control.click());
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
    // Both layouts share one dashboard and one native fullscreen control.
    expect(container!.querySelectorAll('[data-testid="focus-fullscreen"]')).toHaveLength(1);
  });

  it("is unavailable rather than pretending off-macOS", () => {
    render({
      focusMode: true,
      windowFullscreen: { fullscreen: false, pending: false, available: false, epoch: 0 },
    });
    expect(button("focus-fullscreen").disabled).toBe(true);
    expect(
      container!.querySelector('[data-testid="focus-fullscreen-state"]')?.textContent,
    ).toContain("unavailable");
  });

  it("only offers the exit control for a stored focus preference", () => {
    render({
      focusMode: true,
      focusPreference: false,
      windowFullscreen: { ...WINDOWED, fullscreen: true, epoch: 1 },
    });
    expect(button("focus-exit").disabled).toBe(true);
    expect(container!.querySelector(".focus-bar__drawer")?.textContent).toContain(
      "stored preference is off",
    );
    render({ focusMode: true, focusPreference: true, windowFullscreen: WINDOWED });
    expect(button("focus-exit").disabled).toBe(false);
    expect(container!.querySelector(".focus-bar__drawer")?.textContent).toContain(
      "Focus Studio preference on",
    );
  });

  it("does not offer to turn off a preference that is not what holds the layout", () => {
    // In full screen the layout would stay even if the preference went off, so
    // the control is disabled rather than silently doing nothing.
    render({
      focusMode: true,
      focusPreference: true,
      windowFullscreen: { fullscreen: true, pending: false, available: true, epoch: 1 },
    });
    const exit = button("focus-exit");
    expect(exit.disabled).toBe(true);
    expect(exit.getAttribute("title")).toContain("Leave full screen first");
  });
});

describe("bounded resizable composer", () => {
  it("is present in every layout (R10 widened it) and describes itself", () => {
    // R05 shipped the grip inside the immersive layout only. R10 makes the
    // composer resizable where it is actually used, so the same control is now
    // rendered in the ordinary Studio too — a deliberate, tested change rather
    // than a regression of the R05 rule.
    render({ focusMode: false });
    expect(container!.querySelector('[data-testid="composer-grip"]')).not.toBeNull();
    expect(grip().getAttribute("role")).toBe("separator");
    expect(grip().getAttribute("aria-orientation")).toBe("horizontal");
    render({ focusMode: true, windowFullscreen: WINDOWED });
    expect(grip()).not.toBeNull();
  });

  it("resizes from the keyboard and stops at its bounds", () => {
    render({ focusMode: true, windowFullscreen: WINDOWED });
    const textarea = container!.querySelector("textarea")!;
    key(grip(), "ArrowUp");
    const grown = Number.parseInt(textarea.style.height, 10);
    expect(grown).toBeGreaterThan(0);
    key(grip(), "ArrowDown");
    expect(Number.parseInt(textarea.style.height, 10)).toBeLessThan(grown);
    key(grip(), "End");
    const top = Number.parseInt(textarea.style.height, 10);
    for (let index = 0; index < 12; index += 1) key(grip(), "ArrowUp", true);
    expect(Number.parseInt(textarea.style.height, 10)).toBe(top);
    key(grip(), "Home");
    const bottom = Number.parseInt(textarea.style.height, 10);
    for (let index = 0; index < 12; index += 1) key(grip(), "ArrowDown", true);
    expect(Number.parseInt(textarea.style.height, 10)).toBe(bottom);
    expect(bottom).toBeLessThan(top);
  });

  it("resizes from a pointer drag", () => {
    render({ focusMode: true, windowFullscreen: WINDOWED });
    const textarea = container!.querySelector("textarea")!;
    act(() => {
      grip().dispatchEvent(
        new MouseEvent("pointerdown", { clientY: 400, bubbles: true, cancelable: true }),
      );
    });
    const start = Number.parseInt(textarea.style.height, 10);
    act(() => {
      grip().dispatchEvent(new MouseEvent("pointermove", { clientY: 340, bubbles: true }));
    });
    expect(Number.parseInt(textarea.style.height, 10)).toBeGreaterThan(start);
    act(() => {
      grip().dispatchEvent(new MouseEvent("pointerup", { clientY: 340, bubbles: true }));
    });
    // A pointer that moves after release must not keep resizing.
    const released = Number.parseInt(textarea.style.height, 10);
    act(() => {
      grip().dispatchEvent(new MouseEvent("pointermove", { clientY: 100, bubbles: true }));
    });
    expect(Number.parseInt(textarea.style.height, 10)).toBe(released);
  });
});

describe("no remount on a layout change", () => {
  it("keeps the composer element, its text and its selection", () => {
    function Harness(): JSX.Element {
      const [focus, setFocus] = useState(false);
      const [draft, setDraft] = useState("keep this text");
      return (
        <>
          <button type="button" data-testid="flip" onClick={() => setFocus((value) => !value)}>
            flip
          </button>
          <StudioScreen
            detail={detail()}
            studio={studio()}
            studioBusy={false}
            mode="work"
            draft={draft}
            draftStatus="saved"
            inspectorTab="task"
            onInspectorTab={() => undefined}
            onDraft={(value) => setDraft(value)}
            onMode={() => undefined}
            onOpenFolder={() => undefined}
            onShowBoard={() => undefined}
            onStart={() => undefined}
            onSubmit={() => undefined}
            onInterrupt={() => undefined}
            onPause={() => undefined}
            onResumeQueue={() => undefined}
            onCancelQueued={() => undefined}
            onStop={() => undefined}
            onReconcile={() => undefined}
            focusMode={focus}
            focusPreference={focus}
            windowFullscreen={WINDOWED}
            favorites={[]}
            onToggleFocus={() => setFocus((value) => !value)}
            onUseFavorite={() => undefined}
            onRequestSaveFavorite={() => undefined}
            onRemoveFavorite={() => undefined}
          />
        </>
      );
    }
    act(() => root!.render(<Harness />));
    const textarea = container!.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(5, 9);
    act(() => {
      container!.querySelector<HTMLButtonElement>('[data-testid="flip"]')!.click();
    });
    expect(container!.querySelector(".screen--studio-focus")).not.toBeNull();
    const after = container!.querySelector("textarea");
    // The same DOM node: a focus flip changes props, not identity.
    expect(after).toBe(textarea);
    expect(after?.value).toBe("keep this text");
    expect(after?.selectionStart).toBe(5);
    expect(after?.selectionEnd).toBe(9);
    expect(document.activeElement).toBe(textarea);
  });
});
