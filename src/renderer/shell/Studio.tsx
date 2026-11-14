import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo, type JSX } from "react";
import type {
  ProjectDetail,
  StoredEventSummary,
  ThreadSummary,
} from "../../shared/contracts/project-bridge";
import type { StudioMode, StudioSnapshot } from "../../shared/contracts/studio";
import type { FollowUpView, StudioActivityView } from "../../shared/contracts/follow-up";
import type { WindowFullscreenView } from "../../shared/contracts/bridge";
import type { CommandCatalogEntry, CommandCatalogSnapshot } from "../../shared/contracts/commands";
import type { HistorySearchHit } from "../../shared/contracts/project-bridge";
import type { PendingRequestView, PendingResponseInput } from "../../shared/contracts/studio";
import type { PromptFavorite } from "../../shared/contracts/polish";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Inspector,
  SegmentedControl,
  StatusBadge,
  TabPanel,
  Tabs,
  TextArea,
  type WorkStatus,
} from "../design/primitives";
import {
  BranchIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  CostIcon,
  FolderIcon,
  FullscreenIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  RestoreIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
  WarningIcon,
} from "../design/icons";
import { engineBadge, formatTokens, projectAccent, projectMonogram, relativeTime } from "./visual";
import { Markdown } from "./markdown";
import { projectTimeline, type TimelineEntry } from "./timeline";
import { useTimelineWindow } from "./timeline-window";
import { projectActivity } from "./activity";
import { UsageHud } from "./UsageHud";
import { CommandMenu } from "./CommandMenu";
import {
  acceptCommand,
  classifyComposerText,
  probeCommandToken,
  rankCommands,
  type CommandIntent,
} from "./composer-commands";

/**
 * The paged history the shell has loaded. Omitted only by embedders (and tests)
 * that render the Studio from its first page alone; the screen then reports the
 * scope honestly from `ProjectDetail.history` and offers no page controls.
 */
export interface StudioHistoryProps {
  events: StoredEventSummary[];
  storedTotal: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  threadId: string | null;
  truncatedItems: Record<string, { returned: number; stored: number }>;
  completeItems: Record<string, true>;
  olderLoads: number;
  onLoadOlder?: () => void;
  onLoadItem?: (threadId: string, itemId: string) => void;
  onSelectThread?: (threadId: string | null) => void;
}

export interface StudioProps {
  detail: ProjectDetail | null;
  history?: StudioHistoryProps | null;
  studio: StudioSnapshot | null;
  studioBusy: boolean;
  mode: StudioMode;
  draft: string;
  draftStatus: "idle" | "saving" | "saved" | "error";
  /** The pinned slash-command catalog; absent only in embedders that have none. */
  commandCatalog?: CommandCatalogSnapshot | null;
  inspectorTab: string;
  onInspectorTab: (tab: string) => void;
  focusMode: boolean;
  /**
   * The stored Focus Studio *preference*. `focusMode` is the layout actually on
   * screen, which is also true while the window is in native full screen — the
   * OS state is never written into the preference.
   */
  focusPreference?: boolean;
  /** Native full screen as the window reported it; absent in plain embedders. */
  windowFullscreen?: WindowFullscreenView | null;
  onToggleFullscreen?: () => void;
  favorites: PromptFavorite[];
  onToggleFocus: () => void;
  onUseFavorite: (favorite: PromptFavorite) => void;
  onRequestSaveFavorite: () => void;
  onRemoveFavorite: (id: string) => void;
  onDraft: (text: string) => void;
  onMode: (mode: StudioMode) => void;
  onOpenFolder: () => void;
  onShowBoard: () => void;
  onStart: () => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  onPause: () => void;
  onResumeQueue: () => void;
  onCancelQueued: () => void;
  onStop: () => void;
  onReconcile: () => void;
  /**
   * R08. Queue the composer's text for after the current turn. Nothing is sent
   * by this call; main writes the row and returns the queue snapshot.
   */
  onQueueFollowUp?: (prompt: string, mode: StudioMode) => void;
  onEditFollowUp?: (id: string, prompt: string) => void;
  onCancelFollowUp?: (id: string) => void;
  /** Explicit send-now while idle; refused by main while a turn is active. */
  onDispatchFollowUps?: () => void;
  followUpBusy?: boolean;
  /**
   * R07. Answer one engine approval or question. The reply is acknowledged by
   * the Runtime, so the card only says "sent" after `acknowledged`.
   */
  onAnswerPending?: (requestId: string, response: PendingResponseInput) => void;
  /** The request whose answer is in flight, if any. */
  pendingAnswerId?: string | null;
  /**
   * R10. Copy exact text to the clipboard. The shell owns the IPC and reports
   * only what the clipboard acknowledged, so this component never claims a copy.
   */
  onCopy?: (text: string, label: "message" | "code" | "prompt") => void;
  /** Local conversation search over stored events, anchored to cards. */
  search?: StudioSearchProps | null;
  /** Open the project's scoped Changes view. */
  onShowChanges?: () => void;
  /** Open the composer's file-mention picker (a verified read, not an upload). */
  onMentionFile?: () => void;
}

export interface StudioSearchProps {
  query: string;
  hits: HistorySearchHit[];
  busy: boolean;
  error: string | null;
  /** The hit being navigated to, so the matched card can be marked. */
  anchor: { itemId: string | null; seq: number } | null;
  onQuery: (query: string) => void;
  onJump: (hit: HistorySearchHit) => void;
  onClear: () => void;
}

const LONG_BODY = 4_000;

function threadLabel(thread: ThreadSummary, currentThreadId: string | null | undefined): string {
  const title = thread.title?.trim() || `Thread ${thread.id.slice(-8)}`;
  // "Current" is the thread this Studio is bound to; everything else is
  // archived conversation and is labelled as such instead of looking live.
  return `${title} · ${thread.id === currentThreadId ? "current" : "archived"}`;
}

/**
 * The one place a status dot gains the `live` modifier.
 *
 * Vivid decoration may pulse that modifier, so it must mean exactly one thing:
 * the engine reports a running turn right now. A disconnected or stopped agent
 * keeps its plain dot and looks static no matter which intensity is on.
 */
function statusDotClass(
  tone: "neutral" | "success" | "attention" | "danger",
  live: boolean,
): string {
  const variant =
    tone === "success"
      ? "status-dot--success"
      : tone === "danger"
        ? "status-dot--danger"
        : "status-dot--attention";
  return `status-dot ${variant}${live ? " status-dot--live" : ""}`;
}

function connectionLabel(studio: StudioSnapshot | null, detail: ProjectDetail): string {
  if (!studio) return engineBadge(detail.engine).label;
  switch (studio.connection.state) {
    case "connected":
      return "Connected";
    case "running":
      return "Turn running";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Not started";
  }
}

function connectionTone(
  studio: StudioSnapshot | null,
  detail: ProjectDetail,
): "neutral" | "success" | "attention" | "danger" {
  if (!studio) return engineBadge(detail.engine).tone === "danger" ? "danger" : "neutral";
  if (studio.connection.state === "connected" || studio.connection.state === "running")
    return "success";
  if (studio.connection.state === "failed") return "danger";
  if (
    studio.connection.state === "connecting" ||
    studio.connection.state === "reconnecting" ||
    studio.connection.state === "stopped"
  )
    return "attention";
  return "neutral";
}

/**
 * One engine ask, answered in place.
 *
 * The card shows exactly what the engine asked — the tool and the arguments it
 * captured, or the question and its options — plus the permission posture the
 * turn is running under. Approving here changes no posture: "Allow once" answers
 * this one call, and the session grant is a separate, explicit checkbox.
 *
 * Nothing claims delivery before the Runtime acknowledges it: an approval the
 * engine no longer holds renders as expired with its note, and a failed send
 * leaves the card answerable only after the engine's own list says so.
 */
function PendingRequestCard({
  request,
  busy,
  posture,
  onAnswer,
  onRecheck,
}: {
  request: PendingRequestView;
  busy: boolean;
  posture: string;
  onAnswer?: (requestId: string, response: PendingResponseInput) => void;
  /** Re-read the engine's own pending list after an unconfirmed delivery. */
  onRecheck?: () => void;
}): JSX.Element {
  const [remember, setRemember] = useState(false);
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [showInput, setShowInput] = useState(false);
  const open = request.status === "pending" || request.status === "sending";
  const answers = request.questions.flatMap((question) => {
    const selected = choices[question.id] ?? [];
    const other = (freeText[question.id] ?? "").trim();
    return [
      ...selected.map((label) => ({ questionId: question.id, label, value: label })),
      ...(other ? [{ questionId: question.id, label: "Other", value: other }] : []),
    ];
  });
  const complete =
    request.questions.length > 0 &&
    request.questions.every((question) => {
      const count =
        (choices[question.id] ?? []).length + ((freeText[question.id] ?? "").trim() ? 1 : 0);
      return question.malformed ? false : question.multiSelect ? count > 0 : count === 1;
    });
  const toggle = (questionId: string, label: string, multi: boolean): void => {
    setChoices((current) => {
      const selected = current[questionId] ?? [];
      const next = multi
        ? selected.includes(label)
          ? selected.filter((entry) => entry !== label)
          : [...selected, label]
        : [label];
      return { ...current, [questionId]: next };
    });
  };
  const statusLabel: Record<PendingRequestView["status"], string> = {
    pending: "Waiting for you",
    sending: "Sending…",
    answered: "Answered",
    expired: "Expired",
    cancelled: "Cancelled",
    unknown: "Delivery unknown",
  };
  return (
    <li
      className={`pending-request pending-request--${request.kind} pending-request--${request.status}`}
      data-testid={`pending-request-${request.kind}`}
      data-status={request.status}
    >
      <div className="pending-request__head">
        <span className="pending-request__eyebrow">
          {request.kind === "approval" ? "Approval requested" : "Input required"}
          {request.toolName ? ` · ${request.toolName}` : ""}
        </span>
        <Badge
          tone={
            request.status === "answered"
              ? "success"
              : open
                ? "attention"
                : request.status === "expired" || request.status === "cancelled"
                  ? "neutral"
                  : "danger"
          }
        >
          {statusLabel[request.status]}
        </Badge>
      </div>
      <p className="pending-request__title">{request.title}</p>
      <p className="hint-line">
        Permission posture {posture}
        {request.turnId ? ` · turn ${request.turnId}` : ""}
        {request.decidedBy ? ` · decided by ${request.decidedBy}` : ""}
      </p>
      {request.input !== null && request.input !== undefined ? (
        <>
          <button
            type="button"
            className="pending-request__disclosure"
            aria-expanded={showInput}
            onClick={() => setShowInput((value) => !value)}
          >
            {showInput ? "Hide the captured arguments" : "Show the captured arguments"}
          </button>
          {showInput ? (
            <pre className="pending-request__input mono">
              {typeof request.input === "string"
                ? request.input
                : JSON.stringify(request.input, null, 2)}
            </pre>
          ) : null}
        </>
      ) : null}

      {request.kind === "user_input" && open ? (
        <div className="pending-request__questions">
          {request.questions.map((question) => (
            <fieldset className="pending-request__question" key={question.id}>
              <legend>{question.header ?? question.question}</legend>
              {question.header ? <p className="hint-line">{question.question}</p> : null}
              {question.options.map((option) => (
                <label className="pending-request__option" key={option.label}>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${request.id}-${question.id}`}
                    checked={(choices[question.id] ?? []).includes(option.label)}
                    disabled={!request.canAnswer || busy}
                    onChange={() => toggle(question.id, option.label, question.multiSelect)}
                  />
                  <span className="pending-request__option-text">
                    {option.label}
                    {option.description ? (
                      <small className="pending-request__option-hint">{option.description}</small>
                    ) : null}
                  </span>
                </label>
              ))}
              {/* The engine validates a label against the options it offered, so
                  free text is only answerable for a question that offered none.
                  Showing the field otherwise would let the user type an answer
                  Mona cannot submit. */}
              {question.options.length === 0 ? (
                <label className="pending-request__option pending-request__option--free">
                  <span>Your answer</span>
                  <input
                    type="text"
                    aria-label={`${question.header ?? question.question} answer`}
                    value={freeText[question.id] ?? ""}
                    disabled={!request.canAnswer || busy}
                    onChange={(event) =>
                      setFreeText((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                </label>
              ) : null}
              {question.malformed ? (
                <p className="hint-line pending-request__malformed">
                  This question has no answerable identity, so Mona will not guess one.
                </p>
              ) : null}
            </fieldset>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="pending-request__actions">
          {request.kind === "approval" ? (
            <>
              <Button
                size="sm"
                variant="primary"
                disabled={!request.canAnswer || busy || !request.decisions.includes("allow")}
                onClick={() =>
                  onAnswer?.(request.id, { kind: "approval", decision: "allow", remember })
                }
                data-testid="pending-approve"
              >
                Allow once
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!request.canAnswer || busy || !request.decisions.includes("deny")}
                onClick={() =>
                  onAnswer?.(request.id, { kind: "approval", decision: "deny", remember: false })
                }
                data-testid="pending-deny"
              >
                Deny
              </Button>
              <label className="pending-request__remember">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={!request.canAnswer || busy}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>
                  Remember this class for the session (a grant never changes the permission posture)
                </span>
              </label>
            </>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={!request.canAnswer || busy || !complete}
              onClick={() => onAnswer?.(request.id, { kind: "user_input", answers })}
              title={complete ? "Send these answers to the engine" : "Answer every question first"}
              data-testid="pending-submit"
            >
              Send answers
            </Button>
          )}
          {busy ? <span className="hint-line">Waiting for the engine to acknowledge…</span> : null}
        </div>
      ) : null}
      {!request.canAnswer && request.cannotAnswerReason && open ? (
        <p className="hint-line">{request.cannotAnswerReason}</p>
      ) : null}
      {request.status === "unknown" && onRecheck ? (
        <div className="pending-request__actions">
          <Button size="sm" variant="secondary" onClick={onRecheck} data-testid="pending-recheck">
            Read the engine's list again
          </Button>
        </div>
      ) : null}
      {request.acknowledgement ? (
        <p className="hint-line" data-testid="pending-acknowledgement">
          {request.acknowledgement}
        </p>
      ) : null}
      {request.note ? <p className="hint-line">{request.note}</p> : null}
    </li>
  );
}

/**
 * R11 — a card's handlers, read through a stable ref.
 *
 * The callbacks are rebuilt on every shell render (they close over current
 * state), so passing them as props would make every card re-render on every
 * keystroke. The ref keeps the behaviour current while the card's identity stays
 * bound to its entry.
 */
export interface TimelineCardHandlers {
  onCopy?: (text: string, label: "message" | "code" | "prompt") => void;
  onLoadItem?: (threadId: string, itemId: string) => void;
  onShowChanges?: () => void;
}

export interface TimelineCardProps {
  entry: TimelineEntry;
  truncated?: { returned: number; stored: number } | null;
  /** True when this card is the result the reader jumped to. */
  anchored?: boolean;
  handlers: { current: TimelineCardHandlers };
}

function TimelineCardImpl({
  entry,
  truncated,
  anchored,
  handlers,
}: TimelineCardProps): JSX.Element {
  const { onCopy, onLoadItem, onShowChanges } = handlers.current;
  const [expanded, setExpanded] = useState(false);
  const tooLong = entry.body.length > LONG_BODY;
  const body = tooLong && !expanded ? `${entry.body.slice(0, LONG_BODY)}\n…` : entry.body;
  return (
    <li
      className={`timeline-event timeline-event--${entry.kind}${
        anchored ? " timeline-event--anchored" : ""
      }`}
      data-card-key={entry.key}
      data-item-id={entry.itemId ?? undefined}
      data-seq={entry.seq}
      data-anchored={anchored ? "true" : undefined}
    >
      <span className="timeline-event__rail" aria-hidden="true">
        <span className="timeline-event__icon">
          {entry.kind === "tool" ? (
            <TerminalIcon size={15} />
          ) : entry.kind === "error" ? (
            <WarningIcon size={15} />
          ) : entry.kind === "status" ? (
            <InfoIcon size={15} />
          ) : entry.kind === "user" ? (
            <SparkIcon size={15} />
          ) : entry.kind === "reasoning" ? (
            <ClockIcon size={15} />
          ) : (
            <CheckIcon size={15} />
          )}
        </span>
      </span>
      <div className="timeline-event__body">
        <div className="timeline-event__head">
          <span className="timeline-event__title">
            {entry.title}
            {entry.status ? <span className="timeline-event__badge">{entry.status}</span> : null}
          </span>
          <span className="timeline-event__time">
            {new Date(entry.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        {body ? (
          entry.kind === "assistant" || entry.kind === "user" ? (
            <div className="timeline-event__prose">
              <Markdown
                text={body}
                onCopyCode={onCopy ? (source) => onCopy(source, "code") : undefined}
              />
            </div>
          ) : (
            <pre className="timeline-event__output">{body}</pre>
          )
        ) : null}
        {entry.partial ? (
          <div className="timeline-event__partial" data-testid="studio-partial-item">
            <span>
              This message began before the events loaded here, so the text below is not its
              beginning.
            </span>
            {entry.itemId ? (
              onLoadItem ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onLoadItem(entry.threadId, entry.itemId as string)}
                >
                  Load the beginning of this message
                </Button>
              ) : null
            ) : (
              <span className="hint-line">
                Its beginning was stored before item identity existed, so Mona cannot reconstruct
                it.
              </span>
            )}
          </div>
        ) : null}
        {truncated ? (
          <span className="hint-line" data-testid="studio-truncated-item">
            Showing {truncated.returned} of {truncated.stored} stored frames for this message.
          </span>
        ) : null}
        <div className="timeline-event__actions">
          {tooLong ? (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Collapse long output" : `Show full output (${entry.body.length} chars)`}
            </Button>
          ) : null}
          {onCopy && entry.body.length > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onCopy(entry.body, entry.kind === "tool" ? "code" : "message")}
              title="Copy this card's exact text. Success is reported only after the clipboard holds it."
              data-testid="copy-message"
            >
              {entry.kind === "tool" ? "Copy command" : "Copy"}
            </Button>
          ) : null}
          {onShowChanges && (entry.kind === "tool" || entry.kind === "error") ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={onShowChanges}
              title="Open this project's Changes view. Paths in model output are shown as text, never followed from here."
              data-testid="open-changes"
            >
              Open Changes
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/**
 * R11 — memoized on purpose. `entry` is an object from the memoized projection,
 * so a card re-renders only when its own entry, its truncation state or its
 * anchor state changes. Handlers arrive through a stable ref.
 */
const TimelineCard = memo(TimelineCardImpl);

/** How long the stream has been silent, or null when it is not stalled. */
function stallSeconds(studio: StudioSnapshot): number | null {
  const silent = studio.connection.silentForMs;
  if (silent === null || silent === undefined) return null;
  // Only a claimed-live connection can be "stalled": a stopped or failed
  // runtime is already reported by its own state.
  if (studio.connection.state !== "connected" && studio.connection.state !== "running") {
    return null;
  }
  // A quiet stream during a long model call is normal; 45 s of complete silence
  // while the engine promises keepalives is not.
  if (silent < 45_000) return null;
  return Math.round(silent / 1000);
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

/** Wall-clock elapsed, from a timestamp the studio actually recorded. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

/**
 * Elapsed time since the studio entered its current state, read from the
 * snapshot's own `since`. A running turn's `since` is the moment the connection
 * changed to "running", which is the turn's start; nothing here invents a
 * start time, and an unreadable timestamp says so instead of showing 0s.
 *
 * It keeps its own one-second timer so a long turn does not re-render the
 * transcript once per second.
 */
function Elapsed({ since, live }: { since: string; live: boolean }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  // With no session — or one that has not started — `since` is when the
  // snapshot was built, not when anything began. A clock there would be a
  // fabricated one, so the fact says so instead.
  if (!live) return <span>—</span>;
  const started = Date.parse(since);
  if (!Number.isFinite(started)) return <span>unknown</span>;
  return <span>{formatElapsed(Math.max(0, Math.round((now - started) / 1000)))}</span>;
}

interface FocusBarProps {
  detail: ProjectDetail;
  studio: StudioSnapshot | null;
  health: { label: string; tone: "neutral" | "success" | "attention" | "danger" };
  focusPreference: boolean;
  fullscreen: WindowFullscreenView | null;
  canStart: boolean;
  onStart: () => void;
  onPause: () => void;
  onResumeQueue: () => void;
  onInterrupt: () => void;
  onCancelQueued: () => void;
  onStop: () => void;
  onShowBoard: () => void;
  onToggleFocus: () => void;
  onToggleFullscreen?: () => void;
}

/**
 * The immersive dashboard: one row between 44 and 56 logical pixels that keeps
 * the identity, the honest activity state, the elapsed clock, the model, the
 * scoped spend and tokens, and the emergency controls on screen. Everything
 * else moves into the popover, which is opened by a real button rather than a
 * hover, so keyboard and screen-reader users reach it too.
 */
function formatSpan(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * R08. One line of real state, derived from stored events. The strip never
 * says "thinking": it says which turn is open, how long its frames span, and
 * what the last stored event's age is. Tool names expand in place.
 */
function ActivityStrip({
  activity,
  filterThreadId,
}: {
  activity: StudioActivityView;
  filterThreadId: string | null;
}): JSX.Element {
  const [openTool, setOpenTool] = useState<string | null>(null);
  const scope =
    filterThreadId === null
      ? activity.threadId === null
        ? "this project"
        : "current conversation"
      : "selected conversation";
  const label =
    activity.status === "running"
      ? "Running"
      : activity.status === "waiting"
        ? "Waiting for you"
        : activity.status === "idle"
          ? "Idle"
          : "Unknown";
  return (
    <section className="activity-strip" aria-label="Current activity" data-testid="activity-strip">
      <span
        className={statusDotClass(
          activity.status === "running"
            ? "success"
            : activity.status === "waiting"
              ? "attention"
              : "neutral",
          activity.status === "running",
        )}
        aria-hidden="true"
      />
      <span className="activity-strip__status" data-testid="activity-status">
        {label}
      </span>
      <span className="hint-line" data-testid="activity-scope">
        {scope}
        {activity.mode ? ` · ${activity.mode}` : ""}
      </span>
      {activity.turnId ? (
        <span className="hint-line">turn {activity.turnId.slice(0, 13)}</span>
      ) : null}
      {activity.durationMs !== null ? (
        <span className="hint-line" data-testid="activity-span">
          frames span {formatSpan(activity.durationMs)}
        </span>
      ) : null}
      {activity.idleMs !== null ? (
        <span className="hint-line" data-testid="activity-idle">
          last event {formatSpan(activity.idleMs)} ago
        </span>
      ) : null}
      {activity.needsYouReason ? <Badge tone="attention">{activity.needsYouReason}</Badge> : null}
      {activity.tools.length > 0 ? (
        <span className="activity-strip__tools">
          {activity.tools.map((tool) => (
            <button
              type="button"
              key={tool.id}
              className="activity-chip"
              aria-expanded={openTool === tool.id}
              onClick={() => setOpenTool(openTool === tool.id ? null : tool.id)}
              title={tool.summary}
              data-testid="activity-tool"
            >
              <TerminalIcon size={12} />
              <span>{tool.name}</span>
              <span className="activity-chip__status">{tool.status ?? "open"}</span>
            </button>
          ))}
          {activity.toolsNotInWindow > 0 ? (
            <span className="hint-line">
              +{activity.toolsNotInWindow} not shown (older than the loaded window)
            </span>
          ) : null}
        </span>
      ) : null}
      {openTool !== null
        ? (() => {
            const tool = activity.tools.find((candidate) => candidate.id === openTool);
            if (!tool) return null;
            return (
              <div className="activity-strip__detail" data-testid="activity-tool-detail">
                <span className="hint-line">
                  {tool.name} · {tool.status ?? "no terminal frame yet"}
                  {tool.durationMs !== null
                    ? ` · ${formatSpan(tool.durationMs)}`
                    : " · duration unavailable"}
                </span>
                <span className="hint-line" data-testid="activity-tool-identity">
                  item {tool.id}
                </span>
              </div>
            );
          })()
        : null}
    </section>
  );
}

const FOLLOW_UP_LABEL: Record<FollowUpView["status"], string> = {
  queued: "Queued",
  dispatching: "Sending",
  accepted: "Sent",
  rejected: "Refused",
  canceled: "Canceled",
  unknown: "Outcome unknown",
  stale: "Not sent",
};

const FOLLOW_UP_TONE: Record<
  FollowUpView["status"],
  "neutral" | "attention" | "success" | "danger"
> = {
  queued: "neutral",
  dispatching: "attention",
  accepted: "success",
  rejected: "danger",
  canceled: "neutral",
  unknown: "attention",
  stale: "attention",
};

/**
 * R08. The follow-up queue. Only `queued` rows offer edit, cancel, and Run now;
 * every other state is a record of what happened, not a control.
 */
function FollowUpQueue({
  items,
  busy,
  steering,
  turnActive,
  onEdit,
  onCancel,
  onDispatch,
}: {
  items: FollowUpView[];
  busy: boolean;
  steering: StudioSnapshot["steering"] | undefined;
  turnActive: boolean;
  onEdit?: (id: string, prompt: string) => void;
  onCancel?: (id: string) => void;
  onDispatch?: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const queued = items.filter((item) => item.status === "queued");
  const recentlySettled = items
    .filter((item) => item.status !== "queued")
    .slice(-3)
    .reverse();
  const canRunNow = queued.some((item) => item.canDispatchNow) && !turnActive;
  return (
    <section className="follow-ups" aria-label="Queued follow-ups" data-testid="follow-up-queue">
      <div className="follow-ups__head">
        <span className="follow-ups__title">Follow-ups</span>
        <span className="hint-line" data-testid="follow-up-count">
          {queued.length === 0
            ? "Nothing queued"
            : `${queued.length} queued for after the current turn`}
        </span>
        {canRunNow && onDispatch ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onDispatch}
            title="Send the oldest queued follow-up now. Main refuses while a turn is active."
            data-testid="follow-up-run-now"
          >
            Run now
          </Button>
        ) : null}
      </div>
      {turnActive ? (
        <p className="hint-line" data-testid="steer-availability">
          {steering && !steering.available
            ? steering.reason
            : "Steering this run is not offered: no verified native route."}
        </p>
      ) : null}
      {queued.length === 0 ? null : (
        <ul className="follow-ups__list">
          {queued.map((item) => (
            <li key={item.id} className="follow-up" data-testid="follow-up-item">
              {editing?.id === item.id ? (
                <TextArea
                  label="Edit queued follow-up"
                  rows={2}
                  value={editing.text}
                  onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                />
              ) : (
                <span className="follow-up__text">{item.prompt}</span>
              )}
              <span className="follow-up__meta hint-line">
                {item.mode} · queued {relativeTime(item.queuedAt)}
                {item.note ? ` · ${item.note}` : ""}
              </span>
              <span className="follow-up__actions">
                {editing?.id === item.id ? (
                  <>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={busy || editing.text.trim().length === 0}
                      onClick={() => {
                        onEdit?.(item.id, editing.text);
                        setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Discard
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setEditing({ id: item.id, text: item.prompt })}
                      data-testid="follow-up-edit"
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => onCancel?.(item.id)}
                      data-testid="follow-up-cancel"
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {recentlySettled.length > 0 ? (
        <ul className="follow-ups__settled" aria-label="Recently handled follow-ups">
          {recentlySettled.map((item) => (
            <li key={item.id} className="hint-line" data-testid="follow-up-settled">
              <Badge tone={FOLLOW_UP_TONE[item.status]}>{FOLLOW_UP_LABEL[item.status]}</Badge>{" "}
              {item.prompt.slice(0, 90)}
              {item.turnId ? ` · turn ${item.turnId.slice(0, 13)}` : ""}
              {item.note ? ` · ${item.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function FocusBar(props: FocusBarProps): JSX.Element {
  const drawerRef = useRef<HTMLDetailsElement | null>(null);
  const { detail, studio, health, fullscreen } = props;
  const { project, usage } = detail;
  const profile = studio?.profile ?? null;
  const effective = profile?.effective ?? null;
  const state = studio?.connection.state ?? "not_started";
  const blockedTasks = detail.tasks.filter((task) => task.status === "blocked").length;
  const thread = studio?.engineThreadId ?? studio?.threadId ?? null;
  // One derivation per fact, so the narrow layout can move a value into the
  // drawer without ever computing a second, differently-worded answer.
  const modelText = effective
    ? `${effective.provider} / ${effective.model}`
    : profile
      ? `${profile.provider} / ${profile.model}`
      : "not reported yet";
  const spendText = studio?.cost.observed
    ? `${studio.cost.costComplete ? "" : "at least "}$${studio.cost.costUsd.toFixed(4)} · ${studio.cost.turns}t`
    : "not recorded";
  const tokensText = usage.observed
    ? `${formatTokens(usage.inputTokens)} in · ${formatTokens(usage.outputTokens)} out · ${formatTokens(usage.cachedTokens)} cached`
    : "no usage recorded";
  const live = state === "running" || state === "connected";
  return (
    <header className="focus-bar" data-testid="studio-focus-bar">
      <div className="focus-bar__identity">
        <span
          className={`monogram monogram--${projectAccent(project)} monogram--tiny`}
          aria-hidden="true"
        >
          {projectMonogram(project)}
        </span>
        <div className="focus-bar__names">
          <span className="focus-bar__project" title={project.rootPath}>
            {project.name}
          </span>
          <span className="focus-bar__thread" title={thread ?? "No engine conversation yet"}>
            {thread ? `Conversation ${thread.slice(-10)}` : "No engine conversation yet"}
            {studio?.activeTurnId ? ` · turn ${studio.activeTurnId.slice(-8)}` : ""}
          </span>
        </div>
      </div>

      <div className="focus-bar__facts">
        <span className="fact" data-testid="focus-activity">
          <span
            className={statusDotClass(health.tone, studio?.connection.state === "running")}
            aria-hidden="true"
          />
          <span className="fact__label">Engine</span>
          <span className="fact__value">{health.label}</span>
        </span>
        <span
          className="fact"
          data-testid="focus-elapsed"
          title="Time since the studio entered this state. For a running turn that is the turn's start, as the engine session recorded it."
        >
          <ClockIcon size={14} />
          <span className="fact__label">{state === "running" ? "Turn" : "Elapsed"}</span>
          <span className="fact__value">
            {studio ? <Elapsed since={studio.connection.since} live={live} /> : "no session"}
          </span>
        </span>
        <span
          className="fact"
          data-testid="focus-model"
          title={
            effective
              ? `Observed on the last turn: ${effective.provider} / ${effective.model}`
              : profile
                ? `Configured: ${profile.provider} / ${profile.model}`
                : "No route has been reported yet"
          }
        >
          <SparkIcon size={14} />
          <span className="fact__label">Model</span>
          <span className="fact__value">
            {effective?.model ?? profile?.model ?? "not reported yet"}
          </span>
          {effective ? (
            <Badge tone={effective.usedFallback ? "attention" : "neutral"}>Observed</Badge>
          ) : null}
        </span>
        <span
          className="fact"
          data-testid="focus-cost"
          title={`Project scope, from stored turn receipts: ${studio?.cost.label ?? "no usage recorded"}. An unpriced turn is never counted as $0.00.`}
        >
          <CostIcon size={14} />
          <span className="fact__label">Project spend</span>
          <span className="fact__value">{spendText}</span>
        </span>
        <span
          className="fact"
          data-testid="focus-tokens"
          title="Project scope: input, output and cached tokens as the engine reported them at each completed turn."
        >
          <span className="fact__label">Tokens</span>
          <span className="fact__value">{tokensText}</span>
        </span>
      </div>

      <div className="focus-bar__actions">
        {props.canStart ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={props.onStart}
            title="Start the owned runtime for this workspace. Submitting a task also starts it."
          >
            Start
          </Button>
        ) : null}
        {studio?.pauseAfterTask ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<PlayIcon size={14} />}
            onClick={props.onResumeQueue}
          >
            Resume queue
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            icon={<PauseIcon size={14} />}
            disabled={!studio?.controls.canPause}
            title={
              studio?.controls.canPause
                ? "Finish the active task, then start nothing new"
                : "Pause is a queue boundary; start the engine first"
            }
            onClick={props.onPause}
          >
            Pause
          </Button>
        )}
        <Button
          size="sm"
          variant="danger"
          icon={<StopIcon size={14} />}
          disabled={!studio?.controls.canInterrupt}
          title={
            studio?.controls.canInterrupt
              ? "Ask the engine to interrupt the active turn"
              : "No active turn to interrupt"
          }
          onClick={props.onInterrupt}
        >
          Interrupt
        </Button>
        <details
          className="focus-bar__more"
          ref={drawerRef}
          onKeyDown={(event) => {
            // The drawer is the first thing Escape closes. Without this the
            // shell's handler would take the whole focused layout away and
            // unmount the very panel the reader was in.
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (drawerRef.current) drawerRef.current.open = false;
          }}
        >
          <summary className="focus-bar__more-toggle" data-testid="focus-more">
            More <ChevronDownIcon size={13} />
          </summary>
          <div className="focus-bar__drawer" role="group" aria-label="More Studio controls">
            <div className="focus-bar__drawer-actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={!studio?.controls.canCancelQueued}
                onClick={props.onCancelQueued}
              >
                Cancel queued
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={!studio?.controls.canStop}
                onClick={props.onStop}
              >
                Stop engine
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<WarningIcon size={14} />}
                onClick={props.onShowBoard}
              >
                {blockedTasks > 0 ? `Blockers (${blockedTasks})` : "Blockers"}
              </Button>
            </div>
            <dl className="detail-list detail-list--tight">
              {/* A narrow window hides some facts from the bar rather than
                  wrapping it. They are never lost: the same values are here,
                  with the same wording, so nothing becomes unreachable. */}
              <div className="detail-row">
                <dt>Model</dt>
                <dd data-testid="focus-drawer-model">{modelText}</dd>
              </div>
              <div className="detail-row">
                <dt>Spend</dt>
                <dd data-testid="focus-drawer-cost">{spendText}</dd>
              </div>
              <div className="detail-row">
                <dt>Tokens</dt>
                <dd data-testid="focus-drawer-tokens">{tokensText}</dd>
              </div>
              <div className="detail-row">
                <dt>Full screen</dt>
                <dd data-testid="focus-fullscreen-state">
                  {fullscreen === null
                    ? "not reported by this build"
                    : !fullscreen.available
                      ? "unavailable on this platform"
                      : fullscreen.pending
                        ? "requested; waiting for macOS to report the transition"
                        : fullscreen.fullscreen
                          ? `native, observed ${fullscreen.epoch} transition${fullscreen.epoch === 1 ? "" : "s"} ago`
                          : "windowed"}
                </dd>
              </div>
              <div className="detail-row">
                <dt>Layout</dt>
                <dd>
                  {props.focusPreference
                    ? "Focus Studio preference on; stored with the project view and restored as a layout, never as full screen"
                    : "Focused layout from native full screen; the stored preference is off"}
                </dd>
              </div>
              <div className="detail-row">
                <dt>Scope</dt>
                <dd>
                  Spend and tokens are project totals from stored turn receipts
                  {usage.turns > 0 ? ` (${usage.turns} turn${usage.turns === 1 ? "" : "s"})` : ""}.
                  {usage.observed && !usage.costComplete ? " Some turns are unpriced." : ""}
                </dd>
              </div>
              {studio && studio.diagnostics.length > 0 ? (
                <div className="detail-row">
                  <dt>Diagnostics</dt>
                  <dd>{studio.diagnostics.slice(-3).join(" · ")}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </details>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Leave Focus Studio"
          title={
            fullscreen?.fullscreen
              ? "Native full screen is providing this layout. Leave full screen first (Control-Command-F or the green button), then this turns the stored preference off."
              : props.focusPreference
                ? "Leave Focus Studio (Escape also leaves it when the composer and dialogs are closed)"
                : "Focus Studio is not on for this project"
          }
          disabled={!props.focusPreference || fullscreen?.fullscreen === true}
          onClick={props.onToggleFocus}
          data-testid="focus-exit"
        >
          <RestoreIcon size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={fullscreen?.fullscreen ? "Exit Full Screen" : "Enter Full Screen"}
          aria-pressed={fullscreen?.fullscreen === true}
          aria-busy={fullscreen?.pending === true}
          title={
            fullscreen === null
              ? "This build has no window full screen control"
              : !fullscreen.available
                ? "Native full screen is only offered on macOS"
                : fullscreen.pending
                  ? "Waiting for macOS to report the transition"
                  : fullscreen.fullscreen
                    ? "Leave native full screen (Control-Command-F)"
                    : "Enter native full screen (Control-Command-F)"
          }
          disabled={!fullscreen?.available || fullscreen?.pending === true}
          onClick={props.onToggleFullscreen}
          data-testid="focus-fullscreen"
        >
          <FullscreenIcon size={14} />
        </Button>
      </div>
    </header>
  );
}

export function StudioScreen(props: StudioProps): JSX.Element {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const anchorRef = useRef<{
    height: number;
    top: number;
    loads: number;
    /** The card at the top of the viewport when the older page was asked for. */
    key: string | null;
    /** That card's offset from the top of the scrolling pane, in pixels. */
    viewportOffset: number;
    /** The project the anchor belongs to; a switch abandons it. */
    projectId: string | null;
  } | null>(null);
  const lastCountRef = useRef(0);
  const [unread, setUnread] = useState(0);
  const [atLatest, setAtLatest] = useState(true);
  // R13 — the card whose place an older-page read must hold. It is state, not
  // only the ref below, because the window has to keep that card *mounted*; see
  // the pin's comment for why the identity is otherwise unreachable.
  const [heldKey, setHeldKey] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [composing, setComposing] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissedCommand, setDismissedCommand] = useState<string | null>(null);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);
  const [menuBox, setMenuBox] = useState<{ placement: "above" | "below"; maxHeight: number }>({
    placement: "above",
    maxHeight: 360,
  });
  // R05: the immersive composer is bounded and resizable. The height is a
  // component value, so it survives focus, full screen and a project switch
  // without a remount and without a new persisted preference.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const gripRef = useRef<{ y: number; height: number } | null>(null);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  // The stage and the composer's own chrome are observed, not assumed. A fixed
  // pixel height would survive a window shrink, a zoom change or a focus
  // transition and then take the live turn off screen, which is exactly what
  // the bound exists to prevent.
  const [stageSize, setStageSize] = useState({ height: 0, chrome: 96, other: 0 });
  useLayoutEffect(() => {
    if (!props.focusMode) return;
    const stage = stageRef.current;
    const field = composerRef.current;
    if (!stage || !field) return;
    const measure = (): void => {
      const height = stage.clientHeight > 0 ? stage.clientHeight : window.innerHeight;
      const box = field.closest(".composer") as HTMLElement | null;
      const chrome =
        box && box.offsetHeight > 0 ? Math.max(0, box.offsetHeight - field.offsetHeight) : 96;
      // What the stage holds besides the console and the composer: the search
      // panel, the conversation toolbar, the gaps and the padding. The composer
      // bound has to subtract it, or "42% of the stage" quietly becomes "42% of
      // the stage after the console" (R13 measured 197 px of console against a
      // 248 px composer that way).
      const timeline = timelineRef.current;
      const other =
        timeline && box ? Math.max(0, height - timeline.offsetHeight - box.offsetHeight) : 0;
      setStageSize((previous) =>
        previous.height === height && previous.chrome === chrome && previous.other === other
          ? previous
          : { height, chrome, other },
      );
    };
    measure();
    // A ResizeObserver sees window resize, zoom, and a layout change that a
    // window `resize` event does not announce.
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    observer?.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [props.focusMode]);
  const { detail, studio, history } = props;
  const events = history?.events ?? detail?.events ?? [];
  const eventCount = events.length;
  const historyComplete = history ? !history.hasMore : detail?.history.hasMore === false;

  // R11 — the projection is a pure function of the event list, the paging state
  // and the reloaded item ids, so it is memoized on exactly those. Before this,
  // a keystroke in the composer re-projected the whole loaded transcript,
  // because the draft lives in the same shell state as the console.
  //
  // `completeItems` is flattened to a stable string inside the memo: a fresh
  // `Set` in the argument list would be a new object on every render and defeat
  // the cache entirely.
  const completeItemKey = useMemo(
    () =>
      Object.keys(history?.completeItems ?? {})
        .sort()
        .join("|"),
    [history?.completeItems],
  );
  const { entries, internalActivity, unprojected } = useMemo(
    () =>
      projectTimeline(events, {
        historyComplete,
        completeItems: new Set(completeItemKey === "" ? [] : completeItemKey.split("|")),
      }),
    [events, historyComplete, completeItemKey],
  );

  // R08: the strip is a read over the same stored frames the console shows.
  // Computed from events and the live snapshot; no timer and no engine call sits
  // behind it.
  //
  // R11 memoizes it, and `now` is therefore the clock of the last recomputation
  // rather than of the last paint. The consequence is stated rather than hidden:
  // while a turn is live the snapshot pushes twice a second, so the age is fresh;
  // when the project is completely idle nothing recomputes it and the reported
  // age stops advancing. That was already true before this change — R08 has no
  // timer on purpose — and a keystroke used to refresh it by accident. A timer
  // here would be a per-second render of the whole screen to move one label.
  const activity = useMemo(
    () =>
      projectActivity({
        studio,
        events,
        filterThreadId: history?.threadId ?? null,
        now: Date.now(),
      }),
    [studio, events, history?.threadId],
  );

  // The hit the reader jumped to. Scrolling happens after the card exists: a hit
  // in an older page is found by loading pages, never by pretending it is here.
  const searchAnchor = props.search?.anchor ?? null;
  const anchorKey =
    searchAnchor === null ? null : `${searchAnchor.itemId ?? ""}:${searchAnchor.seq}`;
  // R11 — the card the window must keep mounted. A search hit outside the
  // rendered slice would otherwise be scrolled to as a hole.
  const anchorCardKey = useMemo(() => {
    if (searchAnchor === null) return null;
    const found = entries.find((entry) =>
      searchAnchor.itemId !== null
        ? entry.itemId === searchAnchor.itemId
        : entry.seq === searchAnchor.seq,
    );
    return found?.key ?? null;
  }, [entries, searchAnchor]);

  // R11 — bounded rendering. `keys` changes only when the projected order does,
  // so the window arithmetic is not repeated on a keystroke.
  const cardKeys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const timelineWindow = useTimelineWindow({
    keys: cardKeys,
    containerRef: timelineRef,
    includeKey: anchorCardKey ?? heldKey,
    followRef: followRef,
  });
  // Cards read their handlers through this ref, so a new closure in the shell
  // does not re-render every mounted card.
  const cardHandlers = useRef<TimelineCardHandlers>({});
  cardHandlers.current = {
    onCopy: props.onCopy,
    onLoadItem: history?.onLoadItem,
    onShowChanges: props.onShowChanges,
  };
  // The load callback is read through a ref: `history` is rebuilt on every Shell
  // render, and an effect keyed on the object would ask for another page on each
  // one. Only a completed page read (the event count or `hasMore`) retries.
  const loadOlderRef = useRef<(() => void) | null>(null);
  const appliedAnchorRef = useRef<string | null>(null);
  loadOlderRef.current = props.history?.onLoadOlder ?? null;
  const historyHasMore = props.history?.hasMore ?? false;
  const historyLoading = props.history?.loading ?? false;
  const historyPages = props.history?.olderLoads ?? 0;
  useEffect(() => {
    if (searchAnchor === null) return;
    const node = timelineRef.current;
    if (!node) return;
    const selector =
      searchAnchor.itemId !== null
        ? `[data-item-id="${CSS.escape(searchAnchor.itemId)}"]`
        : `[data-seq="${searchAnchor.seq}"]`;
    const card = node.querySelector(selector);
    if (card) {
      followRef.current = false;
      setAtLatest(false);
      // Once per anchor: the effect also runs on every later page or live frame,
      // and re-scrolling each time would drag a reader who has moved on.
      if (appliedAnchorRef.current !== anchorKey) {
        appliedAnchorRef.current = anchorKey;
        card.scrollIntoView({ block: "center" });
      }
      return;
    }
    // Not in the loaded window yet: ask for one more page, bounded by the
    // history the project actually holds. When the last page has been read and
    // the card still is not here, the loop ends — an absent hit is reported as
    // absent rather than hidden behind an endless load.
    if (historyHasMore && !historyLoading) loadOlderRef.current?.();
  }, [anchorKey, searchAnchor, historyHasMore, historyLoading, historyPages, eventCount]);

  const composerLimits = useMemo(() => {
    const stage = stageSize.height > 0 ? stageSize.height : window.innerHeight || 800;
    // The bound applies to the composer BOX, not to the text area. That
    // distinction was the defect R13 measured: `0.42 x stage` was compared
    // against the text area, so the box — mode row, hint and action row
    // included, 152 px of chrome on this host — could reach 64% of the stage
    // while the check still read "bounded". The text area's maximum is
    // whatever the box has left after that chrome. A three-line composer is a
    // requirement, so the bound never pushes the text area below its 72 px
    // floor; below that the stage is too short and the page scrolls instead.
    const boxCap = Math.round(stage * 0.42);
    return { min: 72, max: Math.max(72, boxCap - stageSize.chrome) };
  }, [stageSize]);
  // Re-clamp whenever the stage changes: a shrink must not leave a height the
  // new stage cannot afford.
  useEffect(() => {
    setComposerHeight((current) =>
      current === null
        ? current
        : Math.min(composerLimits.max, Math.max(composerLimits.min, current)),
    );
  }, [composerLimits]);
  const clampComposer = (value: number): number =>
    Math.min(composerLimits.max, Math.max(composerLimits.min, Math.round(value)));
  const resizeComposer = (delta: number): void => {
    setComposerHeight((current) =>
      clampComposer((current ?? (composerRef.current?.offsetHeight || 96)) + delta),
    );
  };

  // Follow new engine events, but never fight a reader who scrolled up.
  useEffect(() => {
    const node = timelineRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [events]);

  // A different project or thread starts at its own live edge; a stale
  // follow/scroll position from the previous conversation is not inherited.
  useEffect(() => {
    followRef.current = true;
    setAtLatest(true);
    setUnread(0);
    lastCountRef.current = 0;
    anchorRef.current = null;
    setHeldKey(null);
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [detail?.project.id, history?.threadId]);

  // Inserting an older page must not drag the reader down. R13 found that the
  // original height-based correction was no longer exact once R11 windowed the
  // console: the list's height includes estimated (unmeasured) cards, so
  // "scrollHeight grew by N, move by N" left the reader a card short — 115.5 px
  // on a 10,054-event project, reproduced on the installed build. The anchor now
  // names the card that was at the top of the viewport and holds *its* offset,
  // re-applying over a few frames while the new slice measures itself.
  // `heldKey` keeps that card *mounted* across the prepend, which is what makes
  // the identity reachable at all: a page is 200 cards, the insertion is above
  // the reader, and the slice is computed from the pre-insertion scroll position,
  // so the card that was on screen would otherwise not be in the DOM and the pin
  // would fall back to the estimate it exists to replace. The height-based target
  // stays only for a card that has genuinely left the list.
  // The anchor is applied only when a completed older-page read changes the
  // load counter, so a live refresh cannot be mistaken for an older page.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const node = timelineRef.current;
    if (!anchor || !node) return;
    if ((history?.olderLoads ?? 0) === anchor.loads) return;
    // The anchor belongs to the conversation it was taken in. A project or thread
    // switch abandons it rather than scrolling the new conversation to a position
    // that meant something in the old one.
    if (anchor.projectId !== (detail?.project.id ?? null)) {
      anchorRef.current = null;
      setHeldKey(null);
      return;
    }
    // A reader who jumped to the live edge has left the older page deliberately;
    // a pending correction must not drag them back.
    if (followRef.current) {
      anchorRef.current = null;
      setHeldKey(null);
      return;
    }
    let cancelled = false;
    let frames = 0;
    let last = Number.NaN;
    // Only this pin may clear its own anchor: a second "Load earlier" click
    // supersedes it, and the newer pin owns the ref by then.
    const settle = (): void => {
      if (anchorRef.current !== anchor) return;
      anchorRef.current = null;
      setHeldKey(null);
    };
    const pin = (): void => {
      if (cancelled) return;
      const card = anchor.key
        ? node.querySelector<HTMLElement>(`[data-card-key="${CSS.escape(anchor.key)}"]`)
        : null;
      if (!card) {
        // `heldKey` kept it mounted, so this means the card truly left the list
        // (a page boundary dropped it, or the thread changed). Correct by the
        // measured height difference and settle rather than loop. The mode is
        // written to the DOM so the smoke can prove which path ran: a fallback
        // is a real correction, but it is the estimate this change exists to
        // replace, and it must not be able to pass as the measured one.
        node.dataset.anchorMode = "height";
        node.scrollTop = node.scrollHeight - anchor.height + anchor.top;
        settle();
        return;
      }
      node.dataset.anchorMode = "identity";
      const paneTop = node.getBoundingClientRect().top;
      const offset = card.getBoundingClientRect().top - paneTop + node.scrollTop;
      const target = Math.max(0, offset - anchor.viewportOffset);
      const converged = Number.isFinite(last) && Math.abs(target - node.scrollTop) < 0.5;
      last = target;
      node.scrollTop = target;
      frames += 1;
      // Four frames is the bound: the new slice's cards have measured themselves
      // by then, so the remaining difference is zero, not an estimate.
      if (converged || frames >= 4) {
        settle();
        return;
      }
      requestAnimationFrame(() => requestAnimationFrame(() => pin()));
    };
    pin();
    // Written to the DOM rather than React state: counting this must not cause
    // another commit, and the smoke can assert that the anchor really applied.
    node.dataset.anchorApplications = String(Number(node.dataset.anchorApplications ?? 0) + 1);
    return () => {
      cancelled = true;
    };
  }, [events, history?.olderLoads]);

  const loadOlder = (): void => {
    const node = timelineRef.current;
    if (!node) {
      anchorRef.current = null;
      setHeldKey(null);
    } else {
      const paneTop = node.getBoundingClientRect().top;
      const cards = Array.from(node.querySelectorAll<HTMLElement>("[data-card-key]"));
      const first = cards.find((card) => card.getBoundingClientRect().bottom > paneTop + 1) ?? null;
      const key = first?.dataset.cardKey ?? null;
      anchorRef.current = {
        height: node.scrollHeight,
        top: node.scrollTop,
        loads: history?.olderLoads ?? 0,
        key,
        viewportOffset: first ? first.getBoundingClientRect().top - paneTop : 0,
        projectId: detail?.project.id ?? null,
      };
      setHeldKey(key);
    }
    followRef.current = false;
    setAtLatest(false);
    props.history?.onLoadOlder?.();
  };

  const jumpToLatest = (): void => {
    followRef.current = true;
    setAtLatest(true);
    setUnread(0);
    // The reader asked for the live edge; nothing is left to hold.
    anchorRef.current = null;
    setHeldKey(null);
    const node = timelineRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    // The window re-measures as the slice changes, which moves the list's height
    // under the viewport. Re-pin after layout settles; without this the jump lands
    // a few dozen pixels short, and the pane's own scroll handler reads that as
    // "the reader scrolled away" and turns follow back off.
    const pin = (): void => {
      if (followRef.current && timelineRef.current) {
        timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(pin));
  };

  // R10 unread count. The reader scrolled back deliberately, so new frames are
  // counted instead of yanking the viewport. The unit is stated as "events"
  // because that is what this counts: a heartbeat is an event, and calling it a
  // message would be a nicer number and a worse fact.
  useEffect(() => {
    const previous = lastCountRef.current;
    lastCountRef.current = eventCount;
    if (followRef.current) {
      setUnread(0);
      return;
    }
    // Count the delta, not one per render: a burst of frames is several events.
    setUnread((current) => current + Math.max(0, eventCount - previous));
  }, [eventCount]);

  const commandProbe =
    props.commandCatalog && !composing
      ? probeCommandToken(props.draft, caret, selection.start, selection.end)
      : { token: null, literal: null };
  const commandQuery = commandProbe.token?.name ?? "";
  const commandMatches =
    props.commandCatalog && commandProbe.token
      ? rankCommands(props.commandCatalog, commandQuery)
      : [];
  const commandKey = commandProbe.token
    ? `${commandProbe.token.start}:${commandProbe.token.name}`
    : null;
  const commandMenuOpen = commandKey !== null && dismissedCommand !== commandKey;
  // The listbox only exists when it has rows; ARIA references must follow the
  // DOM, not the intent, or the combobox points at a missing element.
  const commandListOpen = commandMenuOpen && commandMatches.length > 0;
  const commandIntent: CommandIntent = props.commandCatalog
    ? classifyComposerText(props.draft, props.commandCatalog)
    : { kind: "prompt" };
  const commandLine = commandIntent.kind !== "prompt";
  // A new query or a freshly opened list starts at its best match. Arrow keys
  // change only the index, so they are not reset by this effect.
  useEffect(() => {
    setCommandIndex(0);
  }, [commandQuery, commandMenuOpen]);

  // A restored or externally replaced draft must not leave a caret from the
  // previous project. Clamp it to the text and re-measure on draft-identity
  // changes so the probe never reads a position the user cannot see.
  useEffect(() => {
    if (caret <= props.draft.length) return;
    setCaret(props.draft.length);
    setSelection({ start: props.draft.length, end: props.draft.length });
  }, [props.draft.length, caret]);

  useEffect(() => {
    setCommandIndex(0);
    setDismissedCommand(null);
  }, [detail?.project.id, history?.threadId]);

  // Escape dismisses this token only. Moving the caret away or editing the
  // token clears the dismissal; accepting a no-argument command also closes the
  // list instead of immediately reopening it on the new text.
  useEffect(() => {
    if (dismissedCommand !== null && dismissedCommand !== commandKey) {
      setDismissedCommand(null);
    }
  }, [commandKey, dismissedCommand]);

  // The list floats over the studio. Measure the composer so it opens on the
  // side with room: a 900 px window has less than 42vh above the composer, and
  // a 200% zoom halves the CSS viewport again. The panel scrolls rather than
  // pushing the composer or the page sideways.
  useLayoutEffect(() => {
    if (!commandMenuOpen) return;
    const measure = (): void => {
      const node = composerBoxRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      const placement = above >= 220 || above >= below ? "above" : "below";
      const available = placement === "above" ? above : below;
      // The viewport cap matters at page zoom: Electron changes the CSS
      // viewport without resizing the window, so a measurement taken before a
      // zoom change must never produce a panel taller than the window.
      const cap = Math.min(520, window.innerHeight - 16);
      // Never taller than the room on the chosen side. Below 64 CSS px the
      // panel overlaps the composer (a tiny window at high zoom) rather than
      // pretending to fit; the list stays scrollable.
      setMenuBox({
        placement,
        maxHeight: Math.min(cap, Math.max(64, available - 8)),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [commandMenuOpen, props.draft, props.focusMode]);

  // Accepting a suggestion is a controlled-value edit; restore the caret after
  // React has rendered the new text instead of guessing where the DOM put it.
  useEffect(() => {
    if (pendingCaret === null) return;
    const node = composerRef.current;
    if (node) {
      node.focus();
      node.setSelectionRange(pendingCaret, pendingCaret);
      setCaret(pendingCaret);
      setSelection({ start: pendingCaret, end: pendingCaret });
    }
    setPendingCaret(null);
  }, [props.draft, pendingCaret]);

  const trackCaret = (node: HTMLTextAreaElement): void => {
    const start = node.selectionStart ?? 0;
    const end = node.selectionEnd ?? start;
    setCaret(start);
    setSelection({ start, end });
  };

  const acceptEntry = (entry: CommandCatalogEntry): void => {
    if (!commandProbe.token) return;
    const next = acceptCommand(props.draft, commandProbe.token, entry);
    props.onDraft(next.text);
    setPendingCaret(next.caret);
    setCommandIndex(0);
    setDismissedCommand(`${commandProbe.token.start}:${entry.name}`);
  };

  if (!detail) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<FolderIcon size={30} />}
            title="Choose a project"
            description="Open a folder or select a project from Home. Mona reads local state only; it does not start an engine or resume work automatically."
            action={
              <Button
                variant="primary"
                onClick={props.onOpenFolder}
                icon={<FolderIcon size={16} />}
              >
                Open folder
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const { project, engine, usage } = detail;
  const health = { label: connectionLabel(studio, detail), tone: connectionTone(studio, detail) };
  const scope = history?.storedTotal ?? detail.history.storedTotal;
  const followUps = studio?.followUps ?? [];
  // A settled request is history, not a waiting prompt. Only open asks render as
  // an interruption; the rest stay in the stored record and the diagnostics.
  // An `unknown` row is still an ask the engine may be waiting on, so it stays on
  // screen with its reason and a way to re-read the engine's list. Only settled
  // rows (answered, expired, cancelled) drop out of the attention area.
  const openPending = (studio?.pendingRequests ?? []).filter(
    (request) =>
      request.status === "pending" || request.status === "sending" || request.status === "unknown",
  );
  const blockedTasks = detail.tasks.filter((task) => task.status === "blocked");
  const currentTask =
    detail.tasks.find((task) => task.status === "running") ??
    detail.tasks.find((task) => task.status === "blocked") ??
    detail.tasks[0] ??
    null;
  const profile = studio?.profile ?? null;
  const effective = profile?.effective ?? null;
  // The composer is bound to the studio's current conversation. Reading an
  // older one is a stored read; a send would go to the current conversation,
  // so a task typed here would start somewhere the reader is not looking.
  const sendTargetThread = studio?.threadId ?? detail.currentThreadId;
  const viewingArchivedThread = history?.threadId != null && history.threadId !== sendTargetThread;
  const sendBlocked =
    props.draft.trim().length === 0 ||
    props.studioBusy ||
    viewingArchivedThread ||
    (studio !== null && !studio.canSubmit);
  const sendReason = viewingArchivedThread
    ? "You are reading an earlier conversation. Select Current in the conversation list to send here; this draft belongs to the current conversation."
    : (studio?.cannotSubmitReason ??
      (studio === null ? "Mona starts the engine when you submit an explicit task." : null));
  const sendDisabled = commandLine ? props.draft.trim().length === 0 : sendBlocked;
  const sendTitle = commandLine
    ? "This line is a Codewhale command. Send explains its route; it is never sent to the model."
    : sendBlocked
      ? (sendReason ?? "A turn is already active")
      : "Submit this task";
  const connectionState = studio?.connection.state ?? "not_started";
  const canStart =
    !props.studioBusy &&
    (connectionState === "not_started" ||
      connectionState === "stopped" ||
      connectionState === "failed");

  return (
    <div
      className={`screen screen--studio ${props.focusMode ? "screen--studio-focus" : ""}`}
      data-focus-mode={props.focusMode ? "on" : "off"}
    >
      {props.focusMode ? (
        <FocusBar
          detail={detail}
          studio={studio}
          health={health}
          focusPreference={props.focusPreference ?? props.focusMode}
          fullscreen={props.windowFullscreen ?? null}
          canStart={canStart}
          onStart={props.onStart}
          onPause={props.onPause}
          onResumeQueue={props.onResumeQueue}
          onInterrupt={props.onInterrupt}
          onCancelQueued={props.onCancelQueued}
          onStop={props.onStop}
          onShowBoard={props.onShowBoard}
          onToggleFocus={props.onToggleFocus}
          onToggleFullscreen={props.onToggleFullscreen}
        />
      ) : null}
      <div className="context-bar">
        <div className="context-bar__identity">
          <span className={`monogram monogram--${projectAccent(project)}`} aria-hidden="true">
            {projectMonogram(project)}
          </span>
          <div className="context-bar__text">
            <h1 className="context-bar__title">{project.name}</h1>
            <span className="context-bar__path mono" title={project.rootPath}>
              {project.rootPath}
            </span>
          </div>
        </div>
        <div className="context-bar__actions">
          <Button
            size="sm"
            variant={props.focusMode ? "primary" : "ghost"}
            onClick={props.onToggleFocus}
            title="Focus Mode keeps one task, the timeline, the composer, and the emergency controls. Command-Shift-F toggles it."
            aria-pressed={props.focusMode}
          >
            {props.focusMode ? "Focus Mode on" : "Focus Mode"}
          </Button>
          {/* Native full screen is a separate control from the stored layout:
              it is the OS state, and the menu's Control-Command-F is the same
              action. One press cannot reach both, because only the menu binds
              that key. */}
          <Button
            size="sm"
            variant="ghost"
            icon={<FullscreenIcon size={14} />}
            aria-label={
              props.windowFullscreen?.fullscreen ? "Exit Full Screen" : "Enter Full Screen"
            }
            aria-pressed={props.windowFullscreen?.fullscreen === true}
            aria-busy={props.windowFullscreen?.pending === true}
            title={
              props.windowFullscreen === null || props.windowFullscreen === undefined
                ? "This build has no window full screen control"
                : !props.windowFullscreen.available
                  ? "Native full screen is only offered on macOS"
                  : props.windowFullscreen.pending
                    ? "Waiting for macOS to report the transition"
                    : "Native macOS full screen (Control-Command-F). The focused layout follows the window's own event."
            }
            disabled={!props.windowFullscreen?.available || props.windowFullscreen.pending === true}
            onClick={props.onToggleFullscreen}
            data-testid="studio-fullscreen"
          >
            {props.windowFullscreen?.fullscreen ? "Exit Full Screen" : "Full Screen"}
          </Button>
        </div>
        <div className="context-bar__facts">
          <span className="fact">
            <BranchIcon size={14} />
            <span className="fact__label">Branch</span>
            <span className="fact__value">{detail.branch ?? "Not a Git repository"}</span>
          </span>
          <span className="fact" data-testid="studio-connection">
            <span
              className={statusDotClass(health.tone, connectionState === "running")}
              aria-hidden="true"
            />
            <span className="fact__label">Engine</span>
            <Badge tone={health.tone}>{health.label}</Badge>
          </span>
          <span className="fact" data-testid="studio-profile">
            <SparkIcon size={14} />
            <span className="fact__label">Model</span>
            <span className="fact__value">
              {effective
                ? `${effective.provider} / ${effective.model}`
                : profile
                  ? `${profile.provider} / ${profile.model}`
                  : "Not reported until the studio reads its profile"}
            </span>
            {effective ? (
              <Badge tone={effective.usedFallback ? "attention" : "neutral"}>Observed</Badge>
            ) : profile ? (
              <Badge tone="neutral">Configured</Badge>
            ) : null}
          </span>
          <span className="fact">
            <LockIcon size={14} />
            <span className="fact__label">Permission</span>
            <span className="fact__value">
              {effective
                ? effective.permissionPosture
                : profile
                  ? `${profile.permissionPosture} (configured)`
                  : "Unknown"}
            </span>
          </span>
          <span className="fact" data-testid="studio-cost">
            <CostIcon size={14} />
            <span className="fact__label">Spend</span>
            <span className="fact__value">
              {studio?.cost.label ??
                (usage.observed
                  ? usage.costComplete
                    ? `$${usage.costUsd.toFixed(4)}`
                    : `At least $${usage.costUsd.toFixed(4)}; some turns unpriced`
                  : "No usage recorded")}
            </span>
          </span>
        </div>
      </div>

      {props.focusMode ? null : connectionState === "failed" ? (
        <Callout
          tone="danger"
          title="The live studio could not connect"
          action={
            canStart ? (
              <Button size="sm" variant="secondary" onClick={props.onStart}>
                Retry start
              </Button>
            ) : undefined
          }
        >
          {studio?.connection.reason ?? "The engine is unavailable."} History and drafts remain
          usable. Starting an engine is an explicit action, not a model call.
        </Callout>
      ) : connectionState === "not_started" ? (
        <Callout
          tone="attention"
          title="Engine not started for this project"
          action={
            canStart ? (
              <Button size="sm" variant="secondary" onClick={props.onStart}>
                Start engine
              </Button>
            ) : undefined
          }
        >
          {studio?.connection.reason ??
            "Mona has not started its owned runtime in this launch. Starting it is separate from submitting a task; browsing and viewing history make no model call."}
        </Callout>
      ) : connectionState === "connecting" ? (
        <Callout tone="neutral" title="Connecting to the owned runtime">
          Waiting for a verified loopback listener and an authenticated health answer. No task is
          sent yet.
        </Callout>
      ) : connectionState === "reconnecting" ? (
        <Callout tone="attention" title="Reconnecting from the first missing event">
          {studio?.connection.reason ?? "The event stream ended while the turn is active."} Replay
          advances display state only; it never re-runs a tool.
        </Callout>
      ) : studio && stallSeconds(studio) !== null ? (
        <Callout
          tone="attention"
          title={`No engine events for ${formatDuration(stallSeconds(studio) ?? 0)}`}
          action={
            canStart ? (
              <Button size="sm" variant="secondary" onClick={props.onStart}>
                Reconnect
              </Button>
            ) : undefined
          }
        >
          The stream is open but silent. Mona reconnects automatically when the engine's keepalives
          stop; reconnecting now re-subscribes from the first event it is missing.
        </Callout>
      ) : connectionState === "stopped" ? (
        <Callout
          tone="attention"
          title="Runtime stopped"
          action={
            canStart ? (
              <Button size="sm" variant="secondary" onClick={props.onStart}>
                Start engine
              </Button>
            ) : undefined
          }
        >
          The owned runtime is stopped. Work was interrupted, not completed; starting again does not
          resend it.
        </Callout>
      ) : connectionState === "running" ? (
        <Callout tone="success" title="A turn is running">
          {studio?.activeTurnId ? `Turn ${studio.activeTurnId}. ` : ""}Pause after task and
          interrupt now stay visible in the control strip below the composer.
        </Callout>
      ) : (
        <Callout tone="success" title="Runtime connected to this workspace">
          {studio?.connection.engine
            ? `Codewhale ${studio.connection.engine.version} (${studio.connection.engine.commit.slice(0, 7)})`
            : "The engine identity was verified."}
          {studio?.connection.port ? ` · loopback port ${studio.connection.port}` : ""}. Nothing is
          sent until you submit a task.
        </Callout>
      )}

      {openPending.length > 0 ? (
        <section className="pending-requests" aria-label="Engine requests waiting for you">
          <ul className="pending-requests__list">
            {openPending.map((request) => (
              <PendingRequestCard
                key={request.id}
                request={request}
                busy={props.pendingAnswerId === request.id}
                posture={
                  studio?.profile.effective?.permissionPosture ??
                  studio?.profile.permissionPosture ??
                  "unknown"
                }
                onAnswer={props.onAnswerPending}
                onRecheck={props.onStart}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {studio?.submission?.status === "outcome_unknown" ? (
        <Callout
          tone="attention"
          title="Submission outcome unknown — reconcile required"
          action={
            <Button size="sm" variant="secondary" onClick={props.onReconcile}>
              Reconcile lookup
            </Button>
          }
        >
          The response was lost after the write may have been accepted. Mona will not resend it.
          {studio.submission.note ? ` ${studio.submission.note}` : ""}
        </Callout>
      ) : null}

      {studio && studio.connection.missing.length > 0 ? (
        <Callout tone="attention" title="Some engine events were never received">
          {studio.connection.missing
            .slice(0, 3)
            .map((gap) => (gap.from === gap.to ? `#${gap.from}` : `#${gap.from}–${gap.to}`))
            .join(", ")}
          {studio.connection.missing.length > 3
            ? ` and ${studio.connection.missing.length - 3} more`
            : ""}{" "}
          — the timeline below is missing those frames. Mona asked the engine to replay them and
          recorded the gap rather than inventing content.
        </Callout>
      ) : null}

      <ActivityStrip activity={activity} filterThreadId={history?.threadId ?? null} />
      <UsageHud
        usage={studio?.usage}
        profile={profile}
        connection={studio?.connection ?? null}
        readAtLabel={
          studio?.usage?.provenance.readAt
            ? new Date(studio.usage.provenance.readAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })
            : undefined
        }
      />

      <div className="studio" ref={stageRef}>
        {/* Paging controls stay outside the scrolling console, so Jump to
            latest is reachable without scrolling and Load earlier is never
            hidden by the very history it loads. */}
        {props.search ? (
          <div className="history-search" data-testid="studio-search">
            <label className="history-search__field">
              <span className="hint-line">Search conversation</span>
              <input
                type="search"
                value={props.search.query}
                placeholder="Match stored text in this project"
                onChange={(event) => props.search?.onQuery(event.target.value)}
                aria-describedby="history-search-scope"
              />
            </label>
            <span className="hint-line" id="history-search-scope" data-testid="search-scope">
              {props.search.busy
                ? "Searching stored events…"
                : props.search.error
                  ? `Search failed: ${props.search.error}`
                  : props.search.query.trim().length === 0
                    ? "Matches this project's stored text."
                    : `${props.search.hits.length} match${props.search.hits.length === 1 ? "" : "es"} in stored text.`}
              {" Local read only; nothing is sent to the engine."}
            </span>
            {props.search.query.trim().length > 0 ? (
              <Button size="sm" variant="ghost" onClick={props.search.onClear}>
                Clear search
              </Button>
            ) : null}
            {props.search.hits.length > 0 ? (
              <ul className="history-search__results" aria-label="Search results">
                {props.search.hits.slice(0, 8).map((hit) => (
                  <li key={`${hit.threadId}:${hit.seq}`}>
                    <button
                      type="button"
                      className="history-search__hit"
                      onClick={() => props.search?.onJump(hit)}
                    >
                      <span className="history-search__snippet">{hit.snippet}</span>
                      <span className="hint-line">
                        {hit.kind} · {new Date(hit.timestamp).toLocaleTimeString()}
                        {hit.itemId ? "" : " · frame without item identity"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <div className="timeline__toolbar" data-testid="studio-history-toolbar">
          <label className="timeline__thread">
            <span className="hint-line">Conversation</span>
            <select
              value={history?.threadId ?? ""}
              disabled={!history?.onSelectThread || detail.threads.length < 2}
              onChange={(event) => props.history?.onSelectThread?.(event.target.value || null)}
              data-testid="studio-thread-select"
            >
              <option value="">All threads</option>
              {detail.threads.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {threadLabel(thread, studio?.threadId ?? detail.currentThreadId)}
                </option>
              ))}
            </select>
          </label>
          <span className="hint-line" data-testid="studio-history-scope">
            {entries.length} shown · {scope} stored
            {history?.hasMore ? " · older pages available" : " · earliest stored event loaded"}
            {/* R11: when the console windows a long conversation, say how many
                cards are actually painted. Every loaded card is still reachable
                by scrolling; this reports the bound, not a loss. */}
            {timelineWindow.virtualized ? ` · ${timelineWindow.rendered} painted` : ""}
          </span>
          <span className="timeline__toolbar-actions">
            {history?.hasMore ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={loadOlder}
                disabled={history.loading}
                data-testid="studio-load-earlier"
              >
                {history.loading ? "Loading earlier…" : "Load earlier events"}
              </Button>
            ) : null}
            {!atLatest ? (
              <Button
                size="sm"
                variant="primary"
                onClick={jumpToLatest}
                data-testid="studio-jump-latest"
                title="Return to the newest stored event. New events are counted while you read older ones."
              >
                {unread > 0
                  ? `Jump to latest · ${unread} new event${unread === 1 ? "" : "s"}`
                  : "Jump to latest"}
              </Button>
            ) : unread > 0 ? (
              <span className="hint-line" data-testid="studio-unread">
                {unread} new event{unread === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
        </div>
        {history?.error ? (
          <Callout tone="attention" title="History could not be read">
            {history.error} — the events already shown remain, and nothing was invented to fill the
            gap.
          </Callout>
        ) : null}
        <section
          className="studio__timeline"
          aria-label="Agent console"
          tabIndex={0}
          data-testid="studio-timeline"
          data-history-loads={history?.olderLoads ?? 0}
          ref={timelineRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
            followRef.current = atBottom;
            setAtLatest(atBottom);
          }}
        >
          {entries.length === 0 ? (
            <EmptyState
              headingLevel={2}
              icon={<ClockIcon size={26} />}
              title="No engine history stored yet"
              description="Mona stores thread, turn, and event projections only when the engine reports them. Nothing is simulated here."
            />
          ) : (
            <>
              {internalActivity > 0 || unprojected.length > 0 ? (
                <div className="timeline__more">
                  <span className="hint-line" data-testid="studio-activity">
                    {internalActivity} engine activity event
                    {internalActivity === 1 ? "" : "s"} stored
                    {unprojected.length > 0
                      ? ` · unprojected kinds: ${unprojected.join(", ")}`
                      : ""}
                  </span>
                </div>
              ) : null}
              <ol
                className="timeline"
                data-windowed={timelineWindow.virtualized ? "true" : "false"}
                data-rendered={timelineWindow.rendered}
                data-cards={entries.length}
              >
                {timelineWindow.top > 0 ? (
                  <li
                    className="timeline__spacer"
                    aria-hidden="true"
                    style={{ height: `${timelineWindow.top}px` }}
                    data-testid="timeline-spacer-top"
                  />
                ) : null}
                {entries.slice(timelineWindow.start, timelineWindow.end).map((entry) => (
                  <TimelineCard
                    key={entry.key}
                    entry={entry}
                    truncated={
                      entry.itemId
                        ? (history?.truncatedItems[`${entry.threadId}:${entry.itemId}`] ?? null)
                        : null
                    }
                    handlers={cardHandlers}
                    anchored={
                      searchAnchor !== null &&
                      (searchAnchor.itemId !== null
                        ? entry.itemId === searchAnchor.itemId
                        : entry.seq === searchAnchor.seq)
                    }
                  />
                ))}
                {timelineWindow.bottom > 0 ? (
                  <li
                    className="timeline__spacer"
                    aria-hidden="true"
                    style={{ height: `${timelineWindow.bottom}px` }}
                    data-testid="timeline-spacer-bottom"
                  />
                ) : null}
              </ol>
            </>
          )}
        </section>

        {/* The console above is the wide surface. The composer and the
            task/requirements/context inspector share the row beneath it, so a
            long turn has room to breathe instead of being squeezed into a
            narrow column beside the inspector. */}
        <div className="studio__work">
          <section className="studio__main" aria-label="Task prompt">
            {/* R10: the composer is resizable in every layout, not only the
                immersive one. The grip is a real separator — pointer drag,
                Arrow keys, Home and End — and reports its bounds, so it is
                reachable without a mouse. */}
            {
              <div
                className="composer-grip"
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the prompt composer"
                aria-valuemin={composerLimits.min}
                aria-valuemax={composerLimits.max}
                aria-valuenow={composerHeight ?? composerLimits.min}
                tabIndex={0}
                data-testid="composer-grip"
                onPointerDown={(event) => {
                  gripRef.current = {
                    y: event.clientY,
                    height: composerRef.current?.offsetHeight || 96,
                  };
                  setComposerHeight(clampComposer(gripRef.current.height));
                  try {
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                  } catch {
                    // A host without pointer capture still resizes; the pointer
                    // simply leaves this element mid-drag.
                  }
                  event.preventDefault();
                }}
                onPointerMove={(event) => {
                  const grip = gripRef.current;
                  if (!grip) return;
                  setComposerHeight(clampComposer(grip.height - (event.clientY - grip.y)));
                }}
                onPointerUp={(event) => {
                  gripRef.current = null;
                  try {
                    event.currentTarget.releasePointerCapture?.(event.pointerId);
                  } catch {
                    // Nothing was captured.
                  }
                }}
                onPointerCancel={() => {
                  gripRef.current = null;
                }}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 64 : 24;
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    resizeComposer(step);
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    resizeComposer(-step);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    setComposerHeight(clampComposer(composerLimits.min));
                  } else if (event.key === "End") {
                    event.preventDefault();
                    setComposerHeight(clampComposer(composerLimits.max));
                  }
                }}
              >
                <span className="composer-grip__bar" aria-hidden="true" />
              </div>
            }
            <div className="composer">
              <div className="composer__mode">
                <SegmentedControl
                  label="Execution mode"
                  value={props.mode}
                  options={[
                    { value: "plan", label: "Plan" },
                    { value: "work", label: "Work" },
                  ]}
                  onChange={(value) => props.onMode(value === "plan" ? "plan" : "work")}
                />
                <span className="hint-line">
                  {props.mode === "plan"
                    ? "Plan asks before shell or write actions; it cannot widen to Full Access."
                    : profile
                      ? `Work uses the saved Full Access profile: ${profile.provider} / ${profile.model}.`
                      : "Work uses the saved Full Access profile."}
                </span>
              </div>
              <div className="favorites" aria-label="Prompt favorites">
                <span className="favorites__label">Favorites</span>
                {props.favorites.length === 0 ? (
                  <span className="hint-line">
                    None saved yet. A favorite is inert local text until you insert it.
                  </span>
                ) : (
                  props.favorites.map((favorite) => (
                    <span className="favorite-chip" key={favorite.id}>
                      <button
                        type="button"
                        className="favorite-chip__insert"
                        onClick={() => props.onUseFavorite(favorite)}
                        title={favorite.text.slice(0, 240)}
                      >
                        {favorite.label}
                      </button>
                      <button
                        type="button"
                        className="favorite-chip__remove"
                        aria-label={`Remove favorite ${favorite.label}`}
                        onClick={() => props.onRemoveFavorite(favorite.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={props.onRequestSaveFavorite}
                  disabled={props.draft.trim().length === 0}
                  title={
                    props.draft.trim().length === 0
                      ? "Write a prompt first; Mona saves exactly what is in the composer"
                      : "Save the composer text as a reusable favorite"
                  }
                >
                  Save prompt…
                </Button>
              </div>
              <div className="composer__input" ref={composerBoxRef}>
                {/* R11 — the composer carries no `role="combobox"`. ARIA in HTML
                    permits only `textbox` on a `<textarea>`, so the combobox role
                    made the element invalid (axe: aria-allowed-role). The
                    autocomplete relationship is carried instead by attributes the
                    textbox role does support: the kind of popup it opens, the list
                    it controls, and the active option. `aria-expanded` is also a
                    combobox-only attribute, so the open state is carried by the
                    listbox existing in the document and by `aria-activedescendant`
                    naming its highlighted option — which is what a screen reader
                    announces on each arrow press. */}
                <TextArea
                  ref={composerRef}
                  label="Task prompt"
                  hint="Enter adds a line break. ⌘Enter sends. Type / at line start for Codewhale commands."
                  placeholder="Describe one concrete outcome, its boundaries, and how to verify it…"
                  rows={3}
                  style={composerHeight === null ? undefined : { height: `${composerHeight}px` }}
                  value={props.draft}
                  aria-haspopup="listbox"
                  aria-autocomplete="list"
                  aria-controls={commandListOpen ? "composer-command-menu" : undefined}
                  aria-activedescendant={
                    commandListOpen
                      ? `composer-command-option-${Math.min(commandIndex, commandMatches.length - 1)}`
                      : undefined
                  }
                  onChange={(event) => {
                    props.onDraft(event.target.value);
                    trackCaret(event.target);
                  }}
                  onSelect={(event) => trackCaret(event.currentTarget)}
                  onClick={(event) => trackCaret(event.currentTarget)}
                  onMouseUp={(event) => trackCaret(event.currentTarget)}
                  onKeyUp={(event) => trackCaret(event.currentTarget)}
                  onCompositionStart={() => setComposing(true)}
                  onCompositionEnd={(event) => {
                    setComposing(false);
                    trackCaret(event.currentTarget);
                  }}
                  onKeyDown={(event) => {
                    const native = event.nativeEvent;
                    if (native.isComposing || composing) return;
                    if (commandMenuOpen) {
                      if (
                        (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.altKey
                      ) {
                        // With no rows the caret keeps its normal behaviour;
                        // swallowing the key would strand the user.
                        if (commandMatches.length > 0) {
                          event.preventDefault();
                          const delta = event.key === "ArrowDown" ? 1 : -1;
                          setCommandIndex(
                            (index) =>
                              (index + delta + commandMatches.length) % commandMatches.length,
                          );
                          return;
                        }
                      }
                      if (
                        event.key === "Tab" &&
                        !event.shiftKey &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !event.altKey
                      ) {
                        const entry = commandMatches[commandIndex]?.entry;
                        if (entry) {
                          event.preventDefault();
                          acceptEntry(entry);
                          return;
                        }
                      }
                      if (event.key === "Escape") {
                        // The list closes first; Escape never interrupts work or
                        // leaves Focus Mode while a suggestion is open.
                        event.preventDefault();
                        event.stopPropagation();
                        setDismissedCommand(commandKey);
                        return;
                      }
                    }
                    if (
                      event.key !== "Enter" ||
                      !event.metaKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.ctrlKey ||
                      native.isComposing
                    )
                      return;
                    event.preventDefault();
                    if (!event.repeat && (commandLine || !sendBlocked)) props.onSubmit();
                  }}
                />
                {props.commandCatalog && commandMenuOpen ? (
                  <CommandMenu
                    catalog={props.commandCatalog}
                    query={commandQuery}
                    matches={commandMatches}
                    selected={Math.min(commandIndex, Math.max(0, commandMatches.length - 1))}
                    onHover={setCommandIndex}
                    onAccept={acceptEntry}
                    engine={studio?.connection.engine ?? null}
                    placement={menuBox.placement}
                    maxHeight={menuBox.maxHeight}
                    compact={menuBox.maxHeight < 240}
                  />
                ) : null}
              </div>
              <div className="composer__actions">
                <div className="composer__left">
                  <span className="hint-line" aria-live="polite">
                    {props.draftStatus === "saving"
                      ? "Saving draft…"
                      : props.draftStatus === "saved"
                        ? "Draft saved locally"
                        : props.draftStatus === "error"
                          ? "Draft could not be saved"
                          : "Draft is local to this project"}
                    {sendReason && sendBlocked ? ` · ${sendReason}` : ""}
                  </span>
                </div>
                <div className="composer__right">
                  {props.onMentionFile ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={props.onMentionFile}
                      title="Insert a workspace file's text into the composer as an explicit, reviewable block. Sizes and an estimated token cost are shown before you insert it."
                      data-testid="mention-file"
                    >
                      Mention file…
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    title="Binary attachments are unavailable in the pinned adapter: it accepts text context, not file uploads. Mona will not fabricate one."
                    data-testid="attach-file"
                  >
                    Attach binary
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      props.followUpBusy === true ||
                      props.draft.trim().length === 0 ||
                      viewingArchivedThread
                    }
                    title={
                      viewingArchivedThread
                        ? "This is an archived conversation; a follow-up must target the current one"
                        : props.draft.trim().length === 0
                          ? "Write the follow-up first"
                          : "Queue this text for after the current turn. It is stored, not sent; main dispatches it at the next turn boundary."
                    }
                    onClick={() => props.onQueueFollowUp?.(props.draft, props.mode)}
                    data-testid="queue-follow-up"
                  >
                    Queue after turn
                  </Button>
                  <Button
                    variant="primary"
                    icon={<PlayIcon size={15} />}
                    disabled={sendDisabled}
                    title={sendTitle}
                    onClick={props.onSubmit}
                    data-testid="studio-send"
                  >
                    Send to engine
                  </Button>
                </div>
              </div>
            </div>
            <FollowUpQueue
              items={followUps}
              busy={props.followUpBusy === true}
              steering={studio?.steering}
              turnActive={studio?.activeTurnId != null}
              onEdit={props.onEditFollowUp}
              onCancel={props.onCancelFollowUp}
              onDispatch={props.onDispatchFollowUps}
            />
          </section>

          {props.focusMode ? null : (
            <aside className="studio__inspector" aria-label="Inspector">
              <Tabs
                label="Inspector sections"
                value={props.inspectorTab}
                onChange={props.onInspectorTab}
                tabs={[
                  { id: "task", label: "Task" },
                  { id: "requirements", label: "Requirements" },
                  { id: "context", label: "Context" },
                ]}
              />
              <TabPanel id="task" active={props.inspectorTab === "task"}>
                {currentTask ? (
                  <Inspector
                    title="Current task"
                    actions={<StatusBadge status={currentTask.status as WorkStatus} />}
                    label="Current task"
                  >
                    <p className="inspector__task-title">{currentTask.title}</p>
                    <dl className="detail-list">
                      <div className="detail-row">
                        <dt>Task</dt>
                        <dd className="mono">{currentTask.id}</dd>
                      </div>
                      <div className="detail-row">
                        <dt>Updated</dt>
                        <dd>{relativeTime(currentTask.updatedAt)}</dd>
                      </div>
                      <div className="detail-row">
                        <dt>Depends on</dt>
                        <dd>
                          {currentTask.dependsOn.length === 0
                            ? "Nothing"
                            : currentTask.dependsOn.join(", ")}
                        </dd>
                      </div>
                    </dl>
                    <div className="inspector__actions">
                      <Button size="sm" variant="secondary" onClick={props.onShowBoard}>
                        Open work board
                      </Button>
                    </div>
                  </Inspector>
                ) : (
                  <EmptyState
                    headingLevel={2}
                    icon={<ClockIcon size={24} />}
                    title="No tasks yet"
                    description="Tasks are created explicitly. Mona does not infer a task or a percentage from project activity."
                  />
                )}
              </TabPanel>
              <TabPanel id="requirements" active={props.inspectorTab === "requirements"}>
                {detail.evidence.length === 0 ? (
                  <EmptyState
                    headingLevel={2}
                    icon={<InfoIcon size={24} />}
                    title="No requirement evidence"
                    description="Evidence appears here when a task records it. Completion is never inferred from a checked box."
                  />
                ) : (
                  <ul className="requirement-list">
                    {detail.evidence.map((entry) => (
                      <li className="requirement-row" key={`${entry.requirementId}-${entry.path}`}>
                        <span className="requirement-row__id mono">{entry.requirementId}</span>
                        <span className="requirement-row__title mono">{entry.path}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </TabPanel>
              <TabPanel id="context" active={props.inspectorTab === "context"}>
                <Card title="Context" eyebrow="Real local state">
                  <dl className="detail-list">
                    <div className="detail-row">
                      <dt>Connection</dt>
                      <dd>
                        {studio
                          ? `${studio.connection.state}: ${studio.connection.reason}`
                          : "The studio has not started in this launch"}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt>Submission</dt>
                      <dd>
                        {studio?.submission
                          ? `${studio.submission.status} · ${studio.submission.reconciled ? "reconciled" : "not reconciled"}`
                          : "No submission recorded"}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt>Repository</dt>
                      <dd>
                        {detail.project.repositoryKind === "none"
                          ? "Plain folder"
                          : detail.project.repositoryKind}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt>Threads</dt>
                      <dd>{detail.threads.length}</dd>
                    </div>
                    <div className="detail-row">
                      <dt>Events</dt>
                      <dd>
                        {(history?.events.length ?? detail.history.pageSize) + " loaded of "}
                        {detail.history.storedTotal} stored
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt>Runtime</dt>
                      <dd>{engine.blockedReason ?? "Bound to this workspace"}</dd>
                    </div>
                    <div className="detail-row">
                      <dt>Binding</dt>
                      <dd className="mono wrap">
                        {engine.binding
                          ? `${engine.binding.executable} · ${engine.binding.state}`
                          : "No runtime binding"}
                      </dd>
                    </div>
                    <div className="detail-row">
                      <dt>Tokens</dt>
                      <dd>
                        {formatTokens(usage.inputTokens)} input · {formatTokens(usage.outputTokens)}{" "}
                        output
                      </dd>
                    </div>
                  </dl>
                </Card>
                {studio && studio.diagnostics.length > 0 ? (
                  <details className="diagnostics">
                    <summary>Diagnostics ({studio.diagnostics.length})</summary>
                    <ul>
                      {studio.diagnostics.map((entry) => (
                        <li key={entry}>{entry}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </TabPanel>
            </aside>
          )}
        </div>
      </div>

      <div className="control-strip" role="region" aria-label="Execution controls">
        <div className="control-strip__status">
          <span
            className={statusDotClass(health.tone, studio?.connection.state === "running")}
            aria-hidden="true"
          />
          <span>
            {studio?.activeTurnId
              ? `Turn active · ${studio.activeTurnId}`
              : connectionState === "connected"
                ? "Runtime connected · no active turn"
                : `Studio ${connectionState.replace("_", " ")}`}
            {studio?.pauseAfterTask ? " · paused after this task" : ""}
            {studio && studio.queued > 0 ? ` · ${studio.queued} queued` : ""}
            {blockedTasks.length > 0
              ? ` · ${blockedTasks.length} blocked task${blockedTasks.length === 1 ? "" : "s"}`
              : ""}
          </span>
        </div>
        <div className="control-strip__actions">
          {studio?.pauseAfterTask ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<PlayIcon size={14} />}
              onClick={props.onResumeQueue}
            >
              Resume queue
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon={<PauseIcon size={14} />}
              disabled={!studio?.controls.canPause}
              title={
                studio?.controls.canPause
                  ? "Finish the active task, then start nothing new"
                  : "Pause is a queue boundary; start the engine first"
              }
              onClick={props.onPause}
            >
              Pause after task
            </Button>
          )}
          <Button
            size="sm"
            variant="danger"
            icon={<StopIcon size={14} />}
            disabled={!studio?.controls.canInterrupt || props.studioBusy}
            title={
              studio?.controls.canInterrupt
                ? "Ask the engine to interrupt the active turn; the receipt is shown"
                : "No active turn to interrupt"
            }
            onClick={props.onInterrupt}
          >
            Interrupt now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!studio?.controls.canCancelQueued}
            title={
              studio?.controls.canCancelQueued
                ? "Remove future starts; the active turn is untouched"
                : "The queue is empty in P08; prompt queueing arrives with the work board"
            }
            onClick={props.onCancelQueued}
          >
            Cancel queued
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!studio?.controls.canStop || props.studioBusy}
            title={
              studio?.controls.canStop
                ? "Interrupt any active turn, then stop the owned process tree"
                : "No owned runtime is running"
            }
            onClick={props.onStop}
          >
            Stop engine
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<WarningIcon size={14} />}
            onClick={props.onShowBoard}
          >
            Blockers
          </Button>
        </div>
      </div>
    </div>
  );
}
