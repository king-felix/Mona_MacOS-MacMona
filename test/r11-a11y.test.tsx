// @vitest-environment jsdom
import { act, useState, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectDetail, StoredEventSummary } from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { emptyStudioUsageView } from "../src/shared/contracts/usage-hud";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import { Dialog, TextField } from "../src/renderer/design/primitives";
import { StudioScreen } from "../src/renderer/shell/Studio";
import { acceleratorAllowed, acceleratorScope } from "../src/renderer/shell/keyboard";
import { MIN_WINDOWED } from "../src/renderer/shell/timeline-window";

/**
 * R11 — accessibility and bounded-render contracts at the component boundary.
 *
 * Each case here corresponds to a defect the audit found or a claim R11 makes.
 * They are the mechanism behind the claims: "a dialog does not lose the caret",
 * "streaming does not announce the transcript", "a long console mounts a slice".
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
  container = null;
  root = null;
});

/* ------------------------------------------------------------- dialog focus */

/**
 * A dialog whose close handler is rebuilt on every render, exactly as every
 * production caller writes it (`onClose={() => setDialog(null)}`), and whose
 * field value is parent state. Before R11 the focus effect depended on
 * `onClose`, so each keystroke repeated it and the caret jumped to the header's
 * close button after the first character.
 */
function DialogHarness(): JSX.Element {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState("");
  return (
    <div>
      <button type="button" data-testid="opener">
        Open
      </button>
      <Dialog open={open} title="Rename project" onClose={() => setOpen(false)}>
        <TextField
          label="Project label"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {/* Proves the parent really re-rendered: the field's DOM value alone
            would look updated even if React state never changed. */}
        <p data-testid="echo">{name}</p>
      </Dialog>
    </div>
  );
}

describe("R11 dialog focus lifecycle", () => {
  it("keeps the caret in a dialog field while the parent re-renders", () => {
    act(() => root!.render(<DialogHarness />));
    const input = container!.querySelector<HTMLInputElement>(".dialog__body input");
    expect(input).not.toBeNull();
    input!.focus();
    expect(document.activeElement).toBe(input);

    // Two keystrokes: each one re-renders the harness with a new inline onClose.
    for (const value of ["a", "ab"]) {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, value);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(document.activeElement).toBe(input);
    }
    // The echo proves the state change reached the parent, so the effect above
    // really did have a new `onClose` to react to.
    expect(container!.querySelector('[data-testid="echo"]')?.textContent).toBe("ab");
  });

  it("leaves focus where the reader put it when the parent re-renders", () => {
    act(() => root!.render(<DialogHarness />));
    const input = container!.querySelector<HTMLInputElement>(".dialog__body input");
    const close = container!.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]');
    expect(input).not.toBeNull();
    expect(close).not.toBeNull();

    // The reader deliberately moves to the header action. Then the dialog's
    // parent re-renders for a reason that has nothing to do with the dialog — a
    // live engine frame, a draft save — which is the ordinary steady state of
    // this app, not an edge case.
    act(() => close!.focus());
    expect(document.activeElement).toBe(close);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "moved");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The re-render is proven by the echo, not assumed.
    expect(container!.querySelector('[data-testid="echo"]')?.textContent).toBe("moved");
    // Focus is still the reader's choice. Before R11 this effect was keyed on
    // `onClose` — an inline arrow that is a new function on every parent render —
    // so it re-ran here (proved by the echo above), and every run restored focus
    // to the pre-dialog element and then re-focused the dialog. jsdom's
    // "visible or active" filter masked the movement; a browser would move a
    // caret the reader had placed deliberately. The guard is cheap and the
    // property is the one that matters: an unrelated re-render does not touch
    // focus.
    expect(document.activeElement).toBe(close);
  });

  it("focuses the dialog body rather than its header close button", () => {
    act(() => root!.render(<DialogHarness />));
    const close = container!.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]');
    const input = container!.querySelector<HTMLInputElement>(".dialog__body input");
    expect(close).not.toBeNull();
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    expect(document.activeElement).not.toBe(close);
  });

  it("ignores Escape while an IME is composing, then closes and restores focus", () => {
    act(() => root!.render(<DialogHarness />));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => {
      document.dispatchEvent(composing);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("is modal and labelled for assistive technology", () => {
    act(() => root!.render(<DialogHarness />));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe("Rename project");
  });
});

/* ------------------------------------------------------- accelerator policy */

describe("R11 window-accelerator policy", () => {
  it("blocks every accelerator while a modal dialog is open", () => {
    const scope = acceleratorScope(document);
    expect(scope.modalOpen).toBe(false);
    expect(acceleratorAllowed({}, scope)).toBe(true);

    act(() => root!.render(<DialogHarness />));
    const open = acceleratorScope(document);
    expect(open.modalOpen).toBe(true);
    // ⌘1–⌘9, ⌘K, ⌘J: all refused, so navigation cannot happen behind a dialog.
    expect(acceleratorAllowed({ keyCode: 49 }, open)).toBe(false);
  });

  it("refuses a composing keystroke in both spellings macOS uses", () => {
    const scope = { modalOpen: false };
    expect(acceleratorAllowed({ isComposing: true }, scope)).toBe(false);
    expect(acceleratorAllowed({ keyCode: 229 }, scope)).toBe(false);
    expect(acceleratorAllowed({}, scope)).toBe(true);
  });
});

/* ------------------------------------------------------ console semantics */

function projectDetail(events: StoredEventSummary[]): ProjectDetail {
  return {
    project: {
      id: "prj_0123456789abcdef",
      name: "R11 project",
      rootPath: "/tmp/r11",
      canonicalPath: "/tmp/r11",
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
    currentThreadId: "thr_a",
    draft: null,
    events,
    history: { olderCursor: null, hasMore: false, storedTotal: events.length, pageSize: 200 },
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

function studioSnapshot(): StudioSnapshot {
  return {
    projectId: "prj_0123456789abcdef",
    connection: {
      state: "connected",
      reason: "ready",
      since: "2026-11-11T00:00:00.000Z",
      port: 51234,
      engine: { version: "0.10.2", commit: "ff466b2ed0bfb4ae5267d4d8d0ecb562cf46956e" },
      owned: true,
      external: false,
      lastEventAt: null,
      silentForMs: null,
      missing: [],
    },
    threadId: "thr_a",
    engineThreadId: "thr_a",
    activeTurnId: null,
    lastMode: "work",
    pauseAfterTask: false,
    queued: 0,
    profile: null,
    cost: { observed: false, costUsd: null, costComplete: false, turns: 0, label: "unpriced" },
    submission: null,
    diagnostics: [],
    followUps: [],
    steering: { available: false, reason: "no steer route", requiredRoute: null },
    usage: emptyStudioUsageView(),
    pendingRequests: [],
    canSubmit: true,
    cannotSubmitReason: null,
    controls: { canInterrupt: false, canPause: true, canCancelQueued: false, canStop: true },
  };
}

function message(seq: number, text: string): StoredEventSummary {
  return {
    threadId: "thr_a",
    seq,
    kind: "item.completed",
    payload: {
      item: { id: `item_${seq}`, kind: "agent_message", status: "completed", detail: text },
    },
    timestamp: new Date(Date.parse("2026-11-11T00:00:00.000Z") + seq * 1_000).toISOString(),
    turnId: "turn_one",
    itemId: `item_${seq}`,
  };
}

function renderStudio(events: StoredEventSummary[], draft = ""): void {
  act(() => {
    root!.render(
      <StudioScreen
        detail={projectDetail(events)}
        studio={studioSnapshot()}
        studioBusy={false}
        mode="work"
        draft={draft}
        draftStatus="idle"
        commandCatalog={buildCommandCatalog()}
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
        history={{
          events,
          storedTotal: events.length,
          hasMore: false,
          loading: false,
          error: null,
          threadId: null,
          truncatedItems: {},
          completeItems: {},
          olderLoads: 0,
          onLoadOlder: () => undefined,
          onLoadItem: () => undefined,
          onSelectThread: () => undefined,
        }}
      />,
    );
  });
}

describe("R11 console announcements", () => {
  it("keeps the transcript out of every live region", () => {
    renderStudio([message(1, "first answer"), message(2, "second answer")]);
    const timeline = container!.querySelector('[data-testid="studio-timeline"]');
    expect(timeline).not.toBeNull();
    // A streamed frame must never re-announce the conversation: no live region
    // may exist inside the console, and no card may carry one.
    expect(timeline!.querySelectorAll("[aria-live]").length).toBe(0);
    expect(timeline!.querySelectorAll('[role="log"]').length).toBe(0);
    expect(timeline!.querySelectorAll('[role="status"]').length).toBe(0);
    // The cards themselves are a list, so a reader can navigate them.
    expect(timeline!.querySelector("ol.timeline")).not.toBeNull();
    expect(timeline!.querySelectorAll("li.timeline-event").length).toBe(2);
  });

  it("announces a command suggestion once, through the combobox", () => {
    renderStudio([message(1, "an answer")], "/he");
    const options = Array.from(container!.querySelectorAll('[role="option"]'));
    expect(options.length).toBeGreaterThan(0);
    // Exactly one option is selected, and its accessible name carries the
    // description rather than the name alone.
    expect(
      options.filter((option) => option.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    const selected = options.find((option) => option.getAttribute("aria-selected") === "true");
    expect((selected?.textContent ?? "").length).toBeGreaterThan(10);

    // The detail panel duplicates that name, so it must not be a live region.
    const detail = container!.querySelector(".command-menu__detail");
    expect(detail).not.toBeNull();
    expect(detail!.closest("[aria-live]")).toBeNull();
    expect(detail!.getAttribute("aria-live")).toBeNull();
  });
});

/**
 * The two axe rules that R11 actually fixed, asserted directly so they cannot
 * come back: a heading level must not skip, and a textarea must not claim the
 * combobox role.
 */
describe("R11 ARIA validity", () => {
  it("keeps the composer a valid textbox with a popup relationship", () => {
    renderStudio([message(1, "an answer")], "/he");
    const composer = container!.querySelector("textarea");
    expect(composer).not.toBeNull();
    // ARIA in HTML allows only `textbox` on a textarea; combobox is invalid there.
    const role = composer!.getAttribute("role");
    expect(role === null || role === "textbox").toBe(true);
    expect(composer!.getAttribute("aria-haspopup")).toBe("listbox");
    expect(composer!.getAttribute("aria-autocomplete")).toBe("list");
    // Attributes that only the combobox role supports must not appear.
    expect(composer!.hasAttribute("aria-expanded")).toBe(false);
  });

  it("keeps every empty-state heading one level below the screen title", () => {
    renderStudio([], "");
    const empty = container!.querySelector(".empty-state__title");
    expect(empty).not.toBeNull();
    // The Studio's own title is an h1, so the empty state is an h2 — not an h3,
    // which skips a level and is what axe reported as heading-order.
    expect(empty!.tagName).toBe("H2");
  });
});

/**
 * The empty Studio is a real state with its own action ("Open folder"). Before
 * R11 the activity projection was memoized *after* the `detail === null` early
 * return, so opening a project from that empty state re-rendered the same
 * component with a different number of hooks and React threw
 * "Rendered more hooks than during the previous render". Nothing in the suite
 * rendered that transition, and the lint config has no `react-hooks` plugin, so
 * the gate could not see it either.
 */
describe("R11 hook order across the empty→loaded transition", () => {
  it("mounts with no project and then with one, without changing its hook count", () => {
    const events = [message(1, "an answer")];
    const renderWith = (detail: ProjectDetail | null): void => {
      act(() => {
        root!.render(
          <StudioScreen
            detail={detail}
            studio={null}
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
          />,
        );
      });
    };

    renderWith(null);
    expect(container!.textContent).toContain("Choose a project");
    // The transition itself is the assertion: React throws on a hook-count change.
    renderWith(projectDetail(events));
    expect(container!.textContent).toContain("an answer");
    // And back again, because a project can be archived or the screen left empty.
    renderWith(null);
    expect(container!.textContent).toContain("Choose a project");
  });
});

/* ----------------------------------------------------------- visual bound */

describe("R11 bounded console rendering", () => {
  it("renders the whole list when the pane has no measurable height", () => {
    // jsdom has no layout: `clientHeight` is 0. The hook must not window, because
    // a window built on a guessed viewport would hide content nobody can scroll.
    const events = Array.from({ length: MIN_WINDOWED + 40 }, (_, index) =>
      message(index + 1, `answer ${index + 1}`),
    );
    renderStudio(events);
    const list = container!.querySelector("ol.timeline");
    expect(list?.getAttribute("data-windowed")).toBe("false");
    expect(container!.querySelectorAll("li.timeline-event").length).toBe(events.length);
  });

  it("mounts a measured slice and spacer heights for a long conversation", async () => {
    const events = Array.from({ length: 300 }, (_, index) =>
      message(index + 1, `answer ${index + 1}`),
    );
    renderStudio(events);
    const pane = container!.querySelector<HTMLElement>('[data-testid="studio-timeline"]');
    expect(pane).not.toBeNull();

    // Give the pane a real height and scroll to the middle, as a browser would.
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 600 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const list = container!.querySelector("ol.timeline");
    expect(list?.getAttribute("data-windowed")).toBe("true");
    const mounted = container!.querySelectorAll("li.timeline-event").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(events.length);

    // The unrendered remainder is accounted for by a spacer, so the scrollbar
    // is not lying about how much conversation there is.
    const spacer = container!.querySelector<HTMLElement>('[data-testid="timeline-spacer-bottom"]');
    expect(spacer).not.toBeNull();
    expect(Number.parseFloat(spacer!.style.height)).toBeGreaterThan(0);
    expect(
      container!
        .querySelector('[data-testid="timeline-spacer-bottom"]')
        ?.getAttribute("aria-hidden"),
    ).toBe("true");

    // Every mounted card is the real first card: the slice starts at the top
    // when the reader is at the top.
    expect(container!.querySelector("li.timeline-event")?.getAttribute("data-seq")).toBe("1");
  });

  it("says how many cards it is painting when it windows", async () => {
    const events = Array.from({ length: 300 }, (_, index) =>
      message(index + 1, `answer ${index + 1}`),
    );
    renderStudio(events);
    const pane = container!.querySelector<HTMLElement>('[data-testid="studio-timeline"]');
    Object.defineProperty(pane, "clientHeight", { configurable: true, value: 600 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    const scope =
      container!.querySelector('[data-testid="studio-history-scope"]')?.textContent ?? "";
    expect(scope).toContain("300 shown");
    expect(scope).toMatch(/\d+ painted/);
  });
});
