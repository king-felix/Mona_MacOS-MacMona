import type { ProjectId } from "../../shared/contracts/ids";
import type {
  AttentionView,
  NotificationReceiptView,
  PolishDigestView,
  PolishPreferences,
  PolishPreferencesPatch,
  PolishStatusView,
  ProjectIdentityInput,
  PromptFavorite,
  ResumeBriefView,
  SinceYouLeftView,
} from "../../shared/contracts/polish";
import type { ProjectSummary } from "../../shared/contracts/project-bridge";
import type { StateStore } from "../state/store";
import type { ProjectService } from "../projects/service";
import type { TaskBoard } from "./board";
import type { ChangeLedger } from "./changes";
import type { CostLedger } from "./costs";
import { KeepAwake, type AttentionController } from "./attention";
import { PolishDigest } from "./digest";
import { PolishNotifier } from "./notifications";
import { normalizeIdentity, type PolishPreferencesStore } from "./preferences";

export interface PolishServiceOptions {
  store: StateStore;
  board: TaskBoard;
  projects: ProjectService;
  changes?: ChangeLedger | null;
  cost?: CostLedger | null;
  notifier: PolishNotifier;
  attention: AttentionController;
  keepAwake: KeepAwake;
  preferences: PolishPreferencesStore;
  isTurnActive?: (projectId: ProjectId) => Promise<boolean>;
  now?: () => Date;
}

function seenScope(projectId: ProjectId): string {
  return `polish:seen:${projectId}`;
}

/**
 * The IPC-facing polish surface. Every method reads local state or an explicit
 * user preference; none can start an engine turn or spend inference.
 */
export class PolishService {
  private readonly store: StateStore;
  private readonly board: TaskBoard;
  private readonly projects: ProjectService;
  private readonly digest: PolishDigest;
  private readonly notifier: PolishNotifier;
  private readonly attention: AttentionController;
  private readonly keepAwake: KeepAwake;
  private readonly preferences: PolishPreferencesStore;
  private readonly isTurnActive?: (projectId: ProjectId) => Promise<boolean>;
  private readonly costLedger: CostLedger | null;
  private readonly now: () => Date;
  private lastAttention: AttentionView | null = null;
  /** Whether the last refresh observed active work; reported, not assumed. */
  private activeWorkObserved = false;
  private lastLaunch: PolishStatusView["launchAtLogin"] = {
    enabled: false,
    applied: false,
    note: "Launch at login has not been evaluated yet.",
  };

  constructor(options: PolishServiceOptions) {
    this.store = options.store;
    this.board = options.board;
    this.projects = options.projects;
    this.notifier = options.notifier;
    this.attention = options.attention;
    this.keepAwake = options.keepAwake;
    this.preferences = options.preferences;
    this.isTurnActive = options.isTurnActive;
    this.costLedger = options.cost ?? null;
    this.now = options.now ?? (() => new Date());
    this.digest = new PolishDigest({
      store: options.store,
      board: options.board,
      changes: options.changes ?? null,
      cost: options.cost ?? null,
      now: this.now,
    });
  }

  digestView(projectId: ProjectId): Promise<PolishDigestView> {
    return this.digest.digest(projectId);
  }

  resume(projectId: ProjectId): Promise<ResumeBriefView> {
    return this.digest.resume(projectId);
  }

  sinceYouLeft(projectId: ProjectId): Promise<SinceYouLeftView> {
    return this.digest.sinceYouLeft(projectId);
  }

  async markSeen(projectId: ProjectId): Promise<{ seenAt: string }> {
    const result = await this.digest.markSeen(projectId);
    // Recompute the real attention state; a read must not invent a zero for
    // blockers or budget limits that are still present.
    await this.refresh(projectId);
    return result;
  }

  preferencesView(): Promise<PolishPreferences> {
    return this.preferences.get();
  }

  async setPreferences(patch: PolishPreferencesPatch): Promise<PolishPreferences> {
    const updated = await this.preferences.update(patch);
    this.keepAwake.sync(this.lastAttention?.running ?? false, updated.keepAwakeDuringWork);
    const status = this.attention.sync(
      {
        running: this.lastAttention?.running ?? false,
        blocked: this.lastAttention?.blocked ?? 0,
        unseenCompletions: this.lastAttention?.unseenCompletions ?? 0,
        limits: 0,
      },
      updated,
    );
    this.lastAttention = status.view;
    this.lastLaunch = status.launchAtLogin;
    return updated;
  }

  favorites(): Promise<PromptFavorite[]> {
    return this.preferences.favorites();
  }

  saveFavorite(input: unknown): Promise<PromptFavorite> {
    return this.preferences.saveFavorite(input);
  }

  removeFavorite(id: string): Promise<{ removed: boolean }> {
    return this.preferences.removeFavorite(id);
  }

  async identity(
    projectId: ProjectId,
    input: ProjectIdentityInput,
    expectedRevision: number,
  ): Promise<ProjectSummary> {
    const normalized = normalizeIdentity(input);
    await this.store.setProjectIdentity(projectId, normalized, expectedRevision);
    return this.projects.summaryById(projectId);
  }

  async status(): Promise<PolishStatusView> {
    const preferences = await this.preferences.get();
    const attention =
      this.lastAttention ??
      this.attention.sync(
        { running: false, blocked: 0, unseenCompletions: 0, limits: 0 },
        preferences,
      ).view;
    this.lastAttention = attention;
    const availability = this.notifier.availability();
    const recent = await this.notifier.recent().catch(() => []);
    return {
      preferences,
      attention,
      keepAwake: {
        active: this.keepAwake.status().active,
        // True only when an assertion is actually held for observed active
        // work — never a constant.
        scopedToActiveWork: this.keepAwake.status().active && this.activeWorkObserved,
        note: preferences.keepAwakeDuringWork
          ? this.keepAwake.status().note
          : "keep-awake is turned off in Settings",
      },
      launchAtLogin: this.lastLaunch,
      menuBar: { installed: attention.installed, note: attention.note },
      notifications: {
        available: availability.available,
        note: availability.note,
        recent,
      },
    };
  }

  notifyTest(): Promise<NotificationReceiptView> {
    return this.notifier.test();
  }

  /**
   * Recompute attention, keep-awake scope, and unseen alerts for one project.
   * Called after a terminal turn, a task transition, or an explicit read — not
   * on every streamed token.
   */
  async refresh(projectId: ProjectId): Promise<PolishStatusView> {
    const preferences = await this.preferences.get();
    const [snapshot, cost] = await Promise.all([
      this.board.snapshot(projectId),
      this.costView(projectId),
    ]);
    const seen = await this.store.getSettings(seenScope(projectId)).catch(() => null);
    const seenAt =
      seen && typeof seen.value === "object" && seen.value !== null
        ? typeof (seen.value as { seenAt?: unknown }).seenAt === "string"
          ? (seen.value as { seenAt: string }).seenAt
          : null
        : null;
    const unseenCompletions =
      seenAt === null
        ? 0
        : snapshot.tasks.filter(
            (task) =>
              task.status === "completed" &&
              task.completedAt !== null &&
              Date.parse(task.completedAt) > Date.parse(seenAt),
          ).length;
    const limits = cost?.evaluations.filter((evaluation) => evaluation.level !== "ok").length ?? 0;
    let running = snapshot.tasks.some((task) => task.status === "running");
    if (!running && this.isTurnActive) {
      running = await this.isTurnActive(projectId).catch(() => false);
    }
    const status = this.attention.sync(
      {
        running,
        blocked: snapshot.handoff.blockedProblems.length,
        unseenCompletions,
        limits,
      },
      preferences,
    );
    this.lastAttention = status.view;
    this.lastLaunch = status.launchAtLogin;
    this.activeWorkObserved = running;
    this.keepAwake.sync(running, preferences.keepAwakeDuringWork);
    // Hand the notifier the snapshot this refresh already read, so one refresh
    // costs one board load rather than four.
    await this.notifier
      .refresh(projectId, {
        tasks: snapshot.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          completedAt: task.completedAt,
        })),
        problems: snapshot.problems
          .filter((problem) => problem.status === "blocked")
          .map((problem) => ({
            id: problem.id,
            taskId: problem.taskId,
            title: problem.symptom,
            requirement: problem.requirement,
            helpNeeded: problem.helpNeeded ?? "a human decision is required",
            blockedAt: problem.blockedAt,
          })),
        budgets:
          cost?.evaluations.map((evaluation) => ({
            id: evaluation.budgetId,
            level: evaluation.level,
            message: evaluation.message,
            at: evaluation.windowStart,
          })) ?? [],
      })
      .catch(() => []);
    return this.status();
  }

  private async costView(projectId: ProjectId) {
    return this.costLedger ? this.costLedger.ledger(projectId, {}).catch(() => null) : null;
  }
}
