import type { CommandCatalogEntry, CommandCatalogSnapshot } from "../../shared/contracts/commands";

/**
 * R03 — pure composer command parsing.
 *
 * The composer must never misread ordinary text as a command. A token is only
 * considered at the start of a line, outside a fenced code block, unescaped,
 * and without a second slash (which makes it a path). Submission is stricter
 * still: only an exact canonical name or alias resolves to a command.
 */

export type LiteralReason = "path" | "fenced-code" | "outside-line-start";

export interface CommandToken {
  /** Index of the leading slash. */
  start: number;
  /** Index just after the command word (before arguments). */
  end: number;
  /** Text after the slash, excluding arguments. */
  name: string;
  /** The full command line, for diagnostics. */
  line: string;
}

export interface TokenProbe {
  token: CommandToken | null;
  literal: LiteralReason | null;
}

/** True when the line containing `index` is inside a ```` ``` ````/`~~~` fence. */
export function insideFence(text: string, index: number): boolean {
  const before = text.slice(0, index).split("\n");
  // The line containing the index is the last entry; only earlier lines count.
  before.pop();
  let open: "```" | "~~~" | null = null;
  for (const line of before) {
    const trimmed = line.trimStart();
    if (open === null) {
      if (trimmed.startsWith("```")) open = "```";
      else if (trimmed.startsWith("~~~")) open = "~~~";
    } else if (trimmed.startsWith(open)) {
      open = null;
    }
  }
  return open !== null;
}

/**
 * Find the slash token at the caret. `selectionStart !== selectionEnd` is not a
 * command context: the menu closes rather than discarding the user's selection.
 */
export function probeCommandToken(
  text: string,
  caret: number,
  selectionStart = caret,
  selectionEnd = caret,
): TokenProbe {
  if (selectionStart !== selectionEnd) return { token: null, literal: null };
  const position = Math.max(0, Math.min(caret, text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const newline = text.indexOf("\n", lineStart);
  const lineEnd = newline === -1 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);
  const indent = line.length - line.trimStart().length;
  const slash = lineStart + indent;
  if (text[slash] !== "/") return { token: null, literal: null };
  if (position < slash || position > lineEnd) return { token: null, literal: null };

  const rest = text.slice(slash + 1, lineEnd);
  const word = /^[^\s]*/.exec(rest)?.[0] ?? "";
  const end = slash + 1 + word.length;
  if (position < slash || position > end) return { token: null, literal: null };

  if (word.includes("/")) {
    return { token: null, literal: "path" };
  }
  if (insideFence(text, slash)) {
    return { token: null, literal: "fenced-code" };
  }
  if (indent > 0) {
    // An indented line is prose or code, not a command line.
    return { token: null, literal: "outside-line-start" };
  }
  return {
    token: { start: slash, end, name: word, line },
    literal: null,
  };
}

export interface CommandMatch {
  entry: CommandCatalogEntry;
  /** Why it matched, used for a stable visible ranking. */
  reason: "name" | "alias" | "summary";
  /** The alias that matched, when the canonical name did not. */
  alias: string | null;
}

const DISCOVERY_RANK: Record<CommandCatalogEntry["discovery"], number> = {
  primary: 0,
  advanced: 1,
  compatibility: 2,
};

function startsWithNameOrAlias(entry: CommandCatalogEntry, query: string): boolean {
  if (entry.name.toLowerCase().startsWith(query)) return true;
  return entry.aliases.some((alias) => alias.toLowerCase().startsWith(query));
}

/**
 * Deterministic filtering and ranking. An empty query follows the engine's
 * own empty-discovery flag; a filter can find every command, including the one
 * hidden row, so nothing silently disappears.
 */
export function rankCommands(snapshot: CommandCatalogSnapshot, query: string): CommandMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: Array<CommandMatch & { score: number }> = [];
  for (const entry of snapshot.commands) {
    if (needle.length === 0) {
      if (entry.hidden || !entry.showInEmptyDiscovery) continue;
      matches.push({ entry, reason: "name", alias: null, score: 0 });
      continue;
    }
    const name = entry.name.toLowerCase();
    const exactAlias =
      entry.aliases.find((candidate) => candidate.toLowerCase() === needle) ?? null;
    const prefixAlias =
      exactAlias ??
      entry.aliases.find((candidate) => candidate.toLowerCase().startsWith(needle)) ??
      null;
    let score: number | null = null;
    let reason: CommandMatch["reason"] = "name";
    let matchedAlias: string | null = null;
    if (name === needle) score = 0;
    else if (exactAlias) {
      score = 1;
      reason = "alias";
      matchedAlias = exactAlias;
    } else if (name.startsWith(needle)) score = 2;
    else if (prefixAlias) {
      score = 3;
      reason = "alias";
      matchedAlias = prefixAlias;
    } else if (name.includes(needle)) score = 4;
    else if (entry.summary.toLowerCase().includes(needle)) {
      score = 5;
      reason = "summary";
    }
    // The one hidden command is discoverable by typing its name or alias, and
    // never appears in the unfiltered list.
    if (score === null) continue;
    if (entry.hidden && !startsWithNameOrAlias(entry, needle)) continue;
    matches.push({ entry, reason, alias: matchedAlias, score });
  }
  matches.sort((left, right) => {
    if (left.score !== right.score) return left.score - right.score;
    const discovery = DISCOVERY_RANK[left.entry.discovery] - DISCOVERY_RANK[right.entry.discovery];
    if (discovery !== 0) return discovery;
    if (left.entry.name.length !== right.entry.name.length) {
      return left.entry.name.length - right.entry.name.length;
    }
    return left.entry.name < right.entry.name ? -1 : left.entry.name > right.entry.name ? 1 : 0;
  });
  return matches.map(({ entry, reason, alias }) => ({ entry, reason, alias }));
}

/** Accept a suggestion: replace exactly the token, keep the surrounding text. */
export function acceptCommand(
  text: string,
  token: CommandToken,
  entry: CommandCatalogEntry,
): { text: string; caret: number } {
  const replacement = `/${entry.name}${entry.composerWantsTrailingSpace ? " " : ""}`;
  return {
    text: `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`,
    caret: token.start + replacement.length,
  };
}

/**
 * Fail closed when the catalog could not be loaded: a single-line slash token
 * that is not obviously a path may be a command, so it must not silently become
 * a model prompt. A leading space, backslash, newline, or a second slash marks
 * text the user can still send.
 */
export function couldBeCommandText(text: string): boolean {
  const trimmed = text.replace(/\s+$/, "");
  return (
    trimmed.length > 1 &&
    trimmed.startsWith("/") &&
    !trimmed.includes("\n") &&
    !trimmed.slice(1).includes("/")
  );
}

export type CommandIntent =
  | { kind: "prompt" }
  | { kind: "command"; entry: CommandCatalogEntry; args: string }
  | {
      kind: "incomplete";
      entry: CommandCatalogEntry;
      args: string;
      reason: "required-argument";
    }
  | { kind: "ambiguous"; query: string; matches: CommandMatch[] };

/**
 * Spellings whose name or alias *starts with* the query. Only these make a
 * line ambiguous: a substring or summary hit (query `the` matching 33
 * descriptions) is a suggestion, never a reason to refuse the user's prose.
 */
export function prefixMatches(snapshot: CommandCatalogSnapshot, query: string): CommandMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return snapshot.commands
    .filter((entry) =>
      [entry.name, ...entry.aliases].some((spelling) => spelling.toLowerCase().startsWith(needle)),
    )
    .map((entry) => {
      const alias = entry.aliases.find((candidate) => candidate.toLowerCase().startsWith(needle));
      return {
        entry,
        reason: entry.name.toLowerCase().startsWith(needle)
          ? ("name" as const)
          : ("alias" as const),
        alias: entry.name.toLowerCase().startsWith(needle) ? null : (alias ?? null),
      };
    });
}

/**
 * Decide what ⌘Enter or the Send button means. Only an exact spelling becomes a
 * command. A *bare* prefix of a real command name or alias (`/he`) is reported
 * as ambiguous; a prefix followed by words (`/the release is broken`) is prose
 * and is sent, because a suggestion is not a classification. Everything else —
 * paths, unknown slash text, description-only matches, multiline text — stays
 * ordinary prompt text.
 */
export function classifyComposerText(
  text: string,
  snapshot: CommandCatalogSnapshot,
): CommandIntent {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return { kind: "prompt" };
  const probe = probeCommandToken(trimmed, 1, 1, 1);
  if (!probe.token) return { kind: "prompt" };
  const query = probe.token.name;
  if (query.length === 0) return { kind: "prompt" };
  const needle = query.toLowerCase();
  const entry = snapshot.commands.find((candidate) =>
    [candidate.name, ...candidate.aliases].some((spelling) => spelling.toLowerCase() === needle),
  );
  if (entry) {
    const args = trimmed.slice(probe.token.end).trim();
    if (entry.requiresRequiredArgument && args.length === 0) {
      return { kind: "incomplete", entry, args, reason: "required-argument" };
    }
    return { kind: "command", entry, args };
  }
  // A command being typed has no arguments yet; words after the token make it
  // prose. Without this, `/the release is broken` would be refused because
  // "the" prefixes /theme.
  if (trimmed.slice(probe.token.end).trim().length > 0) return { kind: "prompt" };
  const matches = prefixMatches(snapshot, query);
  if (matches.length > 0) return { kind: "ambiguous", query, matches };
  return { kind: "prompt" };
}

/** One honest sentence for the composer notice and the menu detail. */
export function describeCommandSupport(entry: CommandCatalogEntry): string {
  const { route, support } = entry.annotation;
  if (support === "runtime-api" && route.kind === "runtime-api") {
    return `Runtime route: ${route.endpoints.join(", ")}. Execution is wired in R04; this build only catalogues it.`;
  }
  if (support === "terminal-only" && route.kind === "tui-local") {
    return `TUI-only: ${route.note}`;
  }
  if (support === "unavailable" && route.kind === "unavailable") {
    return `Unavailable on the pinned engine: ${route.note}`;
  }
  return "The catalog's route claim is incomplete; this row is not executable.";
}

export function describeCommandIntent(intent: CommandIntent): string | null {
  if (intent.kind === "command") {
    return `/${intent.entry.name} is a Codewhale command, not a prompt. ${describeCommandSupport(intent.entry)}`;
  }
  if (intent.kind === "incomplete") {
    return `/${intent.entry.name} needs an argument. Usage: ${intent.entry.usage}`;
  }
  if (intent.kind === "ambiguous") {
    const names = intent.matches
      .slice(0, 4)
      .map((match) => `/${match.entry.name}`)
      .join(", ");
    const more = intent.matches.length > 4 ? `, and ${intent.matches.length - 4} more` : "";
    return `"${intent.query}" is ambiguous (${names}${more}). Tab accepts the highlighted command; nothing was sent.`;
  }
  return null;
}
