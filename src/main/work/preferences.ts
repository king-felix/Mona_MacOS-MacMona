import { randomUUID } from "node:crypto";
import {
  FavoriteInputSchema,
  PolishPreferencesPatchSchema,
  PolishPreferencesSchema,
  PromptFavoriteSchema,
  defaultPolishPreferences,
  type PolishAccent,
  type PolishPreferences,
  type PolishPreferencesPatch,
  type ProjectIdentityInput,
  type PromptFavorite,
} from "../../shared/contracts/polish";
import { StateError } from "../state/errors";
import type { StateStore } from "../state/store";

export const PREFERENCES_SCOPE = "polish:preferences";
export const FAVORITES_SCOPE = "prompts:favorites";
export const MAX_FAVORITES = 50;

const ACCENTS: readonly string[] = ["violet", "mint", "coral", "amber", "indigo"];

function mergePreferences(stored: unknown, timeZone: string): PolishPreferences {
  const fallback = defaultPolishPreferences(timeZone);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return fallback;
  const raw = stored as Record<string, unknown>;
  const rawNotifications =
    raw.notifications && typeof raw.notifications === "object" && !Array.isArray(raw.notifications)
      ? (raw.notifications as Record<string, unknown>)
      : {};
  const rawQuiet =
    rawNotifications.quietHours &&
    typeof rawNotifications.quietHours === "object" &&
    !Array.isArray(rawNotifications.quietHours)
      ? (rawNotifications.quietHours as Record<string, unknown>)
      : {};
  const merged = {
    notifications: {
      ...fallback.notifications,
      ...rawNotifications,
      quietHours: { ...fallback.notifications.quietHours, ...rawQuiet },
    },
    dockBadge: typeof raw.dockBadge === "boolean" ? raw.dockBadge : fallback.dockBadge,
    menuBarStatus:
      typeof raw.menuBarStatus === "boolean" ? raw.menuBarStatus : fallback.menuBarStatus,
    keepAwakeDuringWork:
      typeof raw.keepAwakeDuringWork === "boolean"
        ? raw.keepAwakeDuringWork
        : fallback.keepAwakeDuringWork,
    launchAtLogin:
      typeof raw.launchAtLogin === "boolean" ? raw.launchAtLogin : fallback.launchAtLogin,
  };
  const parsed = PolishPreferencesSchema.safeParse(merged);
  return parsed.success ? parsed.data : fallback;
}

export interface PolishPreferencesOptions {
  store: StateStore;
  /** Used only for the default quiet-hours zone; never a host-timezone guess at delivery. */
  timeZone?: () => string;
  newId?: () => string;
  now?: () => Date;
}

/**
 * Local preferences and prompt favorites. Everything here is inert data: a
 * preference changes delivery or presentation, and a favorite is only text
 * until the user inserts it into the composer they control.
 */
export class PolishPreferencesStore {
  private readonly store: StateStore;
  private readonly timeZone: () => string;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(options: PolishPreferencesOptions) {
    this.store = options.store;
    this.timeZone = options.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.newId = options.newId ?? (() => `fav_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
    this.now = options.now ?? (() => new Date());
  }

  async get(): Promise<PolishPreferences> {
    const stored = await this.store.getSettings(PREFERENCES_SCOPE).catch(() => null);
    return mergePreferences(stored?.value ?? null, this.timeZone() || "UTC");
  }

  async update(patch: PolishPreferencesPatch): Promise<PolishPreferences> {
    const parsed = PolishPreferencesPatchSchema.parse(patch);
    const current = await this.get();
    const next: PolishPreferences = {
      ...current,
      ...(parsed.dockBadge === undefined ? {} : { dockBadge: parsed.dockBadge }),
      ...(parsed.menuBarStatus === undefined ? {} : { menuBarStatus: parsed.menuBarStatus }),
      ...(parsed.keepAwakeDuringWork === undefined
        ? {}
        : { keepAwakeDuringWork: parsed.keepAwakeDuringWork }),
      ...(parsed.launchAtLogin === undefined ? {} : { launchAtLogin: parsed.launchAtLogin }),
      notifications: {
        ...current.notifications,
        ...(parsed.notifications ?? {}),
        quietHours: {
          ...current.notifications.quietHours,
          ...(parsed.notifications?.quietHours ?? {}),
        },
      },
    };
    const validated = PolishPreferencesSchema.parse(next);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: validated.notifications.quietHours.timeZone });
    } catch {
      throw new StateError(
        "INVALID_INPUT",
        "quiet-hours time zone must be an IANA zone such as Europe/Berlin",
      );
    }
    await this.store.putSettings(PREFERENCES_SCOPE, validated);
    return validated;
  }

  async favorites(): Promise<PromptFavorite[]> {
    const stored = await this.store.getSettings(FAVORITES_SCOPE).catch(() => null);
    const value = stored?.value as { items?: unknown } | undefined;
    if (!value || !Array.isArray(value.items)) return [];
    return value.items.flatMap((item) => {
      const parsed = PromptFavoriteSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async saveFavorite(input: unknown): Promise<PromptFavorite> {
    const parsed = FavoriteInputSchema.parse(input);
    const items = await this.favorites();
    const existing = items.find((item) => item.text === parsed.text);
    const now = this.now().toISOString();
    if (existing) {
      const updated: PromptFavorite = {
        ...existing,
        label: parsed.label,
        updatedAt: now,
      };
      await this.writeFavorites(items.map((item) => (item.id === existing.id ? updated : item)));
      return updated;
    }
    if (items.length >= MAX_FAVORITES) {
      throw new StateError(
        "CONFLICT",
        `prompt favorites are limited to ${MAX_FAVORITES}; remove one before adding another`,
      );
    }
    const favorite: PromptFavorite = {
      id: this.newId(),
      label: parsed.label,
      text: parsed.text,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeFavorites([favorite, ...items]);
    return favorite;
  }

  async removeFavorite(id: string): Promise<{ removed: boolean }> {
    const items = await this.favorites();
    const next = items.filter((item) => item.id !== id);
    if (next.length === items.length) return { removed: false };
    await this.writeFavorites(next);
    return { removed: true };
  }

  private async writeFavorites(items: PromptFavorite[]): Promise<void> {
    const validated = items.map((item) => PromptFavoriteSchema.parse(item));
    await this.store.putSettings(FAVORITES_SCOPE, { items: validated });
  }
}

/**
 * A project identity is local presentation only. The accent must be one of the
 * measured palette names and the monogram one or two upper-case characters, so
 * a value from an imported plan cannot smuggle markup into the shell.
 */
export function normalizeIdentity(input: ProjectIdentityInput): ProjectIdentityInput {
  const accent = input.accent === null ? null : String(input.accent);
  if (accent !== null && !ACCENTS.includes(accent)) {
    throw new StateError("INVALID_INPUT", `accent must be one of ${ACCENTS.join(", ")}`);
  }
  const named = accent as PolishAccent | null;
  if (input.monogram === null) return { accent: named, monogram: null };
  const monogram = input.monogram.trim().toUpperCase();
  if (monogram.length === 0) return { accent: named, monogram: null };
  if (!/^[A-Z0-9]{1,2}$/.test(monogram)) {
    throw new StateError("INVALID_INPUT", "monogram must be one or two letters or digits");
  }
  return { accent: named, monogram };
}
