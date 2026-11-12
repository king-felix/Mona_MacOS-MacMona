import type { AttentionView, PolishPreferences } from "../../shared/contracts/polish";

/** The minimal inputs that can make Mona ask for attention. */
export interface AttentionInput {
  running: boolean;
  blocked: number;
  unseenCompletions: number;
  limits: number;
}

export interface AttentionPlan {
  badge: string | null;
  menuTitle: string;
  tooltip: string;
  running: boolean;
  blocked: number;
  unseenCompletions: number;
}

/**
 * Menu-bar and Dock state, derived locally. The title is short because it sits
 * beside the system clock; the tooltip carries the explanation. A badge count
 * is never a percentage and never implies a completed task without records.
 */
export function planAttention(input: AttentionInput): AttentionPlan {
  const attention = input.blocked + input.unseenCompletions + input.limits;
  const badge = attention > 0 ? String(Math.min(attention, 99)) : null;
  const menuTitle = input.running
    ? input.blocked > 0
      ? `◐ Working · ${input.blocked} blocked`
      : "◐ Working"
    : input.blocked > 0
      ? `◐ ${input.blocked} blocked`
      : input.unseenCompletions > 0
        ? `◐ ${input.unseenCompletions} done`
        : "◐ Mona";
  const tooltip = [
    "Mona",
    input.running ? "work in progress" : "idle",
    input.blocked > 0 ? `${input.blocked} blocked` : null,
    input.unseenCompletions > 0
      ? `${input.unseenCompletions} finished since your last visit`
      : null,
    input.limits > 0 ? `${input.limits} cost limit alert${input.limits === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    badge,
    menuTitle,
    tooltip,
    running: input.running,
    blocked: input.blocked,
    unseenCompletions: input.unseenCompletions,
  };
}

export interface AttentionHost {
  installed(): boolean;
  note(): string;
  setBadge(badge: string): void;
  setMenu(title: string, tooltip: string): void;
  setLoginItem(openAtLogin: boolean): void;
  loginItem(): boolean;
}

export interface AttentionSyncInput extends AttentionInput {
  /** The runtime is alive and owned by this app, whether or not a turn runs. */
  runtimeActive?: boolean;
}

export interface AttentionStatus {
  view: AttentionView;
  launchAtLogin: { enabled: boolean; applied: boolean; note: string };
  changed: boolean;
}

/**
 * Keeps native chrome honest: Dock badge and menu-bar title follow stored
 * state, and are cleared when the user turns the surface off. The controller
 * does not decide who has attention; it only reflects the plan.
 */
export class AttentionController {
  private lastBadge: string | null = null;
  private lastMenuTitle: string | null = null;
  private lastTooltip: string | null = null;
  private loginApplied: boolean | null = null;

  constructor(private readonly host: AttentionHost) {
    // Read the real login-item state first: a default of "off" must not call
    // the system when it is already off, and an externally enabled item is
    // turned off because the preference says so.
    this.loginApplied = host.loginItem();
  }

  sync(input: AttentionSyncInput, preferences: PolishPreferences): AttentionStatus {
    const plan = planAttention(input);
    let changed = false;
    const badge = preferences.dockBadge ? (plan.badge ?? "") : "";
    if (this.lastBadge !== badge) {
      this.host.setBadge(badge);
      this.lastBadge = badge;
      changed = true;
    }
    const menuTitle = preferences.menuBarStatus ? plan.menuTitle : "";
    const tooltip = preferences.menuBarStatus ? plan.tooltip : "Mona menu-bar status is turned off";
    if (this.lastMenuTitle !== menuTitle || this.lastTooltip !== tooltip) {
      this.host.setMenu(menuTitle, tooltip);
      this.lastMenuTitle = menuTitle;
      this.lastTooltip = tooltip;
      changed = true;
    }
    if (this.loginApplied !== preferences.launchAtLogin) {
      this.host.setLoginItem(preferences.launchAtLogin);
      this.loginApplied = preferences.launchAtLogin;
      changed = true;
    }
    const applied = this.host.loginItem();
    return {
      view: {
        ...plan,
        installed: this.host.installed(),
        updatedAt: new Date().toISOString(),
        note: this.host.note(),
      },
      launchAtLogin: {
        enabled: preferences.launchAtLogin,
        applied,
        note: preferences.launchAtLogin
          ? applied
            ? "Mona is registered to open at login because you asked for it."
            : "The login-item change was requested but the system did not confirm it."
          : "Launch at login is off. Mona does not enroll itself.",
      },
      changed,
    };
  }

  /** Clear attention chrome without pretending work finished. */
  clear(preferences: PolishPreferences): void {
    this.lastBadge = null;
    this.lastMenuTitle = null;
    this.lastTooltip = null;
    this.host.setBadge("");
    this.host.setMenu(
      preferences.menuBarStatus ? "◐ Mona" : "",
      preferences.menuBarStatus ? "Mona · idle" : "Mona menu-bar status is turned off",
    );
  }
}

export interface KeepAwakeHost {
  start(): number;
  stop(id: number): void;
}

/**
 * Power assertions are scoped to real, active work: an active engine turn or a
 * running task. Turning the preference off or finishing the work releases the
 * assertion immediately, and release is idempotent so shutdown cannot leak it.
 */
export class KeepAwake {
  private id: number | null = null;
  private lastReason = "idle";

  constructor(private readonly host: KeepAwakeHost) {}

  sync(active: boolean, enabled: boolean): { active: boolean; note: string } {
    if (active && enabled && this.id === null) {
      this.id = this.host.start();
      this.lastReason = "work is active and keep-awake is enabled";
    } else if ((!active || !enabled) && this.id !== null) {
      this.release();
      this.lastReason = !enabled ? "keep-awake is turned off" : "no active turn or task remains";
    } else if (!active || !enabled) {
      this.lastReason = !enabled ? "keep-awake is turned off" : "no active work";
    }
    return { active: this.id !== null, note: this.lastReason };
  }

  release(): void {
    if (this.id === null) return;
    const id = this.id;
    this.id = null;
    this.host.stop(id);
  }

  status(): { active: boolean; note: string } {
    return { active: this.id !== null, note: this.lastReason };
  }
}
