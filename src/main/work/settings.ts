import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  CredentialClearReceipt,
  CredentialReceipt,
  EngineRouteView,
  ModelCatalogView,
  ModelView,
  ProviderCatalogView,
  ReasoningControlView,
  ReasoningSupportView,
  RouteChangeReceipt,
  RouteView,
  SavedRouteView,
  SettingsDiagnosticsView,
  SettingsSnapshot,
} from "../../shared/contracts/settings";
import type { StudioSnapshot } from "../../shared/contracts/studio";
import type {
  EngineModelCatalog,
  EngineProviderCatalog,
  EngineRuntimeConfig,
  EngineSettingsAdapter,
} from "../engine/types";
import { resolveEngineBinary } from "../engine/runtime-process";
import type { StateStore } from "../state/store";
import {
  DECLARED_REASONING_EFFORT,
  DEFAULT_EXECUTION_PROFILE,
  PROFILE_SCOPE,
  REASONING_DISPLAY_SCOPE,
  loadReasoningDisplay,
  parseExecutionProfile,
  type ExecutionProfile,
} from "./profile";
import {
  customEndpointConfigured,
  deriveReasoningSupport,
  describeInheritance,
  readEngineCatalogModelFactsBatch,
  type EngineCatalogModelFacts,
} from "./reasoning";

const PROVIDER_CACHE = "engine:provider-cache";
const MODEL_CACHE = "engine:model-cache:";
const PROVIDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HOME = homedir();

/**
 * Replace a leading home directory with `~`. The separator check matters: a
 * prefix match alone would turn `/Users/victor2/x` into `~2/x` when the home is
 * `/Users/victor`, which names a different file. One implementation, so the four
 * screens that redact paths cannot drift apart.
 */
export function redactHomePath(path: string, home: string = HOME): string {
  if (!home || home.length <= 1) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export class SettingsError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_UNAVAILABLE"
      | "CONFIG_STALE"
      | "INVALID_ROUTE"
      | "CREDENTIAL_REFUSED"
      | "DIAGNOSTICS_FAILED",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface SettingsEngineAccess {
  adapter: EngineSettingsAdapter;
  workspace: string;
}

export interface RouteWorkbenchOptions {
  store: StateStore;
  engine: (projectId: ProjectId) => SettingsEngineAccess | null;
  studio: (projectId: ProjectId) => Promise<StudioSnapshot | null>;
  /** Per-user product backup directory (not the repository). */
  backupDir: string;
  now?: () => Date;
  engineBinary?: () => string;
  /** Override for fixtures and tests; defaults to the process user's home. */
  homeDir?: string;
  /** Override for the engine config directory; defaults to CODEWHALE_HOME. */
  configRoot?: string;
  runDoctor?: (
    command: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  /**
   * Called after the transcript preference is written, so an already-open studio
   * re-reads its snapshot instead of showing a stale transcript until the next
   * unrelated push. Display only: it never sends anything to the engine.
   */
  onDisplayChanged?: (projectId: ProjectId) => void;
}

/**
 * The stored engine-route projection. It deliberately holds only the endpoint
 * authority (scheme + host): a configured base URL may carry userinfo or a
 * query token, and a cached copy on disk must never duplicate a credential.
 */
interface StoredEngineRoute {
  readAt: string;
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  endpointAuthority: string | null;
  endpointStatus: EngineRouteView["endpointStatus"];
  approvalMode: string | null;
  sandboxMode: string | null;
  allowShell: boolean | null;
}

interface BackupRecord {
  path: string;
  sha256: string;
  bytes: number;
}

interface ConfigWriteContext {
  configPath: string;
  settingsPath: string;
  revision: string | null;
  bytes: Buffer | null;
}

/**
 * A built-in provider repeats its canonical id in `model_provider_id`, so the
 * screen hands back `exactId: "deepseek"` for the plain `deepseek` route. That is
 * the generic route, not a named one: only a genuinely different identity names a
 * custom endpoint. One helper so the catalog read, the cache key, the validation,
 * and the stored profile cannot disagree about which route is being described.
 */
export function routeExactId(provider: string, exactId: string | null | undefined): string | null {
  if (typeof exactId !== "string" || exactId.length === 0) return null;
  return exactId === provider ? null : exactId;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

/** Scheme + host only. Userinfo, path, query, and fragment never reach the UI. */
export function endpointAuthority(value: string | null): {
  authority: string | null;
  status: EngineRouteView["endpointStatus"];
} {
  if (!value) return { authority: null, status: "unknown" };
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { authority: null, status: "malformed" };
    }
    if (!url.hostname) return { authority: null, status: "malformed" };
    return { authority: `${url.protocol}//${url.host}`, status: "configured" };
  } catch {
    return { authority: null, status: "malformed" };
  }
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]",
  ],
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]"],
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|authorization)\s*[=:]\s*["']?)[^\s"',}]{4,}/gi,
    "$1[redacted]",
  ],
  [/([?&](?:key|token|secret|password|signature)=)[^&\s]+/gi, "$1[redacted]"],
  [/\/\/[^/\s@]+@/g, "//[redacted]@"],
  [/([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)[^\s]+/g, "$1[redacted]"],
];

/**
 * Pattern classes the redactor recognises. A scanner reports the class, never
 * the matched value: a caller can refuse or count a finding without echoing it.
 */
export const SECRET_CLASSES = [
  "private_key",
  "provider_key",
  "bearer_token",
  "assignment_secret",
  "url_secret",
  "url_userinfo",
  "environment_secret",
] as const;
export type SecretClass = (typeof SECRET_CLASSES)[number];

/**
 * Report which secret-shaped classes appear in `text`. Values are never
 * returned. Used by the prompt shelf and handoff exporter to refuse or redact
 * before anything is persisted or packed.
 */
export function scanForSecrets(text: string): SecretClass[] {
  const found = new Set<SecretClass>();
  SECRET_PATTERNS.forEach(([pattern], index) => {
    const label = SECRET_CLASSES[index];
    if (!label) return;
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const probe = new RegExp(pattern.source, flags);
    if (probe.test(text)) found.add(label);
  });
  return [...found];
}

/**
 * Redact a diagnostics payload before it leaves the machine. It is exported for
 * the acceptance test that scans the exported document for secret material.
 */
export function redactDiagnostics(
  input: string,
  home: string = HOME,
): { text: string; redactions: number } {
  let text = input;
  let redactions = 0;
  if (home && home.length > 1) {
    const occurrences = text.split(home).length - 1;
    if (occurrences > 0) {
      text = text.split(home).join("~");
      redactions += occurrences;
    }
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args) => {
      redactions += 1;
      for (let index = args.length - 1; index >= 0; index -= 1) {
        const value = args[index];
        if (typeof value === "string" && replacement.includes(`$${index}`)) {
          return replacement.replace(`$${index}`, value);
        }
      }
      return replacement;
    });
  }
  return { text, redactions };
}

export class RouteWorkbench {
  private readonly store: StateStore;
  private readonly engine: RouteWorkbenchOptions["engine"];
  private readonly studio: RouteWorkbenchOptions["studio"];
  private readonly backupDir: string;
  private readonly now: () => Date;
  private readonly engineBinary: () => string;
  private readonly homeDir: string;
  private readonly configRoot: string;
  private readonly runDoctor: NonNullable<RouteWorkbenchOptions["runDoctor"]>;
  private readonly onDisplayChanged: NonNullable<RouteWorkbenchOptions["onDisplayChanged"]>;

  constructor(options: RouteWorkbenchOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.studio = options.studio;
    this.backupDir = options.backupDir;
    this.now = options.now ?? (() => new Date());
    this.engineBinary = options.engineBinary ?? (() => resolveEngineBinary().path);
    this.homeDir = options.homeDir ?? HOME;
    const fromEnv = process.env.CODEWHALE_HOME;
    this.configRoot =
      options.configRoot ??
      (fromEnv && fromEnv.startsWith("/") ? fromEnv : join(this.homeDir, ".codewhale"));
    this.runDoctor = options.runDoctor ?? defaultDoctorRunner;
    this.onDisplayChanged = options.onDisplayChanged ?? (() => undefined);
  }

  // ------------------------------------------------------------------ reading

  async snapshot(projectId: ProjectId): Promise<SettingsSnapshot> {
    const saved = await this.readSaved();
    const access = this.engine(projectId);
    const paths = this.paths();
    const studioSnapshot = await this.studio(projectId).catch(() => null);
    const observed = this.observedRoute(studioSnapshot, saved.profile);
    const showReasoning = await this.readReasoningDisplay();
    const policy = {
      autoRoute: false as const,
      fallback: "refuse" as const,
      note: "Mona never changes route on failure, never tries a second provider or model, and exposes no auto-router. A route failure stays on the configured route and is shown as an error.",
    };

    if (!access) {
      const config = await readBytes(paths.configPath);
      const engineDefault = await this.cachedEngineRoute();
      const models = await this.cachedModels(saved.profile.provider, saved.profile.exactId);
      return {
        projectId,
        runtime: "unavailable",
        runtimeNote:
          "The live engine is not connected. Saved defaults and the last cached catalog are shown; no value is invented and no setting is written without a live validation read.",
        savedDefault: saved.view,
        engineDefault,
        observed,
        providers: await this.cachedProviders(),
        models,
        reasoning: this.reasoningControl(
          saved.profile,
          models,
          engineDefault,
          showReasoning,
          observed,
          saved.declaredStored,
        ),
        policy,
        engineSelection: this.engineSelection(),
        engineConfigRevision: config ? hashBytes(config) : null,
        configPath: paths.configPath,
        settingsPath: paths.settingsPath,
        settingsRevision: saved.version,
      };
    }

    const providers = await this.readProviders(access);
    const models = await this.readModels(access, saved.profile.provider, saved.profile.exactId);
    const engineDefault = await this.readEngineRoute(access);
    const identity = await access.adapter.discover().catch(() => null);
    // Read the config revision after the catalog reads: an engine may lazily
    // rewrite its route document on first resolution, and the revision we hand
    // to the user must describe the document that a later action will see.
    const config = await readBytes(paths.configPath);
    return {
      projectId,
      runtime: "connected",
      runtimeNote: "Live provider and model catalogs were read from this project's engine.",
      savedDefault: this.validateSaved(saved, providers, models),
      engineDefault,
      observed,
      providers,
      models,
      reasoning: this.reasoningControl(
        saved.profile,
        models,
        engineDefault,
        showReasoning,
        observed,
        saved.declaredStored,
      ),
      policy,
      engineSelection: this.engineSelection(identity?.identity ?? null),
      engineConfigRevision: config ? hashBytes(config) : null,
      configPath: paths.configPath,
      settingsPath: paths.settingsPath,
      settingsRevision: saved.version,
    };
  }

  async models(
    projectId: ProjectId,
    provider: string,
    exactId: string | null,
  ): Promise<ModelCatalogView> {
    if (!PROVIDER.test(provider)) {
      throw new SettingsError("INVALID_ROUTE", "provider id is not a bounded identifier");
    }
    const access = this.engine(projectId);
    const normalized = routeExactId(provider, exactId);
    if (!access) return this.cachedModels(provider, normalized);
    return this.readModels(access, provider, normalized);
  }

  /**
   * The transcript preference is Mona's own display choice. It is stored
   * locally, never sent to the engine, and saving it never touches a route or a
   * turn. The snapshot returned after the write is the proof it persisted.
   */
  async setReasoningDisplay(input: { projectId: ProjectId; showReasoning: boolean }): Promise<{
    receipt: { persisted: boolean; showReasoning: boolean; note: string };
    snapshot: SettingsSnapshot;
  }> {
    await this.store.putSettings(REASONING_DISPLAY_SCOPE, {
      showReasoning: input.showReasoning,
      updatedAt: this.now().toISOString(),
      note: "Mona transcript preference; never sent to the engine.",
    });
    // The snapshot is taken after the write; only then is a listener told, so a
    // listener that re-reads observes the stored value.
    const snapshot = await this.snapshot(input.projectId);
    try {
      this.onDisplayChanged(input.projectId);
    } catch {
      // A listener that went away must not fail the write.
    }
    return {
      receipt: {
        persisted: true,
        showReasoning: input.showReasoning,
        note: input.showReasoning
          ? "Mona now shows engine-reported reasoning in the transcript. The request is unchanged."
          : "Mona now hides engine-reported reasoning in the transcript. The request is unchanged and the engine keeps sending it.",
      },
      snapshot,
    };
  }

  // ------------------------------------------------------------------ writing

  async saveDefault(input: {
    projectId: ProjectId;
    expectedRevision: number;
    provider: string;
    exactId: string | null;
    model: string;
    reasoningEffort: string | null;
    permissionPosture: "full_access" | "ask";
    autoApprove: boolean;
    trustMode: boolean;
    allowShell: boolean;
  }): Promise<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }> {
    if (!PROVIDER.test(input.provider) || !MODEL.test(input.model)) {
      throw new SettingsError("INVALID_ROUTE", "provider or model id is not a bounded identifier");
    }
    if (input.exactId !== null && !MODEL.test(input.exactId)) {
      throw new SettingsError("INVALID_ROUTE", "exact provider id is not a bounded identifier");
    }
    const access = this.engine(input.projectId);
    if (!access) {
      throw new SettingsError(
        "RUNTIME_UNAVAILABLE",
        "A live engine is required to validate a route before it is saved. Start the project studio and try again.",
      );
    }
    const providers = await this.readProviders(access);
    // The built-in canonical id is the generic route; normalize before the read
    // so validation sees the same identity the profile will store.
    const exactId = routeExactId(input.provider, input.exactId);
    const models = await this.readModels(access, input.provider, exactId);
    const validation = validateRoute(
      {
        provider: input.provider,
        exactId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      },
      providers,
      models,
    );
    if (!validation.ok) {
      throw new SettingsError("INVALID_ROUTE", validation.reason ?? "the route is not supported", {
        provider: input.provider,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });
    }
    const before = await this.readSaved();
    const fullAccess = input.permissionPosture === "full_access";
    const profile: ExecutionProfile = {
      provider: input.provider,
      exactId,
      model: input.model,
      // The setting is always declared: an omitted request means the declared
      // default, never "whatever happens to be configured".
      reasoningEffort: input.reasoningEffort ?? DECLARED_REASONING_EFFORT,
      permissionPosture: input.permissionPosture,
      autoApprove: fullAccess && input.autoApprove,
      trustMode: fullAccess && input.trustMode,
      allowShell: fullAccess && input.allowShell,
    };
    const written = await this.store
      .putSettingsIfVersion(
        PROFILE_SCOPE,
        {
          ...profile,
          updatedAt: this.now().toISOString(),
          note: "Saved new-thread default; validated against the live provider and model catalog.",
        },
        input.expectedRevision,
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "CONFLICT"
        ) {
          throw new SettingsError("CONFIG_STALE", error.message, {
            expectedRevision: input.expectedRevision,
          });
        }
        throw error;
      });
    const receipt: RouteChangeReceipt = {
      applied: true,
      target: "saved_default",
      before: routeOf(before.profile),
      after: routeOf(profile),
      persisted: true,
      requiresReload: false,
      backupPath: null,
      backupSha256: null,
      revisionBefore: String(before.version),
      revisionAfter: String(written.version),
      verification:
        "The saved default was validated against the live catalog and written to Mona's versioned settings. Active sessions keep the route they started with.",
      note: "Applies to new threads. An active turn is untouched.",
    };
    return { receipt, snapshot: await this.snapshot(input.projectId) };
  }

  async resetDefault(input: {
    projectId: ProjectId;
    expectedRevision: number;
  }): Promise<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }> {
    const before = await this.readSaved();
    const profile = { ...DEFAULT_EXECUTION_PROFILE };
    const written = await this.store
      .putSettingsIfVersion(
        PROFILE_SCOPE,
        {
          ...profile,
          updatedAt: this.now().toISOString(),
          note: "Measured P01 route restored as the saved new-thread default.",
        },
        input.expectedRevision,
      )
      .catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          (error as { code: string }).code === "CONFLICT"
        ) {
          throw new SettingsError("CONFIG_STALE", error.message);
        }
        throw error;
      });
    return {
      receipt: {
        applied: true,
        target: "saved_default",
        before: routeOf(before.profile),
        after: routeOf(profile),
        persisted: true,
        requiresReload: false,
        backupPath: null,
        backupSha256: null,
        revisionBefore: String(before.version),
        revisionAfter: String(written.version),
        verification:
          "The measured P01 route (deepseek / deepseek-flash) is again the saved new-thread default.",
        note: "Victor's Flash route is the default; no automatic routing was enabled.",
      },
      snapshot: await this.snapshot(input.projectId),
    };
  }

  /**
   * Change the engine's own configured route. This is a separate, explicit
   * action from the saved new-thread default, and it is the only path that
   * writes the engine's config document.
   */
  async switchEngineRoute(input: {
    projectId: ProjectId;
    provider: string;
    exactId: string | null;
    model: string;
    expectedConfigRevision: string | null;
    confirm: boolean;
  }): Promise<{ receipt: RouteChangeReceipt; snapshot: SettingsSnapshot }> {
    if (!input.confirm) {
      throw new SettingsError(
        "INVALID_ROUTE",
        "changing the engine default route requires explicit confirmation",
      );
    }
    const access = this.engine(input.projectId);
    if (!access) {
      throw new SettingsError(
        "RUNTIME_UNAVAILABLE",
        "a live engine is required to change its configured route",
      );
    }
    if (input.exactId && input.exactId !== input.provider) {
      throw new SettingsError(
        "INVALID_ROUTE",
        "the engine switch route cannot select a named custom route; save it as the new-thread default instead",
      );
    }
    const paths = this.paths();
    // The stale check runs before any catalog read. A read may make the engine
    // lazily rewrite its document; the user's revision describes the document
    // they saw, so an external edit must be caught here, not after normalization.
    const context = await this.readConfigContext(paths.configPath, paths.settingsPath);
    if (
      input.expectedConfigRevision !== null &&
      context.revision !== input.expectedConfigRevision
    ) {
      throw new SettingsError(
        "CONFIG_STALE",
        "the engine configuration changed since this screen read it; reload before saving",
        { expected: input.expectedConfigRevision, current: context.revision },
      );
    }
    const providers = await this.readProviders(access);
    const requestedExactId = routeExactId(input.provider, input.exactId);
    const models = await this.readModels(access, input.provider, requestedExactId);
    const validation = validateRoute(
      {
        provider: input.provider,
        exactId: requestedExactId,
        model: input.model,
        reasoningEffort: null,
      },
      providers,
      models,
    );
    if (!validation.ok) {
      throw new SettingsError("INVALID_ROUTE", validation.reason ?? "the route is not supported");
    }
    // Re-read after validation: the backup must capture the bytes the switch
    // will actually replace.
    const currentContext = await this.readConfigContext(paths.configPath, paths.settingsPath);
    const before = await this.readEngineRoute(access);
    // Back up the document that will actually be replaced. The user-visible
    // revision was already checked above; a normalization by our own catalog
    // read must not be reported as an external conflict.
    const backup = await this.backupConfig(
      currentContext,
      `before route switch to ${input.provider}/${input.model}`,
    );
    const switched = await access.adapter.switchProvider({
      provider: input.provider,
      model: input.model,
    });
    const afterConfig = await this.readRuntimeConfig(access);
    const afterRevision = await this.configRevision(paths.configPath);
    const afterRoute: RouteView = {
      provider: switched.provider,
      exactId: switched.provider === input.provider ? input.exactId : null,
      model: switched.model ?? afterConfig.model ?? input.model,
      reasoningEffort: afterConfig.reasoningEffort,
    };
    const matches = afterRoute.provider === input.provider && afterRoute.model === input.model;
    await this.writeConfigEvidence(currentContext, backup, {
      action: "switch_provider",
      requested: { provider: input.provider, model: input.model },
      observed: afterRoute,
      persisted: switched.persisted,
      matches,
    });
    return {
      receipt: {
        applied: matches,
        target: "engine_default",
        before: routeOfEngine(before),
        after: afterRoute,
        persisted: switched.persisted,
        requiresReload: false,
        backupPath: backup.path || null,
        backupSha256: backup.sha256 || null,
        revisionBefore: currentContext.revision,
        revisionAfter: afterRevision,
        verification: matches
          ? "The engine's live config reports the requested provider and model."
          : `The engine did not report the requested route (observed ${afterRoute.provider}/${afterRoute.model}). The change is not claimed as applied.`,
        note: switched.message ?? "provider switch reported by the engine",
      },
      snapshot: await this.snapshot(input.projectId),
    };
  }

  async setProviderCredential(input: {
    projectId: ProjectId;
    provider: string;
    key: string;
    scope: "session" | "durable";
  }): Promise<CredentialReceipt> {
    if (!PROVIDER.test(input.provider)) {
      throw new SettingsError("INVALID_ROUTE", "provider id is not a bounded identifier");
    }
    const access = this.engine(input.projectId);
    if (!access) {
      throw new SettingsError(
        "RUNTIME_UNAVAILABLE",
        "a live engine is required to store a credential",
      );
    }
    const catalog = await access.adapter.listProviders();
    const provider = catalog.providers.find((entry) => entry.id === input.provider);
    if (!provider) {
      throw new SettingsError("INVALID_ROUTE", "the engine does not report that provider");
    }
    if (!provider.credentialWritable) {
      throw new SettingsError(
        "CREDENTIAL_REFUSED",
        provider.credentialWritableReason ??
          "the engine does not own this route's credential; Mona will not write around it",
      );
    }
    const receipt = await access.adapter.setProviderKey({
      provider: input.provider,
      key: input.key,
      scope: input.scope,
    });
    return {
      provider: receipt.provider,
      credentialState: normalizeCredentialState(receipt.credentialState),
      stored: receipt.stored,
      scope: input.scope,
      backend: receipt.backend,
      note:
        receipt.scope === "session"
          ? "Held in engine memory for this run only; not written to disk and not shown again."
          : "Stored by the engine's own credential store. Mona did not record the value.",
    };
  }

  async clearProviderCredential(input: {
    projectId: ProjectId;
    provider: string;
    scope: "session" | "durable";
  }): Promise<CredentialClearReceipt> {
    if (!PROVIDER.test(input.provider)) {
      throw new SettingsError("INVALID_ROUTE", "provider id is not a bounded identifier");
    }
    const access = this.engine(input.projectId);
    if (!access) {
      throw new SettingsError(
        "RUNTIME_UNAVAILABLE",
        "a live engine is required to clear a credential",
      );
    }
    const result = await access.adapter.clearProviderKey({
      provider: input.provider,
      scope: input.scope,
    });
    return {
      provider: input.provider,
      cleared: result.cleared,
      credentialState: result.credentialState
        ? normalizeCredentialState(result.credentialState)
        : null,
      note:
        input.scope === "session"
          ? "The in-memory key overlay was removed; stored or environment credentials are unchanged."
          : "The engine cleared the Codewhale-owned durable key. Other credential owners are not touched.",
    };
  }

  // -------------------------------------------------------------- diagnostics

  async diagnostics(projectId: ProjectId): Promise<SettingsDiagnosticsView> {
    const generatedAt = this.now().toISOString();
    let binary: string;
    try {
      binary = this.engineBinary();
    } catch (error) {
      return {
        generatedAt,
        ok: false,
        summary: "Diagnostics could not run because the engine binary was not found.",
        warnings: [error instanceof Error ? error.message : String(error)],
        redacted: "",
        redactions: 0,
      };
    }
    const doctor = await this.runDoctor([binary, "doctor", "--json"], { timeoutMs: 20_000 });
    const configDoctor = await this.runDoctor([binary, "config", "doctor"], { timeoutMs: 20_000 });
    const raw = [
      "# codewhale doctor --json",
      doctor.stdout,
      doctor.stderr,
      "# codewhale config doctor",
      configDoctor.stdout,
      configDoctor.stderr,
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    const redacted = redactDiagnostics(raw, this.homeDir);
    const warnings: string[] = [];
    let structural: Record<string, unknown> | null = null;
    try {
      structural = JSON.parse(doctor.stdout) as Record<string, unknown>;
    } catch {
      structural = null;
    }
    if (!structural) {
      warnings.push("the engine did not return parseable doctor JSON");
    } else {
      if (structural.config_present === false) warnings.push("no engine config file is present");
      const apiKey = structural.api_key as { availability?: unknown; source?: unknown } | undefined;
      if (apiKey && apiKey.availability !== "present" && apiKey.availability !== "not_required") {
        warnings.push(
          `provider credential availability: ${String(apiKey.availability ?? "unknown")} (${String(apiKey.source ?? "unknown source")})`,
        );
      }
      const baseUrl = structural.base_url;
      if (typeof baseUrl === "string") {
        const endpoint = endpointAuthority(baseUrl);
        if (endpoint.status === "malformed")
          warnings.push("the configured provider endpoint is malformed");
      }
      const mcp = structural.mcp as
        { servers?: Array<{ name?: unknown; status?: unknown }> } | undefined;
      for (const server of mcp?.servers ?? []) {
        if (server.status && server.status !== "ok") {
          warnings.push(`MCP server ${String(server.name ?? "?")}: ${String(server.status)}`);
        }
      }
    }
    if (configDoctor.code !== 0 && configDoctor.stderr.trim().length > 0) {
      warnings.push("config doctor reported a problem; see the redacted report");
    }
    const project = await this.engine(projectId);
    if (project) {
      const providers = await this.readProviders(project);
      if (providers.source !== "live") {
        warnings.push("the live provider catalog could not be read");
      }
      for (const provider of providers.providers) {
        if (provider.current && provider.credentialState === "missing") {
          warnings.push(`the active provider ${provider.id} reports a missing credential`);
        }
      }
    }
    const ok = doctor.code === 0 && configDoctor.code === 0 && warnings.length === 0;
    return {
      generatedAt,
      ok,
      summary: ok
        ? "Engine configuration and credentials are structurally clean. No secret material is included."
        : `Diagnostics completed with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}.`,
      warnings,
      redacted: redacted.text.slice(0, 40_000),
      redactions: redacted.redactions,
    };
  }

  // ---------------------------------------------------------------- internals

  private paths(): { configPath: string; settingsPath: string } {
    return {
      configPath: join(this.configRoot, "config.toml"),
      settingsPath: join(this.configRoot, "settings.toml"),
    };
  }

  private async readSaved(): Promise<{
    profile: ExecutionProfile;
    /** Whether a stored profile row already carries the reasoning setting. */
    declaredStored: boolean;
    version: number;
    updatedAt: string | null;
    view: SavedRouteView;
  }> {
    const stored = await this.store.getSettings(PROFILE_SCOPE);
    const parsed = stored ? parseExecutionProfile(stored.value) : null;
    const profile = parsed ?? { ...DEFAULT_EXECUTION_PROFILE };
    // A read never writes (P16): the declaration is reported as what it is —
    // the value Mona sends — and says whether a stored row carries it yet.
    const storedEffort =
      stored && typeof stored.value === "object" && stored.value !== null
        ? (stored.value as { reasoningEffort?: unknown }).reasoningEffort
        : undefined;
    const declaredStored = typeof storedEffort === "string";
    const updatedAt =
      stored && typeof stored.value === "object" && stored.value !== null
        ? (stored.value as { updatedAt?: unknown }).updatedAt
        : null;
    return {
      profile,
      declaredStored,
      version: stored?.version ?? 0,
      updatedAt: typeof updatedAt === "string" ? updatedAt : null,
      view: {
        route: routeOf(profile),
        permissionPosture: profile.permissionPosture,
        autoApprove: profile.autoApprove,
        trustMode: profile.trustMode,
        allowShell: profile.allowShell,
        revision: stored?.version ?? 0,
        source: parsed ? "configured" : "measured_default",
        updatedAt: typeof updatedAt === "string" ? updatedAt : null,
        validation: {
          ok: false,
          checkedAt: this.now().toISOString(),
          reason: "not validated in this read",
          catalog: "unavailable",
        },
      },
    };
  }

  private validateSaved(
    saved: Awaited<ReturnType<RouteWorkbench["readSaved"]>>,
    providers: ProviderCatalogView,
    models: ModelCatalogView,
  ): SavedRouteView {
    const validation = validateRoute(saved.profile, providers, models);
    return {
      ...saved.view,
      validation: {
        ok: validation.ok,
        checkedAt: this.now().toISOString(),
        reason: validation.reason,
        catalog: providers.source === "live" && models.source === "live" ? "live" : "unavailable",
      },
    };
  }

  private async readReasoningDisplay(): Promise<boolean> {
    return loadReasoningDisplay(this.store);
  }

  /**
   * One requested/effective view for the saved route. The support facts come
   * from the exact model's row, so an unknown model can never borrow another
   * model's ladder.
   */
  private reasoningControl(
    saved: ExecutionProfile,
    models: ModelCatalogView,
    engineDefault: EngineRouteView,
    showReasoning: boolean,
    observed: SettingsSnapshot["observed"] = null,
    declaredStored = false,
  ): ReasoningControlView {
    const model = models.models.find((entry) => entry.id === saved.model) ?? null;
    const support =
      model?.reasoningSupport ??
      deriveReasoningSupport({
        engineState: "unknown",
        engineLevels: [],
        engineSource: null,
        facts: null,
      });
    const requested = saved.reasoningEffort ?? null;
    const configuredDefault =
      engineDefault.source === "unavailable" ? null : engineDefault.reasoningEffort;
    // A cached read is not a current fact: the engine may be down, and its config
    // may have changed since. The three states stay distinct all the way to the
    // screen, so a stale value is never presented as the live one.
    const configuredSource =
      engineDefault.source === "live"
        ? ("engine_config" as const)
        : engineDefault.source === "stored"
          ? ("engine_config_cached" as const)
          : ("unavailable" as const);
    const configuredReadAt = engineDefault.source === "stored" ? engineDefault.readAt : null;
    const inheritance = describeInheritance({
      requested,
      configuredDefault,
      configuredSource,
      configuredReadAt,
      // Only an engine-reported value counts as effective (D-108).
      reportedEffective: observed?.effectiveReasoningEffort ?? null,
      reportedTurnId: observed?.turnId ?? null,
    });
    return {
      support,
      requested: {
        effort: requested,
        thinking:
          requested === null
            ? "unspecified"
            : requested === "off"
              ? "off"
              : requested === DECLARED_REASONING_EFFORT
                ? "auto"
                : "on",
      },
      inheritance: {
        configuredDefault,
        configuredSource,
        configuredReadAt,
        effective: inheritance.effective,
        effectiveSource: inheritance.effectiveSource,
        effectiveTurnId: inheritance.effectiveTurnId,
        note: inheritance.note,
      },
      declared: {
        value: DECLARED_REASONING_EFFORT,
        editable: false,
        stored: declaredStored,
        note: "Auto is the engine's own default: its reasoning selector resolves a concrete tier for each turn. Mona sends it explicitly and does not offer a different setting here, so the value is declared rather than implied.",
      },
      display: {
        showReasoning,
        note: "Mona renders the reasoning items the engine streams. This preference changes Mona's transcript only; it is never sent to the engine and it does not change thinking or effort.",
      },
    };
  }

  private observedRoute(
    snapshot: StudioSnapshot | null,
    saved: ExecutionProfile,
  ): SettingsSnapshot["observed"] {
    const effective = snapshot?.profile.effective ?? null;
    if (!snapshot || !effective) return null;
    const matchesSavedDefault =
      effective.provider === saved.provider && effective.model === saved.model ? true : false;
    return {
      threadId: snapshot.engineThreadId ?? snapshot.threadId ?? "",
      turnId: snapshot.profile.effectiveTurnId,
      requestedProvider: snapshot.profile.provider,
      requestedModel: snapshot.profile.model,
      effectiveProvider: effective.provider,
      effectiveModel: effective.model,
      permissionPosture: effective.permissionPosture,
      effectiveReasoningEffort: effective.reasoningEffort ?? null,
      effectiveReasoningSource: effective.reasoningSource ?? null,
      reasoningTokens: effective.reasoningTokens ?? null,
      reasoningEvidence: reasoningEvidence(effective.reasoningTokens ?? null),
      usedFallback: effective.usedFallback,
      observedAt: this.now().toISOString(),
      matchesSavedDefault,
    };
  }

  private async readProviders(access: SettingsEngineAccess): Promise<ProviderCatalogView> {
    const readAt = this.now().toISOString();
    try {
      const catalog = await access.adapter.listProviders();
      const view = mapProviders(catalog, readAt);
      await this.store.putSettings(PROVIDER_CACHE, { readAt, catalog }).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cachedProviders();
      return {
        ...cached,
        error:
          cached.source === "stored"
            ? `${describe(error)}; showing the last catalog read at ${cached.readAt}`
            : describe(error),
      };
    }
  }

  private async cachedProviders(): Promise<ProviderCatalogView> {
    const cached = await this.store.getSettings(PROVIDER_CACHE).catch(() => null);
    const value = cached?.value as { readAt?: unknown; catalog?: unknown } | undefined;
    const catalog = value?.catalog as EngineProviderCatalog | undefined;
    if (!catalog || !Array.isArray(catalog.providers) || typeof value?.readAt !== "string") {
      return {
        current: null,
        currentExactId: null,
        providers: [],
        readAt: this.now().toISOString(),
        source: "unavailable",
        error: "no live provider catalog has been read yet",
      };
    }
    return { ...mapProviders(catalog, value.readAt), source: "stored", error: null };
  }

  private async readModels(
    access: SettingsEngineAccess,
    provider: string,
    exactId: string | null,
  ): Promise<ModelCatalogView> {
    const readAt = this.now().toISOString();
    try {
      const catalog = await access.adapter.listModels(provider, exactId);
      const view = mapModels(catalog, readAt, await this.supportMap(catalog, exactId));
      await this.store
        .putSettings(`${MODEL_CACHE}${provider}:${exactId ?? "-"}`, { readAt, exactId, catalog })
        .catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cachedModels(provider, exactId);
      return {
        ...cached,
        error: `${describe(error)}${cached.source === "stored" ? `; showing the last catalog read at ${cached.readAt}` : ""}`,
      };
    }
  }

  private async cachedModels(provider: string, exactId: string | null): Promise<ModelCatalogView> {
    const cached = await this.store
      .getSettings(`${MODEL_CACHE}${provider}:${exactId ?? "-"}`)
      .catch(() => null);
    const value = cached?.value as
      { readAt?: unknown; exactId?: unknown; catalog?: unknown } | undefined;
    const catalog = value?.catalog as EngineModelCatalog | undefined;
    if (!catalog || !Array.isArray(catalog.models) || typeof value?.readAt !== "string") {
      return {
        provider,
        exactId,
        models: [],
        readAt: this.now().toISOString(),
        source: "unavailable",
        error: "no live model catalog has been read for this provider yet",
      };
    }
    const storedExactId = typeof value?.exactId === "string" ? value.exactId : null;
    return {
      ...mapModels(catalog, value.readAt, await this.supportMap(catalog, storedExactId)),
      source: "stored",
      error: null,
    };
  }

  /**
   * Read the engine's own metadata for each model once. The engine's live
   * provider-roster projection reports `unknown` even when its Models.dev cache
   * publishes a ladder (D-108), so both sources are consulted and the explicit
   * engine answer keeps precedence.
   *
   * The metadata describes the provider's first-party route. A named exact route
   * or a user-configured `base_url` is a different endpoint — the runtime itself
   * refuses to infer levels there — so those get no cached facts at all rather
   * than a first-party claim they cannot support.
   */
  private async supportMap(
    catalog: EngineModelCatalog,
    requestedExactId: string | null,
  ): Promise<Map<string, ReasoningSupportView>> {
    // Both sides must agree the route is generic: the caller's request and the
    // engine's echo. A named route whose echo was dropped still must not borrow
    // first-party metadata.
    const facts: ReadonlyMap<string, EngineCatalogModelFacts | null> =
      routeExactId(catalog.provider, requestedExactId) === null &&
      routeExactId(catalog.provider, catalog.exactId) === null &&
      !(await this.customEndpoint(catalog.provider))
        ? // One read for the whole roster: a provider can publish hundreds of
          // models, and a read per model would open the same file repeatedly.
          await readEngineCatalogModelFactsBatch(
            this.configRoot,
            catalog.provider,
            catalog.models.map((model) => model.id),
          ).catch(() => new Map<string, EngineCatalogModelFacts | null>())
        : new Map<string, EngineCatalogModelFacts | null>();
    const supports = new Map<string, ReasoningSupportView>();
    for (const model of catalog.models) {
      const engineState =
        model.reasoningEffort === "supported" || model.reasoningEffort === "unsupported"
          ? model.reasoningEffort
          : "unknown";
      supports.set(
        model.id,
        deriveReasoningSupport({
          engineState,
          engineLevels: model.reasoningEffortLevels,
          engineSource: model.reasoningEffortSource,
          facts: facts.get(model.id) ?? null,
        }),
      );
    }
    return supports;
  }

  /**
   * Config bytes decide whether this provider's endpoint is the user's own. A
   * missing document is not a custom endpoint — the engine has configured none,
   * and it is the engine that writes this file when it resolves a route. A
   * document that exists but cannot be read is unknown, so it fails closed.
   */
  private async customEndpoint(provider: string): Promise<boolean> {
    try {
      const bytes = await readFile(this.paths().configPath);
      return customEndpointConfigured(bytes.toString("utf8"), provider);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === "ENOENT" ? false : true;
    }
  }

  private async readRuntimeConfig(access: SettingsEngineAccess): Promise<EngineRuntimeConfig> {
    return access.adapter.readRuntimeConfig();
  }

  private async readEngineRoute(access: SettingsEngineAccess): Promise<EngineRouteView> {
    const readAt = this.now().toISOString();
    try {
      const config = await this.readRuntimeConfig(access);
      const endpoint = endpointAuthority(config.baseUrl);
      const stored: StoredEngineRoute = {
        readAt,
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        endpointAuthority: endpoint.authority,
        endpointStatus: config.baseUrl ? endpoint.status : "default",
        approvalMode: config.approvalMode,
        sandboxMode: config.sandboxMode,
        allowShell: config.allowShell,
      };
      await this.store.putSettings("engine:runtime-config-cache", stored).catch(() => undefined);
      return {
        provider: stored.provider,
        exactId: null,
        model: stored.model,
        reasoningEffort: stored.reasoningEffort,
        endpointAuthority: stored.endpointAuthority,
        endpointStatus: stored.endpointStatus,
        approvalMode: stored.approvalMode,
        sandboxMode: stored.sandboxMode,
        allowShell: stored.allowShell,
        readAt,
        source: "live",
        error: null,
      };
    } catch (error) {
      return {
        ...(await this.cachedEngineRoute()),
        error: describe(error),
      };
    }
  }

  private async cachedEngineRoute(): Promise<EngineRouteView> {
    const cached = await this.store.getSettings("engine:runtime-config-cache").catch(() => null);
    const stored = cached?.value as Partial<StoredEngineRoute> | undefined;
    if (!stored || typeof stored.readAt !== "string") {
      return {
        provider: null,
        exactId: null,
        model: null,
        reasoningEffort: null,
        endpointAuthority: null,
        endpointStatus: "unknown",
        approvalMode: null,
        sandboxMode: null,
        allowShell: null,
        readAt: this.now().toISOString(),
        source: "unavailable",
        error: "the live engine config has not been read yet",
      };
    }
    return {
      provider: stored.provider ?? null,
      exactId: null,
      model: stored.model ?? null,
      reasoningEffort: stored.reasoningEffort ?? null,
      endpointAuthority: stored.endpointAuthority ?? null,
      endpointStatus: stored.endpointStatus ?? "unknown",
      approvalMode: stored.approvalMode ?? null,
      sandboxMode: stored.sandboxMode ?? null,
      allowShell: stored.allowShell ?? null,
      readAt: stored.readAt,
      source: "stored",
      error: null,
    };
  }

  private engineSelection(
    identity: { version: string; commit: string } | null = null,
  ): SettingsSnapshot["engineSelection"] {
    try {
      const binary = resolveEngineBinary();
      return {
        source: binary.source === "env" ? "external_env" : "bundled",
        path: binary.realPath,
        sha256: binary.sha256,
        version: identity?.version ?? null,
        commit: identity?.commit ?? null,
        note:
          binary.source === "env"
            ? "An explicit external binary was adopted through CODEWHALE_BIN. Mona records its path and SHA-256 and never resolves an arbitrary PATH name."
            : binary.source === "bundled"
              ? "Mona runs the pinned engine carried inside the signed app bundle. Its path and SHA-256 are recorded; PATH and Homebrew are not consulted."
              : "This development build runs the pinned host installation of Codewhale. Packaged Mona carries its own engine instead.",
      };
    } catch (error) {
      return {
        source: "unavailable",
        path: null,
        sha256: null,
        version: identity?.version ?? null,
        commit: identity?.commit ?? null,
        note: describe(error),
      };
    }
  }

  private async readConfigContext(
    configPath: string,
    settingsPath: string,
  ): Promise<ConfigWriteContext> {
    const bytes = await readBytes(configPath);
    return {
      configPath,
      settingsPath,
      revision: bytes ? hashBytes(bytes) : null,
      bytes,
    };
  }

  private async configRevision(path: string): Promise<string | null> {
    const bytes = await readBytes(path);
    return bytes ? hashBytes(bytes) : null;
  }

  private async backupConfig(context: ConfigWriteContext, reason: string): Promise<BackupRecord> {
    await mkdir(this.backupDir, { recursive: true });
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    if (!context.bytes) {
      // Nothing existed to copy. Record that fact rather than pretending a
      // backup was taken; the receipt still names the document.
      const absent = join(this.backupDir, `engine-config-${stamp}-absent.json`);
      await writeFile(
        absent,
        JSON.stringify(
          {
            schema_version: 1,
            captured_at: this.now().toISOString(),
            source: context.configPath,
            sha256: null,
            bytes: 0,
            reason,
            note: "the config document did not exist before this change",
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      return { path: absent, sha256: "", bytes: 0 };
    }
    const target = join(
      this.backupDir,
      `engine-config-${stamp}-${context.revision?.slice(0, 12) ?? "unknown"}-${basename(context.configPath)}`,
    );
    await writeFile(target, context.bytes, { mode: 0o600 });
    await writeFile(
      `${target}.json`,
      JSON.stringify(
        {
          schema_version: 1,
          captured_at: this.now().toISOString(),
          source: context.configPath,
          sha256: context.revision,
          bytes: context.bytes.length,
          reason,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    return {
      path: target,
      sha256: context.revision ?? "",
      bytes: context.bytes.length,
    };
  }

  private async writeConfigEvidence(
    context: ConfigWriteContext,
    backup: BackupRecord,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!backup.path) return;
    const after = await readBytes(context.configPath);
    await writeFile(
      `${backup.path}.receipt.json`,
      JSON.stringify(
        {
          schema_version: 1,
          recorded_at: this.now().toISOString(),
          before: { path: backup.path, sha256: backup.sha256, bytes: backup.bytes },
          after: {
            sha256: after ? hashBytes(after) : null,
            bytes: after?.length ?? 0,
          },
          ...detail,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}

/**
 * What the engine's own reasoning-token count does and does not prove. Non-zero
 * is positive evidence that thinking ran; zero is inconclusive, because a short
 * prompt can produce none even with thinking on. Neither is a substitute for an
 * effective setting the engine did not report.
 */
export function reasoningEvidence(tokens: number | null): string {
  if (tokens === null) {
    return "The engine reported no reasoning-token count for that turn, so there is no evidence either way.";
  }
  if (tokens > 0) {
    return `The engine reported ${tokens} reasoning token${tokens === 1 ? "" : "s"} for that turn: thinking demonstrably ran.`;
  }
  return "The engine reported 0 reasoning tokens for that turn. That is inconclusive — a short prompt can produce none with thinking on — so it is not proof that thinking was off.";
}

function routeOf(profile: ExecutionProfile): RouteView {
  return {
    provider: profile.provider,
    exactId: profile.exactId,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort ?? null,
  };
}

function routeOfEngine(view: EngineRouteView): RouteView {
  return {
    provider: view.provider ?? "",
    exactId: view.exactId,
    model: view.model ?? "",
    reasoningEffort: view.reasoningEffort,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeCredentialState(
  value: string | null,
): ProviderCatalogView["providers"][number]["credentialState"] {
  switch (value) {
    case "configured":
    case "login_required":
    case "missing":
    case "no_auth":
    case "local":
    case "legacy":
      return value;
    default:
      return "unknown";
  }
}

function mapProviders(catalog: EngineProviderCatalog, readAt: string): ProviderCatalogView {
  return {
    current: catalog.current,
    currentExactId: catalog.currentExactId,
    providers: catalog.providers.map((provider) => ({
      id: provider.id,
      exactId: provider.exactId,
      displayName: provider.displayName,
      defaultModel: provider.defaultModel,
      hasModelCatalog: provider.hasModelCatalog,
      current: catalog.current === provider.id,
      credentialState: normalizeCredentialState(provider.credentialState),
      credentialSource:
        provider.credentialSource === "secret_store" ||
        provider.credentialSource === "account_session" ||
        provider.credentialSource === "config" ||
        provider.credentialSource === "external_auth" ||
        provider.credentialSource === "none"
          ? provider.credentialSource
          : "unknown",
      credentialWritable: provider.credentialWritable,
      credentialWritableReason: provider.credentialWritableReason,
      browserConnect: provider.browserConnect,
    })),
    readAt,
    source: "live",
    error: null,
  };
}

function supportWithoutMetadata(model: EngineModelCatalog["models"][number]): ReasoningSupportView {
  const engineState =
    model.reasoningEffort === "supported" || model.reasoningEffort === "unsupported"
      ? model.reasoningEffort
      : "unknown";
  return deriveReasoningSupport({
    engineState,
    engineLevels: model.reasoningEffortLevels,
    engineSource: model.reasoningEffortSource,
    facts: null,
  });
}

function mapModels(
  catalog: EngineModelCatalog,
  readAt: string,
  supports: ReadonlyMap<string, ReasoningSupportView> = new Map(),
): ModelCatalogView {
  return {
    provider: catalog.provider,
    exactId: catalog.exactId,
    models: catalog.models.map((model) => ({
      id: model.id,
      imageInput:
        model.imageInput === "supported" || model.imageInput === "unsupported"
          ? model.imageInput
          : "unknown",
      reasoningEffort:
        model.reasoningEffort === "supported" || model.reasoningEffort === "unsupported"
          ? model.reasoningEffort
          : "unknown",
      reasoningEffortLevels: model.reasoningEffortLevels,
      reasoningEffortSource: model.reasoningEffortSource,
      contextTokens: model.contextTokens,
      outputTokens: model.outputTokens,
      factsSource: model.factsSource,
      reasoningSupport: supports.get(model.id) ?? supportWithoutMetadata(model),
    })),
    readAt,
    source: "live",
    error: null,
  };
}

/** The legacy view for a hand-built catalog that carries no support facts. */
function supportFromModel(model: ModelView): ReasoningSupportView {
  if (model.reasoningSupport) return model.reasoningSupport;
  return deriveReasoningSupport({
    engineState:
      model.reasoningEffort === "supported" || model.reasoningEffort === "unsupported"
        ? model.reasoningEffort
        : "unknown",
    engineLevels: model.reasoningEffortLevels,
    engineSource: model.reasoningEffortSource,
    facts: null,
  });
}

/**
 * The single gate between a chosen route and anything persisted or sent. A
 * reasoning level is only accepted when this exact model publishes it.
 */
export function validateRoute(
  route: {
    provider: string;
    exactId: string | null;
    model: string;
    reasoningEffort?: string | null;
  },
  providers: ProviderCatalogView,
  models: ModelCatalogView,
): { ok: boolean; reason: string | null } {
  if (providers.source !== "live") {
    return { ok: false, reason: "a live provider catalog is required to validate this route" };
  }
  const provider = providers.providers.find((entry) => entry.id === route.provider);
  if (!provider) {
    return { ok: false, reason: `the engine does not report provider '${route.provider}'` };
  }
  if (route.exactId && provider.exactId && route.exactId !== provider.exactId) {
    return {
      ok: false,
      reason: `exact provider identity '${route.exactId}' does not match the engine's '${provider.exactId}'`,
    };
  }
  if (!provider.hasModelCatalog) {
    return {
      ok: false,
      reason: `the engine reports no model catalog for '${route.provider}', so a model cannot be validated`,
    };
  }
  if (models.source !== "live") {
    return { ok: false, reason: "a live model catalog is required to validate this model" };
  }
  if (models.models.length === 0) {
    return {
      ok: false,
      reason: `the engine returned no models for '${route.provider}'; Mona will not persist an unverified selection`,
    };
  }
  const model = models.models.find((entry) => entry.id === route.model);
  if (!model) {
    return {
      ok: false,
      reason: `'${route.model}' is not in the engine's catalog for '${route.provider}'`,
    };
  }
  const effort = route.reasoningEffort ?? null;
  if (effort !== null) {
    // `auto` is the runtime's own canonical default, not a claim about this
    // model's ladder: its selector resolves a concrete tier per turn. It is
    // therefore always acceptable, and requires no metadata to prove.
    if (effort === DECLARED_REASONING_EFFORT) return { ok: true, reason: null };
    const support = supportFromModel(model);
    // `off` is the thinking-disable value, not an effort tier. It is gated on the
    // thinking control alone: a model can publish a toggle and no ladder (993
    // models in the engine's own catalog do), and refusing `off` there would
    // reject a control the metadata demonstrably publishes.
    if (effort === "off") {
      if (support.thinking !== "toggle") {
        return {
          ok: false,
          reason: `'${model.id}' publishes no thinking on/off control, so Mona will not send 'off'`,
        };
      }
      return { ok: true, reason: null };
    }
    if (support.effort === "unsupported") {
      return {
        ok: false,
        reason: `'${model.id}' publishes no selectable reasoning-effort ladder; Mona will not send a level it cannot prove`,
      };
    }
    if (support.effort === "unknown") {
      return {
        ok: false,
        reason: `no metadata is available for '${model.id}', so Mona cannot prove that '${effort}' is accepted; it sends no unproven level`,
      };
    }
    if (!support.levels.includes(effort)) {
      return {
        ok: false,
        reason: `'${effort}' is not one of this model's published levels (${support.levels.join(", ") || "none"})`,
      };
    }
  }
  return { ok: true, reason: null };
}

/**
 * A saved model that the engine's live catalog no longer lists cannot be sent:
 * the provider rejects the name and the turn fails *after* it has started, so
 * the operator sees a provider 400 instead of an actionable refusal. This is the
 * same predicate the save path applies (`validateRoute`), asked again at
 * dispatch time, because the catalog is the engine's and can change under a
 * saved profile.
 *
 * A catalog that could not be read is not evidence against the route: null here
 * means "no objection", and the engine stays the authority for what it accepts.
 * An empty catalog is also no objection — a provider without one has nothing to
 * compare against, and refusing there would block a route the save path allows.
 */
export function unsupportedSavedModel(
  route: { provider: string; model: string },
  catalog: { models: { id: string }[] } | null,
): string | null {
  if (!catalog || catalog.models.length === 0) return null;
  if (catalog.models.some((entry) => entry.id === route.model)) return null;
  const shown = catalog.models
    .slice(0, 8)
    .map((entry) => entry.id)
    .join(", ");
  const rest = catalog.models.length > 8 ? `, +${catalog.models.length - 8} more` : "";
  return (
    `The saved model '${route.model}' is not in the engine's live catalog for '${route.provider}' ` +
    `(it offers: ${shown}${rest}). A turn sent with it is rejected by the provider, so Mona ` +
    "refused before dispatch and nothing was sent. Choose a supported model in Settings → " +
    "Providers & route; Mona never changes the model for you."
  );
}

async function defaultDoctorRunner(
  command: string[],
  options: { timeoutMs: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const [binary, ...args] = command;
  if (!binary) return { stdout: "", stderr: "no engine binary", code: 1 };
  const exec = promisify(execFile);
  try {
    const result = await exec(binary, args, {
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const candidate = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: candidate.stdout ?? "",
      stderr: candidate.stderr ?? describe(error),
      code: typeof candidate.code === "number" ? candidate.code : 1,
    };
  }
}
