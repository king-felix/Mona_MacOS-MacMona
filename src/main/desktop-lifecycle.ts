import { app, BrowserWindow, powerMonitor, type WebContents } from "electron";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { RuntimeStatus, RuntimeSupervisor } from "./supervisor/runtime-supervisor";
import type { QuitTransition, WorkController, WorkSnapshot } from "./work/control";

export interface OpenRequest {
  path: string;
  receivedAt: string;
  source: "second_instance" | "argv";
}

export interface DesktopLifecycleStatus {
  quitRequested: boolean;
  shutdownRunning: boolean;
  shutdownComplete: boolean;
  shutdownReceipt: QuitTransition | null;
  shutdownError: string | null;
  lastOpenRequest: OpenRequest | null;
  rendererCrashes: number;
  lastPowerEvent: string | null;
  runtime: RuntimeStatus;
  work: WorkSnapshot;
}

export interface DesktopLifecycleOptions {
  supervisor: RuntimeSupervisor;
  work: WorkController;
  currentWindow: () => BrowserWindow | null;
  openWindow: () => BrowserWindow;
  onStatus?: (status: DesktopLifecycleStatus) => void;
  shutdownTimeoutMs?: number;
}

/**
 * The desktop ownership boundary:
 *
 *  - closing the last window keeps Mona and its runtime alive;
 *  - a renderer crash never touches the runtime;
 *  - sleep becomes reconnecting, not a new request;
 *  - quitting runs Interrupt now (if anything is running) and then stops the
 *    owned process tree, with a bounded forced step if graceful stops fail;
 *  - a second launcher hands its folder to this instance instead of starting
 *    a second owner.
 */
export class DesktopLifecycle {
  private quitRequested = false;
  private shutdownRunning = false;
  private shutdownComplete = false;
  private shutdownReceipt: QuitTransition | null = null;
  private shutdownError: string | null = null;
  private lastOpenRequest: OpenRequest | null = null;
  private rendererCrashes = 0;
  private lastPowerEvent: string | null = null;
  private installed = false;
  private crashHandled = false;

  constructor(private readonly options: DesktopLifecycleOptions) {}

  status(): DesktopLifecycleStatus {
    return {
      quitRequested: this.quitRequested,
      shutdownRunning: this.shutdownRunning,
      shutdownComplete: this.shutdownComplete,
      shutdownReceipt: this.shutdownReceipt,
      shutdownError: this.shutdownError,
      lastOpenRequest: this.lastOpenRequest,
      rendererCrashes: this.rendererCrashes,
      lastPowerEvent: this.lastPowerEvent,
      runtime: this.options.supervisor.status(),
      work: this.options.work.snapshot(),
    };
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;

    app.on("second-instance", (_event, argv, workingDirectory) => {
      const request = this.parseOpenRequest(argv, workingDirectory);
      if (request) this.lastOpenRequest = request;
      this.focusWindow();
      this.emit();
    });

    app.on("before-quit", (event) => {
      if (this.shutdownComplete) return;
      event.preventDefault();
      this.quitRequested = true;
      void this.shutdown("before-quit");
    });

    app.on("window-all-closed", () => {
      // macOS keeps the process alive; any owned runtime keeps running too.
      this.emit();
    });

    app.on("web-contents-created", (_event, contents) => {
      this.watchRenderer(contents);
    });

    const registerPowerEvents = () => {
      powerMonitor.on("suspend", () => {
        this.lastPowerEvent = "suspend";
        this.options.supervisor.noteSuspend();
        this.emit();
      });
      powerMonitor.on("resume", () => {
        this.lastPowerEvent = "resume";
        void this.options.supervisor.noteResume().then(() => this.emit());
      });
    };
    if (app.isReady()) registerPowerEvents();
    else void app.whenReady().then(registerPowerEvents);

    // Only a genuine uncaught exception is a main-process failure. Routine
    // promise rejections must not be treated as fatal and lose user work.
    process.on("uncaughtException", (error) => {
      void this.handleMainFailure(error);
    });
  }

  watchRenderer(contents: WebContents): void {
    contents.on("render-process-gone", (_event, details) => {
      this.rendererCrashes += 1;
      this.options.supervisor.noteRendererCrash({
        reason: details.reason,
        exitCode: details.exitCode,
      });
      this.emit();
    });
  }

  /** A second launch hands its folder to the existing owner. */
  handleSecondInstance(argv: string[], workingDirectory: string): OpenRequest | null {
    const request = this.parseOpenRequest(argv, workingDirectory);
    if (request) this.lastOpenRequest = request;
    this.focusWindow();
    this.emit();
    return request;
  }

  async shutdown(reason: string): Promise<DesktopLifecycleStatus> {
    if (this.shutdownRunning || this.shutdownComplete) return this.status();
    this.shutdownRunning = true;
    this.options.supervisor.beginShutdown();
    this.emit();
    try {
      this.shutdownReceipt = await withTimeout(
        this.options.work.quitAndStopWork(),
        this.options.shutdownTimeoutMs ?? 20_000,
      );
      if (!this.shutdownReceipt.stopped) {
        this.shutdownError = "runtime stop was not confirmed; forced cleanup attempted";
        await withTimeout(
          this.options.supervisor
            .stopOwned(`${reason}_forced`, { force: true })
            .catch(() => undefined),
          5_000,
        );
      }
    } catch (error) {
      this.shutdownError = `${reason}: ${String(error)}`;
      // Last bounded step: force-stop only the runtime Mona owns.
      try {
        await withTimeout(
          this.options.supervisor.stopOwned(`${reason}_timeout`, { force: true }),
          5_000,
        );
      } catch (forceError) {
        this.shutdownError += `; forced stop failed: ${String(forceError)}`;
      }
    }
    this.shutdownComplete = true;
    this.shutdownRunning = false;
    this.emit();
    app.exit(this.shutdownError === null ? 0 : 1);
    return this.status();
  }

  private async handleMainFailure(error: unknown): Promise<void> {
    if (this.crashHandled) return;
    this.crashHandled = true;
    this.shutdownError = `main process failure: ${String(error)}`;
    // The initial target is clean child termination, not daemon survival.
    if (this.options.supervisor.isOwned()) {
      await withTimeout(
        this.options.supervisor.stopOwned("main_failure", { force: true }).catch(() => undefined),
        5_000,
      );
    }
    this.shutdownComplete = true;
    app.exit(1);
  }

  private parseOpenRequest(argv: string[], workingDirectory: string): OpenRequest | null {
    // Electron's argv starts with the app bundle/entry path; that is not a
    // user folder. Take the last remaining existing directory so a launcher
    // can pass flags before the folder.
    const appPath = resolve(app.getAppPath());
    const candidates: string[] = [];
    for (const argument of argv) {
      if (!argument || argument.startsWith("-")) continue;
      const candidate = resolve(workingDirectory, argument);
      if (candidate === appPath) continue;
      try {
        if (statSync(candidate).isDirectory()) candidates.push(candidate);
      } catch {
        // Not a path; ignore launcher flags.
      }
    }
    const chosen = candidates.at(-1);
    if (!chosen) return null;
    return {
      path: chosen,
      receivedAt: new Date().toISOString(),
      source: "second_instance",
    };
  }

  private focusWindow(): void {
    const existing = this.options.currentWindow();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    this.options.openWindow();
  }

  private emit(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch {
      // Status reporting must never break shutdown.
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`operation did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
