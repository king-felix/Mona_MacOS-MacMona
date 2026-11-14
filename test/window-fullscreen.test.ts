import { describe, expect, it, vi } from "vitest";
import type { WindowFullscreenView } from "../src/shared/contracts/bridge";
import {
  FULLSCREEN_CHANGED_CHANNEL,
  NativeFullscreen,
  type FullscreenWindow,
} from "../src/main/window-fullscreen";

/**
 * The rule under test: `fullscreen` is what the window reported, never what
 * was asked for. `setFullScreen` is asynchronous in real macOS — it returns
 * before the window is in its new Space — so a controller that flipped a
 * boolean on the call would claim a transition that had not happened.
 */
class FakeWindow implements FullscreenWindow {
  full = false;
  destroyed = false;
  readonly calls: boolean[] = [];
  readonly sent: Array<{ channel: string; payload: WindowFullscreenView }> = [];
  private readonly listeners = new Map<string, Array<() => void>>();

  isFullScreen(): boolean {
    return this.full;
  }

  setFullScreen(value: boolean): void {
    this.calls.push(value);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  off(event: "enter-full-screen" | "leave-full-screen", listener: () => void): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((entry) => entry !== listener),
    );
  }

  webContents = {
    send: (channel: string, payload: WindowFullscreenView): void => {
      this.sent.push({ channel, payload });
    },
  };

  /** What AppKit does later: change the state, then tell the window. */
  complete(value: boolean): void {
    this.full = value;
    for (const listener of this.listeners.get(value ? "enter-full-screen" : "leave-full-screen") ??
      []) {
      listener();
    }
  }

  emit(event: "enter-full-screen" | "leave-full-screen"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function controller(window: FakeWindow, platform = "darwin", settleMs = 60_000) {
  const warn = vi.fn();
  const subject = new NativeFullscreen({ window, platform, warn, settleMs });
  return { subject, warn };
}

describe("native fullscreen controller", () => {
  it("reads the window's state instead of assuming a windowed start", () => {
    const window = new FakeWindow();
    window.full = true;
    const { subject } = controller(window);
    expect(subject.view()).toEqual({ fullscreen: true, pending: false, available: true, epoch: 0 });
  });

  it("reports a request as pending, not as a transition", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    const view = subject.request(true);
    expect(window.calls).toEqual([true]);
    expect(view).toEqual({ fullscreen: false, pending: true, available: true, epoch: 0 });
    // The renderer hears "asked, not yet observed": the same windowed state plus
    // a pending flag. It never hears that the transition happened.
    expect(window.sent).toEqual([
      {
        channel: FULLSCREEN_CHANGED_CHANNEL,
        payload: { fullscreen: false, pending: true, available: true, epoch: 0 },
      },
    ]);
  });

  it("takes the state from the transition event and broadcasts it", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    subject.request(true);
    window.complete(true);
    expect(subject.view()).toEqual({ fullscreen: true, pending: false, available: true, epoch: 1 });
    // One pending broadcast, then the observed one.
    expect(window.sent).toHaveLength(2);
    expect(window.sent[1]?.channel).toBe(FULLSCREEN_CHANGED_CHANNEL);
    expect(window.sent[1]?.payload).toEqual(subject.view());
  });

  it("does not send a second request for a state already held or in flight", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    subject.request(true);
    subject.request(true);
    subject.request(true);
    expect(window.calls).toEqual([true]);
    window.complete(true);
    subject.request(true);
    // The window is already full screen: no call, and no pending intent.
    expect(window.calls).toEqual([true]);
    expect(subject.view().pending).toBe(false);
  });

  it("reverses a pending request instead of waiting for an animation", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    subject.request(true);
    const view = subject.request(false);
    expect(window.calls).toEqual([true, false]);
    // The intent is dropped: the window is (still) in the state that was asked
    // for, so nothing is pending and the confirmation is immediate.
    expect(view).toEqual({ fullscreen: false, pending: false, available: true, epoch: 0 });
    window.complete(false);
    expect(subject.view()).toMatchObject({ fullscreen: false, pending: false });
  });

  it("follows a transition nobody requested, such as the green button", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    window.complete(true);
    expect(window.calls).toEqual([]);
    expect(subject.view()).toMatchObject({ fullscreen: true, pending: false, epoch: 1 });
    expect(window.sent).toHaveLength(1);
  });

  it("ignores a duplicate transition that changes no fact", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    window.complete(true);
    window.emit("enter-full-screen");
    expect(subject.view().epoch).toBe(1);
    expect(window.sent).toHaveLength(1);
  });

  it("clears a pending request when the window refuses it", () => {
    const window = new FakeWindow();
    window.setFullScreen = () => {
      throw new Error("not allowed right now");
    };
    const { subject, warn } = controller(window);
    const view = subject.request(true);
    expect(view.fullscreen).toBe(false);
    expect(view.pending).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refused"));
    // The renderer still hears the truth, so a pending indicator cannot stick.
    expect(window.sent.map((entry) => entry.payload.pending)).toEqual([false]);
  });

  it("is unavailable away from macOS and says so without touching the window", () => {
    const window = new FakeWindow();
    const { subject, warn } = controller(window, "linux");
    const view = subject.request(true);
    expect(view).toEqual({ fullscreen: false, pending: false, available: false, epoch: 0 });
    expect(window.calls).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("drops an intent that macOS never answers instead of latching pending", async () => {
    const window = new FakeWindow();
    const { subject, warn } = controller(window, "darwin", 40);
    expect(subject.request(true).pending).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const view = subject.view();
    // The window never reported a transition, so the state is unchanged — and
    // the control is usable again instead of being disabled forever.
    expect(view).toEqual({ fullscreen: false, pending: false, available: true, epoch: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no native full screen transition"));
    // Pending, then the drop. Both are observations of the real state.
    expect(window.sent).toHaveLength(2);
    expect(window.sent.map((entry) => entry.payload.pending)).toEqual([true, false]);
    expect(subject.request(true).pending).toBe(true);
  });

  it("does nothing for a destroyed window and stops listening after dispose", () => {
    const window = new FakeWindow();
    const { subject } = controller(window);
    window.destroyed = true;
    expect(subject.request(true).pending).toBe(false);
    expect(window.calls).toEqual([]);
    window.destroyed = false;
    subject.dispose();
    window.complete(true);
    expect(subject.view()).toMatchObject({ fullscreen: false, epoch: 0 });
  });
});
