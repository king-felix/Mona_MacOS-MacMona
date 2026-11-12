export type AdapterErrorCode =
  | "INCOMPATIBLE_ENGINE"
  | "UNSUPPORTED_CAPABILITY"
  | "MALFORMED_RESPONSE"
  | "SCHEMA_DRIFT"
  | "WRONG_THREAD"
  | "AUTH_FAILED"
  | "RUNTIME_UNAVAILABLE"
  | "EVENT_TOO_LARGE"
  | "PROFILE_MISMATCH"
  | "OPERATION_ABSENT"
  | "OPERATION_CONFLICT";

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class UnsupportedCapabilityError extends AdapterError {
  constructor(
    readonly capability: string,
    reason: string,
    details?: Record<string, unknown>,
  ) {
    super(
      "UNSUPPORTED_CAPABILITY",
      `unsupported capability: ${capability} (${reason})`,
      false,
      details,
    );
    this.name = "UnsupportedCapabilityError";
  }
}

export function isAdapterError(error: unknown): error is AdapterError {
  return error instanceof AdapterError;
}
