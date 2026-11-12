/**
 * Typed state-layer failures. Every caller decides on a UI action from the
 * code, never by parsing an English message. A write that cannot be proven is
 * an error, not a silent success.
 */
export type StateErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "OWNER_MISMATCH"
  | "STALE_REVISION"
  | "ALIAS_CONFLICT"
  | "INVALID_PATH"
  | "DISK_FULL"
  | "QUOTA_EXCEEDED"
  | "ARTIFACT_TOO_LARGE"
  | "ARTIFACT_MISSING"
  | "MIGRATION_FAILED"
  | "UNSUPPORTED_SCHEMA"
  | "CORRUPT_DATABASE"
  | "IMPORT_INVALID"
  | "IMPORT_DIGEST_MISMATCH"
  | "IMPORT_REVISION_CONFLICT"
  | "MAINTENANCE_FAILED"
  | "INVALID_INPUT"
  | "PROTECTED_ARTIFACT";

export class StateError extends Error {
  constructor(
    readonly code: StateErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "StateError";
  }

  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function isStateError(error: unknown, code?: StateErrorCode): error is StateError {
  return error instanceof StateError && (code === undefined || error.code === code);
}
