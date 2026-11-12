/**
 * Labeled test fixtures. These are never a production fallback: if real state
 * is unavailable the UI must say so, not render a fixture as success.
 */
export const FIXTURE_LABEL = "TEST FIXTURE — NOT LIVE STATE" as const;

export const fixtures = {
  connecting: {
    schema: "event",
    label: FIXTURE_LABEL,
    data: {
      schema_version: 1,
      seq: 1,
      event: "stream.progress",
      kind: "stream.progress",
      thread_id: "thr_0123456789abcdef",
      timestamp: "2026-11-11T00:00:00.000Z",
      payload: { state: "replaying", thread_id: "thr_0123456789abcdef", seq: 1 },
    },
  },
  running: {
    schema: "event",
    label: FIXTURE_LABEL,
    data: {
      schema_version: 1,
      seq: 2,
      previous_seq: 1,
      event: "item.delta",
      kind: "item.delta",
      thread_id: "thr_0123456789abcdef",
      turn_id: "turn_0123456789abcdef",
      item_id: "item_0123456789abcdef",
      timestamp: "2026-11-11T00:00:01.000Z",
      payload: { kind: "agent_message", delta: "Working…" },
    },
  },
  completed: {
    schema: "event",
    label: FIXTURE_LABEL,
    data: {
      schema_version: 1,
      seq: 3,
      previous_seq: 2,
      event: "turn.completed",
      kind: "turn.completed",
      thread_id: "thr_0123456789abcdef",
      turn_id: "turn_0123456789abcdef",
      timestamp: "2026-11-11T00:00:02.000Z",
      payload: { status: "completed" },
    },
  },
  interrupted: {
    schema: "event",
    label: FIXTURE_LABEL,
    data: {
      schema_version: 1,
      seq: 4,
      previous_seq: 3,
      event: "turn.interrupted",
      kind: "turn.interrupted",
      thread_id: "thr_0123456789abcdef",
      turn_id: "turn_0123456789abcdef",
      timestamp: "2026-11-11T00:00:03.000Z",
      payload: { status: "interrupted", reason: "user_interrupt" },
    },
  },
  unknownCost: {
    schema: "usage",
    label: FIXTURE_LABEL,
    data: {
      provider: "deepseek",
      model: "deepseek-flash",
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: null,
      reasoningTokens: null,
      costUsd: null,
      costState: "unknown",
      source: "fixture",
      capturedAt: "2026-11-11T00:00:04.000Z",
    },
  },
  blocked: {
    schema: "error",
    label: FIXTURE_LABEL,
    data: {
      code: "BLOCKED_CREDENTIALS",
      message: "The configured provider has no usable credential.",
      retryable: false,
    },
  },
  unsupported: {
    schema: "error",
    label: FIXTURE_LABEL,
    data: {
      code: "UNSUPPORTED_OPERATION",
      message: "This pinned runtime does not expose the requested operation.",
      retryable: false,
    },
  },
  malformed: {
    schema: "event",
    label: FIXTURE_LABEL,
    data: {
      schema_version: 1,
      seq: "not-a-number",
      event: "",
      thread_id: "prj_0123456789abcdef",
      timestamp: "not-a-time",
    },
  },
} as const;

export type FixtureName = keyof typeof fixtures;
