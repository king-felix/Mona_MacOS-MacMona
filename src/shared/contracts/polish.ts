import { z } from "zod";
import type { TaskId } from "./ids";
import type { TaskState } from "./board";

/**
 * Daily-use polish contracts: the deterministic Resume Brief, "Since you left",
 * attention state, notification preferences, project identity, and prompt
 * favorites. Nothing in this surface can call a model; every field is derived
 * from stored tasks, events, receipts, or an explicit local preference.
 */

export const POLISH_ACCENTS = ["violet", "mint", "coral", "amber", "indigo"] as const;
export type PolishAccent = (typeof POLISH_ACCENTS)[number];

export const POLISH_SCREENS = ["home", "studio", "board", "changes", "cost", "settings"] as const;
export type PolishScreen = (typeof POLISH_SCREENS)[number];

const Clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected a 24-hour HH:MM clock time");

export const QuietHoursSchema = z.strictObject({
  enabled: z.boolean(),
  /** Local wall-clock start, inclusive. */
  start: Clock,
  /** Local wall-clock end, exclusive. */
  end: Clock,
  /** IANA time zone; quiet hours follow the user's stated zone, not the host guess. */
  timeZone: z.string().min(1).max(64),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const NotificationPreferencesSchema = z.strictObject({
  enabled: z.boolean(),
  completion: z.boolean(),
  blocker: z.boolean(),
  limit: z.boolean(),
  /**
   * False by default: notification bodies stay generic so a lock screen never
   * shows a prompt fragment or a file name.
   */
  showDetails: z.boolean(),
  quietHours: QuietHoursSchema,
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const PolishPreferencesSchema = z.strictObject({
  notifications: NotificationPreferencesSchema,
  dockBadge: z.boolean(),
  menuBarStatus: z.boolean(),
  /** Optional and off by default; enabled only by an explicit user choice. */
  keepAwakeDuringWork: z.boolean(),
  /** Off until the user asks for it. Mona never enrolls the app silently. */
  launchAtLogin: z.boolean(),
});
export type PolishPreferences = z.infer<typeof PolishPreferencesSchema>;

const DefaultTimeZone = "UTC";

/** A conservative default: notifications on, details off, quiet hours unused. */
export function defaultPolishPreferences(timeZone = DefaultTimeZone): PolishPreferences {
  return {
    notifications: {
      enabled: true,
      completion: true,
      blocker: true,
      limit: true,
      showDetails: false,
      quietHours: { enabled: false, start: "22:00", end: "07:00", timeZone },
    },
    dockBadge: true,
    menuBarStatus: true,
    keepAwakeDuringWork: false,
    launchAtLogin: false,
  };
}

export const PolishPreferencesPatchSchema = z.strictObject({
  notifications: NotificationPreferencesSchema.partial().optional(),
  dockBadge: z.boolean().optional(),
  menuBarStatus: z.boolean().optional(),
  keepAwakeDuringWork: z.boolean().optional(),
  launchAtLogin: z.boolean().optional(),
});
export type PolishPreferencesPatch = z.infer<typeof PolishPreferencesPatchSchema>;

/** Prompt favorites are inert local text until the user inserts one. */
export const PromptFavoriteSchema = z.strictObject({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(80),
  text: z.string().min(1).max(20_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PromptFavorite = z.infer<typeof PromptFavoriteSchema>;

export const FavoriteInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  text: z.string().min(1).max(20_000),
});
export type FavoriteInput = z.infer<typeof FavoriteInputSchema>;

/** Where a notification or brief entry sends the user. */
export interface PolishFocusTarget {
  projectId: string;
  screen: PolishScreen;
  taskId: TaskId | null;
  problemId: string | null;
  changeSetId: string | null;
  /** True when the target came from a notification click. */
  fromNotification: boolean;
}

export type BriefTone = "neutral" | "success" | "attention" | "danger";

export interface BriefFact {
  label: string;
  value: string;
  tone: BriefTone;
}

export interface ResumeBlockerView {
  problemId: string;
  taskId: TaskId | null;
  taskTitle: string | null;
  requirement: string;
  helpNeeded: string;
  totalAttempts: number;
  noProgressAttempts: number;
  evidence: string[];
  blockedAt: string | null;
}

export interface ResumeTestResultView {
  /** True only when a stored check criterion or an observed test command exists. */
  available: boolean;
  /** Machine-checkable criteria on the focused task (or project when none). */
  satisfiedChecks: number;
  totalChecks: number;
  label: string;
  lastEvidencePath: string | null;
  lastAt: string | null;
  /** A command the engine recorded; its outcome is the tool status, not a guess. */
  observedCommand: { command: string; status: string; at: string } | null;
  note: string;
}

export interface ResumeChangeSummaryView {
  available: boolean;
  countedFiles: number;
  turns: number;
  /** Dirty Git paths no recorded turn names; never presented as agent-authored. */
  unreceiptedPaths: number;
  truncated: boolean;
  label: string;
  note: string;
}

export interface ResumeSpendView {
  observed: boolean;
  knownUsd: number;
  complete: boolean;
  label: string;
  reportedTurns: number;
  estimatedTurns: number;
  unknownTurns: number;
  missingTurns: number;
}

export interface ResumeCurrentTaskView {
  id: TaskId;
  title: string;
  status: TaskState;
  /** The exact stored prompt text; previewed, never injected into UI chrome. */
  prompt: string;
  nextStep: string | null;
}

export interface ResumeBriefView {
  projectId: string;
  projectName: string;
  generatedAt: string;
  source: {
    lastSeenAt: string | null;
    eventsConsidered: number;
    tasksConsidered: number;
    changeSetsConsidered: number;
  };
  currentTask: ResumeCurrentTaskView | null;
  lastVerifiedStep: string | null;
  unresolvedBlocker: ResumeBlockerView | null;
  blockers: ResumeBlockerView[];
  testResult: ResumeTestResultView;
  changes: ResumeChangeSummaryView;
  spend: ResumeSpendView;
  nextStep: string;
  facts: BriefFact[];
  /** Structural proof that the brief never fabricates progress. */
  noCompletionPercentage: true;
}

export type DigestGroupId = "completion" | "blocker" | "test" | "change" | "session" | "attention";

export interface DigestEntryView {
  /** Stable identity: event thread:seq, problem id, or change-set id. */
  key: string;
  group: DigestGroupId;
  title: string;
  detail: string | null;
  at: string;
  taskId: TaskId | null;
  turnId: string | null;
  changeSetId: string | null;
  problemId: string | null;
  evidencePath: string | null;
  screen: PolishScreen;
}

export interface DigestGroupView {
  id: DigestGroupId;
  title: string;
  entries: DigestEntryView[];
}

export interface SinceYouLeftView {
  projectId: string;
  /** The stored watermark this digest was computed from; null on first visit. */
  since: string | null;
  generatedAt: string;
  groups: DigestGroupView[];
  entryCount: number;
  /** Duplicate (thread, seq) rows ignored, so replay cannot inflate the digest. */
  duplicatesSuppressed: number;
  note: string;
}

export interface PolishDigestView {
  resume: ResumeBriefView;
  sinceYouLeft: SinceYouLeftView;
}

export interface AttentionView {
  badge: string | null;
  menuTitle: string;
  tooltip: string;
  running: boolean;
  blocked: number;
  unseenCompletions: number;
  /** True when the menu-bar item and Dock badge are actually installed. */
  installed: boolean;
  updatedAt: string;
  note: string;
}

/**
 * What the system actually reported. `shown` means macOS confirmed display;
 * `handed_over` means the request was accepted with no confirmation; `failed`
 * means the system refused it. Only `shown` may be described as delivered.
 */
export type NotificationDelivery = "shown" | "handed_over" | "failed" | "suppressed";

export interface NotificationReceiptView {
  key: string;
  kind: "completion" | "blocker" | "limit";
  projectId: string;
  /** True only for `shown`; a handover is not a delivery. */
  delivered: boolean;
  delivery: NotificationDelivery;
  suppressedReason: string | null;
  title: string;
  body: string;
  at: string;
}

export interface PolishStatusView {
  preferences: PolishPreferences;
  attention: AttentionView;
  keepAwake: { active: boolean; scopedToActiveWork: boolean; note: string };
  launchAtLogin: { enabled: boolean; applied: boolean; note: string };
  menuBar: { installed: boolean; note: string };
  notifications: { available: boolean; note: string; recent: NotificationReceiptView[] };
}

export interface ProjectIdentityInput {
  accent: PolishAccent | null;
  monogram: string | null;
}
