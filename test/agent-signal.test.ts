import { describe, expect, it } from "vitest";
import {
  agentSignalAt,
  projectAgentWork,
  QUIET_AFTER_MS,
} from "../src/renderer/shell/agent-signal";
import { studioSnapshot } from "./helpers/studio-fixtures";
import type { StoredEventSummary } from "../src/shared/contracts/project-bridge";
const now = Date.parse("2026-11-15T12:00:00Z");
function running() {
  const snapshot = studioSnapshot();
  snapshot.activeTurnId = "turn-live";
  snapshot.connection = {
    ...snapshot.connection,
    state: "running",
    since: new Date(now - 1000).toISOString(),
    lastEventAt: new Date(now).toISOString(),
  };
  return snapshot;
}
function frame(seq: number, kind: string, itemKind: string, itemId = "item-a"): StoredEventSummary {
  return {
    threadId: running().threadId!,
    turnId: "turn-live",
    itemId,
    seq,
    kind,
    timestamp: new Date(now).toISOString(),
    payload:
      kind === "item.delta"
        ? { kind: itemKind, delta: "text" }
        : { item: { id: itemId, kind: itemKind, name: "shell" } },
  };
}
const derive = (events: StoredEventSummary[]) => projectAgentWork(running(), events);
describe("agent activity evidence", () => {
  it("does not infer reasoning from an open turn or heartbeat", () => {
    expect(derive([frame(1, "operation.heartbeat", "")]).phase).toBe("waiting");
  });
  it("shows engine reasoning only while its item is open", () => {
    const events = [frame(1, "item.delta", "agent_reasoning")];
    expect(derive(events).phase).toBe("reasoning");
    events.push(frame(2, "item.completed", "agent_reasoning"));
    expect(derive(events).phase).toBe("waiting");
  });
  it("handles tool completion without a repeated kind and response streaming", () => {
    expect(derive([frame(1, "item.started", "tool_call")])).toMatchObject({
      phase: "tool",
      detail: "shell · awaiting its result",
    });
    expect(
      derive([frame(1, "item.started", "tool_call"), frame(2, "item.completed", "")]).phase,
    ).toBe("waiting");
    expect(derive([frame(1, "item.delta", "agent_message")]).phase).toBe("writing");
  });
  it("does not reuse old, foreign, or settled turn activity", () => {
    for (const overrides of [{ threadId: "other" }, { turnId: "old" }])
      expect(derive([{ ...frame(1, "item.started", "tool_call"), ...overrides }]).phase).toBe(
        "waiting",
      );
    expect(
      derive([frame(1, "item.started", "tool_call"), frame(2, "turn.completed", "")]).phase,
    ).toBe("waiting");
  });
  it("uses chronological sequence, not the arrival order of loaded pages", () => {
    expect(
      derive([frame(2, "item.completed", "tool_call"), frame(1, "item.started", "tool_call")])
        .phase,
    ).toBe("waiting");
  });
  it("stops motion and explicitly reports uncertainty when contact is stale", () => {
    const snapshot = running();
    expect(
      agentSignalAt(
        snapshot,
        derive([frame(1, "item.delta", "agent_reasoning")]),
        now + QUIET_AFTER_MS,
      ),
    ).toMatchObject({ phase: "quiet", animate: false });
  });
  it("does not call a reconnect or failure healthy even with a stored turn", () => {
    for (const state of ["reconnecting", "failed", "stopped"] as const) {
      const snapshot = running();
      snapshot.connection.state = state;
      expect(
        agentSignalAt(snapshot, derive([frame(1, "item.started", "tool_call")]), now),
      ).toMatchObject({ phase: "offline", animate: false });
    }
  });
  it("prioritizes actual human requests, including uncertain answers", () => {
    const snapshot = running();
    snapshot.pendingRequests = [{ status: "unknown" }] as typeof snapshot.pendingRequests;
    expect(agentSignalAt(snapshot, derive([]), now)).toMatchObject({
      phase: "human",
      label: "Needs the Human",
      animate: false,
    });
  });
  it("never says a completed or idle turn is still reasoning", () => {
    const snapshot = running();
    snapshot.activeTurnId = null;
    expect(
      agentSignalAt(snapshot, derive([frame(1, "item.delta", "agent_reasoning")]), now),
    ).toMatchObject({ phase: "idle", animate: false });
  });
});
