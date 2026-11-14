import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type {
  ProjectDetail,
  StoredEventSummary,
  ThreadSummary,
} from "../../shared/contracts/project-bridge";
import type { StudioMode, StudioSnapshot } from "../../shared/contracts/studio";
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
  ClockIcon,
  CostIcon,
  FolderIcon,
  InfoIcon,
  LockIcon,
  PauseIcon,
  PlayIcon,
  SparkIcon,
  StopIcon,
  TerminalIcon,
  WarningIcon,
} from "../design/icons";
import { engineBadge, formatTokens, projectAccent, projectMonogram, relativeTime } from "./visual";
import { Markdown } from "./markdown";
import { projectTimeline, type TimelineEntry } from "./timeline";

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
  inspectorTab: string;
  onInspectorTab: (tab: string) => void;
  focusMode: boolean;
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
}

const LONG_BODY = 4_000;

function threadLabel(thread: ThreadSummary, currentThreadId: string | null | undefined): string {
  const title = thread.title?.trim() || `Thread ${thread.id.slice(-8)}`;
  // "Current" is the thread this Studio is bound to; everything else is
  // archived conversation and is labelled as such instead of looking live.
  return `${title} · ${thread.id === currentThreadId ? "current" : "archived"}`;
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

function TimelineCard({
  entry,
  truncated,
  onLoadItem,
}: {
  entry: TimelineEntry;
  truncated?: { returned: number; stored: number } | null;
  onLoadItem?: (threadId: string, itemId: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const tooLong = entry.body.length > LONG_BODY;
  const body = tooLong && !expanded ? `${entry.body.slice(0, LONG_BODY)}\n…` : entry.body;
  return (
    <li className={`timeline-event timeline-event--${entry.kind}`}>
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
              <Markdown text={body} />
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
        {tooLong ? (
          <Button size="sm" variant="ghost" onClick={() => setExpanded(!expanded)}>
            {expanded ? "Collapse long output" : `Show full output (${entry.body.length} chars)`}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

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

export function StudioScreen(props: StudioProps): JSX.Element {
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const anchorRef = useRef<{ height: number; top: number; loads: number } | null>(null);
  const [atLatest, setAtLatest] = useState(true);

  const { detail, studio, history } = props;
  const events = history?.events ?? detail?.events ?? [];
  const historyComplete = history ? !history.hasMore : detail?.history.hasMore === false;

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
    anchorRef.current = null;
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [detail?.project.id, history?.threadId]);

  // Inserting an older page must not drag the reader down: hold the distance
  // from the bottom constant while content grows above the viewport. The
  // anchor is applied only when a completed older-page read changes the
  // load counter, so a live refresh cannot be mistaken for an older page.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const node = timelineRef.current;
    if (!anchor || !node) return;
    if ((history?.olderLoads ?? 0) === anchor.loads) return;
    const target = node.scrollHeight - anchor.height + anchor.top;
    anchorRef.current = null;
    node.scrollTop = target;
    // Written to the DOM rather than React state: counting this must not cause
    // another commit, and the smoke can assert that the anchor really applied.
    node.dataset.anchorApplications = String(Number(node.dataset.anchorApplications ?? 0) + 1);
  }, [events, history?.olderLoads]);

  const loadOlder = (): void => {
    const node = timelineRef.current;
    anchorRef.current = node
      ? { height: node.scrollHeight, top: node.scrollTop, loads: history?.olderLoads ?? 0 }
      : null;
    followRef.current = false;
    setAtLatest(false);
    props.history?.onLoadOlder?.();
  };

  const jumpToLatest = (): void => {
    followRef.current = true;
    setAtLatest(true);
    const node = timelineRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  };

  if (!detail) {
    return (
      <div className="screen">
        <Card>
          <EmptyState
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
  const { entries, internalActivity, unprojected } = projectTimeline(events, {
    historyComplete,
    completeItems: new Set(Object.keys(history?.completeItems ?? {})),
  });
  const scope = history?.storedTotal ?? detail.history.storedTotal;
  const blockedTasks = detail.tasks.filter((task) => task.status === "blocked");
  const currentTask =
    detail.tasks.find((task) => task.status === "running") ??
    detail.tasks.find((task) => task.status === "blocked") ??
    detail.tasks[0] ??
    null;
  const profile = studio?.profile ?? null;
  const effective = profile?.effective ?? null;
  const sendBlocked =
    props.draft.trim().length === 0 || props.studioBusy || (studio !== null && !studio.canSubmit);
  const sendReason =
    studio?.cannotSubmitReason ??
    (studio === null ? "Mona starts the engine when you submit an explicit task." : null);
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
        </div>
        <div className="context-bar__facts">
          <span className="fact">
            <BranchIcon size={14} />
            <span className="fact__label">Branch</span>
            <span className="fact__value">{detail.branch ?? "Not a Git repository"}</span>
          </span>
          <span className="fact" data-testid="studio-connection">
            <span
              className={`status-dot ${
                health.tone === "success"
                  ? "status-dot--success"
                  : health.tone === "danger"
                    ? "status-dot--danger"
                    : "status-dot--attention"
              }`}
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

      {connectionState === "failed" ? (
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

      {studio?.pendingInput ? (
        <Callout tone="attention" title="The engine is waiting for input Mona cannot answer">
          {studio.pendingInput}
        </Callout>
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

      <div className="studio">
        {/* Paging controls stay outside the scrolling console, so Jump to
            latest is reachable without scrolling and Load earlier is never
            hidden by the very history it loads. */}
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
              >
                Jump to latest
              </Button>
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
              <ol className="timeline">
                {entries.map((entry) => (
                  <TimelineCard
                    key={entry.key}
                    entry={entry}
                    truncated={
                      entry.itemId
                        ? (history?.truncatedItems[`${entry.threadId}:${entry.itemId}`] ?? null)
                        : null
                    }
                    onLoadItem={history?.onLoadItem}
                  />
                ))}
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
              <TextArea
                label="Task prompt"
                hint="Enter adds a line break. ⌘Enter sends. Saved locally for this project and thread."
                placeholder="Describe one concrete outcome, its boundaries, and how to verify it…"
                rows={3}
                value={props.draft}
                onChange={(event) => props.onDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    !event.metaKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.ctrlKey ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  event.preventDefault();
                  if (!event.repeat && !sendBlocked) props.onSubmit();
                }}
              />
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
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    title="The pinned adapter does not support attachments; Mona will not fabricate one"
                  >
                    Attach file
                  </Button>
                  <Button
                    variant="primary"
                    icon={<PlayIcon size={15} />}
                    disabled={sendBlocked}
                    title={
                      sendBlocked ? (sendReason ?? "A turn is already active") : "Submit this task"
                    }
                    onClick={props.onSubmit}
                    data-testid="studio-send"
                  >
                    Send to engine
                  </Button>
                </div>
              </div>
            </div>
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
                    icon={<ClockIcon size={24} />}
                    title="No tasks yet"
                    description="Tasks are created explicitly. Mona does not infer a task or a percentage from project activity."
                  />
                )}
              </TabPanel>
              <TabPanel id="requirements" active={props.inspectorTab === "requirements"}>
                {detail.evidence.length === 0 ? (
                  <EmptyState
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
            className={`status-dot ${
              health.tone === "success"
                ? "status-dot--success"
                : health.tone === "danger"
                  ? "status-dot--danger"
                  : "status-dot--attention"
            }`}
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
