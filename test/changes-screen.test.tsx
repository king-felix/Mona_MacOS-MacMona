// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "../src/shared/contracts/project-bridge";
import type { ChangesSnapshot, FileWindowView } from "../src/shared/contracts/changes";
import { ChangesScreen } from "../src/renderer/shell/Changes";

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
  vi.unstubAllGlobals();
});

function detail(): ProjectDetail {
  return {
    project: {
      id: "prj_0123456789abcdef",
      name: "Changes project",
      rootPath: "/Users/example/projects/changes",
      canonicalPath: "/Users/example/projects/changes",
      repositoryKind: "git",
      repositoryRoot: "/Users/example/projects/changes",
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
    events: [],
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
      blockedReason: "not running",
    },
  } as ProjectDetail;
}

function snapshot(overrides: Partial<ChangesSnapshot> = {}): ChangesSnapshot {
  return {
    projectId: "prj_0123456789abcdef" as never,
    sets: [
      {
        id: "chg_1",
        turnId: "turn_0123456789abcdef",
        threadId: "thr_0123456789abcdef",
        taskId: null,
        state: "settled",
        reason: null,
        preSnapshotId: "tree_pre_0123456789",
        postSnapshotId: "tree_post_0123456789",
        capturedAt: "2026-11-11T00:00:00.000Z",
        origin: "engine",
        truncated: false,
        omitted: null,
        files: [
          {
            artifactId: "file_app",
            path: "src/app.ts",
            previousPath: null,
            kind: "file",
            change: "updated",
            source: "tool_mutation",
            attribution: "tool",
            toolName: "edit_file",
            toolCallId: "call_1",
            itemId: "item_1",
            sizeBytes: 42,
            revision: "a".repeat(64),
            restoreSnapshotId: "tree_pre_0123456789",
            binaryHint: false,
            oversized: false,
          },
          {
            artifactId: "file_notes",
            path: "notes.txt",
            previousPath: null,
            kind: "file",
            change: "created",
            source: "workspace_changed_during_turn",
            attribution: "workspace_delta",
            toolName: null,
            toolCallId: null,
            itemId: null,
            sizeBytes: 12,
            revision: "b".repeat(64),
            restoreSnapshotId: null,
            binaryHint: false,
            oversized: false,
          },
        ],
        tools: [
          {
            itemId: "item_1",
            toolCallId: "call_1",
            toolName: "edit_file",
            status: "completed",
            summary: "edited src/app.ts",
            artifacts: [],
          },
        ],
        note: null,
      },
    ],
    git: {
      available: true,
      reason: null,
      root: "/Users/example/projects/changes",
      branch: "main",
      detached: false,
      worktree: "linked-review",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      head: {
        commit: "c".repeat(40),
        shortCommit: "ccccccc",
        subject: "base",
        committedAt: "2026-11-11T00:00:00.000Z",
      },
      entries: [
        {
          path: "src/app.ts",
          originalPath: null,
          indexStatus: ".",
          worktreeStatus: "M",
          staged: false,
          unstaged: true,
          untracked: false,
          conflicted: false,
          attribution: "tool",
          receipt: { changeSetId: "chg_1", turnId: "turn_0123456789abcdef", toolName: "edit_file" },
        },
        {
          path: "user-edit.txt",
          originalPath: null,
          indexStatus: ".",
          worktreeStatus: "?",
          staged: false,
          unstaged: false,
          untracked: true,
          conflicted: false,
          attribution: "unreceipted",
          receipt: null,
        },
      ],
      counts: { staged: 0, unstaged: 1, untracked: 1, conflicted: 0 },
      stagedBeforeReview: 0,
    },
    receipts: { available: false, reason: "Start the studio" },
    restore: { available: false, reason: "Start the studio for this project" },
    lastCommit: null,
    notes: [
      "A change receipt is the engine's record of what changed; it is not proof that every related file was written by the agent.",
    ],
    generatedAt: "2026-11-11T00:05:00.000Z",
    ...overrides,
  };
}

function fileWindow(): FileWindowView {
  return {
    path: "src/app.ts",
    mode: "text",
    availability: "available",
    content: "export const value = 1;\n",
    diff: null,
    encoding: "utf-8",
    offset: 0,
    nextOffset: 25,
    totalBytes: 25,
    truncated: false,
    revision: "a".repeat(64),
    source: "workspace",
    canEdit: false,
    note: null,
  };
}

function stubBridge(state: ChangesSnapshot) {
  const bridge = {
    changesSnapshot: vi.fn(async () => ({ ok: true, value: state })),
    refreshChanges: vi.fn(async () => ({ ok: true, value: state })),
    readChangeFile: vi.fn(async () => ({ ok: true, value: fileWindow() })),
    readChangeArtifact: vi.fn(async () => ({
      ok: true,
      value: {
        artifactId: "art_1",
        availability: "available",
        mediaType: null,
        sizeBytes: 4,
        content: "out\n",
        encoding: "utf-8",
        offset: 0,
        nextOffset: 4,
        truncated: false,
        note: null,
      },
    })),
    previewRestore: vi.fn(),
    restoreChanges: vi.fn(),
    stageGitPaths: vi.fn(),
    commitGitPaths: vi.fn(),
    writeWorkspaceFile: vi.fn(),
    revealWorkspacePath: vi.fn(async () => ({ ok: true, value: { revealed: true } })),
  };
  (window as unknown as { mona: unknown }).mona = bridge;
  return bridge;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("Changes screen", () => {
  it("shows receipts, honest attribution, and the Git worktree", async () => {
    stubBridge(snapshot());
    act(() => root?.render(<ChangesScreen detail={detail()} onOpenFolder={() => undefined} />));
    await settle();
    const text = container?.textContent ?? "";
    expect(text).toContain("Settled delta");
    expect(text).toContain("src/app.ts");
    expect(text).toContain("Tool: edit_file");
    expect(text).toContain("Workspace delta");
    expect(text).toContain("no restore point");
    expect(text).toContain("Tool and test receipts (1)");
    expect(text).toContain("changed during the turn, not attributed to a tool");

    // The workspace tab carries branch, worktree, and unreceipted work.
    const tabs = Array.from(container?.querySelectorAll('[role="tab"]') ?? []);
    const workspaceTab = tabs.find((tab) => tab.textContent?.includes("Workspace & Git"));
    expect(workspaceTab).toBeTruthy();
    act(() => (workspaceTab as HTMLElement).click());
    await settle();
    const workspaceText = container?.textContent ?? "";
    expect(workspaceText).toContain("worktree linked-review");
    expect(workspaceText).toContain("user-edit.txt");
    expect(workspaceText).toContain("No recorded turn names this path");
  });

  it("does not pretend a non-Git folder is a repository", async () => {
    stubBridge(
      snapshot({
        git: {
          available: false,
          reason: "this folder is not a Git worktree; Mona does not initialize one",
          root: null,
          branch: null,
          detached: false,
          worktree: null,
          upstream: null,
          ahead: null,
          behind: null,
          head: null,
          entries: [],
          counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
          stagedBeforeReview: 0,
        },
      }),
    );
    act(() => root?.render(<ChangesScreen detail={detail()} onOpenFolder={() => undefined} />));
    await settle();
    const tabs = Array.from(container?.querySelectorAll('[role="tab"]') ?? []);
    const workspaceTab = tabs.find((tab) => tab.textContent?.includes("Workspace & Git"));
    act(() => (workspaceTab as HTMLElement).click());
    await settle();
    expect(container?.textContent).toContain("This folder is not a Git worktree");
    expect(container?.textContent).toContain("Mona does not initialize one");
  });

  it("loads a text window lazily and shows restore availability honestly", async () => {
    const bridge = stubBridge(snapshot());
    act(() => root?.render(<ChangesScreen detail={detail()} onOpenFolder={() => undefined} />));
    await settle();
    const fileButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("src/app.ts"),
    );
    expect(fileButton).toBeTruthy();
    await act(async () => {
      (fileButton as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(bridge.readChangeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "prj_0123456789abcdef",
        path: "src/app.ts",
        mode: "text",
      }),
    );
    expect(container?.textContent).toContain("export const value = 1;");
    expect(container?.textContent).toContain("Start the studio for this project");
  });
});
