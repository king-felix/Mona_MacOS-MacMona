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
