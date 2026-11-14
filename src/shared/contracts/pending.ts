/**
 * Pending engine requests — approvals and clarification questions.
 *
 * The pinned Runtime asks the user two ways: `approval.required` carries a
 * single-use `approval_id` capability answered at `POST /v1/approvals/{id}`, and
 * `user_input.required` carries a request id answered at
 * `POST /v1/user-input/{thread_id}/{request_id}` with structured choices.
 *
 * These parsers turn the engine's payloads into one typed shape for the store,
 * the snapshot and the screen. They are deliberately defensive: a payload this
 * build does not recognise yields no signal rather than an invented prompt, and
 * anything that would become part of a URL path is validated against a strict
 * charset, because the capability is echoed verbatim by the adapter.
 *
 * Nothing here decides that a request is answerable. That is a fact about the
 * engine (`pending_approvals` / `pending_user_inputs` on thread detail) and is
 * reconciled by the studio, not guessed from an event.
 */

export type PendingRequestKind = "approval" | "user_input";

export type PendingRequestStatus =
  "pending" | "sending" | "answered" | "expired" | "cancelled" | "unknown";

export interface PendingQuestionOption {
  label: string;
  description: string | null;
}

export interface PendingQuestion {
  id: string;
  /** Short label for the question, when the engine supplies one. */
  header: string | null;
  question: string;
  options: PendingQuestionOption[];
  multiSelect: boolean;
  /** True when this build cannot build a valid answer for the question. */
  malformed: boolean;
}

export interface PendingApprovalSignal {
  kind: "approval";
  /** The Runtime-minted capability; the only value the reply endpoint accepts. */
  requestKey: string;
  turnId: string | null;
  toolName: string | null;
  title: string;
  summary: string | null;
  /** The captured tool input, or null when the engine captured none. */
  input: unknown;
  toolCallId: string | null;
  /** Decisions the engine's own payload offered, when it named any. */
  decisions: Array<"allow" | "deny">;
}

export interface PendingUserInputSignal {
  kind: "user_input";
  requestKey: string;
  turnId: string | null;
  title: string;
  questions: PendingQuestion[];
  callId: string | null;
}

export type PendingSignal = PendingApprovalSignal | PendingUserInputSignal;

export interface PendingSettlement {
  kind: PendingRequestKind;
  requestKey: string;
  status: "answered" | "expired" | "cancelled";
  decision: "allow" | "deny" | null;
  decidedBy: string | null;
  automatic: boolean;
  note: string | null;
}

/** A capability or request id that is safe to echo into a URL path segment. */
const KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 4_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function key(value: unknown): string | null {
  const candidate = text(value, 200);
  return candidate !== null && KEY.test(candidate) ? candidate : null;
}

const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 64;

function parseQuestion(value: unknown, index: number): PendingQuestion {
  const source = record(value) ?? {};
  const id = key(source.id);
  const options: PendingQuestionOption[] = [];
  for (const option of Array.isArray(source.options) ? source.options.slice(0, MAX_OPTIONS) : []) {
    const entry = record(option);
    const label = text(entry?.label, 400);
    if (label === null) continue;
    options.push({ label, description: text(entry?.description, 800) });
  }
  const header = text(source.header, 200);
  const question = text(source.question, 2_000) ?? header ?? `Question ${index + 1}`;
  return {
    id: id ?? "",
    header,
    question,
    options,
    multiSelect: source.multi_select === true,
    // A question with no id cannot be answered: the engine validates
    // `questions.id` and would refuse an answer Mona guessed a name for.
    malformed:
      id === null || (options.length === 0 && header === null && text(source.question) === null),
  };
}

/**
 * The structured request an engine event announces, or null when the event is
 * not a request this build understands.
 */
export function pendingSignalFor(event: {
  kind: string;
  turnId?: string | null;
  payload: unknown;
}): PendingSignal | null {
  const payload = record(event.payload) ?? {};
  if (/^approval\.(required|requested)$/.test(event.kind)) {
    const requestKey = key(payload.approval_id) ?? key(payload.id);
    if (requestKey === null) return null;
    const toolName = text(payload.tool_name, 200);
    const summary = text(payload.summary, 400) ?? text(payload.description, 400);
    const requested = Array.isArray(payload.available_decisions)
      ? payload.available_decisions.filter(
          (entry): entry is "allow" | "deny" => entry === "allow" || entry === "deny",
        )
      : [];
    return {
      kind: "approval",
      requestKey,
      turnId: text(payload.turn_id, 200) ?? event.turnId ?? null,
      toolName,
      // The summary is built by the engine from the call's own arguments, never
      // from model prose. Falling back to the tool name stays descriptive
      // without inventing what was asked.
      title: summary ?? (toolName ? `${toolName} needs approval` : "A tool call needs approval"),
      summary,
      input: payload.input === undefined ? null : payload.input,
      toolCallId: text(payload.tool_call_id, 200),
      decisions: requested.length > 0 ? requested : ["allow", "deny"],
    };
  }
  if (
    /^user_input\.(required|requested)$/.test(event.kind) ||
    event.kind === "clarification.requested"
  ) {
    // Upstream documents `request_id`; its own clients read `id`. Both spellings
    // are accepted rather than assuming one.
    const requestKey = key(payload.request_id) ?? key(payload.id) ?? key(payload.input_id);
    if (requestKey === null) return null;
    const nested = record(payload.request);
    const source = Array.isArray(payload.questions)
      ? payload.questions
      : Array.isArray(nested?.questions)
        ? nested.questions
        : [];
    const questions = source.slice(0, MAX_QUESTIONS).map(parseQuestion);
    if (questions.length === 0) return null;
    return {
      kind: "user_input",
      requestKey,
      turnId: text(payload.turn_id, 200) ?? event.turnId ?? null,
      title:
        text(payload.summary, 400) ?? text(payload.header, 200) ?? "The engine asked a question",
      questions,
      callId: text(payload.call_id, 200),
    };
  }
  return null;
}

/** The settlement an engine event reports, or null when it settles nothing. */
export function pendingSettlementFor(event: {
  kind: string;
  payload: unknown;
}): PendingSettlement | null {
  const payload = record(event.payload) ?? {};
  if (event.kind === "approval.decided" || event.kind === "approval.timeout") {
    const requestKey = key(payload.approval_id) ?? key(payload.id);
    if (requestKey === null) return null;
    const cancelled = payload.cancelled === true || event.kind === "approval.timeout";
    // A cancellation or a timeout is the engine's own close, not a person's
    // answer. Even though the payload names a `deny`, no decision is recorded
    // against the user for one.
    const decision =
      cancelled || payload.timeout === true
        ? null
        : payload.decision === "allow" || payload.decision === "deny"
          ? payload.decision
          : payload.allowed === true
            ? "allow"
            : payload.allowed === false
              ? "deny"
              : null;
    // A timeout is the engine's own deny, not a person's decision, and a
    // cancellation is not a refusal. Both keep their own status so the screen
    // never reports "denied by you" for something nobody answered.
    const status =
      event.kind === "approval.timeout" || payload.timeout === true
        ? "expired"
        : cancelled
          ? "cancelled"
          : "answered";
    return {
      kind: "approval",
      requestKey,
      status,
      decision,
      decidedBy: text(payload.decided_by, 100),
      automatic: payload.auto === true || payload.automatic === true,
      note:
        status === "expired"
          ? "the engine's decision budget expired; that is the engine's deny, not your answer"
          : status === "cancelled"
            ? "the turn ended before anyone answered"
            : null,
    };
  }
  if (event.kind === "user_input.answered" || event.kind === "user_input.canceled") {
    const requestKey = key(payload.request_id) ?? key(payload.input_id) ?? key(payload.id);
    if (requestKey === null) return null;
    return {
      kind: "user_input",
      requestKey,
      status: event.kind === "user_input.canceled" ? "cancelled" : "answered",
      decision: null,
      decidedBy: null,
      automatic: false,
      note:
        event.kind === "user_input.canceled"
          ? "the question was cancelled by the engine; no answer was sent"
          : null,
    };
  }
  return null;
}
