import type { UpdateRejectionCode } from "../../shared/contracts/update";

/**
 * A refused trust decision, carrying the machine-readable code the UI renders.
 * A refusal is an error, never a silent fallback to an unverified path.
 */
export class UpdateError extends Error {
  constructor(
    readonly code: UpdateRejectionCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "UpdateError";
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isUpdateError(error: unknown): error is UpdateError {
  return error instanceof UpdateError;
}
