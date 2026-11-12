import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts/ids";
import { CostLedger } from "../src/main/work/costs";
import {
  PICO_PER_USD,
  civilDayRange,
  estimateCostPico,
  picoToUsd,
  ratePerMillionToPicoPerToken,
  usdToPico,
} from "../src/main/work/cost-math";
import { openTestStore } from "./helpers/state";

// A round, hand-checkable rate card: $0.28 / $2.80 / $0.42 per million tokens.
// In pico-per-token that is exactly 280,000 / 2,800,000 / 420,000.
const RATE = {
  cacheHitPico: ratePerMillionToPicoPerToken(0.28),
  cacheMissPico: ratePerMillionToPicoPerToken(2.8),
  outputPico: ratePerMillionToPicoPerToken(0.42),
  toolCallPico: null,
  reasoningInOutput: true,
};

async function setup() {
  const { store, dir } = await openTestStore();
  const project = await store.createProject({ name: "Costs", rootPath: dir });
  const thread = await store.upsertThread({
    id: "thr_costtest000001",
    projectId: project.id,
    engineThreadId: "thr_engine000000001",
    title: "Work",
  });
  const ledger = new CostLedger(store);
  return { store, dir, project, thread, ledger };
}

describe("cost arithmetic", () => {
  it("converts dollars, rates, and pico exactly", () => {
    expect(PICO_PER_USD).toBe(1_000_000_000_000);
    expect(usdToPico(0.000004)).toBe(4_000_000);
    expect(picoToUsd(4_000_000)).toBeCloseTo(0.000004, 12);
    expect(ratePerMillionToPicoPerToken(0.28)).toBe(280_000);
    expect(ratePerMillionToPicoPerToken(2.8)).toBe(2_800_000);
    expect(ratePerMillionToPicoPerToken(0.42)).toBe(420_000);
  });

  it("prices an inclusive turn without double-counting cache hits", () => {
    const result = estimateCostPico(
      {
        inputTokens: 1_200,
        cachedTokens: 800,
        cacheMissTokens: null,
        outputTokens: 40,
        reasoningTokens: 12,
      },
      RATE,
      "inclusive_input",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hitTokens).toBe(800);
    expect(result.missTokens).toBe(400);
    // Cache hits are the cheap bucket: 400*2,800,000 + 800*280,000 + 40*420,000
    expect(result.pico).toBe(1_360_800_000);
    expect(picoToUsd(result.pico)).toBeCloseTo(0.0013608, 12);
  });

  it("prices an exclusive bucket additively and never adds reasoning twice", () => {
    const result = estimateCostPico(
      {
        inputTokens: 12_659,
        cachedTokens: 40_448,
        cacheMissTokens: null,
        outputTokens: 313,
        reasoningTokens: 8,
      },
      RATE,
      "exclusive_input",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.missTokens).toBe(12_659);
    expect(result.hitTokens).toBe(40_448);
    expect(result.billedOutputTokens).toBe(313);
    expect(result.pico).toBe(12_659 * 2_800_000 + 40_448 * 280_000 + 313 * 420_000);
  });

  it("adds reasoning to output only when the card bills it separately", () => {
    const buckets = {
      inputTokens: 1_000,
      cachedTokens: 0,
      cacheMissTokens: null,
      outputTokens: 100,
      reasoningTokens: 50,
    };
    const inclusive = estimateCostPico(buckets, RATE, "inclusive_input");
    const separate = estimateCostPico(
      buckets,
      { ...RATE, reasoningInOutput: false },
      "inclusive_input",
    );
    expect(inclusive.ok && separate.ok).toBe(true);
    if (!inclusive.ok || !separate.ok) return;
    expect(inclusive.pico).toBe(1_000 * 2_800_000 + 100 * 420_000);
    expect(separate.pico).toBe(1_000 * 2_800_000 + 150 * 420_000);
  });

  it("refuses to estimate when the buckets conflict or a rate is missing", () => {
    expect(
      estimateCostPico(
        {
          inputTokens: 100,
          cachedTokens: 200,
          cacheMissTokens: null,
          outputTokens: 5,
          reasoningTokens: 0,
        },
        RATE,
        "inclusive_input",
      ),
    ).toEqual({ ok: false, reason: "cache_buckets_conflict" });
    expect(
      estimateCostPico(
        {
          inputTokens: 100,
          cachedTokens: 0,
          cacheMissTokens: null,
          outputTokens: 5,
          reasoningTokens: 0,
        },
        { ...RATE, outputPico: null },
        "inclusive_input",
      ),
    ).toEqual({ ok: false, reason: "missing_output_rate" });
  });
});

describe("civil day boundaries", () => {
  it("uses the local civil date, including a DST transition", () => {
    // 2026-03-08 in America/New_York is a 23-hour day.
    const at = "2026-03-08T15:00:00.000Z";
    const range = civilDayRange(at, "America/New_York");
    expect(range.day).toBe("2026-03-08");
    expect(range.startIso).toBe("2026-03-08T05:00:00.000Z");
    expect(range.endIso).toBe("2026-03-09T04:00:00.000Z");
    const hours = (Date.parse(range.endIso) - Date.parse(range.startIso)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("keeps an early-UTC turn on the previous civil day", () => {
    // 2026-11-11T03:30Z is still 2026-11-10 in Los Angeles.
    expect(civilDayRange("2026-11-11T03:30:00.000Z", "America/Los_Angeles").day).toBe("2026-11-10");
  });
});

describe("cost ledger ingestion", () => {
  it("records a turn once and does not double-charge on replay", async () => {
    const { ledger, project, thread, store } = await setup();
    const observation = {
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_aaaaaaaaaaaaaaa1",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        inputTokens: 1_200,
        cachedTokens: 800,
        cacheMissTokens: null,
        outputTokens: 40,
        reasoningTokens: 12,
      },
      capturedAt: "2026-11-11T00:00:10.000Z",
      windowSince: thread.createdAt,
      aggregate: { costUsd: 0.0013608, costComplete: true },
    };
    const first = await ledger.recordTurn(observation);
    const second = await ledger.recordTurn(observation);
    expect(second.id).toBe(first.id);
    expect(first.costState).toBe("reported");
    expect(first.costPicoUsd).toBe(1_360_800_000);
    const summary = await store.summarizeUsage(project.id as ProjectId);
    expect(summary.turns).toBe(1);
    expect(summary.costUsd).toBeCloseTo(0.0013608, 12);
    expect(summary.costComplete).toBe(true);
  });

  it("allocates a cumulative thread total as an exact delta", async () => {
    const { ledger, project, thread, store } = await setup();
    const base = {
      projectId: project.id as ProjectId,
      threadId: thread.id,
      provider: "deepseek",
      model: "deepseek-flash",
      windowSince: thread.createdAt,
    };
    const first = await ledger.recordTurn({
      ...base,
      turnId: "turn_bbbbbbbbbbbbbbb1",
      usage: {
        inputTokens: 1_000,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T00:01:00.000Z",
      aggregate: { costUsd: 0.001, costComplete: true },
    });
    const second = await ledger.recordTurn({
      ...base,
      turnId: "turn_bbbbbbbbbbbbbbb2",
      usage: {
        inputTokens: 2_000,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 20,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T00:02:00.000Z",
      aggregate: { costUsd: 0.0035, costComplete: true },
    });
    expect(first.costPicoUsd).toBe(usdToPico(0.001));
    expect(second.costPicoUsd).toBe(usdToPico(0.0035) - usdToPico(0.001));
    expect(second.costAllocation).toBe("thread_delta");
    const summary = await store.summarizeUsage(project.id as ProjectId);
    expect(summary.costUsd).toBeCloseTo(0.0035, 12);
    expect(summary.costComplete).toBe(true);
    expect(summary.residualPicoUsd).toBe(0);
  });

  it("never records a negative delta when the thread total moves backwards", async () => {
    const { ledger, project, thread, store } = await setup();
    const base = {
      projectId: project.id as ProjectId,
      threadId: thread.id,
      provider: "deepseek",
      model: "deepseek-flash",
      windowSince: thread.createdAt,
      usage: {
        inputTokens: 10,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    };
    await ledger.recordTurn({
      ...base,
      turnId: "turn_ccccccccccccccc1",
      capturedAt: "2026-11-11T00:03:00.000Z",
      aggregate: { costUsd: 0.01, costComplete: true },
    });
    const reset = await ledger.recordTurn({
      ...base,
      turnId: "turn_ccccccccccccccc2",
      capturedAt: "2026-11-11T00:04:00.000Z",
      aggregate: { costUsd: 0.002, costComplete: true },
    });
    expect(reset.costState).toBe("unallocated");
    expect(reset.costPicoUsd).toBeNull();
    expect(reset.note).toContain("moved backwards");
    const summary = await store.summarizeUsage(project.id as ProjectId);
    expect(summary.costUsd).toBeGreaterThanOrEqual(0.01);
    expect(summary.costComplete).toBe(false);
  });

  it("keeps an unpriced turn unknown instead of zero when no rate card exists", async () => {
    const { ledger, project, thread, store } = await setup();
    const record = await ledger.recordTurn({
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_ddddddddddddddd1",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        inputTokens: 1_000,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T00:05:00.000Z",
      windowSince: thread.createdAt,
      aggregate: { costUsd: 0, costComplete: false },
    });
    expect(record.costState).toBe("unknown_price");
    expect(record.costUsd).toBeNull();
    const summary = await store.summarizeUsage(project.id as ProjectId);
    expect(summary.costComplete).toBe(false);
    expect(summary.unknownTurns).toBe(1);
    expect(summary.costUsd).toBe(0);

    const view = await ledger.ledger(project.id as ProjectId, { timeZone: "UTC" });
    expect(view.totals.costComplete).toBe(false);
    expect(view.totals.costBasis).toBe("none");
    expect(view.notes.some((note) => note.includes("No local rate card"))).toBe(true);
  });

  it("uses a recorded rate card as an explicit estimate, versioned and historical", async () => {
    const { ledger, project, thread, store } = await setup();
    const card = await ledger.setRateCard({
      provider: "deepseek",
      model: "deepseek-flash",
      cacheHitPerMillion: 0.28,
      cacheMissPerMillion: 2.8,
      outputPerMillion: 0.42,
      readAt: "2026-11-11T00:00:00.000Z",
    });
    expect(card.revisionNo).toBe(1);
    const record = await ledger.recordTurn({
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_eeeeeeeeeeeeeee1",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        inputTokens: 1_200,
        cachedTokens: 800,
        cacheMissTokens: null,
        outputTokens: 40,
        reasoningTokens: 12,
      },
      capturedAt: "2026-11-11T00:06:00.000Z",
      windowSince: thread.createdAt,
      aggregate: null,
    });
    expect(record.costState).toBe("estimated");
    expect(record.costPicoUsd).toBe(1_360_800_000);
    expect(record.rateCardId).toBe(card.id);

    const replacement = await ledger.setRateCard({
      provider: "deepseek",
      model: "deepseek-flash",
      cacheHitPerMillion: 1,
      cacheMissPerMillion: 1,
      outputPerMillion: 1,
    });
    expect(replacement.revisionNo).toBe(2);
    const after = await store.getUsageForTurn(thread.id, "turn_eeeeeeeeeeeeeee1");
    // The stored row keeps its original rate provenance.
    expect(after?.costPicoUsd).toBe(1_360_800_000);
    expect(after?.rateCardId).toBe(card.id);
  });

  it("previews a recalculation without rewriting stored history", async () => {
    const { ledger, project, thread, store } = await setup();
    await ledger.recordTurn({
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_ffffffffffffff01",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        inputTokens: 1_000,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 100,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T00:07:00.000Z",
      windowSince: thread.createdAt,
      aggregate: null,
    });
    const preview = await ledger.previewRecalculation(project.id as ProjectId, {
      provider: "deepseek",
      model: "deepseek-flash",
      cacheHitPerMillion: 1,
      cacheMissPerMillion: 1,
      outputPerMillion: 1,
    });
    expect(preview.turns).toBe(1);
    expect(preview.afterPico).toBe(1_000 * 1_000_000 + 100 * 1_000_000);
    expect(preview.beforePico).toBe(0);
    const stored = await store.getUsageForTurn(thread.id, "turn_ffffffffffffff01");
    expect(stored?.costPicoUsd).toBeNull();
  });

  it("records a turn with no usage as missing, not free", async () => {
    const { ledger, project, thread, store } = await setup();
    const record = await ledger.recordTurn({
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_1111111111111101",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: null,
      capturedAt: "2026-11-11T00:08:00.000Z",
      windowSince: thread.createdAt,
      aggregate: null,
    });
    expect(record.costState).toBe("missing_usage");
    expect(record.costUsd).toBeNull();
    const summary = await store.summarizeUsage(project.id as ProjectId);
    expect(summary.missingTurns).toBe(1);
    expect(summary.costComplete).toBe(false);
  });
});

describe("cost ledger attribution", () => {
  it("rolls up by model, task, session, and civil day", async () => {
    const { ledger, project, thread } = await setup();
    const base = {
      projectId: project.id as ProjectId,
      threadId: thread.id,
      provider: "deepseek",
      model: "deepseek-flash",
      windowSince: thread.createdAt,
    };
    await ledger.recordTurn({
      ...base,
      turnId: "turn_2222222222222201",
      usage: {
        inputTokens: 100,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-10T23:30:00.000Z",
      aggregate: { costUsd: 0.001, costComplete: true },
    });
    await ledger.recordTurn({
      ...base,
      turnId: "turn_2222222222222202",
      usage: {
        inputTokens: 100,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T01:30:00.000Z",
      aggregate: { costUsd: 0.002, costComplete: true },
    });
    const view = await ledger.ledger(project.id as ProjectId, { timeZone: "UTC" });
    expect(view.totals.turns).toBe(2);
    expect(view.totals.costUsd).toBeCloseTo(0.002, 12);
    expect(view.byDay.map((row) => row.key)).toEqual(["2026-11-10", "2026-11-11"]);
    expect(view.byThread[0]?.key).toBe(thread.id);
    expect(view.byModel[0]?.label).toBe("deepseek · deepseek-flash");
    expect(view.byTask[0]?.key).toBe("unassigned");
    expect(view.routes[0]?.state).toBe("reported");
  });
});

describe("budgets and the dispatch gate", () => {
  it("warns, stops the next dispatch, and reports an unpriced lower bound", async () => {
    const { ledger, project, thread } = await setup();
    const base = {
      projectId: project.id as ProjectId,
      threadId: thread.id,
      provider: "deepseek",
      model: "deepseek-flash",
      windowSince: thread.createdAt,
      usage: {
        inputTokens: 100,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
    };
    await ledger.recordTurn({
      ...base,
      turnId: "turn_3333333333333301",
      capturedAt: "2026-11-11T00:10:00.000Z",
      aggregate: { costUsd: 0.004, costComplete: true },
    });
    await ledger.recordTurn({
      ...base,
      turnId: "turn_3333333333333302",
      capturedAt: "2026-11-11T00:11:00.000Z",
      aggregate: { costUsd: 0, costComplete: false },
    });

    let gate = await ledger.dispatchGate(project.id as ProjectId, "2026-11-11T00:12:00.000Z");
    expect(gate.allowed).toBe(true);
    expect(gate.level).toBe("ok");

    await ledger.setBudget({
      projectId: project.id as ProjectId,
      scope: "project",
      limitUsd: 0.01,
      warnUsd: 0.003,
    });
    gate = await ledger.dispatchGate(project.id as ProjectId, "2026-11-11T00:13:00.000Z");
    expect(gate.allowed).toBe(true);
    expect(gate.level).toBe("warn");
    expect(gate.evaluations[0]?.unknownTurns).toBe(1);
    expect(gate.evaluations[0]?.message).toContain("lower bound");

    await ledger.setBudget({
      projectId: project.id as ProjectId,
      scope: "project",
      limitUsd: 0.004,
    });
    gate = await ledger.dispatchGate(project.id as ProjectId, "2026-11-11T00:14:00.000Z");
    expect(gate.allowed).toBe(false);
    expect(gate.level).toBe("stop");
    expect(gate.reasons[0]).toContain("limit");

    const budgets = await ledger.ledger(project.id as ProjectId, {
      generatedAt: "2026-11-11T00:15:00.000Z",
    });
    expect(budgets.budgets).toHaveLength(1);
    expect(budgets.budgets[0]?.limitUsd).toBeCloseTo(0.004, 12);
    await ledger.clearBudget({
      projectId: project.id as ProjectId,
      budgetId: budgets.budgets[0]!.id,
      expectedRevision: budgets.budgets[0]!.revision,
    });
    gate = await ledger.dispatchGate(project.id as ProjectId, "2026-11-11T00:16:00.000Z");
    expect(gate.allowed).toBe(true);
  });

  it("scopes a day budget to the civil day, not the UTC day", async () => {
    const { ledger, project, thread } = await setup();
    await ledger.recordTurn({
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_4444444444444401",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        inputTokens: 100,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T20:00:00.000Z",
      windowSince: thread.createdAt,
      aggregate: { costUsd: 0.02, costComplete: true },
    });
    await ledger.setBudget({
      projectId: project.id as ProjectId,
      scope: "day",
      limitUsd: 0.01,
      timeZone: "America/Los_Angeles",
    });
    // 05:00Z is 21:00 on 2026-11-10 in Los Angeles, before the turn at 20:00Z.
    const previous = await ledger.dispatchGate(
      project.id as ProjectId,
      "2026-11-11T05:00:00.000Z",
      {
        timeZone: "America/Los_Angeles",
      },
    );
    expect(previous.allowed).toBe(true);
    // 21:00Z is 13:00 on 2026-11-11: today's spend, above the limit.
    const sameDay = await ledger.dispatchGate(project.id as ProjectId, "2026-11-11T21:00:00.000Z", {
      timeZone: "America/Los_Angeles",
    });
    expect(sameDay.allowed).toBe(false);
  });

  it("refuses an inverted warning threshold", async () => {
    const { ledger, project } = await setup();
    await expect(
      ledger.setBudget({
        projectId: project.id as ProjectId,
        scope: "project",
        limitUsd: 1,
        warnUsd: 2,
      }),
    ).rejects.toThrow(/warning threshold/);
  });
});

describe("cost export", () => {
  it("exports JSON and CSV with explicit cost states and no balance", async () => {
    const { ledger, project, thread } = await setup();
    await ledger.recordTurn({
      projectId: project.id as ProjectId,
      threadId: thread.id,
      turnId: "turn_5555555555555501",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: {
        inputTokens: 1_000,
        cachedTokens: 0,
        cacheMissTokens: null,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      capturedAt: "2026-11-11T00:20:00.000Z",
      windowSince: thread.createdAt,
      aggregate: { costUsd: 0, costComplete: false },
    });
    const json = await ledger.exportLedger(project.id as ProjectId, {
      format: "json",
      timeZone: "UTC",
      generatedAt: "2026-11-11T01:00:00.000Z",
    });
    expect(json.filename).toBe("mona-cost-costs-2026-11-11.json");
    const parsed = JSON.parse(json.content) as Record<string, unknown>;
    expect(parsed.balance).toBeNull();
    expect(String(parsed.balance_note)).toContain("never derives a remaining balance");
    const turns = parsed.turns as Array<Record<string, unknown>>;
    expect(turns[0]?.cost_state).toBe("unknown_price");
    expect(turns[0]?.cost_usd).toBeNull();

    const csv = await ledger.exportLedger(project.id as ProjectId, {
      format: "csv",
      timeZone: "UTC",
    });
    expect(csv.filename.endsWith(".csv")).toBe(true);
    const lines = csv.content.trim().split("\n");
    expect(lines[0]).toContain("cost_state");
    expect(lines[1]).toContain("unknown_price");
    expect(lines[1]?.split(",")).toHaveLength(lines[0]!.split(",").length);
  });
});
