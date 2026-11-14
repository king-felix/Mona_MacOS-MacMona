// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ProjectSummary } from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { emptyStudioUsageView } from "../src/shared/contracts/usage-hud";
import type { PolishDigestView, PolishStatusView } from "../src/shared/contracts/polish";
import { defaultPolishPreferences } from "../src/shared/contracts/polish";
import { HomeScreen } from "../src/renderer/shell/Home";
import { StudioScreen } from "../src/renderer/shell/Studio";
import { SettingsScreen } from "../src/renderer/shell/Settings";

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
  (window as unknown as { mona: unknown }).mona = {
    serviceStatus: async () => ({
      supported: true,
      installed: true,
      installPath: "/Users/example/Library/Services/Mona.service",
      installPathDisplay: "~/Library/Services/Mona.service",
      scope: "development",
      registration: "registered",
      enabled: "enabled",
      menuTitle: "Start new DS project with Mona",
      message: "registered",
      appIdentity: "Mona",
      packaged: false,
      lastHandoff: null,
      recovery: [],
      detail: [],
      checkedAt: "2026-11-12T00:00:00.000Z",
    }),
    // P23: the Updates tab reads these on mount. This fixture models the real
    // bridge shape; a value of `null` here would make the tab claim "unavailable"
    // and hide the controls the test is not exercising.
    updateStatus: async () => ({
      ok: true,
      value: {
        current: {
          version: "0.1.0",
          build: 81,
          channel: "local",
          schemaVersion: 8,
          engineVersion: "0.10.2",
        },
        config: {
          schemaVersion: 1,
          mode: "manual",
          baseUrl: null,
          manifestPath: null,
          teamId: null,
          manifestKey: null,
          allowLocalPackages: true,
        },
        configProblem: null,
        source: {
          baseUrl: null,
          host: null,
          manifestAuthenticated: false,
          keyFingerprint: null,
        },
        lastCheck: null,
        lastIntent: null,
        history: [],
        deferral: {
          deferred: false,
          items: [],
          reason: "No task, turn, or runtime is active.",
          action: "An update can be verified and handed to Installer now.",
        },
        note: "Manual package updates.",
      },
    }),
    uninstallGuide: async () => ({
      ok: true,
      value: {
        applied: false,
        installedReceipt: null,
        ownershipManifestPresent: false,
        entries: [],
        userDataScopes: [],
        preserves: [],
        utility: {
          path: null,
          signed: false,
          commands: { dryRun: "", removeService: "", removeUserData: "" },
        },
        note: "This copy was not installed by the package.",
      },
    }),
    stateRecovery: async () => ({
      ok: true,
      value: {
        buildSchemaVersion: 8,
        databaseSchemaVersion: 8,
        state: "ok",
        problem: null,
        snapshots: [],
        journal: null,
        support: { supportPath: "/tmp", backupsPath: "/tmp", reportPath: null, instruction: "" },
        canRestoreSnapshot: false,
        note: "A restore replaces the whole database with the snapshot.",
      },
    }),
  };
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

const project: ProjectSummary = {
  id: "prj_0123456789abcdef",
  name: "Polish project",
  rootPath: "/Users/example/projects/polish",
  canonicalPath: "/Users/example/projects/polish",
  repositoryKind: "git",
  repositoryRoot: "/Users/example/projects/polish",
  worktreeName: null,
  accent: "mint",
  monogram: "PP",
  archived: false,
  pinned: false,
  removedAt: null,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  revision: 3,
};

function detail(): ProjectDetail {
  return {
    project,
    tasks: [],
    dependencies: [],
    threads: [],
    currentThreadId: "thr_0123456789abcdef",
    draft: null,
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
    branch: "main",
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
    projectId: project.id,
    connection: {
      state: "connected",
      reason: "ready",
      since: "2026-11-12T00:00:00.000Z",
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
      effective: null,
      effectiveTurnId: null,
    },
    cost: { observed: true, costUsd: 0.0042, costComplete: true, turns: 1, label: "$0.0042" },
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

function digest(): PolishDigestView {
  return {
    resume: {
      projectId: project.id,
      projectName: project.name,
      generatedAt: "2026-11-12T10:00:00.000Z",
      source: {
        lastSeenAt: "2026-11-12T08:00:00.000Z",
        eventsConsidered: 12,
        tasksConsidered: 3,
        changeSetsConsidered: 2,
      },
      currentTask: {
        id: "tsk_0123456789abcdef",
        title: "Make the catalog real",
        status: "blocked",
        prompt: "Keep drafts local.",
        nextStep: "unblock MONA-011",
      },
      lastVerifiedStep: "write the test",
      unresolvedBlocker: {
        problemId: "prb_0123456789abcdef",
        taskId: "tsk_0123456789abcdef",
        taskTitle: "Make the catalog real",
        requirement: "MONA-011",
        helpNeeded: "A decision about the cache key is required.",
        totalAttempts: 3,
        noProgressAttempts: 3,
        evidence: ["docs/evidence/attempt.txt"],
        blockedAt: "2026-11-12T09:30:00.000Z",
      },
      blockers: [],
      testResult: {
        available: true,
        satisfiedChecks: 1,
        totalChecks: 2,
        label: "1 of 2 acceptance checks satisfied · not verified",
        lastEvidencePath: "docs/evidence/attempt.txt",
        lastAt: "2026-11-12T09:00:00.000Z",
        observedCommand: {
          command: "npm test",
          status: "completed",
          at: "2026-11-12T09:00:00.000Z",
        },
        note: "Checks are satisfied only by a recorded action with evidence.",
      },
      changes: {
        available: true,
        countedFiles: 2,
        turns: 1,
        unreceiptedPaths: 1,
        truncated: false,
        label: "2 files in 1 recorded turn · 1 unreceipted",
        note: "Counts come from settled engine receipts.",
      },
      spend: {
        observed: true,
        knownUsd: 0.0042,
        complete: false,
        label: "At least $0.0042; 1 of 2 turns unpriced",
        reportedTurns: 1,
        estimatedTurns: 0,
        unknownTurns: 1,
        missingTurns: 0,
      },
      nextStep: 'Unblock MONA-011 on "Make the catalog real": A decision is required.',
      facts: [
        {
          label: "Unresolved blocker",
          value: "MONA-011 · A decision is required.",
          tone: "danger",
        },
        { label: "Current prompt", value: "Make the catalog real · blocked", tone: "danger" },
        { label: "Test result", value: "1 of 2 acceptance checks satisfied", tone: "attention" },
        { label: "Changed files", value: "2 files in 1 recorded turn", tone: "neutral" },
        { label: "Spend confidence", value: "At least $0.0042", tone: "attention" },
      ],
      noCompletionPercentage: true,
    },
    sinceYouLeft: {
      projectId: project.id,
      since: "2026-11-12T08:00:00.000Z",
      generatedAt: "2026-11-12T10:00:00.000Z",
      groups: [
        {
          id: "completion",
          title: "Finished",
          entries: [
            {
              key: "thr_0123456789abcdef:1",
              group: "completion",
              title: "Turn completed · 2 file receipts",
              detail: "src/app.ts, src/test.ts",
              at: "2026-11-12T09:00:00.000Z",
              taskId: "tsk_0123456789abcdef",
              turnId: "turn_0123456789abcdef",
              changeSetId: "chs_0123456789abcdef",
              problemId: null,
              evidencePath: null,
              screen: "changes",
            },
          ],
        },
        {
          id: "blocker",
          title: "Needs you",
          entries: [
            {
              key: "blocker:prb_0123456789abcdef",
              group: "blocker",
              title: "Blocked: Make the catalog real",
              detail: "A decision about the cache key is required.",
              at: "2026-11-12T09:30:00.000Z",
              taskId: "tsk_0123456789abcdef",
              turnId: null,
              changeSetId: null,
              problemId: "prb_0123456789abcdef",
              evidencePath: "docs/evidence/attempt.txt",
              screen: "board",
            },
          ],
        },
      ],
      entryCount: 2,
      duplicatesSuppressed: 1,
      note: "Grouped from stored engine events, task transitions, blockers, and receipts. No model summarized this.",
    },
  };
}

function polishStatus(): PolishStatusView {
  return {
    preferences: defaultPolishPreferences("UTC"),
    attention: {
      badge: "2",
      menuTitle: "◐ 1 blocked",
      tooltip: "Mona · idle · 1 blocked",
      running: false,
      blocked: 1,
      unseenCompletions: 1,
      installed: true,
      updatedAt: "2026-11-12T10:00:00.000Z",
      note: "menu-bar status is installed",
    },
    keepAwake: { active: false, scopedToActiveWork: true, note: "no active work" },
    launchAtLogin: { enabled: false, applied: false, note: "Launch at login is off." },
    menuBar: { installed: true, note: "menu-bar status is installed" },
    notifications: {
      available: true,
      note: "macOS notifications are available.",
      recent: [
        {
          key: "task-completed:tsk_0123456789abcdef",
          kind: "completion",
          projectId: project.id,
          delivered: true,
          delivery: "shown",
          suppressedReason: null,
          title: "Mona · work finished",
          body: "Open Mona to review the project record.",
          at: "2026-11-12T09:00:00.000Z",
        },
      ],
    },
  };
}

function noop(): void {
  return undefined;
}

function home(digestValue: PolishDigestView | null) {
  const actions = {
    onQuery: noop,
    onToggleArchived: noop,
    onOpenFolder: noop,
    onSelect: noop,
    onRename: noop,
    onPin: noop,
    onArchive: noop,
    onRemove: noop,
    onRelocate: noop,
    onReveal: noop,
    onEditIdentity: noop,
    onOpenScreen: noop,
    onRevealEvidence: noop,
  };
  return (
    <HomeScreen
      catalog={[project]}
      selectedId={project.id}
      query=""
      showArchived={false}
      busy={false}
      digest={digestValue}
      {...actions}
    />
  );
}

describe("Home Resume Brief", () => {
  it("renders the brief, the blocker, and the catch-up groups from records", () => {
    act(() => root?.render(home(digest())));
    const text = container?.textContent ?? "";
    expect(container?.querySelector('[data-testid="resume-brief"]')).toBeTruthy();
    expect(text).toContain("Resume Brief");
    expect(text).toContain("Unresolved blocker · MONA-011");
    expect(text).toContain("A decision about the cache key is required.");
    expect(text).toContain("Next exact action");
    expect(text).toContain("Since you left");
    expect(text).toContain("Turn completed · 2 file receipts");
    expect(text).toContain("Blocked: Make the catalog real");
    expect(text).toContain("1 duplicate event row ignored");
    expect(text).toContain("no model call");
    expect(text).not.toMatch(/\d+%/);
  });

  it("says to select a project instead of fabricating a brief", () => {
    act(() => root?.render(home(null)));
    expect(container?.querySelector('[data-testid="resume-empty"]')).toBeTruthy();
  });
});

describe("Studio Focus Mode", () => {
  const baseProps = {
    detail: detail(),
    studio: studio(),
    studioBusy: false,
    mode: "work" as const,
    draft: "Review the diff.",
    draftStatus: "saved" as const,
    inspectorTab: "task",
    onInspectorTab: noop,
    onDraft: noop,
    onMode: noop,
    onOpenFolder: noop,
    onShowBoard: noop,
    onStart: noop,
    onSubmit: noop,
    onInterrupt: noop,
    onPause: noop,
    onResumeQueue: noop,
    onCancelQueued: noop,
    onStop: noop,
    onReconcile: noop,
    favorites: [
      {
        id: "fav_00000001",
        label: "Review",
        text: "Review the diff.",
        createdAt: "2026-11-12T08:00:00.000Z",
        updatedAt: "2026-11-12T08:00:00.000Z",
      },
    ],
    onToggleFocus: noop,
    onUseFavorite: noop,
    onRequestSaveFavorite: noop,
    onRemoveFavorite: noop,
  };

  it("hides the inspector but keeps the emergency controls", () => {
    act(() => root?.render(<StudioScreen {...baseProps} focusMode={true} />));
    expect(container?.querySelector('[data-focus-mode="on"]')).toBeTruthy();
    expect(container?.querySelector('[aria-label="Inspector"]')).toBeNull();
    expect(container?.querySelector(".control-strip")).toBeTruthy();
    expect(container?.textContent).toContain("Interrupt now");
    expect(container?.textContent).toContain("Pause after task");
    expect(container?.textContent).toContain("Review");
  });

  it("shows the inspector when Focus Mode is off", () => {
    act(() => root?.render(<StudioScreen {...baseProps} focusMode={false} />));
    expect(container?.querySelector('[data-focus-mode="off"]')).toBeTruthy();
    expect(container?.querySelector('[aria-label="Inspector"]')).toBeTruthy();
  });
});

describe("Settings and attention", () => {
  it("exposes notification, quiet-hour, keep-awake, and login controls", async () => {
    const patch = vi.fn();
    const test = vi.fn();
    await act(async () =>
      root?.render(
        <SettingsScreen
          app={null}
          paths={null}
          facts={null}
          runtime={null}
          detail={detail()}
          tools={[]}
          theme="daybreak"
          density="comfortable"
          onTheme={noop}
          onDensity={noop}
          polish={polishStatus()}
          onPatchPreferences={patch}
          onTestNotification={test}
          onQuit={noop}
        />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const tab = Array.from(container?.querySelectorAll('[role="tab"]') ?? []).find(
      (node) => (node.textContent ?? "").trim() === "Attention",
    );
    expect(tab).toBeTruthy();
    act(() => (tab as HTMLElement).click());
    const text = container?.textContent ?? "";
    expect(text).toContain("Notifications");
    expect(text).toContain("Quiet hours");
    expect(text).toContain("Keep the Mac awake while work is active");
    expect(text).toContain("Open Mona at login");
    expect(text).toContain("Launch at login");
    expect(text).toContain("Send test notification");
    expect(text).toContain("menu-bar status is installed");
    const loginSwitch = Array.from(container?.querySelectorAll('[role="switch"]') ?? []).find(
      (node) => (node.textContent ?? "").includes("Open Mona at login"),
    );
    expect(loginSwitch?.getAttribute("aria-checked")).toBe("false");
    const testButton = Array.from(container?.querySelectorAll("button") ?? []).find((node) =>
      (node.textContent ?? "").includes("Send test notification"),
    );
    act(() => (testButton as HTMLElement).click());
    expect(test).toHaveBeenCalledTimes(1);
  });
});
