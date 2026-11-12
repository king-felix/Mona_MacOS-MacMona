import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AcceptanceCriterion, TaskState } from "../../shared/contracts/board";
import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import { ProjectId as ProjectIdSchema, TaskId as TaskIdSchema } from "../../shared/contracts/ids";
import {
  CONTEXT_SLOTS,
  CONTEXT_SLOT_LABELS,
  ContextSelectionRequestSchema,
  MEMORY_SOURCES,
  MemorySearchRequestSchema,
  WorkspaceSearchRequestSchema,
  type ContextSelectionPreview,
  type ContextSlot,
  type ContextSlotView,
  type MemoryHit,
  type MemoryIndexStatus,
  type MemoryPointer,
  type MemorySearchResult,
  type MemorySource,
  type MemorySourceCount,
  type ResumePacket,
  type ResumePointer,
  type WorkspaceSearchHit,
  type WorkspaceSearchResult,
} from "../../shared/contracts/memory";
import { StateError } from "../state/errors";
import type {
  ArtifactRecord,
  AttemptRecord,
  RequirementEvidenceRecord,
  StateStore,
  StoredDecision,
  StoredProject,
  StoredTask,
} from "../state/store";
import { redactDiagnostics } from "./settings";

/**
 * Project memory: local, deterministic recall over stored records for one
 * project. Nothing here embeds, calls a model, touches the network, or copies a
 * repository into the database. Search ranks rows that Mona already owns; the
 * workspace search is a bounded on-demand read that writes nothing.
 *
 * The two honest limits are stated in the results rather than in prose:
 * `exactProviderRequest` is always `false` (Mona cannot inspect the request the
 * engine assembles) and `indexStatus.credentialsIndexed` is always `false`.
 */

/**
 * Ranking, in one place so it stays reviewable and reproducible.
 *
 * 1. Normalise: the query is lower-cased, split on whitespace, empties dropped,
 *    capped at 8 terms, and each term is capped at 64 characters. The
 *    "whole query" used for exact-substring bonuses is the terms joined by one
 *    space, so whitespace differences cannot change a score.
 * 2. A record is a hit only when at least one term appears in its title or body.
 * 3. Score: whole query in title +100; each term in title +40; whole query in
 *    body +50; each term in body +12; the total is capped at 300.
 * 4. Ties break by higher `occurrences`, then by the source order in
 *    `MEMORY_SOURCES`, then by lexicographic record id. Every input read is
 *    already stable (`list*` methods are ordered), so two runs produce the same
 *    array.
 */
const MAX_QUERY_TERMS = 8;
const MAX_TERM_LENGTH = 64;
const MAX_SCORE = 300;
const MAX_TITLE_TERM_SCORE = 40;
const MAX_TITLE_QUERY_SCORE = 100;
const MAX_BODY_TERM_SCORE = 12;
const MAX_BODY_QUERY_SCORE = 50;
const MAX_SNIPPET_CHARS = 240;
const MAX_HITS = 200;
const MAX_RESUME_CHARS = 8_000;
const MAX_CONTEXT_BYTES = 100_000;
const CONTEXT_TRUNCATION_MARKER = "\n…(truncated at the context preview limit)";
const RESUME_TRUNCATED_MARKER = "…(truncated)";

/** Stated in every resume packet: the packet is Mona's text, not the request. */
const PACKET_FINAL_LINE =
  "This packet is Mona's own text; the assembled provider request is not inspectable.";

const RESUME_EXCLUDED = [
  "engine conversation history",
  "the assembled provider request",
  "credentials and environment variables",
  "repository contents",
  "full prompts of other tasks",
];

const CONTEXT_EXCLUDED = [
  "Mona_macOS_Project.md and Mona_macOS_PROMPTS.md — the full product spec and prompt files; Mona never injects them unless the caller selects them",
  "engine conversation history",
  "state from other projects",
  "provider-side system prompts",
];

const PROVIDER_REQUEST_NOTE =
  "Mona 0.10.2 exposes no provider-request inspection: this preview is Mona's own composition of stored records, not the request the engine assembles.";

/** Only these extensions are read; everything else is skipped and counted. */
const WORKSPACE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "json",
  "md",
  "mdx",
  "txt",
  "yml",
  "yaml",
  "toml",
  "swift",
  "c",
  "h",
  "css",
  "html",
  "sh",
] as const;

const WORKSPACE_EXTENSION_SET = new Set<string>(WORKSPACE_EXTENSIONS);

/** Directories that are never descended into, at any depth. */
const WORKSPACE_SKIP_DIRECTORIES = [
  ".git",
  ".mona",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "target",
  "DerivedData",
  ".next",
  "vendor",
] as const;

const WORKSPACE_SKIP_DIRECTORY_SET = new Set<string>(WORKSPACE_SKIP_DIRECTORIES);

const WORKSPACE_MAX_FILES = 2_000;
const WORKSPACE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const WORKSPACE_MAX_FILE_BYTES = 512 * 1024;
const WORKSPACE_MAX_HIT_CHARS = 400;
const BINARY_PROBE_BYTES = 4 * 1024;

const WORKSPACE_SCOPE =
  "Bounded on-demand read of the project root: only regular files with extensions " +
  `${WORKSPACE_EXTENSIONS.join(", ")} are read; directories ` +
  `${WORKSPACE_SKIP_DIRECTORIES.join(", ")} are skipped; symlinks are never followed; ` +
  "caps: 2000 files, 8 MiB scanned, 200 hits, 400 characters per hit line.";

/** Only these states can be the "current task" in a resume packet. */
const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "pending",
  "running",
  "verifying",
  "blocked",
  "interrupted",
]);

/** Prompt-shelf records are supplied by a callback, not imported by this module. */
export interface MemoryExtraSource {
  source: "prompt";
  id: string;
  title: string;
  body: string;
  updatedAt: string;
  pointer: MemoryPointer;
}

export interface ProjectMemoryOptions {
  store: StateStore;
  now?: () => Date;
  /** Used to redact the local home path; tests inject a literal. */
  homeDir?: string;
  /** Injected so the resume packet can state engine identity without a live call. */
  engineInfo?: () => {
    version: string | null;
    commit: string | null;
    observedAt?: string | null;
  };
  /**
   * Prompt-shelf records. The shelf is not imported here: a later wiring step
   * passes a reader, and this module treats the records like any other source.
   */
  extraSources?: () => Promise<MemoryExtraSource[]>;
}

interface SearchRecord {
  id: string;
  source: MemorySource;
  /** Already redacted. */
  title: string;
  /** Already redacted; never artifact bytes, never repository contents. */
  body: string;
  updatedAt: string;
  pointer: MemoryPointer;
  redactions: number;
}

interface ScoredRecord {
  record: SearchRecord;
  score: number;
  matchedTerms: string[];
  occurrences: number;
}

export interface ContextBlock {
  slot: ContextSlot;
  text: string;
  items: number;
  available: boolean;
  note: string;
  redactions: number;
}

interface ContextMaterials {
  project: StoredProject;
  task: StoredTask;
  criteria: AcceptanceCriterion[];
  decisions: StoredDecision[];
  evidence: RequirementEvidenceRecord[];
  attempts: AttemptRecord[];
  resume: ResumePacket;
}

// ------------------------------------------------------------- small helpers

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/**
 * Evidence pointers are only "available" when the file really exists and really
 * resolves inside the project root. A symlink that escapes the root is not
 * evidence Mona can point at.
 */
function evidenceAvailable(rootPath: string, path: string): boolean {
  const root = safeRealpath(rootPath);
  if (!root) return false;
  const target = isAbsolute(path) ? path : resolve(root, path);
  if (!isInside(root, target)) return false;
  if (!existsSync(target)) return false;
  const real = safeRealpath(target);
  return real !== null && isInside(root, real);
}

function normalizeTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    const term = raw.slice(0, MAX_TERM_LENGTH);
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_QUERY_TERMS) break;
  }
  return terms;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Fit included blocks into a byte budget, in slot order. The last block that
 * fits may be clipped with an explicit marker; later blocks are dropped and the
 * result reports `truncated`. Slot byte counts are derived from the fitted
 * blocks, so a cut preview never claims a total it does not have.
 */
export function fitContextBlocks(
  ordered: readonly ContextBlock[],
  budget: number,
  prefix: { text: string; redactions: number } | null,
): { blocks: ContextBlock[]; truncated: boolean } {
  const reserved = Buffer.byteLength(prefix?.text ?? "", "utf8") + (prefix ? 2 : 0);
  let remaining = Math.max(0, budget - reserved);
  const kept: ContextBlock[] = [];
  let truncated = false;
  for (const block of ordered) {
    const size = Buffer.byteLength(block.text, "utf8") + (kept.length > 0 ? 2 : 0);
    if (size <= remaining) {
      kept.push(block);
      remaining -= size;
      continue;
    }
    // The marker is sized in bytes: it contains an ellipsis, which is one UTF-16
    // unit and three UTF-8 bytes.
    const markerBytes = Buffer.byteLength(CONTEXT_TRUNCATION_MARKER, "utf8");
    if (remaining > markerBytes + 2) {
      const allowance = remaining - markerBytes - (kept.length > 0 ? 2 : 0);
      const clipped = clipBytes(block.text, Math.max(0, allowance));
      if (clipped.length > 0) {
        kept.push({ ...block, text: `${clipped}${CONTEXT_TRUNCATION_MARKER}` });
      }
    }
    truncated = true;
    break;
  }
  return { blocks: kept, truncated };
}

/** Clip to a UTF-8 byte budget without splitting a multi-byte character. */
function clipBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // Back off to a code-point boundary (continuation bytes are 10xxxxxx).
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** One line, ≤ 240 characters, centred on the first match of `term`. */
function snippetFor(text: string, term: string | null): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= MAX_SNIPPET_CHARS) return flat;
  const index = term ? flat.toLowerCase().indexOf(term) : -1;
  if (!term || index < 0) return clipChars(flat, MAX_SNIPPET_CHARS);
  // Reserve one character for each ellipsis that may be added.
  const budget = MAX_SNIPPET_CHARS - 2;
  const focus = Math.min(term.length, budget);
  let start = Math.max(0, index - Math.floor((budget - focus) / 2));
  const end = Math.min(flat.length, start + budget);
  start = Math.max(0, end - budget);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  const out = `${prefix}${flat.slice(start, end)}${suffix}`;
  return out.length > MAX_SNIPPET_CHARS ? clipChars(out, MAX_SNIPPET_CHARS) : out;
}

function toProjectId(value: string): ProjectId {
  const parsed = ProjectIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new StateError("INVALID_INPUT", "expected a project id like prj_<id>", {
      project_id: value,
    });
  }
  return parsed.data;
}

function toTaskId(value: string): TaskId {
  const parsed = TaskIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new StateError("INVALID_INPUT", "expected a task id like tsk_<id>", { task_id: value });
  }
  return parsed.data;
}

function invalidInput(message: string, details: Record<string, unknown> = {}): StateError {
  return new StateError("INVALID_INPUT", message, details);
}

// --------------------------------------------------------------------- class

export class ProjectMemory {
  private readonly store: StateStore;
  private readonly now: () => Date;
  private readonly homeDir: string;
  private readonly engineInfo: (() => { version: string | null; commit: string | null }) | null;
  private readonly extraSources: (() => Promise<MemoryExtraSource[]>) | null;

  constructor(options: ProjectMemoryOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.homeDir = options.homeDir ?? homedir();
    this.engineInfo = options.engineInfo ?? null;
    this.extraSources = options.extraSources ?? null;
  }

  // ------------------------------------------------------------------ search

  async search(request: {
    projectId: string;
    query: string;
    sources?: MemorySource[];
    limit?: number;
  }): Promise<MemorySearchResult> {
    const parsed = MemorySearchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw invalidInput("invalid memory search request", { problems: parsed.error.issues });
    }
    const projectId = toProjectId(parsed.data.projectId);
    const project = await this.requireProject(projectId);
    const startedAt = this.now().getTime();

    const query = parsed.data.query;
    const terms = normalizeTerms(query);
    if (terms.length === 0) {
      throw invalidInput("a search needs at least one term", { project_id: String(project.id) });
    }
    const wholeQuery = terms.join(" ");
    const wanted = new Set<MemorySource>(parsed.data.sources ?? [...MEMORY_SOURCES]);
    const limit = Math.min(parsed.data.limit ?? 20, MAX_HITS);

    const records = await this.collectRecords(projectId, wanted);
    const scored: ScoredRecord[] = [];
    for (const record of records) {
      const result = this.scoreRecord(record, terms, wholeQuery);
      if (result) scored.push(result);
    }
    scored.sort((a, b) => this.compareScored(a, b));

    const total = scored.length;
    const hits = scored.slice(0, limit).map((entry) => this.toHit(entry, terms));
    const counts: MemorySourceCount[] = [];
    for (const source of MEMORY_SOURCES) {
      if (!wanted.has(source)) continue;
      const sourceRecords = records.filter((record) => record.source === source);
      counts.push({
        source,
        records: sourceRecords.length,
        redactions: sourceRecords.reduce((sum, record) => sum + record.redactions, 0),
        present: sourceRecords.length > 0,
      });
    }
    const redactions = records.reduce((sum, record) => sum + record.redactions, 0);
    const durationMs = Math.max(0, Math.round(this.now().getTime() - startedAt));

    return {
      projectId: project.id,
      query,
      terms,
      hits,
      total,
      truncated: total > hits.length,
      considered: records.length,
      sources: counts,
      persisted: false,
      redactions,
      durationMs,
      note: "Local, deterministic search over stored records only: no embeddings, no model call, no network, and no repository contents. Redaction totals cover every record considered.",
    };
  }

  async indexStatus(projectId: string): Promise<MemoryIndexStatus> {
    const id = toProjectId(projectId);
    await this.requireProject(id);
    const generatedAt = this.now().toISOString();
    const records = await this.collectRecords(id, new Set<MemorySource>([...MEMORY_SOURCES]));
    const canonicalLines = records
      .map((record) => `${record.source}\0${record.id}\0${record.updatedAt}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const digest = createHash("sha256").update(canonicalLines.join("\n")).digest("hex");
    const counts: MemorySourceCount[] = MEMORY_SOURCES.map((source) => {
      const sourceRecords = records.filter((record) => record.source === source);
      return {
        source,
        records: sourceRecords.length,
        redactions: sourceRecords.reduce((sum, record) => sum + record.redactions, 0),
        present: sourceRecords.length > 0,
      };
    });
    return {
      projectId: id,
      generatedAt,
      digest,
      counts,
      totalRecords: records.length,
      totalRedactions: records.reduce((sum, record) => sum + record.redactions, 0),
      stateRevision: await this.store.stateRevision(),
      repositoryContents: "on_demand",
      credentialsIndexed: false,
      embeddings: false,
      excluded: [
        {
          what: "the settings table",
          why: "runtime settings are configuration, not project memory; search never reads them",
        },
        {
          what: "engine config files",
          why: "engine configuration belongs to the engine and is never copied into this database",
        },
        {
          what: "environment variables",
          why: "the process environment can hold credentials, so it is never indexed",
        },
        {
          what: "repository file contents",
          why: "code stays on disk and is searched on demand; no repository copy is written here",
        },
        {
          what: "artifact bytes",
          why: "only artifact metadata (source, media type, digest) is searchable",
        },
        {
          what: "engine transcripts",
          why: "conversation history is owned by the engine and is never stored or indexed by Mona",
        },
      ],
      retention: {
        note: "Records follow project retention; evidence rows are protected and are not pruned by retention sweeps.",
        evidenceProtected: true,
      },
      note: "Everything here is local and deterministic: no embeddings, no model call, no network, and no repository copy.",
    };
  }

  // -------------------------------------------------------- workspace search

  async searchWorkspace(request: {
    projectId: string;
    query: string;
    limit?: number;
  }): Promise<WorkspaceSearchResult> {
    const parsed = WorkspaceSearchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw invalidInput("invalid workspace search request", { problems: parsed.error.issues });
    }
    const projectId = toProjectId(parsed.data.projectId);
    const project = await this.requireProject(projectId);
    const query = parsed.data.query;
    const needle = query.toLowerCase();
    const limit = Math.min(parsed.data.limit ?? MAX_HITS, MAX_HITS);

    const root = safeRealpath(project.rootPath);
    if (!root) {
      return {
        projectId: project.id,
        query,
        hits: [],
        filesScanned: 0,
        filesSkipped: 1,
        bytesScanned: 0,
        truncated: true,
        skippedReasons: [{ reason: "unreadable-root", count: 1 }],
        scope: WORKSPACE_SCOPE,
        persisted: false,
        note: "The project folder is not readable, so nothing was scanned. This read wrote nothing.",
      };
    }

    let filesScanned = 0;
    let filesSkipped = 0;
    let bytesScanned = 0;
    let truncated = false;
    const skipped = new Map<string, number>();
    const hits: WorkspaceSearchHit[] = [];
    const stack: string[] = [root];

    const skip = (reason: string): void => {
      filesSkipped += 1;
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    };

    let done = false;
    while (stack.length > 0 && !done) {
      const directory = stack.pop() as string;
      let names: string[];
      try {
        names = readdirSync(directory).sort();
      } catch {
        skip("unreadable-directory");
        continue;
      }
      for (const name of names) {
        const path = join(directory, name);
        let stat;
        try {
          stat = lstatSync(path);
        } catch {
          skip("unreadable");
          continue;
        }
        // lstat never follows a link, so a symlink is skipped before any read.
        if (stat.isSymbolicLink()) {
          skip("symlink");
          continue;
        }
        if (stat.isDirectory()) {
          if (WORKSPACE_SKIP_DIRECTORY_SET.has(name)) {
            skip(`directory: ${name}`);
            continue;
          }
          stack.push(path);
          continue;
        }
        if (!stat.isFile()) {
          skip("not-regular");
          continue;
        }
        if (!WORKSPACE_EXTENSION_SET.has(extname(name).slice(1).toLowerCase())) {
          skip("extension");
          continue;
        }
        const real = safeRealpath(path);
        if (!real || !isInside(root, real)) {
          skip("outside-root");
          continue;
        }
        if (stat.size > WORKSPACE_MAX_FILE_BYTES) {
          skip("too-large");
          continue;
        }
        if (
          filesScanned >= WORKSPACE_MAX_FILES ||
          bytesScanned + stat.size > WORKSPACE_MAX_TOTAL_BYTES
        ) {
          truncated = true;
          done = true;
          break;
        }
        let data: Buffer;
        try {
          data = readFileSync(path);
        } catch {
          skip("unreadable");
          continue;
        }
        if (data.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
          skip("binary");
          continue;
        }
        filesScanned += 1;
        bytesScanned += data.byteLength;
        const lines = data.toString("utf8").split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line === undefined) continue;
          if (!line.toLowerCase().includes(needle)) continue;
          hits.push(this.workspaceHit(relative(root, path), index + 1, line));
          if (hits.length >= MAX_HITS) {
            truncated = true;
            done = true;
            break;
          }
        }
      }
    }

    hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    const cappedHits = hits.slice(0, limit);
    const skippedReasons = [...skipped.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));

    return {
      projectId: project.id,
      query,
      hits: cappedHits,
      filesScanned,
      filesSkipped,
      bytesScanned,
      truncated: truncated || hits.length > cappedHits.length,
      skippedReasons,
      scope: WORKSPACE_SCOPE,
      persisted: false,
      note: "On-demand read of the project root. It is not stored, cached, or indexed: the result disappears when the call returns and nothing is written.",
    };
  }

  private workspaceHit(path: string, line: number, raw: string): WorkspaceSearchHit {
    const redacted = redactDiagnostics(raw.trim(), this.homeDir).text;
    if (redacted.length <= WORKSPACE_MAX_HIT_CHARS) {
      return { path, line, text: redacted, truncated: false };
    }
    return {
      path,
      line,
      text: `${redacted.slice(0, WORKSPACE_MAX_HIT_CHARS - 1)}…`,
      truncated: true,
    };
  }

  // ------------------------------------------------------------ resume packet

  async resumePacket(projectId: string): Promise<ResumePacket> {
    const id = toProjectId(projectId);
    const project = await this.requireProject(id);
    const [tasks, problems, evidence, decisions, stateRevision] = await Promise.all([
      this.store.listTasks(id),
      this.store.listProblems(id),
      this.store.listRequirementEvidence(id),
      this.store.listDecisions(id),
      this.store.stateRevision(),
    ]);

    const generatedAt = this.now().toISOString();
    const redact = (value: string): string => redactDiagnostics(value, this.homeDir).text;

    const current = this.pickCurrentTask(tasks);
    const blockers = problems.filter((problem) => problem.status !== "resolved").slice(0, 5);
    const recentEvidence = evidence.slice(-8);
    const recentDecisions = decisions.slice(-5);
    const engine = this.engineLabel();

    const lines: string[] = [
      `Project: ${redact(project.name)}`,
      `Generated: ${generatedAt}`,
      `State revision: ${stateRevision}`,
      `Current task: ${current ? `${redact(current.title)} [${current.status}]` : "none"}`,
      `Next action: ${current?.nextStep ? redact(current.nextStep) : "none recorded"}`,
    ];
    for (const problem of blockers) {
      lines.push(
        `Blocked: ${redact(problem.symptom)} (attempts total/${problem.totalAttempts}, no-progress/${problem.noProgressAttempts})`,
      );
    }
    for (const entry of recentEvidence) {
      lines.push(`Evidence: ${redact(entry.path)} (${redact(entry.requirementId)})`);
    }
    for (const decision of recentDecisions) {
      lines.push(`Decisions: ${redact(decision.title)}`);
    }
    lines.push(`Engine: ${engine}`);
    lines.push(PACKET_FINAL_LINE);

    let text = lines.join("\n");
    if (text.length > MAX_RESUME_CHARS) {
      text = `${text.slice(0, MAX_RESUME_CHARS - RESUME_TRUNCATED_MARKER.length)}${RESUME_TRUNCATED_MARKER}`;
    }

    const pointers: ResumePointer[] = [];
    if (current) {
      pointers.push({
        kind: "task",
        label: "Current task",
        value: redact(current.title),
        available: true,
        note: current.status,
      });
    }
    for (const problem of blockers) {
      pointers.push({
        kind: "task",
        label: "Blocked problem",
        value: redact(problem.symptom),
        available: true,
        note: `attempts total/${problem.totalAttempts}, no-progress/${problem.noProgressAttempts}`,
      });
    }
    for (const entry of recentEvidence) {
      pointers.push({
        kind: "evidence",
        label: "Evidence",
        value: redact(entry.path),
        available: evidenceAvailable(project.rootPath, entry.path),
        note: redact(entry.requirementId),
      });
    }
    for (const decision of recentDecisions) {
      pointers.push({
        kind: "decision",
        label: "Decision",
        value: redact(decision.title),
        available: true,
        note: decision.id,
      });
    }

    return {
      projectId: id,
      projectName: redact(project.name),
      generatedAt,
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      pointers,
      excluded: [...RESUME_EXCLUDED],
      stateRevision,
      exactProviderRequest: false,
      engineInspection: "unavailable",
      note: "Assembled from Mona's stored records only. The engine keeps its own conversation history, and Mona cannot show the request the engine assembles.",
    };
  }

  // ---------------------------------------------------------- context slots

  async contextSlots(projectId: string, taskId: string): Promise<ContextSlotView[]> {
    const materials = await this.loadContext(projectId, taskId);
    return this.buildSlots(materials, new Set<ContextSlot>());
  }

  async contextSelection(request: {
    projectId: string;
    taskId: string;
    include: ContextSlot[];
  }): Promise<ContextSelectionPreview> {
    const parsed = ContextSelectionRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw invalidInput("invalid context selection request", { problems: parsed.error.issues });
    }
    const materials = await this.loadContext(parsed.data.projectId, parsed.data.taskId);
    const include = new Set<ContextSlot>(parsed.data.include);
    const allBlocks = this.buildBlocks(materials, include);
    const ordered = allBlocks.filter((block) => include.has(block.slot));
    const title = include.has("prompt")
      ? null
      : redactDiagnostics(materials.task.title, this.homeDir);

    // The cap applies to the composition, not to a summary of it: blocks are
    // fitted *before* the text and the slot byte counts are derived, so
    // "slot bytes sum to the total" stays true even when the preview is cut.
    const fitted = fitContextBlocks(ordered, MAX_CONTEXT_BYTES, title);
    const blocks = fitted.blocks;
    const textual = blocks.filter((block) => block.text.length > 0);

    let text = textual.map((block) => block.text).join("\n\n");
    const redactions =
      ordered.reduce((sum, block) => sum + block.redactions, 0) + (title?.redactions ?? 0);
    if (title) {
      // The prompt slot is the base; without it the preview starts from the
      // bare title, and the prompt slot's note says so.
      text = text ? `${title.text}\n\n${text}` : title.text;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    const slots = this.buildSlots(materials, include, fitted.blocks);

    // Per-slot bytes sum to the included total: the first included block also
    // carries the joining separators (and the bare title when prompt is out).
    const sumBlocks = textual.reduce(
      (sum, block) => sum + Buffer.byteLength(block.text, "utf8"),
      0,
    );
    const extra = Math.max(0, bytes - sumBlocks);
    const carrier = textual[0] ?? blocks[0];
    if (carrier) {
      const view = slots.find((slot) => slot.slot === carrier.slot);
      if (view) view.bytes += extra;
    }

    return {
      projectId: materials.project.id,
      taskId: materials.task.id,
      text,
      bytes,
      slots,
      included: CONTEXT_SLOTS.filter((slot) => include.has(slot)),
      excluded: [...CONTEXT_EXCLUDED],
      truncated: fitted.truncated,
      redactions,
      exactProviderRequest: false,
      providerRequestNote: PROVIDER_REQUEST_NOTE,
      note: "The text is Mona's own composition of stored records for this task; slot byte counts sum to the included total.",
    };
  }

  private async loadContext(projectId: string, taskId: string): Promise<ContextMaterials> {
    const id = toProjectId(projectId);
    const tid = toTaskId(taskId);
    const project = await this.requireProject(id);
    const task = await this.store.getTask(tid);
    if (!task || task.projectId !== project.id) {
      throw new StateError("NOT_FOUND", `task ${taskId} is not in project ${projectId}`, {
        project_id: id,
        task_id: taskId,
      });
    }
    const [criteria, decisions, evidence, attempts, resume] = await Promise.all([
      this.store.listAcceptance(tid),
      this.store.listDecisions(id),
      this.store.listRequirementEvidence(id),
      this.store.listAttempts(id),
      this.resumePacket(id),
    ]);
    return {
      project,
      task,
      criteria,
      decisions,
      evidence: evidence.filter((entry) => entry.taskId === tid),
      attempts: attempts.filter((entry) => entry.taskId === tid),
      resume,
    };
  }

  private buildSlots(
    materials: ContextMaterials,
    include: ReadonlySet<ContextSlot>,
    prebuilt?: readonly ContextBlock[],
  ): ContextSlotView[] {
    const blocks = prebuilt ?? this.buildBlocks(materials, include);
    const views = new Map<ContextSlot, ContextSlotView>();
    for (const block of blocks) {
      views.set(block.slot, {
        slot: block.slot,
        label: CONTEXT_SLOT_LABELS[block.slot],
        available: block.available,
        included: include.has(block.slot),
        items: block.items,
        bytes: Buffer.byteLength(block.text, "utf8"),
        note: block.note,
      });
    }
    return CONTEXT_SLOTS.map((slot) => views.get(slot)).filter(
      (view): view is ContextSlotView => view !== undefined,
    );
  }

  private buildBlocks(
    materials: ContextMaterials,
    include: ReadonlySet<ContextSlot>,
  ): ContextBlock[] {
    const blocks: ContextBlock[] = [];
    const redact = (value: string): { text: string; redactions: number } =>
      redactDiagnostics(value, this.homeDir);
    const push = (
      slot: ContextSlot,
      raw: string,
      items: number,
      available: boolean,
      note: string,
    ): void => {
      const redacted = redact(raw);
      blocks.push({
        slot,
        text: redacted.text,
        items,
        available,
        note,
        redactions: redacted.redactions,
      });
    };

    push(
      "prompt",
      `${materials.task.title}\n\n${materials.task.prompt}`,
      1,
      true,
      include.has("prompt")
        ? "Task title and prompt; every selection starts from this base."
        : "Not included: the preview starts from the bare task title only; the prompt body is not submitted.",
    );
    push(
      "acceptance",
      materials.criteria.map((criterion) => `[[${criterion.kind}]] ${criterion.text}`).join("\n"),
      materials.criteria.length,
      materials.criteria.length > 0,
      materials.criteria.length > 0
        ? `${materials.criteria.length} acceptance criteria recorded for this task.`
        : "No acceptance criteria recorded for this task.",
    );
    push(
      "requirements",
      `Requirements: ${materials.task.requirements.join(", ")}`,
      materials.task.requirements.length,
      materials.task.requirements.length > 0,
      materials.task.requirements.length > 0
        ? "Requirement ids recorded on the task."
        : "No requirement ids recorded on this task.",
    );
    const recentDecisions = materials.decisions.slice(-5);
    push(
      "decisions",
      recentDecisions
        .map(
          (decision) =>
            `Decision: ${decision.title} — ${clipChars(decision.body.replace(/\s+/g, " ").trim(), 200)}`,
        )
        .join("\n"),
      recentDecisions.length,
      recentDecisions.length > 0,
      recentDecisions.length > 0
        ? "The project's last 5 decisions."
        : "No project decisions recorded.",
    );
    push(
      "evidence_pointers",
      materials.evidence
        .map((entry) => `Evidence: ${entry.path} (${entry.requirementId})`)
        .join("\n"),
      materials.evidence.length,
      materials.evidence.length > 0,
      materials.evidence.length > 0
        ? "Evidence recorded for this task, as paths rather than contents."
        : "No evidence recorded for this task.",
    );
    const recentAttempts = materials.attempts.slice(-5);
    push(
      "prior_attempts",
      recentAttempts
        .map((attempt) => `Attempt: ${attempt.hypothesis} -> ${attempt.observed}`)
        .join("\n"),
      recentAttempts.length,
      recentAttempts.length > 0,
      recentAttempts.length > 0
        ? "The last 5 recorded attempts for this task."
        : "No attempts recorded for this task.",
    );
    push(
      "resume_packet",
      materials.resume.text,
      1,
      true,
      "The resume packet Mona would open the next session with.",
    );
    return blocks;
  }

  // -------------------------------------------------------------- internals

  private async requireProject(id: ProjectId): Promise<StoredProject> {
    const project = await this.store.getProject(id);
    if (!project) {
      throw new StateError("NOT_FOUND", `project ${id} does not exist`, { project_id: id });
    }
    return project;
  }

  /**
   * Load exactly the searchable sources the caller asked for. Bodies are
   * redacted once here, so a hit can never carry raw secret-shaped text.
   */
  private async collectRecords(
    projectId: ProjectId,
    wanted: ReadonlySet<MemorySource>,
  ): Promise<SearchRecord[]> {
    const records: SearchRecord[] = [];
    const home = this.homeDir;
    for (const source of MEMORY_SOURCES) {
      if (!wanted.has(source)) continue;
      switch (source) {
        case "task": {
          for (const task of await this.store.listTasks(projectId)) {
            const body = [task.prompt, task.nextStep ?? ""].filter((part) => part).join("\n");
            records.push(
              makeRecord(source, task.id, task.title, body, task.updatedAt, home, {
                kind: source,
                recordId: task.id,
                path: null,
              }),
            );
          }
          break;
        }
        case "decision": {
          for (const decision of await this.store.listDecisions(projectId)) {
            records.push(
              makeRecord(
                source,
                decision.id,
                decision.title,
                decision.body,
                decision.createdAt,
                home,
                { kind: source, recordId: decision.id, path: null },
              ),
            );
          }
          break;
        }
        case "evidence": {
          for (const entry of await this.store.listRequirementEvidence(projectId)) {
            records.push(
              makeRecord(
                source,
                entry.id,
                `${entry.requirementId}: ${entry.path}`,
                entry.note ?? "",
                entry.createdAt,
                home,
                { kind: source, recordId: entry.id, path: entry.path },
              ),
            );
          }
          break;
        }
        case "attempt": {
          for (const attempt of await this.store.listAttempts(projectId)) {
            const body = [attempt.symptom ?? "", attempt.action, attempt.observed]
              .filter((part) => part)
              .join("\n");
            records.push(
              makeRecord(source, attempt.id, attempt.hypothesis, body, attempt.createdAt, home, {
                kind: source,
                recordId: attempt.id,
                path: null,
              }),
            );
          }
          break;
        }
        case "problem": {
          for (const problem of await this.store.listProblems(projectId)) {
            records.push(
              makeRecord(
                source,
                problem.id,
                problem.symptom,
                problem.helpNeeded ?? "",
                problem.updatedAt,
                home,
                { kind: source, recordId: problem.id, path: null },
              ),
            );
          }
          break;
        }
        case "prompt": {
          if (!this.extraSources) break;
          for (const extra of await this.extraSources()) {
            records.push(
              makeRecord(
                source,
                extra.id,
                extra.title,
                extra.body,
                extra.updatedAt,
                home,
                extra.pointer,
              ),
            );
          }
          break;
        }
        case "thread": {
          for (const thread of await this.store.listThreads(projectId)) {
            records.push(
              makeRecord(
                source,
                thread.id,
                thread.title ?? "(untitled thread)",
                "",
                thread.updatedAt,
                home,
                { kind: source, recordId: thread.id, path: null },
              ),
            );
          }
          break;
        }
        case "artifact": {
          for (const artifact of await this.store.listArtifacts(projectId)) {
            // Metadata only: the bytes stay in the artifact store.
            records.push(
              makeRecord(
                source,
                artifact.id,
                artifact.source,
                artifactBody(artifact),
                artifact.createdAt,
                home,
                { kind: source, recordId: artifact.id, path: artifact.relPath },
              ),
            );
          }
          break;
        }
      }
    }
    return records;
  }

  private scoreRecord(
    record: SearchRecord,
    terms: readonly string[],
    wholeQuery: string,
  ): ScoredRecord | null {
    const title = record.title.toLowerCase();
    const body = record.body.toLowerCase();
    const matchedTerms = terms.filter((term) => title.includes(term) || body.includes(term));
    if (matchedTerms.length === 0) return null;
    let score = 0;
    if (wholeQuery && title.includes(wholeQuery)) score += MAX_TITLE_QUERY_SCORE;
    for (const term of terms) {
      if (title.includes(term)) score += MAX_TITLE_TERM_SCORE;
    }
    if (wholeQuery && body.includes(wholeQuery)) score += MAX_BODY_QUERY_SCORE;
    for (const term of terms) {
      if (body.includes(term)) score += MAX_BODY_TERM_SCORE;
    }
    let occurrences = 0;
    for (const term of matchedTerms) {
      occurrences += countOccurrences(title, term) + countOccurrences(body, term);
    }
    return {
      record,
      score: Math.min(score, MAX_SCORE),
      matchedTerms,
      occurrences,
    };
  }

  private compareScored(a: ScoredRecord, b: ScoredRecord): number {
    if (a.score !== b.score) return b.score - a.score;
    if (a.occurrences !== b.occurrences) return b.occurrences - a.occurrences;
    const sourceDelta =
      MEMORY_SOURCES.indexOf(a.record.source) - MEMORY_SOURCES.indexOf(b.record.source);
    if (sourceDelta !== 0) return sourceDelta;
    if (a.record.id === b.record.id) return 0;
    return a.record.id < b.record.id ? -1 : 1;
  }

  private toHit(entry: ScoredRecord, terms: readonly string[]): MemoryHit {
    const record = entry.record;
    const body = record.body.toLowerCase();
    const title = record.title.toLowerCase();
    const bodyTerm = terms.find((term) => body.includes(term)) ?? null;
    const titleTerm = terms.find((term) => title.includes(term)) ?? null;
    const snippetSource = bodyTerm ? record.body : record.title;
    const snippet = snippetFor(snippetSource, bodyTerm ?? titleTerm);
    return {
      id: record.id,
      source: record.source,
      title: record.title,
      snippet,
      score: entry.score,
      matchedTerms: entry.matchedTerms,
      occurrences: entry.occurrences,
      redactions: record.redactions,
      updatedAt: record.updatedAt,
      pointer: record.pointer,
    };
  }

  private pickCurrentTask(tasks: readonly StoredTask[]): StoredTask | null {
    const active = tasks.filter((task) => ACTIVE_TASK_STATES.has(task.status));
    if (active.length === 0) return null;
    const sorted = [...active].sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });
    return sorted[0] ?? null;
  }

  private engineLabel(): string {
    const info = this.engineInfo?.() ?? null;
    if (!info) return "not observed";
    const label = [info.version, info.commit].filter((part): part is string => Boolean(part));
    return label.length > 0 ? label.join(" ") : "not observed";
  }
}

// ------------------------------------------------------------ record helpers

function artifactBody(artifact: ArtifactRecord): string {
  return [artifact.mediaType, artifact.digest].filter((part) => part).join("\n");
}

function makeRecord(
  source: MemorySource,
  id: string,
  title: string,
  body: string,
  updatedAt: string,
  home: string,
  pointer: MemoryPointer,
): SearchRecord {
  const redactedTitle = redactDiagnostics(title, home);
  const redactedBody = redactDiagnostics(body, home);
  return {
    id,
    source,
    title: redactedTitle.text,
    body: redactedBody.text,
    updatedAt,
    pointer,
    redactions: redactedTitle.redactions + redactedBody.redactions,
  };
}
