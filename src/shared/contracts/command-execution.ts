import { z } from "zod";
import { OperationKey, ProjectId } from "./ids";
import type { StudioMode, StudioSnapshot } from "./studio";
import type { CommandCostClass, CommandSideEffect } from "./commands";

/**
 * R04 — executing a catalogued Codewhale command.
 *
 * R03 catalogued the engine's composer surface and said which route *could*
 * carry each row. R04 is the execution layer. Every command is dispatched in
 * the main process through this one validated request, so aliases share a
 * single validation path and the renderer can never turn a slash line into
 * shell text. A route that Mona does not own (a TUI-only command) is reported
 * as such and, at most, prefilled into the terminal; it is never executed on
 * the user's behalf.
 */

export const COMMAND_ROUTE_KINDS = ["native", "view", "terminal", "unavailable"] as const;
export type CommandRouteKind = (typeof COMMAND_ROUTE_KINDS)[number];

export const NATIVE_COMMAND_OPERATIONS = ["new", "compact", "retry", "rename", "fork"] as const;
export type NativeCommandOperation = (typeof NATIVE_COMMAND_OPERATIONS)[number];

/** Existing Mona surfaces a command may reveal. These are real screens. */
export const COMMAND_SCREENS = [
  "studio",
  "board",
  "changes",
  "cost",
  "settings",
  "agents",
  "capabilities",
  "memory",
] as const;
export type CommandScreen = (typeof COMMAND_SCREENS)[number];

export const COMMAND_EXECUTION_ENTRY_SCHEMA = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("native"),
    operation: z.enum(NATIVE_COMMAND_OPERATIONS),
    /** True when the operation may spend or change the conversation. */
    confirm: z.boolean(),
    note: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("view"),
    screen: z.enum(COMMAND_SCREENS),
    settingsTab: z.string().min(1).optional(),
    note: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    /** A fixed, shell-word-only invocation; user arguments are never added. */
    invocation: z.string().min(1),
    note: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("unavailable"),
    note: z.string().min(1),
  }),
]);
export type CommandExecutionEntry = z.infer<typeof COMMAND_EXECUTION_ENTRY_SCHEMA>;

export const COMMAND_EXECUTION_PLAN_SCHEMA = z.record(
  z.string().min(1),
  COMMAND_EXECUTION_ENTRY_SCHEMA,
);
export type CommandExecutionPlan = z.infer<typeof COMMAND_EXECUTION_PLAN_SCHEMA>;

/**
 * The typed request. `spelling` is the exact word the user typed, without the
 * slash; main resolves it against canonical names *and* aliases, so no caller
 * can smuggle an unvalidated name. `arguments` is always data: it is passed to
 * a typed native operation or refused, and it is never interpolated into a
 * shell invocation.
 */
export const CommandExecuteRequestSchema = z.strictObject({
  projectId: ProjectId,
  mode: z.enum(["plan", "work"]),
  /**
   * The engine's own spellings are not all ASCII: `/voice` answers to `语音`,
   * `/help` to `?`. The rule that matters is that this is one bare token — no
   * whitespace, no slash, no shell metacharacter — so it can only be a lookup
   * key, never a path or a shell fragment. Main resolves it exactly.
   */
  spelling: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (value) => !/[\s/\\\u0000-\u001f\u007f]/.test(value),
      "a command spelling is one word without slashes or control characters",
    )
    .refine((value) => !/[;&|`$<>(){}"']/.test(value), "a command spelling is not shell text"),
  arguments: z.string().max(4096).default(""),
  operationKey: OperationKey,
  /** The user accepted a stated effect (a possible spend, a conversation fork). */
  confirm: z.boolean().optional(),
  /** The user chose to interrupt the running turn rather than wait. */
  resolveBusy: z.literal("interrupt").optional(),
});
export type CommandExecuteRequest = z.infer<typeof CommandExecuteRequestSchema>;

export const COMMAND_RECEIPT_STATUSES = [
  "completed",
  "confirmation-required",
  "busy",
  "invalid-argument",
  "not-executable",
  "deferred",
  "failed",
] as const;
export type CommandReceiptStatus = (typeof COMMAND_RECEIPT_STATUSES)[number];

export interface CommandTarget {
  screen: CommandScreen | null;
  settingsTab: string | null;
  /** Prefilled into the terminal input. Never executed by Mona. */
  invocation: string | null;
}

export interface CommandThreadReceipt {
  mode: StudioMode;
  generation: number;
  localThreadId: string;
  engineThreadId: string | null;
  previousLocalThreadId: string | null;
  previousEngineThreadId: string | null;
  /** What the switch deliberately kept, stated rather than assumed. */
  preserved: { draft: boolean; history: boolean; usage: boolean };
}

export interface CommandReceipt {
  /** Canonical engine name, even when an alias was typed. */
  command: string;
  /** The spelling the user typed. */
  spelling: string;
  route: CommandRouteKind;
  status: CommandReceiptStatus;
  note: string;
  detail: string[];
  cost: CommandCostClass;
  sideEffects: CommandSideEffect[];
  target: CommandTarget;
  thread: CommandThreadReceipt | null;
  operationKey: string;
  /** True when this key had already completed and the stored receipt is returned. */
  duplicate: boolean;
  snapshot: StudioSnapshot | null;
}
