import { describe, expect, it } from "vitest";
import type { ProjectId, TaskId } from "../src/shared/contracts";
import {
  defaultPolishPreferences,
  type PolishPreferences,
  type PolishFocusTarget,
} from "../src/shared/contracts/polish";
import {
  collectCandidates,
  inQuietHours,
  localMinutes,
  planNotification,
  PolishNotifier,
  type NotificationCandidate,
  type NotificationHost,
  type NotificationSources,
} from "../src/main/work/notifications";
import { makeClock, openTestStore } from "./helpers/state";

const projectId = "prj_0123456789abcdef" as ProjectId;
const taskId = "tsk_0123456789abcdef" as TaskId;

function preferences(
  overrides: Omit<Partial<PolishPreferences["notifications"]>, "quietHours"> & {
    quietHours?: Partial<PolishPreferences["notifications"]["quietHours"]>;
  } = {},
): PolishPreferences {
  const base = defaultPolishPreferences("UTC");
  return {
    ...base,
    notifications: {
      ...base.notifications,
      ...overrides,
      quietHours: { ...base.notifications.quietHours, ...(overrides.quietHours ?? {}) },
    },
  };
}

function candidate(
  at: string,
  overrides: Partial<NotificationCandidate> = {},
): NotificationCandidate {
  return {
    key: `task-completed:${taskId}:${at}`,
    kind: "completion",
    projectId,
    projectName: "Sensitive project name",
    at,
    taskId,
    problemId: null,
    changeSetId: null,
    title: "“secret prompt title” is verified",
    body: "docs/secret-file.ts",
    focus: {
      projectId,
      screen: "changes",
      taskId,
      problemId: null,
      changeSetId: null,
      fromNotification: true,
    } as PolishFocusTarget,
    ...overrides,
  };
}

function sources(tasks: Array<{ completedAt: string | null }> = []): NotificationSources {
  return {
    tasks: async () =>
      tasks.map((task, index) => ({
        id: `${taskId}${index}` as TaskId,
        title: `Task ${index}`,
        completedAt: task.completedAt,
      })),
    problems: async () => [],
    budgets: async () => [],
  };
}

function host(
  outcome: "shown" | "handed_over" | "failed" = "shown",
): NotificationHost & { delivered: Array<{ title: string; body: string }> } {
  const delivered: Array<{ title: string; body: string }> = [];
  return {
    delivered,
    available: () => true,
    note: () => "available",
    deliver: async (input) => {
      delivered.push({ title: input.title, body: input.body });
      return outcome;
    },
  };
}

describe("quiet hours", () => {
  it("handles an overnight window as half-open", () => {
    const quiet = { enabled: true, start: "22:00", end: "07:00", timeZone: "UTC" };
    const at = (iso: string) => new Date(iso);
    expect(inQuietHours(at("2026-11-12T21:59:00Z"), quiet)).toBe(false);
    expect(inQuietHours(at("2026-11-12T22:00:00Z"), quiet)).toBe(true);
    expect(inQuietHours(at("2026-11-13T03:30:00Z"), quiet)).toBe(true);
    expect(inQuietHours(at("2026-11-13T06:59:00Z"), quiet)).toBe(true);
    expect(inQuietHours(at("2026-11-13T07:00:00Z"), quiet)).toBe(false);
    expect(inQuietHours(at("2026-11-13T12:00:00Z"), quiet)).toBe(false);
  });

  it("follows the stated zone, not the host clock", () => {
    const instant = new Date("2026-11-12T23:30:00Z");
    expect(localMinutes(instant, "UTC")).toBe(23 * 60 + 30);
    expect(localMinutes(instant, "America/Los_Angeles")).toBe(15 * 60 + 30);
    expect(localMinutes(instant, "Europe/Berlin")).toBe(30);
    const window = { enabled: true, start: "22:00", end: "07:00", timeZone: "America/Los_Angeles" };
    expect(inQuietHours(instant, window)).toBe(false);
    expect(inQuietHours(instant, { ...window, timeZone: "Europe/Berlin" })).toBe(true);
  });

  it("treats equal endpoints as no window and invalid zones as not quiet", () => {
    const instant = new Date("2026-11-12T23:30:00Z");
    expect(
      inQuietHours(instant, { enabled: true, start: "22:00", end: "22:00", timeZone: "UTC" }),
    ).toBe(false);
    expect(
      inQuietHours(instant, { enabled: true, start: "22:00", end: "07:00", timeZone: "Not/AZone" }),
    ).toBe(false);
    expect(
      inQuietHours(instant, { enabled: false, start: "22:00", end: "07:00", timeZone: "UTC" }),
    ).toBe(false);
  });
});

describe("notification planning", () => {
  it("keeps detailed task text off the lock screen by default", () => {
    const plan = planNotification(
      candidate("2026-11-12T10:00:00Z"),
      preferences(),
      new Date("2026-11-12T10:00:00Z"),
    );
    expect(plan.deliver).toBe(true);
    expect(plan.title).toBe("Mona · work finished");
    expect(plan.title).not.toContain("secret");
    expect(plan.body).not.toContain("secret");
    expect(plan.body).not.toContain("docs/");
  });

  it("uses detailed text only after an explicit choice", () => {
    const plan = planNotification(
      candidate("2026-11-12T10:00:00Z"),
      preferences({ showDetails: true }),
      new Date("2026-11-12T10:00:00Z"),
    );
    expect(plan.title).toContain("Sensitive project name");
    expect(plan.body).toContain("secret prompt title");
  });

  it("suppresses a disabled category or a global off switch with a reason", () => {
    const at = new Date("2026-11-12T10:00:00Z");
    expect(
      planNotification(candidate("2026-11-12T10:00:00Z"), preferences({ completion: false }), at)
        .reason,
    ).toMatch(/completion notifications/);
    expect(
      planNotification(candidate("2026-11-12T10:00:00Z"), preferences({ enabled: false }), at)
        .reason,
    ).toMatch(/turned off/);
  });
});

describe("notification delivery", () => {
  it("announces a completion once and survives a reconnect", async () => {
    const clock = makeClock("2026-11-12T10:00:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const firstHost = host();
    const first = new PolishNotifier({
      store,
      sources: sources(),
      host: firstHost,
      preferences: async () => preferences(),
      now: clock.now,
    });
    // First refresh seeds the cursor; old history is not replayed.
    expect(await first.refresh(projectId)).toEqual([]);
    const afterSeed = clock.now().getTime();
    clock.advance(10_000);
    const completedAt = new Date(afterSeed + 5_000).toISOString();
    const second = new PolishNotifier({
      store,
      sources: sources([{ completedAt }]),
      host: firstHost,
      preferences: async () => preferences(),
      now: clock.now,
    });
    const receipts = await second.refresh(projectId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.delivery).toBe("shown");
    expect(receipts[0]?.delivered).toBe(true);
    expect(firstHost.delivered).toHaveLength(1);
    expect(firstHost.delivered[0]?.title).toBe("Mona · work finished");

    // A new instance after a relaunch reads the durable keys and stays quiet.
    const reconnectHost = host();
    const reconnected = new PolishNotifier({
      store,
      sources: sources([{ completedAt }]),
      host: reconnectHost,
      preferences: async () => preferences(),
      now: clock.now,
    });
    expect(await reconnected.refresh(projectId)).toEqual([]);
    expect(reconnectHost.delivered).toHaveLength(0);
  });

  it("records quiet-hours suppression once instead of delivering later", async () => {
    const clock = makeClock("2026-11-12T22:30:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const quietHost = host();
    const notifier = new PolishNotifier({
      store,
      sources: sources(),
      host: quietHost,
      preferences: async () => preferences({ quietHours: { enabled: true } }),
      now: clock.now,
    });
    await notifier.refresh(projectId);
    const afterSeed = clock.now().getTime();
    clock.advance(10_000);
    const completedAt = new Date(afterSeed + 5_000).toISOString();
    const withTask = new PolishNotifier({
      store,
      sources: sources([{ completedAt }]),
      host: quietHost,
      preferences: async () => preferences({ quietHours: { enabled: true } }),
      now: clock.now,
    });
    const receipts = await withTask.refresh(projectId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.delivered).toBe(false);
    expect(receipts[0]?.suppressedReason).toContain("quiet hours");
    expect(quietHost.delivered).toHaveLength(0);

    // Morning: the suppressed alert is not queued or replayed.
    const morning = new PolishNotifier({
      store,
      sources: sources([]),
      host: quietHost,
      preferences: async () => preferences(),
      now: () => new Date("2026-11-13T09:00:00.000Z"),
    });
    expect(await morning.refresh(projectId)).toEqual([]);
    expect(quietHost.delivered).toHaveLength(0);
  });

  it("does not announce an old completion on the first run", async () => {
    const clock = makeClock("2026-11-12T10:00:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const quiet = host();
    const notifier = new PolishNotifier({
      store,
      sources: sources([{ completedAt: "2026-11-01T10:00:00.000Z" }]),
      host: quiet,
      preferences: async () => preferences(),
      now: clock.now,
    });
    expect(await notifier.refresh(projectId)).toEqual([]);
    clock.advance(1_000);
    expect(await notifier.refresh(projectId)).toEqual([]);
    expect(quiet.delivered).toHaveLength(0);
  });

  it("treats a limit alert as deduplicated by window rather than by cursor", async () => {
    const clock = makeClock("2026-11-12T10:00:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const limitHost = host();
    const limitSources: NotificationSources = {
      ...sources(),
      budgets: async () => [
        {
          id: "bdg_0000000000000001",
          level: "warn" as const,
          message: "Project budget warning",
          at: "2026-11-12T00:00:00.000Z",
        },
      ],
    };
    const notifier = new PolishNotifier({
      store,
      sources: limitSources,
      host: limitHost,
      preferences: async () => preferences(),
      now: clock.now,
    });
    await notifier.refresh(projectId);
    clock.advance(1_000);
    const delivered = await notifier.refresh(projectId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe("limit");
    clock.advance(1_000);
    expect(await notifier.refresh(projectId)).toEqual([]);
    expect(limitHost.delivered).toHaveLength(1);
  });

  it("collects only records newer than the watermark, except windowed limits", async () => {
    const at = new Date("2026-11-12T12:00:00.000Z").toISOString();
    const collected = await collectCandidates(
      projectId,
      "Project",
      {
        tasks: async () => [{ id: taskId, title: "Done", completedAt: at }],
        problems: async () => [
          {
            id: "prb_0000000000000001",
            taskId,
            title: "Blocked",
            requirement: "MONA-011",
            helpNeeded: "a decision",
            blockedAt: "2026-11-12T11:00:00.000Z",
          },
        ],
        budgets: async () => [
          {
            id: "bdg_0000000000000001",
            level: "stop" as const,
            message: "Budget stop",
            at: "2026-11-12T00:00:00.000Z",
          },
        ],
      },
      "2026-11-12T11:30:00.000Z",
    );
    expect(collected.map((entry) => entry.kind).sort()).toEqual(["completion", "limit"]);
  });
});

describe("delivery honesty", () => {
  async function seed(
    store: Awaited<ReturnType<typeof openTestStore>>["store"],
    clock: ReturnType<typeof makeClock>,
  ) {
    clock.advance(1_000);
    await new PolishNotifier({
      store,
      sources: sources(),
      host: host(),
      preferences: async () => preferences(),
      now: clock.now,
    }).refresh(projectId);
    return clock.now().getTime() + 5_000;
  }

  it("records a system refusal as failed, never as delivered", async () => {
    const clock = makeClock("2026-11-12T10:00:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const completedAt = new Date(await seed(store, clock)).toISOString();
    clock.advance(1_000);
    const refusing = host("failed");
    const notifier = new PolishNotifier({
      store,
      sources: sources([{ completedAt }]),
      host: refusing,
      preferences: async () => preferences(),
      now: clock.now,
    });
    const receipts = await notifier.refresh(projectId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.delivery).toBe("failed");
    expect(receipts[0]?.delivered).toBe(false);
    expect(receipts[0]?.suppressedReason).toContain("did not accept");
    // A refusal is still not retried forever: the key is spent.
    clock.advance(1_000);
    expect(await notifier.refresh(projectId)).toEqual([]);
  });

  it("separates a handover from a confirmed display", async () => {
    const clock = makeClock("2026-11-12T10:00:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const completedAt = new Date(await seed(store, clock)).toISOString();
    clock.advance(1_000);
    const notifier = new PolishNotifier({
      store,
      sources: sources([{ completedAt }]),
      host: host("handed_over"),
      preferences: async () => preferences(),
      now: clock.now,
    });
    const receipts = await notifier.refresh(projectId);
    expect(receipts[0]?.delivery).toBe("handed_over");
    expect(receipts[0]?.delivered).toBe(false);
    expect(receipts[0]?.suppressedReason).toContain("without a display confirmation");
  });

  it("delivers once when two refreshes overlap", async () => {
    const clock = makeClock("2026-11-12T10:00:00.000Z", 1_000);
    const { store } = await openTestStore({ now: clock.now });
    const completedAt = new Date(await seed(store, clock)).toISOString();
    clock.advance(1_000);
    const shared = host();
    const notifier = new PolishNotifier({
      store,
      sources: sources([{ completedAt }]),
      host: shared,
      preferences: async () => preferences(),
      now: clock.now,
    });
    // Main and the renderer both observe the same terminal push.
    const [first, second] = await Promise.all([
      notifier.refresh(projectId),
      notifier.refresh(projectId),
    ]);
    expect(first.length + second.length).toBe(1);
    expect(shared.delivered).toHaveLength(1);
  });
});
