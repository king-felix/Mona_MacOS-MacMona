import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ReasoningSupportView } from "../../shared/contracts/settings";

/**
 * Canonical Runtime reasoning vocabulary (upstream RUNTIME_API.md). `auto` and
 * `off` are deliberately absent: the catalog never publishes either as an
 * active tier, and Mona only offers what the route publishes. `off` is handled
 * separately because it is the engine's thinking-disable value, not a tier.
 */
export const CANONICAL_EFFORTS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
];

/** The engine's own Models.dev catalog cache. Public model metadata, no secrets. */
const CATALOG_RELATIVE = join("catalog", "models-dev-catalog.json");

/** Larger than the observed 6.6 MB cache; refuses a corrupted or unrelated file. */
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

export interface EngineCatalogModelFacts {
  /** The metadata's own reasoning flag, when it states one. */
  reasoning: boolean | null;
  /** Active effort tiers the metadata publishes, canonical and in its order. */
  levels: string[];
  /** The metadata publishes a thinking on/off control. */
  toggle: boolean;
  canonicalModelId: string | null;
  /** When the engine fetched this metadata, as ISO-8601, or null when unknown. */
  fetchedAt: string | null;
  /** Human-readable source, safe to show: never a filesystem path. */
  sourceLabel: string;
}

interface ParsedCatalog {
  fetchedAt: string | null;
  providers: Record<string, unknown>;
}

let cache: { key: string; value: ParsedCatalog | null } | null = null;
/**
 * One read in flight per cache revision. A provider roster can list hundreds of
 * models, and the screens read the catalog per model; without this, each of
 * those would start its own multi-megabyte read of the same file before any of
 * them could populate `cache`.
 */
let inFlight: { key: string; promise: Promise<ParsedCatalog | null> } | null = null;

function isoFromUnix(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The cache is two JSON documents written back to back: a small header and the
 * provider body. The header is one line; the body may be one line or pretty
 * printed, so only the first newline is a separator. A single-document file is
 * also accepted. Anything else is refused rather than guessed at: a newer
 * layout must not silently become "this model has no controls".
 */
export function parseEngineCatalog(raw: string): ParsedCatalog | null {
  const newline = raw.indexOf("\n");
  const first = newline < 0 ? raw : raw.slice(0, newline);
  const rest = newline < 0 ? "" : raw.slice(newline + 1).trim();
  const header = parseDocument(first);
  const body = rest.length > 0 ? parseDocument(rest) : header;
  if (!isRecord(body) || !isRecord(body.providers)) return null;
  let fetchedAt: string | null = null;
  if (rest.length > 0) {
    if (!isRecord(header)) return null;
    const schema = header.schema_version;
    if (typeof schema !== "number" || schema > 2) return null;
    fetchedAt = isoFromUnix(header.fetched_at);
  }
  return { fetchedAt, providers: body.providers };
}

async function loadCatalog(configRoot: string): Promise<ParsedCatalog | null> {
  const path = join(configRoot, CATALOG_RELATIVE);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  if (!info.isFile() || info.size <= 0 || info.size > MAX_CATALOG_BYTES) return null;
  const key = `${path}:${info.mtimeMs}:${info.size}`;
  if (cache?.key === key) return cache.value;
  if (inFlight?.key === key) return inFlight.promise;
  const promise = readCatalog(path, key);
  inFlight = { key, promise };
  try {
    return await promise;
  } finally {
    if (inFlight?.promise === promise) inFlight = null;
  }
}

async function readCatalog(path: string, key: string): Promise<ParsedCatalog | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // A transient failure is not a fact about the file. Caching it would keep
    // the controls off until the file's mtime changed, which for a cache the
    // engine refreshes on its own schedule can be a long time.
    return null;
  }
  const value = parseEngineCatalog(raw);
  cache = { key, value };
  return value;
}

function readOptions(value: unknown): { levels: string[]; toggle: boolean } | null {
  if (!Array.isArray(value)) return null;
  let toggle = false;
  const levels: string[] = [];
  for (const option of value) {
    if (!isRecord(option)) continue;
    if (option.type === "toggle") toggle = true;
    if (option.type === "effort" && Array.isArray(option.values)) {
      for (const level of option.values) {
        if (typeof level !== "string") continue;
        if (!CANONICAL_EFFORTS.includes(level)) continue;
        if (!levels.includes(level)) levels.push(level);
      }
    }
  }
  return { levels, toggle };
}

/**
 * Read what the engine's own Models.dev catalog states about one exact
 * provider/model. The pinned engine's live provider-roster projection drops
 * this metadata (see DECISIONS.md, D-108); the cache the engine itself reads
 * still carries it, and this is the only non-inventing source for the exact
 * route when the API projection is silent.
 *
 * Returns null when the file, provider, or model is absent or malformed. No
 * effort level is ever inferred from a provider default or a model name.
 */
export async function readEngineCatalogModelFacts(
  configRoot: string,
  provider: string,
  modelId: string,
): Promise<EngineCatalogModelFacts | null> {
  const catalog = await loadCatalog(configRoot);
  return factsFrom(catalog, provider, modelId);
}

/**
 * Resolve one provider's whole roster from a single catalog read. Used by the
 * configuration screens, which read facts for every model in the roster.
 */
export async function readEngineCatalogModelFactsBatch(
  configRoot: string,
  provider: string,
  modelIds: readonly string[],
): Promise<Map<string, EngineCatalogModelFacts | null>> {
  const catalog = await loadCatalog(configRoot).catch(() => null);
  const resolved = new Map<string, EngineCatalogModelFacts | null>();
  for (const modelId of modelIds) resolved.set(modelId, factsFrom(catalog, provider, modelId));
  return resolved;
}

function factsFrom(
  catalog: ParsedCatalog | null,
  provider: string,
  modelId: string,
): EngineCatalogModelFacts | null {
  if (!catalog) return null;
  const providerEntry = catalog.providers[provider];
  if (!isRecord(providerEntry)) return null;
  const models = providerEntry.models;
  if (!isRecord(models)) return null;
  const model = models[modelId];
  if (!isRecord(model)) return null;
  const options = readOptions(model.reasoning_options);
  const reasoning = typeof model.reasoning === "boolean" ? model.reasoning : null;
  if (options === null && reasoning === null) return null;
  return {
    reasoning,
    levels: options?.levels ?? [],
    toggle: options?.toggle ?? false,
    canonicalModelId:
      typeof model.canonical_model_id === "string" ? model.canonical_model_id : null,
    fetchedAt: catalog.fetchedAt,
    sourceLabel: "the engine's Models.dev catalog cache",
  };
}

/**
 * Whether this provider's endpoint is something the user configured rather than
 * the provider's own first-party host. The engine's Models.dev metadata describes
 * the first-party route; the runtime itself refuses to infer levels "on a custom
 * endpoint", so Mona will not borrow that metadata for one.
 *
 * The TOML is scanned, not parsed: any `base_url` that applies to this provider
 * (its own table, an accepted spelling, or the top level) makes the route
 * custom. Anything unreadable is treated as custom — the fail-closed direction,
 * because the alternative is claiming first-party metadata for an unknown host.
 */
export function customEndpointConfigured(toml: string | null, provider: string): boolean {
  if (toml === null) return true;
  const wanted = normalizeProviderKey(provider);
  let table: string[] = [];
  for (const rawLine of toml.split(/\r?\n/)) {
    // Strip a trailing comment only when it follows whitespace, so a `#` inside
    // a URL value is not mistaken for a comment.
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (line.length === 0) continue;
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = splitKey(header[1] ?? "");
      continue;
    }
    const assignment = /^([A-Za-z0-9_.'"\-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    // A dotted key is the same as a table path spelled in one line:
    // `providers.deepseek.base_url = "…"` describes the same route as
    // `[providers.deepseek]` plus `base_url = "…"`.
    const path = [...table, ...splitKey(assignment[1] ?? "")];
    const value = assignment[2] ?? "";
    if (isBaseUrl(path[path.length - 1] ?? "")) {
      if (appliesTo(path.slice(0, -1), wanted)) return true;
      continue;
    }
    // An inline table can carry a whole provider: `providers = { deepseek = {
    // base_url = "…" } }`. Only a provider that actually sets an endpoint counts.
    if (path.length === 1 && path[0] === "providers" && /\bbase[_-]url\b/.test(value)) {
      const names = inlineProviderNames(value);
      if (names === null) return true; // unreadable shape: fail closed
      if (names.some((name) => normalizeProviderKey(name) === wanted)) return true;
    }
  }
  return false;
}

function isBaseUrl(key: string): boolean {
  return key === "base_url" || key === "base-url";
}

/**
 * Whether a key path describes this provider's endpoint. An empty path is the
 * top level and applies to whatever route runs; `profiles.*` can override any
 * route; `providers.<name>` names one, and an accepted spelling is the same
 * provider.
 */
function appliesTo(path: string[], wanted: string): boolean {
  if (path.length === 0) return true;
  if (path[0] === "profiles") return true;
  if (path[0] !== "providers") return true; // an unrecognized top-level owner: fail closed
  const named = path[1];
  // `providers.base_url` (no provider named) and `providers = { base_url = … }`
  // are not a shape this build understands; treat them as applicable rather than
  // assuming the user's route is the first-party one.
  if (!named) return true;
  return normalizeProviderKey(named) === wanted;
}

/** Split a TOML key on dots outside quotes, dropping the quotes. */
function splitKey(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((part) => part.length > 0);
}

/**
 * Provider names at the first level of an inline `providers` table. Returns null
 * when the shape cannot be read, so the caller can fail closed.
 */
function inlineProviderNames(value: string): string[] | null {
  const body = stripBraces(value);
  if (body === null) return null;
  const names: string[] = [];
  for (const segment of splitTopLevel(body)) {
    const assignment = /^\s*([A-Za-z0-9_.'"\-]+)\s*=/.exec(segment);
    if (!assignment) continue;
    const path = splitKey(assignment[1] ?? "");
    if (path.length > 0 && path[0]) names.push(path[0]);
  }
  return names.length > 0 ? names : null;
}

function stripBraces(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return value.slice(start + 1, end);
}

/** Split on commas that are not inside braces, brackets, or quotes. */
function splitTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const ch of raw) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    if (ch === "}" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function normalizeProviderKey(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, "");
}

function sourceDetail(facts: EngineCatalogModelFacts): string {
  const when = facts.fetchedAt ? `, fetched ${facts.fetchedAt}` : "";
  return `${facts.sourceLabel}${when}`;
}

/**
 * Turn what the live catalog says plus what the engine's metadata states into
 * one honest support view. An explicit engine answer outranks cached metadata;
 * cached metadata outranks silence; nothing is inferred.
 */
export function deriveReasoningSupport(input: {
  engineState: "supported" | "unsupported" | "unknown";
  engineLevels: readonly string[];
  engineSource: string | null;
  facts: EngineCatalogModelFacts | null;
}): ReasoningSupportView {
  const facts = input.facts;
  // The live projection has no thinking field, so a toggle always comes from the
  // metadata. It is labelled as such rather than attributed to the live catalog.
  const toggleNote = facts?.toggle
    ? " The thinking on/off control comes from the engine's catalog metadata, not from the live catalog answer."
    : "";
  const liveSource = input.engineSource
    ? `engine catalog (${input.engineSource})`
    : "engine catalog";
  if (input.engineState === "supported") {
    const levels = [...input.engineLevels];
    return {
      effort: "published",
      levels,
      thinking: facts?.toggle ? "toggle" : "unknown",
      source: "model_catalog",
      sourceDetail: facts?.toggle
        ? `${liveSource}; thinking control from ${sourceDetail(facts)}`
        : liveSource,
      degraded: false,
      note:
        (levels.length > 0
          ? `The engine's live catalog publishes ${levels.join(", ")} for this model.`
          : "The engine's live catalog declares an effort ladder but lists no active tier.") +
        toggleNote,
    };
  }
  if (input.engineState === "unsupported") {
    // The live answer describes this exact route's effort ladder. It says nothing
    // about the thinking control, which may still be published, and it can be
    // narrower than the provider's own metadata.
    const disagreement =
      facts && facts.levels.length > 0
        ? " The provider's own metadata lists tiers this route's catalog does not publish, so Mona offers none of them here."
        : "";
    return {
      effort: "unsupported",
      levels: [],
      thinking: facts?.toggle ? "toggle" : "unknown",
      source: "model_catalog",
      sourceDetail: facts?.toggle
        ? `${liveSource}; thinking control from ${sourceDetail(facts)}`
        : liveSource,
      degraded: false,
      note:
        "This route's catalog publishes no selectable effort ladder. That is not evidence that thinking is disabled." +
        disagreement +
        toggleNote,
    };
  }
  if (facts) {
    const levels = [...facts.levels];
    if (levels.length === 0 && !facts.toggle) {
      return {
        effort: facts.reasoning === false ? "unsupported" : "unknown",
        levels: [],
        thinking: "unknown",
        source: "engine_catalog_cache",
        sourceDetail: sourceDetail(facts),
        degraded: true,
        note:
          facts.reasoning === false
            ? "The engine's catalog metadata does not list reasoning for this model."
            : "The engine's catalog metadata lists no selectable effort ladder for this model. That is not evidence that thinking is disabled.",
      };
    }
    return {
      effort: "metadata",
      levels,
      thinking: facts.toggle ? "toggle" : "unknown",
      source: "engine_catalog_cache",
      sourceDetail: sourceDetail(facts),
      degraded: true,
      note:
        "The engine's live catalog projection omitted this model's metadata, but the engine's own Models.dev catalog publishes " +
        (levels.length > 0 ? levels.join(", ") : "a thinking toggle") +
        " for it. Mona offers only those published values.",
    };
  }
  return {
    effort: "unknown",
    levels: [],
    thinking: "unknown",
    source: null,
    sourceDetail: null,
    degraded: false,
    note: "No metadata is available for this model, so Mona cannot prove any effort level or a thinking toggle. It offers none rather than guessing. Unknown is not the same as unsupported or disabled.",
  };
}

/**
 * Prose for a saved default plus the engine's configured default. The engine
 * does not report the effective reasoning setting on any documented route, so
 * `effective` stays null unless a future engine adds a receipt; it is never
 * equated with the request.
 */
export function describeInheritance(input: {
  requested: string | null;
  configuredDefault: string | null;
  configuredSource: "engine_config" | "engine_config_cached" | "unavailable";
  configuredReadAt?: string | null;
  /** What an engine actually reported for a completed turn, when it reports one. */
  reportedEffective?: string | null;
  reportedTurnId?: string | null;
}): {
  effective: string | null;
  effectiveSource: "engine_turn_receipt" | null;
  effectiveTurnId: string | null;
  note: string;
} {
  if (input.reportedEffective) {
    // The only value Mona may call effective: one the engine itself reported for
    // a real turn. It is a fact about that turn, not a promise about the next.
    return {
      effective: input.reportedEffective,
      effectiveSource: "engine_turn_receipt",
      effectiveTurnId: input.reportedTurnId ?? null,
      note:
        `The runtime reported \`reasoning_effort = ${input.reportedEffective}\` for ` +
        (input.reportedTurnId ? `turn ${input.reportedTurnId}` : "the last completed turn") +
        ". That is the value the engine parsed for that turn; it does not promise the next one.",
    };
  }
  if (input.requested !== null) {
    const declaredAuto = input.requested === "auto";
    return {
      effective: null,
      effectiveSource: null,
      effectiveTurnId: null,
      note: declaredAuto
        ? "Mona declares `auto` and sends it on every new thread and turn, so the engine's reasoning selector resolves " +
          "a concrete tier for each turn. That tier is not reported back, so the effective value stays unknown; the " +
          "request is not proof of what the provider did. Because Mona sends `auto` explicitly, the engine's own " +
          "configured default does not govern this route."
        : "Mona sends this value on every new thread and turn. The runtime does not report the effective reasoning " +
          "setting, so it stays unknown; the request is not proof of what the provider did.",
    };
  }
  if (input.configuredSource === "unavailable") {
    return {
      effective: null,
      effectiveSource: null,
      effectiveTurnId: null,
      note:
        "Not set by Mona. The engine's configured default could not be read in this snapshot, so the effective setting is " +
        "unknown. Omitting a level does not mean thinking is disabled.",
    };
  }
  if (input.configuredDefault === null) {
    return {
      effective: null,
      effectiveSource: null,
      effectiveTurnId: null,
      note:
        "Not set by Mona. The engine reports no configured reasoning default, so a new turn may leave the provider's own " +
        "default in control. The effective setting is unknown; omission does not mean thinking is disabled.",
    };
  }
  const stale =
    input.configuredSource === "engine_config_cached"
      ? ` (last read ${input.configuredReadAt ?? "at an unrecorded time"}; the engine is not connected now, so this may have changed)`
      : "";
  if (input.configuredDefault === "auto") {
    return {
      effective: null,
      effectiveSource: null,
      effectiveTurnId: null,
      note:
        `Not set by Mona. The engine's configured default \`reasoning_effort = auto\`${stale} applies: the engine's auto ` +
        "selector chooses a concrete tier for each turn, so the effective setting is unknown until the engine reports it. " +
        "This is not the provider default, and it is not 'thinking off'.",
    };
  }
  return {
    effective: null,
    effectiveSource: null,
    effectiveTurnId: null,
    note:
      `Not set by Mona. The engine's configured default \`reasoning_effort = ${input.configuredDefault}\`${stale} applies to a ` +
      "new turn. The runtime does not report the effective value, so it stays unknown; this is not the provider's own default.",
  };
}
