import { useCallback, useEffect, useState, type JSX } from "react";
import type { ServiceStatus } from "../../shared/contracts/open";
import { Badge, Button, Callout, Card } from "../design/primitives";
import { RefreshIcon } from "../design/icons";

/**
 * Finder integration, reported from measurement rather than assumption:
 * whether the Service bundle is installed, whether macOS lists it, whether the
 * system records it as disabled, and what the last handoff actually was.
 *
 * Nothing here enables a service silently. When it is not ready, the panel
 * gives the exact steps and the two safe actions (refresh the registration,
 * open the Services settings pane).
 */
export function FinderIntegration(): JSX.Element {
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.mona.serviceStatus());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const refreshRegistration = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await window.mona.refreshService());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async (): Promise<void> => {
    const result = await window.mona.openServiceSettings();
    if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
  };

  const registrationTone =
    status?.registration === "registered"
      ? "success"
      : status?.registration === "missing"
        ? "danger"
        : "attention";
  const enabledTone =
    status?.enabled === "enabled"
      ? "success"
      : status?.enabled === "disabled"
        ? "danger"
        : "attention";

  return (
    <>
      <Card title="Finder integration" eyebrow="macOS Services">
        <dl className="detail-list">
          <div className="detail-row">
            <dt>Service</dt>
            <dd>{status?.menuTitle ?? "Start new DS project with Mona"}</dd>
          </div>
          <div className="detail-row">
            <dt>Installed</dt>
            <dd className="mono wrap">
              {status?.installPathDisplay ?? status?.installPath ?? "Not installed"} ·{" "}
              {status?.scope ?? "unknown scope"}
            </dd>
          </div>
          <div className="detail-row">
            <dt>Registration</dt>
            <dd>
              <Badge tone={registrationTone}>{status?.registration ?? "unknown"}</Badge>
            </dd>
          </div>
          <div className="detail-row">
            <dt>Enabled</dt>
            <dd>
              <Badge tone={enabledTone}>{status?.enabled ?? "unknown"}</Badge>
            </dd>
          </div>
          <div className="detail-row">
            <dt>App identity</dt>
            <dd className="mono wrap">
              {status?.appIdentity ?? "com.mona.workbench"} ·{" "}
              {status?.packaged ? "packaged app" : "development build"}
            </dd>
          </div>
          <div className="detail-row">
            <dt>Last handoff</dt>
            <dd>
              {status?.lastHandoff
                ? `${status.lastHandoff.at ?? "unknown time"} · ${
                    status.lastHandoff.forwarded
                      ? "forwarded"
                      : (status.lastHandoff.code ?? "refused")
                  } · ${status.lastHandoff.resolvedPath ?? "no path"}`
                : "No handoff recorded"}
            </dd>
          </div>
        </dl>

        {error ? (
          <Callout tone="danger" title="The integration status could not be read">
            {error}
          </Callout>
        ) : null}

        {status && status.recovery.length > 0 ? (
          <Callout tone="attention" title="Finder handoff is not ready yet">
            <ol className="rule-list">
              {status.recovery.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </Callout>
        ) : null}

        <div className="inline-facts">
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshIcon size={14} />}
            disabled={busy}
            onClick={() => void check()}
          >
            Check again
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !status?.installPath}
            onClick={() => void refreshRegistration()}
          >
            Refresh registration
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void openSettings()}>
            Open Services settings
          </Button>
        </div>

        {status && status.detail.length > 0 ? (
          <ul className="evidence-list">
            {status.detail.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Other ways to open a project" eyebrow="Same validated path">
        <ul className="rule-list">
          <li>
            <strong>File → Open Project…</strong> (⌘O) opens the native folder dialog.
          </li>
          <li>
            <strong>Drop one folder</strong> on the Mona window or on the Dock icon. A folder is
            registered and selected; multi-selection is refused with a reason.
          </li>
          <li>
            <strong>Services → Start new DS project with Mona</strong> in Finder hands the selected
            folder to the running Mona, or starts it once.
          </li>
        </ul>
        <p className="hint-line">
          Opening a folder never starts the engine, never submits a prompt, and never resumes an
          interrupted turn. Those remain explicit actions in Studio.
        </p>
      </Card>
    </>
  );
}
