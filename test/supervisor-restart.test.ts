import { describe, expect, it } from "vitest";
import { RestartPolicy } from "../src/main/supervisor/restart";

describe("bounded restart policy", () => {
  it("backs off and stops after the restart budget", () => {
    let now = 0;
    const policy = new RestartPolicy(
      { maxRestarts: 2, baseDelayMs: 1_000, maxDelayMs: 8_000, stableUptimeMs: 60_000 },
      () => now,
    );
    policy.noteStarted();
    now += 500;
    const first = policy.noteExit(false);
    expect(first).toMatchObject({ restart: true, delayMs: 1_000, attempt: 1 });
    now += 500;
    policy.noteStarted();
    now += 500;
    const second = policy.noteExit(false);
    expect(second).toMatchObject({ restart: true, delayMs: 2_000, attempt: 2 });
    policy.noteStarted();
    now += 500;
    const third = policy.noteExit(false);
    expect(third.restart).toBe(false);
    expect(third.reason).toBe("restart_exhausted");
  });

  it("does not restart after a clean exit", () => {
    const policy = new RestartPolicy({}, () => 0);
    policy.noteStarted();
    const decision = policy.noteExit(true);
    expect(decision.restart).toBe(false);
    expect(decision.reason).toBe("unexpected_clean_exit");
  });

  it("resets the count only after a demonstrably stable run", () => {
    let now = 0;
    const policy = new RestartPolicy(
      { maxRestarts: 1, baseDelayMs: 1_000, maxDelayMs: 8_000, stableUptimeMs: 10_000 },
      () => now,
    );
    policy.noteStarted();
    now += 100;
    expect(policy.noteExit(false).restart).toBe(true);
    policy.noteStarted();
    now += 30_000;
    expect(policy.noteExit(false).restart).toBe(true);
    policy.noteStarted();
    now += 50;
    expect(policy.noteExit(false).reason).toBe("restart_exhausted");
  });
});
