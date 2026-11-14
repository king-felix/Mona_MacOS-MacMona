import type { CommandExecutionEntry } from "../../shared/contracts/command-execution";
import type {
  CommandExecuteRequest,
  CommandReceipt,
  CommandThreadReceipt,
} from "../../shared/contracts/command-execution";
import type { CommandCostClass, CommandSideEffect } from "../../shared/contracts/commands";
import type { ResolvedCommand } from "./commands";
import type { CommandCatalogService } from "./commands";
import { StudioError, type StudioCommandResult, type WorkStudio } from "./studio";

/**
 * R04 — the one path from a typed slash command to an effect.
 *
 * Every command resolves here, in the main process, against the pinned catalog
 * and the curated execution plan. Three properties matter more than the happy
 * path:
 *
 *  - Nothing reaches the model. A recognised command is never turned into a
 *    prompt, and a TUI-only command is never guessed at.
 *  - Nothing reaches a shell. A terminal route returns a fixed invocation that
 *    the renderer *prefills*; typed arguments are never interpolated into it.
 *  - Nothing is claimed that did not happen. A view opens a screen; a native
 *    operation reports the engine's own receipt; an unavailable command says so.
 */

export interface CommandDispatchDeps {
  catalog: CommandCatalogService;
  studio: WorkStudio;
}

const TERMINAL_NOTE =
  "Nothing was run. The terminal pane is prefilled with the command above and waits for you to launch it.";
// The classification comes first, in the same words the capability row and the
// command list use. R04's receipt described only the consequence ("the CLI
// prints its own help"), and the command smoke — which `npm run ci` does not
// run — kept failing on it from R04 until R13 noticed. A reader who sees
// "TUI-only" learns what the command is; the sentence after it says what Mona
// did instead.
const TUI_CLASSIFICATION = "TUI-only.";

export class CommandDispatchService {
  constructor(private readonly deps: CommandDispatchDeps) {}

  async execute(request: CommandExecuteRequest): Promise<CommandReceipt> {
    const resolved = this.deps.catalog.resolve(request.spelling);
    if (!resolved) {
      throw Object.assign(
        new Error(
          `"${request.spelling}" is not a command in the pinned Codewhale catalog; nothing was run.`,
        ),
        { code: "INVALID_INPUT" },
      );
    }
    const entry = resolved.plan;
    const base = this.baseReceipt(resolved, request, entry);

    if (entry.kind === "unavailable") {
      return {
        ...base,
        status: "not-executable",
        note: entry.note,
        detail: ["This engine version exposes no route for it. Nothing was run."],
      };
    }
    if (entry.kind === "view") {
      return {
        ...base,
        status: "completed",
        note: `${entry.note} Mona opened the surface; it did not run /${resolved.command} for you.`,
        target: { screen: entry.screen, settingsTab: entry.settingsTab ?? null, invocation: null },
      };
    }
    if (entry.kind === "terminal") {
      return {
        ...base,
        status: "deferred",
        note: `${TUI_CLASSIFICATION} ${entry.note} ${TERMINAL_NOTE}`,
        target: { screen: null, settingsTab: null, invocation: entry.invocation },
      };
    }
    return this.native(resolved, request, entry, base);
  }

  private baseReceipt(
    resolved: ResolvedCommand,
    request: CommandExecuteRequest,
    entry: CommandExecutionEntry,
  ): CommandReceipt {
    return {
      command: resolved.command,
      spelling: request.spelling,
      route: entry.kind,
      status: "failed",
      note: "",
      detail: [],
      cost: resolved.entry.annotation.cost as CommandCostClass,
      sideEffects: resolved.entry.annotation.sideEffects as CommandSideEffect[],
      target: { screen: null, settingsTab: null, invocation: null },
      thread: null,
      operationKey: request.operationKey,
      duplicate: false,
      snapshot: null,
    };
  }

  private async native(
    resolved: ResolvedCommand,
    request: CommandExecuteRequest,
    entry: Extract<CommandExecutionEntry, { kind: "native" }>,
    base: CommandReceipt,
  ): Promise<CommandReceipt> {
    const args = request.arguments.trim();
    const argumentError = validateArguments(entry.operation, args);
    if (argumentError !== null) {
      return { ...base, status: "invalid-argument", note: argumentError };
    }

    if (entry.confirm && !request.confirm) {
      return {
        ...base,
        status: "confirmation-required",
        note: `${entry.note} Confirm to run /${resolved.command}.`,
        detail: [
          `Cost class: ${base.cost}.`,
          ...base.sideEffects.map((effect) => `Effect: ${effect}.`),
          "Nothing has been sent yet.",
        ],
      };
    }

    const prior = await this.deps.studio.commandOperation(request.operationKey);
    if (prior) {
      if (prior.projectId !== request.projectId || prior.command !== resolved.command) {
        return {
          ...base,
          status: "invalid-argument",
          note: "That operation key was already used for a different command or project; nothing was run.",
        };
      }
      if (entry.operation !== "new") {
        if (prior.status === "completed") {
          const stored = prior.result as {
            note?: unknown;
            thread?: unknown;
            status?: unknown;
          } | null;
          return {
            ...base,
            status: "completed",
            note:
              typeof stored?.note === "string"
                ? stored.note
                : "This command already completed for that operation key.",
            thread: parseThread(stored?.thread),
            duplicate: true,
            snapshot: await this.deps.studio.snapshot(request.projectId),
          };
        }
        return {
          ...base,
          status: "failed",
          note: "This operation was already attempted and did not record a result. Check the conversation state before trying again; Mona will not repeat it blindly.",
          duplicate: true,
          snapshot: await this.deps.studio.snapshot(request.projectId),
        };
      }
      // `/new` resolves a pending key by resuming its recorded target thread.
    }

    try {
      const result = await this.runNative(entry.operation, request, args);
      return {
        ...base,
        status: result.status,
        note: result.note,
        thread: result.thread ? { ...result.thread, preserved: preserved() } : null,
        snapshot: result.snapshot,
        duplicate: result.duplicate,
        detail:
          result.status === "busy"
            ? [
                "The running turn keeps its events and its thread.",
                entry.operation === "new"
                  ? "Choose Wait, or choose Interrupt and start a new conversation."
                  : `/${resolved.command} waits; it has no interrupt option of its own.`,
              ]
            : entry.operation === "new"
              ? [
                  "Earlier conversations stay readable in the thread selector.",
                  "The engine thread is created with a deterministic operation key, so a retry cannot duplicate it.",
                ]
              : [],
      };
    } catch (error) {
      if (error instanceof StudioError) {
        return {
          ...base,
          status:
            error.code === "TURN_ACTIVE"
              ? "busy"
              : error.code === "INVALID_INPUT"
                ? "invalid-argument"
                : "failed",
          note: error.message,
          snapshot: await this.deps.studio.snapshot(request.projectId),
        };
      }
      return {
        ...base,
        status: "failed",
        note: `The engine operation did not complete: ${
          error instanceof Error ? error.message : String(error)
        } Nothing was reported as successful.`,
        snapshot: await this.deps.studio.snapshot(request.projectId),
      };
    }
  }

  private runNative(
    operation: Extract<CommandExecutionEntry, { kind: "native" }>["operation"],
    request: CommandExecuteRequest,
    args: string,
  ): Promise<StudioCommandResult> {
    const studio = this.deps.studio;
    switch (operation) {
      case "new":
        return studio.newThread(request.projectId, {
          mode: request.mode,
          operationKey: request.operationKey,
          ...(request.resolveBusy ? { resolveBusy: request.resolveBusy } : {}),
        });
      case "rename":
        return studio.renameConversation(request.projectId, {
          mode: request.mode,
          title: args,
          operationKey: request.operationKey,
        });
      case "compact":
        return studio.compactConversation(request.projectId, {
          mode: request.mode,
          operationKey: request.operationKey,
        });
      case "fork":
        return studio.forkConversation(request.projectId, {
          mode: request.mode,
          operationKey: request.operationKey,
        });
      case "retry":
        return studio.retryConversation(request.projectId, {
          mode: request.mode,
          operationKey: request.operationKey,
        });
    }
  }
}

function preserved(): CommandThreadReceipt["preserved"] {
  // Every switch keeps these by construction: the old local thread row, its
  // events and its turn rows are never deleted, and drafts are keyed per thread.
  return { draft: true, history: true, usage: true };
}

function parseThread(value: unknown): CommandThreadReceipt | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.mode !== "plan" && record.mode !== "work") return null;
  if (typeof record.localThreadId !== "string" || record.localThreadId.length === 0) return null;
  if (typeof record.generation !== "number" || !Number.isInteger(record.generation)) return null;
  return {
    mode: record.mode,
    generation: record.generation,
    localThreadId: record.localThreadId,
    engineThreadId: typeof record.engineThreadId === "string" ? record.engineThreadId : null,
    previousLocalThreadId:
      typeof record.previousLocalThreadId === "string" ? record.previousLocalThreadId : null,
    previousEngineThreadId:
      typeof record.previousEngineThreadId === "string" ? record.previousEngineThreadId : null,
    preserved: preserved(),
  };
}

/**
 * Arguments are data. A name that takes none refuses all of them, so a user
 * cannot smuggle a flag (or anything else) into a typed operation, and an
 * argument that is required is bounded and free of control characters.
 */
export function validateArguments(
  operation: Extract<CommandExecutionEntry, { kind: "native" }>["operation"],
  args: string,
): string | null {
  switch (operation) {
    case "new":
      if (args.length === 0) return null;
      if (args === "--force") {
        return null; // Accepted and deliberately inert: Mona never discards drafts.
      }
      return "/new takes no argument except --force.";
    case "compact":
      return args.length === 0
        ? null
        : "/compact does not take a focus argument here: focus is TUI-only. Run /compact with no argument.";
    case "retry":
      return args.length === 0 ? null : "/retry takes no argument in this build.";
    case "fork":
      return args.length === 0
        ? null
        : "/fork is bound to the current conversation and takes no argument.";
    case "rename": {
      if (args.length === 0) return "/rename needs a new title, for example: /rename Payment retry";
      if (args.length > 200) return "A title is limited to 200 characters.";
      if (/[\u0000-\u001f\u007f]/.test(args)) return "A title must not contain control characters.";
      return null;
    }
  }
}
