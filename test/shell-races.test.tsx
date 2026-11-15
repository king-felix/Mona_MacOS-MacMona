// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts/ids";
import type {
  HistoryPage,
  IpcResult,
  ProjectDetail,
  ProjectSummary,
} from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot, StudioSubmitResult } from "../src/shared/contracts/studio";
import { emptyStudioUsageView } from "../src/shared/contracts/usage-hud";
import type { MonaBridge, WindowFullscreenView } from "../src/shared/contracts/bridge";
import { Shell } from "../src/renderer/shell/Shell";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import type { CommandCatalogSnapshot } from "../src/shared/contracts/commands";
import type {
  CommandExecuteRequest,
  CommandReceipt,
} from "../src/shared/contracts/command-execution";

/**
 * R01 acceptance at the component boundary: real Shell, real StudioScreen, a
 * fake bridge whose IPC answers the test releases by hand. Each case turns a
 * user ordering (type during send, switch during send, reversed loads, late
 * acknowledgement) into a deterministic deferred-promise sequence.
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
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  delete document.body.dataset.ready;
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const A = "prj_aaaaaaaaaaaaaaaa" as ProjectId;
const B = "prj_bbbbbbbbbbbbbbbb" as ProjectId;
const C = "prj_cccccccccccccccc" as ProjectId;

function project(id: ProjectId, name: string): ProjectSummary {
  return {
    id,
    name,
    rootPath: `/Users/example/projects/${name}`,
    canonicalPath: `/Users/example/projects/${name}`,
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
  };
}

function detail(summary: ProjectSummary, draftText: string | null = null): ProjectDetail {
  return {
    project: summary,
    tasks: [],
    dependencies: [],
    threads: [
      {
        id: `thr_${summary.id.slice(4)}`,
        title: null,
        engineThreadId: null,
        updatedAt: "2026-11-11T00:00:00.000Z",
      },
    ],
    currentThreadId: `thr_${summary.id.slice(4)}`,
    draft: draftText === null ? null : { threadId: `thr_${summary.id.slice(4)}`, text: draftText },
    events: [],
    history: { olderCursor: null, hasMore: false, storedTotal: 0, pageSize: 0 },
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

function studioSnapshot(id: ProjectId): StudioSnapshot {
  return {
    projectId: id,
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
    threadId: `thr_${id.slice(4)}`,
    engineThreadId: `thr_${id.slice(4)}`,
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
      effective: null,
      effectiveTurnId: null,
    },
    cost: { observed: false, costUsd: 0, costComplete: false, turns: 0, label: "unpriced" },
    submission: null,
    diagnostics: [],
    followUps: [],
    steering: { available: false, reason: "test fixture: no steer route", requiredRoute: null },
    usage: emptyStudioUsageView(),
    pendingRequests: [],
    canSubmit: true,
    cannotSubmitReason: null,
    controls: { canInterrupt: false, canPause: true, canCancelQueued: false, canStop: true },
  };
}

function acceptedResult(id: ProjectId, turnId = "turn_0000000000000001"): StudioSubmitResult {
  return {
    outcome: "accepted",
    operationKey: "op_key_000000000001",
    turnId,
    note: null,
    guidance: null,
    reconciliation: null,
    snapshot: studioSnapshot(id),
  };
}

interface SaveCall {
  projectId: string;
  threadId: string;
  text: string;
}

interface SubmitCall {
  projectId: string;
  prompt: string;
  mode: string;
}

interface CommandCall {
  projectId: string;
  mode: string;
  spelling: string;
  arguments: string;
  operationKey: string;
  confirm?: boolean;
  resolveBusy?: "interrupt";
}

interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface World {
  catalog: ProjectSummary[];
  details: Map<string, ProjectDetail>;
  detailGates: Map<string, Gate<IpcResult<ProjectDetail>>>;
  saveCalls: SaveCall[];
  submitCalls: SubmitCall[];
  /** When set, each save waits for its own gate until the test releases it. */
  saveManual: boolean;
  saveGates: Array<Gate<IpcResult<{ saved: boolean }>>>;
  saveResult: IpcResult<{ saved: boolean }> | null;
  submitGate: Gate<IpcResult<StudioSubmitResult>> | null;
  submitResult: IpcResult<StudioSubmitResult> | null;
  historyGate: Gate<IpcResult<HistoryPage>> | null;
  catalogResult: IpcResult<CommandCatalogSnapshot> | null;
  commandCalls: CommandCall[];
  commandResult: ((input: CommandCall) => IpcResult<CommandReceipt>) | null;
  /** When set, executeCommand waits for this gate before answering. */
  commandGate: Gate<IpcResult<CommandReceipt>> | null;
  historyThreadCalls: Array<string | null>;
  /** R05: the window's observed native-fullscreen state and its listeners. */
  fullscreenView: WindowFullscreenView;
  fullscreenWrites: boolean[];
  fullscreenListeners: Array<(view: WindowFullscreenView) => void>;
  toggleFocusListeners: Array<() => void>;
  savedViews: Array<Record<string, unknown>>;
  /** R10: the project each conversation search was run against. */
  searchCalls: Array<{ projectId: string; query: string }>;
}

function world(projects: ProjectSummary[]): World {
  return {
    catalog: projects,
    details: new Map(),
    detailGates: new Map(),
    saveCalls: [],
    submitCalls: [],
    saveManual: false,
    saveGates: [],
    saveResult: null,
    submitGate: null,
    submitResult: null,
    historyGate: null,
    catalogResult: null,
    commandCalls: [],
    commandResult: null,
    commandGate: null,
    historyThreadCalls: [],
    fullscreenView: { fullscreen: false, pending: false, available: true, epoch: 0 },
    fullscreenWrites: [],
    fullscreenListeners: [],
    toggleFocusListeners: [],
    savedViews: [],
    searchCalls: [],
  };
}

/** A receipt shaped exactly like the main-process dispatcher's. */
function receipt(overrides: Partial<CommandReceipt> = {}): CommandReceipt {
  return {
    command: "help",
    spelling: "help",
    route: "terminal",
    status: "deferred",
    note: "The CLI prints its own command help. Nothing was run. The terminal pane is prefilled.",
    detail: [],
    cost: "none",
    sideEffects: ["none"],
    target: { screen: null, settingsTab: null, invocation: "codewhale help" },
    thread: null,
    operationKey: "cmd-receipt-0001",
    duplicate: false,
    snapshot: null,
    ...overrides,
  };
}

function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

function install(state: World): void {
  const handlers: Record<string, (...args: never[]) => unknown> = {
    getAppInfo: async () => ({
      name: "Mona",
      version: "0.1.0-test",
      electron: "45.3.0",
      chrome: "140",
      node: "24",
      platform: "darwin",
      arch: "arm64",
      packaged: false,
    }),
    getPaths: async () => ({ support: "/tmp/mona", cache: "/tmp/mona", logs: "/tmp/mona" }),
    zoom: async () => ({ factor: 1, percent: "100%", steps: [1], min: 1, max: 2 }),
    discoverTools: async () => [],
    listProjects: async () => ok(state.catalog),
    projectDetail: async (id: string) => {
      const pending = state.detailGates.get(id);
      if (pending) return pending.promise;
      const value = state.details.get(id);
      if (!value) return { ok: false, error: { code: "NOT_FOUND", message: `no ${id}` } };
      return ok(value);
    },
    studioState: async (id: string) => ok(studioSnapshot(id as ProjectId)),
    projectHistory: async (_projectId: string, options?: { threadId?: string | null }) => {
      state.historyThreadCalls.push(options?.threadId ?? null);
      if (state.historyGate) return state.historyGate.promise;
      return ok({
        events: [],
        olderCursor: null,
        hasMore: false,
        storedTotal: 0,
        pageSize: 0,
        threadId: null,
      });
    },
    projectHistoryItem: async (projectId: string, threadId: string, itemId: string) =>
      ok({ threadId, itemId, events: [], truncated: false, storedCount: 0 }),
    polishDigest: async () => ({ ok: false, error: { code: "NONE", message: "no digest" } }),
    polishStatus: async () => ({ ok: false, error: { code: "NONE", message: "no status" } }),
    promptFavorites: async () => ok([]),
    searchHistory: async (projectId: string, query: string) => {
      state.searchCalls.push({ projectId, query });
      return ok({
        query,
        scannedAt: "2026-11-11T00:00:00.000Z",
        hits: query.trim()
          ? [
              {
                threadId: `thr_${projectId.slice(4)}`,
                seq: 4,
                itemId: "item_search",
                kind: "item.completed",
                timestamp: "2026-11-11T00:00:04.000Z",
                snippet: `${projectId} stored text mentions ${query}`,
              },
            ]
          : [],
      });
    },
    saveDraft: async (projectId: string, threadId: string, text: string) => {
      state.saveCalls.push({ projectId, threadId, text });
      if (state.saveManual) {
        const pending = gate<IpcResult<{ saved: boolean }>>();
        state.saveGates.push(pending);
        return pending.promise;
      }
      return state.saveResult ?? ok({ saved: true });
    },
    commandCatalog: async () => state.catalogResult ?? ok(buildCommandCatalog()),
    executeCommand: async (input: CommandExecuteRequest) => {
      const call: CommandCall = {
        projectId: input.projectId,
        mode: input.mode,
        spelling: input.spelling,
        arguments: input.arguments,
        operationKey: input.operationKey,
        ...(input.confirm ? { confirm: true } : {}),
        ...(input.resolveBusy ? { resolveBusy: input.resolveBusy } : {}),
      };
      state.commandCalls.push(call);
      if (state.commandGate) return state.commandGate.promise;
      if (state.commandResult) return state.commandResult(call);
      return ok(receipt({ spelling: input.spelling, operationKey: input.operationKey }));
    },
    submitTask: async (projectId: string, prompt: string, mode: string) => {
      state.submitCalls.push({ projectId, prompt, mode });
      if (state.submitGate) return state.submitGate.promise;
      return state.submitResult ?? ok(acceptedResult(projectId as ProjectId));
    },
    markPolishSeen: async () => ok({ marked: true }),
    saveProjectView: async (_id: string, view: Record<string, unknown>) => {
      state.savedViews.push(view);
      return ok({ saved: true });
    },
    windowFullscreen: async () => state.fullscreenView,
    setWindowFullscreen: async (value: boolean) => {
      state.fullscreenWrites.push(value);
      // Main answers with what the window has observed, which is still the old
      // state until the transition event arrives.
      return state.fullscreenView;
    },
    onFullscreenChanged: (callback: (view: WindowFullscreenView) => void) => {
      state.fullscreenListeners.push(callback);
      return () => undefined;
    },
    onToggleFocus: (callback: () => void) => {
      state.toggleFocusListeners.push(callback);
      return () => undefined;
    },
  };
  const bridge = new Proxy(
    {},
    {
      get: (_target, property) => {
        const name = String(property);
        if (name in handlers) return handlers[name];
        if (name.startsWith("on")) return () => () => undefined;
        if (name === "pathForDroppedFile") return () => null;
        return async () => ok(null);
      },
    },
  ) as unknown as MonaBridge;
  Object.defineProperty(window, "mona", { configurable: true, writable: true, value: bridge });
}

async function tick(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function textarea(): HTMLTextAreaElement {
  const element = container!.querySelector<HTMLTextAreaElement>("textarea");
  if (!element) throw new Error("composer textarea is not rendered");
  return element;
}

function type(value: string): void {
  const element = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickProject(id: ProjectId): void {
  const button = container!.querySelector<HTMLButtonElement>(`[data-project-id="${id}"]`);
  if (!button) throw new Error(`project ${id} is not in the catalog list`);
  act(() => {
    button.click();
  });
}

function clickSend(): void {
  const button = container!.querySelector<HTMLButtonElement>('[data-testid="studio-send"]');
  if (!button) throw new Error("send button is not rendered");
  act(() => {
    button.click();
  });
}

function commandEnter(): void {
  act(() => {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function headerTitle(): string {
  return container!.querySelector(".context-bar__title")?.textContent ?? "";
}

function draftHint(): string {
  return container!.querySelector(".composer__left .hint-line")?.textContent ?? "";
}

function noticeText(): string {
  return container!.querySelector(".notification__title")?.textContent ?? "";
}

function errorText(): string {
  return container!.querySelector(".callout")?.textContent ?? "";
}

async function boot(state: World): Promise<void> {
  delete document.body.dataset.ready;
  install(state);
  act(() => {
    root?.render(<Shell />);
  });
  await waitFor(() => document.body.dataset.ready === "true", "the shell to boot");
  await tick(6);
}

async function goHome(): Promise<void> {
  const button = container!.querySelector<HTMLButtonElement>(
    'nav[aria-label="Screens"] button[aria-label="Home"]',
  );
  if (!button) throw new Error("the Home rail item is not rendered");
  act(() => {
    button.click();
  });
  await waitFor(
    () => container!.querySelectorAll("[data-project-id]").length > 0,
    "the catalog list",
  );
}

async function openProject(id: ProjectId, name: string): Promise<void> {
  clickProject(id);
  await waitFor(() => headerTitle() === name, `the studio for ${name}`);
}

describe("shell selection epochs", () => {
  it("a slow A load cannot replace a later B selection", async () => {
    const state = world([project(C, "Start"), project(A, "Alpha"), project(B, "Beta")]);
    state.details.set(C, detail(state.catalog[0]!));
    state.details.set(B, detail(state.catalog[2]!));
    const slowA = gate<IpcResult<ProjectDetail>>();
    state.detailGates.set(A, slowA);
    await boot(state);

    clickProject(A); // slow load starts
    await tick(2);
    await openProject(B, "Beta");

    // A's response arrives last. The project id matches a project in the
    // catalogue, so only a selection epoch can reject it.
    await act(async () => {
      slowA.resolve(ok(detail(state.catalog[1]!)));
      await Promise.resolve();
    });
    await tick(6);
    expect(headerTitle()).toBe("Beta");
  });

  it("A→B→A applies the newest load, not the first one for the same project", async () => {
    const state = world([project(C, "Start"), project(A, "Alpha"), project(B, "Beta")]);
    state.details.set(C, detail(state.catalog[0]!));
    state.details.set(B, detail(state.catalog[2]!));
    const firstA = gate<IpcResult<ProjectDetail>>();
    state.detailGates.set(A, firstA);
    await boot(state);

    clickProject(A); // first A load, slow
    await tick(2);
    await openProject(B, "Beta");
    const secondA = gate<IpcResult<ProjectDetail>>();
    state.detailGates.set(A, secondA);
    await goHome();
    clickProject(A); // A again, also slow
    await tick(2);

    // The first A response is stale even though the current project is A.
    await act(async () => {
      firstA.resolve(ok(detail(state.catalog[1]!, "stale A draft")));
      await Promise.resolve();
    });
    await tick(6);
    // The stale load must not apply at all: the shell stays on the catalog
    // instead of opening A with the old payload.
    expect(container!.querySelector("textarea")).toBeNull();
    expect(headerTitle()).not.toBe("Alpha");

    await act(async () => {
      secondA.resolve(ok(detail(state.catalog[1]!, "fresh A draft")));
      await Promise.resolve();
    });
    await waitFor(() => textarea().value === "fresh A draft", "the newest A load");
  });
});

describe("shell submission identity", () => {
  it("keeps text typed during a send and sends exactly the claimed bytes", async () => {
    const state = world([project(A, "Alpha")]);
    state.details.set(A, detail(state.catalog[0]!));
    await boot(state);
    await openProject(A, "Alpha");
    state.submitGate = gate<IpcResult<StudioSubmitResult>>();

    type("Ship the fix");
    clickSend();
    await waitFor(() => state.submitCalls.length === 1, "the first submit");
    // The composer stays editable while the send is in flight.
    type("Ship the fix, then update the notes.");
    expect(state.submitCalls[0]!.prompt).toBe("Ship the fix");

    await act(async () => {
      state.submitGate!.resolve(ok(acceptedResult(A)));
      await Promise.resolve();
    });
    await tick(8);
    expect(state.submitCalls).toHaveLength(1);
    expect(textarea().value).toBe("Ship the fix, then update the notes.");
    // The newer text is queued by the normal debounce, then acknowledged.
    await wait(600);
    expect(draftHint()).toContain("Draft saved locally");
    expect(state.saveCalls.at(-1)?.text).toBe("Ship the fix, then update the notes.");
  });

  it("clears the composer when nothing changed during the send", async () => {
    const state = world([project(A, "Alpha")]);
    state.details.set(A, detail(state.catalog[0]!));
    await boot(state);
    await openProject(A, "Alpha");
    state.submitGate = gate<IpcResult<StudioSubmitResult>>();

    type("One short task");
    clickSend();
    await waitFor(() => state.submitCalls.length === 1, "the first submit");
    await act(async () => {
      state.submitGate!.resolve(ok(acceptedResult(A)));
      await Promise.resolve();
    });
    await waitFor(() => textarea().value === "", "the composer to clear");
    expect(state.saveCalls.some((call) => call.projectId === A && call.text === "")).toBe(true);
  });

  it("a switch during a send leaves the new project's draft untouched", async () => {
    const state = world([project(C, "Start"), project(A, "Alpha"), project(B, "Beta")]);
    state.details.set(C, detail(state.catalog[0]!));
    state.details.set(A, detail(state.catalog[1]!));
    state.details.set(B, detail(state.catalog[2]!, "B work in progress"));
    await boot(state);
    await openProject(A, "Alpha");
    state.submitGate = gate<IpcResult<StudioSubmitResult>>();

    type("Alpha task");
    clickSend();
    await waitFor(() => state.submitCalls.length === 1, "the first submit");
    await goHome();
    await openProject(B, "Beta");
    expect(textarea().value).toBe("B work in progress");

    await act(async () => {
      state.submitGate!.resolve(ok(acceptedResult(A)));
      await Promise.resolve();
    });
    await tick(8);
    expect(textarea().value).toBe("B work in progress");
    expect(state.saveCalls.some((call) => call.projectId === B && call.text === "")).toBe(false);
  });

  it("a repeated click and Command-Enter dispatch exactly once", async () => {
    const state = world([project(A, "Alpha")]);
    state.details.set(A, detail(state.catalog[0]!));
    await boot(state);
    await openProject(A, "Alpha");
    state.submitGate = gate<IpcResult<StudioSubmitResult>>();

    type("Only once");
    clickSend();
    clickSend();
    commandEnter();
    await tick(4);
    expect(state.submitCalls).toHaveLength(1);

    await act(async () => {
      state.submitGate!.resolve(ok(acceptedResult(A)));
      await Promise.resolve();
    });
    await tick(6);
    expect(state.submitCalls).toHaveLength(1);
    // The gate is released: a later, separate task may be sent.
    type("A second task");
    clickSend();
    await waitFor(() => state.submitCalls.length === 2, "a second submission after release");
  });
});

describe("shell draft saving", () => {
  it("never reports newer text saved when an older acknowledgement arrives late", async () => {
    const state = world([project(A, "Alpha")]);
    state.details.set(A, detail(state.catalog[0]!));
    await boot(state);
    await openProject(A, "Alpha");
    // From here every save waits for the test, including the ones a debounce
    // queued behind an edit.
    state.saveManual = true;

    const baseline = state.saveCalls.length;
    type("first draft");
    await wait(600); // debounce fires; this save is now in flight
    expect(state.saveCalls.length - baseline).toBe(1);

    // Typing while the older save is still unacknowledged.
    type("first draft, extended");
    expect(draftHint()).toContain("Saving draft");

    // The older write acknowledges; its reply says nothing about the newer text.
    await act(async () => {
      state.saveGates[0]!.resolve(ok({ saved: true }));
      await Promise.resolve();
    });
    await tick(6);
    expect(draftHint()).not.toContain("Draft saved locally");
    expect(textarea().value).toBe("first draft, extended");

    // The journal then writes the newest text, and only that write may say saved.
    await wait(600);
    expect(state.saveCalls.at(-1)?.text).toBe("first draft, extended");
    expect(draftHint()).toContain("Saving draft");
    await act(async () => {
      state.saveGates.at(-1)!.resolve(ok({ saved: true }));
      await Promise.resolve();
    });
    await waitFor(() => draftHint().includes("Draft saved locally"), "the newer text to be saved");
  });

  it("keeps the text and says so when a save is rejected", async () => {
    const state = world([project(A, "Alpha")]);
    state.details.set(A, detail(state.catalog[0]!));
    state.saveResult = {
      ok: false,
      error: { code: "CONFLICT", message: "draft thread does not belong to this project" },
    };
    await boot(state);
    await openProject(A, "Alpha");

    type("Do not lose this");
    await wait(600);
    expect(textarea().value).toBe("Do not lose this");
    expect(draftHint()).toContain("could not be saved");
    expect(errorText()).toContain("CONFLICT");
  });

  it("a restart restores the stored draft and sends nothing", async () => {
    const state = world([project(A, "Alpha")]);
    state.details.set(A, detail(state.catalog[0]!, "Restored draft"));
    await boot(state);
    await openProject(A, "Alpha");
    expect(textarea().value).toBe("Restored draft");
    expect(state.submitCalls).toHaveLength(0);
    expect(draftHint()).toContain("Draft saved locally");
  });
});

describe("R02 paged history in the real shell", () => {
  it("prepends an older page without moving the reader", async () => {
    const state = world([project(A, "A")]);
    const summary = project(A, "A");
    const current: ProjectDetail = detail(summary);
    current.events = [
      {
        threadId: `thr_${A.slice(4)}`,
        seq: 3,
        kind: "item.completed",
        payload: { item: { id: "item_3", kind: "agent_message", detail: "three" } },
        timestamp: "2026-11-11T00:00:03.000Z",
        turnId: null,
        itemId: "item_3",
      },
    ];
    current.history = {
      olderCursor: { recordedAt: "r3", rowId: 3 },
      hasMore: true,
      storedTotal: 3,
      pageSize: 1,
    };
    state.details.set(A, current);
    state.historyGate = gate<IpcResult<HistoryPage>>();
    install(state);
    act(() => root?.render(<Shell />));
    act(() => document.dispatchEvent(new Event("mona:ready")));
    document.body.dataset.ready = "true";
    await waitFor(
      () => container!.querySelectorAll("[data-project-id]").length > 0,
      "catalog cards",
    );
    act(() => {
      container!.querySelector<HTMLElement>("[data-project-id]")?.click();
    });
    await waitFor(() => document.documentElement.dataset.screen === "studio", "studio screen");
    const timeline = container!.querySelector<HTMLDivElement>('[data-testid="studio-timeline"]');
    if (!timeline) throw new Error("timeline is not rendered");
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 300 });
    timeline.scrollTop = 500;
    act(() => {
      timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    const loadEarlier = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Load earlier"),
    );
    if (!loadEarlier) throw new Error("load earlier is not offered");
    act(() => loadEarlier.click());
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 2_000 });
    state.historyGate.resolve(
      ok({
        events: [
          {
            threadId: `thr_${A.slice(4)}`,
            seq: 1,
            kind: "item.completed",
            payload: { item: { id: "item_1", kind: "agent_message", detail: "one" } },
            timestamp: "2026-11-11T00:00:01.000Z",
            turnId: null,
            itemId: "item_1",
          },
          {
            threadId: `thr_${A.slice(4)}`,
            seq: 2,
            kind: "item.completed",
            payload: { item: { id: "item_2", kind: "agent_message", detail: "two" } },
            timestamp: "2026-11-11T00:00:02.000Z",
            turnId: null,
            itemId: "item_2",
          },
        ],
        olderCursor: null,
        hasMore: false,
        storedTotal: 3,
        pageSize: 2,
        threadId: null,
      }),
    );
    await tick(8);
    expect(timeline.scrollTop).toBe(1_500);
    expect(container!.textContent).toContain("one");
    expect(container!.textContent).toContain("three");
  });
});

describe("R03 commands never reach the model", () => {
  async function openStudio(): Promise<World> {
    const state = world([project(C, "Start")]);
    state.details.set(C, detail(state.catalog[0]!));
    await boot(state);
    await openProject(C, "Start");
    return state;
  }

  it("dispatches a TUI-only command instead of submitting it as a prompt", async () => {
    const state = await openStudio();
    type("/help");
    commandEnter();
    await tick(8);
    expect(state.submitCalls).toHaveLength(0);
    expect(state.commandCalls.map((call) => call.spelling)).toEqual(["help"]);
    expect(noticeText()).toContain("Nothing was run");
    expect(textarea().value).toBe("/help");
  });

  it("reports an ambiguous prefix and selects nothing silently", async () => {
    const state = await openStudio();
    type("/he");
    commandEnter();
    await tick(4);
    expect(state.submitCalls).toHaveLength(0);
    expect(noticeText()).toContain("ambiguous");
    expect(noticeText()).toContain("/help");
  });

  it("names a required argument instead of sending the bare command", async () => {
    const state = await openStudio();
    type("/anchor");
    commandEnter();
    await tick(4);
    expect(state.submitCalls).toHaveLength(0);
    expect(noticeText()).toContain("needs an argument");
    expect(noticeText()).toContain("/anchor <text>");
  });

  it("fails closed on slash text when the catalog could not be loaded", async () => {
    const state = world([project(C, "Start")]);
    state.details.set(C, detail(state.catalog[0]!));
    state.catalogResult = {
      ok: false,
      error: { code: "RUNTIME_UNAVAILABLE", message: "catalog unreadable" },
    };
    await boot(state);
    await openProject(C, "Start");
    type("/help");
    commandEnter();
    await tick(4);
    expect(state.submitCalls).toHaveLength(0);
    expect(noticeText()).toContain("catalog is unavailable");
  });

  it("still sends ordinary prose as a prompt", async () => {
    const state = await openStudio();
    type("Investigate the failing test");
    commandEnter();
    await tick(6);
    expect(state.submitCalls).toHaveLength(1);
    expect(state.submitCalls[0]?.prompt).toBe("Investigate the failing test");
  });

  it("sends a slash path literally", async () => {
    const state = await openStudio();
    type("/Users/example/notes.md");
    commandEnter();
    await tick(6);
    expect(state.submitCalls).toHaveLength(1);
    expect(state.submitCalls[0]?.prompt).toBe("/Users/example/notes.md");
  });
});

function clickButtonContaining(text: string): void {
  const buttons = Array.from(container!.querySelectorAll<HTMLButtonElement>("button"));
  const button = buttons.find((candidate) => (candidate.textContent ?? "").includes(text));
  if (!button) throw new Error(`no button containing "${text}"`);
  act(() => {
    button.click();
  });
}

describe("R04 commands dispatch through the typed IPC route", () => {
  async function openStudio(): Promise<World> {
    const state = world([project(C, "Start")]);
    state.details.set(C, detail(state.catalog[0]!));
    await boot(state);
    await openProject(C, "Start");
    return state;
  }

  it("sends an alias-free spelling and the typed argument to main, not to the model", async () => {
    const state = await openStudio();
    type("/rename Payment retry");
    commandEnter();
    await tick(8);
    expect(state.submitCalls).toHaveLength(0);
    expect(state.commandCalls).toHaveLength(1);
    expect(state.commandCalls[0]).toMatchObject({
      projectId: C,
      mode: "work",
      spelling: "rename",
      arguments: "Payment retry",
    });
  });

  it("keeps the composer text for a command that is not /new", async () => {
    const state = await openStudio();
    type("/cost");
    commandEnter();
    await tick(8);
    expect(state.submitCalls).toHaveLength(0);
    expect(state.commandCalls[0]?.spelling).toBe("cost");
    expect(textarea().value).toBe("/cost");
  });

  it("renders a confirmation for a possible spend and reuses the same operation key", async () => {
    const state = await openStudio();
    state.commandResult = (call) =>
      ok(
        receipt({
          command: "compact",
          spelling: call.spelling,
          route: "native",
          status: call.confirm ? "completed" : "confirmation-required",
          note: call.confirm
            ? "Compaction: compacted 12 turns"
            : "Compacts the current conversation. Confirm to run /compact.",
          detail: call.confirm ? [] : ["Nothing has been sent yet."],
          operationKey: call.operationKey,
        }),
      );
    type("/compact");
    commandEnter();
    await tick(8);
    expect(state.commandCalls).toHaveLength(1);
    expect(container!.textContent).toContain("Nothing has been sent yet.");
    clickButtonContaining("Run /compact");
    await tick(8);
    expect(state.commandCalls).toHaveLength(2);
    expect(state.commandCalls[1]?.operationKey).toBe(state.commandCalls[0]?.operationKey);
    expect(state.commandCalls[1]?.confirm).toBe(true);
    expect(noticeText()).toContain("compacted 12 turns");
    expect(state.submitCalls).toHaveLength(0);
  });

  it("offers the wait/interrupt choice when /new meets a running turn", async () => {
    const state = await openStudio();
    state.commandResult = (call) =>
      ok(
        receipt({
          command: "new",
          spelling: "new",
          route: "native",
          status: call.resolveBusy ? "completed" : "busy",
          note: call.resolveBusy
            ? "New work conversation created."
            : "A work turn is running (turn_abc). Wait for it to finish, or choose Interrupt.",
          detail: call.resolveBusy
            ? []
            : ["Choose Wait, or choose Interrupt and start a new conversation."],
          operationKey: call.operationKey,
        }),
      );
    type("/new");
    commandEnter();
    await tick(8);
    expect(state.commandCalls).toHaveLength(1);
    expect(container!.textContent).toContain("Wait");
    clickButtonContaining("Interrupt and start a new conversation");
    await tick(8);
    expect(state.commandCalls).toHaveLength(2);
    expect(state.commandCalls[1]).toMatchObject({
      resolveBusy: "interrupt",
      operationKey: state.commandCalls[0]?.operationKey,
    });
  });

  it("keeps text typed while a /new dispatch is in flight", async () => {
    const state = await openStudio();
    const pending = gate<IpcResult<CommandReceipt>>();
    state.commandGate = pending;
    type("/new");
    commandEnter();
    await tick(2);
    expect(state.commandCalls).toHaveLength(1);
    // The user keeps typing before the engine answers. Those bytes were never
    // part of the dispatched revision and must survive it.
    type("/new then do X");
    pending.resolve(
      ok(
        receipt({
          command: "new",
          spelling: "new",
          route: "native",
          status: "completed",
          note: "New work conversation created.",
          thread: {
            mode: "work",
            generation: 1,
            localThreadId: "thr_new0000000000000",
            engineThreadId: "thr_engine00000000000",
            previousLocalThreadId: "thr_old0000000000000",
            previousEngineThreadId: "thr_older000000000000",
            preserved: { draft: true, history: true, usage: true },
          },
          operationKey: state.commandCalls[0]!.operationKey,
        }),
      ),
    );
    await tick(10);
    expect(state.submitCalls).toHaveLength(0);
    expect(textarea().value).toBe("/new then do X");
    // The notice says the newer text was kept, like the submit path does.
    expect(noticeText()).toContain("Text typed since sending was kept");
  });

  it("will not send into a conversation the reader is not looking at", async () => {
    const state = world([project(C, "Start")]);
    const base = detail(state.catalog[0]!);
    base.threads = [
      {
        id: "thr_current00000000",
        title: "Current",
        engineThreadId: "thr_e_current",
        updatedAt: "2026-11-11T00:00:00.000Z",
      },
      {
        id: "thr_archived0000000",
        title: "Earlier",
        engineThreadId: "thr_e_archived",
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    base.currentThreadId = "thr_current00000000";
    state.details.set(C, base);
    await boot(state);
    await openProject(C, "Start");

    const selector = container!.querySelector<HTMLSelectElement>(
      '[data-testid="studio-thread-select"]',
    );
    expect(selector).not.toBeNull();
    type("do the next thing");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(selector, "thr_archived0000000");
      selector!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await tick(8);

    const send = container!.querySelector<HTMLButtonElement>('[data-testid="studio-send"]');
    expect(send?.disabled).toBe(true);
    expect(container!.textContent).toContain("You are reading an earlier conversation");
    clickSend();
    await tick(6);
    expect(state.submitCalls).toHaveLength(0);
    // The draft is still there: blocking a send never discards text.
    expect(textarea().value).toBe("do the next thing");
  });

  it("keeps the command line when /new is refused as busy", async () => {
    const state = await openStudio();
    state.commandResult = (call) =>
      ok(
        receipt({
          command: "new",
          spelling: "new",
          route: "native",
          status: "busy",
          note: "A work turn is running. Wait, or choose Interrupt.",
          operationKey: call.operationKey,
        }),
      );
    type("/new");
    commandEnter();
    await tick(8);
    // A refusal is not a success: the line the user typed is still theirs.
    expect(textarea().value).toBe("/new");
    expect(state.submitCalls).toHaveLength(0);
    clickButtonContaining("Wait");
    await tick(4);
    expect(textarea().value).toBe("/new");
    expect(state.commandCalls).toHaveLength(1);
  });

  it("does not offer an interrupt for a command that cannot use one", async () => {
    const state = await openStudio();
    state.commandResult = (call) =>
      ok(
        receipt({
          command: "fork",
          spelling: "fork",
          route: "native",
          status: "busy",
          note: "a turn is active (turn_abc); fork waits for it to finish",
          operationKey: call.operationKey,
        }),
      );
    type("/fork");
    commandEnter();
    await tick(8);
    expect(state.commandCalls).toHaveLength(1);
    expect(container!.textContent).toContain("fork waits for it to finish");
    expect(container!.textContent).not.toContain("Interrupt and start a new conversation");
    clickButtonContaining("Close");
    await tick(4);
    expect(state.commandCalls).toHaveLength(1);
  });

  it("clears only the dispatched /new line and moves the reader to the new conversation", async () => {
    const state = await openStudio();
    state.commandResult = (call) =>
      ok(
        receipt({
          command: "new",
          spelling: "new",
          route: "native",
          status: "completed",
          note: "New work conversation created: local thr_new, engine thr_engine. The earlier conversation is unchanged.",
          thread: {
            mode: "work",
            generation: 1,
            localThreadId: "thr_new0000000000000",
            engineThreadId: "thr_engine00000000000",
            previousLocalThreadId: "thr_old0000000000000",
            previousEngineThreadId: "thr_older000000000000",
            preserved: { draft: true, history: true, usage: true },
          },
          operationKey: call.operationKey,
        }),
      );
    type("/new");
    commandEnter();
    await tick(8);
    expect(state.commandCalls[0]?.spelling).toBe("new");
    expect(state.submitCalls).toHaveLength(0);
    expect(textarea().value).toBe("");
    expect(noticeText()).toContain("New work conversation created");
    expect(state.historyThreadCalls).toContain("thr_new0000000000000");
  });

  it("keys the draft to the new conversation after /new", async () => {
    const state = await openStudio();
    const before = `thr_${C.slice(4)}`;
    state.commandResult = (call) =>
      ok(
        receipt({
          command: "new",
          spelling: "new",
          route: "native",
          status: "completed",
          note: "New work conversation created.",
          thread: {
            mode: "work",
            generation: 1,
            localThreadId: "thr_newconversation1",
            engineThreadId: "thr_engine00000000000",
            previousLocalThreadId: before,
            previousEngineThreadId: "thr_older000000000000",
            preserved: { draft: true, history: true, usage: true },
          },
          operationKey: call.operationKey,
        }),
      );
    type("/new");
    commandEnter();
    await tick(8);
    expect(textarea().value).toBe("");

    // The next keystroke belongs to the new conversation, not the old one.
    type("fix the flaky test");
    await wait(600);
    const saves = state.saveCalls.filter((call) => call.text === "fix the flaky test");
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.at(-1)?.threadId).toBe("thr_newconversation1");
    expect(saves.some((call) => call.threadId === before)).toBe(false);
  });

  it("refuses a conversation-rewriting command while an earlier conversation is selected", async () => {
    const state = world([project(C, "Start")]);
    const base = detail(state.catalog[0]!);
    base.threads = [
      {
        id: "thr_current00000000",
        title: "Current",
        engineThreadId: "thr_e_current",
        updatedAt: "2026-11-11T00:00:00.000Z",
      },
      {
        id: "thr_archived0000000",
        title: "Earlier",
        engineThreadId: "thr_e_archived",
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
    ];
    base.currentThreadId = "thr_current00000000";
    state.details.set(C, base);
    await boot(state);
    await openProject(C, "Start");

    const selector = container!.querySelector<HTMLSelectElement>(
      '[data-testid="studio-thread-select"]',
    );
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(selector, "thr_archived0000000");
      selector!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await tick(8);

    type("/rename Payment retry");
    commandEnter();
    await tick(8);
    // Nothing was rewritten: the command names a conversation on screen.
    expect(state.commandCalls).toHaveLength(0);
    expect(noticeText()).toContain("earlier one");
    expect(noticeText()).toContain("Nothing was sent");

    // `/cost` opens a screen, so it is still allowed from an archive view.
    type("/cost");
    commandEnter();
    await tick(8);
    expect(state.commandCalls.map((call) => call.spelling)).toEqual(["cost"]);
  });

  it("keeps a leading space as literal text, so a command can still be discussed", async () => {
    const state = await openStudio();
    type(" /new is a command I want to ask about");
    commandEnter();
    await tick(8);
    expect(state.commandCalls).toHaveLength(0);
    expect(state.submitCalls).toHaveLength(1);
    expect(state.submitCalls[0]?.prompt).toBe(" /new is a command I want to ask about");
  });

  it("dispatches one command exactly once for a repeated Command-Enter", async () => {
    const state = await openStudio();
    type("/compact");
    commandEnter();
    commandEnter();
    await tick(8);
    expect(state.commandCalls).toHaveLength(1);
  });
});

/**
 * R05 at the Shell boundary. The rules under test are the ones a component
 * test cannot see: the layout follows an observed window transition, the stored
 * view preference never learns the OS state, one key press cannot toggle twice
 * through the menu accelerator and the DOM handler, and none of it remounts the
 * Studio, which would drop the draft caret and the live turn.
 */
describe("focus Studio and native full screen", () => {
  async function openStudioInFocus(): Promise<World> {
    const state = world([project(C, "Start")]);
    state.details.set(C, detail(state.catalog[0]!));
    await boot(state);
    await openProject(C, "Start");
    return state;
  }

  function pressFocusShortcut(): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          metaKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it("follows the window's transition, not the request", async () => {
    const state = await openStudioInFocus();
    const control = container!.querySelector<HTMLButtonElement>('[data-testid="focus-fullscreen"]');
    expect(control).not.toBeNull();
    act(() => control!.click());
    await tick(4);
    // The ask reached main exactly once.
    expect(state.fullscreenWrites).toEqual([true]);
    // Main answered with the state the window still reports, so nothing moved.
    expect(document.documentElement.dataset.fullscreen).toBe("off");
    expect(container!.querySelector(".shell--focus")).toBeNull();

    // Now the window reports the transition.
    state.fullscreenView = { fullscreen: true, pending: false, available: true, epoch: 1 };
    act(() => {
      for (const listener of state.fullscreenListeners) listener(state.fullscreenView);
    });
    await tick(4);
    expect(document.documentElement.dataset.fullscreen).toBe("on");
    expect(container!.querySelector(".shell--focus")).not.toBeNull();
    expect(container!.querySelector('[data-testid="studio-focus-bar"]')).not.toBeNull();
    // Leaving full screen removes the immersive layout again.
    state.fullscreenView = { fullscreen: false, pending: false, available: true, epoch: 2 };
    act(() => {
      for (const listener of state.fullscreenListeners) listener(state.fullscreenView);
    });
    await tick(4);
    expect(container!.querySelector(".shell--focus")).toBeNull();
    expect(container!.querySelectorAll('[data-testid="studio-focus-bar"]')).toHaveLength(1);
  });

  it("keeps the composer element, text and selection across a layout change", async () => {
    await openStudioInFocus();
    type("half-written plan");
    const before = textarea();
    before.focus();
    before.setSelectionRange(4, 9);
    pressFocusShortcut();
    await tick(4);
    expect(document.documentElement.dataset.focusMode).toBe("on");
    const after = container!.querySelector("textarea");
    expect(after).toBe(before);
    expect(after?.value).toBe("half-written plan");
    expect(after?.selectionStart).toBe(4);
    expect(after?.selectionEnd).toBe(9);
    expect(document.activeElement).toBe(before);
    // No submit, no runtime start: a layout change is not an action.
    expect(container!.querySelector('[data-testid="studio-send"]')).not.toBeNull();
  });

  it("turns one deliberate press into one toggle", async () => {
    const state = await openStudioInFocus();
    pressFocusShortcut();
    await tick(2);
    expect(document.documentElement.dataset.focusMode).toBe("on");
    // The menu accelerator observes the same physical press and delivers its
    // event immediately after the DOM handler; the guard is what stops the
    // second observation from toggling back.
    act(() => {
      for (const listener of state.toggleFocusListeners) listener();
    });
    await tick(2);
    expect(document.documentElement.dataset.focusMode).toBe("on");
    // A later, deliberate second press does toggle off.
    await wait(240);
    act(() => {
      for (const listener of state.toggleFocusListeners) listener();
    });
    await tick(2);
    expect(document.documentElement.dataset.focusMode).toBe("off");
  });

  it("says so when macOS refuses the transition instead of failing silently", async () => {
    const state = await openStudioInFocus();
    act(() => {
      container!.querySelector<HTMLButtonElement>('[data-testid="focus-fullscreen"]')!.click();
    });
    await tick(3);
    // Main publishes the pending observation, then drops the intent: the window
    // never reported the state that was asked for.
    act(() => {
      for (const listener of state.fullscreenListeners) {
        listener({ fullscreen: false, pending: true, available: true, epoch: 0 });
      }
    });
    await tick(2);
    expect(
      container!.querySelector('[data-testid="focus-fullscreen"]')?.getAttribute("aria-busy"),
    ).toBe("true");
    act(() => {
      for (const listener of state.fullscreenListeners) {
        listener({ fullscreen: false, pending: false, available: true, epoch: 0 });
      }
    });
    await tick(2);
    expect(noticeText()).toContain("did not report a full screen transition");
    expect(document.documentElement.dataset.fullscreen).toBe("off");
  });

  it("stores the layout preference and never the OS full-screen state", async () => {
    const state = await openStudioInFocus();
    state.fullscreenView = { fullscreen: true, pending: false, available: true, epoch: 1 };
    act(() => {
      for (const listener of state.fullscreenListeners) listener(state.fullscreenView);
    });
    await tick(4);
    await wait(360);
    const stored = state.savedViews.at(-1);
    expect(stored).toBeDefined();
    expect(stored?.focusMode).toBe(false);
    expect(Object.keys(stored ?? {})).not.toContain("fullscreen");
  });

  it("leaves focus on Escape from the timeline, but not from the composer", async () => {
    await openStudioInFocus();
    pressFocusShortcut();
    await tick(4);
    expect(document.documentElement.dataset.focusMode).toBe("on");

    // The composer keeps Escape for its own command list; a keystroke there
    // must not drop the user out of the layout mid-sentence.
    textarea().focus();
    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await tick(2);
    expect(document.documentElement.dataset.focusMode).toBe("on");

    // Keyboard-only exit: Escape from the console does leave the layout, and it
    // never stops work.
    act(() => {
      container!.querySelector<HTMLElement>('[data-testid="studio-timeline"]')?.focus();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await tick(2);
    expect(document.documentElement.dataset.focusMode).toBe("off");
  });
});

describe("R10 search is scoped to the project it was run in", () => {
  it("drops results and the jump anchor when another project opens", async () => {
    const state = world([project(A, "A"), project(B, "B")]);
    for (const id of [A, B]) {
      const summary = project(id, id === A ? "A" : "B");
      const value: ProjectDetail = detail(summary);
      value.events = [
        {
          threadId: `thr_${id.slice(4)}`,
          seq: 4,
          kind: "item.completed",
          payload: { item: { id: "item_search", kind: "agent_message", detail: "parser" } },
          timestamp: "2026-11-11T00:00:04.000Z",
          turnId: null,
          itemId: "item_search",
        },
      ];
      state.details.set(id, value);
    }
    await boot(state);
    await openProject(A, "A");
    act(() =>
      Array.from(container!.querySelectorAll("button"))
        .find((button) => button.textContent === "Search")
        ?.click(),
    );
    const field = container!.querySelector<HTMLInputElement>(".history-search input");
    if (!field) throw new Error("the search field is not rendered");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(field, "parser");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(6);
    expect(state.searchCalls.at(-1)).toEqual({ projectId: A, query: "parser" });
    expect(container!.textContent).toContain("1 match");
    expect(container!.textContent).toContain(`${A} stored text mentions parser`);

    // Switching project must not leave the previous project's stored text on
    // screen, nor page the new project's history looking for the old anchor.
    await goHome();
    await openProject(B, "B");
    await tick(4);
    act(() =>
      Array.from(container!.querySelectorAll("button"))
        .find((button) => button.textContent === "Search")
        ?.click(),
    );
    const after = container!.querySelector<HTMLInputElement>(".history-search input");
    expect(after?.value).toBe("");
    expect(container!.textContent).not.toContain(`${A} stored text mentions parser`);
    expect(container!.textContent).toContain("Matches this project's stored text.");
  });
});
