import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type {
  CapabilityRowView,
  CapabilitySnapshot,
  CapabilityStatus,
} from "../../shared/contracts/capability";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  EmptyState,
  ScreenHeader,
} from "../design/primitives";
import { RefreshIcon, SearchIcon, TerminalIcon, WarningIcon } from "../design/icons";
import { relativeTime } from "./visual";

const STATUS_TONE: Record<CapabilityStatus, "success" | "attention" | "danger" | "neutral"> = {
  verified: "success",
  unqualified: "attention",
  blocked_gap: "danger",
  unavailable: "neutral",
};

const INTEGRATION_LABEL: Record<string, string> = {
  native_view: "Native view",
  advanced_action: "Advanced action",
  integrated_terminal: "Integrated terminal",
  unavailable: "Unavailable",
  blocked_gap: "Blocked gap",
};

export interface CapabilityEntryRequest {
  kind: "screen" | "settings_tab" | "terminal" | "palette";
  target: string | null;
  label: string;
  invocation: string;
  rowId: string;
}

export function CapabilitiesScreen({
  onOpenEntry,
  onTerminal,
}: {
  onOpenEntry: (request: CapabilityEntryRequest) => void;
  onTerminal: (command: string) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<CapabilityStatus | "all">("all");
  const [integration, setIntegration] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<{ json: string; markdown: string } | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    const result = refresh
      ? await window.mona.refreshCapabilities()
      : await window.mona.capabilitySnapshot();
    setLoading(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setError(null);
    setSnapshot(result.value);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const rows = snapshot?.rows ?? [];
  const selected = rows.find((row) => row.id === selectedId) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (status !== "all" && row.status !== status) return false;
      if (integration !== "all" && row.integration !== integration) return false;
      if (needle.length === 0) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.description.toLowerCase().includes(needle) ||
        row.invocation.toLowerCase().includes(needle) ||
        row.id.toLowerCase().includes(needle)
      );
    });
  }, [rows, query, status, integration]);

  const coverage = snapshot?.coverage ?? null;

  const requestReport = useCallback(async () => {
    setReportBusy(true);
    const result = await window.mona.capabilityReport();
    setReportBusy(false);
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setReport({ json: result.value.json, markdown: result.value.markdown });
  }, []);

  const open = useCallback(
    (row: CapabilityRowView) => {
      if (row.entryPoint.kind === "none") return;
      if (row.entryPoint.kind === "terminal") {
        onTerminal(row.invocation);
        return;
      }
      onOpenEntry({
        kind: row.entryPoint.kind === "palette" ? "palette" : row.entryPoint.kind,
        target: row.entryPoint.target,
        label: row.entryPoint.label,
        invocation: row.invocation,
        rowId: row.id,
      });
    },
    [onOpenEntry, onTerminal],
  );

  return (
    <div className="screen screen--capabilities">
      <ScreenHeader
        eyebrow="Capability explorer"
        title="Every discovered engine capability, with its real route"
        lede="This table is computed from the pinned surface and this build's entry points. A row without a faithful route says so and names the verified advanced or terminal route instead of showing a control that cannot work."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshIcon size={14} />}
              onClick={() => void load(true)}
            >
              Re-probe
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void requestReport()}
              disabled={reportBusy}
            >
              {reportBusy ? "Building…" : "Coverage report"}
            </Button>
          </>
        }
      />

      {error ? (
        <Callout
          tone="danger"
          title="Capabilities could not be read"
          action={
            <Button size="sm" variant="ghost" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }
        >
          {error}
        </Callout>
      ) : null}

      {snapshot && snapshot.source === "stored" ? (
        <Callout tone="attention" title="Showing the last computed coverage">
          {snapshot.unavailableReason}
        </Callout>
      ) : null}

      {coverage ? (
        <div className="capability-summary" data-testid="capability-summary">
          <div className="capability-stat">
            <span className="capability-stat__value">{coverage.rowsTotal}</span>
            <span className="capability-stat__label">rows discovered</span>
          </div>
          <div className="capability-stat">
            <span className="capability-stat__value">{coverage.verified}</span>
            <span className="capability-stat__label">verified</span>
          </div>
          <div className="capability-stat">
            <span className="capability-stat__value">{coverage.unqualified}</span>
            <span className="capability-stat__label">open (route named)</span>
          </div>
          <div className="capability-stat">
            <span className="capability-stat__value">{coverage.blockedGaps}</span>
            <span className="capability-stat__label">blocked gaps</span>
          </div>
          <div className="capability-stat">
            <span className="capability-stat__value">{coverage.unavailable}</span>
            <span className="capability-stat__label">unavailable</span>
          </div>
          <div className="capability-stat">
            <span className="capability-stat__value">{coverage.testedEntryPoint}</span>
            <span className="capability-stat__label">entry points exercised</span>
          </div>
          <p className="capability-summary__verdict" data-testid="capability-verdict">
            {coverage.complete
              ? "Every row is verified."
              : "Full parity is not claimed: required gaps remain."}
          </p>
        </div>
      ) : null}

      {snapshot ? (
        <div className="capability-cards">
          <Card title="Version drift" eyebrow="Read-only help probe">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>Installed</dt>
                <dd>
                  {snapshot.drift.checked
                    ? `${snapshot.drift.engineVersion ?? "unknown"} (${snapshot.drift.engineCommit ?? "unknown"})`
                    : "not checked"}
                </dd>
              </div>
              <div className="detail-row">
                <dt>Recorded</dt>
                <dd>
                  {snapshot.drift.inventoryVersion} ({snapshot.drift.inventoryCommit.slice(0, 12)})
                </dd>
              </div>
              <div className="detail-row">
                <dt>Version match</dt>
                <dd>
                  <Badge
                    tone={
                      snapshot.drift.versionMatch && snapshot.drift.commitMatch
                        ? "success"
                        : "attention"
                    }
                  >
                    {snapshot.drift.checked
                      ? snapshot.drift.versionMatch && snapshot.drift.commitMatch
                        ? "matches the inventory"
                        : "differs — re-qualification required"
                      : "unchecked"}
                  </Badge>
                </dd>
              </div>
              <div className="detail-row">
                <dt>Additions</dt>
                <dd>{snapshot.drift.additions.length}</dd>
              </div>
              <div className="detail-row">
                <dt>Removals</dt>
                <dd>{snapshot.drift.removals.length}</dd>
              </div>
            </dl>
            <p className="muted">{snapshot.drift.note}</p>
            {snapshot.drift.additions.length + snapshot.drift.removals.length > 0 ? (
              <ul className="capability-drift">
                {snapshot.drift.additions.map((entry) => (
                  <li key={`add-${entry.name}`}>
                    <WarningIcon size={13} /> added: <strong>{entry.name}</strong> — {entry.note}
                  </li>
                ))}
                {snapshot.drift.removals.map((entry) => (
                  <li key={`remove-${entry.name}`}>
                    <WarningIcon size={13} /> missing: <strong>{entry.name}</strong> — {entry.note}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
          <Card title="Engine feature flags" eyebrow="codewhale features list">
            {snapshot.features.length === 0 ? (
              <p className="muted">Feature flags were not read in this snapshot.</p>
            ) : (
              <ul className="feature-flags" data-testid="feature-flags">
                {snapshot.features.map((feature) => (
                  <li key={feature.name}>
                    <Badge tone={feature.enabled ? "success" : "neutral"}>
                      {feature.enabled ? "on" : "off"}
                    </Badge>
                    <span className="mono">{feature.name}</span>
                    <span className="muted">{feature.stage}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="How to read a row" eyebrow="Status vocabulary">
            <ul className="capability-legend">
              <li>
                <Badge tone="success">verified</Badge> the named entry point and route were
                exercised.
              </li>
              <li>
                <Badge tone="attention">open</Badge> route named, operation not exercised (write,
                destructive, or costly). No success is claimed.
              </li>
              <li>
                <Badge tone="danger">blocked</Badge> supported upstream, no faithful route in this
                build.
              </li>
              <li>
                <Badge tone="neutral">unavailable</Badge> not available on this platform or build.
              </li>
            </ul>
            <p className="muted">
              A terminal entry opens the shell with the exact command prefilled; Mona never runs it
              for you.
            </p>
          </Card>
        </div>
      ) : null}

      <div className="capability-filters">
        <label className="field__label" htmlFor="capability-search">
          Search rows
        </label>
        <input
          id="capability-search"
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, description, or route"
        />
        <select
          className="input"
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as CapabilityStatus | "all")}
        >
          <option value="all">All statuses</option>
          <option value="verified">Verified</option>
          <option value="unqualified">Open</option>
          <option value="blocked_gap">Blocked gap</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <select
          className="input"
          aria-label="Filter by integration"
          value={integration}
          onChange={(event) => setIntegration(event.target.value)}
        >
          <option value="all">All integrations</option>
          <option value="native_view">Native view</option>
          <option value="advanced_action">Advanced action</option>
          <option value="integrated_terminal">Integrated terminal</option>
          <option value="blocked_gap">Blocked gap</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <span className="muted" data-testid="capability-count">
          {loading ? "Reading…" : `${filtered.length} of ${rows.length} rows`}
        </span>
      </div>

      <div className="capability-layout">
        <ul className="capability-list" data-testid="capability-list">
          {filtered.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`capability-row ${row.id === selectedId ? "capability-row--selected" : ""}`}
                onClick={() => setSelectedId(row.id)}
              >
                <span className="capability-row__name">{row.name}</span>
                <Badge tone={STATUS_TONE[row.status]}>
                  {row.status === "unqualified" ? "open" : row.status}
                </Badge>
                <span className="capability-row__integration">
                  {INTEGRATION_LABEL[row.integration] ?? row.integration}
                </span>
                <span className="capability-row__entry">{row.entryPoint.label}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li>
              <EmptyState
                title="No rows match"
                description="Clear the filters. The inventory is never trimmed to look complete."
              />
            </li>
          ) : null}
        </ul>

        <div className="capability-detail" data-testid="capability-detail">
          {selected ? (
            <>
              <header className="capability-detail__header">
                <div>
                  <p className="eyebrow">
                    {selected.id} · {selected.scope}
                  </p>
                  <h2 className="capability-detail__title">{selected.name}</h2>
                  <p className="muted">{selected.description}</p>
                </div>
                <Badge tone={STATUS_TONE[selected.status]}>
                  {selected.status === "unqualified" ? "open" : selected.status}
                </Badge>
              </header>
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Entry point</dt>
                  <dd>
                    {selected.entryPoint.label}
                    {selected.entryPoint.tested ? " · exercised" : " · not exercised"}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Exact route</dt>
                  <dd className="mono wrap">{selected.invocation}</dd>
                </div>
                <div className="detail-row">
                  <dt>Classification</dt>
                  <dd>
                    <Badge
                      tone={
                        selected.classification === "destructive"
                          ? "danger"
                          : selected.classification === "write"
                            ? "attention"
                            : "neutral"
                      }
                    >
                      {selected.classification}
                    </Badge>{" "}
                    {selected.permission}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Cost class</dt>
                  <dd>{selected.cost}</dd>
                </div>
                <div className="detail-row">
                  <dt>Arguments</dt>
                  <dd className="mono wrap">{selected.arguments}</dd>
                </div>
                <div className="detail-row">
                  <dt>Help source</dt>
                  <dd className="mono wrap">{selected.helpSource}</dd>
                </div>
                <div className="detail-row">
                  <dt>Version / platform</dt>
                  <dd>
                    {selected.upstreamVersion} · {selected.platform}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Test</dt>
                  <dd>{selected.tests}</dd>
                </div>
                {selected.gap ? (
                  <div className="detail-row">
                    <dt>Gap</dt>
                    <dd>{selected.gap}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="capability-detail__actions">
                {selected.entryPoint.kind === "none" ? (
                  <Badge tone="neutral">No in-app route for this row</Badge>
                ) : selected.entryPoint.kind === "terminal" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<TerminalIcon size={14} />}
                    onClick={() => open(selected)}
                  >
                    Open terminal with the command
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => open(selected)}>
                    Open {selected.entryPoint.label}
                  </Button>
                )}
              </div>
              <p className="muted">
                Showing what this build can actually reach. A row is never hidden to make the
                coverage look complete.
              </p>
            </>
          ) : (
            <EmptyState
              title="Pick a row"
              description="Each row carries its entry point, exact route, cost class, help source, and test."
            />
          )}
        </div>
      </div>

      <Dialog
        open={report !== null}
        title="Capability coverage report"
        description="Computed from the rows on this screen. The markdown is part of the P18 evidence."
        onClose={() => setReport(null)}
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              if (report)
                void navigator.clipboard?.writeText(report.markdown).catch(() => undefined);
            }}
          >
            Copy markdown
          </Button>
        }
      >
        <pre className="capability-report" data-testid="capability-report">
          {report?.markdown ?? ""}
        </pre>
      </Dialog>

      <p className="muted capability-footer">
        {snapshot
          ? `${snapshot.rows.length} rows · inventory ${snapshot.inventoryPath ?? "unknown"} · loaded ${relativeTime(snapshot.loadedAt)}`
          : "Loading the inventory."}{" "}
        <SearchIcon size={12} /> Reads are local; the only engine call is a read-only help probe.
      </p>
    </div>
  );
}
