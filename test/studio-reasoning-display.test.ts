import { describe, expect, it } from "vitest";
import type { StoredEventSummary } from "../src/shared/contracts/project-bridge";
import { projectTimeline } from "../src/renderer/shell/timeline";

const THREAD = "thr_display0000000001";

function event(seq: number, kind: string, payload: unknown, itemId?: string): StoredEventSummary {
  return {
    threadId: THREAD,
    seq,
    kind,
    payload,
    timestamp: `2026-11-12T00:00:0${seq}.000Z`,
    turnId: "turn_display",
    itemId: itemId ?? null,
  } as StoredEventSummary;
}

function transcript(): StoredEventSummary[] {
  return [
    event(1, "item.completed", {
      item: { id: "item_user", kind: "user_message", status: "completed", summary: "hello" },
    }),
    event(2, "item.completed", {
      item: {
        id: "item_reasoning",
        kind: "agent_reasoning",
        status: "completed",
        detail: "weighing the options",
      },
    }),
    event(3, "item.completed", {
      item: { id: "item_answer", kind: "agent_message", status: "completed", summary: "done" },
    }),
  ];
}

describe("reasoning display preference", () => {
  it("shows engine-reported reasoning by default", () => {
    const projected = projectTimeline(transcript(), { historyComplete: true });
    expect(projected.entries.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "assistant",
    ]);
  });

  it("hides only the reasoning cards when the preference is off", () => {
    const projected = projectTimeline(transcript(), {
      historyComplete: true,
      showReasoning: false,
    });
    expect(projected.entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
    // The frames are still accounted for; nothing is silently lost from the
    // transcript's activity total.
    expect(projected.entries.some((entry) => entry.body === "weighing the options")).toBe(false);
  });
});
