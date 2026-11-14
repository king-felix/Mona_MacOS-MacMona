import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectId } from "../src/shared/contracts";
import { ProjectService } from "../src/main/projects/service";
import type { RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import type { StoredEventSummary } from "../src/shared/contracts/project-bridge";
import { mergeEvents } from "../src/renderer/shell/history";
import { projectTimeline } from "../src/renderer/shell/timeline";
import { openTestStore } from "./helpers/state";

function status(): RuntimeStatus {
  return {
    state: "disconnected",
    reason: "not_started",
    since: "2026-11-11T00:00:00.000Z",
    workspace: null,
    ownershipId: null,
    port: null,
    engine: null,
    external: false,
    restarts: 0,
    lastFailure: null,
    pendingRestartInMs: null,
  };
}

async function setup() {
  const handle = await openTestStore();
  const service = new ProjectService({
    store: handle.store,
    status,
    chooseFolder: async () => null,
    reveal: () => undefined,
  });
  const folder = join(handle.dir, "history-project");
  mkdirSync(folder, { recursive: true });
  const opened = await service.open(folder);
  if (!opened) throw new Error("project did not open");
  const detail = await service.detail(opened.project.id as ProjectId);
  return {
    ...handle,
    service,
    projectId: opened.project.id as ProjectId,
    threadId: detail.threads[0]!.id,
  };
}

const base = Date.parse("2026-11-11T00:00:00.000Z");
const at = (seq: number): string => new Date(base + seq * 1_000).toISOString();

describe("R02 paged stored history", () => {
  it("keeps a 10,000+ event project reachable page by page, once each", async () => {
    const { service, store, projectId, threadId } = await setup();
    const total = 10_050;
    for (let seq = 1; seq <= total; seq += 1) {
      await store.recordEvent({
        threadId,
        seq,
        // A long session is mostly plumbing and status; it still has to be
        // reachable. Nothing here starts a runtime or asks a model.
        kind: seq % 25 === 0 ? "operation.heartbeat" : "status.note",
        payload: { seq },
        timestamp: at(seq),
      });
    }

    const first = await service.detail(projectId);
    expect(first.history.storedTotal).toBe(total);
    expect(first.history.hasMore).toBe(true);
    expect(first.events).toHaveLength(200);
    expect(first.events[first.events.length - 1]?.seq).toBe(total);
    expect(first.history.olderCursor).not.toBeNull();

    const revisionBefore = await store.stateRevision();
    const seen: number[] = first.events.map((event) => event.seq);
    let cursor = first.history.olderCursor;
    let pages = 1;
    while (cursor) {
      const page = await service.history(projectId, { before: cursor, limit: 500 });
      expect(page.events.length).toBeGreaterThan(0);
      expect(page.events.length).toBeLessThanOrEqual(500);
      expect(page.storedTotal).toBe(total);
      seen.push(...page.events.map((event) => event.seq));
      cursor = page.olderCursor;
      pages += 1;
      if (pages > 40) throw new Error("paging did not terminate");
    }
    const revisionAfter = await store.stateRevision();

    // Every stored frame is reachable exactly once, from the live edge back to
    // the first event.
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(total);
    // Reading history is a read: no state revision moves, so no write, no
    // runtime, and no provider request happened.
    expect(revisionAfter).toBe(revisionBefore);
  }, 120_000);

  it("reconstructs a 2,000+ frame item whose beginning predates the page", async () => {
    const { service, store, projectId, threadId } = await setup();
    const turnId = "turn_long0000000000001";
    let seq = 0;
    const next = (): number => {
      seq += 1;
      return seq;
    };
    await store.recordEvent({
      threadId,
      seq: next(),
      kind: "turn.started",
      payload: { permission_posture: "full_access" },
      timestamp: at(seq),
      turnId,
    });
    const bigChunks: string[] = [];
    const smallChunks: string[] = [];
    for (let index = 0; index < 2_100; index += 1) {
      if (index % 40 === 39) {
        await store.recordEvent({
          threadId,
          seq: next(),
          kind: "operation.heartbeat",
          payload: { observed_at: at(seq) },
          timestamp: at(seq),
          turnId,
        });
      }
      const chunk = `big-${index} `;
      bigChunks.push(chunk);
      await store.recordEvent({
        threadId,
        seq: next(),
        kind: "item.delta",
        payload: { kind: "agent_message", delta: chunk },
        timestamp: at(seq),
        turnId,
        itemId: "item_big",
      });
      if (index < 300) {
        const other = `small-${index} `;
        smallChunks.push(other);
        await store.recordEvent({
          threadId,
          seq: next(),
          kind: "item.delta",
          payload: { kind: "agent_message", delta: other },
          timestamp: at(seq),
          turnId,
          itemId: "item_small",
        });
      }
    }
    await store.recordEvent({
      threadId,
      seq: next(),
      kind: "item.completed",
      payload: { item: { id: "item_big", kind: "agent_message", status: "completed" } },
      timestamp: at(seq),
      turnId,
      itemId: "item_big",
    });
    await store.recordEvent({
      threadId,
      seq: next(),
      kind: "item.completed",
      payload: { item: { id: "item_small", kind: "agent_message", status: "completed" } },
      timestamp: at(seq),
      turnId,
      itemId: "item_small",
    });
    await store.recordEvent({
      threadId,
      seq: next(),
      kind: "turn.completed",
      payload: {},
      timestamp: at(seq),
      turnId,
    });

    const first = await service.detail(projectId);
    expect(first.history.hasMore).toBe(true);
    const tailEvents = first.events as StoredEventSummary[];
    const paged = projectTimeline(tailEvents, { historyComplete: false });
    const bigTail = paged.entries.find((entry) => entry.itemId === "item_big");
    expect(bigTail).toMatchObject({ kind: "assistant", partial: true });
    expect(bigTail?.body.length).toBeLessThan(bigChunks.join("").length);

    const item = await service.historyItem(projectId, threadId, "item_big");
    expect(item.truncated).toBe(false);
    expect(item.storedCount).toBe(2_101);
    expect(item.events.every((event) => event.itemId === "item_big")).toBe(true);
    // The interleaved item's completion is in the tail, so it is visible as a
    // partial card; loading its own frames is how a reader rebuilds it.
    const smallItem = await service.historyItem(projectId, threadId, "item_small");
    expect(smallItem.storedCount).toBe(301);

    const merged = mergeEvents(
      item.events as StoredEventSummary[],
      smallItem.events as StoredEventSummary[],
      tailEvents,
    );
    // Still paged overall, but this item's beginning is now in hand.
    const rebuilt = projectTimeline(merged, {
      historyComplete: false,
      completeItems: new Set([`${threadId}:item_big`, `${threadId}:item_small`]),
    });
    const big = rebuilt.entries.find((entry) => entry.itemId === "item_big");
    expect(big?.partial).toBe(false);
    expect(big?.body).toBe(bigChunks.join(""));
    // The interleaved item stays its own card; nothing was merged by kind.
    const small = rebuilt.entries.find((entry) => entry.itemId === "item_small");
    expect(small?.body).toBe(smallChunks.join(""));
    expect(rebuilt.entries.filter((entry) => entry.kind === "assistant")).toHaveLength(2);
  }, 120_000);

  it("pages a thread filter separately from the project total", async () => {
    const { service, store, projectId, threadId } = await setup();
    const second = await store.upsertThread({ id: "thr_second00000000001", projectId });
    for (let seq = 1; seq <= 30; seq += 1) {
      await store.recordEvent({
        threadId,
        seq,
        kind: "status.note",
        payload: { thread: "first", seq },
        timestamp: at(seq),
      });
      await store.recordEvent({
        threadId: second.id,
        seq: seq + 100,
        kind: "status.note",
        payload: { thread: "second", seq },
        timestamp: at(seq + 1_000),
      });
    }
    const all = await service.history(projectId, { limit: 500 });
    expect(all.storedTotal).toBe(60);
    const filtered = await service.history(projectId, { threadId: second.id, limit: 500 });
    expect(filtered.storedTotal).toBe(30);
    expect(filtered.events.every((event) => event.threadId === second.id)).toBe(true);
    expect(filtered.threadId).toBe(second.id);
  }, 60_000);

  it("refuses a thread that belongs to another project", async () => {
    const { service, store, projectId, dir } = await setup();
    await expect(
      service.history(projectId, { threadId: "thr_not_in_project" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      service.historyItem(projectId, "thr_not_in_project", "item_x"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // A second project's thread is equally refused.
    const otherFolder = join(dir, "other-project");
    mkdirSync(otherFolder, { recursive: true });
    const other = await service.open(otherFolder);
    const otherDetail = await service.detail(other!.project.id as ProjectId);
    await expect(
      service.history(projectId, { threadId: otherDetail.threads[0]!.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    void store;
  });

  it("does not count a duplicate replay as a second stored frame", async () => {
    const { service, store, projectId, threadId } = await setup();
    const input = {
      threadId,
      seq: 7,
      kind: "item.delta" as const,
      payload: { kind: "agent_message", delta: "once" },
      timestamp: at(7),
      turnId: "turn_dup",
      itemId: "item_dup",
    };
    const first = await store.recordEvent(input);
    const replay = await store.recordEvent(input);
    expect(first.recorded).toBe(true);
    expect(replay.recorded).toBe(false);
    const page = await service.detail(projectId);
    expect(page.history.storedTotal).toBe(1);
    expect(page.events).toHaveLength(1);
  });
});
