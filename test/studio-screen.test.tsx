// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, StoredEventSummary } from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { emptyStudioUsageView } from "../src/shared/contracts/usage-hud";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import { StudioScreen } from "../src/renderer/shell/Studio";
import axe from "axe-core";

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

function detail(
  events: ProjectDetail["events"] = [],
  overrides: Partial<ProjectDetail> = {},
): ProjectDetail {
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
    events,
    history: {
      olderCursor: null,
      hasMore: false,
      storedTotal: events.length,
      pageSize: events.length,
    },
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

  it("offers the engine's approval as an answerable card, not a dead wait", () => {
    const answered: Array<{ id: string; response: unknown }> = [];
    render({
      studio: studio({
        pendingRequests: [
          {
            id: "prq_0123456789abcdef",
            kind: "approval",
            projectId: "prj_test",
            threadId: "thr_test",
            turnId: "turn_test",
            toolName: "bash",
            title: "Run `npm test` in the project root",
            summary: "Run `npm test` in the project root",
            input: { command: "npm test" },
            questions: [],
            decisions: ["allow", "deny"],
            status: "pending",
            decision: null,
            decidedBy: null,
            acknowledgement: null,
            note: null,
            createdAt: "2026-11-11T00:00:00.000Z",
            settledAt: null,
            canAnswer: true,
            cannotAnswerReason: null,
          },
        ],
      }),
      onAnswerPending: (id, response) => answered.push({ id, response }),
    });
    expect(container?.textContent).toContain("Approval requested");
    expect(container?.textContent).toContain("Run `npm test` in the project root");
    // The old text told the user to leave Mona or widen the permission mode;
    // answering in place replaces that advice entirely.
    expect(container?.textContent).not.toContain("cannot answer");
    expect(container?.textContent).not.toContain("Switch to Work");

    const approve = container?.querySelector('[data-testid="pending-approve"]');
    act(() => (approve as HTMLElement | null)?.click());
    expect(answered).toEqual([
      {
        id: "prq_0123456789abcdef",
        response: { kind: "approval", decision: "allow", remember: false },
      },
    ]);
  });

  it("shows a question's options and sends only a complete answer", () => {
    const answered: Array<{ id: string; response: unknown }> = [];
    render({
      studio: studio({
        pendingRequests: [
          {
            id: "prq_fedcba9876543210",
            kind: "user_input",
            projectId: "prj_test",
            threadId: "thr_test",
            turnId: "turn_test",
            toolName: null,
            title: "Which package manager?",
            summary: null,
            input: null,
            questions: [
              {
                id: "q1",
                header: "Package manager",
                question: "Which package manager should I use?",
                options: [
                  { label: "npm", description: "the repository's lockfile" },
                  { label: "pnpm", description: null },
                ],
                multiSelect: false,
                malformed: false,
              },
            ],
            decisions: [],
            status: "pending",
            decision: null,
            decidedBy: null,
            acknowledgement: null,
            note: null,
            createdAt: "2026-11-11T00:00:00.000Z",
            settledAt: null,
            canAnswer: true,
            cannotAnswerReason: null,
          },
        ],
      }),
      onAnswerPending: (id, response) => answered.push({ id, response }),
    });
    const submit = container?.querySelector(
      '[data-testid="pending-submit"]',
    ) as HTMLButtonElement | null;
    expect(submit?.disabled).toBe(true);
    const radio = container?.querySelector('input[type="radio"]') as HTMLInputElement | null;
    act(() => radio?.click());
    // React state settles synchronously enough for a jsdom click; the button
    // must become available only once an answer exists.
    expect(
      (container?.querySelector('[data-testid="pending-submit"]') as HTMLButtonElement | null)
        ?.disabled,
    ).toBe(false);
    act(() =>
      (container?.querySelector('[data-testid="pending-submit"]') as HTMLElement | null)?.click(),
    );
    expect(answered).toEqual([
      {
        id: "prq_fedcba9876543210",
        response: {
          kind: "user_input",
          answers: [{ questionId: "q1", label: "npm", value: "npm" }],
        },
      },
    ]);
  });
});

describe("R02 paged conversation history", () => {
  const threadA = {
    id: "thr_a",
    title: "Current work",
    engineThreadId: "eng_a",
    updatedAt: "2026-11-11T00:00:02.000Z",
  };
  const threadB = {
    id: "thr_b",
    title: "Older work",
    engineThreadId: null,
    updatedAt: "2026-11-10T00:00:00.000Z",
  };

  function stored(
    seq: number,
    text: string,
    extra: Partial<StoredEventSummary> = {},
  ): StoredEventSummary {
    return {
      threadId: "thr_a",
      seq,
      kind: "item.completed",
      payload: { item: { id: "item_a", kind: "agent_message", status: "completed", detail: text } },
      timestamp: `2026-11-11T00:00:0${seq}.000Z`,
      turnId: "turn_one",
      itemId: "item_a",
      ...extra,
    };
  }

  function history(
    events: StoredEventSummary[],
    overrides: Partial<NonNullable<Parameters<typeof StudioScreen>[0]["history"]>> = {},
  ): NonNullable<Parameters<typeof StudioScreen>[0]["history"]> {
    return {
      events,
      storedTotal: 10_050,
      hasMore: true,
      loading: false,
      error: null,
      threadId: null,
      truncatedItems: {},
      completeItems: {},
      olderLoads: 0,
      onLoadOlder: () => undefined,
      onLoadItem: () => undefined,
      onSelectThread: () => undefined,
      ...overrides,
    };
  }

  it("loads a real older page instead of revealing a fixed tail", () => {
    const onLoadOlder = vi.fn();
    const events = [stored(1, "visible answer")];
    render({
      detail: detail(events, {
        threads: [threadA],
        history: {
          olderCursor: { recordedAt: "2026-11-11T00:00:01.000Z", rowId: 1 },
          hasMore: true,
          storedTotal: 10_050,
          pageSize: 1,
        },
      }),
      history: history(events, { onLoadOlder }),
    });
    const scope =
      container!.querySelector('[data-testid="studio-history-scope"]')?.textContent ?? "";
    expect(scope).toContain("1 shown");
    expect(scope).toContain("10050 stored");
    expect(scope).toContain("older pages available");
    const load = container!.querySelector('[data-testid="studio-load-earlier"]');
    expect(load).not.toBeNull();
    expect(container!.textContent).not.toContain("Show 1 earlier event");
    act(() => (load as HTMLButtonElement).click());
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("offers Jump to latest once the reader scrolls away, and honours it", () => {
    const events = [stored(1, "one"), stored(2, "two")];
    render({
      detail: detail(events, { threads: [threadA] }),
      history: history(events, { hasMore: false, storedTotal: 2 }),
    });
    const node = container!.querySelector('[data-testid="studio-timeline"]') as HTMLDivElement;
    Object.defineProperty(node, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(node, "clientHeight", { configurable: true, value: 300 });
    node.scrollTop = 0;
    act(() => {
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const jump = container!.querySelector('[data-testid="studio-jump-latest"]');
    expect(jump).not.toBeNull();
    act(() => (jump as HTMLButtonElement).click());
    expect(node.scrollTop).toBe(1_000);
    expect(container!.querySelector('[data-testid="studio-jump-latest"]')).toBeNull();
  });

  it("distinguishes the current thread from archived conversation", () => {
    const onSelectThread = vi.fn();
    render({
      detail: detail([], { threads: [threadA, threadB] }),
      studio: studio({ threadId: "thr_a" }),
      history: history([], { hasMore: false, storedTotal: 0, onSelectThread }),
    });
    const select = container!.querySelector(
      '[data-testid="studio-thread-select"]',
    ) as HTMLSelectElement;
    const labels = Array.from(select.options).map((option) => option.textContent);
    expect(labels).toEqual(["All threads", "Current work · current", "Older work · archived"]);
    act(() => {
      select.value = "thr_b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelectThread).toHaveBeenCalledWith("thr_b");
  });

  it("shows an honest partial card and can load the item's beginning", () => {
    const onLoadItem = vi.fn();
    const events: StoredEventSummary[] = [
      {
        threadId: "thr_a",
        seq: 9,
        kind: "item.delta",
        payload: { kind: "agent_message", delta: "…only the tail" },
        timestamp: "2026-11-11T00:00:09.000Z",
        turnId: "turn_one",
        itemId: "item_a",
      },
    ];
    render({
      detail: detail(events, { threads: [threadA] }),
      history: history(events, { onLoadItem }),
    });
    const partial = container!.querySelector('[data-testid="studio-partial-item"]');
    expect(partial).not.toBeNull();
    expect(partial?.textContent).toContain("began before the events loaded here");
    const load = Array.from(partial!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Load the beginning"),
    );
    act(() => (load as HTMLButtonElement).click());
    expect(onLoadItem).toHaveBeenCalledWith("thr_a", "item_a");
  });

  it("says when a partial item has no stored identity to reload", () => {
    const events: StoredEventSummary[] = [
      {
        threadId: "thr_a",
        seq: 9,
        kind: "item.delta",
        payload: { kind: "agent_message", delta: "legacy tail" },
        timestamp: "2026-11-11T00:00:09.000Z",
        turnId: "turn_one",
        itemId: null,
      },
    ];
    render({
      detail: detail(events, { threads: [threadA] }),
      history: history(events),
    });
    const partial = container!.querySelector('[data-testid="studio-partial-item"]');
    expect(partial?.textContent).toContain("cannot reconstruct it");
    expect(partial?.querySelector("button")).toBeNull();
  });

  it("reports a truncated item load instead of implying completeness", () => {
    const events = [stored(1, "one")];
    render({
      detail: detail(events, { threads: [threadA] }),
      history: history(events, {
        hasMore: true,
        truncatedItems: { "thr_a:item_a": { returned: 400, stored: 5_000 } },
        completeItems: {},
      }),
    });
    expect(
      container!.querySelector('[data-testid="studio-truncated-item"]')?.textContent,
    ).toContain("Showing 400 of 5000 stored frames");
  });
});

describe("R02 scroll anchoring", () => {
  function stored(seq: number, text: string): StoredEventSummary {
    return {
      threadId: "thr_a",
      seq,
      kind: "item.completed",
      payload: {
        item: { id: `item_${seq}`, kind: "agent_message", status: "completed", detail: text },
      },
      timestamp: `2026-11-11T00:00:0${seq}.000Z`,
      turnId: "turn_one",
      itemId: `item_${seq}`,
    };
  }
  function history(
    events: StoredEventSummary[],
    hasMore: boolean,
    olderLoads = 0,
    onLoadOlder: () => void = () => undefined,
  ): NonNullable<Parameters<typeof StudioScreen>[0]["history"]> {
    return {
      events,
      storedTotal: 300,
      hasMore,
      loading: false,
      error: null,
      threadId: null,
      truncatedItems: {},
      completeItems: {},
      olderLoads,
      onLoadOlder,
    };
  }

  it("keeps the reader's viewport in place when an older page is prepended", () => {
    const newer = [stored(3, "three")];
    const detailProps = detail(newer, { threads: [] });
    render({ detail: detailProps, history: history(newer, true) });
    const node = container!.querySelector('[data-testid="studio-timeline"]') as HTMLDivElement;
    Object.defineProperty(node, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(node, "clientHeight", { configurable: true, value: 300 });
    node.scrollTop = 500;
    act(() => {
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const loadEarlier = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Load earlier"),
    );
    expect(loadEarlier).toBeDefined();
    act(() => (loadEarlier as HTMLButtonElement).click());

    // The older page arrives: the content above the viewport grew by 1,000 px.
    Object.defineProperty(node, "scrollHeight", { configurable: true, value: 2_000 });
    render({
      detail: detailProps,
      history: history([stored(1, "one"), stored(2, "two"), ...newer], true, 1),
    });
    expect(node.scrollTop).toBe(1_500);
  });

  it("does not move the viewport when only new live events arrive", () => {
    const initial = [stored(3, "three")];
    const detailProps = detail(initial, { threads: [] });
    render({ detail: detailProps, history: history(initial, false) });
    const node = container!.querySelector('[data-testid="studio-timeline"]') as HTMLDivElement;
    Object.defineProperty(node, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(node, "clientHeight", { configurable: true, value: 300 });
    node.scrollTop = 400;
    act(() => {
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    Object.defineProperty(node, "scrollHeight", { configurable: true, value: 1_200 });
    render({
      detail: detailProps,
      history: history([...initial, stored(4, "four")], false),
    });
    // The reader stays where they were; the live edge does not drag them.
    expect(node.scrollTop).toBe(400);
  });
});

describe("R03 descriptive command autocomplete", () => {
  const catalog = buildCommandCatalog();

  function Harness({
    initial = "",
    ...props
  }: Partial<Parameters<typeof StudioScreen>[0]> & { initial?: string }): JSX.Element {
    const [draft, setDraft] = useState(initial);
    return (
      <StudioScreen
        detail={detail()}
        studio={studio()}
        studioBusy={false}
        mode="work"
        draft={draft}
        draftStatus="idle"
        inspectorTab="task"
        onInspectorTab={() => undefined}
        onDraft={setDraft}
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
        commandCatalog={catalog}
        {...props}
      />
    );
  }

  function renderHarness(
    props: Partial<Parameters<typeof StudioScreen>[0]> & { initial?: string },
  ) {
    act(() => root?.render(<Harness {...props} />));
  }

  /** A controlled composer: the draft comes from the props, as the real Shell does. */
  function renderControlled(draft: string) {
    act(() =>
      root?.render(
        <StudioScreen
          detail={detail()}
          studio={studio()}
          studioBusy={false}
          mode="work"
          draft={draft}
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
          commandCatalog={catalog}
        />,
      ),
    );
  }

  function composer(): HTMLTextAreaElement {
    const element = container!.querySelector<HTMLTextAreaElement>("textarea");
    if (!element) throw new Error("composer textarea is not rendered");
    return element;
  }

  function type(value: string): void {
    const element = composer();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function key(init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      composer().dispatchEvent(event);
    });
    return event;
  }

  it("opens a listbox with a description, usage, and route for a command position", () => {
    renderHarness({ initial: "/he" });
    const menu = container!.querySelector('[data-testid="command-menu"]');
    expect(menu).not.toBeNull();
    const listbox = container!.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Codewhale commands");
    expect(container!.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
    expect(composer().getAttribute("role")).toBe("combobox");
    expect(composer().getAttribute("aria-expanded")).toBe("true");
    expect(composer().getAttribute("aria-activedescendant")).toMatch(/^composer-command-option-/);
    const text = container!.textContent ?? "";
    expect(text).toContain("/help");
    expect(text).toContain("Commands, skills, and keys");
    expect(text).toContain("/help [command]");
    expect(text).toContain("TUI only");
  });

  it("moves with arrows, accepts with Tab, and leaves plain Enter as a newline", () => {
    const onSubmit = vi.fn();
    renderHarness({ initial: "/", onSubmit });
    const first = composer().getAttribute("aria-activedescendant");
    key({ key: "ArrowDown" });
    expect(composer().getAttribute("aria-activedescendant")).not.toBe(first);
    key({ key: "ArrowUp" });
    expect(composer().getAttribute("aria-activedescendant")).toBe(first);

    const enter = key({ key: "Enter" });
    expect(enter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    type("/he");
    key({ key: "Tab" });
    expect(composer().value).toBe("/help ");
    expect(container!.querySelector('[data-testid="command-menu"]')).toBeNull();
  });

  it("accepting a no-argument command closes the list instead of reopening it", () => {
    renderHarness({ initial: "/cle" });
    key({ key: "Tab" });
    expect(composer().value).toBe("/clear");
    expect(container!.querySelector('[data-testid="command-menu"]')).toBeNull();
  });

  it("Escape closes the list first without touching the draft or submitting", () => {
    const onSubmit = vi.fn();
    renderHarness({ initial: "/he", onSubmit });
    const escape = key({ key: "Escape" });
    expect(escape.defaultPrevented).toBe(true);
    expect(container!.querySelector('[data-testid="command-menu"]')).toBeNull();
    expect(composer().value).toBe("/he");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not open during IME composition and never submits a composing Enter", () => {
    const onSubmit = vi.fn();
    renderHarness({ initial: "/", onSubmit });
    act(() => {
      composer().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    type("/he");
    expect(container!.querySelector('[data-testid="command-menu"]')).toBeNull();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "isComposing", { value: true });
    act(() => {
      composer().dispatchEvent(event);
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not reference a listbox that has no rows, and announces the empty filter", () => {
    renderHarness({ initial: "/zzzzz" });
    const element = composer();
    expect(element.getAttribute("aria-expanded")).toBe("false");
    expect(element.getAttribute("aria-controls")).toBeNull();
    const status = container!.querySelector('.command-menu__head [role="status"]');
    expect(status?.textContent).toContain("No catalogued command matches");
    // Arrow keys still move the caret when there is nothing to choose.
    const event = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      element.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it("clamps a restored draft caret instead of reading a stale position", () => {
    renderControlled("/help now please");
    const element = container!.querySelector<HTMLTextAreaElement>("textarea")!;
    act(() => {
      element.setSelectionRange(15, 15);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    // A project switch replaces the draft with a shorter one. The stale caret
    // (15) must not be read against the new text.
    renderControlled("/");
    expect(container!.querySelector('[data-testid="command-menu"]')).not.toBeNull();
    expect((container!.querySelector("textarea") as HTMLTextAreaElement).value).toBe("/");
  });

  it("closes while a selection is active so accepting cannot discard it", () => {
    renderHarness({ initial: "/he" });
    const element = composer();
    act(() => {
      element.setSelectionRange(0, 3);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    expect(container!.querySelector('[data-testid="command-menu"]')).toBeNull();
  });

  it("accepts a pointed row and restores the caret after the replacement", () => {
    renderHarness({ initial: "/he" });
    const option = container!.querySelector<HTMLElement>('[role="option"]');
    expect(option).not.toBeNull();
    act(() => {
      option!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(composer().value).toBe("/help ");
    expect(composer().selectionStart).toBe(6);
  });

  it("keeps Send available for a command even when the engine cannot submit it", () => {
    renderHarness({ initial: "/help", studio: studio({ canSubmit: false }) });
    const send = container!.querySelector<HTMLButtonElement>('[data-testid="studio-send"]');
    expect(send?.disabled).toBe(false);
    expect(send?.title).toContain("Codewhale command");
  });

  it("has no serious accessibility violations with the list open", async () => {
    renderHarness({ initial: "/he" });
    const results = await axe.run(container!, { rules: { "color-contrast": { enabled: false } } });
    const blocking = results.violations.filter(
      (violation) => violation.impact === "serious" || violation.impact === "critical",
    );
    expect(blocking.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});

describe("R10 review conveniences", () => {
  const hit = {
    threadId: "thr_test",
    seq: 4,
    itemId: "item_test",
    kind: "item.completed",
    timestamp: "2026-11-11T00:00:04.000Z",
    snippet: "…the parser drops unicode…",
  };

  it("copies a card's exact body and offers code copy in prose", () => {
    const copied: Array<{ text: string; label: string }> = [];
    render({
      detail: detail([
        {
          threadId: "thr_test",
          seq: 4,
          kind: "item.completed",
          payload: {
            item: {
              id: "item_test",
              kind: "agent_message",
              detail: "Here is the fix:\n\n```ts\nexport const answer = 42;\n```",
            },
          },
          timestamp: "2026-11-11T00:00:04.000Z",
          turnId: "turn_test",
          itemId: "item_test",
        },
      ]),
      onCopy: (text, label) => copied.push({ text, label }),
    });
    const cardCopy = container?.querySelector('[data-testid="copy-message"]');
    act(() => (cardCopy as HTMLElement | null)?.click());
    expect(copied[0]?.label).toBe("message");
    expect(copied[0]?.text).toContain("export const answer = 42;");
    const codeCopy = container?.querySelector('[data-testid="copy-code"]');
    act(() => (codeCopy as HTMLElement | null)?.click());
    // Code copy must hand back the block's source, not the surrounding prose.
    expect(copied[1]).toEqual({ text: "export const answer = 42;", label: "code" });
  });

  it("shows search results, jumps to one, and states the search scope", () => {
    const searched: string[] = [];
    const jumped: string[] = [];
    render({
      search: {
        query: "unicode",
        hits: [hit],
        busy: false,
        error: null,
        anchor: null,
        onQuery: (value) => searched.push(value),
        onJump: (value) => jumped.push(value.snippet),
        onClear: () => searched.push(""),
      },
    });
    expect(container?.textContent).toContain("1 match");
    expect(container?.textContent).toContain("Local read only");
    const result = container?.querySelector(".history-search__hit");
    act(() => (result as HTMLElement | null)?.click());
    expect(jumped).toEqual([hit.snippet]);
    const field = container?.querySelector(".history-search input") as HTMLInputElement | null;
    expect(field?.value).toBe("unicode");
  });

  it("marks the card a search jumped to, and asks for an older page when it is not loaded", () => {
    const loads: number[] = [];
    const older = {
      threadId: "thr_test",
      seq: 1,
      kind: "item.completed",
      payload: { item: { id: "item_old", kind: "agent_message", detail: "older text" } },
      timestamp: "2026-11-11T00:00:01.000Z",
      turnId: null,
      itemId: "item_old",
    };
    render({
      detail: detail({ events: [older] }),
      search: {
        query: "unicode",
        hits: [hit],
        busy: false,
        error: null,
        anchor: { itemId: "item_missing", seq: 99 },
        onQuery: () => undefined,
        onJump: () => undefined,
        onClear: () => undefined,
      },
      history: {
        events: [older],
        storedTotal: 400,
        hasMore: true,
        loading: false,
        error: null,
        threadId: null,
        truncatedItems: {},
        completeItems: {},
        olderLoads: 0,
        onLoadOlder: () => loads.push(1),
      },
    });
    // The hit is not in the loaded window, so the console asks for one more
    // page instead of pretending the match is on screen.
    expect(loads.length).toBeGreaterThan(0);
  });

  it("offers a verified file mention and keeps binary attachment unavailable", () => {
    render({ onMentionFile: () => undefined });
    expect(container?.querySelector('[data-testid="mention-file"]')).not.toBeNull();
    const attach = container?.querySelector(
      '[data-testid="attach-file"]',
    ) as HTMLButtonElement | null;
    expect(attach?.disabled).toBe(true);
    expect(attach?.title).toContain("unavailable");
  });

  it("offers Open Changes from a tool card without following model paths", () => {
    const opened: number[] = [];
    render({
      detail: detail([
        {
          threadId: "thr_test",
          seq: 9,
          kind: "item.completed",
          payload: {
            item: {
              id: "item_tool",
              kind: "command_execution",
              detail: "cat /Users/someone/secret.txt",
            },
          },
          timestamp: "2026-11-11T00:00:09.000Z",
          turnId: "turn_test",
          itemId: "item_tool",
        },
      ]),
      onShowChanges: () => opened.push(1),
    });
    const button = container?.querySelector('[data-testid="open-changes"]');
    expect(button).not.toBeNull();
    act(() => (button as HTMLElement | null)?.click());
    expect(opened).toEqual([1]);
    // A model-mentioned absolute path is rendered as text, never as a link.
    expect(container?.querySelector('.timeline-event--tool a[href^="file"]')).toBeNull();
  });

  it("shows unread events while the reader is scrolled back", () => {
    const first = {
      threadId: "thr_test",
      seq: 1,
      kind: "item.completed",
      payload: { item: { id: "item_a", kind: "agent_message", detail: "first" } },
      timestamp: "2026-11-11T00:00:01.000Z",
      turnId: null,
      itemId: "item_a",
    };
    const second = {
      ...first,
      seq: 2,
      itemId: "item_b",
      payload: { item: { id: "item_b", kind: "agent_message", detail: "second" } },
      timestamp: "2026-11-11T00:00:02.000Z",
    };
    const base = {
      storedTotal: 2,
      hasMore: false,
      loading: false,
      error: null,
      threadId: null,
      truncatedItems: {},
      completeItems: {},
      olderLoads: 0,
    };
    render({ history: { ...base, events: [first] } });
    const timeline = container?.querySelector('[data-testid="studio-timeline"]') as HTMLElement;
    // Simulating a reader who scrolled up: the console is no longer following.
    act(() => {
      Object.defineProperty(timeline, "scrollHeight", { value: 1200, configurable: true });
      Object.defineProperty(timeline, "clientHeight", { value: 400, configurable: true });
      Object.defineProperty(timeline, "scrollTop", {
        value: 0,
        configurable: true,
        writable: true,
      });
      timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    render({ history: { ...base, events: [first, second] } });
    expect(container?.textContent).toMatch(/new event/);
  });
});
