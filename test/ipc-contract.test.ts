import { describe, expect, it } from "vitest";
import { IpcContractError, validateIpc } from "../src/main/ipc-contract";

describe("IPC validation", () => {
  it("accepts an empty strict payload for app:info", () => {
    expect(validateIpc("app:info", {})).toEqual({});
  });

  it("rejects an unknown channel", () => {
    expect(() => validateIpc("shell:run", {})).toThrow(IpcContractError);
    try {
      validateIpc("shell:run", {});
    } catch (error) {
      expect((error as IpcContractError).code).toBe("UNKNOWN_CHANNEL");
    }
  });

  it("rejects unknown fields", () => {
    expect(() => validateIpc("app:info", { exec: "rm -rf /" })).toThrow(/malformed/i);
  });

  it("rejects a non-object payload", () => {
    expect(() => validateIpc("app:info", "hello")).toThrow();
    expect(() => validateIpc("app:paths", null)).toThrow();
  });

  it("validates tool names and caps the list", () => {
    expect(validateIpc("tools:discover", { names: ["codewhale", "git"] })).toEqual({
      names: ["codewhale", "git"],
    });
    expect(() => validateIpc("tools:discover", { names: ["../evil"] })).toThrow();
    expect(() => validateIpc("tools:discover", { names: ["a".repeat(65)] })).toThrow();
    expect(() =>
      validateIpc("tools:discover", { names: Array.from({ length: 17 }, (_, i) => `t${i}`) }),
    ).toThrow();
  });
});

describe("project IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts catalog reads and rejects unknown fields", () => {
    expect(validateIpc("projects:list", { query: "mona", includeArchived: true })).toEqual({
      query: "mona",
      includeArchived: true,
    });
    expect(() => validateIpc("projects:list", { path: "/tmp" })).toThrow();
    expect(validateIpc("projects:detail", { projectId })).toEqual({ projectId });
    expect(() => validateIpc("projects:detail", { projectId: "thr_0123456789abcdef" })).toThrow();
  });

  it("validates mutations with revisions and rejects destructive channels", () => {
    expect(
      validateIpc("projects:rename", { projectId, name: "New label", expectedRevision: 2 }),
    ).toEqual({ projectId, name: "New label", expectedRevision: 2 });
    expect(() =>
      validateIpc("projects:rename", { projectId, name: "New label", expectedRevision: 0 }),
    ).toThrow();
    expect(() =>
      validateIpc("projects:rename", { projectId, name: "", expectedRevision: 1 }),
    ).toThrow();
    expect(
      validateIpc("projects:pin", { projectId, pinned: true, expectedRevision: 1 }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("projects:archive", { projectId, archived: "yes", expectedRevision: 1 }),
    ).toThrow();
    expect(validateIpc("projects:remove", { projectId, expectedRevision: 3 })).toBeTruthy();
    expect(validateIpc("projects:relocate", { projectId, expectedRevision: 3 })).toBeTruthy();
    expect(validateIpc("projects:reveal", { projectId })).toBeTruthy();
    expect(() => validateIpc("projects:delete-folder", { projectId })).toThrow(IpcContractError);
    expect(() =>
      validateIpc("projects:remove", { projectId, expectedRevision: 3, deleteFiles: true }),
    ).toThrow();
  });

  it("validates view state and drafts", () => {
    expect(validateIpc("projects:view", { projectId, view: { screen: "cost" } })).toEqual({
      projectId,
      view: { screen: "cost" },
    });
    expect(
      validateIpc("projects:draft", { projectId, threadId: "thr_0123456789abcdef", text: "" }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("projects:draft", {
        projectId,
        threadId: "thr_0123456789abcdef",
        text: "x".repeat(200_001),
      }),
    ).toThrow();
    expect(validateIpc("runtime:status", {})).toEqual({});
    expect(validateIpc("state:facts", {})).toEqual({});
  });
});

describe("studio IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts explicit studio actions and rejects smuggling", () => {
    expect(validateIpc("studio:state", { projectId })).toEqual({ projectId });
    expect(validateIpc("studio:start", { projectId })).toEqual({ projectId });
    expect(
      validateIpc("studio:submit", { projectId, prompt: "Do one thing", mode: "plan" }),
    ).toEqual({ projectId, prompt: "Do one thing", mode: "plan" });
    expect(() => validateIpc("studio:submit", { projectId, prompt: "x", mode: "root" })).toThrow();
    expect(() => validateIpc("studio:submit", { projectId, prompt: "", mode: "work" })).toThrow();
    expect(() =>
      validateIpc("studio:submit", { projectId, prompt: "x", mode: "work", autoApprove: true }),
    ).toThrow();
    expect(() =>
      validateIpc("studio:submit", { projectId, prompt: "x".repeat(100_001), mode: "work" }),
    ).toThrow();
    for (const channel of [
      "studio:interrupt",
      "studio:pause",
      "studio:resume-queue",
      "studio:cancel-queued",
      "studio:reconcile",
      "studio:stop",
    ]) {
      expect(validateIpc(channel, { projectId })).toEqual({ projectId });
    }
    expect(() => validateIpc("studio:interrupt", { projectId, turnId: "turn_1" })).toThrow();
    expect(() => validateIpc("studio:start", { projectId: "thr_0123456789abcdef" })).toThrow();
  });
});

describe("open path IPC validation", () => {
  it("accepts a dropped folder path with the enumerated source", () => {
    expect(validateIpc("open:folder", { path: "/Users/example/project", source: "drop" })).toEqual({
      path: "/Users/example/project",
      source: "drop",
    });
  });

  it("rejects an invented source, an empty path, and an oversized path", () => {
    expect(() => validateIpc("open:folder", { path: "/tmp/x", source: "service" })).toThrow(
      /malformed/i,
    );
    expect(() => validateIpc("open:folder", { path: "", source: "drop" })).toThrow(/malformed/i);
    expect(() =>
      validateIpc("open:folder", { path: `/${"a".repeat(9000)}`, source: "drop" }),
    ).toThrow(/malformed/i);
  });

  it("accepts empty strict payloads for the read-only status channels", () => {
    expect(validateIpc("open:status", {})).toEqual({});
    expect(validateIpc("service:status", {})).toEqual({});
    expect(validateIpc("service:refresh", {})).toEqual({});
    expect(validateIpc("service:open-settings", {})).toEqual({});
    expect(() => validateIpc("service:refresh", { path: "/tmp/evil" })).toThrow(/malformed/i);
  });
});

describe("work board IPC validation", () => {
  const projectId = "prj_0123456789abcdef";
  const taskId = "tsk_0123456789abcdef";

  it("accepts a bounded task with criteria, owner, and dependencies", () => {
    expect(
      validateIpc("board:create", {
        projectId,
        title: "Write the schema",
        prompt: "Create the table",
        owner: "mona_queue",
        requirements: ["MONA-009"],
        acceptance: [
          { text: "migration applies", kind: "check" },
          { text: "Victor accepts names", kind: "human" },
        ],
        steps: ["draft", "apply"],
        dependsOn: [taskId],
      }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("board:create", { projectId, title: "x", prompt: "y", autoStart: true }),
    ).toThrow(/malformed/i);
    expect(() =>
      validateIpc("board:create", { projectId, title: "x", prompt: "y", owner: "codewhale" }),
    ).toThrow(/malformed/i);
    expect(() =>
      validateIpc("board:create", { projectId, title: "x", prompt: "y", requirements: ["NOPE-1"] }),
    ).toThrow(/malformed/i);
  });

  it("keeps verification sources explicit and completion revision-checked", () => {
    expect(
      validateIpc("board:satisfy", {
        taskId,
        criterionId: "acp_0123456789abcdef",
        expectedRevision: 2,
        by: "human",
        evidencePath: "docs/evidence/proof.md",
      }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("board:satisfy", {
        taskId,
        criterionId: "acp_0123456789abcdef",
        expectedRevision: 2,
        by: "model",
      }),
    ).toThrow(/malformed/i);
    expect(() => validateIpc("board:complete", { taskId, expectedRevision: 0 })).toThrow(
      /malformed/i,
    );
    expect(() => validateIpc("board:complete", { taskId })).toThrow(/malformed/i);
  });

  it("accepts only a project id for dispatch and accepts an inert plan object", () => {
    expect(validateIpc("board:dispatch-next", { projectId })).toEqual({ projectId });
    expect(() => validateIpc("board:dispatch-next", { projectId, prompt: "do more" })).toThrow();
    const plan = {
      format: "mona-task-plan",
      format_version: 1,
      name: "Plan",
      tasks: [{ key: "a", title: "A", prompt: "do a" }],
    };
    expect(validateIpc("board:import", { projectId, plan })).toEqual({ projectId, plan });
  });
});

describe("cost ledger IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts a bounded ledger read and rejects loose payloads", () => {
    expect(validateIpc("cost:ledger", { projectId })).toEqual({ projectId });
    expect(
      validateIpc("cost:ledger", { projectId, since: "2026-11-01T00:00:00.000Z" }),
    ).toBeTruthy();
    expect(() => validateIpc("cost:ledger", { projectId, since: "yesterday" })).toThrow();
    expect(() => validateIpc("cost:ledger", { projectId, timeZone: "x".repeat(65) })).toThrow();
    expect(() => validateIpc("cost:ledger", { projectId, balance: true })).toThrow();
  });

  it("validates budgets as positive, scoped, optional limits", () => {
    expect(validateIpc("cost:budget-set", { projectId, scope: "day", limitUsd: 2.5 })).toBeTruthy();
    expect(() =>
      validateIpc("cost:budget-set", { projectId, scope: "week", limitUsd: 2.5 }),
    ).toThrow();
    expect(() =>
      validateIpc("cost:budget-set", { projectId, scope: "project", limitUsd: 0 }),
    ).toThrow();
    expect(() =>
      validateIpc("cost:budget-set", { projectId, scope: "project", limitUsd: 1, unlimited: true }),
    ).toThrow();
    expect(
      validateIpc("cost:budget-clear", { projectId, budgetId: "bdg_1", expectedRevision: 2 }),
    ).toBeTruthy();
  });

  it("validates rate cards as explicit per-million numbers", () => {
    expect(
      validateIpc("cost:rate-set", {
        provider: "deepseek",
        model: "deepseek-flash",
        cacheHitPerMillion: 0.28,
        cacheMissPerMillion: 2.8,
        outputPerMillion: 0.42,
      }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("cost:rate-set", {
        provider: "deepseek",
        model: "deepseek-flash",
        cacheHitPerMillion: 0.28,
        cacheMissPerMillion: 2.8,
      }),
    ).toThrow();
    expect(() =>
      validateIpc("cost:rate-set", {
        provider: "deepseek",
        model: "deepseek-flash",
        cacheHitPerMillion: -1,
        cacheMissPerMillion: 2.8,
        outputPerMillion: 0.42,
      }),
    ).toThrow();
    expect(() =>
      validateIpc("cost:recalc-preview", {
        projectId,
        provider: "deepseek",
        model: "deepseek-flash",
        cacheHitPerMillion: 0.28,
        cacheMissPerMillion: 2.8,
        outputPerMillion: 0.42,
        write: true,
      }),
    ).toThrow();
  });

  it("exports only through a named format", () => {
    expect(validateIpc("cost:export-file", { projectId, format: "csv" })).toBeTruthy();
    expect(() => validateIpc("cost:export-file", { projectId, format: "xlsx" })).toThrow();
    expect(() => validateIpc("cost:export-file", { projectId })).toThrow();
  });
});

describe("polish IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts local reads and rejects unknown fields", () => {
    expect(validateIpc("polish:digest", { projectId })).toEqual({ projectId });
    expect(validateIpc("polish:mark-seen", { projectId })).toEqual({ projectId });
    expect(validateIpc("polish:refresh", { projectId })).toEqual({ projectId });
    expect(validateIpc("polish:status", {})).toEqual({});
    expect(() => validateIpc("polish:digest", { projectId, prompt: "summarize" })).toThrow();
  });

  it("validates preference patches strictly", () => {
    expect(validateIpc("polish:preferences-set", { patch: { dockBadge: false } })).toEqual({
      patch: { dockBadge: false },
    });
    // A partial notification patch is legal; the store merges it with the
    // current value rather than resetting quiet hours or category toggles.
    expect(
      validateIpc("polish:preferences-set", { patch: { notifications: { enabled: true } } }),
    ).toEqual({ patch: { notifications: { enabled: true } } });
    expect(() =>
      validateIpc("polish:preferences-set", {
        patch: {
          notifications: {
            enabled: true,
            completion: true,
            blocker: true,
            limit: true,
            showDetails: false,
            quietHours: { enabled: true, start: "25:00", end: "07:00", timeZone: "UTC" },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      validateIpc("polish:preferences-set", { patch: { launchAtLogin: "yes" } }),
    ).toThrow();
    expect(() =>
      validateIpc("polish:preferences-set", { patch: { installHelper: true } }),
    ).toThrow();
  });

  it("validates project identity without accepting arbitrary markup", () => {
    expect(
      validateIpc("polish:identity", {
        projectId,
        accent: "coral",
        monogram: "AB",
        expectedRevision: 2,
      }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("polish:identity", {
        projectId,
        accent: "neon",
        monogram: "AB",
        expectedRevision: 2,
      }),
    ).toThrow();
    expect(() =>
      validateIpc("polish:identity", {
        projectId,
        accent: null,
        monogram: "ABCDE",
        expectedRevision: 2,
      }),
    ).toThrow();
    expect(() =>
      validateIpc("polish:identity", { projectId, accent: null, monogram: null }),
    ).toThrow();
  });

  it("keeps favorites inert and quit explicit", () => {
    expect(
      validateIpc("polish:favorite-save", { label: "Review", text: "Review the diff." }),
    ).toEqual({ label: "Review", text: "Review the diff." });
    expect(() =>
      validateIpc("polish:favorite-save", { label: "Run", text: "do it", execute: true }),
    ).toThrow();
    expect(validateIpc("polish:favorite-remove", { id: "fav_00000001" })).toEqual({
      id: "fav_00000001",
    });
    expect(validateIpc("polish:quit", { interrupt: true })).toEqual({ interrupt: true });
    expect(() => validateIpc("polish:quit", {})).toThrow();
  });
});

describe("P15 orchestration IPC validation", () => {
  const projectId = "prj_0123456789abcdef";
  const taskId = "tsk_0123456789abcdef";
  const threadId = "thr_0123456789abcdef";

  it("accepts read-only observatory calls and rejects unknown fields", () => {
    expect(validateIpc("agents:observatory", { projectId })).toEqual({ projectId });
    expect(validateIpc("agents:history", { projectId, limit: 20 })).toEqual({
      projectId,
      limit: 20,
    });
    expect(() => validateIpc("agents:observatory", { projectId, raw: true })).toThrow();
  });

  it("validates run and worker controls", () => {
    expect(validateIpc("agents:run-cancel", { projectId, runId: "agent_1" })).toBeTruthy();
    expect(() => validateIpc("agents:run-cancel", { projectId, runId: "" })).toThrow();
    expect(
      validateIpc("agents:worker-control", {
        projectId,
        workerId: "fleet-1-local-1",
        action: "restart",
      }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("agents:worker-control", {
        projectId,
        workerId: "fleet-1-local-1",
        action: "delete",
      }),
    ).toThrow();
    expect(
      validateIpc("agents:fleet-control", { projectId, runId: "fleet-1", action: "stop" }),
    ).toBeTruthy();
  });

  it("validates goal controls against a bounded engine thread id", () => {
    expect(
      validateIpc("agents:goal-set", { projectId, threadId, objective: "Ship it" }),
    ).toBeTruthy();
    expect(() =>
      validateIpc("agents:goal-set", { projectId, threadId, objective: "   " }),
    ).toThrow();
    expect(() =>
      validateIpc("agents:goal-set", { projectId, threadId: "not-a-thread", objective: "x" }),
    ).toThrow();
    expect(validateIpc("agents:goal-block", { projectId, threadId, reason: null })).toBeTruthy();
  });

  it("accepts only a serial fleet launch for a named native role", () => {
    const input = {
      projectId,
      taskId,
      name: "Native task",
      role: "reviewer",
      instructions: "Review it.",
      parallelism: "serial",
    };
    expect(validateIpc("agents:launch-fleet", input)).toMatchObject({ parallelism: "serial" });
    expect(() =>
      validateIpc("agents:launch-fleet", { ...input, parallelism: "parallel" }),
    ).toThrow();
    expect(() => validateIpc("agents:launch-fleet", { ...input, role: "root" })).toThrow();
    expect(() => validateIpc("agents:launch-fleet", { ...input, taskId: "task_1" })).toThrow();
  });
});

describe("terminal IPC validation", () => {
  const sessionId = "term_0123456789abcdef";
  const projectId = "prj_0123456789abcdef";

  it("accepts a bounded create and rejects a project-shaped id that is not one", () => {
    expect(validateIpc("terminal:create", {})).toBeTruthy();
    expect(validateIpc("terminal:create", { projectId, cols: 120, rows: 40 })).toBeTruthy();
    expect(() => validateIpc("terminal:create", { cols: 1 })).toThrow();
    expect(() => validateIpc("terminal:create", { rows: 10_000 })).toThrow();
    expect(() => validateIpc("terminal:create", { shell: "/bin/bash" })).toThrow();
  });

  it("bounds terminal input and requires a session-shaped id", () => {
    expect(validateIpc("terminal:write", { sessionId, data: "ls\n" })).toBeTruthy();
    expect(() => validateIpc("terminal:write", { sessionId, data: "x".repeat(8_193) })).toThrow();
    expect(() => validateIpc("terminal:write", { sessionId: "term_zz", data: "x" })).toThrow();
    expect(() =>
      validateIpc("terminal:write", { sessionId, data: "x", encoding: "utf-32" }),
    ).toThrow();
    expect(() => validateIpc("terminal:write", { sessionId, data: "x", exec: true })).toThrow();
  });

  it("bounds resize to the same window range as the helper", () => {
    expect(validateIpc("terminal:resize", { sessionId, cols: 80, rows: 24 })).toBeTruthy();
    expect(() => validateIpc("terminal:resize", { sessionId, cols: 0, rows: 24 })).toThrow();
    expect(() => validateIpc("terminal:resize", { sessionId, cols: 80, rows: 1_000 })).toThrow();
  });

  it("accepts a replay cursor and a bounded log tail", () => {
    expect(validateIpc("terminal:output", { sessionId, cursor: 0 })).toBeTruthy();
    expect(() => validateIpc("terminal:output", { sessionId, cursor: -1 })).toThrow();
    expect(() => validateIpc("terminal:output", { sessionId, maxBytes: 0 })).toThrow();
    expect(validateIpc("terminal:log", { projectId })).toBeTruthy();
    expect(() => validateIpc("terminal:log", { projectId, path: "/etc/passwd" })).toThrow();
  });

  it("keeps search and close narrow", () => {
    expect(validateIpc("terminal:search", { sessionId, query: "error" })).toBeTruthy();
    expect(() => validateIpc("terminal:search", { sessionId, query: "" })).toThrow();
    expect(validateIpc("terminal:close", { sessionId })).toBeTruthy();
    expect(() => validateIpc("terminal:close", { sessionId, force: true })).toThrow();
  });
});

describe("capability IPC validation", () => {
  it("accepts only empty payloads", () => {
    expect(validateIpc("capability:snapshot", {})).toEqual({});
    expect(validateIpc("capability:refresh", {})).toEqual({});
    expect(validateIpc("capability:report", {})).toEqual({});
    expect(() => validateIpc("capability:snapshot", { probe: true })).toThrow();
  });
});

describe("R03 command catalog IPC validation", () => {
  it("accepts only an empty request", () => {
    expect(validateIpc("commands:catalog", {})).toEqual({});
    expect(() => validateIpc("commands:catalog", { query: "help" })).toThrow();
  });
});

describe("R04 command execution IPC validation", () => {
  const base = {
    projectId: "prj_0123456789abcdef",
    mode: "work",
    spelling: "new",
    arguments: "",
    operationKey: "cmd-0123456789",
  } as const;

  it("accepts one typed command request", () => {
    expect(validateIpc("commands:execute", base)).toEqual(base);
    expect(
      validateIpc("commands:execute", { ...base, confirm: true, resolveBusy: "interrupt" }),
    ).toMatchObject({ confirm: true, resolveBusy: "interrupt" });
  });

  it("rejects a slash, a shell word, or a free-form command", () => {
    for (const spelling of [
      "/new",
      "new; rm -rf /",
      "new arg",
      "",
      "$(id)",
      "new\nrm",
      "new|cat",
      "../../etc/passwd",
    ]) {
      expect(() => validateIpc("commands:execute", { ...base, spelling })).toThrow();
    }
  });

  it("accepts the engine's own non-ASCII and punctuation aliases", () => {
    // The pinned catalog really answers to these; a rule that rejected them
    // would make a catalogued command undispatchesable.
    for (const spelling of ["语音", "语音控制", "语音发送", "帮助", "接力", "?"]) {
      expect(validateIpc("commands:execute", { ...base, spelling })).toMatchObject({ spelling });
    }
  });

  it("rejects an unbounded argument, a bad operation key and unknown fields", () => {
    expect(() =>
      validateIpc("commands:execute", { ...base, arguments: "x".repeat(4097) }),
    ).toThrow();
    expect(() => validateIpc("commands:execute", { ...base, operationKey: "bad key!" })).toThrow();
    expect(() => validateIpc("commands:execute", { ...base, prompt: "hello" })).toThrow();
    expect(() => validateIpc("commands:execute", { ...base, resolveBusy: "force" })).toThrow();
  });
});

describe("history IPC validation", () => {
  const projectId = "prj_0123456789abcdef";

  it("accepts a keyset page request and rejects malformed cursors", () => {
    expect(validateIpc("projects:history", { projectId })).toEqual({ projectId });
    expect(
      validateIpc("projects:history", {
        projectId,
        before: { recordedAt: "2026-11-11T00:00:00.000Z", rowId: 42 },
        limit: 500,
        threadId: "thr_0123456789abcdef",
      }),
    ).toEqual({
      projectId,
      before: { recordedAt: "2026-11-11T00:00:00.000Z", rowId: 42 },
      limit: 500,
      threadId: "thr_0123456789abcdef",
    });
    expect(() =>
      validateIpc("projects:history", { projectId, before: { recordedAt: "x", rowId: -1 } }),
    ).toThrow();
    expect(() => validateIpc("projects:history", { projectId, limit: 501 })).toThrow();
    expect(() => validateIpc("projects:history", { projectId, threadId: "" })).toThrow();
    expect(() =>
      validateIpc("projects:history", {
        projectId,
        before: { recordedAt: "x", rowId: 1 },
        extra: 1,
      }),
    ).toThrow();
  });

  it("accepts an item read and requires both identities", () => {
    expect(
      validateIpc("projects:history-item", {
        projectId,
        threadId: "thr_0123456789abcdef",
        itemId: "item_0123456789abcdef",
      }),
    ).toBeTruthy();
    expect(() => validateIpc("projects:history-item", { projectId, threadId: "thr_x" })).toThrow();
    expect(() =>
      validateIpc("projects:history-item", { projectId, threadId: "thr_x", itemId: "" }),
    ).toThrow();
  });
});

describe("window IPC validation", () => {
  it("accepts a read and a boolean full-screen request", () => {
    expect(validateIpc("window:fullscreen", {})).toEqual({});
    expect(validateIpc("window:fullscreen:set", { fullscreen: true })).toEqual({
      fullscreen: true,
    });
    expect(validateIpc("window:fullscreen:set", { fullscreen: false })).toEqual({
      fullscreen: false,
    });
  });

  it("refuses a window selector and a non-boolean state", () => {
    // The invoking sender decides the window; a caller-supplied id would let
    // one renderer put another window into full screen.
    expect(() => validateIpc("window:fullscreen:set", { fullscreen: true, windowId: 1 })).toThrow(
      /malformed/i,
    );
    expect(() => validateIpc("window:fullscreen:set", { fullscreen: "yes" })).toThrow();
    expect(() => validateIpc("window:fullscreen", { fullscreen: true })).toThrow(/malformed/i);
  });
});
