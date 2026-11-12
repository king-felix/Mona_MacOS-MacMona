import { describe, expect, it } from "vitest";
import type { ProjectId } from "../src/shared/contracts";
import { TaskBoard } from "../src/main/work/board";
import { PolishService } from "../src/main/work/polish";
import { PolishPreferencesStore } from "../src/main/work/preferences";
import { PolishNotifier } from "../src/main/work/notifications";
import {
  AttentionController,
  KeepAwake,
  type AttentionHost,
  type KeepAwakeHost,
} from "../src/main/work/attention";
import { ProjectService } from "../src/main/projects/service";
import type { RuntimeStatus } from "../src/main/supervisor/runtime-supervisor";
import { makeClock, openTestStore, tempDir } from "./helpers/state";

const runtime: RuntimeStatus = {
  state: "disconnected",
  reason: "none",
  since: "2026-11-12T00:00:00.000Z",
  workspace: null,
  ownershipId: null,
  port: null,
  engine: null,
  external: false,
  restarts: 0,
  lastFailure: null,
  pendingRestartInMs: null,
};

class FakeAttention implements AttentionHost {
  badges: string[] = [];
  menus: string[] = [];
  setBadge(badge: string): void {
    this.badges.push(badge);
  }
  setMenu(title: string): void {
    this.menus.push(title);
  }
  setLoginItem(): void {
    return undefined;
  }
  loginItem(): boolean {
    return false;
  }
  installed(): boolean {
    return true;
  }
  note(): string {
    return "fake";
  }
}

class FakePower implements KeepAwakeHost {
  started = 0;
  stopped = 0;
  start(): number {
    this.started += 1;
    return 3;
  }
  stop(): void {
    this.stopped += 1;
  }
}

async function bench() {
  const clock = makeClock("2026-11-12T09:00:00.000Z", 1_000);
  const { store } = await openTestStore({ now: clock.now });
  const root = tempDir("mona-polish-service-");
  const board = new TaskBoard({ store });
  const projects = new ProjectService({
    store,
    status: () => runtime,
    chooseFolder: async () => null,
    reveal: () => undefined,
  });
  const opened = await projects.open(root);
  if (!opened) throw new Error("project was not opened");
  const projectId = opened.project.id as ProjectId;
  const preferences = new PolishPreferencesStore({ store, timeZone: () => "UTC" });
  const attention = new FakeAttention();
  const power = new FakePower();
  const keepAwake = new KeepAwake(power);
  const notifier = new PolishNotifier({
    store,
    sources: {
      tasks: async () => [],
      problems: async () => [],
      budgets: async () => [],
    },
    host: {
      available: () => true,
      note: () => "fake",
      deliver: async () => "shown" as const,
    },
    preferences: () => preferences.get(),
    now: clock.now,
  });
  let turnActive = false;
  const service = new PolishService({
    store,
    board,
    projects,
    notifier,
    attention: new AttentionController(attention),
    keepAwake,
    preferences,
    isTurnActive: async () => turnActive,
    now: clock.now,
  });
  return {
    store,
    board,
    projectId,
    service,
    preferences,
    power,
    turnActive: (value: boolean) => {
      turnActive = value;
    },
  };
}

describe("polish service wiring", () => {
  it("holds one power assertion while work is active and releases it after", async () => {
    const b = await bench();
    await b.preferences.update({ keepAwakeDuringWork: true });
    const task = await b.board.create({
      projectId: b.projectId,
      title: "Long run",
      prompt: "Work for a while.",
    });
    const running = await b.board.startTask(task.id);
    void running;

    const active = await b.service.refresh(b.projectId);
    expect(b.power.started).toBe(1);
    expect(active.keepAwake.active).toBe(true);
    expect(active.keepAwake.scopedToActiveWork).toBe(true);

    // A second refresh during the same run does not stack assertions.
    await b.service.refresh(b.projectId);
    expect(b.power.started).toBe(1);

    // Interrupting the run releases it on the next observation.
    const current = await b.store.getTask(task.id);
    if (!current) throw new Error("task vanished");
    await b.store.updateTaskStatus(task.id, "interrupted", current.revision);
    const idle = await b.service.refresh(b.projectId);
    expect(b.power.stopped).toBe(1);
    expect(idle.keepAwake.active).toBe(false);
    expect(idle.keepAwake.scopedToActiveWork).toBe(false);
  });

  it("takes no assertion when the preference is off, even while work runs", async () => {
    const b = await bench();
    const task = await b.board.create({
      projectId: b.projectId,
      title: "Long run",
      prompt: "Work for a while.",
    });
    await b.board.startTask(task.id);
    const status = await b.service.refresh(b.projectId);
    expect(b.power.started).toBe(0);
    expect(status.keepAwake.active).toBe(false);
    expect(status.keepAwake.scopedToActiveWork).toBe(false);
    expect(status.keepAwake.note).toContain("turned off");
  });

  it("observes an engine turn that no task row records", async () => {
    const b = await bench();
    await b.preferences.update({ keepAwakeDuringWork: true });
    b.turnActive(true);
    const status = await b.service.refresh(b.projectId);
    expect(b.power.started).toBe(1);
    expect(status.attention.running).toBe(true);
    b.turnActive(false);
    await b.service.refresh(b.projectId);
    expect(b.power.stopped).toBe(1);
  });

  it("reports blockers in attention from stored problems", async () => {
    const b = await bench();
    const task = await b.board.create({
      projectId: b.projectId,
      title: "Blocked work",
      prompt: "Try repeatedly.",
      requirements: ["MONA-011"],
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await b.board.recordAttempt({
        projectId: b.projectId,
        taskId: task.id,
        requirement: "MONA-011",
        symptom: "still failing",
        hypothesis: `h${attempt}`,
        action: `a${attempt}`,
        observed: "still failing",
        materialProgress: false,
      });
    }
    const status = await b.service.refresh(b.projectId);
    expect(status.attention.blocked).toBe(1);
    expect(status.attention.badge).toBe("1");
  });
});
