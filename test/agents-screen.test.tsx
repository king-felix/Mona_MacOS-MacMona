// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ProjectSummary } from "../src/shared/contracts/project-bridge";
import type { AgentRunView, FleetRunView, ObservatoryView } from "../src/shared/contracts/agents";
import type { BoardSnapshot } from "../src/shared/contracts/board";
import { AgentsScreen } from "../src/renderer/shell/Agents";

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

const project: ProjectSummary = {
  id: "prj_0123456789abcdef",
  name: "Agents project",
  rootPath: "/Users/example/projects/agents",
  canonicalPath: "/Users/example/projects/agents",
  repositoryKind: "git",
  repositoryRoot: "/Users/example/projects/agents",
  worktreeName: null,
  accent: "violet",
  monogram: "AP",
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

function agentRun(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    kind: "agent_run",
    runId: "agent_8f9c0296",
    workerId: "agent_8f9c0296",
    parentRunId: null,
    actorKind: "subagent",
    role: "explore",
    label: "explore · Count the files",
    objectiveSummary: "Count the files and report the exact count.",
    status: "running",
    rawStatus: "running",
    taskId: null,
    threadId: "thr_0123456789abcdef",
    originTurnId: "turn_0123456789abcdef",
    workspace: "/Users/example/projects/agents",
    branch: { name: "main", head: "abc1234", dirty: null, source: "local_git" },
    lastEvent: {
      seq: 2,
      at: "2026-11-12T07:45:30.000Z",
      status: "running",
      message: "running",
      kind: "lifecycle",
    },
    tools: { names: ["read_file"], source: "events", note: "Tool names come from events." },
    tests: {
      state: "self_reported",
      total: null,
      passed: null,
      failed: null,
      note: "No verified command or test receipt is attached.",
    },
    spend: {
      confidence: "unknown",
      usd: null,
      tokens: null,
      source: "sub-agent worker ledger",
      note: "Token usage is not yet reported by the sub-agent worker ledger.",
    },
    artifacts: [],
    children: [],
    startedAt: "2026-11-12T07:45:30.000Z",
    updatedAt: "2026-11-12T07:45:31.000Z",
    completedAt: null,
    terminal: false,
    ...overrides,
  };
}

function fleetRun(overrides: Partial<FleetRunView> = {}): FleetRunView {
  return {
    kind: "fleet_run",
    runId: "fleet-efb4a405",
    name: "p15-live-smoke",
    lifecycle: "completed",
    target: "this_computer",
    workflow: { id: "p15-live-smoke", kind: "parallel" },
    roles: ["reviewer"],
    createdAt: "2026-11-12T07:46:06Z",
    updatedAt: "2026-11-12T07:46:08Z",
    completedAt: null,
    taskCount: 1,
    workerCount: 1,
    taskId: null,
    linkedTaskRunId: null,
    lastEvent: {
      seq: null,
      at: "2026-11-12T07:46:08Z",
      status: "fleet.task.completed",
      message: "P15-OK",
      kind: "event",
    },
    events: [
      {
        seq: null,
        at: "2026-11-12T07:46:08Z",
        status: "fleet.task.completed",
        message: "P15-OK",
        kind: "event",
      },
    ],
    tasks: [
      {
        taskId: "answer",
        name: "Answer",
        status: "completed",
        workerId: "fleet-efb4a405-local-1",
        attempts: 1,
        role: "reviewer",
        receiptResult: "partial",
        score: { value: 0.5, max: 1, notes: "no scorer configured" },
      },
    ],
    workers: [
      {
        kind: "fleet_worker",
        workerId: "fleet-efb4a405-local-1",
        role: "reviewer",
        host: "local",
        status: "online",
        taskId: "answer",
        objective: null,
        lastEvent: {
          seq: 12,
          at: "2026-11-12T07:46:08Z",
          status: "completed",
          message: "completed exit_code=0 P15-OK",
          kind: "lifecycle",
        },
        heartbeatAt: "2026-11-12T07:46:08Z",
        artifacts: [],
        lastError: null,
        spend: {
          confidence: "unknown",
          usd: null,
          tokens: null,
          source: "fleet worker record",
          note: "This worker record carries no usage. Mona leaves spend unknown.",
        },
        tools: {
          names: [],
          source: "not_exposed",
          note: "This worker record names no tool calls.",
        },
        tests: {
          state: "unknown",
          total: null,
          passed: null,
          failed: null,
          note: "This worker record carries no test evidence.",
        },
        children: [],
      },
    ],
    receipts: [],
    spend: {
      confidence: "not_reported",
      usd: null,
      tokens: null,
      source: "fleet receipts",
      note: "Fleet receipts carry no token totals.",
    },
    aggregateNote: "Parent and child spend are never added. not additive across parent and child.",
    children: [],
    ...overrides,
  };
}

function observatory(overrides: Partial<ObservatoryView> = {}): ObservatoryView {
  return {
    projectId: project.id,
    observedAt: "2026-11-12T08:00:00.000Z",
    source: "engine",
    connected: true,
    reason: null,
    runs: [agentRun()],
    fleets: [fleetRun()],
    goals: [
      {
        threadId: "thr_0123456789abcdef",
        goalId: "goal-1",
        objective: "Finish the migration",
        status: "active",
        tokensUsed: 12,
        timeUsedSeconds: 3,
        continuationCount: 1,
        repeatedGapCount: 0,
        createdAt: "2026-11-12T07:45:00.000Z",
        updatedAt: "2026-11-12T07:45:10.000Z",
        source: "engine",
        stale: false,
      },
    ],
    summary: {
      runs: 2,
      running: 1,
      terminal: 1,
      failed: 0,
      interrupted: 0,
      unknownSpend: 1,
      goalsActive: 1,
      fleetRuns: 1,
      fleetWorkers: 1,
    },
    ownership: {
      oneMutatingRunPerWorkspace: true,
      activeTaskRunId: null,
      activeTaskId: null,
      activeOwner: null,
      note: "One mutating run per workspace.",
    },
    parallel: {
      requested: false,
      qualified: false,
      checks: [
        {
          id: "isolated_worktrees",
          label: "Isolated worktrees",
          passed: false,
          detail: "True per-task Git worktree isolation is not verified.",
        },
      ],
      note: "Serial one-task launch is the only qualified mode.",
    },
    capabilities: {
      agentRuns: true,
      agentRunCancel: true,
      goals: true,
      goalControls: true,
      fleetCreate: true,
      fleetStart: true,
      fleetStop: true,
      workerStop: true,
      workerRestart: true,
      fleetReceipts: true,
      fleetReplay: true,
    },
    gaps: [
      {
        id: "parallel-worktree-isolation",
        title: "Parallel builders in isolated worktrees",
        status: "gap",
        detail: "Mona refuses parallel launch rather than share one mutable tree.",
      },
    ],
    lastObservedAt: "2026-11-12T08:00:00.000Z",
    notes: [],
    ...overrides,
  };
}

function board(): BoardSnapshot {
  return {
    projectId: project.id,
    tasks: [],
    dependencies: [],
    problems: [],
    blocked: [],
    counts: {
      total: 0,
      pending: 0,
      running: 0,
      verifying: 0,
      completed: 0,
      blocked: 0,
      interrupted: 0,
      skipped: 0,
    },
    events: [],
    selection: null,
  } as unknown as BoardSnapshot;
}

function installMona(
  view: ObservatoryView,
  calls: { cancel?: number; detail?: number; goal?: number } = {},
): void {
  (window as unknown as { mona: unknown }).mona = {
    agentObservatory: async () => ({ ok: true, value: view }),
    boardSnapshot: async () => ({ ok: true, value: board() }),
    cancelAgentRun: async () => {
      calls.cancel = (calls.cancel ?? 0) + 1;
      return {
        ok: true,
        value: {
          action: "agent_run_cancel",
          accepted: true,
          status: 202,
          runId: "agent_8f9c0296",
          message: "Stop accepted; poll.",
          at: "2026-11-12T08:00:01.000Z",
          record: null,
        },
      };
    },
    agentFleetDetail: async () => {
      calls.detail = (calls.detail ?? 0) + 1;
      return { ok: true, value: fleetRun({ workers: [], receipts: [] }) };
    },
    setThreadGoal: async () => {
      calls.goal = (calls.goal ?? 0) + 1;
      return {
        ok: true,
        value: {
          action: "goal_set",
          accepted: true,
          status: 200,
          runId: "goal-1",
          message: "Goal set.",
          at: "2026-11-12T08:00:01.000Z",
          record: null,
        },
      };
    },
    controlFleetRun: async () => ({ ok: true, value: {} }),
    controlFleetWorker: async () => ({ ok: true, value: {} }),
    completeThreadGoal: async () => ({ ok: true, value: {} }),
    blockThreadGoal: async () => ({ ok: true, value: {} }),
    clearThreadGoal: async () => ({ ok: true, value: {} }),
    launchNativeFleet: async () => ({ ok: true, value: {} }),
  };
}

async function render(node: JSX.Element): Promise<void> {
  await act(async () => root?.render(node));
  await act(async () => {
    await Promise.resolve();
  });
}

describe("agents screen", () => {
  it("renders real run identities, unknown spend, and the serial boundary", async () => {
    installMona(observatory());
    await render(
      <AgentsScreen
        detail={detail()}
        engineThreadId="thr_0123456789abcdef"
        onOpenFolder={() => undefined}
        onShowStudio={() => undefined}
      />,
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("agent_8f9c0296");
    expect(text).toContain("p15-live-smoke");
    expect(text).toContain("Spend: Unknown");
    expect(text).toContain("Token usage is not yet reported");
    expect(text).toContain("receipt: partial");
    expect(text).toContain("Self-reported only");
    expect(text).toContain("Serial one-task launch is the only qualified mode.");
    expect(text).toContain("Parallel builders in isolated worktrees");
    expect(text).toContain("Finish the migration");
    expect(text).toContain("active goals");
  });

  it("selects a run and requires a deliberate confirmation before cancelling", async () => {
    const calls: { cancel?: number } = {};
    installMona(observatory(), calls);
    await render(
      <AgentsScreen
        detail={detail()}
        engineThreadId="thr_0123456789abcdef"
        onOpenFolder={() => undefined}
        onShowStudio={() => undefined}
      />,
    );
    const summary = Array.from(container?.querySelectorAll("summary") ?? []).find((node) =>
      node.textContent?.includes("agent_8f9c0296"),
    );
    expect(summary).toBeTruthy();
    await act(async () => {
      summary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const cancel = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Cancel run"),
    );
    expect(cancel).toBeTruthy();
    await act(async () => {
      cancel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container?.textContent).toContain("Cancel this sub-agent?");
    expect(calls.cancel ?? 0).toBe(0);
    const confirm = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Confirm stop"),
    );
    await act(async () => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.cancel).toBe(1);
  });

  it("shows a disconnected stored observation without enabled controls", async () => {
    installMona(
      observatory({
        source: "stored",
        connected: false,
        reason: "The live studio is not attached. Showing the last stored observation.",
        runs: [
          agentRun({
            status: "interrupted",
            terminal: true,
            spend: {
              confidence: "unknown",
              usd: null,
              tokens: null,
              source: "stored projection",
              note: "No spend value is retained locally.",
            },
          }),
        ],
        fleets: [],
      }),
    );
    await render(
      <AgentsScreen
        detail={detail()}
        engineThreadId={null}
        onOpenFolder={() => undefined}
        onShowStudio={() => undefined}
      />,
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("Not connected");
    expect(text).toContain("Showing the last stored observation");
    expect(text).toContain("Interrupted");
    // A stored goal is readable but every control is disabled without a thread.
    expect(text).toContain("Finish the migration");
    expect(text).toContain("This goal comes from a stored observation.");
    const complete = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === "Complete",
    );
    expect(complete?.disabled).toBe(true);
    // Engine controls are disabled too: a stored view cannot start an operation.
    const summary = Array.from(container?.querySelectorAll("summary") ?? []).find((node) =>
      node.textContent?.includes("agent_8f9c0296"),
    );
    await act(async () => {
      summary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const cancel = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Cancel run"),
    );
    expect(cancel?.disabled).toBe(true);
    expect(container?.textContent).toContain("Reconnect the studio to cancel a run");
  });

  it("refuses to offer a fleet launch the runtime cannot start", async () => {
    const view = observatory();
    view.capabilities = { ...view.capabilities, fleetStart: false, fleetCreate: false };
    installMona(view);
    await render(
      <AgentsScreen
        detail={detail()}
        engineThreadId="thr_0123456789abcdef"
        onOpenFolder={() => undefined}
        onShowStudio={() => undefined}
      />,
    );
    expect(container?.textContent).toContain("This runtime cannot start a fleet");
    expect(
      Array.from(container?.querySelectorAll("button") ?? []).some((button) =>
        button.textContent?.includes("Launch serial run"),
      ),
    ).toBe(false);
  });

  it("asks for a studio thread when no goal has ever been observed", async () => {
    installMona(
      observatory({
        source: "stored",
        connected: false,
        reason: "The live studio is not attached.",
        runs: [],
        fleets: [],
        goals: [],
      }),
    );
    await render(
      <AgentsScreen
        detail={detail()}
        engineThreadId={null}
        onOpenFolder={() => undefined}
        onShowStudio={() => undefined}
      />,
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("No active studio thread");
    expect(text).toContain("No native agent runs");
  });
});
