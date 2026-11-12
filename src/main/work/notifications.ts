import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import type {
  NotificationDelivery,
  NotificationReceiptView,
  PolishFocusTarget,
  PolishPreferences,
  QuietHours,
} from "../../shared/contracts/polish";
import type { StateStore } from "../state/store";

export const NOTIFICATION_STATE_SCOPE = "polish:notifications";
const MAX_KEYS = 500;
const MAX_RECENT = 20;

export type NotificationKind = "completion" | "blocker" | "limit";

/** One thing that might deserve an alert, derived from stored state. */
export interface NotificationCandidate {
  key: string;
  kind: NotificationKind;
  projectId: ProjectId;
  projectName: string;
  at: string;
  taskId: TaskId | null;
  problemId: string | null;
  changeSetId: string | null;
  /** Detailed title. Only used when the user turns on detailed notifications. */
  title: string;
  /** Detailed body. May contain a task title or help text; never sent by default. */
  body: string;
  focus: PolishFocusTarget;
}

/** Preloaded inputs, so one refresh does not re-read the board four times. */
export interface NotificationSnapshot {
  tasks: Array<{ id: TaskId; title: string; completedAt: string | null }>;
  problems: Array<{
    id: string;
    taskId: TaskId | null;
    title: string;
    requirement: string;
    helpNeeded: string;
    blockedAt: string | null;
  }>;
  budgets: Array<{ id: string; level: "ok" | "warn" | "stop"; message: string; at: string | null }>;
}

export interface NotificationSources {
  tasks(
    projectId: ProjectId,
  ): Promise<Array<{ id: TaskId; title: string; completedAt: string | null }>>;
  problems(projectId: ProjectId): Promise<
    Array<{
      id: string;
      taskId: TaskId | null;
      title: string;
      requirement: string;
      helpNeeded: string;
      blockedAt: string | null;
    }>
  >;
  budgets(
    projectId: ProjectId,
  ): Promise<
    Array<{ id: string; level: "ok" | "warn" | "stop"; message: string; at: string | null }>
  >;
}

export interface NotificationHost {
  available(): boolean;
  note(): string;
  /**
   * Resolves with what the system reported. A handover without confirmation is
   * `handed_over`, never `shown`; the caller records exactly that.
   */
  deliver(input: {
    title: string;
    body: string;
    focus: PolishFocusTarget;
  }): Promise<Exclude<NotificationDelivery, "suppressed">>;
}

interface StoredNotificationState {
  seeded: boolean;
  cursor: string;
  delivered: string[];
  suppressed: string[];
  recent: NotificationReceiptView[];
}

export interface NotificationPlan {
  deliver: boolean;
  /** Set when delivery was suppressed; never a silent drop without a reason. */
  reason: string | null;
  title: string;
  body: string;
}

function parseClock(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Wall-clock minutes in a stated IANA zone. Using `Intl` (not the host offset)
 * is what makes a quiet window follow the user's zone across travel and DST,
 * and what makes the test suite deterministic on any machine.
 */
export function localMinutes(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? Number.NaN);
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? Number.NaN);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return (hour % 24) * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * A quiet window is half-open: `start` is inside, `end` is not. An overnight
 * window (22:00–07:00) wraps midnight. Equal endpoints mean "no window" rather
 * than an accidental 24-hour silence.
 */
export function inQuietHours(at: Date, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const start = parseClock(quiet.start);
  const end = parseClock(quiet.end);
  const current = localMinutes(at, quiet.timeZone);
  if (start === null || end === null || current === null) return false;
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function categoryEnabled(kind: NotificationKind, prefs: PolishPreferences): boolean {
  return prefs.notifications[kind];
}

/**
 * Pure delivery decision. Default content is deliberately generic so a lock
 * screen never shows a prompt fragment, a file name, or a help request; the
 * detailed title is only used after an explicit preference change.
 */
export function planNotification(
  candidate: NotificationCandidate,
  preferences: PolishPreferences,
  at: Date,
): NotificationPlan {
  const notifications = preferences.notifications;
  if (!notifications.enabled) {
    return { deliver: false, reason: "notifications are turned off", title: "", body: "" };
  }
  if (!categoryEnabled(candidate.kind, preferences)) {
    return {
      deliver: false,
      reason: `${candidate.kind} notifications are turned off`,
      title: "",
      body: "",
    };
  }
  if (inQuietHours(at, notifications.quietHours)) {
    return {
      deliver: false,
      reason: `quiet hours (${notifications.quietHours.start}–${notifications.quietHours.end} ${notifications.quietHours.timeZone})`,
      title: "",
      body: "",
    };
  }
  const generic =
    candidate.kind === "completion"
      ? "Mona · work finished"
      : candidate.kind === "blocker"
        ? "Mona · work needs you"
        : "Mona · a cost limit was reached";
  if (!notifications.showDetails) {
    return {
      deliver: true,
      reason: null,
      title: generic,
      body: "Open Mona to review the project record. Detailed content is hidden on the lock screen.",
    };
  }
  return {
    deliver: true,
    reason: null,
    title: `Mona · ${candidate.projectName}`,
    body: `${candidate.title}${candidate.body ? ` — ${candidate.body}` : ""}`,
  };
}

/**
 * Derives candidates from stored state. There is no event subscription to lose
 * across a reconnect: every refresh re-reads the same records, and the
 * persisted key set decides what has already been announced.
 */
export async function collectCandidates(
  projectId: ProjectId,
  projectName: string,
  sources: NotificationSources,
  since: string | null,
  preloaded?: Partial<NotificationSnapshot>,
): Promise<NotificationCandidate[]> {
  const [tasks, problems, budgets] = await Promise.all([
    preloaded?.tasks ?? sources.tasks(projectId).catch(() => []),
    preloaded?.problems ?? sources.problems(projectId).catch(() => []),
    preloaded?.budgets ?? sources.budgets(projectId).catch(() => []),
  ]);
  const candidates: NotificationCandidate[] = [];
  const newer = (at: string | null): boolean => {
    if (!since || !at) return since === null;
    const value = Date.parse(at);
    const mark = Date.parse(since);
    if (Number.isNaN(value) || Number.isNaN(mark)) return false;
    return value > mark;
  };
  for (const task of tasks) {
    if (!task.completedAt) continue;
    candidates.push({
      key: `task-completed:${task.id}:${task.completedAt}`,
      kind: "completion",
      projectId,
      projectName,
      at: task.completedAt,
      taskId: task.id,
      problemId: null,
      changeSetId: null,
      title: `“${task.title}” is verified`,
      body: "Completion is backed by recorded acceptance evidence.",
      focus: {
        projectId,
        screen: "board",
        taskId: task.id,
        problemId: null,
        changeSetId: null,
        fromNotification: true,
      },
    });
  }
  for (const problem of problems) {
    if (!problem.blockedAt) continue;
    candidates.push({
      key: `problem-blocked:${problem.id}:${problem.blockedAt ?? "current"}`,
      kind: "blocker",
      projectId,
      projectName,
      at: problem.blockedAt,
      taskId: problem.taskId,
      problemId: problem.id,
      changeSetId: null,
      title: `${problem.requirement} needs a decision`,
      body: problem.helpNeeded,
      focus: {
        projectId,
        screen: "board",
        taskId: problem.taskId,
        problemId: problem.id,
        changeSetId: null,
        fromNotification: true,
      },
    });
  }
  for (const budget of budgets) {
    if (budget.level === "ok" || !budget.at) continue;
    candidates.push({
      key: `budget:${budget.id}:${budget.level}:${budget.at ?? "window"}`,
      kind: "limit",
      projectId,
      projectName,
      at: budget.at,
      taskId: null,
      problemId: null,
      changeSetId: null,
      title: budget.message,
      body: "A local budget threshold was reached; in-flight spend may still complete.",
      focus: {
        projectId,
        screen: "cost",
        taskId: null,
        problemId: null,
        changeSetId: null,
        fromNotification: true,
      },
    });
  }
  // Limit alerts are deduplicated by window and level instead of by cursor: a
  // threshold already crossed when Mona opens is still worth one alert.
  return candidates.filter((candidate) => candidate.kind === "limit" || newer(candidate.at));
}

export interface PolishNotifierOptions {
  store: StateStore;
  sources: NotificationSources;
  host: NotificationHost;
  preferences: () => Promise<PolishPreferences>;
  projectName?: (projectId: ProjectId) => Promise<string>;
  now?: () => Date;
}

/**
 * Completion, blocker, and limit alerts only. Each candidate is announced once,
 * keyed in durable state, so a reconnect or a relaunch cannot repeat it. Quiet
 * hours suppress delivery — never computation — and the suppression is recorded
 * rather than queued for later.
 */
export class PolishNotifier {
  private readonly store: StateStore;
  private readonly sources: NotificationSources;
  private readonly host: NotificationHost;
  private readonly preferences: () => Promise<PolishPreferences>;
  private readonly projectName: (projectId: ProjectId) => Promise<string>;
  private readonly now: () => Date;
  /** Cursor kept in memory so a quiet refresh does not churn settings history. */
  private memoryCursor: string | null = null;
  /**
   * One refresh at a time per project. Main and the renderer both observe the
   * same terminal push, and two interleaved refreshes could each read the key
   * set before either wrote it — announcing the same completion twice.
   */
  private readonly inflight = new Map<string, Promise<NotificationReceiptView[]>>();

  constructor(options: PolishNotifierOptions) {
    this.store = options.store;
    this.sources = options.sources;
    this.host = options.host;
    this.preferences = options.preferences;
    this.projectName = options.projectName ?? (async () => "project");
    this.now = options.now ?? (() => new Date());
  }

  private async load(): Promise<StoredNotificationState> {
    const stored = await this.store.getSettings(NOTIFICATION_STATE_SCOPE).catch(() => null);
    const value = stored?.value as Partial<StoredNotificationState> | undefined;
    if (!value || typeof value !== "object") {
      const seeded: StoredNotificationState = {
        seeded: false,
        cursor: this.now().toISOString(),
        delivered: [],
        suppressed: [],
        recent: [],
      };
      await this.save(seeded);
      return seeded;
    }
    return {
      seeded: value.seeded === true,
      cursor: typeof value.cursor === "string" ? value.cursor : this.now().toISOString(),
      delivered: Array.isArray(value.delivered)
        ? value.delivered.filter((key): key is string => typeof key === "string").slice(-MAX_KEYS)
        : [],
      suppressed: Array.isArray(value.suppressed)
        ? value.suppressed.filter((key): key is string => typeof key === "string").slice(-MAX_KEYS)
        : [],
      recent: Array.isArray(value.recent)
        ? value.recent.filter(
            (entry): entry is NotificationReceiptView =>
              Boolean(entry) &&
              typeof entry === "object" &&
              typeof (entry as { key?: unknown }).key === "string",
          )
        : [],
    };
  }

  private async save(state: StoredNotificationState): Promise<void> {
    await this.store.putSettings(NOTIFICATION_STATE_SCOPE, {
      ...state,
      delivered: state.delivered.slice(-MAX_KEYS),
      suppressed: state.suppressed.slice(-MAX_KEYS),
      recent: state.recent.slice(-MAX_RECENT),
    });
  }

  recent(): Promise<NotificationReceiptView[]> {
    return this.load().then((state) => state.recent.slice(-MAX_RECENT));
  }

  availability(): { available: boolean; note: string } {
    return { available: this.host.available(), note: this.host.note() };
  }

  /**
   * Re-derive every candidate from stored state and announce the unseen ones.
   * The first call on a fresh store seeds the cursor instead of replaying the
   * entire project history as a burst of alerts.
   */
  refresh(
    projectId: ProjectId,
    preloaded?: Partial<NotificationSnapshot>,
  ): Promise<NotificationReceiptView[]> {
    const previous = this.inflight.get(projectId) ?? Promise.resolve([]);
    const next = previous.catch(() => []).then(() => this.refreshOnce(projectId, preloaded));
    this.inflight.set(projectId, next);
    void next.finally(() => {
      if (this.inflight.get(projectId) === next) this.inflight.delete(projectId);
    });
    return next;
  }

  private async refreshOnce(
    projectId: ProjectId,
    preloaded?: Partial<NotificationSnapshot>,
  ): Promise<NotificationReceiptView[]> {
    const state = await this.load();
    const now = this.now();
    if (!state.seeded) {
      state.seeded = true;
      state.cursor = now.toISOString();
      this.memoryCursor = state.cursor;
      await this.save(state);
      return [];
    }
    if (this.memoryCursor) state.cursor = this.memoryCursor;
    const preferences = await this.preferences();
    const projectName = await this.projectName(projectId);
    const candidates = await collectCandidates(
      projectId,
      projectName,
      this.sources,
      state.cursor,
      preloaded,
    );
    const known = new Set([...state.delivered, ...state.suppressed]);
    const receipts: NotificationReceiptView[] = [];
    for (const candidate of [...candidates].sort(
      (left, right) => Date.parse(left.at) - Date.parse(right.at),
    )) {
      if (known.has(candidate.key)) continue;
      known.add(candidate.key);
      const at = this.now();
      const plan = planNotification(candidate, preferences, at);
      if (!plan.deliver) {
        state.suppressed.push(candidate.key);
        receipts.push({
          key: candidate.key,
          kind: candidate.kind,
          projectId,
          delivered: false,
          delivery: "suppressed",
          suppressedReason: plan.reason,
          title: "",
          body: "",
          at: at.toISOString(),
        });
        continue;
      }
      if (!this.host.available()) {
        state.suppressed.push(candidate.key);
        receipts.push({
          key: candidate.key,
          kind: candidate.kind,
          projectId,
          delivered: false,
          delivery: "suppressed",
          suppressedReason: this.host.note(),
          title: plan.title,
          body: plan.body,
          at: at.toISOString(),
        });
        continue;
      }
      // Only a confirmed `shown` counts as delivered. A handover the system did
      // not confirm is recorded as exactly that, and a refusal is a failure with
      // the reason, never a silent success.
      let outcome: NotificationDelivery = "failed";
      try {
        const answer = await this.host.deliver({
          title: plan.title,
          body: plan.body,
          focus: candidate.focus,
        });
        outcome = answer;
      } catch {
        outcome = "failed";
      }
      const delivered = outcome === "shown";
      // Any receipt means the alert will not be announced again; the key set is
      // what prevents a duplicate, independent of whether macOS showed it.
      state.delivered.push(candidate.key);
      const receipt: NotificationReceiptView = {
        key: candidate.key,
        kind: candidate.kind,
        projectId,
        delivered,
        delivery: outcome,
        suppressedReason:
          outcome === "shown"
            ? null
            : outcome === "handed_over"
              ? "handed to macOS without a display confirmation"
              : "the system did not accept the notification",
        title: plan.title,
        body: plan.body,
        at: at.toISOString(),
      };
      receipts.push(receipt);
      state.recent.push(receipt);
    }
    state.recent = state.recent.slice(-MAX_RECENT);
    this.memoryCursor = now.toISOString();
    if (receipts.length > 0) {
      state.cursor = this.memoryCursor;
      await this.save(state);
    }
    return receipts;
  }

  /** Deliver one explicit test alert so the user can verify system delivery. */
  async test(): Promise<NotificationReceiptView> {
    const at = this.now();
    if (!this.host.available()) {
      return {
        key: `test:${at.toISOString()}`,
        kind: "completion",
        projectId: "prj_notificationtest" as ProjectId,
        delivered: false,
        delivery: "suppressed",
        suppressedReason: this.host.note(),
        title: "",
        body: "",
        at: at.toISOString(),
      };
    }
    const preferences = await this.preferences();
    const plan = planNotification(
      {
        key: `test:${at.toISOString()}`,
        kind: "completion",
        projectId: "prj_notificationtest" as ProjectId,
        projectName: "Mona",
        at: at.toISOString(),
        taskId: null,
        problemId: null,
        changeSetId: null,
        title: "Test notification",
        body: "System delivery check requested from Settings.",
        focus: {
          projectId: "prj_notificationtest" as ProjectId,
          screen: "settings",
          taskId: null,
          problemId: null,
          changeSetId: null,
          fromNotification: true,
        },
      },
      preferences,
      at,
    );
    if (!plan.deliver) {
      return {
        key: `test:${at.toISOString()}`,
        kind: "completion",
        projectId: "prj_notificationtest" as ProjectId,
        delivered: false,
        delivery: "suppressed",
        suppressedReason: plan.reason,
        title: "",
        body: "",
        at: at.toISOString(),
      };
    }
    let outcome: NotificationDelivery = "failed";
    try {
      outcome = await this.host.deliver({
        title: plan.title.includes("finished") ? "Mona · notification test" : plan.title,
        body: plan.body,
        focus: {
          projectId: "prj_notificationtest" as ProjectId,
          screen: "settings",
          taskId: null,
          problemId: null,
          changeSetId: null,
          fromNotification: true,
        },
      });
    } catch {
      outcome = "failed";
    }
    const receipt: NotificationReceiptView = {
      key: `test:${at.toISOString()}`,
      kind: "completion",
      projectId: "prj_notificationtest" as ProjectId,
      delivered: outcome === "shown",
      delivery: outcome,
      suppressedReason:
        outcome === "shown"
          ? null
          : outcome === "handed_over"
            ? "handed to macOS without a display confirmation"
            : "the system did not accept the notification",
      title: "Mona · notification test",
      body: plan.body,
      at: at.toISOString(),
    };
    const state = await this.load();
    state.recent.push(receipt);
    state.recent = state.recent.slice(-MAX_RECENT);
    await this.save(state);
    return receipt;
  }
}
