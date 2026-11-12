import { useCallback, useEffect, useState, type JSX } from "react";
import type {
  RecoveryView,
  UninstallView,
  UpdateCheckView,
  UpdateHandoffReceipt,
  UpdateIntentRecord,
  UpdateStatusView,
} from "../../shared/contracts/update";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  SegmentedControl,
  Switch,
  TextField,
} from "../design/primitives";
import { ArchiveIcon, CheckIcon, ClockIcon, RefreshIcon, ShieldIcon } from "../design/icons";

type Tone = "neutral" | "primary" | "accent" | "success" | "attention" | "danger";

interface Notice {
  tone: Tone;
  text: string;
}

function decisionTone(view: UpdateCheckView | null): Tone {
  if (!view) return "neutral";
  if (view.decision === "available") return "success";
  if (view.decision === "refused") return "danger";
  if (view.decision === "deferred") return "attention";
  return "neutral";
}

function decisionLabel(view: UpdateCheckView): string {
  switch (view.decision) {
    case "available":
      return "Verified and ready";
    case "refused":
      return "Refused";
    case "deferred":
      return "Deferred";
    case "up_to_date":
      return "Up to date";
    default:
      return "Manual updates";
  }
}

function intentTone(state: UpdateIntentRecord["state"]): Tone {
  if (state === "handed_off") return "success";
  if (state === "observed_migrated") return "success";
  if (state === "failed") return "danger";
  if (state === "cancelled") return "neutral";
  return "attention";
}

function recoveryTone(state: RecoveryView["state"]): Tone {
  if (state === "ok") return "success";
  if (state === "migration_failed") return "danger";
  return "attention";
}

const bytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

/**
 * Settings → Updates.
 *
 * Every value here is a recorded fact: the running build's own identity, the
 * configured source, the last authenticated check, the intent timeline, the
 * verified snapshots on disk, and the ownership manifest. Nothing is estimated,
 * and an unknown cost or unverified package is shown as unknown rather than as
 * zero or safe.
 */
export function UpdateSettings(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [check, setCheck] = useState<UpdateCheckView | null>(null);
  const [receipt, setReceipt] = useState<UpdateHandoffReceipt | null>(null);
  const [uninstall, setUninstall] = useState<UninstallView | null>(null);
  const [recovery, setRecovery] = useState<RecoveryView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmLocal, setConfirmLocal] = useState(false);
  const [confirmEngine, setConfirmEngine] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [form, setForm] = useState<{
    mode: "manual" | "configured";
    baseUrl: string;
    manifestPath: string;
    teamId: string;
    manifestKey: string;
    allowLocalPackages: boolean;
  }>({
    mode: "manual",
    baseUrl: "",
    manifestPath: "update.json",
    teamId: "",
    manifestKey: "",
    allowLocalPackages: true,
  });

  const load = useCallback(async () => {
    const [statusResult, uninstallResult, recoveryResult] = await Promise.all([
      window.mona.updateStatus(),
      window.mona.uninstallGuide(),
      window.mona.stateRecovery(),
    ]);
    if (statusResult.ok) {
      setStatus(statusResult.value);
      setForm({
        mode: statusResult.value.config.mode,
        baseUrl: statusResult.value.config.baseUrl ?? "",
        manifestPath: statusResult.value.config.manifestPath ?? "update.json",
        teamId: statusResult.value.config.teamId ?? "",
        manifestKey: statusResult.value.config.manifestKey ?? "",
        allowLocalPackages: statusResult.value.config.allowLocalPackages,
      });
      setCheck(statusResult.value.lastCheck);
    } else {
      setNotice({ tone: "danger", text: statusResult.error.message });
    }
    setUninstall(uninstallResult.ok ? uninstallResult.value : null);
    setRecovery(recoveryResult.ok ? recoveryResult.value : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSource = async (): Promise<void> => {
    setBusy("source");
    setNotice(null);
    try {
      const result = await window.mona.configureUpdateSource({
        mode: form.mode,
        baseUrl: form.mode === "configured" ? form.baseUrl.trim() || null : null,
        manifestPath: form.mode === "configured" ? form.manifestPath.trim() || null : null,
        teamId: form.mode === "configured" ? form.teamId.trim() || null : null,
        manifestKey: form.mode === "configured" ? form.manifestKey.trim() || null : null,
        allowLocalPackages: form.allowLocalPackages,
      });
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.error.message });
        return;
      }
      setStatus(result.value.status);
      setNotice({
        tone: "success",
        text:
          form.mode === "configured"
            ? "Distribution source saved. A check now reads its signed manifest; nothing is downloaded until you choose to install."
            : "Manual package updates selected. Mona will not query any host.",
      });
    } finally {
      setBusy(null);
    }
  };

  const runCheck = async (): Promise<void> => {
    setBusy("check");
    setNotice(null);
    setReceipt(null);
    try {
      const result = await window.mona.checkForUpdate(true);
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.error.message });
        return;
      }
      setCheck(result.value);
      if (result.value.decision === "refused") {
        setNotice({ tone: "danger", text: result.value.reason });
      } else if (result.value.decision === "manual") {
        setNotice({ tone: "neutral", text: result.value.reason });
      }
    } finally {
      setBusy(null);
    }
  };

  const choosePackage = async (): Promise<void> => {
    setBusy("choose");
    setNotice(null);
    setReceipt(null);
    setConfirmLocal(false);
    setConfirmEngine(false);
    try {
      const result = await window.mona.chooseUpdatePackage();
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.error.message });
        return;
      }
      if (!result.value.chosen) return;
      setCheck(result.value.view);
      if (result.value.view && !result.value.view.source.manifestAuthenticated) {
        setNotice({
          tone: "neutral",
          text: "The package was inspected locally. Its identity comes from the installer metadata and its digest is recorded; it is not publisher-authenticated.",
        });
      }
    } finally {
      setBusy(null);
    }
  };

  const install = async (): Promise<void> => {
    if (!check?.candidate) return;
    setBusy("install");
    setNotice(null);
    try {
      if (check.engineChange && confirmEngine) {
        await window.mona.confirmEngineChange(check.candidate.packageSha256);
      }
      const result = await window.mona.installUpdate({
        packagePath: check.packagePath ?? undefined,
        expectedSha256: check.candidate.packageSha256,
        confirmedLocalBuild: confirmLocal,
      });
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.error.message });
        return;
      }
      setReceipt(result.value);
      if (result.value.state === "handed_off") {
        setNotice({
          tone: "success",
          text: "Apple Installer was opened with the verified package. Mona quits so the app bundle is free to replace; the next launch migrates this user's state.",
        });
      } else if (result.value.state === "deferred") {
        setNotice({ tone: "attention", text: result.value.reason });
      } else {
        setNotice({ tone: "danger", text: result.value.reason });
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const restore = async (snapshotPath: string, schemaVersion: number): Promise<void> => {
    setBusy("restore");
    setNotice(null);
    try {
      const result = await window.mona.restoreRecoverySnapshot({
        snapshotPath,
        expectedSchemaVersion: schemaVersion,
        confirmation: "restore-matching-snapshot",
      });
      if (!result.ok) {
        setNotice({ tone: "danger", text: result.error.message });
        return;
      }
      setNotice({
        tone: "success",
        text: `${result.value.note} The previous database is at ${result.value.replacedPath ?? "(none)"}.`,
      });
      setConfirmRestore(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const current = status?.current ?? null;
  const deferral = status?.deferral ?? null;
  const candidate = check?.candidate ?? null;
  const canInstall =
    check?.decision === "available" &&
    candidate !== null &&
    !deferral?.deferred &&
    (!check.engineChange || confirmEngine) &&
    (candidate.channel === "release" || confirmLocal);

  return (
    <div className="settings-section" data-testid="settings-updates">
      <Card title="This build" eyebrow="Installed identity">
        {current ? (
          <dl className="detail-list">
            <div className="detail-row">
              <dt>Version</dt>
              <dd className="mono">
                {current.version} (build {current.build})
              </dd>
            </div>
            <div className="detail-row">
              <dt>Channel</dt>
              <dd>
                <Badge tone={current.channel === "release" ? "success" : "attention"}>
                  {current.channel === "release"
                    ? "release"
                    : current.channel === "local"
                      ? "local development build"
                      : "source development build"}
                </Badge>
              </dd>
            </div>
            <div className="detail-row">
              <dt>State schema</dt>
              <dd>v{current.schemaVersion}</dd>
            </div>
            <div className="detail-row">
              <dt>Bundled engine</dt>
              <dd className="mono">{current.engineVersion ?? "not recorded"}</dd>
            </div>
          </dl>
        ) : (
          <EmptyState
            title="Build identity unavailable"
            description="The update surface did not answer, so nothing is claimed about this build."
          />
        )}
        <p className="hint-line">
          A check is a local read. It never makes a model call, and Mona never updates the bundled
          engine separately from the whole app.
        </p>
      </Card>

      {notice ? (
        <Callout tone={notice.tone === "neutral" ? "neutral" : notice.tone} title={notice.text} />
      ) : null}

      {receipt ? (
        <Card title="Handoff receipt" eyebrow="What actually happened">
          <dl className="detail-list">
            <div className="detail-row">
              <dt>State</dt>
              <dd>
                <Badge
                  tone={
                    receipt.state === "handed_off"
                      ? "success"
                      : receipt.state === "deferred"
                        ? "attention"
                        : "danger"
                  }
                >
                  {receipt.state.replace("_", " ")}
                </Badge>
              </dd>
            </div>
            <div className="detail-row">
              <dt>Version</dt>
              <dd className="mono">
                {receipt.fromVersion} → {receipt.toVersion}
              </dd>
            </div>
            <div className="detail-row">
              <dt>Package digest</dt>
              <dd className="mono wrap">{receipt.packageSha256}</dd>
            </div>
            <div className="detail-row">
              <dt>State snapshot</dt>
              <dd className="mono wrap">
                {receipt.backup
                  ? `${receipt.backup.path} (${bytes(receipt.backup.sizeBytes)}, v${receipt.backup.schemaVersion}, ${receipt.backup.integrity})`
                  : "none taken"}
              </dd>
            </div>
            <div className="detail-row">
              <dt>Installer opened</dt>
              <dd>{receipt.installerLaunched ? "yes" : "no"}</dd>
            </div>
            <div className="detail-row">
              <dt>Quitting</dt>
              <dd>
                {receipt.quitRequested
                  ? "Mona quits on the normal shutdown path so Installer can replace the bundle"
                  : "Mona stays open"}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <Card
        title="Update source"
        eyebrow="Manual or explicitly configured"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<CheckIcon size={14} />}
            onClick={() => void saveSource()}
            disabled={busy !== null}
            data-testid="update-save-source"
          >
            Save source
          </Button>
        }
      >
        <div className="field-row">
          <span className="muted">
            {status?.source.host ? `Configured host: ${status.source.host}` : "No host configured"}
          </span>
        </div>
        <div className="field-row">
          <SegmentedControl
            label="Source mode"
            value={form.mode}
            onChange={(value) =>
              setForm((prev) => ({ ...prev, mode: value as "manual" | "configured" }))
            }
            options={[
              { value: "manual", label: "Manual package" },
              { value: "configured", label: "Configured source" },
            ]}
          />
        </div>
        {form.mode === "configured" ? (
          <>
            <TextField
              label="Base URL"
              hint="HTTPS only. Mona refuses a plaintext or cross-host package URL."
              placeholder="https://updates.example.com/mona"
              value={form.baseUrl}
              mono
              onChange={(event) => setForm((prev) => ({ ...prev, baseUrl: event.target.value }))}
            />
            <TextField
              label="Manifest path"
              hint="Relative to the base URL; the manifest is a signed envelope, not a bare digest."
              value={form.manifestPath}
              mono
              onChange={(event) =>
                setForm((prev) => ({ ...prev, manifestPath: event.target.value }))
              }
            />
            <TextField
              label="Publisher team"
              hint="The exact Developer ID team the package must carry."
              value={form.teamId}
              mono
              placeholder="ABCDE12345"
              onChange={(event) => setForm((prev) => ({ ...prev, teamId: event.target.value }))}
            />
            <TextField
              label="Manifest public key"
              hint="Base64 Ed25519 public key (SPKI). The private key never lives in this app."
              value={form.manifestKey}
              mono
              onChange={(event) =>
                setForm((prev) => ({ ...prev, manifestKey: event.target.value }))
              }
            />
          </>
        ) : (
          <p className="hint-line">
            No host is queried. Choose a package you already have; Mona verifies its installer
            identity, bundle identifiers, architecture, minimum macOS, and version order before it
            offers a handoff.
          </p>
        )}
        <div className="field-row">
          <Switch
            label="Allow local development packages"
            checked={form.allowLocalPackages}
            onChange={(checked) => setForm((prev) => ({ ...prev, allowLocalPackages: checked }))}
          />
        </div>
        <p className="hint-line">
          A local package is never treated as a publisher-authenticated release, and it can never
          replace a release install.
        </p>
      </Card>

      <Card
        title="Check for updates"
        eyebrow="Local and deterministic"
        actions={
          <div className="button-row">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshIcon size={14} />}
              onClick={() => void runCheck()}
              disabled={busy !== null || form.mode !== "configured"}
              data-testid="update-check"
            >
              Check source
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<ArchiveIcon size={14} />}
              onClick={() => void choosePackage()}
              disabled={busy !== null}
              data-testid="update-choose-package"
            >
              Choose package…
            </Button>
          </div>
        }
      >
        {check ? (
          <>
            <div className="field-row">
              <Badge tone={decisionTone(check)}>{decisionLabel(check)}</Badge>
              <span className="muted">
                {check.source.manifestAuthenticated
                  ? "manifest authenticated"
                  : "not authenticated"}
                {check.source.host ? ` · ${check.source.host}` : ""} · checked{" "}
                {new Date(check.checkedAt).toLocaleString()}
              </span>
            </div>
            <p className="hint-line">{check.reason}</p>
            {check.code ? (
              <p className="hint-line mono" data-testid="update-decision-code">
                code: {check.code}
              </p>
            ) : null}
            {candidate ? (
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Candidate</dt>
                  <dd className="mono">
                    {candidate.version} (build {candidate.build}) · {candidate.channel}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Package</dt>
                  <dd className="mono wrap">
                    {candidate.packageName} · {bytes(candidate.packageSize)}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>SHA-256</dt>
                  <dd className="mono wrap">{candidate.packageSha256}</dd>
                </div>
                <div className="detail-row">
                  <dt>Requires</dt>
                  <dd>
                    macOS {candidate.minimumMacOS} · {candidate.architectures.join(", ")}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Engine</dt>
                  <dd className="mono">{candidate.engineVersion}</dd>
                </div>
                <div className="detail-row">
                  <dt>Install</dt>
                  <dd>
                    {candidate.installKind === "reinstall"
                      ? "reinstall the same version (state is kept)"
                      : "upgrade"}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Signature</dt>
                  <dd>
                    {candidate.channel === "release"
                      ? `Developer ID team ${candidate.teamId ?? "unknown"} · notarized ${candidate.notarized ? "yes" : "no"}`
                      : "local package — digest recorded, publisher not authenticated"}
                  </dd>
                </div>
              </dl>
            ) : null}
            {check.engineChange ? (
              <Callout tone="attention" title="This update changes the bundled engine">
                The package ships engine {check.engineChange.to} while this build bundles{" "}
                {check.engineChange.from}. Mona never changes the engine independently; the whole
                app is replaced together. Confirm the engine change before installing.
                <div className="field-row">
                  <Switch
                    label="I accept the engine change"
                    checked={confirmEngine}
                    onChange={setConfirmEngine}
                  />
                </div>
              </Callout>
            ) : null}
            {candidate?.channel === "local" ? (
              <Callout tone="attention" title="Local development build">
                This package is ad-hoc signed. Installing it replaces the app with an
                unauthenticated local build; it is not a shareable release.
                <div className="field-row">
                  <Switch
                    label="Install this local development build"
                    checked={confirmLocal}
                    onChange={setConfirmLocal}
                  />
                </div>
              </Callout>
            ) : null}
            {deferral?.deferred ? (
              <Callout tone="attention" title="Update deferred: work is active">
                <ul className="evidence-list" data-testid="update-deferral-items">
                  {deferral.items.map((item) => (
                    <li key={`${item.projectId}-${item.kind}-${item.taskId ?? ""}`}>
                      <Badge tone="attention">{item.kind}</Badge> {item.projectName}
                      {item.taskTitle ? ` · ${item.taskTitle}` : ""} — {item.detail}
                    </li>
                  ))}
                </ul>
                {deferral.action}
              </Callout>
            ) : null}
            <div className="button-row">
              <Button
                variant="primary"
                icon={<ShieldIcon size={15} />}
                onClick={() => void install()}
                disabled={busy !== null || !canInstall}
                data-testid="update-install"
              >
                Verify, back up state, and open Installer
              </Button>
              {!canInstall && check.decision === "available" ? (
                <span className="muted">
                  {deferral?.deferred
                    ? "Finish active work first."
                    : confirmRequiredHint(check, confirmLocal, confirmEngine)}
                </span>
              ) : null}
            </div>
          </>
        ) : (
          <p className="hint-line">
            No check has run in this launch. Checking reads the configured manifest and verifies its
            signature; it downloads nothing.
          </p>
        )}
      </Card>

      <Card title="Update history" eyebrow="Recorded intents">
        {status && status.history.length > 0 ? (
          <ul className="evidence-list" data-testid="update-history">
            {status.history.map((intent) => (
              <li key={intent.id}>
                <Badge tone={intentTone(intent.state)}>{intent.state.replace("_", " ")}</Badge>{" "}
                <span className="mono">
                  {intent.fromVersion} → {intent.toVersion}
                </span>{" "}
                · {intent.channel} · {new Date(intent.createdAt).toLocaleString()}
                <span className="muted mono wrap"> {intent.packageSha256.slice(0, 16)}…</span>
                {intent.state === "recorded" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void window.mona
                        .cancelUpdateIntent(intent.id)
                        .then(() => load())
                        .catch(() => undefined)
                    }
                  >
                    Cancel intent
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint-line">
            No update has been prepared on this Mac. An intent is recorded before anything
            privileged happens, so an interrupted update is explainable.
          </p>
        )}
      </Card>

      <Card title="State recovery" eyebrow={`Schema v${recovery?.buildSchemaVersion ?? "?"}`}>
        {recovery ? (
          <>
            <div className="field-row">
              <Badge tone={recoveryTone(recovery.state)}>
                {recovery.state === "ok"
                  ? "healthy"
                  : recovery.state === "newer_schema"
                    ? "newer schema"
                    : recovery.state === "migration_failed"
                      ? "migration failed"
                      : "unreadable"}
              </Badge>
              <span className="muted">
                database v{recovery.databaseSchemaVersion ?? "unreadable"} · this build v
                {recovery.buildSchemaVersion}
              </span>
            </div>
            {recovery.problem ? (
              <Callout
                tone={recovery.state === "ok" ? "neutral" : "danger"}
                title={recovery.problem.message}
              />
            ) : null}
            <p className="hint-line">{recovery.note}</p>
            {recovery.journal ? (
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Migration journal</dt>
                  <dd>
                    <Badge tone={recovery.journal.state === "complete" ? "success" : "attention"}>
                      {recovery.journal.state}
                    </Badge>{" "}
                    v{recovery.journal.fromVersion} → v{recovery.journal.toVersion}
                    {recovery.journal.error ? ` · ${recovery.journal.error}` : ""}
                  </dd>
                </div>
              </dl>
            ) : null}
            {recovery.snapshots.length === 0 ? (
              <p className="hint-line">
                No state snapshot exists yet under{" "}
                <span className="mono">{recovery.support.backupsPath}</span>.
              </p>
            ) : (
              <ul className="evidence-list" data-testid="recovery-snapshots">
                {recovery.snapshots.slice(0, 8).map((snapshot) => (
                  <li key={snapshot.path}>
                    <Badge tone={snapshot.appliesToThisBuild ? "success" : "neutral"}>
                      v{snapshot.schemaVersion < 0 ? "?" : snapshot.schemaVersion}
                    </Badge>{" "}
                    <span className="mono wrap">{snapshot.fileName}</span>
                    <span className="muted">
                      {" "}
                      · {bytes(snapshot.sizeBytes)} ·{" "}
                      {new Date(snapshot.createdAt).toLocaleString()} · integrity{" "}
                      {snapshot.integrity}
                      {snapshot.appliesToThisBuild ? " · restorable" : " · not this build's schema"}
                    </span>
                    {snapshot.appliesToThisBuild ? (
                      confirmRestore === snapshot.path ? (
                        <>
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => void restore(snapshot.path, snapshot.schemaVersion)}
                          >
                            Replace the database with this snapshot
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmRestore(null)}>
                            Keep current state
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setConfirmRestore(snapshot.path)}
                        >
                          Restore…
                        </Button>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <EmptyState
            title="Recovery facts unavailable"
            description="The recovery reader did not answer. No snapshot is offered, because an unverified restore is not offered."
          />
        )}
      </Card>

      <Card title="Uninstall" eyebrow="App and service only, by default">
        {uninstall ? (
          <>
            <Callout tone={uninstall.applied ? "neutral" : "attention"} title={uninstall.note} />
            {uninstall.installedReceipt ? (
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Installed</dt>
                  <dd className="mono">
                    {uninstall.installedReceipt.version} · {uninstall.installedReceipt.channel} ·{" "}
                    {uninstall.installedReceipt.package}
                  </dd>
                </div>
              </dl>
            ) : null}
            <ul className="evidence-list" data-testid="uninstall-entries">
              {uninstall.entries.map((entry) => (
                <li key={entry.path}>
                  <Badge tone={!entry.present ? "neutral" : entry.verified ? "success" : "danger"}>
                    {!entry.present ? "absent" : entry.verified ? "owned" : "refused"}
                  </Badge>{" "}
                  <span className="mono wrap">{entry.path}</span>
                  <span className="muted"> · {entry.detail}</span>
                </li>
              ))}
            </ul>
            <div className="field-row">
              <h3 className="field-row__title">Kept by default</h3>
              <ul className="evidence-list">
                {uninstall.preserves.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </div>
            <div className="field-row">
              <h3 className="field-row__title">Your state is a separate decision</h3>
              <ul className="evidence-list" data-testid="uninstall-user-data">
                {uninstall.userDataScopes.map((scope) => (
                  <li key={scope.path}>
                    <Badge tone={scope.exists ? "attention" : "neutral"}>
                      {scope.exists ? "present" : "absent"}
                    </Badge>{" "}
                    {scope.label} <span className="mono wrap">{scope.path}</span>
                    <span className="muted"> · {scope.note}</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="hint-line">
              Run these in Terminal. The utility verifies ownership and refuses an unrecognized
              path; it never walks another user's home.
            </p>
            <pre className="mono code-block" data-testid="uninstall-commands">
              {uninstall.utility.commands.dryRun}
              {"\n"}
              {uninstall.utility.commands.removeService}
              {"\n"}
              {uninstall.utility.commands.removeUserData}
            </pre>
            {uninstall.utility.path === null ? (
              <p className="hint-line">
                The utility ships inside the package payload. This copy was not installed by the
                package, so the command above will not exist until Mona is installed from its
                installer.
              </p>
            ) : null}
          </>
        ) : (
          <EmptyState
            title="Uninstall facts unavailable"
            description="The installed receipt and ownership manifest could not be read, so Mona will not guess which paths it owns."
          />
        )}
      </Card>

      <p className="hint-line">
        <ClockIcon size={13} /> An update never interrupts a run, and no step here costs a token.
      </p>
    </div>
  );
}

function confirmRequiredHint(
  view: UpdateCheckView,
  confirmLocal: boolean,
  confirmEngine: boolean,
): string {
  if (view.engineChange && !confirmEngine) return "Confirm the engine change first.";
  if (view.candidate?.channel === "local" && !confirmLocal) {
    return "Confirm this local development build first.";
  }
  return "";
}
