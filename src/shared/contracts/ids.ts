import { z } from "zod";

/**
 * Branded identifiers. Mona never accepts a bare string where a project,
 * thread, turn, or task identity is required: mixing them up is a data-loss
 * bug, so the compiler carries the distinction and the runtime checks the
 * prefix.
 */
function brandedId<T extends string>(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[a-z0-9]{8,64}$`), `expected ${prefix}_<lowercase id>`)
    .brand<T>();
}

export const ProjectId = brandedId<"ProjectId">("prj");
export type ProjectId = z.infer<typeof ProjectId>;

export const TaskId = brandedId<"TaskId">("tsk");
export type TaskId = z.infer<typeof TaskId>;

export const ThreadId = brandedId<"ThreadId">("thr");
export type ThreadId = z.infer<typeof ThreadId>;

export const TurnId = brandedId<"TurnId">("turn");
export type TurnId = z.infer<typeof TurnId>;

export const OperationKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "operation keys are opaque ASCII tokens");
export type OperationKey = z.infer<typeof OperationKey>;

/** An absolute local path. Mona is macOS-only for 1.0, so POSIX form is exact. */
export const AbsolutePath = z.string().min(1).startsWith("/", "expected an absolute macOS path");
export type AbsolutePath = z.infer<typeof AbsolutePath>;

/** An ISO-8601 timestamp that actually parses. */
export const Timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "expected an ISO-8601 timestamp",
});
export type Timestamp = z.infer<typeof Timestamp>;
