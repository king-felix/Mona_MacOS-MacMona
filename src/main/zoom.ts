import type { ZoomView } from "../shared/contracts/bridge";
import { normalizeZoom, stepZoom, zoomView } from "../shared/zoom";
import type { StateStore } from "./state/store";

/**
 * Interface scale, owned by the main process.
 *
 * Electron's page zoom scales the whole renderer uniformly — CSS pixels,
 * images, and native scrollbars included — so one `setZoomFactor` is the honest
 * mechanism. There is no per-component multiplier and no design-token rewrite:
 * a stylesheet that says `236px` becomes 236 scaled pixels.
 *
 * The ladder, its bounds, and the percent formatting live in `src/shared/zoom.ts`
 * because the renderer displays and steps the same values. This module adds the
 * window and the persistence.
 */
export const ZOOM_SCOPE = "app:zoom";

/** A window-like seam so the controller is testable without Electron. */
export interface ZoomTarget {
  webContents: {
    setZoomFactor(factor: number): void;
    getZoomFactor?(): number;
  };
}

/** Only the two settings calls the controller needs. */
export interface ZoomStore {
  getSettings(scope: string): Promise<{ value: unknown; version: number } | null>;
  putSettings(scope: string, value: unknown): Promise<unknown>;
}

export interface ZoomControllerOptions {
  store?: ZoomStore;
  /** Resolved lazily: the window may not exist when the controller is built. */
  window?: () => ZoomTarget | null;
  warn?: (message: string) => void;
}

export class ZoomController {
  private current = 1;
  private readonly store?: ZoomStore;
  private readonly resolveWindow?: () => ZoomTarget | null;
  private readonly warn: (message: string) => void;

  constructor(options: ZoomControllerOptions = {}) {
    this.store = options.store;
    this.resolveWindow = options.window;
    this.warn = options.warn ?? (() => undefined);
  }

  get factor(): number {
    return this.current;
  }

  view(): ZoomView {
    return zoomView(this.current);
  }

  /**
   * Read the stored scale. A failed read is not a reason to refuse to start:
   * the controller falls back to 100% and says so.
   */
  async load(): Promise<number> {
    if (!this.store) return this.current;
    try {
      const stored = await this.store.getSettings(ZOOM_SCOPE);
      const value = stored?.value as { factor?: unknown } | undefined;
      this.current = normalizeZoom(value?.factor);
    } catch (error) {
      this.warn(`saved interface scale was unreadable: ${errorMessage(error)}`);
      this.current = 1;
    }
    return this.current;
  }

  /** Push the current factor onto the live window. Never throws. */
  apply(target?: ZoomTarget | null): number {
    const window = target ?? this.resolveWindow?.() ?? null;
    if (!window) return this.current;
    try {
      window.webContents.setZoomFactor(this.current);
    } catch (error) {
      this.warn(`interface scale could not be applied: ${errorMessage(error)}`);
    }
    return this.current;
  }

  /** Set a scale, apply it, and persist it. Returns the applied view. */
  async set(factor: unknown, target?: ZoomTarget | null): Promise<ZoomView> {
    this.current = normalizeZoom(factor);
    this.apply(target);
    await this.persist();
    return this.view();
  }

  async step(direction: "in" | "out", target?: ZoomTarget | null): Promise<ZoomView> {
    return this.set(stepZoom(this.current, direction), target);
  }

  async reset(target?: ZoomTarget | null): Promise<ZoomView> {
    return this.set(1, target);
  }

  /**
   * Chromium also remembers a per-origin zoom in the profile. Storing the value
   * in Mona's own settings makes it inspectable and restorable, and keeps it
   * correct if the Chromium profile is ever reset.
   */
  private async persist(): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.putSettings(ZOOM_SCOPE, { factor: this.current });
    } catch (error) {
      this.warn(`interface scale could not be saved: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrow a StateStore to the seam this module needs. */
export function zoomStore(store: StateStore): ZoomStore {
  return store as unknown as ZoomStore;
}
