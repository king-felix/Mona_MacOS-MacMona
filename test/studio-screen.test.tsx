// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { StudioScreen } from "../src/renderer/shell/Studio";

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

function detail(events: ProjectDetail["events"] = []): ProjectDetail {
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
    draft: null,
    events,
    usage: {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      costComplete: false,
      observed: false,
      byModel: [],
    },
    evidence: [],
    view: null,
    branch: null,
    engine: {
      state: "disconnected",
      reason: "not_started",
      owned: false,
      external: false,
      workspace: null,
      port: null,
      engineVersion: null,
      engineCommit: null,
      executable: null,
      executablePresent: false,
      canExecute: false,
      blockedReason: "No runtime is bound to this project yet.",
      binding: null,
    },
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
    engineThreadId: "thr_0123456789abcdef",
    activeTurnId: null,
    lastMode: "work",
    pauseAfterTask: false,
    queued: 0,
    profile: {
      provider: "deepseek",
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
      turns: 1,
      label: "$0.0012 across 1 turn",
    },
    submission: null,
    diagnostics: [],
    pendingInput: null,
    canSubmit: true,
    cannotSubmitReason: null,
    controls: { canInterrupt: false, canPause: true, canCancelQueued: false, canStop: true },
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof StudioScreen>[0]> = {}): void {
  act(() => {
    root?.render(
      <StudioScreen
        detail={detail()}
        studio={studio()}
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

describe("studio screen honesty and safety", () => {
  it("submits with Command-Enter only, leaving plain Enter and IME alone", () => {
    const onSubmit = vi.fn();
    render({ draft: "Do work", onSubmit });
    const textarea = container!.querySelector("textarea")!;
    function key(options: KeyboardEventInit = {}) {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...options,
      });
      act(() => {
        textarea.dispatchEvent(event);
      });
      return event;
    }
    expect(key().defaultPrevented).toBe(false);
    expect(key({ metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    key({ metaKey: true, repeat: true });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(key({ metaKey: true }).defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("uses the same disabled gate for shortcut and send button", () => {
    const onSubmit = vi.fn();
    for (const props of [
      { draft: "   " },
      { draft: "Do work", studioBusy: true },
      { draft: "Do work", studio: studio({ canSubmit: false }) },
    ]) {
      render({ onSubmit, ...props });
      expect(
        (container!.querySelector('[data-testid="studio-send"]') as HTMLButtonElement).disabled,
      ).toBe(true);
      act(() => {
        container!.querySelector("textarea")!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    }
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("says a silent stream is silent instead of showing a live-looking turn", () => {
    render({
      studio: studio({
        activeTurnId: "turn_1",
        connection: { ...studio().connection, state: "running", silentForMs: 90_000 },
      }),
    });
    const text = container?.textContent ?? "";
    expect(text).toContain("No engine events for");
    expect(text).toContain("The stream is open but silent");
  });

  it("does not cry stall while events are still arriving", () => {
    render({
      studio: studio({
        activeTurnId: "turn_1",
        connection: { ...studio().connection, state: "running", silentForMs: 3_000 },
      }),
    });
    expect(container?.textContent ?? "").not.toContain("No engine events for");
  });

  it("shows exactly which engine events are missing from the record", () => {
    render({
      studio: studio({
        connection: {
          ...studio().connection,
          missing: [
            { from: 3, to: 4 },
            { from: 9, to: 9 },
          ],
        },
      }),
    });
    const text = container?.textContent ?? "";
    expect(text).toContain("Some engine events were never received");
    expect(text).toContain("#3–4");
    expect(text).toContain("#9");
  });

  it("shows the saved profile and observed effective route separately", () => {
    render();
    expect(container?.textContent).toContain("deepseek / deepseek-flash");
    expect(container?.textContent).toContain("Observed");
    expect(container?.textContent).toContain("full_access");
    expect(container?.textContent).toContain("$0.0012");
  });

  it("keeps execution controls visible with a truthful disabled state", () => {
    render();
    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    const interrupt = buttons.find((button) => button.textContent?.includes("Interrupt now"));
    const stop = buttons.find((button) => button.textContent?.includes("Stop engine"));
    expect(interrupt).toBeTruthy();
    expect(interrupt?.disabled).toBe(true);
    expect(interrupt?.title).toContain("No active turn");
    expect(stop?.disabled).toBe(false);
  });

  it("renders adversarial model output as inert text inside a large-output control", () => {
    const hostile =
      '<script>window.mona.submitTask("prj_0123456789abcdef","pwn","work")</script>' +
      "\n\n[click me](https://evil.example/steal)\n\n" +
      "x".repeat(5_000);
    render({
      detail: detail([
        {
          threadId: "thr_0123456789abcdef",
          seq: 3,
          kind: "item.completed",
          payload: {
            item: { id: "i1", kind: "agent_message", status: "completed", detail: hostile },
          },
          timestamp: "2026-11-11T00:00:03.000Z",
        },
      ]),
    });
    const timeline = container?.querySelector('[data-testid="studio-timeline"]');
    expect(timeline?.querySelectorAll("script, img, iframe")).toHaveLength(0);
    expect(timeline?.querySelectorAll("a[href]")).toHaveLength(0);
    expect(timeline?.textContent).toContain("<script>");
    const expand = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Show full output"),
    );
    expect(expand).toBeTruthy();
  });

  it("states an unknown submission outcome instead of claiming success", () => {
    render({
      studio: studio({
        submission: {
          operationKey: "op-0123456789abcdef",
          status: "outcome_unknown",
          turnId: null,
          reconciled: false,
          note: "transport error after the write",
          submittedAt: "2026-11-11T00:00:00.000Z",
        },
      }),
    });
    expect(container?.textContent).toContain("Submission outcome unknown");
    expect(container?.textContent).toContain("Reconcile lookup");
  });

  it("shows the engine's approval wait as a real wait, not a hang", () => {
    render({
      studio: studio({
        pendingInput:
          "The engine is waiting for an approval decision Mona cannot answer yet. Switch to Work with your saved Full Access profile, or answer in Codewhale. It will wait here rather than spin.",
      }),
    });
    expect(container?.textContent).toContain("waiting for input Mona cannot answer");
  });
});
