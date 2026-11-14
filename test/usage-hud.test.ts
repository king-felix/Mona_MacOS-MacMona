import { describe, expect, it } from "vitest";
import { projectUsageScope, usageScopeState } from "../src/main/work/usage-hud";
import type { UsageSummary } from "../src/main/state/store";

function summary(overrides: Partial<UsageSummary> & { semantics?: string[] } = {}) {
  const base = {
    turns: 1,
    inputTokens: 1000,
    outputTokens: 200,
    cachedTokens: 400,
    cacheMissTokens: 600,
    reasoningTokens: 0,
    costUsd: 0.0012,
    costPicoUsd: 1_200_000_000,
    costComplete: true,
    observed: true,
    reportedTurns: 1,
    estimatedTurns: 0,
    unknownTurns: 0,
    missingTurns: 0,
    unallocatedTurns: 0,
    residualPicoUsd: 0,
    semantics: ["inclusive_input"],
  };
  return { ...base, ...overrides } as UsageSummary & { semantics: string[] };
}

describe("R09 usage projection", () => {
  it("reports no usage as empty, never as $0.00", () => {
    const view = projectUsageScope({
      scope: "project",
      summary: summary({
        turns: 0,
        costUsd: 0,
        costPicoUsd: 0,
        costComplete: false,
        observed: false,
        reportedTurns: 0,
        semantics: [],
      }),
    });
    expect(view.state).toBe("empty");
    expect(view.costUsd).toBeNull();
    expect(view.label).toBe("No usage recorded");
  });

  it("waits for an active turn that has not reported yet", () => {
    const view = projectUsageScope({
      scope: "turn",
      active: true,
      summary: summary({ turns: 0, costComplete: false, reportedTurns: 0, semantics: [] }),
    });
    expect(view.state).toBe("waiting");
    expect(view.label).toBe("Waiting for usage");
    expect(view.costUsd).toBeNull();
  });

  it("subtracts cached input when the native count is inclusive", () => {
    const view = projectUsageScope({ scope: "turn", summary: summary() });
    expect(view.state).toBe("complete");
    expect(view.inputTokens).toBe(600);
    expect(view.cachedInputTokens).toBe(400);
    expect(view.label).toContain("600 in (400 cached)");
    expect(view.label).toContain("200 out");
    expect(view.label).toContain("$0.0012");
  });

  it("keeps exclusive input and cached input separate", () => {
    const view = projectUsageScope({
      scope: "thread",
      summary: summary({ semantics: ["exclusive_input"], inputTokens: 600 }),
    });
    expect(view.inputTokens).toBe(600);
    expect(view.cachedInputTokens).toBe(400);
    expect(view.note).toBeNull();
  });

  it("never invents a subtraction when rows disagree", () => {
    const view = projectUsageScope({
      scope: "project",
      summary: summary({ semantics: ["mixed"] }),
    });
    expect(view.tokenSemantics).toBe("mixed");
    expect(view.inputTokens).toBe(1000);
  });

  it("marks a partial total and states how many turns are unpriced", () => {
    const view = projectUsageScope({
      scope: "project",
      summary: summary({
        turns: 3,
        reportedTurns: 1,
        unknownTurns: 1,
        missingTurns: 1,
        costComplete: false,
      }),
    });
    expect(view.state).toBe("partial");
    expect(view.costComplete).toBe(false);
    expect(view.costUsd).toBeCloseTo(0.0012, 6);
    expect(view.label).toContain("partial");
    expect(view.note).toContain("2 of 3 turns cannot be priced");
  });

  it("distinguishes unpriced usage from zero spend", () => {
    const view = projectUsageScope({
      scope: "turn",
      summary: summary({
        reportedTurns: 0,
        estimatedTurns: 0,
        unknownTurns: 1,
        costComplete: false,
        costUsd: 0.0005,
      }),
    });
    expect(view.state).toBe("unpriced");
    expect(view.costUsd).toBeNull();
    expect(view.label).toContain("unpriced");
  });

  it("keeps unknown token semantics unknown", () => {
    const view = projectUsageScope({
      scope: "project",
      summary: summary({ semantics: [] }),
    });
    expect(view.tokenSemantics).toBe("unknown");
  });

  it("does not count a missing usage row as a priced turn", () => {
    expect(
      usageScopeState({
        scope: "thread",
        summary: summary({
          turns: 2,
          missingTurns: 2,
          reportedTurns: 0,
          estimatedTurns: 0,
          costComplete: false,
        }),
      }),
    ).toBe("unpriced");
  });
});

describe("R09 scoped usage read", () => {
  it("narrows to one conversation and one turn, and keeps the residual project-only", async () => {
    const { openTestStore } = await import("./helpers/state");
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Usage", rootPath: dir });
    const threadA = "thr_aaaaaaaaaaaaaaaa";
    const threadB = "thr_bbbbbbbbbbbbbbbb";
    await store.recordUsage({
      projectId: project.id,
      threadId: threadA,
      turnId: "turn_aaaaaaaaaaaaaaaa",
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 1000,
      outputTokens: 100,
      cachedTokens: 400,
      costUsd: 0.001,
      tokenSemantics: "inclusive_input",
      capturedAt: "2026-11-14T00:00:00.000Z",
    });
    await store.recordUsage({
      projectId: project.id,
      threadId: threadB,
      turnId: "turn_bbbbbbbbbbbbbbbb",
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 2000,
      outputTokens: 200,
      cachedTokens: 0,
      costUsd: null,
      costState: "unknown_price",
      capturedAt: "2026-11-14T00:01:00.000Z",
    });

    const thread = await store.summarizeUsageScoped(project.id, { threadId: threadA });
    expect(thread.turns).toBe(1);
    expect(thread.inputTokens).toBe(1000);
    expect(thread.semantics).toEqual(["inclusive_input"]);
    expect(thread.costComplete).toBe(true);

    const turn = await store.summarizeUsageScoped(project.id, { turnId: "turn_bbbbbbbbbbbbbbbb" });
    expect(turn.turns).toBe(1);
    expect(turn.costComplete).toBe(false);
    expect(turn.unknownTurns).toBe(1);
    // A per-scope read never carries the project residual into a single turn.
    expect(turn.residualPicoUsd).toBe(0);

    const projectSummary = await store.summarizeUsageScoped(project.id);
    expect(projectSummary.turns).toBe(2);
    expect(projectSummary.costComplete).toBe(false);

    const view = projectUsageScope({ scope: "project", summary: projectSummary });
    expect(view.state).toBe("partial");
    await store.close();
  });
});

describe("R09 scope agreement and imported history", () => {
  it("agrees with the Cost screen's project total and excludes unassigned rows from a thread", async () => {
    const { openTestStore } = await import("./helpers/state");
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Agree", rootPath: dir });
    const thread = "thr_cccccccccccccccc";
    await store.recordUsage({
      projectId: project.id,
      threadId: thread,
      turnId: "turn_cccccccccccccccc",
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      costUsd: 0.004,
      tokenSemantics: "exclusive_input",
      capturedAt: "2026-11-14T00:00:00.000Z",
    });
    // Imported old history: a usage row with no thread or turn identity.
    await store.recordUsage({
      projectId: project.id,
      threadId: null,
      turnId: null,
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 50,
      outputTokens: 5,
      cachedTokens: null,
      costUsd: 0.002,
      capturedAt: "2026-11-13T00:00:00.000Z",
    });

    const official = await store.summarizeUsage(project.id);
    const scoped = await store.summarizeUsageScoped(project.id);
    expect(scoped.costUsd).toBeCloseTo(official.costUsd, 9);
    expect(scoped.costComplete).toBe(official.costComplete);
    expect(scoped.turns).toBe(official.turns);

    const threadScope = await store.summarizeUsageScoped(project.id, { threadId: thread });
    expect(threadScope.turns).toBe(1);
    expect(threadScope.costUsd).toBeCloseTo(0.004, 9);

    const view = projectUsageScope({ scope: "project", summary: scoped });
    expect(view.costUsd).toBeCloseTo(0.006, 9);
    expect(view.state).toBe("complete");
    await store.close();
  });
});

describe("R09 replay and reconnect", () => {
  it("does not double-count a replayed receipt for the same turn", async () => {
    const { openTestStore } = await import("./helpers/state");
    const { store, dir } = await openTestStore();
    const project = await store.createProject({ name: "Replay", rootPath: dir });
    const thread = "thr_dddddddddddddddd";
    const turn = "turn_dddddddddddddddd";
    const row = {
      projectId: project.id,
      threadId: thread,
      turnId: turn,
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      costUsd: 0.003,
      tokenSemantics: "exclusive_input" as const,
      capturedAt: "2026-11-14T00:00:00.000Z",
    };
    await store.recordUsage(row);
    // A reconnect replays the same terminal frame; the store's identity rule
    // keeps one receipt per turn.
    await store.recordUsage({ ...row, capturedAt: "2026-11-14T00:00:05.000Z" });
    const scoped = await store.summarizeUsageScoped(project.id, { turnId: turn });
    expect(scoped.turns).toBe(1);
    expect(scoped.costUsd).toBeCloseTo(0.003, 9);
    await store.close();
  });

  it("keeps a turn scope after a reconnect, and reports no active turn as empty", () => {
    const thread = projectUsageScope({ scope: "thread", summary: summary() });
    expect(thread.state).toBe("complete");
    const idle = projectUsageScope({
      scope: "turn",
      summary: summary({ turns: 0, reportedTurns: 0, semantics: [] }),
    });
    expect(idle.state).toBe("empty");
  });
});
