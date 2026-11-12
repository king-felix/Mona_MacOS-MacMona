import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod";
import {
  PromptExportRequestSchema,
  PromptRenderRequestSchema,
  ShelfSaveRequestSchema,
  ShelfVariableSchema,
  type PromptImportResult,
  type PromptPack,
  type PromptPackPrompt,
  type PromptRenderRequest,
  type PromptRenderResult,
  type PromptShelfView,
  type ShelfPrompt,
  type ShelfSaveRequest,
  type ShelfVariable,
  type ShelfVersion,
} from "../../shared/contracts/memory";
import { StateError } from "../state/errors";
import type { StateStore, StoredSettings } from "../state/store";
import { SECRET_CLASSES, redactDiagnostics, scanForSecrets, type SecretClass } from "./settings";

export const SHELF_SCOPE = "prompts:shelf";
export const MAX_SHELF_PROMPTS = 60;
export const MAX_SHELF_VERSIONS = 20;

/** The same bounds `ShelfSaveRequestSchema` applies to a body and a tag list. */
const MAX_SHELF_BODY = 20_000;
const MAX_TAGS = 8;
const MAX_VARIABLE_VALUE = 8_000;
const PACK_FORMAT = "mona-prompt-pack";
const PACK_FORMAT_VERSION = 1;
const DEFAULT_PACK_NAME = "Mona prompt shelf";

const SHELF_NOTE =
  "Every prompt here is inert text stored locally. Variables are substituted literally as text in a preview; nothing on this shelf can execute a command, start work, insert itself into a composer, or call a model.";

const VARIABLE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const PROMPT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;

export interface PromptShelfOptions {
  store: StateStore;
  now?: () => Date;
  homeDir?: string;
}

interface ShelfState {
  prompts: ShelfPrompt[];
  version: number;
  /** Set when the stored value could not be read; view reports it instead of throwing. */
  problem: string | null;
}

// --------------------------------------------------------------- primitives

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `{{name}}` with an optional inner padding. The lookarounds keep a token that
 * is part of a longer brace run (`{{{x}}}`) verbatim, and the name class keeps
 * `{{Name}}` and `{{a.b}}` out: those are text, not placeholders.
 */
function variablePattern(): RegExp {
  return /(?<!\{)\{\{\s*([a-z][a-z0-9_-]{0,31})\s*\}\}(?!\})/g;
}

function extractVariables(body: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(variablePattern())) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Keep stored metadata for names that still appear; derive the rest. */
function mergeVariables(body: string, existing: readonly ShelfVariable[]): ShelfVariable[] {
  return extractVariables(body).map((name) => {
    const stored = existing.find((variable) => variable.name === name);
    return stored ? { ...stored } : { name, description: "", required: true, sample: "" };
  });
}

/** Tags are order-insensitive and unique, so an equivalent save is not a change. */
function normalizeTags(next: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const source = next ?? fallback;
  return [...new Set(source)].sort().slice(0, MAX_TAGS);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function latestVersion(prompt: ShelfPrompt): ShelfVersion | null {
  let latest: ShelfVersion | null = null;
  for (const version of prompt.versions) {
    if (!latest || version.version > latest.version) latest = version;
  }
  return latest;
}

function capVersions(versions: readonly ShelfVersion[]): ShelfVersion[] {
  const kept = [...versions].sort((left, right) => left.version - right.version);
  while (kept.length > MAX_SHELF_VERSIONS) {
    // Version 1 is the origin of the prompt; drop the oldest later version.
    const index = kept.findIndex((version) => version.version !== 1);
    if (index < 0) break;
    kept.splice(index, 1);
  }
  return kept;
}

function deriveId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length === 0) return "prompt";
  const bounded = slug.slice(0, 64).replace(/-+$/g, "");
  return bounded.length >= 3 ? bounded : `prompt-${bounded}`;
}

function uniqueId(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tail = `-${suffix}`;
    const head = base.slice(0, Math.max(1, 64 - tail.length)).replace(/-+$/g, "");
    const candidate = `${head}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new StateError("CONFLICT", "could not derive a unique prompt id", { id: base });
}

function collectSecretClasses(values: readonly string[]): SecretClass[] {
  const found = new Set<SecretClass>();
  for (const value of values) {
    for (const secretClass of scanForSecrets(value)) found.add(secretClass);
  }
  return SECRET_CLASSES.filter((secretClass) => found.has(secretClass));
}

function issueSummary(error: z.ZodError): Array<{ path: string; code: string }> {
  return error.issues.slice(0, 8).map((issue) => ({
    path: issue.path.map((part) => String(part)).join("."),
    code: String(issue.code),
  }));
}

function parseRequest<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new StateError("INVALID_INPUT", `${what} is invalid`, {
      issues: issueSummary(parsed.error),
    });
  }
  return parsed.data;
}

/** Local canonical JSON: object keys sorted recursively, arrays untouched. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareText)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function packDigest(prompts: readonly PromptPackPrompt[]): string {
  const ordered = [...prompts].sort(
    (left, right) => compareText(left.label, right.label) || compareText(left.body, right.body),
  );
  return sha256(canonicalJson(ordered));
}

// ------------------------------------------------------------------ storage

const StoredVersionSchema = z.strictObject({
  version: z.number().int().min(1),
  body: z.string().min(1).max(MAX_SHELF_BODY),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  note: z.string().max(400).nullable(),
  createdAt: z.string().min(1).max(64),
  variables: z.array(z.string().regex(VARIABLE_NAME)).max(64),
  acceptance: z.array(z.string().max(400)).max(20),
});

const StoredPromptSchema = z.strictObject({
  id: z.string().regex(PROMPT_ID),
  label: z.string().min(1).max(80),
  description: z.string().max(400),
  currentVersion: z.number().int().min(1),
  versions: z.array(StoredVersionSchema).min(1).max(200),
  variables: z.array(ShelfVariableSchema).max(64),
  acceptance: z.array(z.string().max(400)).max(20),
  tags: z.array(z.string().max(32)).max(8),
  updatedAt: z.string().min(1).max(64),
  redacted: z.boolean(),
});

const StoredShelfSchema = z.strictObject({
  schema_version: z.literal(1),
  prompts: z.array(StoredPromptSchema).max(MAX_SHELF_PROMPTS),
});

const PackPromptSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  description: z.string().max(400),
  body: z.string().min(1).max(MAX_SHELF_BODY),
  acceptance: z.array(z.string().trim().min(1).max(400)).max(20),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).max(8),
  variables: z.array(ShelfVariableSchema).max(64),
});

const PackSchema = z.strictObject({
  format: z.literal(PACK_FORMAT),
  format_version: z.literal(PACK_FORMAT_VERSION),
  name: z.string().trim().min(1).max(80),
  exported_at: z.string().trim().min(1).max(64),
  digest_algorithm: z.literal("sha256"),
  digest: z.string().min(1).max(128),
  prompts: z.array(PackPromptSchema).max(50),
});

function normalizePrompts(prompts: readonly ShelfPrompt[]): ShelfPrompt[] {
  const seen = new Set<string>();
  const normalized: ShelfPrompt[] = [];
  for (const prompt of prompts) {
    if (seen.has(prompt.id)) continue;
    seen.add(prompt.id);
    const versions = [...prompt.versions].sort((left, right) => left.version - right.version);
    const currentVersion = versions.reduce(
      (highest, version) => Math.max(highest, version.version),
      1,
    );
    normalized.push({
      ...prompt,
      versions,
      currentVersion,
      variables: prompt.variables.map((variable) => ({ ...variable })),
      acceptance: [...prompt.acceptance],
      tags: [...prompt.tags],
    });
  }
  return normalized;
}

// -------------------------------------------------------------------- shelf

/**
 * A local, versioned library of reusable prompts. Saving and importing store
 * text and nothing else: no engine is started, no composer is touched, and a
 * preview is a string substitution a human asked for.
 */
export class PromptShelf {
  private readonly store: StateStore;
  private readonly now: () => Date;
  private readonly homeDir: string;

  constructor(options: PromptShelfOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.homeDir = options.homeDir ?? homedir();
  }

  async view(): Promise<PromptShelfView> {
    const state = await this.load();
    const prompts = state.prompts
      .map((prompt) => this.project(prompt))
      .sort(
        (left, right) => compareText(left.label, right.label) || compareText(left.id, right.id),
      );
    return {
      prompts,
      storage: { scope: SHELF_SCOPE, version: state.version },
      limits: {
        prompts: MAX_SHELF_PROMPTS,
        versionsPerPrompt: MAX_SHELF_VERSIONS,
        bodyBytes: MAX_SHELF_BODY,
      },
      note: state.problem ? `${state.problem} ${SHELF_NOTE}` : SHELF_NOTE,
    };
  }

  async save(input: ShelfSaveRequest): Promise<ShelfPrompt> {
    const parsed = parseRequest(ShelfSaveRequestSchema, input, "prompt save request");
    this.refuseSecrets([
      parsed.label,
      parsed.description ?? "",
      parsed.body,
      ...(parsed.acceptance ?? []),
      parsed.note ?? "",
    ]);
    const state = await this.load();
    const createdAt = this.now().toISOString();
    const acceptance = [...(parsed.acceptance ?? [])];

    if (parsed.id === undefined) {
      if (state.prompts.length >= MAX_SHELF_PROMPTS) {
        throw new StateError(
          "CONFLICT",
          `the prompt shelf is limited to ${MAX_SHELF_PROMPTS} prompts; remove one before adding another`,
        );
      }
      const id = uniqueId(
        deriveId(parsed.label),
        new Set(state.prompts.map((prompt) => prompt.id)),
      );
      const prompt: ShelfPrompt = {
        id,
        label: parsed.label,
        description: parsed.description ?? "",
        currentVersion: 1,
        versions: [
          {
            version: 1,
            body: parsed.body,
            digest: sha256(parsed.body),
            note: parsed.note ?? null,
            createdAt,
            variables: extractVariables(parsed.body),
            acceptance,
          },
        ],
        variables: mergeVariables(parsed.body, []),
        acceptance,
        tags: [...(parsed.tags ?? [])],
        updatedAt: createdAt,
        redacted: false,
      };
      await this.write([...state.prompts, prompt]);
      return prompt;
    }

    if (!PROMPT_ID.test(parsed.id)) {
      throw new StateError("INVALID_INPUT", "prompt id is not a bounded identifier");
    }
    const existing = state.prompts.find((prompt) => prompt.id === parsed.id);
    if (!existing) {
      throw new StateError("NOT_FOUND", `prompt ${parsed.id} does not exist`, { id: parsed.id });
    }
    const latest = latestVersion(existing);
    const nextAcceptance = parsed.acceptance ? acceptance : [...existing.acceptance];
    const nextDescription = parsed.description ?? existing.description;
    const nextTags = normalizeTags(parsed.tags, existing.tags);
    // Every editable field counts. A save that only changes the description
    // still has to land, or the caller's edit disappears without a message.
    const changed =
      latest === null ||
      parsed.label !== existing.label ||
      parsed.body !== latest.body ||
      nextDescription !== existing.description ||
      !sameStrings(nextTags, existing.tags) ||
      !sameStrings(nextAcceptance, existing.acceptance);
    if (!changed) return existing;

    const versionNumber = Math.max(...existing.versions.map((version) => version.version)) + 1;
    const version: ShelfVersion = {
      version: versionNumber,
      body: parsed.body,
      digest: sha256(parsed.body),
      note: parsed.note ?? null,
      createdAt,
      variables: extractVariables(parsed.body),
      acceptance: nextAcceptance,
    };
    const versions = capVersions([...existing.versions, version]);
    const updated: ShelfPrompt = {
      ...existing,
      label: parsed.label,
      description: nextDescription,
      currentVersion: Math.max(...versions.map((entry) => entry.version)),
      versions,
      variables: mergeVariables(parsed.body, existing.variables),
      acceptance: nextAcceptance,
      tags: nextTags,
      updatedAt: createdAt,
    };
    await this.write(state.prompts.map((prompt) => (prompt.id === updated.id ? updated : prompt)));
    return updated;
  }

  async remove(promptId: string): Promise<{ removed: boolean; id: string }> {
    const state = await this.load();
    const next = state.prompts.filter((prompt) => prompt.id !== promptId);
    if (next.length === state.prompts.length) return { removed: false, id: promptId };
    await this.write(next);
    return { removed: true, id: promptId };
  }

  async render(request: PromptRenderRequest): Promise<PromptRenderResult> {
    const parsed = parseRequest(PromptRenderRequestSchema, request, "prompt render request");
    for (const [name, value] of Object.entries(parsed.values)) {
      if (value.length > MAX_VARIABLE_VALUE) {
        throw new StateError(
          "INVALID_INPUT",
          `a variable value is limited to ${MAX_VARIABLE_VALUE} characters`,
          { name, limit: MAX_VARIABLE_VALUE },
        );
      }
    }
    const state = await this.load();
    const prompt = state.prompts.find((entry) => entry.id === parsed.promptId);
    if (!prompt) {
      throw new StateError("NOT_FOUND", `prompt ${parsed.promptId} does not exist`, {
        id: parsed.promptId,
      });
    }
    const version =
      parsed.version === undefined
        ? latestVersion(prompt)
        : (prompt.versions.find((entry) => entry.version === parsed.version) ?? null);
    if (!version) {
      throw new StateError(
        "NOT_FOUND",
        `prompt ${prompt.id} has no version ${parsed.version ?? prompt.currentVersion}`,
        { id: prompt.id, version: parsed.version ?? null },
      );
    }
    // Only names declared by this version are substituted. Values are inserted
    // as plain text; a replacement is never rescanned for further tokens.
    const declared = new Set(version.variables);
    const text = version.body.replace(variablePattern(), (match: string, name: string) => {
      if (!declared.has(name)) return match;
      const value = parsed.values[name];
      return value === undefined ? match : value;
    });
    const missing = version.variables.filter((name) => parsed.values[name] === undefined);
    const unknown = Object.keys(parsed.values)
      .filter((name) => !declared.has(name))
      .sort(compareText);
    return {
      promptId: prompt.id,
      version: version.version,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      missing,
      unknown,
      acceptance: [...version.acceptance],
      inert: true,
    };
  }

  async exportPack(request: { name?: string; promptIds?: string[] } = {}): Promise<PromptPack> {
    const parsed = parseRequest(PromptExportRequestSchema, request, "prompt export request");
    const state = await this.load();
    if (state.problem) {
      throw new StateError("UNSUPPORTED_SCHEMA", "the stored prompt shelf could not be read", {
        reason: state.problem,
      });
    }
    let selected = state.prompts;
    if (parsed.promptIds) {
      const wanted = [...new Set(parsed.promptIds)];
      const missing = wanted.filter((id) => !state.prompts.some((prompt) => prompt.id === id));
      if (missing.length > 0) {
        throw new StateError("NOT_FOUND", "the prompt shelf has no prompt with that id", {
          promptIds: missing,
        });
      }
      selected = wanted.map(
        (id) => state.prompts.find((prompt) => prompt.id === id) as ShelfPrompt,
      );
    }
    const prompts: PromptPackPrompt[] = [];
    for (const prompt of selected) {
      // A stored prompt that predates screening must not leave the machine.
      const version = latestVersion(prompt);
      const packed: PromptPackPrompt = {
        label: prompt.label,
        description: prompt.description,
        body: version ? version.body : "",
        acceptance: version ? [...version.acceptance] : [],
        tags: [...prompt.tags],
        variables: prompt.variables.map((variable) => ({ ...variable })),
      };
      const classes = collectSecretClasses([
        packed.label,
        packed.description,
        packed.body,
        ...packed.acceptance,
      ]);
      if (classes.length > 0) {
        throw new StateError("INVALID_INPUT", "prompt text contains secret-shaped material", {
          classes,
          id: prompt.id,
        });
      }
      prompts.push(packed);
    }
    prompts.sort(
      (left, right) => compareText(left.label, right.label) || compareText(left.body, right.body),
    );
    return {
      format: PACK_FORMAT,
      format_version: PACK_FORMAT_VERSION,
      name: parsed.name ?? DEFAULT_PACK_NAME,
      exported_at: this.now().toISOString(),
      digest_algorithm: "sha256",
      digest: packDigest(prompts),
      prompts,
    };
  }

  async importPack(value: unknown): Promise<PromptImportResult> {
    const parsed = PackSchema.safeParse(value);
    if (!parsed.success) {
      throw new StateError("IMPORT_INVALID", "the value is not a valid Mona prompt pack", {
        issues: issueSummary(parsed.error),
      });
    }
    const pack = parsed.data;
    if (pack.format !== PACK_FORMAT || pack.format_version !== PACK_FORMAT_VERSION) {
      throw new StateError(
        "IMPORT_INVALID",
        `only ${PACK_FORMAT} format version ${PACK_FORMAT_VERSION} can be imported`,
      );
    }
    const expected = packDigest(pack.prompts);
    if (pack.digest !== expected) {
      throw new StateError("IMPORT_DIGEST_MISMATCH", "the pack digest does not match its prompts", {
        expected,
        actual: pack.digest,
      });
    }

    const state = await this.load();
    const prompts = [...state.prompts];
    const usedIds = new Set(prompts.map((prompt) => prompt.id));
    const created: PromptImportResult["created"] = [];
    const skipped: PromptImportResult["skipped"] = [];
    let redactions = 0;

    for (const entry of pack.prompts) {
      const classes = collectSecretClasses([
        entry.label,
        entry.description,
        entry.body,
        ...entry.acceptance,
      ]);
      if (classes.length > 0) {
        skipped.push({
          label: entry.label,
          reason: `contains secret-shaped text: ${classes.join(", ")}`,
        });
        continue;
      }
      if (prompts.length >= MAX_SHELF_PROMPTS) {
        skipped.push({
          label: entry.label,
          reason: `the prompt shelf is limited to ${MAX_SHELF_PROMPTS} prompts`,
        });
        continue;
      }
      const description = redactDiagnostics(entry.description, this.homeDir);
      redactions += description.redactions;
      const createdAt = this.now().toISOString();
      const acceptance = [...entry.acceptance];
      const id = uniqueId(deriveId(entry.label), usedIds);
      usedIds.add(id);
      const prompt: ShelfPrompt = {
        id,
        label: entry.label,
        description: description.text,
        currentVersion: 1,
        versions: [
          {
            version: 1,
            body: entry.body,
            digest: sha256(entry.body),
            note: null,
            createdAt,
            variables: extractVariables(entry.body),
            acceptance,
          },
        ],
        variables: mergeVariables(entry.body, entry.variables),
        acceptance,
        tags: [...entry.tags],
        updatedAt: createdAt,
        redacted: false,
      };
      prompts.push(prompt);
      created.push({ label: prompt.label, promptId: id });
    }

    if (created.length > 0) await this.write(prompts);
    return { packName: pack.name, created, skipped, redactions, inert: true };
  }

  // ---------------------------------------------------------------- internals

  private refuseSecrets(values: readonly string[]): void {
    const classes = collectSecretClasses(values);
    if (classes.length > 0) {
      throw new StateError("INVALID_INPUT", "prompt text contains secret-shaped material", {
        classes,
      });
    }
  }

  private async load(): Promise<ShelfState> {
    let stored: StoredSettings | null;
    try {
      stored = await this.store.getSettings(SHELF_SCOPE);
    } catch {
      return {
        prompts: [],
        version: 0,
        problem:
          "The stored prompt shelf could not be read; showing an empty shelf and leaving the stored value untouched.",
      };
    }
    if (!stored) return { prompts: [], version: 0, problem: null };
    const parsed = StoredShelfSchema.safeParse(stored.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue
        ? `${issue.path.map(String).join(".") || "value"} (${issue.code})`
        : "value";
      return {
        prompts: [],
        version: stored.version,
        problem: `The stored prompt shelf does not match schema version 1 at ${where}; showing an empty shelf and leaving the stored value untouched.`,
      };
    }
    return {
      prompts: normalizePrompts(parsed.data.prompts),
      version: stored.version,
      problem: null,
    };
  }

  /**
   * The renderer projection. Save refuses secret-shaped text, so a stored body
   * should never need this; a value restored from a settings backup can, which
   * is why every string a view returns passes the redactor and `redacted`
   * reports whether it actually changed anything.
   */
  private project(prompt: ShelfPrompt): ShelfPrompt {
    let redactions = 0;
    const redact = (text: string): string => {
      const result = redactDiagnostics(text, this.homeDir);
      redactions += result.redactions;
      return result.text;
    };
    const projected: ShelfPrompt = {
      ...prompt,
      label: redact(prompt.label),
      description: redact(prompt.description),
      acceptance: prompt.acceptance.map(redact),
      versions: prompt.versions.map((version) => ({
        ...version,
        body: redact(version.body),
        note: version.note === null ? null : redact(version.note),
        acceptance: version.acceptance.map(redact),
      })),
    };
    return redactions > 0 ? { ...projected, redacted: true } : projected;
  }

  private async write(prompts: readonly ShelfPrompt[]): Promise<void> {
    const ordered = [...prompts].sort(
      (left, right) => compareText(left.label, right.label) || compareText(left.id, right.id),
    );
    await this.store.putSettings(SHELF_SCOPE, { schema_version: 1, prompts: ordered });
  }
}
