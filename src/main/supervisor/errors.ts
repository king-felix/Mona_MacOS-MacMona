import { AdapterError, type AdapterErrorCode } from "../engine/errors";

export type RuntimeLifecycleCode = Extract<
  AdapterErrorCode,
  | "MISSING_EXECUTABLE"
  | "NOT_EXECUTABLE"
  | "WORKSPACE_UNAVAILABLE"
  | "PORT_IN_USE"
  | "PERMISSION_DENIED"
  | "SUPERVISOR_UNAVAILABLE"
  | "STARTUP_FAILED"
  | "STARTUP_TIMEOUT"
  | "OWNERSHIP_MISMATCH"
  | "INCOMPATIBLE_ENGINE"
  | "STALE_OWNERSHIP"
>;

/**
 * A lifecycle failure with an explicit next action. Every actionable startup
 * state carries one so the UI can say what the user can do, not just that
 * something broke.
 */
export class RuntimeLifecycleError extends AdapterError {
  readonly action: string;

  constructor(
    code: RuntimeLifecycleCode,
    message: string,
    action: string,
    details?: Record<string, unknown>,
    retryable = false,
  ) {
    super(code, message, retryable, { ...(details ?? {}), action });
    this.name = "RuntimeLifecycleError";
    this.action = action;
  }
}

export function isRuntimeLifecycleError(error: unknown): error is RuntimeLifecycleError {
  return error instanceof RuntimeLifecycleError;
}
