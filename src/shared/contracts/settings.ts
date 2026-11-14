import { z } from "zod";

/**
 * P16 — provider, model, route, and configuration contracts.
 *
 * These types cross the narrow IPC boundary. Credential material never does:
 * every value here is a class, a state, or a path the engine already reports in
 * a non-secret projection. The saved route record is the only persisted shape.
 */

export const ProviderCredentialState = z.enum([
  "configured",
  "login_required",
  "missing",
  "no_auth",
  "local",
  "legacy",
  "unknown",
]);
export type ProviderCredentialState = z.infer<typeof ProviderCredentialState>;

export const CredentialSource = z.enum([
  "secret_store",
  "account_session",
  "config",
  "external_auth",
  "none",
  "unknown",
]);
export type CredentialSource = z.infer<typeof CredentialSource>;

export const CapabilityState = z.enum(["supported", "unsupported", "unknown"]);
export type CapabilityState = z.infer<typeof CapabilityState>;

export interface ProviderView {
  /** Generic provider kind accepted by /v1/threads `model_provider`. */
  id: string;
  /** Exact configured identity for a named custom route, else null. */
  exactId: string | null;
  displayName: string;
  defaultModel: string | null;
  hasModelCatalog: boolean;
  current: boolean;
  credentialState: ProviderCredentialState;
  credentialSource: CredentialSource;
  /** Whether the engine would accept a durable key write for this route. */
  credentialWritable: boolean;
  credentialWritableReason: string | null;
  browserConnect: boolean;
}

export interface ModelView {
  id: string;
  imageInput: CapabilityState;
  reasoningEffort: CapabilityState;
  /** Only canonical levels the route publishes; empty means none are sent. */
  reasoningEffortLevels: string[];
  reasoningEffortSource: string | null;
  contextTokens: number | null;
  outputTokens: number | null;
  /** Where the catalog facts came from, when the engine reports it. */
  factsSource: string | null;
  /** What this exact route demonstrably supports, and where that came from. */
  reasoningSupport: ReasoningSupportView;
}

/**
 * What the exact route supports for reasoning, and the source of that claim.
 *
 * `effort` is deliberately separate from `thinking`: a selectable effort
 * ladder says nothing about whether thinking can be turned off, and a silent
 * catalog says nothing about either. Mona offers a level only when metadata
 * publishes it.
 */
export interface ReasoningSupportView {
  /**
   * `published`: the engine's live catalog publishes the ladder now.
   * `metadata`: the live projection withheld it, but the engine's own Models.dev
   *   catalog cache publishes it for this exact model.
   * `unsupported`: metadata explicitly publishes no selectable ladder.
   * `unknown`: no metadata; Mona proves nothing and offers nothing.
   */
  effort: "published" | "metadata" | "unsupported" | "unknown";
  /** Canonical active tiers only; `off` and `auto` are never tiers. */
  levels: string[];
  /** Whether the metadata publishes a thinking on/off control (`off`). */
  thinking: "toggle" | "unknown";
  source: "model_catalog" | "engine_catalog_cache" | null;
  sourceDetail: string | null;
  /** True when the live projection omitted metadata the engine still holds. */
  degraded: boolean;
  note: string;
}

/** Requested versus effective reasoning, with the source of each statement. */
export interface ReasoningControlView {
  support: ReasoningSupportView;
  requested: {
    effort: string | null;
    /**
     * `auto` is its own state: the engine's selector decides, so calling it "on"
     * would claim thinking runs at a tier nobody chose.
     */
    thinking: "off" | "on" | "auto" | "unspecified";
  };
  inheritance: {
    /** The engine's own configured `reasoning_effort` (`auto` is common). */
    configuredDefault: string | null;
    /**
     * `engine_config` is a live read; `engine_config_cached` is the last read
     * before the engine became unreachable, never presented as current;
     * `unavailable` means no read has ever succeeded.
     */
    configuredSource: "engine_config" | "engine_config_cached" | "unavailable";
    /** When the configured default was read, for the cached case. */
    configuredReadAt: string | null;
    /** Only a value an engine actually reported; otherwise null = unknown. */
    effective: string | null;
    effectiveSource: "engine_turn_receipt" | null;
    /** The turn the effective value belongs to, when it came from one. */
    effectiveTurnId: string | null;
    note: string;
  };
  /**
   * The one setting Mona ships: declared, stored and sent, with no control to
   * change it in this build. `auto` is the engine's own default.
   */
  declared: {
    value: string;
    editable: false;
    /**
     * True when the stored profile row already carries the value. False means the
     * value is Mona's declared default and will be persisted by the next save;
     * a read never writes.
     */
    stored: boolean;
    note: string;
  };
  /** Mona's transcript preference. Never sent to the engine. */
  display: {
    showReasoning: boolean;
    note: string;
  };
}

export interface ProviderCatalogView {
  current: string | null;
  currentExactId: string | null;
  providers: ProviderView[];
  readAt: string;
  source: "live" | "stored" | "unavailable";
  error: string | null;
}

export interface ModelCatalogView {
  provider: string;
  exactId: string | null;
  models: ModelView[];
  readAt: string;
  source: "live" | "stored" | "unavailable";
  error: string | null;
}

export interface RouteView {
  provider: string;
  exactId: string | null;
  model: string;
  reasoningEffort: string | null;
}

export const SavedRouteRecord = z.strictObject({
  provider: z.string().min(1).max(64),
  exactId: z.string().min(1).max(128).nullable(),
  model: z.string().min(1).max(128),
  reasoningEffort: z.string().min(1).max(32).nullable(),
  updatedAt: z.string().min(1),
  note: z.string().max(500).nullable(),
});
export type SavedRouteRecord = z.infer<typeof SavedRouteRecord>;

export interface RouteValidationView {
  ok: boolean;
  checkedAt: string;
  reason: string | null;
  catalog: "live" | "unavailable";
}

export interface SavedRouteView {
  route: RouteView;
  permissionPosture: "full_access" | "ask";
  autoApprove: boolean;
  trustMode: boolean;
  allowShell: boolean;
  revision: number;
  source: "configured" | "measured_default";
  updatedAt: string | null;
  validation: RouteValidationView;
}

export interface EngineRouteView {
  provider: string | null;
  exactId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /** Scheme + host only; userinfo, path, query, and fragment are dropped. */
  endpointAuthority: string | null;
  endpointStatus: "configured" | "default" | "malformed" | "unknown";
  approvalMode: string | null;
  sandboxMode: string | null;
  allowShell: boolean | null;
  readAt: string;
  source: "live" | "stored" | "unavailable";
  error: string | null;
}

export interface ObservedRouteView {
  threadId: string;
  turnId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  effectiveProvider: string | null;
  effectiveModel: string | null;
  permissionPosture: string | null;
  /**
   * What the engine said it used for reasoning on that turn, or null when this
   * engine build reports nothing. Null is "not reported"; it is never "off".
   */
  effectiveReasoningEffort: string | null;
  /** The engine's own label for that value's origin, when it gives one. */
  effectiveReasoningSource: string | null;
  /** The engine's reasoning-token count for that turn; null is unreported. */
  reasoningTokens: number | null;
  /** What those tokens do and do not prove, in plain language. */
  reasoningEvidence: string;
  usedFallback: boolean | null;
  observedAt: string;
  matchesSavedDefault: boolean | null;
}

export interface RoutingPolicyView {
  /** Mona never changes route on failure and never invents a fallback. */
  autoRoute: false;
  fallback: "refuse";
  note: string;
}

export interface EngineSelectionView {
  source: "bundled" | "external_env" | "unavailable";
  path: string | null;
  sha256: string | null;
  version: string | null;
  commit: string | null;
  note: string;
}

export interface SettingsDiagnosticsView {
  generatedAt: string;
  ok: boolean;
  summary: string;
  warnings: string[];
  /** Bounded, already-redacted text suitable for support. */
  redacted: string;
  redactions: number;
}

export interface SettingsSnapshot {
  projectId: string;
  runtime: "connected" | "unavailable";
  runtimeNote: string;
  savedDefault: SavedRouteView;
  engineDefault: EngineRouteView;
  observed: ObservedRouteView | null;
  providers: ProviderCatalogView;
  models: ModelCatalogView;
  reasoning: ReasoningControlView;
  policy: RoutingPolicyView;
  engineSelection: EngineSelectionView;
  /** Hash of the engine config document the snapshot was taken against. */
  engineConfigRevision: string | null;
  configPath: string | null;
  settingsPath: string | null;
  settingsRevision: number;
}

export interface RouteChangeReceipt {
  applied: boolean;
  target: "saved_default" | "engine_default";
  before: RouteView;
  after: RouteView;
  persisted: boolean;
  requiresReload: boolean;
  backupPath: string | null;
  backupSha256: string | null;
  revisionBefore: string | null;
  revisionAfter: string | null;
  verification: string;
  note: string;
}

export interface CredentialReceipt {
  provider: string;
  credentialState: ProviderCredentialState;
  /** Never the key, and never its length. */
  stored: boolean;
  scope: "session" | "durable";
  backend: string | null;
  note: string;
}

export interface CredentialClearReceipt {
  provider: string;
  cleared: boolean;
  credentialState: ProviderCredentialState | null;
  note: string;
}
