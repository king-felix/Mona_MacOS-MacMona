import type { WindowFullscreenView } from "../shared/contracts/bridge";

/**
 * Native macOS full screen, owned by main and scoped to one window.
 *
 * Three rules decide this module's shape:
 *
 * 1. **Events are the authority.** `setFullScreen(true)` returns immediately;
 *    macOS animates the window into a new Space and reports completion later
 *    through `enter-full-screen`. Until that event arrives the only honest
 *    answer is "asked, not yet observed", which is what `pending` says.
 * 2. **The request is window-scoped.** The IPC handler resolves the invoking
 *    window, so a renderer can never put another window (or the app) into full
 *    screen.
 * 3. **This is OS state, not a view preference.** Nothing here is persisted or
 *    restored: a relaunch opens a normal window, and the stored layout
 *    preference stays a separate record in the project view.
 *
 * The window seam is structural so the whole state machine is testable without
 * an Electron runtime.
 */

export const FULLSCREEN_CHANGED_CHANNEL = "window:fullscreen-changed";

export interface FullscreenWindow {
  isFullScreen(): boolean;
  setFullScreen(fullscreen: boolean): void;
  isDestroyed?(): boolean;
  on(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  off?(event: "enter-full-screen" | "leave-full-screen", listener: () => void): unknown;
  webContents: {
    send(channel: string, payload: WindowFullscreenView): void;
  };
}

export interface NativeFullscreenOptions {
  window: FullscreenWindow;
  /** `darwin` in the product; injected so the refusal path is testable. */
  platform?: string;
  /** Never throws into an IPC handler; reported instead. */
  warn?: (message: string) => void;
  /**
   * How long a request may stay unobserved before the intent is dropped. AppKit
   * can ignore a transition outright (an inactive app, a busy Space); without a
   * deadline `pending` would latch and the control would stay disabled forever.
   */
  settleMs?: number;
}

export class NativeFullscreen {
  private readonly window: FullscreenWindow;
  private readonly available: boolean;
  private readonly warn: (message: string) => void;
  private readonly settleMs: number;
  private observed: boolean;
  private pending: boolean | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private transitions = 0;
  private disposed = false;
  private readonly onEnter = () => this.observe(true);
  private readonly onLeave = () => this.observe(false);

  constructor(options: NativeFullscreenOptions) {
    this.window = options.window;
    this.available = (options.platform ?? process.platform) === "darwin";
    this.warn = options.warn ?? (() => undefined);
    this.settleMs = options.settleMs ?? 4_000;
    this.observed = this.readWindow();
    this.window.on("enter-full-screen", this.onEnter);
    this.window.on("leave-full-screen", this.onLeave);
  }

  view(): WindowFullscreenView {
    return {
      fullscreen: this.observed,
      pending: this.pending !== null,
      available: this.available,
      epoch: this.transitions,
    };
  }

  /**
   * Ask for a state. Returns the view as it stands *after* the request, where
   * `fullscreen` is still the last observed value. A repeat request for the
   * state already in flight is coalesced rather than sent twice.
   */
  request(fullscreen: boolean): WindowFullscreenView {
    if (!this.available) {
      this.warn("native full screen is only offered on macOS");
      return this.view();
    }
    if (this.disposed || this.window.isDestroyed?.() === true) return this.view();
    if (fullscreen === this.observed) {
      // The window is already in the requested state. If a request for the
      // opposite state is still in flight this is a reversal: ask the window
      // for the state it is still in, then drop the intent. A macOS transition
      // that lands anyway arrives as an event and corrects the view.
      if (this.pending !== null) {
        this.pending = null;
        try {
          this.window.setFullScreen(fullscreen);
        } catch (error) {
          this.warn(
            `the window refused the cancellation: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.publish();
      }
      return this.view();
    }
    if (this.pending === fullscreen) return this.view();
    this.pending = fullscreen;
    this.armSettle();
    try {
      this.window.setFullScreen(fullscreen);
      // Tell the renderer the request is in flight. `fullscreen` still carries
      // the last observed state, so a UI can show "waiting" without claiming
      // the transition happened. Skipped here without a listener it is simply
      // the same view again.
      this.publish();
    } catch (error) {
      this.clearSettle();
      this.pending = null;
      this.warn(
        `the window refused native full screen: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.publish();
    }
    return this.view();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.clearSettle();
    this.window.off?.("enter-full-screen", this.onEnter);
    this.window.off?.("leave-full-screen", this.onLeave);
  }

  /** The window's own report, read at the event rather than inferred. */
  private readWindow(): boolean {
    try {
      return this.window.isFullScreen() === true;
    } catch {
      return false;
    }
  }

  private observe(expected: boolean): void {
    if (this.disposed) return;
    const next = this.window.isDestroyed?.() === true ? expected : this.readWindow();
    // A transition that lands on the state already held (a duplicate event)
    // changes no fact, so it must not advance the epoch or wake the renderer.
    if (next === this.observed && this.pending === null) return;
    this.observed = next;
    this.pending = null;
    this.clearSettle();
    this.transitions += 1;
    this.publish();
  }

  private armSettle(): void {
    this.clearSettle();
    const timer = setTimeout(() => {
      this.settleTimer = null;
      if (this.disposed || this.pending === null) return;
      // No transition was observed in time. The state is unchanged and the
      // intent is dropped, so the control becomes usable again and the view
      // still says exactly what the window reports.
      this.pending = null;
      this.warn("no native full screen transition was observed; the request was dropped");
      this.publish();
    }, this.settleMs);
    // A pending screen transition must never hold the process open.
    (timer as { unref?: () => void }).unref?.();
    this.settleTimer = timer;
  }

  private clearSettle(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private publish(): void {
    if (this.window.isDestroyed?.() === true) return;
    try {
      this.window.webContents.send(FULLSCREEN_CHANGED_CHANNEL, this.view());
    } catch (error) {
      this.warn(
        `the fullscreen observation could not be delivered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
