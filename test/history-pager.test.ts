import { describe, expect, it } from "vitest";
import { HistoryPager, mergeEvents, type HistorySource } from "../src/renderer/shell/history";
import type {
  HistoryCursor,
  HistoryPage,
  IpcResult,
  StoredEventSummary,
} from "../src/shared/contracts/project-bridge";
import type { ProjectId } from "../src/shared/contracts/ids";

function event(threadId: string, seq: number, text: string): StoredEventSummary {
  return {
    threadId,
    seq,
    kind: "item.delta",
    payload: { kind: "agent_message", delta: text },
    timestamp: new Date(Date.parse("2026-11-11T00:00:00.000Z") + seq * 1_000).toISOString(),
    turnId: "turn_one",
    itemId: "item_one",
  };
}

function page(
  events: StoredEventSummary[],
  olderCursor: HistoryCursor | null,
  hasMore: boolean,
  threadId: string | null = null,
  storedTotal = 12,
): IpcResult<HistoryPage> {
  return {
    ok: true,
    value: {
      events,
      olderCursor,
      hasMore,
      storedTotal,
      pageSize: events.length,
      threadId,
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const projectId = "prj_0123456789abcdef" as ProjectId;

describe("R02 history pager", () => {
  it("prepends older pages without duplicating a frame", async () => {
    const source: HistorySource = {
      page: async (_id, options) =>
        options.before
          ? page([event("thr_a", 1, "one"), event("thr_a", 2, "two")], null, false)
          : page([event("thr_a", 3, "three")], { recordedAt: "t3", rowId: 3 }, true),
      item: async () => ({ ok: false, error: { code: "X", message: "unused" } }),
    };
    const pager = new HistoryPager(source);
    const seen: number[] = [];
    pager.subscribe((view) => seen.push(view.events.length));
    pager.open(projectId, {
      events: [event("thr_a", 3, "three")],
      olderCursor: { recordedAt: "t3", rowId: 3 },
      hasMore: true,
      storedTotal: 12,
    });
    await pager.older();
    expect(pager.view().events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(pager.view().hasMore).toBe(false);
    expect(pager.view().olderCursor).toBeNull();
    expect(pager.view().loading).toBe(false);
    expect(seen).toContain(3);
  });

  it("discards a page that arrives for an abandoned thread", async () => {
    const first = deferred<IpcResult<HistoryPage>>();
    const calls: Array<string | null | undefined> = [];
    let resolveCount = 0;
    const source: HistorySource = {
      page: async (_id, options) => {
        calls.push(options.threadId);
        resolveCount += 1;
        if (resolveCount === 1) return first.promise;
        return options.threadId === "thr_b"
          ? page([event("thr_b", 1, "B")], null, false, "thr_b")
          : page([event("thr_a", 1, "A")], null, false, "thr_a");
      },
      item: async () => ({ ok: false, error: { code: "X", message: "unused" } }),
    };
    const pager = new HistoryPager(source);
    pager.open(projectId, { events: [], olderCursor: null, hasMore: false, storedTotal: 0 });
    const slow = pager.selectThread("thr_a");
    await pager.selectThread("thr_b");
    first.resolve(page([event("thr_a", 9, "stale")], null, false, "thr_a"));
    await slow;
    expect(calls).toEqual(["thr_a", "thr_b"]);
    expect(pager.view().threadId).toBe("thr_b");
    expect(pager.view().events.map((entry) => entry.threadId)).toEqual(["thr_b"]);
  });

  it("keeps loaded older pages when a live refresh arrives", () => {
    const pager = new HistoryPager({
      page: async () => page([], null, false),
      item: async () => ({ ok: false, error: { code: "X", message: "unused" } }),
    });
    pager.open(projectId, {
      events: [event("thr_a", 4, "four")],
      olderCursor: { recordedAt: "t4", rowId: 4 },
      hasMore: true,
      storedTotal: 12,
    });
    // Simulate an older page having been loaded.
    const merged = mergeEvents([event("thr_a", 1, "one")], pager.view().events);
    pager.open(projectId, {
      events: merged,
      olderCursor: { recordedAt: "t1", rowId: 1 },
      hasMore: true,
      storedTotal: 12,
    });
    pager.mergeLive(projectId, [event("thr_a", 5, "five")]);
    expect(pager.view().events.map((entry) => entry.seq)).toEqual([1, 4, 5]);
    expect(pager.view().hasMore).toBe(true);
  });

  it("filters a live refresh to the selected thread", async () => {
    const pager = new HistoryPager({
      page: async (_id, options) =>
        page([], null, false, options.threadId ?? null, options.threadId ? 30 : 60),
      item: async () => ({ ok: false, error: { code: "X", message: "unused" } }),
    });
    pager.open(projectId, { events: [], olderCursor: null, hasMore: false, storedTotal: 0 });
    await pager.selectThread("thr_a");
    expect(pager.view().storedTotal).toBe(30);
    pager.mergeLive(projectId, [event("thr_b", 1, "B"), event("thr_a", 2, "A")], 31);
    expect(pager.view().events.map((entry) => entry.threadId)).toEqual(["thr_a"]);
    expect(pager.view().storedTotal).toBe(31);
  });

  it("surfaces a failed page and keeps what is already shown", async () => {
    const pager = new HistoryPager({
      page: async () => ({ ok: false, error: { code: "DB_BUSY", message: "try again" } }),
      item: async () => ({ ok: false, error: { code: "X", message: "unused" } }),
    });
    pager.open(projectId, {
      events: [event("thr_a", 5, "five")],
      olderCursor: { recordedAt: "t5", rowId: 5 },
      hasMore: true,
      storedTotal: 12,
    });
    await pager.older();
    expect(pager.view().events.map((entry) => entry.seq)).toEqual([5]);
    expect(pager.view().error).toBe("DB_BUSY: try again");
    expect(pager.view().loading).toBe(false);
  });

  it("records a truncated item load instead of claiming it is complete", async () => {
    const pager = new HistoryPager({
      page: async () => page([], null, false),
      item: async () => ({
        ok: true,
        value: {
          threadId: "thr_a",
          itemId: "item_one",
          events: [event("thr_a", 1, "one")],
          truncated: true,
          storedCount: 5_000,
        },
      }),
    });
    pager.open(projectId, { events: [], olderCursor: null, hasMore: false, storedTotal: 0 });
    await pager.loadItem("thr_a", "item_one");
    expect(pager.view().truncatedItems["thr_a:item_one"]).toEqual({
      returned: 1,
      stored: 5_000,
    });
    expect(pager.view().completeItems["thr_a:item_one"]).toBeUndefined();
  });
});
