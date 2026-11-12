import { useEffect, useMemo, useState, type JSX } from "react";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  ModelCatalogView,
  ModelView,
  ProviderView,
  RouteChangeReceipt,
  SettingsDiagnosticsView,
  SettingsSnapshot,
} from "../../shared/contracts/settings";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  SegmentedControl,
  SelectField,
  Switch,
  TextField,
} from "../design/primitives";
import { RefreshIcon, ShieldIcon, TerminalIcon, WarningIcon } from "../design/icons";

type Tone = "neutral" | "primary" | "accent" | "success" | "attention" | "danger";

interface Notice {
  tone: Tone;
  text: string;
}

function providerOptions(providers: ProviderView[]): Array<{ value: string; label: string }> {
  return providers.map((provider) => ({
    value: provider.id,
    label: `${provider.displayName}${provider.current ? " · engine default" : ""}${
      provider.credentialState === "missing" ? " · no key" : ""
    }`,
  }));
}

function modelOptions(models: ModelView[]): Array<{ value: string; label: string }> {
  return models.map((model) => ({
    value: model.id,
    label: `${model.id}${
      model.contextTokens ? ` · ${Math.round(model.contextTokens / 1000)}k ctx` : ""
    }`,
  }));
}

function endpointTone(status: SettingsSnapshot["engineDefault"]["endpointStatus"]): Tone {
  if (status === "malformed") return "danger";
  if (status === "configured") return "success";
  if (status === "default") return "neutral";
  return "attention";
}

function credentialTone(state: ProviderView["credentialState"]): Tone {
  if (state === "configured" || state === "no_auth" || state === "local") return "success";
  if (state === "missing" || state === "login_required") return "attention";
  return "neutral";
}

export function RouteSettings({
  projectId,
  onOpenStudio,
}: {
  projectId: ProjectId;
  onOpenStudio: () => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [models, setModels] = useState<ModelCatalogView | null>(null);
  const [provider, setProvider] = useState("deepseek");
  const [model, setModel] = useState("deepseek-flash");
  const [effort, setEffort] = useState("");
  const [posture, setPosture] = useState<"full_access" | "ask">("full_access");
  const [autoApprove, setAutoApprove] = useState(true);
  const [trustMode, setTrustMode] = useState(true);
  const [allowShell, setAllowShell] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [receipt, setReceipt] = useState<RouteChangeReceipt | null>(null);
  const [diagnostics, setDiagnostics] = useState<SettingsDiagnosticsView | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [keyScope, setKeyScope] = useState<"session" | "durable">("session");
  const [confirmEngine, setConfirmEngine] = useState(false);

  const load = async (): Promise<void> => {
    if (typeof window.mona.settingsSnapshot !== "function") {
      setNotice({
        tone: "attention",
        text: "This build does not expose the configuration bridge.",
      });
      return;
    }
    const result = await window.mona.settingsSnapshot(projectId);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    const next = result.value;
    setSnapshot(next);
    setProvider(next.savedDefault.route.provider);
    setModel(next.savedDefault.route.model);
    setEffort(next.savedDefault.route.reasoningEffort ?? "");
    setPosture(next.savedDefault.permissionPosture);
    setAutoApprove(next.savedDefault.autoApprove);
    setTrustMode(next.savedDefault.trustMode);
    setAllowShell(next.savedDefault.allowShell);
    const current = await window.mona.settingsModels(
      projectId,
      next.savedDefault.route.provider,
      next.savedDefault.route.exactId,
    );
    setModels(current.ok ? current.value : null);
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  const saved = snapshot?.savedDefault ?? null;
  const providerRow = snapshot?.providers.providers.find((entry) => entry.id === provider) ?? null;
  const selectedModel = models?.models.find((entry) => entry.id === model) ?? null;
  const reasoningOptions = useMemo(() => {
    const base = [{ value: "", label: "Model default (omit)" }];
    if (!selectedModel || selectedModel.reasoningEffort !== "supported") return base;
    return [
      ...base,
      ...selectedModel.reasoningEffortLevels.map((level) => ({ value: level, label: level })),
    ];
  }, [selectedModel]);
  const draftDirty =
    saved !== null &&
    (saved.route.provider !== provider ||
      saved.route.model !== model ||
      (saved.route.reasoningEffort ?? "") !== effort ||
      saved.permissionPosture !== posture ||
      saved.autoApprove !== autoApprove ||
      saved.trustMode !== trustMode ||
      saved.allowShell !== allowShell);

  const refreshAfter = (next: SettingsSnapshot | null): void => {
    if (!next) return;
    setSnapshot(next);
    setProvider(next.savedDefault.route.provider);
    setModel(next.savedDefault.route.model);
    setEffort(next.savedDefault.route.reasoningEffort ?? "");
    setPosture(next.savedDefault.permissionPosture);
    setAutoApprove(next.savedDefault.autoApprove);
    setTrustMode(next.savedDefault.trustMode);
    setAllowShell(next.savedDefault.allowShell);
  };

  const changeProvider = async (next: string): Promise<void> => {
    setProvider(next);
    setModel("");
    setEffort("");
    const row = snapshot?.providers.providers.find((entry) => entry.id === next);
    const result = await window.mona.settingsModels(projectId, next, row?.exactId ?? null);
    if (!result.ok) {
      setModels(null);
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setModels(result.value);
    const fallback = row?.defaultModel ?? result.value.models[0]?.id ?? "";
    setModel(
      result.value.models.some((entry) => entry.id === fallback)
        ? fallback
        : (result.value.models[0]?.id ?? ""),
    );
  };

  const saveDefault = async (): Promise<void> => {
    if (!snapshot) return;
    setBusy("save");
    setNotice(null);
    const result = await window.mona.saveSavedRoute({
      projectId,
      expectedRevision: snapshot.savedDefault.revision,
      provider,
      exactId: providerRow?.exactId ?? null,
      model,
      reasoningEffort: effort === "" ? null : effort,
      permissionPosture: posture,
      autoApprove,
      trustMode,
      allowShell,
    });
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setReceipt(result.value.receipt);
    refreshAfter(result.value.snapshot);
    setNotice({ tone: "success", text: result.value.receipt.note });
  };

  const resetDefault = async (): Promise<void> => {
    if (!snapshot) return;
    setBusy("reset");
    const result = await window.mona.resetSavedRoute(projectId, snapshot.savedDefault.revision);
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setReceipt(result.value.receipt);
    refreshAfter(result.value.snapshot);
    setNotice({ tone: "success", text: "The measured Flash route is the saved default again." });
  };

  const switchEngine = async (): Promise<void> => {
    if (!snapshot) return;
    setBusy("engine");
    const result = await window.mona.switchEngineRoute({
      projectId,
      provider,
      exactId: providerRow?.exactId ?? null,
      model,
      expectedConfigRevision: snapshot.engineConfigRevision,
      confirm: true,
    });
    setBusy(null);
    setConfirmEngine(false);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setReceipt(result.value.receipt);
    setSnapshot(result.value.snapshot);
    setNotice({
      tone: result.value.receipt.applied ? "success" : "attention",
      text: result.value.receipt.verification,
    });
  };

  const saveKey = async (entry: ProviderView): Promise<void> => {
    const key = keyDrafts[entry.id] ?? "";
    if (key.length === 0) return;
    setBusy(`key:${entry.id}`);
    const result = await window.mona.setProviderCredential({
      projectId,
      provider: entry.id,
      key,
      scope: keyScope,
    });
    setBusy(null);
    // The draft is dropped whether the engine accepted it or not.
    setKeyDrafts((current) => ({ ...current, [entry.id]: "" }));
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setNotice({
      tone: "success",
      text: `${entry.displayName}: ${result.value.note} Credential state: ${result.value.credentialState}.`,
    });
    await load();
  };

  const runDiagnostics = async (): Promise<void> => {
    setBusy("diagnostics");
    const result = await window.mona.settingsDiagnostics(projectId);
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setDiagnostics(result.value);
  };

  const exportDiagnostics = async (): Promise<void> => {
    setBusy("export");
    const result = await window.mona.exportSettingsDiagnostics(projectId);
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setNotice(
      result.value.saved
        ? { tone: "success", text: `Redacted diagnostics saved to ${result.value.path}.` }
        : { tone: "neutral", text: "Export cancelled." },
    );
  };

  if (!snapshot) {
    return (
      <EmptyState
        icon={<RefreshIcon size={20} />}
        title="Reading the configuration"
        description="Mona is reading saved defaults and, when a project studio is live, the engine's provider catalog. No model call is made."
      />
    );
  }

  return (
    <div className="settings-panel" aria-live="polite">
      {snapshot.runtime === "unavailable" ? (
        <Callout
          tone="attention"
          title="Live engine not connected"
          action={
            <Button size="sm" onClick={onOpenStudio}>
              Open studio
            </Button>
          }
        >
          {snapshot.runtimeNote}
        </Callout>
      ) : null}
      {notice ? (
        <Callout
          tone={notice.tone}
          title={notice.tone === "danger" ? "Not applied" : "Configuration"}
        >
          {notice.text}
        </Callout>
      ) : null}

      <Card
        title="Saved new-thread default"
        eyebrow="Applies to new threads only"
        actions={
          <Badge tone={saved?.validation.ok ? "success" : "attention"}>
            {saved?.validation.ok ? "validated live" : "not validated"}
          </Badge>
        }
      >
        <p className="muted">
          This is Mona's saved route for new threads. An active session keeps the route it started
          with; changing this never alters a running turn. Route edits are checked against the
          engine's live catalogs before they are stored.
        </p>
        <div className="form-grid">
          <SelectField
            label="Provider"
            value={provider}
            options={providerOptions(snapshot.providers.providers)}
            onChange={(event) => void changeProvider(event.target.value)}
          />
          <SelectField
            label="Model"
            value={model}
            options={
              models && models.models.length > 0
                ? modelOptions(models.models)
                : [{ value: "", label: "No live model catalog" }]
            }
            disabled={!models || models.models.length === 0}
            onChange={(event) => {
              setModel(event.target.value);
              setEffort("");
            }}
          />
          <SelectField
            label="Reasoning effort"
            value={effort}
            options={reasoningOptions}
            disabled={reasoningOptions.length === 1}
            hint={
              selectedModel?.reasoningEffort === "supported"
                ? `Published levels: ${selectedModel.reasoningEffortLevels.join(", ")}`
                : "This route publishes no effort ladder; Mona sends no reasoning level."
            }
            onChange={(event) => setEffort(event.target.value)}
          />
        </div>
        <SegmentedControl
          label="Work posture"
          value={posture}
          options={[
            { value: "full_access", label: "Work · Full Access" },
            { value: "ask", label: "Plan · Ask" },
          ]}
          onChange={(value) => setPosture(value === "ask" ? "ask" : "full_access")}
        />
        {posture === "full_access" ? (
          <div className="switch-row">
            <Switch checked={autoApprove} onChange={setAutoApprove} label="Auto-approve tools" />
            <Switch checked={trustMode} onChange={setTrustMode} label="Trust mode" />
            <Switch checked={allowShell} onChange={setAllowShell} label="Shell access" />
          </div>
        ) : (
          <p className="muted">
            Plan binds an ask posture with no auto-approval, no trust mode, and no shell. Those
            switches are unavailable while Plan is selected, and the stored Work posture is kept.
          </p>
        )}
        <div className="inline-facts">
          <span>Revision {saved?.revision ?? 0}</span>
          {saved?.updatedAt ? (
            <span>updated {new Date(saved.updatedAt).toLocaleString()}</span>
          ) : null}
          <span className="mono">
            {saved?.route.provider}/{saved?.route.model}
            {saved?.route.reasoningEffort ? ` · ${saved.route.reasoningEffort}` : ""}
          </span>
          {draftDirty ? <Badge tone="attention">unsaved edits</Badge> : null}
        </div>
        {saved && !saved.validation.ok ? (
          <Callout tone="attention" title="Saved default is not valid for this engine">
            {saved.validation.reason}
          </Callout>
        ) : null}
        <div className="button-row">
          <Button variant="primary" onClick={() => void saveDefault()} disabled={busy !== null}>
            {busy === "save" ? "Validating…" : "Save default"}
          </Button>
          <Button onClick={() => void resetDefault()} disabled={busy !== null}>
            Restore Flash default
          </Button>
        </div>
      </Card>

      <Card title="Engine route" eyebrow="Configured by Codewhale config">
        <div className="inline-facts">
          <Badge tone={snapshot.engineDefault.source === "live" ? "success" : "neutral"}>
            {snapshot.engineDefault.source}
          </Badge>
          <span className="mono">
            {snapshot.engineDefault.provider ?? "unknown"}/
            {snapshot.engineDefault.model ?? "unknown"}
          </span>
          <Badge tone={endpointTone(snapshot.engineDefault.endpointStatus)}>
            endpoint {snapshot.engineDefault.endpointStatus}
          </Badge>
          {snapshot.engineDefault.endpointAuthority ? (
            <span className="mono">{snapshot.engineDefault.endpointAuthority}</span>
          ) : null}
          <span>approval {snapshot.engineDefault.approvalMode ?? "unknown"}</span>
          <span>sandbox {snapshot.engineDefault.sandboxMode ?? "unknown"}</span>
        </div>
        {snapshot.engineDefault.error ? (
          <p className="muted">{snapshot.engineDefault.error}</p>
        ) : null}
        <p className="muted">
          Changing this writes the engine's own config document, not just Mona's default. The
          document is backed up with a hash first, a stale read is refused, and the observed route
          is verified after the write.
        </p>
        <div className="switch-row">
          <Switch
            checked={confirmEngine}
            onChange={setConfirmEngine}
            label="I understand this changes the engine default for every client"
          />
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={!confirmEngine || busy !== null || snapshot.runtime !== "connected"}
            onClick={() => void switchEngine()}
          >
            {busy === "engine" ? "Switching…" : "Apply provider and model to engine default"}
          </Button>
        </div>
        {receipt?.target === "engine_default" ? (
          <div className="inline-facts">
            <span>backup {receipt.backupPath ? receipt.backupPath.split("/").pop() : "none"}</span>
            <span className="mono">sha {receipt.backupSha256?.slice(0, 12) ?? "—"}</span>
            <span>
              revision {receipt.revisionBefore?.slice(0, 8) ?? "—"} →{" "}
              {receipt.revisionAfter?.slice(0, 8) ?? "—"}
            </span>
            <span>{receipt.persisted ? "persisted by engine" : "not persisted"}</span>
          </div>
        ) : null}
      </Card>

      <Card title="Observed turn route" eyebrow="Requested versus effective">
        {snapshot.observed ? (
          <>
            <div className="inline-facts">
              <Badge
                tone={
                  snapshot.observed.usedFallback
                    ? "danger"
                    : snapshot.observed.matchesSavedDefault
                      ? "success"
                      : "attention"
                }
              >
                {snapshot.observed.usedFallback
                  ? "engine reported a fallback"
                  : snapshot.observed.matchesSavedDefault
                    ? "matches saved default"
                    : "differs from saved default"}
              </Badge>
              <span>
                requested{" "}
                <span className="mono">
                  {snapshot.observed.requestedProvider}/{snapshot.observed.requestedModel}
                </span>
              </span>
              <span>
                effective{" "}
                <span className="mono">
                  {snapshot.observed.effectiveProvider}/{snapshot.observed.effectiveModel}
                </span>
              </span>
              <span>permission {snapshot.observed.permissionPosture ?? "unknown"}</span>
              {snapshot.observed.turnId ? (
                <span className="mono">turn {snapshot.observed.turnId.slice(0, 12)}</span>
              ) : null}
            </div>
            {snapshot.observed.usedFallback ? (
              <Callout tone="danger" title="The engine reported a route fallback">
                This build disables automatic fallback in Mona, but the engine's receipt says one
                occurred. Treat the configured route as unproven for this turn.
              </Callout>
            ) : null}
          </>
        ) : (
          <p className="muted">
            No completed turn has reported an effective route for this project yet. Mona shows
            nothing rather than inferring one.
          </p>
        )}
      </Card>

      <Card title="Credentials and endpoints" eyebrow="Classes only — never values">
        <p className="muted">
          Credential state is the engine's own classification. Endpoint errors and a missing key are
          different conditions. A key typed here goes straight to the engine's credential store or
          its memory overlay; Mona does not keep it, log it, or put it in project files.
        </p>
        <div className="form-grid">
          <SelectField
            label="New key scope"
            value={keyScope}
            options={[
              { value: "session", label: "This run only (engine memory)" },
              { value: "durable", label: "Durable (engine credential store)" },
            ]}
            onChange={(event) =>
              setKeyScope(event.target.value === "durable" ? "durable" : "session")
            }
          />
        </div>
        <div className="route-provider-list">
          {snapshot.providers.providers.map((entry) => (
            <div className="route-provider" key={entry.id}>
              <div className="route-provider__head">
                <span className="mono">{entry.id}</span>
                <Badge tone={credentialTone(entry.credentialState)}>{entry.credentialState}</Badge>
                <span className="muted">
                  source {entry.credentialSource} ·{" "}
                  {entry.credentialWritable ? "writable" : "read-only"}
                </span>
                {entry.current ? <Badge tone="accent">current</Badge> : null}
              </div>
              {entry.credentialWritableReason ? (
                <p className="muted">{entry.credentialWritableReason}</p>
              ) : null}
              <div className="button-row">
                <TextField
                  label={`New key for ${entry.displayName}`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyDrafts[entry.id] ?? ""}
                  onChange={(event) =>
                    setKeyDrafts((current) => ({ ...current, [entry.id]: event.target.value }))
                  }
                  disabled={!entry.credentialWritable || snapshot.runtime !== "connected"}
                />
                <Button
                  size="sm"
                  disabled={
                    !entry.credentialWritable ||
                    snapshot.runtime !== "connected" ||
                    busy !== null ||
                    (keyDrafts[entry.id] ?? "").length === 0
                  }
                  onClick={() => void saveKey(entry)}
                >
                  {busy === `key:${entry.id}` ? "Saving…" : "Store key"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!entry.credentialWritable || snapshot.runtime !== "connected"}
                  onClick={async () => {
                    const result = await window.mona.clearProviderCredential(
                      projectId,
                      entry.id,
                      keyScope,
                    );
                    setNotice(
                      result.ok
                        ? { tone: "neutral", text: result.value.note }
                        : {
                            tone: "danger",
                            text: `${result.error.code}: ${result.error.message}`,
                          },
                    );
                    await load();
                  }}
                >
                  Clear {keyScope} key
                </Button>
              </div>
            </div>
          ))}
          {snapshot.providers.providers.length === 0 ? (
            <p className="muted">
              No provider catalog is available.{" "}
              {snapshot.providers.error ?? "Open a live studio to read it."}
            </p>
          ) : null}
        </div>
      </Card>

      <Card
        title="Routing policy"
        eyebrow="Locked by design"
        actions={<Badge tone="success">fallback off</Badge>}
      >
        <div className="inline-facts">
          <span>automatic routing: off</span>
          <span>fallback: refuse</span>
          <span>provider/model change: explicit only</span>
        </div>
        <p className="muted">{snapshot.policy.note}</p>
      </Card>

      <Card
        title="Connection diagnostics"
        eyebrow="Read-only and redacted"
        actions={
          <Button size="sm" onClick={() => void runDiagnostics()} disabled={busy !== null}>
            {busy === "diagnostics" ? "Running…" : "Run diagnostics"}
          </Button>
        }
      >
        <p className="muted">
          Runs the engine's own doctor in structural mode. It does not start MCP servers, probe the
          provider, or contact an update service.
        </p>
        {diagnostics ? (
          <>
            <div className="inline-facts">
              <Badge tone={diagnostics.ok ? "success" : "attention"}>
                {diagnostics.ok ? "clean" : "needs attention"}
              </Badge>
              <span>{diagnostics.summary}</span>
              <span>{diagnostics.redactions} redactions</span>
            </div>
            {diagnostics.warnings.length > 0 ? (
              <ul className="route-warnings">
                {diagnostics.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            ) : null}
            <details className="route-report">
              <summary>Redacted report</summary>
              <pre className="mono">{diagnostics.redacted}</pre>
            </details>
            <div className="button-row">
              <Button size="sm" onClick={() => void exportDiagnostics()} disabled={busy !== null}>
                {busy === "export" ? "Exporting…" : "Export redacted JSON"}
              </Button>
            </div>
          </>
        ) : (
          <p className="muted">No diagnostics have been run in this session.</p>
        )}
      </Card>

      <Card title="Engine selection" eyebrow="Bundled versus adopted">
        <div className="inline-facts">
          <Badge
            tone={
              snapshot.engineSelection.source === "bundled"
                ? "success"
                : snapshot.engineSelection.source === "external_env"
                  ? "attention"
                  : "danger"
            }
          >
            {snapshot.engineSelection.source}
          </Badge>
          <span className="mono">{snapshot.engineSelection.path ?? "not resolved"}</span>
          {snapshot.engineSelection.version ? (
            <span>
              v{snapshot.engineSelection.version} · {snapshot.engineSelection.commit?.slice(0, 9)}
            </span>
          ) : null}
          {snapshot.engineSelection.sha256 ? (
            <span className="mono">sha {snapshot.engineSelection.sha256.slice(0, 16)}</span>
          ) : null}
        </div>
        <p className="muted">{snapshot.engineSelection.note}</p>
      </Card>

      {snapshot.runtime === "connected" ? (
        <div className="inline-facts">
          <ShieldIcon size={14} />
          <span>no renderer-settable policy field exists outside these explicit actions</span>
          <WarningIcon size={14} />
          <span>an active turn is never rewritten by this screen</span>
        </div>
      ) : (
        <div className="inline-facts">
          <TerminalIcon size={14} />
          <span>{snapshot.configPath ?? "engine config path unavailable"}</span>
        </div>
      )}
    </div>
  );
}
