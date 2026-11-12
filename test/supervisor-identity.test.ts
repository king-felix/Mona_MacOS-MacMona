import { describe, expect, it } from "vitest";
import {
  descendantsOf,
  isSameProcess,
  isZombie,
  parseProcessTable,
} from "../src/main/supervisor/identity";
import { classifyOwnership, type OwnershipRecord } from "../src/main/supervisor/records";

describe("process table parsing", () => {
  it("parses padded BSD start times without losing the identity", () => {
    const raw = [
      "    1     0     1 Ss   Mon Nov  2 15:24:27 2026    ",
      "  211     1   211 S    Fri Nov  6 20:17:54 2026    ",
      " 5000   211  5000 S+   Wed Nov 11 18:32:59 2026    ",
      " 5001   211  5001 Z    Wed Nov 11 18:33:01 2026    ",
    ].join("\n");
    const table = parseProcessTable(raw);
    expect(table.size).toBe(4);
    expect(table.get(211)).toEqual({
      pid: 211,
      ppid: 1,
      pgid: 211,
      state: "S",
      startedAt: "Fri Nov 6 20:17:54 2026",
    });
    expect(isZombie(table.get(5001)!)).toBe(true);
  });

  it("ignores malformed rows instead of inventing processes", () => {
    const table = parseProcessTable("garbage\n\n  nope\n");
    expect(table.size).toBe(0);
  });
});

describe("process identity", () => {
  const entry = {
    pid: 42,
    ppid: 1,
    pgid: 42,
    state: "S",
    startedAt: "Wed Nov 11 18:32:59 2026",
  };

  it("matches only the same pid with the same start time", () => {
    expect(isSameProcess({ pid: 42, startedAt: entry.startedAt }, entry)).toBe(true);
    expect(isSameProcess({ pid: 42, startedAt: "Wed Nov 11 18:33:59 2026" }, entry)).toBe(false);
    expect(isSameProcess({ pid: 42, startedAt: entry.startedAt }, null)).toBe(false);
    expect(isSameProcess({ pid: 42, startedAt: entry.startedAt }, { ...entry, state: "Z" })).toBe(
      false,
    );
  });

  it("walks grandchildren and stops at the tree boundary", () => {
    const table = parseProcessTable(
      [
        "  100     1   100 S Wed Nov 11 18:00:00 2026",
        "  101   100   100 S Wed Nov 11 18:00:01 2026",
        "  102   101   100 S Wed Nov 11 18:00:02 2026",
        "  200     1   200 S Wed Nov 11 17:00:00 2026",
        "  201   200   200 S Wed Nov 11 17:00:01 2026",
        "  103   100   100 Z Wed Nov 11 18:00:03 2026",
      ].join("\n"),
    );
    const tree = [...descendantsOf(100, table)].sort();
    expect(tree).toEqual([101, 102]);
    expect(tree).not.toContain(200);
  });
});

describe("ownership verdicts", () => {
  const base: OwnershipRecord = {
    id: "rt_test",
    workspace: "/tmp/ws",
    canonicalWorkspace: "/private/tmp/ws",
    executable: "/opt/homebrew/bin/codewhale",
    executableSha256: "a".repeat(64),
    supervisorPid: 900,
    supervisorStartedAt: "Wed Nov 11 18:00:00 2026",
    childPid: 901,
    childStartedAt: "Wed Nov 11 18:00:01 2026",
    pgid: 901,
    port: 7000,
    baseUrl: "http://127.0.0.1:7000",
    controlSocket: "/tmp/run/rt_test.sock",
    startedAt: "2026-11-11T18:00:00.000Z",
    updatedAt: "2026-11-11T18:00:00.000Z",
    state: "running",
    engine: { version: "0.10.2", commit: "ff466b2ed0bf" },
    startupReceipt: null,
    stopReceipt: null,
  };

  it("treats a matching pid and start time as the owned process", () => {
    const verdict = classifyOwnership(base, {
      readEntry: (pid) =>
        pid === 900 || pid === 901
          ? {
              pid,
              ppid: pid === 901 ? 900 : 1,
              pgid: 901,
              state: "S",
              startedAt: pid === 900 ? base.supervisorStartedAt : base.childStartedAt,
            }
          : null,
      readExecutable: () => base.executable,
    });
    expect(verdict.verdict).toBe("live_owned");
    expect(verdict.childAlive).toBe(true);
  });

  it("refuses a reused pid as a stranger, even when it is alive", () => {
    const verdict = classifyOwnership(base, {
      readEntry: (pid) =>
        pid === 901
          ? { pid, ppid: 1, pgid: 901, state: "S", startedAt: "Thu Nov 12 09:00:00 2026" }
          : null,
      readExecutable: () => "/usr/bin/stranger",
    });
    expect(verdict.verdict).toBe("pid_reused");
    expect(verdict.note).toContain("refusing to signal");
  });

  it("refuses a matching pid that now runs a different executable", () => {
    const verdict = classifyOwnership(base, {
      readEntry: (pid) => ({
        pid,
        ppid: pid === 901 ? 900 : 1,
        pgid: 901,
        state: "S",
        startedAt: pid === 901 ? base.childStartedAt : base.supervisorStartedAt,
      }),
      readExecutable: (pid) => (pid === 901 ? "/usr/bin/sleep" : base.executable),
    });
    expect(verdict.verdict).toBe("foreign_executable");
  });

  it("reports an orphaned child when only the supervisor is gone", () => {
    const verdict = classifyOwnership(base, {
      readEntry: (pid) =>
        pid === 901
          ? { pid, ppid: 1, pgid: 901, state: "S", startedAt: base.childStartedAt }
          : null,
      readExecutable: () => base.executable,
    });
    expect(verdict.verdict).toBe("orphaned_owned");
    expect(verdict.supervisorAlive).toBe(false);
  });

  it("reports stopped when neither identity is alive", () => {
    const verdict = classifyOwnership(base, {
      readEntry: () => null,
      readExecutable: () => null,
    });
    expect(verdict.verdict).toBe("stopped");
  });
});
