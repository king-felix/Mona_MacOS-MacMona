import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  ArtifactDigestCheck,
  DiagnosticsPreview,
  HandoffEntry,
  HandoffImportResult,
  HandoffInspection,
  HandoffPreview,
  RequalificationView,
  SettingsBackupInspection,
  SettingsBackupScope,
  SettingsBackupView,
  SettingsRestoreResult,
} from "../../shared/contracts/memory";
import { StateError } from "../state/errors";
import {
  buildBundle,
  bundleToFileText,
  canonicalJson,
  verifyBundle,
  type PortablePayload,
  type ProjectBundle,
} from "../state/portable";
import {
  readArchiveFile,
  safeJoin,
  sha256Bytes,
  writeArchiveFile,
  type ArchiveEntry,
  type ArchiveEntryInput,
  type ArchiveProblem,
  type ArchiveReadResult,
} from "../state/safe-archive";
import type { StateStore } from "../state/store";
import { redactDiagnostics, scanForSecrets } from "./settings";

/**
 * Portable project handoff, settings backup/restore, and a redacted local
 * diagnostics bundle.
 *
 * A handoff carries Mona-owned records plus file pointers and digests. It never
 * carries engine sessions, runtime bindings, provider credentials, the
 * environment, artifact bytes, or source. Importing creates records in the local
 * store; it never dispatches a task, opens a thread, or starts the engine. This
 * module never reads `process.env` and never spawns the engine: the engine facts
 * used in diagnostics and requalification are injected by the caller.
 */

export const HANDOFF_FORMAT = "mona-handoff";
export const SETTINGS_BACKUP_FORMAT = "mona-settings-backup";

const DECISIONS_LIMIT_BYTES = 64 * 1024;
const STALE_DIGEST_LIMIT_BYTES = 16 * 1024 * 1024;
const PROMPT_SHELF_SCOPE = "prompts:shelf";
const CREDENTIAL_SCOPE = /credential|secret|token|key/i;

/** The fixed statement of what a handoff can never carry. */
const CANNOT_TRANSFER = [
  "engine conversation history and sessions",
  "runtime bindings, ports, and executable paths",
  "provider credentials and environment",
  "artifact bytes",
  "source files",
  "machine-local prompt favorites and rate cards",
];

const HANDOFF_EXCLUDED: Array<{ what: string; why: string }> = [
  {
    what: "engine conversation history and sessions",
    why: "the engine owns these on this machine; they are not portable",
  },
  {
    what: "runtime bindings, ports, and executable paths",
    why: "machine-local; the receiving machine resolves its own runtime",
  },
  {
    what: "provider credentials and environment",
    why: "never exported; the receiving machine authenticates for itself",
  },
  {
    what: "artifact bytes",
    why: "only artifact metadata and digests travel; bytes stay in the local store",
  },
  {
    what: "source files",
    why: "the bundle carries pointers to files, never a copy of a repository",
  },
  {
    what: "machine-local prompt favorites and rate cards",
    why: "their provenance points at this machine's engine and catalog",
  },
];

const DIAGNOSTICS_EXCLUDED = [
  "environment variables",
  "provider credentials",
  "engine config values",
  "settings values",
  "artifact bytes",
  "repository contents",
  "engine transcripts",
];

const PATH_KEYS = new Set(["rootPath", "canonicalPath", "repositoryRoot", "path"]);
const ENTRY_KINDS = new Set<HandoffEntry["kind"]>([
  "manifest",
  "project",
  "readme",
  "decisions",
  "prompts",
  "pointer",
  "other",
]);

export interface HandoffOptions {
  store: StateStore;
  now?: () => Date;
  homeDir?: string;
  /** Injected: never read env or spawn the engine from this module. */
  engineInfo?: () => {
    version: string | null;
    commit: string | null;
    binaryPresent: boolean;
    observedAt?: string | null;
  };
  productVersion?: string;
  /** Optional prompt pack contribution, supplied by the caller. */
  promptPack?: () => Promise<unknown | null>;
}

interface ManifestEntry {
  path: string;
  digest: string;
  size_bytes: number;
  kind: HandoffEntry["kind"];
}

interface HandoffManifest {
  format: string;
  format_version: number;
  created_at: string;
  digest: string;
  digest_algorithm: "sha256";
  entries: ManifestEntry[];
  cannot_transfer: string[];
}

interface ComposedEntry extends ArchiveEntryInput {
  kind: HandoffEntry["kind"];
}

interface EvidencePointer {
  requirementId: string;
  path: string;
  digest: string | null;
}

interface PointerCheck {
  missingLocalFiles: Array<{ path: string; requirement: string }>;
  staleDigests: Array<{ path: string; expected: string; actual: string | null }>;
}

interface RedactionTally {
  redactions: number;
}

interface ComposedHandoff {
  createdAt: Date;
  entries: ComposedEntry[];
  manifest: HandoffManifest;
  digest: string;
  redactions: number;
  bundle: ProjectBundle;
  pointers: EvidencePointer[];
  counts: HandoffPreview["counts"];
  artifactChecks: ArtifactDigestCheck[];
  /** The fixed exclusions plus any project setting this export had to drop. */
  excluded: HandoffPreview["excluded"];
  canExport: boolean;
  note: string;
}

interface InspectionResult {
  inspection: HandoffInspection;
  bundle: ProjectBundle | null;
  pointers: EvidencePointer[];
  digestFailure: boolean;
}

interface SettingsDocumentScope {
  scope: string;
  version: number;
  value: unknown;
}

interface SettingsBackupDocument {
  format: string;
  format_version: number;
  created_at: string;
  digest_algorithm: string;
  digest: string;
  scopes: SettingsDocumentScope[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problemText(code: string, message: string, path?: string): string {
  return path ? `${code}: ${message} (${path})` : `${code}: ${message}`;
}

function archiveProblemText(problem: ArchiveProblem): string {
  return problemText(problem.code, problem.message, problem.path || undefined);
}

/** sha256 over the sorted `path + "\0" + digest + "\n"` lines. */
function manifestDigest(entries: ReadonlyArray<{ path: string; digest: string }>): string {
  const lines = entries.map((entry) => `${entry.path}\0${entry.digest}\n`).sort();
  return sha256Bytes(Buffer.from(lines.join(""), "utf8"));
}

function valueDigest(value: unknown): string {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function settingsBackupDigest(
  scopes: ReadonlyArray<{ scope: string; version: number; digest: string }>,
): string {
  const ordered = [...scopes]
    .sort((left, right) => (left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0))
    .map((scope) => ({ scope: scope.scope, version: scope.version, digest: scope.digest }));
  return sha256Bytes(Buffer.from(canonicalJson(ordered), "utf8"));
}

/**
 * Resolve an evidence pointer beneath `root`. Absolute pointers are accepted
 * only when they already sit under the root; everything else is passed through
 * `safeJoin`, which refuses `..`, absolute, and otherwise escaping names. A null
 * result means "do not follow this path".
 */
function resolvePointerPath(root: string, pointerPath: string): string | null {
  if (!root.startsWith("/")) return null;
  const base = resolve(root);
  let relative: string;
  if (isAbsolute(pointerPath)) {
    if (pointerPath !== base && !pointerPath.startsWith(`${base}${sep}`)) return null;
    relative = pointerPath === base ? "" : pointerPath.slice(base.length + 1);
  } else {
    // A pointer recorded with a leading slash is root-relative, never host-absolute.
    relative = pointerPath.replace(/^\/+/, "");
  }
  if (relative.length === 0) return null;
  try {
    return safeJoin(base, relative);
  } catch {
    return null;
  }
}

export class ProjectHandoff {
  private readonly store: StateStore;
  private readonly now: () => Date;
  private readonly homeDir: string;
  private readonly engineInfo: HandoffOptions["engineInfo"];
  private readonly productVersion: string;
  private readonly promptPack: HandoffOptions["promptPack"];

  constructor(options: HandoffOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.homeDir = options.homeDir ?? homedir();
    this.engineInfo = options.engineInfo;
    this.productVersion = options.productVersion ?? "unknown";
    this.promptPack = options.promptPack;
  }

  // --------------------------------------------------------------- handoff

  async preview(projectId: string): Promise<HandoffPreview> {
    const composed = await this.compose(projectId, this.now());
    const entries: HandoffEntry[] = composed.entries.map((entry) => ({
      path: entry.path,
      digest: sha256Bytes(entry.data),
      sizeBytes: entry.data.length,
      kind: entry.kind,
    }));
    return {
      projectId,
      projectName: composed.bundle.payload.project.name,
      generatedAt: composed.createdAt.toISOString(),
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      counts: composed.counts,
      redactions: composed.redactions,
      artifactChecks: composed.artifactChecks,
      excluded: composed.excluded,
      canExport: composed.canExport,
      projectRevision: composed.bundle.payload.project.revision,
      note: composed.note,
    };
  }

  async exportToFile(
    projectId: string,
    destination: string,
  ): Promise<{
    saved: boolean;
    path: string | null;
    digest: string;
    entries: number;
    bytes: number;
    redactions: number;
  }> {
    const composed = await this.compose(projectId, this.now());
    if (existsSync(destination)) {
      throw new StateError("CONFLICT", "a file already exists at the handoff destination", {
        path: destination,
      });
    }
    // The only writer: a store-only zip at mode 0600.
    const buffer = writeArchiveFile(
      destination,
      composed.entries.map((entry) => ({ path: entry.path, data: entry.data })),
    );
    return {
      saved: true,
      path: destination,
      digest: composed.digest,
      entries: composed.entries.length,
      bytes: buffer.length,
      redactions: composed.redactions,
    };
  }

  async inspect(path: string): Promise<HandoffInspection> {
    return (await this.inspectInternal(path)).inspection;
  }

  async importFrom(request: {
    path: string;
    rootPath?: string;
    mode?: "create" | "replace";
    expectedRevision?: number;
  }): Promise<HandoffImportResult & { artifactChecks: ArtifactDigestCheck[] }> {
    const inspected = await this.inspectInternal(request.path);
    if (!inspected.inspection.ok || !inspected.bundle) {
      throw new StateError(
        inspected.digestFailure ? "IMPORT_DIGEST_MISMATCH" : "IMPORT_INVALID",
        inspected.digestFailure
          ? "handoff bundle digest does not match its contents"
          : "handoff bundle is not valid for import",
        { problems: inspected.inspection.problems.slice(0, 20) },
      );
    }
    const bundle = inspected.bundle;
    // Inspection checks pointers against the bundle's recorded root. Import
    // additionally knows the destination root, so a deliberate rebind is
    // checked against where the files will actually be looked up.
    const pointers = request.rootPath
      ? this.checkPointers(request.rootPath, inspected.pointers)
      : {
          missingLocalFiles: inspected.inspection.missingLocalFiles,
          staleDigests: inspected.inspection.staleDigests,
        };
    // Parsed in memory only: nothing is extracted to disk.
    const result = await this.store.importProject(bundle, {
      rootPath: request.rootPath,
      mode: request.mode,
      expectedRevision: request.expectedRevision,
    });
    return {
      projectId: result.project.id,
      projectName: result.project.name,
      mode: result.mode,
      imported: {
        tasks: result.imported.tasks,
        decisions: result.imported.decisions,
        evidence: result.imported.evidence,
        attempts: result.imported.attempts,
        acceptance: bundle.payload.acceptance?.length ?? 0,
        steps: bundle.payload.steps?.length ?? 0,
      },
      missingLocalFiles: pointers.missingLocalFiles,
      staleDigests: pointers.staleDigests,
      artifactChecks: inspected.inspection.artifactChecks,
      requalification: inspected.inspection.requalification,
      // Nothing dispatches a task, opens a thread, or starts the engine.
      startedWork: false,
      // Import applies no redaction of its own: the bundle text was redacted at
      // export, so nothing here rewrites a record.
      redactions: 0,
      problems: [],
    };
  }

  // -------------------------------------------------------------- settings

  async settingsBackup(): Promise<SettingsBackupView> {
    const generatedAt = this.now();
    const listed = [...(await this.store.listSettingsScopes())].sort((left, right) =>
      left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0,
    );
    const rows: SettingsBackupScope[] = [];
    const excluded: Array<{ scope: string; why: string }> = [];
    const included: Array<{ scope: string; version: number; digest: string; value: unknown }> = [];

    for (const entry of listed) {
      const stored = await this.store.getSettings(entry.scope);
      if (!stored) continue;
      if (CREDENTIAL_SCOPE.test(entry.scope)) {
        rows.push({
          scope: entry.scope,
          version: stored.version,
          // An excluded scope never carries a digest of its value.
          digest: "",
          sizeBytes: 0,
          included: false,
          reason: "credential-bearing scope",
        });
        excluded.push({ scope: entry.scope, why: "credential-bearing scope" });
        continue;
      }
      const serialized = JSON.stringify(stored.value);
      const classes = scanForSecrets(serialized);
      if (classes.length > 0) {
        const why = `secret-shaped value (${classes.join(", ")})`;
        rows.push({
          scope: entry.scope,
          version: stored.version,
          digest: "",
          sizeBytes: Buffer.byteLength(serialized, "utf8"),
          included: false,
          reason: why,
        });
        excluded.push({ scope: entry.scope, why });
        continue;
      }
      const digest = valueDigest(stored.value);
      rows.push({
        scope: entry.scope,
        version: stored.version,
        digest,
        sizeBytes: Buffer.byteLength(serialized, "utf8"),
        included: true,
        reason: null,
      });
      included.push({ scope: entry.scope, version: stored.version, digest, value: stored.value });
    }

    const digest = settingsBackupDigest(included);
    const document: SettingsBackupDocument = {
      format: SETTINGS_BACKUP_FORMAT,
      format_version: 1,
      created_at: generatedAt.toISOString(),
      digest_algorithm: "sha256",
      digest,
      scopes: included.map((entry) => ({
        scope: entry.scope,
        version: entry.version,
        value: entry.value,
      })),
    };
    return {
      generatedAt: generatedAt.toISOString(),
      scopes: rows,
      excluded,
      digest,
      // The exact document that would be written.
      text: canonicalJson(document),
      stateRevision: await this.store.stateRevision(),
      note:
        excluded.length === 0
          ? "Only Mona's versioned settings table is backed up. Engine config files and the environment are never read; every scope value is screened, and anything credential-bearing is excluded before the document is built."
          : `${excluded.length} scope(s) were excluded; a credential-bearing or secret-shaped scope never leaves this machine.`,
    };
  }

  async exportSettingsToFile(destination: string): Promise<{
    saved: boolean;
    path: string | null;
    digest: string;
    scopes: number;
    bytes: number;
  }> {
    const backup = await this.settingsBackup();
    if (existsSync(destination)) {
      throw new StateError("CONFLICT", "a file already exists at the settings destination", {
        path: destination,
      });
    }
    // One code path for every archive this module writes: a store-only zip with
    // one `settings.json` entry, created 0600 by `writeArchiveFile`.
    const buffer = writeArchiveFile(destination, [
      { path: "settings.json", data: Buffer.from(backup.text, "utf8") },
    ]);
    return {
      saved: true,
      path: destination,
      digest: backup.digest,
      scopes: backup.scopes.filter((scope) => scope.included).length,
      bytes: buffer.length,
    };
  }

  async inspectSettingsBackup(path: string): Promise<SettingsBackupInspection> {
    const { document, problems } = this.readSettingsDocument(path);
    const scopes: SettingsBackupInspection["scopes"] = [];
    if (document) {
      for (const entry of document.scopes) {
        const local = await this.store.getSettings(entry.scope);
        const localVersion = local ? local.version : null;
        const digest = valueDigest(entry.value);
        let action: "create" | "update" | "noop" | "downgrade";
        if (!local) action = "create";
        else if (local.version < entry.version) action = "update";
        else if (local.version > entry.version) action = "downgrade";
        else action = valueDigest(local.value) === digest ? "noop" : "update";
        scopes.push({
          scope: entry.scope,
          version: entry.version,
          digest,
          localVersion,
          action,
        });
      }
    }
    return {
      path,
      ok: document !== null && problems.length === 0,
      problems,
      scopes,
      digest: document?.digest ?? "",
      bytes: this.fileSize(path),
    };
  }

  async restoreSettings(request: {
    path: string;
    mode: "merge" | "replace";
    scopes?: string[];
    expectedRevision?: number;
    confirm?: boolean;
  }): Promise<SettingsRestoreResult> {
    const { document, problems } = this.readSettingsDocument(request.path);
    if (!document || problems.length > 0) {
      throw new StateError("IMPORT_INVALID", "settings backup is not valid", {
        problems: problems.slice(0, 20),
      });
    }
    if (request.mode === "replace" && request.confirm !== true) {
      throw new StateError("INVALID_INPUT", "a replace restore needs explicit confirmation");
    }
    // An early check gives a clear error before a snapshot is written; the
    // store re-checks the same revision inside its exclusive barrier, which is
    // where the guarantee actually holds against a concurrent writer.
    if (request.expectedRevision !== undefined) {
      const current = await this.store.stateRevision();
      if (current !== request.expectedRevision) {
        throw new StateError("STALE_REVISION", "state changed since the settings backup was read", {
          expected_revision: request.expectedRevision,
          actual_revision: current,
        });
      }
    }

    const requested = request.scopes ? new Set(request.scopes) : null;
    const skipped = new Map<string, string>();
    const selected: SettingsDocumentScope[] = [];
    for (const entry of document.scopes) {
      if (requested && !requested.has(entry.scope)) continue;
      // A credential-bearing scope is never written back, even if a hand-edited
      // backup names one: the reason is reported, the value is dropped.
      if (CREDENTIAL_SCOPE.test(entry.scope)) {
        skipped.set(entry.scope, "credential-bearing scope; a restore never writes it");
        continue;
      }
      selected.push(entry);
    }
    if (requested) {
      for (const scope of requested) {
        if (!document.scopes.some((entry) => entry.scope === scope)) {
          skipped.set(scope, "scope is not included in this backup");
        }
      }
    }
    const localScopes = await this.store.listSettingsScopes();
    // A replace must never destroy a credential or the prompt shelf.
    const preserveScopes = new Set<string>([PROMPT_SHELF_SCOPE]);
    for (const entry of localScopes) {
      if (CREDENTIAL_SCOPE.test(entry.scope)) {
        preserveScopes.add(entry.scope);
        if (!requested || requested.has(entry.scope)) {
          skipped.set(entry.scope, "credential-bearing scope; a restore never overwrites it");
        }
      }
    }

    const receipt = await this.store.restoreSettings(
      selected.map((entry) => ({ scope: entry.scope, value: entry.value })),
      {
        mode: request.mode,
        preserveScopes: [...preserveScopes],
        expectedRevision: request.expectedRevision,
      },
    );
    return {
      restored: true,
      applied: receipt.applied,
      reset: receipt.reset,
      skipped: [...skipped].map(([scope, reason]) => ({ scope, reason })),
      barrier: "exclusive",
      journal: receipt.journal,
      snapshot: receipt.snapshot,
      verification: receipt.verification,
      stateRevision: await this.store.stateRevision(),
    };
  }

  // ----------------------------------------------------------- diagnostics

  async diagnosticsPreview(projectId?: string | null): Promise<DiagnosticsPreview> {
    const generatedAt = this.now().toISOString();
    const engine = this.engineInfo?.() ?? {
      version: null,
      commit: null,
      binaryPresent: false,
    };
    const [stats, settingsScopes, retentionPlan] = await Promise.all([
      this.store.stats(),
      this.store.listSettingsScopes(),
      this.store.planRetention(),
    ]);
    const project = projectId ? await this.diagnosticsProject(projectId) : null;
    const document = {
      schema_version: 1 as const,
      product: "Mona" as const,
      product_version: this.productVersion,
      generated_at: generatedAt,
      engine: {
        version: engine.version,
        commit: engine.commit,
        binary_present: engine.binaryPresent,
      },
      state: {
        projects: stats.projects,
        tasks: stats.tasks,
        events: stats.events,
        artifacts: stats.artifacts,
        settings: stats.settings,
        state_revision: stats.stateRevision,
        integrity: stats.integrity,
      },
      // The home path is redacted below; the database file is named, never pathed.
      path: { support: this.homeDir, database_file: "mona.sqlite" },
      settings: settingsScopes.map((entry) => ({ scope: entry.scope, version: entry.version })),
      retention: {
        temporary: retentionPlan.candidates.filter(
          (artifact) => artifact.retentionClass === "temporary",
        ).length,
        diagnostic: retentionPlan.candidates.filter(
          (artifact) => artifact.retentionClass === "diagnostic",
        ).length,
        evidence: retentionPlan.protected.filter(
          (entry) => entry.artifact.retentionClass === "evidence",
        ).length,
        protected: retentionPlan.protected.length,
      },
      project,
      excluded: DIAGNOSTICS_EXCLUDED,
    };
    const raw = JSON.stringify(document, null, 2);
    const redacted = redactDiagnostics(raw, this.homeDir);
    const digest = sha256Bytes(Buffer.from(redacted.text, "utf8"));
    const bytes = Buffer.byteLength(redacted.text, "utf8");
    return {
      generatedAt,
      entries: [
        {
          name: "diagnostics.json",
          sizeBytes: bytes,
          digest,
          redactions: redacted.redactions,
        },
      ],
      text: redacted.text,
      bytes,
      digest,
      redactions: redacted.redactions,
      excluded: DIAGNOSTICS_EXCLUDED,
      environmentIncluded: false,
      credentialsIncluded: false,
      note: "Built from local state only: no environment, no credential, no settings value, no artifact bytes, and no process started. The engine identity it reports came from a stored capability snapshot.",
    };
  }

  // ------------------------------------------------------------- internals

  private async diagnosticsProject(projectId: string): Promise<{
    id: string;
    name: string;
    revision: number;
    tasks: number;
    decisions: number;
    evidence: number;
    artifacts: number;
  } | null> {
    const project = await this.store.getProject(projectId as ProjectId);
    if (!project) return null;
    const [tasks, decisions, evidence, artifacts] = await Promise.all([
      this.store.listTasks(project.id),
      this.store.listDecisions(project.id),
      this.store.listRequirementEvidence(project.id),
      this.store.listArtifacts(project.id),
    ]);
    return {
      id: project.id,
      name: project.name,
      revision: project.revision,
      tasks: tasks.length,
      decisions: decisions.length,
      evidence: evidence.length,
      artifacts: artifacts.length,
    };
  }

  /**
   * Assemble the bundle's entries in memory. `exportToFile` and `preview` share
   * this path, so a preview is exactly what an export would write.
   */
  private async compose(projectId: string, createdAt: Date): Promise<ComposedHandoff> {
    const tally: RedactionTally = { redactions: 0 };
    const exported = await this.store.exportProject(projectId as ProjectId);

    // The store's export excludes bindings, sessions, and credentials by
    // construction, but free text (a decision, a prompt, a note) can still hold
    // a secret-shaped string. Redact the payload's strings, then rebuild the
    // bundle so its own digest still covers the text that ships. Absolute path
    // fields keep their home prefix; they are paths, not credentials.
    const payloadTally: RedactionTally = { redactions: 0 };
    const redacted = this.redactPayload(exported.payload, payloadTally);
    // The project export carries `project:<id>` settings. A credential-bearing
    // scope, or a value that screens as secret-shaped, is dropped rather than
    // redacted: a bundle is not the place to prove a redactor worked.
    const droppedSettings: string[] = [];
    const keptSettings = redacted.settings.filter((setting) => {
      if (CREDENTIAL_SCOPE.test(setting.scope)) {
        droppedSettings.push(setting.scope);
        return false;
      }
      if (scanForSecrets(JSON.stringify(setting.value)).length > 0) {
        droppedSettings.push(setting.scope);
        return false;
      }
      return true;
    });
    const payload: PortablePayload =
      droppedSettings.length > 0 ? { ...redacted, settings: keptSettings } : redacted;
    const rebuilt = payloadTally.redactions > 0 || droppedSettings.length > 0;
    const bundle = rebuilt ? buildBundle(payload, createdAt) : exported;
    tally.redactions += payloadTally.redactions;
    const excluded: HandoffPreview["excluded"] = [
      ...HANDOFF_EXCLUDED,
      ...droppedSettings.map((scope) => ({
        what: `setting ${scope}`,
        why: CREDENTIAL_SCOPE.test(scope)
          ? "credential-bearing scope; a handoff never carries it"
          : "the value screened as secret-shaped, so it is dropped rather than redacted",
      })),
    ];

    const [decisions, evidence, artifacts] = await Promise.all([
      this.store.listDecisions(projectId as ProjectId),
      this.store.listRequirementEvidence(projectId as ProjectId),
      this.store.listArtifacts(projectId as ProjectId),
    ]);
    const pointers: EvidencePointer[] = evidence.map((record) => ({
      requirementId: record.requirementId,
      path: record.path,
      digest: record.digest,
    }));

    const decisionsRaw = decisions
      .map((decision) => `# ${decision.title}\n\n${decision.body}\n`)
      .join("\n");
    const decisionsText = this.redactText(decisionsRaw, tally).slice(0, DECISIONS_LIMIT_BYTES);
    const readmeText = this.redactText(this.readmeText(bundle), tally);

    const promptPack = this.promptPack ? await this.promptPack() : null;
    const promptList = (promptPack as { prompts?: unknown } | null)?.prompts;
    const prompts = promptPack === null ? 0 : Array.isArray(promptList) ? promptList.length : 1;

    const payloadEntries: ComposedEntry[] = [
      {
        path: "project.json",
        data: Buffer.from(bundleToFileText(bundle), "utf8"),
        kind: "project",
      },
      {
        path: "pointers.json",
        data: Buffer.from(canonicalJson({ evidence: pointers }), "utf8"),
        kind: "pointer",
      },
      {
        path: "decisions.md",
        data: Buffer.from(decisionsText, "utf8"),
        kind: "decisions",
      },
      {
        path: "README.md",
        data: Buffer.from(readmeText, "utf8"),
        kind: "readme",
      },
    ];
    if (promptPack !== null && promptPack !== undefined) {
      payloadEntries.push({
        path: "prompts.json",
        // The caller's prompt pack is text; it is written verbatim as canonical JSON.
        data: Buffer.from(canonicalJson(promptPack), "utf8"),
        kind: "prompts",
      });
    }

    const manifestEntries: ManifestEntry[] = payloadEntries.map((entry) => ({
      path: entry.path,
      digest: sha256Bytes(entry.data),
      size_bytes: entry.data.length,
      kind: entry.kind,
    }));
    const digest = manifestDigest(manifestEntries);
    const manifest: HandoffManifest = {
      format: HANDOFF_FORMAT,
      format_version: 1,
      created_at: createdAt.toISOString(),
      digest,
      digest_algorithm: "sha256",
      entries: manifestEntries,
      cannot_transfer: [...CANNOT_TRANSFER],
    };
    const manifestEntry: ComposedEntry = {
      path: "manifest.json",
      data: Buffer.from(canonicalJson(manifest), "utf8"),
      kind: "manifest",
    };
    const entries: ComposedEntry[] = [manifestEntry, ...payloadEntries];

    const counts: HandoffPreview["counts"] = {
      tasks: bundle.payload.tasks.length,
      decisions: bundle.payload.decisions.length,
      evidence: bundle.payload.evidence.length,
      attempts: bundle.payload.attempts.length,
      prompts,
      pointers: pointers.length,
    };
    const canExport = counts.tasks > 0 || counts.decisions > 0 || counts.evidence > 0;
    return {
      createdAt,
      entries,
      manifest,
      digest,
      redactions: tally.redactions,
      bundle,
      pointers,
      counts,
      excluded,
      artifactChecks: this.artifactChecks(
        artifacts.map((artifact) => ({
          id: artifact.id,
          digest: artifact.digest,
          relPath: artifact.relPath,
        })),
      ),
      canExport,
      note: canExport
        ? "A store-only zip of Mona-owned records, file pointers, and digests. Importing starts no work."
        : "An empty handoff is not useful: this project has no tasks, decisions, or evidence to carry.",
    };
  }

  private readmeText(bundle: ProjectBundle): string {
    return [
      "# Mona project handoff",
      "",
      `This bundle carries Mona-owned records for "${bundle.payload.project.name}": the`,
      "project export (project.json), requirement evidence pointers (pointers.json),",
      "project decisions (decisions.md), and this note.",
      "",
      "It cannot transfer:",
      ...CANNOT_TRANSFER.map((item) => `- ${item}`),
      "",
      "Importing a bundle only creates records in Mona's local state. It does not",
      "start a task, open a thread, or start the engine.",
      "",
      "Engine sessions on another machine are inaccessible from this machine: the",
      "engine history that produced these records is not in this bundle.",
      "",
    ].join("\n");
  }

  private redactText(text: string, tally: RedactionTally, home = true): string {
    const result = redactDiagnostics(text, home ? this.homeDir : "");
    tally.redactions += result.redactions;
    return result.text;
  }

  private redactPayload(payload: PortablePayload, tally: RedactionTally): PortablePayload {
    const walk = (value: unknown, key: string | null): unknown => {
      if (typeof value === "string") {
        return this.redactText(value, tally, !(key !== null && PATH_KEYS.has(key)));
      }
      if (Array.isArray(value)) return value.map((item) => walk(item, key));
      if (isRecord(value)) {
        const result: Record<string, unknown> = {};
        for (const [childKey, child] of Object.entries(value)) {
          result[childKey] = walk(child, childKey);
        }
        return result;
      }
      return value;
    };
    return walk(payload, null) as PortablePayload;
  }

  private requalification(): RequalificationView {
    const info = this.engineInfo?.() ?? null;
    const version = info?.version ?? null;
    const commit = info?.commit ?? null;
    const observedAt = info?.observedAt ?? null;
    return {
      required: true,
      reasons: [
        "Engine conversation sessions are not portable; this machine has no engine history for the project.",
        "Runtime bindings, ports, and executable paths are machine-local and are not carried.",
        "The engine version on this machine may differ from the version that wrote the bundle.",
      ],
      localEngine: { version, commit, checked: version !== null, observedAt },
      source: version !== null ? "capability_snapshot" : "none",
      machineBinding: version !== null ? "requalified" : "unavailable",
      note:
        version !== null
          ? `A local engine version (${version}) is recorded${observedAt ? ` as of ${observedAt}` : ""} from the capability inventory. No probe ran for this bundle; engine work still needs live qualification on this machine.`
          : "No engine version is recorded on this machine yet, so the bundle is not qualified for it. Run the capability explorer, then re-inspect.",
    };
  }

  private fileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private checkPointers(rootPath: string | null, pointers: EvidencePointer[]): PointerCheck {
    const missingLocalFiles: PointerCheck["missingLocalFiles"] = [];
    const staleDigests: PointerCheck["staleDigests"] = [];
    for (const pointer of pointers) {
      const target = rootPath ? resolvePointerPath(rootPath, pointer.path) : null;
      const report = (): void => {
        missingLocalFiles.push({ path: pointer.path, requirement: pointer.requirementId });
      };
      if (!target) {
        report();
        continue;
      }
      let size: number;
      try {
        const stats = statSync(target);
        if (!stats.isFile()) {
          report();
          continue;
        }
        size = stats.size;
      } catch {
        report();
        continue;
      }
      if (!pointer.digest) continue;
      if (size > STALE_DIGEST_LIMIT_BYTES) {
        // Too large to re-read cheaply; reported without a staleness claim.
        staleDigests.push({ path: pointer.path, expected: pointer.digest, actual: null });
        continue;
      }
      try {
        const actual = sha256Bytes(readFileSync(target));
        if (actual !== pointer.digest) {
          staleDigests.push({ path: pointer.path, expected: pointer.digest, actual });
        }
      } catch {
        report();
      }
    }
    return { missingLocalFiles, staleDigests };
  }

  private artifactChecks(
    records: ReadonlyArray<{ id: string; digest: string; relPath?: string | null }>,
  ): ArtifactDigestCheck[] {
    return records.map((record) => {
      let relPath: string | null = null;
      try {
        relPath = this.store.artifactFiles.find(record.digest);
      } catch {
        relPath = null;
      }
      if (!relPath && record.relPath) {
        try {
          if (existsSync(this.store.artifactFiles.absolute(record.relPath))) {
            relPath = record.relPath;
          }
        } catch {
          relPath = null;
        }
      }
      if (!relPath) {
        return {
          artifactId: record.id,
          digest: record.digest,
          relPath: record.relPath ?? "",
          present: false,
          matches: false,
          note: "artifact bytes are not carried by a handoff and were not found in the local store",
        };
      }
      try {
        const actual = sha256Bytes(readFileSync(this.store.artifactFiles.absolute(relPath)));
        const matches = actual === record.digest;
        return {
          artifactId: record.id,
          digest: record.digest,
          relPath,
          present: true,
          matches,
          note: matches
            ? "local artifact bytes match the recorded digest"
            : "local artifact bytes do not match the recorded digest",
        };
      } catch {
        return {
          artifactId: record.id,
          digest: record.digest,
          relPath,
          present: true,
          matches: false,
          note: "artifact file is present but could not be read",
        };
      }
    });
  }

  private async inspectInternal(path: string): Promise<InspectionResult> {
    let archive: ArchiveReadResult;
    try {
      archive = readArchiveFile(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        inspection: {
          path,
          ok: false,
          problems: [problemText("READ_FAILED", message)],
          manifest: null,
          project: null,
          missingLocalFiles: [],
          staleDigests: [],
          artifactChecks: [],
          requalification: this.requalification(),
          cannotTransfer: [...CANNOT_TRANSFER],
          bytes: 0,
        },
        bundle: null,
        pointers: [],
        digestFailure: false,
      };
    }

    const problems = archive.problems.map(archiveProblemText);
    let digestFailure = false;
    const entriesByPath = new Map<string, ArchiveEntry>();
    for (const entry of archive.entries) entriesByPath.set(entry.path, entry);
    const manifestEntry = entriesByPath.get("manifest.json");
    const projectEntry = entriesByPath.get("project.json");

    let manifestView: HandoffInspection["manifest"] = null;
    let cannotTransfer: string[] = [...CANNOT_TRANSFER];
    const listedPaths = new Set<string>();

    if (!manifestEntry) {
      problems.push(problemText("MISSING_ENTRY", "manifest.json is required"));
    } else {
      let parsed: unknown = null;
      let parseFailed = false;
      try {
        parsed = JSON.parse(manifestEntry.data.toString("utf8"));
      } catch {
        parseFailed = true;
        problems.push(problemText("MALFORMED", "manifest.json is not valid JSON"));
      }
      if (!isRecord(parsed)) {
        if (!parseFailed) {
          problems.push(problemText("MALFORMED", "manifest.json is not a JSON object"));
        }
      } else {
        const format = typeof parsed.format === "string" ? parsed.format : "";
        const formatVersion = typeof parsed.format_version === "number" ? parsed.format_version : 0;
        const digest = typeof parsed.digest === "string" ? parsed.digest : "";
        const createdAt = typeof parsed.created_at === "string" ? parsed.created_at : "";
        manifestView = {
          format,
          format_version: formatVersion,
          digest,
          created_at: createdAt,
        };
        if (format !== HANDOFF_FORMAT) {
          problems.push(
            problemText("FORMAT", `manifest format is "${format}", expected "${HANDOFF_FORMAT}"`),
          );
        }
        if (Array.isArray(parsed.cannot_transfer)) {
          cannotTransfer = parsed.cannot_transfer.filter(
            (item): item is string => typeof item === "string",
          );
        }
        const listed: ManifestEntry[] = [];
        const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
        if (!Array.isArray(parsed.entries)) {
          problems.push(problemText("MALFORMED", "manifest.json has no entries list"));
        }
        for (const raw of rawEntries) {
          if (
            !isRecord(raw) ||
            typeof raw.path !== "string" ||
            typeof raw.digest !== "string" ||
            typeof raw.size_bytes !== "number"
          ) {
            problems.push(problemText("MALFORMED", "manifest.json has an unreadable entry"));
            continue;
          }
          const kind = ENTRY_KINDS.has(raw.kind as HandoffEntry["kind"])
            ? (raw.kind as HandoffEntry["kind"])
            : "other";
          listed.push({
            path: raw.path,
            digest: raw.digest,
            size_bytes: raw.size_bytes,
            kind,
          });
          listedPaths.add(raw.path);
        }
        for (const meta of listed) {
          const actual = entriesByPath.get(meta.path);
          if (!actual) {
            problems.push(
              problemText(
                "MISSING_ENTRY",
                `${meta.path} is listed in the manifest but absent from the archive`,
              ),
            );
            digestFailure = true;
            continue;
          }
          if (actual.digest !== meta.digest) {
            problems.push(
              problemText("DIGEST_MISMATCH", `${meta.path} does not match its manifest digest`),
            );
            digestFailure = true;
          }
          if (actual.data.length !== meta.size_bytes) {
            problems.push(
              problemText("SIZE_MISMATCH", `${meta.path} does not match its manifest size`),
            );
            digestFailure = true;
          }
        }
        if (!listed.some((meta) => meta.path === "project.json")) {
          problems.push(problemText("MALFORMED", "manifest.json does not list project.json"));
          digestFailure = true;
        }
        // The manifest digest covers every entry except manifest.json itself.
        const covered = listed.filter((meta) => meta.path !== "manifest.json");
        const expected = manifestDigest(covered);
        if (manifestView.digest !== expected) {
          problems.push(
            problemText("DIGEST_MISMATCH", "manifest digest does not cover its entries"),
          );
          digestFailure = true;
        }
      }
    }

    for (const entry of archive.entries) {
      if (entry.path !== "manifest.json" && !listedPaths.has(entry.path)) {
        problems.push(problemText("UNLISTED_ENTRY", `${entry.path} is not in the manifest`));
      }
    }

    let bundle: ProjectBundle | null = null;
    if (!projectEntry) {
      problems.push(problemText("MISSING_ENTRY", "project.json is required"));
    } else {
      let parsed: unknown = null;
      let parseFailed = false;
      try {
        parsed = JSON.parse(projectEntry.data.toString("utf8"));
      } catch {
        parseFailed = true;
        problems.push(problemText("MALFORMED", "project.json is not valid JSON"));
      }
      if (!parseFailed && parsed !== null) {
        const verified = verifyBundle(parsed);
        for (const problem of verified.problems) {
          problems.push(problemText("BUNDLE", problem.message, problem.path));
          if (problem.path === "digest") digestFailure = true;
        }
        bundle = verified.bundle;
      }
    }

    let pointers: EvidencePointer[] = [];
    const pointersEntry = entriesByPath.get("pointers.json");
    if (pointersEntry) {
      try {
        const doc = JSON.parse(pointersEntry.data.toString("utf8")) as unknown;
        const list = isRecord(doc) && Array.isArray(doc.evidence) ? doc.evidence : [];
        for (const raw of list) {
          if (
            !isRecord(raw) ||
            typeof raw.path !== "string" ||
            typeof raw.requirementId !== "string"
          ) {
            problems.push(problemText("MALFORMED", "pointers.json has an unreadable pointer"));
            continue;
          }
          pointers.push({
            requirementId: raw.requirementId,
            path: raw.path,
            digest: typeof raw.digest === "string" ? raw.digest : null,
          });
        }
      } catch {
        problems.push(problemText("MALFORMED", "pointers.json is not valid JSON"));
      }
    } else if (bundle) {
      pointers = bundle.payload.evidence.map((record) => ({
        requirementId: record.requirementId,
        path: record.path,
        digest: record.digest,
      }));
    }

    const rootPath = bundle ? bundle.payload.project.rootPath : null;
    const { missingLocalFiles, staleDigests } = this.checkPointers(rootPath, pointers);
    const artifactChecks = bundle
      ? this.artifactChecks(
          bundle.payload.artifacts.map((artifact) => ({
            id: artifact.id,
            digest: artifact.digest,
            relPath: null,
          })),
        )
      : [];

    const project =
      bundle === null
        ? null
        : {
            id: bundle.payload.project.id,
            name: bundle.payload.project.name,
            rootPath: bundle.payload.project.rootPath,
            revision: bundle.payload.project.revision,
            tasks: bundle.payload.tasks.length,
            decisions: bundle.payload.decisions.length,
            evidence: bundle.payload.evidence.length,
            attempts: bundle.payload.attempts.length,
          };

    return {
      inspection: {
        path,
        ok: problems.length === 0,
        problems,
        manifest: manifestView,
        project,
        missingLocalFiles,
        staleDigests,
        artifactChecks,
        requalification: this.requalification(),
        cannotTransfer,
        bytes: this.fileSize(path),
      },
      bundle,
      pointers,
      digestFailure,
    };
  }

  private readSettingsDocument(path: string): {
    document: SettingsBackupDocument | null;
    problems: string[];
  } {
    let archive: ArchiveReadResult;
    try {
      archive = readArchiveFile(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { document: null, problems: [problemText("READ_FAILED", message)] };
    }
    const problems = archive.problems.map(archiveProblemText);
    const entry = archive.entries.find((candidate) => candidate.path === "settings.json");
    if (!entry) {
      problems.push(problemText("MISSING_ENTRY", "settings.json is required"));
      return { document: null, problems };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(entry.data.toString("utf8"));
    } catch {
      problems.push(problemText("MALFORMED", "settings.json is not valid JSON"));
      return { document: null, problems };
    }
    if (!isRecord(parsed)) {
      problems.push(problemText("MALFORMED", "settings.json is not a JSON object"));
      return { document: null, problems };
    }
    if (parsed.format !== SETTINGS_BACKUP_FORMAT) {
      problems.push(
        problemText(
          "FORMAT",
          `settings backup format is "${String(parsed.format)}", expected "${SETTINGS_BACKUP_FORMAT}"`,
        ),
      );
    }
    if (parsed.digest_algorithm !== "sha256") {
      problems.push(problemText("FORMAT", "settings backup digest algorithm is not sha256"));
    }
    if (
      typeof parsed.digest !== "string" ||
      typeof parsed.created_at !== "string" ||
      typeof parsed.format_version !== "number" ||
      !Array.isArray(parsed.scopes)
    ) {
      problems.push(problemText("MALFORMED", "settings.json is missing required fields"));
      return { document: null, problems };
    }
    const scopes: SettingsDocumentScope[] = [];
    for (const raw of parsed.scopes) {
      if (
        !isRecord(raw) ||
        typeof raw.scope !== "string" ||
        typeof raw.version !== "number" ||
        !Number.isInteger(raw.version) ||
        raw.version < 1 ||
        !("value" in raw)
      ) {
        problems.push(problemText("MALFORMED", "settings.json has an unreadable scope"));
        continue;
      }
      scopes.push({ scope: raw.scope, version: raw.version, value: raw.value });
    }
    if (new Set(scopes.map((scope) => scope.scope)).size !== scopes.length) {
      problems.push(problemText("MALFORMED", "settings backup repeats a scope"));
    }
    const document: SettingsBackupDocument = {
      format: typeof parsed.format === "string" ? parsed.format : "",
      format_version: parsed.format_version,
      created_at: parsed.created_at,
      digest_algorithm: typeof parsed.digest_algorithm === "string" ? parsed.digest_algorithm : "",
      digest: parsed.digest,
      scopes,
    };
    const expected = settingsBackupDigest(
      scopes.map((scope) => ({
        scope: scope.scope,
        version: scope.version,
        digest: valueDigest(scope.value),
      })),
    );
    if (expected !== document.digest) {
      problems.push(
        problemText("DIGEST_MISMATCH", "settings backup digest does not cover its scopes"),
      );
    }
    return { document, problems };
  }
}
