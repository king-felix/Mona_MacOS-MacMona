import { describe, expect, it } from "vitest";
import type { StudioSnapshot } from "../src/shared/contracts/studio";
import type {
  CommandExecuteRequest,
  CommandReceipt,
} from "../src/shared/contracts/command-execution";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import { buildCommandExecutionPlan } from "../src/shared/commands/execution-plan";
import { CommandCatalogService } from "../src/main/work/commands";
import { CommandDispatchService, validateArguments } from "../src/main/work/command-dispatch";
import type { StudioCommandResult, WorkStudio } from "../src/main/work/studio";

const PROJECT = "prj_abcdefgh12345678" as CommandExecuteRequest["projectId"];
const catalog = new CommandCatalogService();
const plan = buildCommandExecutionPlan(buildCommandCatalog());

const SNAPSHOT = {
  projectId: PROJECT,
  connection: {
    state: "not_started",
    reason: "no studio session",
    since: "2026-11-13T00:00:00.000Z",
    port: null,
    engine: null,
    owned: false,
    external: false,
    lastEventAt: null,
    silentForMs: null,
    missing: [],
  },
  threadId: null,
  engineThreadId: null,
  activeTurnId: null,
  lastMode: null,
  pauseAfterTask: false,
  queued: 0,
  profile: {
    provider: "deepseek",
    exactId: null,
    model: "deepseek-flash",
    reasoningEffort: null,
    permissionPosture: "full_access",
    autoApprove: true,
    trustMode: false,
    allowShell: true,
    source: "configured",
    effective: null,
    effectiveTurnId: null,
  },
  cost: { observed: false, costUsd: 0, costComplete: false, turns: 0, label: "No usage recorded" },
  submission: null,
  diagnostics: [],
  followUps: [],
  steering: { available: false, reason: "test fixture: no steer route", requiredRoute: null },
  pendingRequests: [],
  canSubmit: true,
  cannotSubmitReason: null,
  controls: {
    canInterrupt: false,
    canPause: false,
    canCancelQueued: false,
    canStop: false,
  },
} as unknown as StudioSnapshot;

function completedResult(note: string): StudioCommandResult {
  return {
    status: "completed",
    note,
    thread: null,
    turnId: null,
    duplicate: false,
    snapshot: SNAPSHOT,
  };
}

interface FakeStudio {
  studio: WorkStudio;
  calls: Array<{ operation: string; options: unknown }>;
  operations: Map<string, { projectId: string; command: string; status: string; result: unknown }>;
  nextNew: StudioCommandResult | null;
}

function fakeStudio(): FakeStudio {
  const calls: FakeStudio["calls"] = [];
  const operations: FakeStudio["operations"] = new Map();
  const fake: FakeStudio = {
    calls,
    operations,
    nextNew: null,
    studio: null as unknown as WorkStudio,
  };
  const record = (operation: string) => (projectId: unknown, options: unknown) => {
    calls.push({ operation, options });
    return Promise.resolve(completedResult(`${operation} ran`));
  };
  fake.studio = {
    commandOperation: async (key: string) => operations.get(key) ?? null,
    snapshot: async () => SNAPSHOT,
    newThread: async (_projectId: unknown, options: unknown) => {
      calls.push({ operation: "new", options });
      return (
        fake.nextNew ?? {
          ...completedResult("new ran"),
          thread: {
            mode: "work",
            generation: 1,
            localThreadId: "thr_localnew",
            engineThreadId: "thr_enginenew",
            previousLocalThreadId: "thr_localold",
            previousEngineThreadId: "thr_engineold",
          },
        }
      );
    },
    renameConversation: record("rename"),
    compactConversation: record("compact"),
    forkConversation: record("fork"),
    retryConversation: record("retry"),
  } as unknown as WorkStudio;
  return fake;
}

function dispatch(fake: FakeStudio): CommandDispatchService {
  return new CommandDispatchService({ catalog, studio: fake.studio });
}

function request(overrides: Partial<CommandExecuteRequest> = {}): CommandExecuteRequest {
  return {
    projectId: PROJECT,
    mode: "work",
    spelling: "cost",
    arguments: "",
    operationKey: "cmd-test-0001",
    ...overrides,
  } as CommandExecuteRequest;
}

describe("R04 dispatch: every catalogued row has a route", () => {
  it("routes all 109 rows without a model call or an invented effect", async () => {
    const fake = fakeStudio();
    const dispatcher = dispatch(fake);
    let index = 0;
    for (const command of catalog.snapshot().commands) {
      index += 1;
      const entry = plan[command.name]!;
      const args = entry.kind === "native" && entry.operation === "rename" ? "A new title" : "";
      const receipt = await dispatcher.execute(
        request({
          spelling: command.name,
          arguments: args,
          operationKey: `cmd-matrix-${String(index).padStart(4, "0")}`,
          // Spend and conversation changes need the user's explicit acceptance.
          confirm: entry.kind === "native" && entry.operation !== "new" ? true : undefined,
        }),
      );
      expect(receipt.command, command.name).toBe(command.name);
      expect(receipt.route, command.name).toBe(entry.kind);
      expect(receipt.note.length, command.name).toBeGreaterThan(5);
      if (entry.kind === "view") {
        expect(receipt.target.screen, command.name).toBe(entry.screen);
      }
      if (entry.kind === "terminal") {
        expect(receipt.target.invocation, command.name).toBe(entry.invocation);
        expect(receipt.status, command.name).toBe("deferred");
      }
      if (entry.kind === "unavailable") {
        expect(receipt.status, command.name).toBe("not-executable");
      }
      if (entry.kind === "native") {
        expect(receipt.status, command.name).toBe("completed");
        expect(fake.calls.at(-1)?.operation, command.name).toBe(entry.operation);
      }
    }
    expect(catalog.snapshot().commands).toHaveLength(109);
  });

  it("resolves aliases through the same validation and reports the canonical name", async () => {
    const fake = fakeStudio();
    const receipt = await dispatch(fake).execute(request({ spelling: "yasuo", confirm: true }));
    expect(receipt.command).toBe("compact");
    expect(receipt.spelling).toBe("yasuo");
    expect(receipt.status).toBe("completed");
    expect(fake.calls.map((call) => call.operation)).toEqual(["compact"]);
  });

  it("resolves the engine's own non-ASCII and punctuation aliases", async () => {
    const fake = fakeStudio();
    const dispatcher = dispatch(fake);
    const voice = await dispatcher.execute(
      request({ spelling: "语音", operationKey: "cmd-alias-voice" }),
    );
    expect(voice.command).toBe("voice");
    expect(voice.route).toBe("terminal");
    const help = await dispatcher.execute(
      request({ spelling: "?", operationKey: "cmd-alias-help" }),
    );
    expect(help.command).toBe("help");
    const relay = await dispatcher.execute(
      request({ spelling: "接力", operationKey: "cmd-alias-relay" }),
    );
    expect(relay.command).toBe("relay");
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a spelling that is not in the catalog", async () => {
    const fake = fakeStudio();
    await expect(
      dispatch(fake).execute(request({ spelling: "definitely-not-a-command" })),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fake.calls).toHaveLength(0);
  });

  it("never calls the studio for a view, terminal or unavailable route", async () => {
    const fake = fakeStudio();
    const dispatcher = dispatch(fake);
    for (const spelling of ["cost", "theme", "workflow"]) {
      await dispatcher.execute(request({ spelling, operationKey: `cmd-none-${spelling}` }));
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("keeps a view honest: it opens the owner and does not claim the command ran", async () => {
    const receipt = await dispatch(fakeStudio()).execute(request({ spelling: "task" }));
    expect(receipt.target.screen).toBe("board");
    expect(receipt.note).toContain("did not run");
  });

  it("prefills a fixed terminal invocation and never folds arguments into it", async () => {
    const receipt = await dispatch(fakeStudio()).execute(
      request({
        spelling: "theme",
        arguments: "$(touch /tmp/mona-injected); rm -rf /",
        operationKey: "cmd-inject-0001",
      }),
    );
    expect(receipt.target.invocation).toBe("codewhale");
    expect(receipt.target.invocation).not.toMatch(/[;&|`$()]/);
    expect(receipt.note).not.toContain("touch /tmp");
    expect(receipt.note).toContain("Nothing was run");
  });

  it("refuses arguments for a command that takes none", async () => {
    const fake = fakeStudio();
    const receipt = await dispatch(fake).execute(
      request({ spelling: "new", arguments: "; rm -rf /", operationKey: "cmd-badargs-1" }),
    );
    expect(receipt.status).toBe("invalid-argument");
    expect(fake.calls).toHaveLength(0);
  });

  it("requires a title for /rename and bounds it", async () => {
    const fake = fakeStudio();
    const dispatcher = dispatch(fake);
    expect(
      (await dispatcher.execute(request({ spelling: "rename", operationKey: "cmd-rename-0" })))
        .status,
    ).toBe("invalid-argument");
    expect(
      (
        await dispatcher.execute(
          request({
            spelling: "rename",
            arguments: `bad\u0007title`,
            operationKey: "cmd-rename-1",
          }),
        )
      ).status,
    ).toBe("invalid-argument");
    expect(fake.calls).toHaveLength(0);
    const ok = await dispatcher.execute(
      request({ spelling: "rename", arguments: "Payment retry", operationKey: "cmd-rename-2" }),
    );
    expect(ok.status).toBe("completed");
    expect(fake.calls).toHaveLength(1);
  });

  it("asks before a spend or a conversation rewrite, and runs only on confirm", async () => {
    const fake = fakeStudio();
    const dispatcher = dispatch(fake);
    for (const spelling of ["compact", "retry"]) {
      const first = await dispatcher.execute(
        request({ spelling, operationKey: `cmd-confirm-${spelling}` }),
      );
      expect(first.status, spelling).toBe("confirmation-required");
      expect(first.detail.join(" ")).toContain("Nothing has been sent yet.");
    }
    expect(fake.calls).toHaveLength(0);
    const second = await dispatcher.execute(
      request({ spelling: "compact", operationKey: "cmd-confirm-compact", confirm: true }),
    );
    expect(second.status).toBe("completed");
    expect(fake.calls.map((call) => call.operation)).toEqual(["compact"]);
  });

  it("reuses a completed operation key instead of running it twice", async () => {
    const fake = fakeStudio();
    fake.operations.set("cmd-dup-0001", {
      projectId: PROJECT,
      command: "compact",
      status: "completed",
      result: { note: "already compacted", thread: null, status: "completed" },
    });
    const receipt = await dispatch(fake).execute(
      request({ spelling: "compact", operationKey: "cmd-dup-0001", confirm: true }),
    );
    expect(receipt.duplicate).toBe(true);
    expect(receipt.note).toBe("already compacted");
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a key reused for another command or project", async () => {
    const fake = fakeStudio();
    fake.operations.set("cmd-mixed-1", {
      projectId: PROJECT,
      command: "rename",
      status: "completed",
      result: { note: "renamed" },
    });
    const receipt = await dispatch(fake).execute(
      request({ spelling: "fork", operationKey: "cmd-mixed-1" }),
    );
    expect(receipt.status).toBe("invalid-argument");
    expect(fake.calls).toHaveLength(0);
  });

  it("surfaces the busy choice from /new without creating anything", async () => {
    const fake = fakeStudio();
    fake.nextNew = {
      status: "busy",
      note: "A work turn is running (turn_abc). Wait for it to finish, or choose Interrupt.",
      thread: null,
      turnId: "turn_abc",
      duplicate: false,
      snapshot: SNAPSHOT,
    };
    const receipt: CommandReceipt = await dispatch(fake).execute(
      request({ spelling: "new", operationKey: "cmd-busy-0001" }),
    );
    expect(receipt.status).toBe("busy");
    expect(receipt.thread).toBeNull();
    expect(receipt.detail.join(" ")).toContain("Interrupt");
  });

  it("marks the preserved evidence on a new conversation", async () => {
    const receipt = await dispatch(fakeStudio()).execute(
      request({ spelling: "new", operationKey: "cmd-new-0001" }),
    );
    expect(receipt.thread?.localThreadId).toBe("thr_localnew");
    expect(receipt.thread?.previousLocalThreadId).toBe("thr_localold");
    expect(receipt.thread?.preserved).toEqual({ draft: true, history: true, usage: true });
  });

  it("accepts --force as inert because Mona never discards a draft", () => {
    expect(validateArguments("new", "--force")).toBeNull();
    expect(validateArguments("new", "--delete")).not.toBeNull();
    expect(validateArguments("fork", "")).toBeNull();
    expect(validateArguments("retry", "3")).not.toBeNull();
  });
});
