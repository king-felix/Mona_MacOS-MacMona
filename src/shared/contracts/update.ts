import { z } from "zod";

/**
 * Update, migration, rollback, and uninstall (P23).
 *
 * The update itself is Apple Installer's: Mona verifies a package, records the
 * intent, backs up state, and hands the package to the user's normal
 * authorization path. Nothing here installs root code, runs a downloaded
 * script, or self-updates. Every check is local and deterministic, and an
 * update check makes zero inference requests.
 *
 * Two trust tiers are explicit rather than folded together:
 *
 * - `release` — an authenticated manifest (Ed25519 over the exact manifest
 *   bytes), a Developer ID Installer signature from the expected team, and a
 *   digest that matches. Only this tier is a shareable update.
 * - `local` — a package the user chose, labelled "local development build".
 *   Its identity comes from package metadata and its digest is recorded, but
 *   an ad-hoc package is never treated as publisher-authenticated. A local
 *   package updates a local build only; it never claims a production release.
 */

export const UPDATE_CHANNELS = ["release", "local"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** The running build's own channel, as observed rather than assumed. */
export const BUILD_CHANNELS = ["release", "local", "development"] as const;
export type BuildChannel = (typeof BUILD_CHANNELS)[number];

export const MONA_BUNDLE_ID = "com.mona.workbench";
export const MONA_SERVICE_BUNDLE_ID = "com.mona.workbench.service";
export const MONA_PACKAGE_ID = "com.mona.workbench.pkg";
export const MONA_PRODUCT = "Mona";

// ------------------------------------------------------------- version order

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Numeric pre-release components; an empty list is a final release. */
  pre: string[];
  raw: string;
}

// ------------------------------------------------------------ source config

/**
 * An explicitly configured distribution source. There is no built-in URL and
 * no default host: an unconfigured install is in `manual` mode and says so.
 */
export interface UpdateSourceConfig {
  schemaVersion: 1;
  mode: "manual" | "configured";
  /** HTTPS origin of the distribution source; null in manual mode. */
  baseUrl: string | null;
  /** Document path relative to `baseUrl`, e.g. `update.json`. */
  manifestPath: string | null;
  /** Exact Developer ID team the package must carry. */
  teamId: string | null;
  /** Ed25519 public key, base64-encoded SPKI, that authenticates the manifest. */
  manifestKey: string | null;
  /** When true a chosen local package may update a local build. */
  allowLocalPackages: boolean;
}

export const UPDATE_SOURCE_SCOPE = "app:update-source";

const ABSOLUTE_HTTPS =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/i;

export const UpdateSourceConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    mode: z.enum(["manual", "configured"]),
    baseUrl: z.string().min(1).max(2048).regex(ABSOLUTE_HTTPS).nullable(),
    manifestPath: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
      .nullable(),
    teamId: z
      .string()
      .min(5)
      .max(20)
      .regex(/^[A-Z0-9]+$/)
      .nullable(),
    manifestKey: z.string().min(32).max(4096).nullable(),
    allowLocalPackages: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "configured") {
      for (const field of ["baseUrl", "manifestPath", "teamId", "manifestKey"] as const) {
        if (value[field] === null) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is required for a configured source`,
          });
        }
      }
    }
    if (value.baseUrl !== null && value.baseUrl.endsWith("/")) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "baseUrl must not end with a slash",
      });
    }
  });

export const DEFAULT_UPDATE_SOURCE: UpdateSourceConfig = {
  schemaVersion: 1,
  mode: "manual",
  baseUrl: null,
  manifestPath: null,
  teamId: null,
  manifestKey: null,
  allowLocalPackages: true,
};

// ---------------------------------------------------------------- manifest

/**
 * The candidate a source announces. The signature covers the manifest bytes,
 * and the manifest names the package digest and length; the package signature
 * names the publisher. Neither is trusted alone.
 */
export interface UpdateManifest {
  schemaVersion: 1;
  product: typeof MONA_PRODUCT;
  channel: UpdateChannel;
  /** User-visible version, ordered numerically (for example `0.2.0`). */
  version: string;
  /** Monotonic build counter; a build must increase for an upgrade. */
  build: number;
  bundleId: string;
  serviceBundleId: string;
  packageId: string;
  /** Developer ID team the package must carry; null for a local package. */
  teamId: string | null;
  minimumMacOS: string;
  architectures: string[];
  engine: { version: string; commit: string };
  package: {
    /** Absolute HTTPS URL, or a path relative to the configured origin. */
    url: string;
    name: string;
    sha256: string;
    sizeBytes: number;
    /** False means the publisher did not notarize it; a release refuses. */
    notarized: boolean;
  };
  releasedAt: string;
  notesUrl: string | null;
}

export const UpdateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  product: z.literal(MONA_PRODUCT),
  channel: z.enum(UPDATE_CHANNELS),
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/),
  build: z.number().int().min(1),
  bundleId: z.string().min(1).max(200),
  serviceBundleId: z.string().min(1).max(200),
  packageId: z.string().min(1).max(200),
  teamId: z
    .string()
    .min(5)
    .max(20)
    .regex(/^[A-Z0-9]+$/)
    .nullable(),
  minimumMacOS: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+(?:\.\d+){0,2}$/),
  architectures: z
    .array(z.enum(["arm64", "x86_64"]))
    .min(1)
    .max(2),
  engine: z.strictObject({
    version: z.string().min(1).max(64),
    commit: z.string().min(1).max(64),
  }),
  package: z.strictObject({
    url: z.string().min(1).max(2048),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9._ -]+\.pkg$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1024 * 1024 * 1024),
    notarized: z.boolean(),
  }),
  releasedAt: z.string().min(10).max(40),
  notesUrl: z.string().min(1).max(2048).nullable(),
});

/** Detached Ed25519 signature over the exact manifest bytes, base64. */
export interface SignedManifestEnvelope {
  schemaVersion: 1;
  algorithm: "ed25519";
  /** Base64 of the exact manifest JSON bytes the signature covers. */
  payload: string;
  /** Base64 signature over those decoded bytes. */
  signature: string;
}

export const SignedManifestEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  algorithm: z.literal("ed25519"),
  payload: z.string().min(2).max(200_000),
  signature: z.string().min(2).max(4096),
});

/** Manifest bytes above this are refused before they are parsed. */
export const MAX_MANIFEST_BYTES = 256 * 1024;

// -------------------------------------------------------- package facts

export interface PackageSignatureFacts {
  /** What the platform tool reported, not what the package claims. */
  status: "signed" | "adhoc" | "unsigned" | "unknown";
  teamId: string | null;
  /** Certificate common names in chain order, for an audit trail. */
  authorities: string[];
  /** True when a Developer ID Installer authority is present. */
  developerIdInstaller: boolean;
  identifier: string | null;
}

export interface PackageFacts {
  path: string;
  sha256: string;
  sizeBytes: number;
  signature: PackageSignatureFacts;
  package: {
    identifier: string | null;
    version: string | null;
    /** CFBundleVersion, the monotonic build counter Installer enforces. */
    build: number | null;
    installLocation: string | null;
    minimumMacOS: string | null;
  };
  appBundleId: string | null;
  serviceBundleId: string | null;
  architectures: string[];
  engine: { version: string; commit: string } | null;
  /** Where these facts came from; a fixture is labelled as one. */
  source: "pkgutil" | "fixture";
}

// -------------------------------------------------------------- evaluation

export const UPDATE_REJECTION_CODES = [
  "no_source",
  "source_unconfigured",
  "insecure_source",
  "source_host_mismatch",
  "manifest_too_large",
  "manifest_malformed",
  "manifest_unauthenticated",
  "manifest_key_mismatch",
  "manifest_signature_invalid",
  "manifest_channel_mismatch",
  "product_mismatch",
  "identity_mismatch",
  "wrong_team",
  "package_unsigned",
  "package_adhoc",
  "package_identity_mismatch",
  "digest_mismatch",
  "size_mismatch",
  "package_too_large",
  "architecture_mismatch",
  "os_too_old",
  "downgrade",
  "replayed",
  "notarization_missing",
  "engine_mismatch",
  "local_package_not_allowed",
  "release_updates_local_only",
  "engine_change_unconfirmed",
  "local_build_unconfirmed",
  "backup_failed",
  "handoff_failed",
] as const;
export type UpdateRejectionCode = (typeof UPDATE_REJECTION_CODES)[number];

export type UpdateInstallKind = "upgrade" | "reinstall";

export interface UpdateCandidateSummary {
  version: string;
  build: number;
  channel: UpdateChannel;
  packageName: string;
  packageSha256: string;
  packageSize: number;
  minimumMacOS: string;
  architectures: string[];
  engineVersion: string;
  teamId: string | null;
  notarized: boolean;
  releasedAt: string;
  installKind: UpdateInstallKind;
}

export type UpdateDecision = "manual" | "up_to_date" | "available" | "refused" | "deferred";

export interface UpdateCheckView {
  mode: "manual" | "configured";
  decision: UpdateDecision;
  code: UpdateRejectionCode | null;
  reason: string;
  checkedAt: string;
  current: {
    version: string;
    build: number;
    channel: BuildChannel;
    schemaVersion: number;
    engineVersion: string | null;
  };
  candidate: UpdateCandidateSummary | null;
  /** Present when the candidate changes the bundled engine; never silent. */
  engineChange: { from: string; to: string } | null;
  /** Active work that would lose state if the app were replaced now. */
  deferral: UpdateDeferral | null;
  /**
   * The absolute path of the package that was actually verified, and whose
   * digest appears in `candidate`. Install re-reads this path and refuses if its
   * bytes no longer hash to that digest.
   */
  packagePath: string | null;
  source: {
    baseUrl: string | null;
    host: string | null;
    /** True only when the manifest signature verified. */
    manifestAuthenticated: boolean;
    keyFingerprint: string | null;
  };
  /** Always zero: an update check is a local HTTP read, never an inference call. */
  inference: { requests: 0; note: string };
}

// --------------------------------------------------------------- deferral

export interface ActiveWorkItem {
  projectId: string;
  projectName: string;
  kind: "turn" | "task" | "runtime" | "submission";
  taskId: string | null;
  taskTitle: string | null;
  detail: string;
}

export interface UpdateDeferral {
  deferred: boolean;
  items: ActiveWorkItem[];
  reason: string;
  action: string;
}

// ---------------------------------------------------------------- handoff

export interface UpdateBackupReceipt {
  path: string;
  sha256: string;
  sizeBytes: number;
  schemaVersion: number;
  integrity: "ok";
}

export type UpdateHandoffState = "refused" | "deferred" | "recorded" | "handed_off";

export interface UpdateHandoffReceipt {
  intentId: string | null;
  state: UpdateHandoffState;
  code: UpdateRejectionCode | "cancelled" | null;
  reason: string;
  fromVersion: string;
  toVersion: string;
  packagePath: string;
  packageSha256: string;
  backup: UpdateBackupReceipt | null;
  intentRecordedAt: string | null;
  handedOffAt: string | null;
  installerLaunched: boolean;
  /** The app asks the shell to quit after a successful handoff. */
  quitRequested: boolean;
}

export interface UpdateIntentRecord {
  id: string;
  state: "recorded" | "handed_off" | "cancelled" | "failed" | "observed_migrated";
  fromVersion: string;
  toVersion: string;
  channel: UpdateChannel;
  packagePath: string;
  packageSha256: string;
  source: "manual" | "configured";
  backupPath: string | null;
  backupSha256: string | null;
  createdAt: string;
  updatedAt: string;
}

// -------------------------------------------------------------- uninstall

export interface UninstallEntry {
  path: string;
  kind: string;
  present: boolean;
  /** Ownership verified against the manifest and the bundle identity. */
  verified: boolean;
  detail: string;
}

export interface UninstallDataScope {
  label: string;
  path: string;
  exists: boolean;
  note: string;
}

export interface UninstallView {
  applied: boolean;
  installedReceipt: {
    version: string;
    channel: string;
    package: string;
    manifestSha256: string | null;
    installedAt: string;
  } | null;
  ownershipManifestPresent: boolean;
  entries: UninstallEntry[];
  userDataScopes: UninstallDataScope[];
  preserves: string[];
  utility: {
    /** Absolute path to the utility inside the running install, when present. */
    path: string | null;
    signed: false;
    commands: {
      dryRun: string;
      removeService: string;
      removeUserData: string;
    };
  };
  note: string;
}

// ---------------------------------------------------------------- recovery

export interface RecoverySnapshot {
  path: string;
  fileName: string;
  schemaVersion: number;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  integrity: "ok" | "failed";
  /** True when this build can open the snapshot without a downgrade refusal. */
  appliesToThisBuild: boolean;
}

export interface RecoveryJournalView {
  path: string;
  fromVersion: number;
  toVersion: number;
  state: "started" | "complete" | "failed" | "restored";
  backupPath: string | null;
  error: string | null;
  updatedAt: string;
}

export interface RecoveryView {
  buildSchemaVersion: number;
  databaseSchemaVersion: number | null;
  state: "ok" | "newer_schema" | "migration_failed" | "unreadable";
  problem: { code: string; message: string } | null;
  snapshots: RecoverySnapshot[];
  journal: RecoveryJournalView | null;
  support: {
    supportPath: string;
    backupsPath: string;
    reportPath: string | null;
    instruction: string;
  };
  canRestoreSnapshot: boolean;
  note: string;
}

// ------------------------------------------------------------------- IPC

export const UpdateConfigureRequestSchema = z.strictObject({
  mode: z.enum(["manual", "configured"]),
  baseUrl: z.string().min(1).max(2048).nullable(),
  manifestPath: z.string().min(1).max(200).nullable(),
  teamId: z.string().min(5).max(20).nullable(),
  manifestKey: z.string().min(32).max(4096).nullable(),
  allowLocalPackages: z.boolean(),
});

export const UpdateCheckRequestSchema = z.strictObject({
  /** Re-read the configured source even when a cached check exists. */
  refresh: z.boolean().optional(),
});

export const UpdateChoosePackageRequestSchema = z.strictObject({
  /** Absolute path chosen through the native file dialog. */
  path: z.string().min(1).max(4096).startsWith("/").optional(),
});

export const UpdateInstallRequestSchema = z.strictObject({
  packagePath: z.string().min(1).max(4096).startsWith("/"),
  /** The digest the user saw; a different file is refused rather than swapped. */
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  confirmedLocalBuild: z.boolean().optional(),
});

export const UpdateIntentQuerySchema = z.strictObject({
  intentId: z.string().min(1).max(120).optional(),
});

export const RecoveryRestoreRequestSchema = z.strictObject({
  /** An absolute snapshot path from `state:recovery`; never a caller-built path. */
  snapshotPath: z.string().min(1).max(4096).startsWith("/"),
  /** The schema version the user was told the snapshot holds. */
  expectedSchemaVersion: z.number().int().min(1),
  confirmation: z.literal("restore-matching-snapshot"),
});

export interface RecoveryRestoreReceipt {
  restored: boolean;
  fromVersion: number;
  toVersion: number;
  snapshotPath: string;
  replacedPath: string | null;
  integrity: "ok";
  note: string;
}

/** The Settings panel's whole state, read once per refresh. */
export interface UpdateStatusView {
  current: UpdateCheckView["current"];
  config: UpdateSourceConfig;
  /** Why a configured source could not be used, if it could not. */
  configProblem: string | null;
  source: UpdateCheckView["source"];
  lastCheck: UpdateCheckView | null;
  lastIntent: UpdateIntentRecord | null;
  history: UpdateIntentRecord[];
  deferral: UpdateDeferral;
  note: string;
}

export const UPDATE_TAB_ID = "updates";
