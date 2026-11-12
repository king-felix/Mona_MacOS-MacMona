/**
 * Local command-palette ranking. No inference, no network, no engine call: the
 * palette is a deterministic index over records the renderer already holds.
 *
 * Ranking is deliberately boring and inspectable: exact label, label prefix,
 * word-start, label substring, keyword substring, subsequence, hint substring.
 * Ties break by kind (screens and actions before capability rows) and then by
 * the order the caller supplied. A capability row never outranks a real action
 * with the same words — a terminal route is a fallback, not a shortcut.
 */

export type PaletteKind = "screen" | "action" | "project" | "prompt" | "setting" | "capability";

export const PALETTE_KINDS: PaletteKind[] = [
  "screen",
  "action",
  "project",
  "prompt",
  "setting",
  "capability",
];

const KIND_WEIGHT: Record<PaletteKind, number> = {
  screen: 60,
  action: 60,
  project: 50,
  prompt: 40,
  setting: 30,
  capability: 20,
};

export interface PaletteDetail {
  classification?: "read" | "write" | "destructive";
  cost?: string;
  effect?: string;
  route?: string;
  status?: string;
  note?: string;
}

export interface PaletteEntry {
  id: string;
  kind: PaletteKind;
  label: string;
  hint: string;
  keywords?: string[];
  detail?: PaletteDetail;
  /** For capability rows: where the entry point goes. */
  entryKind?: "screen" | "settings_tab" | "terminal" | "palette" | "none";
  entryTarget?: string | null;
  /** False when the entry point must not be offered (gap or unavailable). */
  openable?: boolean;
}

export interface PaletteMatch<T extends PaletteEntry = PaletteEntry> {
  entry: T;
  score: number;
  matchedOn: "label" | "keyword" | "hint" | "none";
}

function wordStartMatch(label: string, needle: string): boolean {
  const lower = label.toLowerCase();
  let index = lower.indexOf(needle);
  while (index !== -1) {
    if (index === 0 || /[\s·:/(\-]/.test(lower[index - 1] ?? "")) return true;
    index = lower.indexOf(needle, index + 1);
  }
  return false;
}

function subsequence(haystack: string, needle: string): boolean {
  let cursor = 0;
  for (const char of haystack) {
    if (char === needle[cursor]) cursor += 1;
    if (cursor === needle.length) return true;
  }
  return needle.length === 0;
}

export function scoreEntry<T extends PaletteEntry>(
  entry: T,
  rawNeedle: string,
): PaletteMatch<T> | null {
  const needle = rawNeedle.trim().toLowerCase();
  if (needle.length === 0) return { entry, score: 0, matchedOn: "none" };
  const label = entry.label.toLowerCase();
  if (label === needle) return { entry, score: 1000, matchedOn: "label" };
  if (label.startsWith(needle)) return { entry, score: 800, matchedOn: "label" };
  if (wordStartMatch(label, needle)) return { entry, score: 650, matchedOn: "label" };
  if (label.includes(needle)) return { entry, score: 450, matchedOn: "label" };
  const keyword = (entry.keywords ?? []).some((value) => value.toLowerCase().includes(needle));
  if (keyword) return { entry, score: 320, matchedOn: "keyword" };
  if (subsequence(label, needle)) return { entry, score: 160, matchedOn: "label" };
  if (entry.hint.toLowerCase().includes(needle)) {
    return { entry, score: 90, matchedOn: "hint" };
  }
  return null;
}

export function rankPalette<T extends PaletteEntry>(
  entries: T[],
  query: string,
  limit = 14,
): { matches: T[]; total: number; truncated: boolean } {
  const scored: PaletteMatch<T>[] = [];
  const needle = query.trim();
  for (const entry of entries) {
    const match = scoreEntry(entry, needle);
    if (match) scored.push(match);
  }
  const order = new Map(entries.map((entry, index) => [entry.id, index]));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const kindDelta = KIND_WEIGHT[b.entry.kind] - KIND_WEIGHT[a.entry.kind];
    if (kindDelta !== 0) return kindDelta;
    return (order.get(a.entry.id) ?? 0) - (order.get(b.entry.id) ?? 0);
  });
  const visible = scored.slice(0, limit);
  return {
    matches: visible.map((match) => match.entry),
    total: scored.length,
    truncated: scored.length > visible.length,
  };
}
