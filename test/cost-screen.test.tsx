// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CostLedgerView } from "../src/shared/contracts/cost";
import type { ProjectDetail } from "../src/shared/contracts/project-bridge";
import { CostScreen } from "../src/renderer/shell/Cost";

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
      name: "Cost project",
      rootPath: "/Users/example/projects/cost",
      canonicalPath: "/Users/example/projects/cost",
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
      blockedReason: "not running",
      binding: null,
    },
  } as unknown as ProjectDetail;
}

function totals(overrides: Partial<CostLedgerView["totals"]> = {}): CostLedgerView["totals"] {
  return {
    turns: 1,
    inputTokens: 1200,
    cachedTokens: 800,
    cacheMissTokens: 0,
    outputTokens: 40,
    reasoningTokens: 12,
    costUsd: 0,
    costPicoUsd: 0,
    costComplete: false,
    costBasis: "none",
    reportedTurns: 0,
    estimatedTurns: 0,
    unknownTurns: 1,
    missingTurns: 0,
    unallocatedTurns: 0,
    unallocatedUsd: 0,
    ...overrides,
  };
}

function ledger(overrides: Partial<CostLedgerView> = {}): CostLedgerView {
  return {
    projectId: "prj_0123456789abcdef",
    generatedAt: "2026-11-11T01:00:00.000Z",
    timeZone: "UTC",
    since: null,
    until: null,
    totals: totals(),
    byModel: [
      {
        key: "deepseek · deepseek-flash",
        label: "deepseek · deepseek-flash",
        totals: totals(),
      },
    ],
    byTask: [],
    byThread: [],
    byDay: [],
    turns: [
      {
        id: "usg_1",
        threadId: "thr_1",
        turnId: "turn_1",
        taskId: null,
        provider: "deepseek",
        model: "deepseek-flash",
        inputTokens: 1200,
        cachedTokens: 800,
        cacheMissTokens: 0,
        outputTokens: 40,
        reasoningTokens: 12,
        costUsd: null,
        state: "unknown_price",
        allocation: "turn",
        tokenSemantics: "inclusive_input",
        rateCardId: null,
        pricingReadAt: null,
        capturedAt: "2026-11-11T00:30:00.000Z",
        note: "the engine did not report a complete price for this thread",
      },
    ],
    rateCards: [],
    routes: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        state: "unknown_price",
        rateCardId: null,
        pricingReadAt: null,
      },
    ],
    pricingFreshness: null,
    budgets: [],
    evaluations: [],
    gate: {
      allowed: true,
      level: "ok",
      reasons: [],
      evaluations: [],
      inFlight: { taskRuns: 0, activeTurn: false },
      reservations: 0,
      note: "A local budget blocks the next dispatch only.",
    },
    balance: {
      available: false,
      note: "No provider balance endpoint is used. Mona never derives a remaining balance from local usage.",
    },
    notes: ["No local rate card is recorded, so Mona cannot produce a local estimate."],
    ...overrides,
  } as CostLedgerView;
}

async function render(next: CostLedgerView | null, failure?: string): Promise<void> {
  const costLedger = vi.fn(async () =>
    failure
      ? { ok: false as const, error: { code: "INTERNAL", message: failure } }
      : { ok: true as const, value: next ?? ledger() },
  );
  (globalThis as unknown as { window: Window }).window.mona = {
    costLedger,
  } as unknown as Window["mona"];
  await act(async () => {
    root?.render(<CostScreen detail={detail()} onOpenFolder={() => undefined} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("cost screen", () => {
  it("shows an unpriced turn as unknown, never as zero dollars", async () => {
    await render(ledger());
    const text = container?.textContent ?? "";
    expect(text).toContain("Spend is incomplete");
    expect(text).toContain("Unknown");
    expect(text).toContain("No dollar subtotal is shown");
    expect(text).not.toContain("$0.00");
    expect(text).toContain("Budget");
    expect(text).toContain("Export JSON");
    expect(text).toContain("No rate recorded");
  });

  it("reports a complete reported total without an 'at least' qualifier", async () => {
    await render(
      ledger({
        totals: totals({
          costUsd: 0.0125,
          costPicoUsd: 12_500_000_000,
          costComplete: true,
          costBasis: "reported",
          reportedTurns: 1,
          unknownTurns: 0,
        }),
        turns: [],
        routes: [
          {
            provider: "deepseek",
            model: "deepseek-flash",
            state: "reported",
            rateCardId: null,
            pricingReadAt: "2026-11-11T00:00:00.000Z",
          },
        ],
      }),
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("$0.0125");
    expect(text).toContain("Every observed turn has an engine-reported price.");
    expect(text).not.toContain("Spend is incomplete");
  });

  it("never rounds a sub-cent known total into zero dollars", async () => {
    await render(
      ledger({
        totals: totals({
          costUsd: 0.0042,
          costPicoUsd: 4_200_000_000,
          costComplete: false,
          costBasis: "reported",
          reportedTurns: 1,
          unknownTurns: 1,
          turns: 2,
        }),
      }),
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("$0.0042");
    // A rounded "$0.00" must not appear as a standalone amount.
    expect(text).not.toMatch(/\$0\.00(?!\d)/);
    expect(text).toContain("1 of 2 observed turns have a definite price");
  });

  it("shows the cost gate as blocked when a budget has stopped dispatch", async () => {
    await render(
      ledger({
        budgets: [
          {
            id: "bdg_1",
            projectId: "prj_0123456789abcdef",
            scope: "project",
            limitUsd: 0.01,
            warnUsd: null,
            enabled: true,
            timeZone: "UTC",
            revision: 1,
            updatedAt: "2026-11-11T00:40:00.000Z",
          },
        ],
        evaluations: [
          {
            budgetId: "bdg_1",
            scope: "project",
            level: "stop",
            knownUsd: 0.02,
            limitUsd: 0.01,
            warnUsd: null,
            unknownTurns: 0,
            complete: true,
            windowStart: "2026-11-11T00:00:00.000Z",
            windowEnd: "2026-11-11T01:00:00.000Z",
            message: "Known spend $0.0200 reached the $0.01 limit for this project.",
          },
        ],
        gate: {
          allowed: false,
          level: "stop",
          reasons: ["Known spend reached the limit"],
          evaluations: [],
          inFlight: { taskRuns: 0, activeTurn: false },
          reservations: 0,
          note: "A local budget blocks the next dispatch only.",
        },
      }),
    );
    const text = container?.textContent ?? "";
    expect(text).toContain("Dispatch gate: blocked.");
    expect(text).toContain("Stops next dispatch");
  });

  it("surfaces a ledger read failure instead of inventing numbers", async () => {
    await render(null, "the cost ledger is unavailable");
    const text = container?.textContent ?? "";
    expect(text).toContain("The ledger could not be read");
    expect(text).toContain("the cost ledger is unavailable");
    expect(text).not.toContain("Known spend");
  });
});
