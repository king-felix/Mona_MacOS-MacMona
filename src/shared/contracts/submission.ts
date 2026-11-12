import { z } from "zod";
import { OperationKey, ThreadId, Timestamp, TurnId } from "./ids";

/**
 * Submission identity is persisted before transmission. `outcome_unknown` is a
 * first-class state: a lost response is reconciled, never blindly retried.
 */
export const SubmissionStatus = z.enum([
  "queued",
  "sending",
  "accepted",
  "running",
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "outcome_unknown",
]);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

export const SubmissionState = z.strictObject({
  operationKey: OperationKey,
  threadId: ThreadId,
  turnId: TurnId.nullable(),
  status: SubmissionStatus,
  submittedAt: Timestamp,
  reconciled: z.boolean(),
  note: z.string().max(2000).optional(),
});
export type SubmissionState = z.infer<typeof SubmissionState>;

export const TERMINAL_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  "completed",
  "failed",
  "interrupted",
  "canceled",
];

export function isTerminalSubmission(status: SubmissionStatus): boolean {
  return TERMINAL_SUBMISSION_STATUSES.includes(status);
}
