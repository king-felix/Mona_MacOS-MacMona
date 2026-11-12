import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_PROFILE,
  PROFILE_SCOPE,
  loadExecutionProfile,
  postureFor,
  profileView,
} from "../src/main/work/profile";
import { openTestStore } from "./helpers/state";

describe("saved execution profile", () => {
  it("writes the measured default once and reports it as configured afterwards", async () => {
    const { store } = await openTestStore();
    const first = await loadExecutionProfile(store);
    expect(first.source).toBe("default");
    expect(first.profile).toEqual(DEFAULT_EXECUTION_PROFILE);
    const stored = await store.getSettings(PROFILE_SCOPE);
    expect(stored?.value).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });

    const second = await loadExecutionProfile(store);
    expect(second.source).toBe("configured");
    expect(second.profile).toEqual(DEFAULT_EXECUTION_PROFILE);
  });

  it("refuses a malformed stored profile instead of silently widening it", async () => {
    const { store } = await openTestStore();
    await store.putSettings(PROFILE_SCOPE, {
      provider: "../etc",
      model: "deepseek-flash",
      permissionPosture: "full_access",
    });
    const loaded = await loadExecutionProfile(store);
    expect(loaded.source).toBe("default");
    expect(loaded.profile.provider).toBe("deepseek");
  });

  it("plan is a narrower posture that cannot escalate to full access", () => {
    const plan = postureFor("plan", DEFAULT_EXECUTION_PROFILE);
    expect(plan).toEqual({
      permissionPosture: "ask",
      autoApprove: false,
      trustMode: false,
      allowShell: false,
    });
    const work = postureFor("work", DEFAULT_EXECUTION_PROFILE);
    expect(work.permissionPosture).toBe("full_access");
    expect(work.autoApprove).toBe(true);
  });

  it("an ask profile never claims auto-approval in work mode", () => {
    const work = postureFor("work", {
      ...DEFAULT_EXECUTION_PROFILE,
      permissionPosture: "ask",
      autoApprove: true,
    });
    expect(work).toEqual({
      permissionPosture: "ask",
      autoApprove: false,
      trustMode: false,
      allowShell: false,
    });
  });

  it("marks the profile as configured until a turn reports what actually ran", () => {
    const view = profileView(DEFAULT_EXECUTION_PROFILE, "configured");
    expect(view.effective).toBeNull();
    expect(view.effectiveTurnId).toBeNull();
    expect(view.source).toBe("configured");
  });
});
