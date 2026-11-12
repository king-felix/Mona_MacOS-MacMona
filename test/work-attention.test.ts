import { describe, expect, it } from "vitest";
import { defaultPolishPreferences } from "../src/shared/contracts/polish";
import {
  AttentionController,
  KeepAwake,
  planAttention,
  type AttentionHost,
  type KeepAwakeHost,
} from "../src/main/work/attention";

class FakeAttentionHost implements AttentionHost {
  badges: string[] = [];
  menus: Array<{ title: string; tooltip: string }> = [];
  loginCalls: boolean[] = [];
  login = false;
  isInstalled = true;
  failNote: string | null = null;

  installed(): boolean {
    return this.isInstalled;
  }

  note(): string {
    return this.failNote ?? "fake attention host";
  }

  setBadge(badge: string): void {
    this.badges.push(badge);
  }

  setMenu(title: string, tooltip: string): void {
    this.menus.push({ title, tooltip });
  }

  setLoginItem(openAtLogin: boolean): void {
    this.loginCalls.push(openAtLogin);
    this.login = openAtLogin;
  }

  loginItem(): boolean {
    return this.login;
  }
}

class FakeKeepAwake implements KeepAwakeHost {
  started: number[] = [];
  stopped: number[] = [];
  next = 7;

  start(): number {
    const id = this.next++;
    this.started.push(id);
    return id;
  }

  stop(id: number): void {
    this.stopped.push(id);
  }
}

describe("attention planning", () => {
  it("summarizes running work, blockers, and unseen completions", () => {
    expect(
      planAttention({ running: true, blocked: 0, unseenCompletions: 0, limits: 0 }),
    ).toMatchObject({
      menuTitle: "◐ Working",
      badge: null,
      running: true,
    });
    expect(
      planAttention({ running: true, blocked: 2, unseenCompletions: 0, limits: 0 }),
    ).toMatchObject({
      menuTitle: "◐ Working · 2 blocked",
      badge: "2",
    });
    expect(
      planAttention({ running: false, blocked: 1, unseenCompletions: 2, limits: 1 }),
    ).toMatchObject({
      menuTitle: "◐ 1 blocked",
      badge: "4",
      tooltip: expect.stringContaining("finished since your last visit"),
    });
    expect(
      planAttention({ running: false, blocked: 0, unseenCompletions: 3, limits: 0 }).menuTitle,
    ).toBe("◐ 3 done");
    expect(
      planAttention({ running: false, blocked: 0, unseenCompletions: 0, limits: 0 }).menuTitle,
    ).toBe("◐ Mona");
  });

  it("clears native chrome when the user turns the surface off", () => {
    const host = new FakeAttentionHost();
    const controller = new AttentionController(host);
    const prefs = defaultPolishPreferences("UTC");
    controller.sync({ running: true, blocked: 1, unseenCompletions: 1, limits: 0 }, prefs);
    expect(host.badges.at(-1)).toBe("2");
    expect(host.menus.at(-1)?.title).toContain("Working");

    controller.sync(
      { running: true, blocked: 1, unseenCompletions: 1, limits: 0 },
      { ...prefs, dockBadge: false, menuBarStatus: false },
    );
    expect(host.badges.at(-1)).toBe("");
    expect(host.menus.at(-1)?.title).toBe("");

    controller.sync(
      { running: false, blocked: 1, unseenCompletions: 1, limits: 0 },
      { ...prefs, dockBadge: true, menuBarStatus: true },
    );
    expect(host.badges.at(-1)).toBe("2");
    expect(host.menus.at(-1)?.title).toBe("◐ 1 blocked");
  });

  it("keeps launch at login off until chosen, then applies and reports it", () => {
    const host = new FakeAttentionHost();
    const controller = new AttentionController(host);
    const prefs = defaultPolishPreferences("UTC");
    const initial = controller.sync(
      { running: false, blocked: 0, unseenCompletions: 0, limits: 0 },
      prefs,
    );
    // The system already reports "off", so a default preference makes no call.
    expect(host.loginCalls).toEqual([]);
    expect(initial.launchAtLogin).toMatchObject({ enabled: false, applied: false });
    expect(initial.launchAtLogin.note).toContain("does not enroll itself");

    const enabled = controller.sync(
      { running: false, blocked: 0, unseenCompletions: 0, limits: 0 },
      { ...prefs, launchAtLogin: true },
    );
    expect(host.loginCalls).toEqual([true]);
    expect(enabled.launchAtLogin).toMatchObject({ enabled: true, applied: true });
  });

  it("turns off a login item the system has enabled but the preference does not", () => {
    const host = new FakeAttentionHost();
    host.login = true;
    const controller = new AttentionController(host);
    const status = controller.sync(
      { running: false, blocked: 0, unseenCompletions: 0, limits: 0 },
      defaultPolishPreferences("UTC"),
    );
    expect(host.loginCalls).toEqual([false]);
    expect(status.launchAtLogin).toMatchObject({ enabled: false, applied: false });
  });

  it("reports an unavailable menu-bar item instead of pretending", () => {
    const host = new FakeAttentionHost();
    host.isInstalled = false;
    host.failNote = "menu-bar status unavailable: test";
    const controller = new AttentionController(host);
    const status = controller.sync(
      { running: false, blocked: 0, unseenCompletions: 0, limits: 0 },
      defaultPolishPreferences("UTC"),
    );
    expect(status.view.installed).toBe(false);
    expect(status.view.note).toContain("unavailable");
  });
});

describe("keep awake", () => {
  it("holds one assertion for active work and releases it on every stop path", () => {
    const host = new FakeKeepAwake();
    const keep = new KeepAwake(host);
    expect(keep.sync(false, true).active).toBe(false);
    expect(host.started).toHaveLength(0);

    expect(keep.sync(true, true).active).toBe(true);
    expect(keep.sync(true, true).active).toBe(true);
    expect(host.started).toHaveLength(1);

    expect(keep.sync(false, true).active).toBe(false);
    expect(host.stopped).toEqual([7]);
    expect(keep.status().note).toContain("no active turn");

    // Turning the preference off while work is active releases immediately.
    keep.sync(true, true);
    expect(host.started).toHaveLength(2);
    const off = keep.sync(true, false);
    expect(off.active).toBe(false);
    expect(host.stopped).toEqual([7, 8]);
    expect(off.note).toContain("turned off");

    // Release is idempotent so quit and shutdown cannot double-stop.
    keep.release();
    keep.release();
    expect(host.stopped).toEqual([7, 8]);
  });
});
