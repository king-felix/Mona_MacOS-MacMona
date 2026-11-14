import { describe, expect, it } from "vitest";
import type { StoredEventSummary } from "../src/shared/contracts/project-bridge";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import { projectActivity } from "../src/renderer/shell/activity";

const THREAD = "thr_0123456789abcdef";
const TURN = "turn_0123456789abcdef";

function snapshot(overrides: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return {
    projectId: "prj_0123456789abcdef" as StudioSnapshot["projectId"],
    connection: {
      state: "running",
      reason: "a turn is active",
      since: "2026-11-11T00:00:00.000Z",
      port: 7878,
      engine: { version: "0.10.2", commit: "ff466b2ed0bf" },
      owned: true,
      external: false,
      lastEventAt: null,
      silentForMs: null,
      missing: [],
    },
    threadId: THREAD,
    engineThreadId: THREAD,
    activeTurnId: TURN,
    lastMode: "work",
    pauseAfterTask: false,
    queued: 0,
    profile: {
      provider: "deepseek",
      exactId: null,
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
    cost: {
      observed: false,
      costUsd: 0,
      costComplete: false,
      turns: 0,
      label: "No usage recorded",
    },
    submission: null,
    diagnostics: [],
    pendingRequests: [],
    followUps: [],
    steering: { available: false, reason: "no steer route", requiredRoute: null },
    canSubmit: false,
    cannotSubmitReason: "a turn is active",
    controls: { canInterrupt: true, canPause: true, canCancelQueued: false, canStop: true },
    ...overrides,
  };
}

function event(overrides: Partial<StoredEventSummary> & { seq: number }): StoredEventSummary {
  return {
    threadId: THREAD,
    kind: "item.started",
    payload: {},
    timestamp: "2026-11-11T00:00:01.000Z",
    turnId: TURN,
    itemId: null,
    ...overrides,
  };
}

function toolStart(seq: number, id: string, at: string): StoredEventSummary {
  return event({
    seq,
    kind: "item.started",
    itemId: id,
    timestamp: at,
    payload: { item: { id, kind: "tool_call", name: "bash" } },
  });
}

function toolEnd(seq: number, id: string, at: string, kind = "item.completed"): StoredEventSummary {
  return event({
    seq,
    kind,
    itemId: id,
    timestamp: at,
    payload: { item: { id, kind: "tool_call", name: "bash" } },
  });
}

describe("R08 activity projection", () => {
  it("reports the open turn's real span and each tool's measured duration", () => {
    const activity = projectActivity({
      studio: snapshot(),
      events: [
        event({ seq: 1, kind: "turn.started", timestamp: "2026-11-11T00:00:00.000Z" }),
        toolStart(2, "item_1", "2026-11-11T00:00:02.000Z"),
        toolEnd(3, "item_1", "2026-11-11T00:00:07.000Z"),
        event({ seq: 4, kind: "item.delta", timestamp: "2026-11-11T00:00:09.000Z" }),
      ],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:12.000Z"),
    });
    expect(activity.status).toBe("running");
    expect(activity.turnId).toBe(TURN);
    expect(activity.startedAt).toBe("2026-11-11T00:00:00.000Z");
    expect(activity.lastEventAt).toBe("2026-11-11T00:00:09.000Z");
    expect(activity.durationMs).toBe(9_000);
    expect(activity.idleMs).toBe(3_000);
    expect(activity.tools).toHaveLength(1);
    expect(activity.tools[0]).toMatchObject({
      name: "bash",
      status: "completed",
      durationMs: 5_000,
    });
  });

  it("does not let frames from an earlier turn inflate the current turn", () => {
    const activity = projectActivity({
      studio: snapshot(),
      events: [
        event({ seq: 1, turnId: "turn_ffffffffffffffff", timestamp: "2026-11-10T23:00:00.000Z" }),
        event({ seq: 2, kind: "turn.started", timestamp: "2026-11-11T00:00:00.000Z" }),
      ],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:05.000Z"),
    });
    expect(activity.startedAt).toBe("2026-11-11T00:00:00.000Z");
    expect(activity.durationMs).toBe(0);
  });

  it("marks a failed tool and keeps an unfinished one open, never invented", () => {
    const activity = projectActivity({
      studio: snapshot(),
      events: [
        toolStart(1, "item_1", "2026-11-11T00:00:01.000Z"),
        toolEnd(2, "item_1", "2026-11-11T00:00:03.000Z", "item.failed"),
        toolStart(3, "item_2", "2026-11-11T00:00:04.000Z"),
      ],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:06.000Z"),
    });
    const byId = Object.fromEntries(activity.tools.map((tool) => [tool.id, tool]));
    expect(byId.item_1?.status).toBe("failed");
    expect(byId.item_1?.durationMs).toBe(2_000);
    expect(byId.item_2?.status).toBeNull();
    expect(byId.item_2?.completedAt).toBeNull();
    expect(byId.item_2?.summary).toContain("running");
  });

  it("reports a completion whose start is outside the window instead of guessing", () => {
    const activity = projectActivity({
      studio: snapshot(),
      events: [toolEnd(9, "item_old", "2026-11-11T00:00:04.000Z")],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:05.000Z"),
    });
    expect(activity.tools[0]).toMatchObject({ id: "item_old", startedAt: null, durationMs: null });
    expect(activity.tools[0]?.summary).toContain("began before the loaded events");
    expect(activity.toolsNotInWindow).toBe(1);
  });

  it("flags waiting on a person, and does not call it running", () => {
    const activity = projectActivity({
      studio: snapshot({
        pendingRequests: [
          {
            id: "prq_0123456789abcdef",
            kind: "approval",
            projectId: "prj_0123456789abcdef",
            threadId: THREAD,
            turnId: TURN,
            toolName: "bash",
            title: "Run the tests",
            summary: null,
            input: null,
            questions: [],
            decisions: ["allow", "deny"],
            status: "pending",
            decision: null,
            decidedBy: null,
            acknowledgement: null,
            note: null,
            createdAt: "2026-11-11T00:00:01.000Z",
            settledAt: null,
            canAnswer: true,
            cannotAnswerReason: null,
          },
        ],
      }),
      events: [event({ seq: 1, kind: "turn.started" })],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:02.000Z"),
    });
    expect(activity.status).toBe("waiting");
    expect(activity.needsYou).toBe(1);
    expect(activity.needsYouReason).toContain("waiting for an answer");
  });

  it("reports idle with the last stored event's age, not a fabricated turn", () => {
    const activity = projectActivity({
      studio: snapshot({ activeTurnId: null }),
      events: [event({ seq: 1, kind: "turn.completed", timestamp: "2026-11-11T00:00:00.000Z" })],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:01:00.000Z"),
    });
    expect(activity.status).toBe("idle");
    expect(activity.turnId).toBeNull();
    expect(activity.tools).toEqual([]);
    expect(activity.idleMs).toBe(60_000);
  });

  it("never calls a disconnected studio idle", () => {
    const base = snapshot({ activeTurnId: null });
    const activity = projectActivity({
      studio: { ...base, connection: { ...base.connection, state: "failed" } },
      events: [],
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:00.000Z"),
    });
    expect(activity.status).toBe("unknown");
  });

  it("bounds the tool rows and says how many were not shown", () => {
    const events: StoredEventSummary[] = [];
    for (let index = 0; index < 12; index += 1) {
      events.push(toolStart(index + 1, `item_${index}`, "2026-11-11T00:00:01.000Z"));
    }
    const activity = projectActivity({
      studio: snapshot(),
      events,
      filterThreadId: null,
      now: Date.parse("2026-11-11T00:00:02.000Z"),
      maxTools: 5,
    });
    expect(activity.tools).toHaveLength(5);
    expect(activity.toolsNotInWindow).toBe(7);
  });
});
