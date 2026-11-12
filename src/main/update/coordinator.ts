import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULT_UPDATE_SOURCE,
  UPDATE_SOURCE_SCOPE,
  UpdateSourceConfigSchema,
  type ActiveWorkItem,
  type PackageFacts,
  type UpdateCheckView,
  type UpdateDeferral,
  type UpdateHandoffReceipt,
  type UpdateIntentRecord,
  type UpdateManifest,
  type UpdateSourceConfig,
  type UpdateStatusView,
} from "../../shared/contracts/update";
import type { StateStore } from "../state/store";
import { UpdateError } from "./errors";
import { fetchAuthenticatedManifest, downloadPackage, type FetchedBytes } from "./source";
import { resolveSecureUrl, sourceHost } from "./manifest";
import {
  evaluateUpdate,
  inspectPackage,
  manifestFromPackage,
  refusalView,
  type CurrentBuild,
  type TrustDecision,
} from "./trust";
import { compareVersions, userVisibleVersion } from "./version";

/**
 * The installer-mediated update coordinator.
 *
 * The order is the guarantee: verify the candidate, refuse while work is
 * active, record the intent, take a verified state snapshot under the
 * maintenance barrier, and only then hand the package to Apple Installer. The
 * app quits after a confirmed handoff; it never installs, never escalates its
 * own privileges, and never starts a second updater.
 *
 * Everything is injected — inspection, fetching, the Installer launcher, the
 * activity probe, the clock — so the policy can be proven without a signed
 * package or a real feed.
 */

export interface UpdateCoordinatorOptions {
  store: StateStore;
  paths: { cache: string; support: string };
  current: () => CurrentBuild;
  hostOs: () => string;
  hostArch: () => string;
  inspect?: (path: string) => PackageFacts;
  fetcher?: (url: string) => Promise<FetchedBytes>;
  launchInstaller?: (packagePath: string) => Promise<void>;
  activity?: () => Promise<ActiveWorkItem[]>;
  shouldQuit?: () => boolean;
  /**
   * Called once a handoff is confirmed. The entry point uses it to quit on the
   * normal shutdown path (which interrupts and stops owned work first), because
   * a running app holds the bundle Installer must replace.
   */
  afterHandoff?: () => void;
  now?: () => Date;
}

interface CachedCheck {
  view: UpdateCheckView;
  manifest: UpdateManifest | null;
  keyFingerprint: string | null;
  /** The bytes that were actually inspected, for a chosen or downloaded package. */
  packagePath?: string | null;
}

export function deferralFrom(items: readonly ActiveWorkItem[]): UpdateDeferral {
  if (items.length === 0) {
    return {
      deferred: false,
      items: [],
      reason: "No task, turn, or runtime is active.",
      action: "An update can be verified and handed to Installer now.",
    };
  }
  const first = items[0];
  return {
    deferred: true,
    items: [...items],
    reason:
      `${items.length} active item${items.length === 1 ? "" : "s"}: ` +
      `${first?.kind ?? "work"} in ${first?.projectName ?? "a project"}${first?.taskTitle ? ` (“${first.taskTitle}”)` : ""}.`,
    action:
      "Finish or interrupt the active work first. Mona does not stop a run to make updating convenient.",
  };
}

const defaultInspector = (path: string): PackageFacts => inspectPackage(path);

const defaultLaunchInstaller = (packagePath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-a", "Installer", packagePath], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      child.unref();
      if (code === 0) resolve();
      else
        reject(
          new UpdateError(
            "handoff_failed",
            "Apple Installer could not be opened for this package",
            {
              exit_code: code,
            },
          ),
        );
    });
  });

export class UpdateCoordinator {
  private readonly store: StateStore;
  private readonly paths: { cache: string; support: string };
  private readonly currentBuild: () => CurrentBuild;
  private readonly hostOs: () => string;
  private readonly hostArch: () => string;
  private readonly inspect: (path: string) => PackageFacts;
  private readonly fetcher: ((url: string) => Promise<FetchedBytes>) | undefined;
  private readonly launchInstaller: (packagePath: string) => Promise<void>;
  private readonly activity: () => Promise<ActiveWorkItem[]>;
  private readonly shouldQuit: () => boolean;
  private readonly afterHandoff: (() => void) | undefined;
  private readonly clock: () => Date;
  private cached: CachedCheck | null = null;
  private pendingEngineChange: { digest: string; confirmed: boolean } | null = null;

  constructor(options: UpdateCoordinatorOptions) {
    this.store = options.store;
    this.paths = options.paths;
    this.currentBuild = options.current;
    this.hostOs = options.hostOs;
    this.hostArch = options.hostArch;
    this.inspect = options.inspect ?? defaultInspector;
    this.fetcher = options.fetcher;
    this.launchInstaller = options.launchInstaller ?? defaultLaunchInstaller;
    this.activity = options.activity ?? (async () => []);
    this.shouldQuit = options.shouldQuit ?? (() => false);
    this.afterHandoff = options.afterHandoff;
    this.clock = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------- configuration

  async config(): Promise<{ config: UpdateSourceConfig; problem: string | null }> {
    const stored = await this.store.getSettings(UPDATE_SOURCE_SCOPE);
    if (!stored) return { config: { ...DEFAULT_UPDATE_SOURCE }, problem: null };
    const parsed = UpdateSourceConfigSchema.safeParse(stored.value);
    if (!parsed.success) {
      return {
        config: { ...DEFAULT_UPDATE_SOURCE },
        problem:
          "The stored update source is not valid, so Mona is using manual package updates. Reconfigure it.",
      };
    }
    return { config: parsed.data, problem: null };
  }

  /**
   * Write the source. The public key is public by design; no credential,
   * token, or private key is accepted here or stored.
   */
  async configure(input: unknown): Promise<UpdateSourceConfig> {
    const parsed = UpdateSourceConfigSchema.safeParse({ schemaVersion: 1, ...(input as object) });
    if (!parsed.success) {
      throw new UpdateError("source_unconfigured", "the update source configuration is not valid", {
        issues: parsed.error.issues.map((issue) => issue.message).slice(0, 5),
      });
    }
    await this.store.putSettings(UPDATE_SOURCE_SCOPE, parsed.data);
    this.cached = null;
    return parsed.data;
  }

  // -------------------------------------------------------------------- reads

  async status(): Promise<UpdateStatusView> {
    const { config, problem } = await this.config();
    const current = this.currentBuild();
    const lastIntent = await this.store.latestUpdateIntent();
    const history = await this.store.listUpdateIntents(10);
    const deferral = deferralFrom(await this.safeActivity());
    const source: UpdateCheckView["source"] = {
      baseUrl: config.baseUrl,
      host: sourceHost(config.baseUrl),
      manifestAuthenticated: this.cached?.view.source.manifestAuthenticated ?? false,
      keyFingerprint: this.cached?.keyFingerprint ?? null,
    };
    return {
      current: {
        version: current.version,
        build: current.build,
        channel: current.channel,
        schemaVersion: current.schemaVersion,
        engineVersion: current.engineVersion,
      },
      config,
      configProblem: problem,
      source,
      lastCheck: this.cached?.view ?? null,
      lastIntent,
      history,
      deferral,
      note:
        config.mode === "manual"
          ? "Manual package updates. No distribution source is configured, so a package is chosen and verified locally."
          : "A distribution source is configured. Checking reads its signed manifest; installing downloads and hands the verified package to Apple Installer.",
    };
  }

  async deferral(): Promise<UpdateDeferral> {
    return deferralFrom(await this.safeActivity());
  }

  private async safeActivity(): Promise<ActiveWorkItem[]> {
    try {
      return await this.activity();
    } catch {
      // A probe failure is not "nothing is active". Treat it as deferred with
      // an honest item so an update cannot proceed on an unknown state.
      return [
        {
          projectId: "unknown",
          projectName: "Mona",
          kind: "runtime",
          taskId: null,
          taskTitle: null,
          detail: "Mona could not read whether work is active, so it refuses to replace the app.",
        },
      ];
    }
  }

  // -------------------------------------------------------------------- check

  async check(options: { refresh?: boolean } = {}): Promise<UpdateCheckView> {
    const { config, problem } = await this.config();
    const current = this.currentBuild();
    const checkedAt = this.clock().toISOString();

    if (config.mode === "manual") {
      const view: UpdateCheckView = {
        mode: "manual",
        decision: "manual",
        code: "no_source",
        reason:
          "No distribution source is configured. Mona shows manual package updates and verifies a package you choose.",
        checkedAt,
        current: {
          version: current.version,
          build: current.build,
          channel: current.channel,
          schemaVersion: current.schemaVersion,
          engineVersion: current.engineVersion,
        },
        candidate: null,
        engineChange: null,
        deferral: deferralFrom(await this.safeActivity()),
        packagePath: null,
        source: { baseUrl: null, host: null, manifestAuthenticated: false, keyFingerprint: null },
        inference: {
          requests: 0,
          note: "An update check is a local read; it makes no model call.",
        },
      };
      this.cached = { view, manifest: null, keyFingerprint: null };
      return view;
    }

    if (problem) {
      return refusalView({
        code: "source_unconfigured",
        reason: problem,
        current,
        mode: config.mode,
        baseUrl: config.baseUrl,
        checkedAt,
      });
    }
    if (!options.refresh && this.cached) {
      return this.cached.view;
    }

    try {
      const authenticated = await fetchAuthenticatedManifest(config, this.fetcher);
      const applied = await this.store.appliedUpdatePackages();
      const trust = evaluateUpdate({
        mode: "configured",
        source: config,
        manifest: authenticated.manifest,
        packageFacts: null,
        stage: "announce",
        current,
        hostOs: this.hostOs(),
        hostArch: this.hostArch(),
        applied,
      });
      const view = this.viewFrom(trust, {
        checkedAt,
        current,
        config,
        keyFingerprint: authenticated.keyFingerprint,
        authenticated: true,
        deferral: deferralFrom(await this.safeActivity()),
        packagePath: null,
      });
      this.cached = {
        view,
        manifest: authenticated.manifest,
        keyFingerprint: authenticated.keyFingerprint,
      };
      return view;
    } catch (error) {
      const updateError =
        error instanceof UpdateError
          ? error
          : new UpdateError(
              "manifest_malformed",
              error instanceof Error ? error.message : "the update source could not be read",
            );
      const view = refusalView({
        code: updateError.code,
        reason: updateError.message,
        current,
        mode: config.mode,
        baseUrl: config.baseUrl,
        checkedAt,
      });
      this.cached = { view, manifest: null, keyFingerprint: null };
      return view;
    }
  }

  // ------------------------------------------------------- local package path

  /**
   * Verify a package the user chose. A local package has no manifest from a
   * source, so its manifest is derived from the package and evaluated by the
   * same policy — which is why an ad-hoc package can never pass as a release.
   */
  async inspectLocal(packagePath: string): Promise<UpdateCheckView> {
    const { config } = await this.config();
    const current = this.currentBuild();
    const checkedAt = this.clock().toISOString();
    try {
      if (!existsSync(packagePath)) {
        throw new UpdateError(
          "manifest_malformed",
          "There is no package file at that path. Choose the package again.",
          { path: packagePath },
        );
      }
      const facts = this.inspect(packagePath);
      const manifest = manifestFromPackage(facts, {
        version: facts.package.version ?? "0.0.0",
        build: facts.package.build ?? 1,
        channel: "local",
      });
      const applied = await this.store.appliedUpdatePackages();
      const trust = evaluateUpdate({
        mode: "manual",
        source: config,
        manifest,
        packageFacts: facts,
        stage: "package",
        current,
        hostOs: this.hostOs(),
        hostArch: this.hostArch(),
        applied,
        localSelection: true,
        engineChangeConfirmed: this.engineConfirmed(facts.sha256),
      });
      const view = this.viewFrom(trust, {
        checkedAt,
        current,
        config,
        keyFingerprint: null,
        authenticated: false,
        deferral: deferralFrom(await this.safeActivity()),
        packagePath,
      });
      this.cached = { view, manifest, keyFingerprint: null, packagePath };
      return view;
    } catch (error) {
      const updateError =
        error instanceof UpdateError
          ? error
          : new UpdateError(
              "manifest_malformed",
              error instanceof Error ? error.message : "the package could not be inspected",
            );
      const view = refusalView({
        code: updateError.code,
        reason: updateError.message,
        current,
        mode: "manual",
        baseUrl: null,
        checkedAt,
      });
      this.cached = { view, manifest: null, keyFingerprint: null };
      return view;
    }
  }

  private viewFrom(
    trust: TrustDecision,
    context: {
      checkedAt: string;
      current: CurrentBuild;
      config: UpdateSourceConfig;
      keyFingerprint: string | null;
      authenticated: boolean;
      deferral: UpdateDeferral;
      packagePath?: string | null;
    },
  ): UpdateCheckView {
    return {
      mode: context.config.mode,
      decision: trust.decision,
      code: trust.code,
      reason: trust.reason,
      checkedAt: context.checkedAt,
      current: {
        version: context.current.version,
        build: context.current.build,
        channel: context.current.channel,
        schemaVersion: context.current.schemaVersion,
        engineVersion: context.current.engineVersion,
      },
      candidate: trust.candidate,
      engineChange: trust.engineChange,
      deferral: context.deferral,
      packagePath: context.packagePath ?? null,
      source: {
        baseUrl: context.config.baseUrl,
        host: sourceHost(context.config.baseUrl),
        manifestAuthenticated: context.authenticated,
        keyFingerprint: context.keyFingerprint,
      },
      inference: { requests: 0, note: "An update check is a local read; it makes no model call." },
    };
  }

  // ------------------------------------------------------------------ install

  /**
   * Acknowledge a disclosed engine change for exactly one package digest. The
   * acknowledgement is bound to bytes, so it cannot be replayed onto another
   * package.
   */
  confirmEngineChange(packageSha256: string): void {
    this.pendingEngineChange = { digest: packageSha256, confirmed: true };
  }

  private engineConfirmed(packageSha256: string): boolean {
    return (
      this.pendingEngineChange?.confirmed === true &&
      this.pendingEngineChange.digest === packageSha256
    );
  }

  async install(request: {
    packagePath?: string;
    expectedSha256: string;
    confirmedLocalBuild?: boolean;
    confirmedEngineChange?: boolean;
  }): Promise<UpdateHandoffReceipt> {
    const current = this.currentBuild();
    const makeRefused = (
      code: UpdateHandoffReceipt["code"],
      reason: string,
      extra: Partial<UpdateHandoffReceipt> = {},
    ): UpdateHandoffReceipt => ({
      intentId: null,
      state: "refused",
      code,
      reason,
      fromVersion: current.version,
      toVersion: current.version,
      packagePath: request.packagePath ?? "",
      packageSha256: request.expectedSha256,
      backup: null,
      intentRecordedAt: null,
      handedOffAt: null,
      installerLaunched: false,
      quitRequested: false,
      ...extra,
    });

    let intent: UpdateIntentRecord | null = null;
    try {
      const { config } = await this.config();
      let manifest: UpdateManifest;
      let facts: PackageFacts;
      let packagePath: string;

      if (config.mode === "configured" && !this.cached?.manifest) {
        await this.check({ refresh: true });
      }

      if (config.mode === "configured") {
        const cachedManifest = this.cached?.manifest ?? null;
        if (cachedManifest === null || cachedManifest.package.sha256 !== request.expectedSha256) {
          return makeRefused(
            "digest_mismatch",
            "The configured source no longer names the package that was verified.",
          );
        }
        manifest = cachedManifest;
        if (config.baseUrl === null) {
          return makeRefused("source_unconfigured", "No distribution source origin is configured.");
        }
        // The bytes are downloaded only for a package that already passed the
        // announce policy, and they are hashed while they are written.
        const downloaded = await downloadPackage({
          url: resolveSecureUrl(config.baseUrl, manifest.package.url),
          destination: join(this.paths.cache, "updates", manifest.package.name),
          expectedSha256: manifest.package.sha256,
          expectedSize: manifest.package.sizeBytes,
        });
        packagePath = downloaded.path;
        facts = this.inspect(packagePath);
      } else {
        const chosenPath = request.packagePath ?? this.cached?.packagePath ?? null;
        if (!chosenPath) {
          return makeRefused("manifest_malformed", "No package was chosen for a manual update.");
        }
        packagePath = chosenPath;
        if (!existsSync(packagePath)) {
          return makeRefused(
            "manifest_malformed",
            "The package file is no longer at the verified path. Choose it again.",
          );
        }
        facts = this.inspect(packagePath);
        manifest = manifestFromPackage(facts, {
          version: facts.package.version ?? "0.0.0",
          build: facts.package.build ?? 1,
          channel: "local",
        });
      }

      if (facts.sha256 !== request.expectedSha256) {
        return makeRefused(
          "digest_mismatch",
          "The package at this path changed after it was verified. Choose it again.",
          { packagePath, toVersion: manifest.version },
        );
      }
      if (manifest.channel === "local" && request.confirmedLocalBuild !== true) {
        return makeRefused(
          "local_build_unconfirmed",
          "This is a local development build. Confirm it explicitly before installing.",
          { packagePath, toVersion: manifest.version },
        );
      }

      const applied = await this.store.appliedUpdatePackages();
      const trust = evaluateUpdate({
        mode: config.mode,
        source: config,
        manifest,
        packageFacts: facts,
        stage: "package",
        current,
        hostOs: this.hostOs(),
        hostArch: this.hostArch(),
        applied,
        localSelection: manifest.channel === "local",
        engineChangeConfirmed:
          request.confirmedEngineChange === true || this.engineConfirmed(facts.sha256),
      });
      if (trust.decision !== "available" || trust.candidate === null) {
        return makeRefused(trust.code ?? "manifest_malformed", trust.reason, {
          packagePath,
          toVersion: manifest.version,
        });
      }

      const deferral = deferralFrom(await this.safeActivity());
      if (deferral.deferred) {
        return {
          ...makeRefused(null, `${deferral.reason} ${deferral.action}`, {
            packagePath,
            toVersion: manifest.version,
          }),
          state: "deferred",
        };
      }

      // 1. Record the intent before anything privileged happens.
      const recorded = await this.store.recordUpdateIntent({
        fromVersion: current.version,
        toVersion: manifest.version,
        channel: manifest.channel,
        packagePath,
        packageSha256: facts.sha256,
        source: config.mode,
        detail: {
          build: manifest.build,
          install_kind: trust.candidate.installKind,
          engine_change: trust.engineChange,
        },
      });

      intent = recorded;

      // 2. Quiesce writers and take a verified snapshot. This holds the store's
      //    exclusive maintenance barrier for the length of the copy.
      let backup;
      try {
        backup = await this.store.backupForUpdate(manifest.version);
      } catch (error) {
        await this.store
          .settleUpdateIntent(recorded.id, "failed", {
            detail: { cause: error instanceof Error ? error.message : String(error) },
          })
          .catch(() => undefined);
        intent = null;
        return makeRefused(
          "backup_failed",
          "Mona could not verify a state snapshot, so it did not start the update. Your state is unchanged.",
          { packagePath, toVersion: manifest.version },
        );
      }
      intent = await this.store.attachUpdateBackup(recorded.id, backup.path, backup.sha256);
      const activeIntent = intent;
      const backupReceipt = {
        path: backup.path,
        sha256: backup.sha256,
        sizeBytes: backup.sizeBytes,
        schemaVersion: backup.schemaVersion,
        integrity: "ok" as const,
      };

      // 3. Hand the verified package to the user's normal authorization path.
      try {
        await this.launchInstaller(packagePath);
      } catch (error) {
        await this.store
          .settleUpdateIntent(activeIntent.id, "failed", {
            detail: { cause: error instanceof Error ? error.message : String(error) },
          })
          .catch(() => undefined);
        return makeRefused(
          "handoff_failed",
          "Apple Installer did not open, so the update was not handed off. Mona is still running.",
          {
            intentId: activeIntent.id,
            packagePath,
            toVersion: manifest.version,
            backup: backupReceipt,
            intentRecordedAt: activeIntent.createdAt,
          },
        );
      }

      const settled = await this.store.settleUpdateIntent(activeIntent.id, "handed_off");
      this.pendingEngineChange = null;
      const quitting = this.afterHandoff !== undefined && this.shouldQuit();
      if (quitting) this.afterHandoff?.();
      return {
        intentId: settled.id,
        state: "handed_off",
        code: null,
        reason:
          "Apple Installer was opened for this package. Finish or cancel it there; Mona quits and migrates its own state on the next launch.",
        fromVersion: current.version,
        toVersion: manifest.version,
        packagePath,
        packageSha256: facts.sha256,
        backup: backupReceipt,
        intentRecordedAt: settled.createdAt,
        handedOffAt: settled.updatedAt,
        installerLaunched: true,
        quitRequested: quitting,
      };
    } catch (error) {
      const updateError =
        error instanceof UpdateError
          ? error
          : new UpdateError(
              "handoff_failed",
              error instanceof Error ? error.message : "the update could not be prepared",
            );
      if (intent) {
        await this.store
          .settleUpdateIntent(intent.id, "failed", { detail: { cause: updateError.message } })
          .catch(() => undefined);
      }
      return makeRefused(updateError.code, updateError.message);
    }
  }

  // ------------------------------------------------------------ reconciliation

  /**
   * After a launch, read the previous intake. A newer running version proves
   * the migration happened; an unchanged version means Installer was cancelled,
   * and the intent is closed as cancelled so the package can be chosen again.
   */
  async reconcileOnLaunch(): Promise<UpdateIntentRecord | null> {
    const latest = await this.store.latestUpdateIntent();
    if (!latest || latest.state !== "handed_off") return latest;
    const current = this.currentBuild();
    const settled = await this.store.settleUpdateIntent(
      latest.id,
      compareVersions(current.version, latest.toVersion) >= 0 ? "observed_migrated" : "cancelled",
    );
    return settled;
  }

  async cancelIntent(intentId: string): Promise<UpdateIntentRecord> {
    return this.store.settleUpdateIntent(intentId, "cancelled");
  }

  /** The user-visible version, without the development suffix. */
  currentVersionLabel(): string {
    return userVisibleVersion(this.currentBuild().version);
  }
}

export function readBuildInfo(options: {
  resourcesPath: string | null;
  appVersion: string;
  packaged: boolean;
  schemaVersion: number;
}): CurrentBuild {
  const manifestPath =
    options.resourcesPath === null ? null : join(options.resourcesPath, "component-manifest.json");
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version?: string;
        build?: number;
        channel?: string;
        engine?: { version?: string; commit?: string };
      };
      return {
        version: manifest.version ?? userVisibleVersion(options.appVersion),
        build: typeof manifest.build === "number" ? manifest.build : 0,
        channel:
          manifest.channel === "release" || manifest.channel === "local"
            ? manifest.channel
            : options.packaged
              ? "release"
              : "development",
        schemaVersion: options.schemaVersion,
        engineVersion: manifest.engine?.version ?? null,
        engineCommit: manifest.engine?.commit ?? null,
      };
    } catch {
      // Fall through to the conservative development identity.
    }
  }
  return {
    version: userVisibleVersion(options.appVersion),
    build: 0,
    channel: options.packaged ? "release" : "development",
    schemaVersion: options.schemaVersion,
    engineVersion: null,
    engineCommit: null,
  };
}
