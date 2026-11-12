import { useState, type JSX } from "react";
import { fixtureRoute, fixtureSettings } from "../fixtures";
import {
  Badge,
  Button,
  Callout,
  Card,
  ScreenHeader,
  SelectField,
  Switch,
  TabPanel,
  Tabs,
  TextField,
} from "../primitives";
import {
  ArchiveIcon,
  BranchIcon,
  FolderIcon,
  LockIcon,
  RefreshIcon,
  ShieldIcon,
  TerminalIcon,
  WarningIcon,
} from "../icons";
import type { Scenario } from "./types";

export function SettingsScreen({ scenario }: { scenario: Scenario }): JSX.Element {
  const [tab, setTab] = useState("route");
  const [telemetry, setTelemetry] = useState(false);
  const [confirmRisky, setConfirmRisky] = useState(false);
  const disconnected = scenario === "disconnected";
  const missingCredentials = scenario === "disconnected" || scenario === "empty";

  return (
    <div className="screen screen--settings">
      <ScreenHeader
        eyebrow="Settings and doctor"
        title="Configuration with the real effects visible"
        lede="Routes, runtime, privacy, and recovery. Diagnostics give concrete next actions without exposing secrets."
      />

      <Tabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "route", label: "Route", icon: <BranchIcon size={15} /> },
          { id: "runtime", label: "Runtime", icon: <TerminalIcon size={15} /> },
          { id: "privacy", label: "Privacy", icon: <ShieldIcon size={15} /> },
          { id: "recovery", label: "Recovery", icon: <ArchiveIcon size={15} /> },
        ]}
      />

      <div className="settings-panel">
        <TabPanel id="route" active={tab === "route"}>
          {missingCredentials ? (
            <Callout
              tone="attention"
              title="Credentials are missing for this route"
              action={
                <Button size="sm" variant="secondary">
                  Open engine credential flow
                </Button>
              }
            >
              Browsing and local history still work. Mona does not ask for a key to open a project,
              and importing a prompt does not execute it.
            </Callout>
          ) : null}
          <Card title="Effective route" eyebrow="Engine remains authoritative">
            <div className="form-grid">
              <TextField label="Provider" defaultValue={fixtureRoute.provider} readOnly mono />
              <TextField label="Model" defaultValue={fixtureRoute.model} readOnly mono />
              <SelectField
                label="Reasoning effort"
                hint="Only values the route supports are offered."
                defaultValue={fixtureRoute.reasoning}
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
              />
              <TextField
                label="Endpoint"
                defaultValue={fixtureRoute.endpoint}
                readOnly
                mono
                hint="Preserved from the engine configuration; Mona does not rewrite it."
              />
            </div>
            <div className="inline-facts">
              <Badge tone="attention" icon={<LockIcon size={13} />}>
                {fixtureRoute.permission}
              </Badge>
              <span>Profile: {fixtureRoute.profile}</span>
              <span>Key source: {fixtureRoute.keySource}</span>
              <Badge tone="success">Flash route preserved</Badge>
            </div>
            <p className="hint-line">
              A route change affects only the scope you choose: new threads, the current thread when
              allowed, or the project default. No automatic fallback is inserted.
            </p>
          </Card>
        </TabPanel>

        <TabPanel id="runtime" active={tab === "runtime"}>
          <Card title="Owned runtime" eyebrow="Identity verified before use">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>State</dt>
                <dd>
                  <Badge tone={disconnected ? "attention" : "success"}>
                    {disconnected ? "Disconnected" : "Running"}
                  </Badge>
                </dd>
              </div>
              <div className="detail-row">
                <dt>Executable</dt>
                <dd className="mono wrap">{fixtureSettings.runtimePath}</dd>
              </div>
              <div className="detail-row">
                <dt>Engine</dt>
                <dd>
                  {fixtureSettings.engineVersion}{" "}
                  <span className="mono">({fixtureSettings.engineCommit})</span>
                </dd>
              </div>
              <div className="detail-row">
                <dt>Ownership</dt>
                <dd>
                  {disconnected
                    ? "No owned process. External runtimes are read-only and never stopped by Mona."
                    : "Owned by this Mona instance; stop receipts are required before restart."}
                </dd>
              </div>
              <div className="detail-row">
                <dt>Workspace</dt>
                <dd className="mono wrap">/Users/example/Projects/Mona</dd>
              </div>
            </dl>
            <div className="button-row">
              <Button variant="secondary" icon={<RefreshIcon size={15} />}>
                Re-check runtime
              </Button>
              <Button variant="ghost" icon={<FolderIcon size={15} />}>
                Reveal executable
              </Button>
            </div>
          </Card>
          <Card title="Diagnostics" eyebrow="Plain language">
            <ul className="rule-list">
              <li>
                <WarningIcon size={15} /> A missing executable, incompatible version, or occupied
                port is shown with a safe next action; Mona never kills a stranger on the port.
              </li>
              <li>
                <ShieldIcon size={15} /> Runtime tokens stay in the owning process. They are never
                written to the database, renderer state, logs, or exported diagnostics.
              </li>
            </ul>
          </Card>
        </TabPanel>

        <TabPanel id="privacy" active={tab === "privacy"}>
          <Card title="Local data" eyebrow="Per-user Application Support">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>Support</dt>
                <dd className="mono wrap">{fixtureSettings.supportPath}</dd>
              </div>
              <div className="detail-row">
                <dt>Database</dt>
                <dd className="mono wrap">{fixtureSettings.databasePath}</dd>
              </div>
              <div className="detail-row">
                <dt>Permissions</dt>
                <dd>Directories 0700 · database 0600 · one writer with a maintenance barrier</dd>
              </div>
              <div className="detail-row">
                <dt>Cloud sync</dt>
                <dd>
                  Refused. The database is never placed in iCloud Drive, Dropbox, or a network
                  mount.
                </dd>
              </div>
            </dl>
            <div className="switch-row">
              <Switch
                label="Mona telemetry (off by default)"
                checked={telemetry}
                onChange={setTelemetry}
              />
              <span className="hint-line">
                Upstream engine telemetry is shown separately and never rewritten.
              </span>
            </div>
          </Card>
          <Card title="Permissions and boundaries" eyebrow="Full Access is not root">
            <ul className="rule-list">
              <li>Renderer is sandboxed with context isolation and a narrow typed IPC bridge.</li>
              <li>No arbitrary shell, filesystem, or URL fetch is exposed to UI content.</li>
              <li>
                Markdown output escapes raw HTML; external links open in the system browser after
                validation.
              </li>
              <li>
                Local full-access agents can still change user files; project labels are not OS
                isolation.
              </li>
            </ul>
          </Card>
        </TabPanel>

        <TabPanel id="recovery" active={tab === "recovery"}>
          <Card title="Backup and migration" eyebrow="Verified snapshots only">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>Schema</dt>
                <dd>v2 · migrations recorded with checksums</dd>
              </div>
              <div className="detail-row">
                <dt>Last snapshot</dt>
                <dd>Today, 11:42 · integrity ok · 0600</dd>
              </div>
              <div className="detail-row">
                <dt>Journal</dt>
                <dd>Last migration completed; failed journals are preserved for diagnosis.</dd>
              </div>
            </dl>
            <div className="button-row">
              <Button variant="secondary" icon={<ArchiveIcon size={15} />}>
                Create snapshot
              </Button>
              <Button
                variant="ghost"
                icon={<RefreshIcon size={15} />}
                onClick={() => setConfirmRisky((value) => !value)}
              >
                Restore snapshot…
              </Button>
            </div>
            {confirmRisky ? (
              <Callout tone="danger" title="Restore is a deliberate, exclusive operation">
                All writers are quiesced under the maintenance barrier. The current database is
                moved aside as evidence; if validation fails, it is put back. Review scope and
                conflicts before confirming.
                <div className="button-row">
                  <Button size="sm" variant="danger">
                    I understand — review scope
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRisky(false)}>
                    Cancel
                  </Button>
                </div>
              </Callout>
            ) : null}
          </Card>
          <Card title="Search and index" eyebrow="Local only">
            <p>
              Project memory, decisions, and blockers are indexed locally. No upload, no summarizer,
              and no model call is required to search them.
            </p>
            <p className="hint-line">
              Rebuilding the index respects the same maintenance barrier as writes.
            </p>
          </Card>
        </TabPanel>
      </div>
    </div>
  );
}
