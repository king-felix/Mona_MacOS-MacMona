import type { BudgetScope, TokenSemantics } from "../../shared/contracts/cost";

/**
 * Exact cost arithmetic. Money is stored as integer pico-USD so fixture sums do
 * not drift: 1 USD = 1e12 pico. A price expressed in USD per million tokens
 * converts exactly to pico per token for rates with at most six decimals.
 */
export const PICO_PER_USD = 1_000_000_000_000;

export function usdToPico(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`a cost must be a finite nonnegative number, received ${usd}`);
  }
  return Math.round(usd * PICO_PER_USD);
}

export function picoToUsd(pico: number): number {
  return pico / PICO_PER_USD;
}

/** USD per million tokens → pico-USD per token. 0.28 → 280,000 pico. */
export function ratePerMillionToPicoPerToken(ratePerMillion: number): number {
  if (!Number.isFinite(ratePerMillion) || ratePerMillion < 0) {
    throw new RangeError(`a rate must be a finite nonnegative number, received ${ratePerMillion}`);
  }
  return Math.round(ratePerMillion * 1_000_000);
}

export function picoPerTokenToRatePerMillion(picoPerToken: number): number {
  return picoPerToken / 1_000_000;
}

export interface UsageBuckets {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheMissTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
}

export interface RateComponents {
  cacheHitPico: number | null;
  cacheMissPico: number | null;
  outputPico: number | null;
  toolCallPico: number | null;
  /** True when reasoning tokens are already part of the output bucket. */
  reasoningInOutput: boolean;
}

export type EstimateOutcome =
  | {
      ok: true;
      pico: number;
      missTokens: number;
      hitTokens: number;
      billedOutputTokens: number;
      /** Set when the reported buckets required an assumption worth showing. */
      note: string | null;
    }
  | { ok: false; reason: string };

/**
 * Estimate one turn from disjoint buckets. The turn record's `input_tokens` is
 * inclusive (cache hits are inside it); a `/v1/usage` bucket's input is already
 * cache-miss only. Reasoning is added to output only when the rate card says
 * the provider bills it separately.
 */
export function estimateCostPico(
  buckets: UsageBuckets,
  rate: RateComponents,
  semantics: TokenSemantics,
): EstimateOutcome {
  const cached = buckets.cachedTokens;
  const input = buckets.inputTokens;
  let hitTokens: number;
  let missTokens: number;
  let note: string | null = null;

  if (semantics === "exclusive_input") {
    hitTokens = cached ?? 0;
    if (input === null) return { ok: false, reason: "missing_input_tokens" };
    missTokens = input;
  } else if (semantics === "inclusive_input") {
    hitTokens = cached ?? 0;
    if (input === null) {
      if (buckets.cacheMissTokens === null) {
        return { ok: false, reason: "missing_input_tokens" };
      }
      missTokens = buckets.cacheMissTokens;
    } else if (buckets.cacheMissTokens !== null) {
      missTokens = buckets.cacheMissTokens;
      const inclusive = missTokens + hitTokens;
      if (inclusive !== input) {
        note = `cache buckets disagree with the inclusive input total (${inclusive} vs ${input}); the explicit miss count was used`;
      }
    } else {
      missTokens = input - hitTokens;
      if (missTokens < 0) {
        return { ok: false, reason: "cache_buckets_conflict" };
      }
    }
  } else {
    return { ok: false, reason: "unknown_token_semantics" };
  }

  if (buckets.outputTokens === null) return { ok: false, reason: "missing_output_tokens" };
  const billedOutputTokens =
    buckets.outputTokens + (rate.reasoningInOutput ? 0 : (buckets.reasoningTokens ?? 0));

  if (missTokens > 0 && rate.cacheMissPico === null) {
    return { ok: false, reason: "missing_cache_miss_rate" };
  }
  if (hitTokens > 0 && rate.cacheHitPico === null) {
    return { ok: false, reason: "missing_cache_hit_rate" };
  }
  if (billedOutputTokens > 0 && rate.outputPico === null) {
    return { ok: false, reason: "missing_output_rate" };
  }

  const pico =
    missTokens * (rate.cacheMissPico ?? 0) +
    hitTokens * (rate.cacheHitPico ?? 0) +
    billedOutputTokens * (rate.outputPico ?? 0);

  return { ok: true, pico, missTokens, hitTokens, billedOutputTokens, note };
}

// --------------------------------------------------------------- civil days

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function defaultTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

interface CivilParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function civilParts(ms: number, timeZone: string): CivilParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

/** Offset of the zone from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = civilParts(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - (ms - (ms % 1000));
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  let utc = guess - zoneOffsetMs(guess, timeZone);
  // Re-resolve at the candidate instant: a DST transition can move midnight.
  const refined = guess - zoneOffsetMs(utc, timeZone);
  if (refined !== utc) utc = refined;
  return utc;
}

export interface CivilDayRange {
  /** Local civil date, `YYYY-MM-DD`. */
  day: string;
  startIso: string;
  endIso: string;
}

/**
 * The local civil day containing `atIso`, as a half-open UTC instant range.
 * Handles 23- and 25-hour days at DST transitions.
 */
export function civilDayRange(atIso: string, timeZone: string): CivilDayRange {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) throw new RangeError(`invalid timestamp: ${atIso}`);
  const parts = civilParts(at, timeZone);
  const start = zonedMidnightUtc(parts.year, parts.month, parts.day, timeZone);
  const next = civilParts(start + 36 * 60 * 60 * 1000, timeZone);
  const end = zonedMidnightUtc(next.year, next.month, next.day, timeZone);
  const day = `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
  return { day, startIso: new Date(start).toISOString(), endIso: new Date(end).toISOString() };
}

export function civilDateKey(atIso: string, timeZone: string): string {
  return civilDayRange(atIso, timeZone).day;
}

export function budgetWindow(input: {
  scope: BudgetScope;
  atIso: string;
  timeZone: string;
  projectSince: string;
  sessionSince: string | null;
}): { startIso: string; endIso: string } {
  if (input.scope === "day") {
    const range = civilDayRange(input.atIso, input.timeZone);
    return { startIso: range.startIso, endIso: range.endIso };
  }
  const startIso =
    input.scope === "session" ? (input.sessionSince ?? input.atIso) : input.projectSince;
  return { startIso, endIso: input.atIso };
}

/** Plain-dollar formatting for stored contracts; the UI may add its own labels. */
export function formatUsd(pico: number, decimals = 2): string {
  return `$${picoToUsd(pico).toFixed(decimals)}`;
}
