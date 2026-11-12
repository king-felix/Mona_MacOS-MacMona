import { describe, expect, it } from "vitest";
import type { InterruptReceipt } from "../src/main/engine/types";
import type { SupervisorStopReceipt } from "../src/main/supervisor/native";
import { WorkController, type TaskRef } from "../src/main/work/control";

const task = (id: string): TaskRef => ({ id, workspace: "/tmp/ws" });

function stopReceipt(overrides: Partial<SupervisorStopReceipt> = {}): SupervisorStopReceipt {
  return {
    ok: true,
    state: "stopped",
    graceful: true,
    escalated: false,
    survivors: [],
    via: "control_socket",
    ...overrides,
  };
}

function interruptReceipt(overrides: Partial<InterruptReceipt> = {}): InterruptReceipt {
  return { interrupted: true, turn: null, note: "interrupt confirmed", ...overrides };
}

function controller(
  interrupt: () => Promise<InterruptReceipt> = async () => interruptReceipt(),
  stop: () => Promise<SupervisorStopReceipt> = async () => stopReceipt(),
) {
  const calls: string[] = [];
  const work = new WorkController({
    interrupt: async () => {
      calls.push("interrupt");
      return interrupt();
    },
    stopOwnedRuntime: async () => {
      calls.push("stop");
      return stop();
    },
  });
  return { work, calls };
}

describe("work transitions stay distinct", () => {
  it("pause after task lets the active task finish and holds the queue", () => {
    const { work, calls } = controller();
    work.enqueue(task("b"));
    work.begin({ task: task("a"), turnId: "turn_1" });
    const pause = work.pauseAfterTask();
    expect(pause).toMatchObject({ action: "pause_after_task", boundary: "after_active_task" });
    expect(work.snapshot().active?.task.id).toBe("a");
    const finished = work.taskFinished();
    expect(finished).toEqual({ next: null, paused: true });
    expect(work.snapshot().queued.map((item) => item.id)).toEqual(["b"]);
    expect(calls).toEqual([]);
  });

  it("interrupt now is an engine operation and does not cancel the queue", async () => {
    const { work, calls } = controller();
    work.enqueue(task("b"));
    work.begin({ task: task("a"), turnId: "turn_1" });
    const transition = await work.interruptNow();
    expect(transition).toMatchObject({
      action: "interrupt_now",
      requested: true,
      confirmed: true,
      uncertain: false,
    });
    expect(calls).toEqual(["interrupt"]);
    expect(work.snapshot().queued.map((item) => item.id)).toEqual(["b"]);
  });

  it("reports an uncertain interrupt instead of claiming a stop", async () => {
    const { work } = controller(async () => {
      throw new Error("socket closed");
    });
    work.begin({ task: task("a"), turnId: "turn_1" });
    const transition = await work.interruptNow();
    expect(transition.confirmed).toBe(false);
    expect(transition.uncertain).toBe(true);
    expect(transition.note).toContain("outcome unknown");
  });

  it("cancel queued removes future starts only", () => {
    const { work } = controller();
    work.enqueue(task("b"));
    work.enqueue(task("c"));
    work.begin({ task: task("a"), turnId: "turn_1" });
    const transition = work.cancelQueued();
    expect(transition.canceled.map((item) => item.id)).toEqual(["b", "c"]);
    expect(work.snapshot().active?.task.id).toBe("a");
    expect(work.snapshot().queued).toEqual([]);
  });

  it("quit and stop work interrupts first, then stops, and never claims rollback", async () => {
    const { work, calls } = controller(
      async () => interruptReceipt(),
      async () => stopReceipt({ escalated: true }),
    );
    work.enqueue(task("b"));
    work.begin({ task: task("a"), turnId: "turn_1" });
    const transition = await work.quitAndStopWork();
    expect(calls).toEqual(["interrupt", "stop"]);
    expect(transition).toMatchObject({
      action: "quit_and_stop_work",
      interrupted: true,
      stopped: true,
      escalated: true,
      rollback: "not_promised",
    });
    expect(transition.notes.join(" ")).toContain("not rollback");
    expect(work.snapshot().quitting).toBe(true);
  });

  it("distinguishes an uncertain interrupt from a confirmed one during quit", async () => {
    const { work } = controller(
      async () => {
        throw new Error("timeout");
      },
      async () => stopReceipt(),
    );
    work.begin({ task: task("a"), turnId: "turn_1" });
    const transition = await work.quitAndStopWork();
    expect(transition.interrupted).toBe(false);
    expect(transition.interruptUncertain).toBe(true);
    expect(transition.stopped).toBe(true);
  });

  it("does not silently turn a failed stop into success", async () => {
    const { work } = controller(
      async () => interruptReceipt(),
      async () => stopReceipt({ ok: false, state: "survivors", survivors: [4242] }),
    );
    work.begin({ task: task("a"), turnId: "turn_1" });
    const transition = await work.quitAndStopWork();
    expect(transition.stopped).toBe(false);
    expect(transition.survivors).toEqual([4242]);
  });

  it("refuses new work once quitting has begun", async () => {
    const { work } = controller();
    await work.quitAndStopWork();
    expect(() => work.enqueue(task("late"))).toThrow(/queue is closed/);
  });
});
