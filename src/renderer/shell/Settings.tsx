import { useState, type JSX } from "react";
import type { AppInfo, AppPathInfo, ToolDiscovery } from "../../shared/contracts/bridge";
import type {
  ProjectDetail,
  RuntimeStatusView,
  StateFacts,
} from "../../shared/contracts/project-bridge";
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  ScreenHeader,
  SegmentedControl,
  TabPanel,
  Tabs,
} from "../design/primitives";
import {
  ArchiveIcon,
  BranchIcon,
  FolderIcon,
  LockIcon,
  RefreshIcon,
  ShieldIcon,
  TerminalIcon,
} from "../design/icons";
import type { Density, ThemeName } from "../design/tokens";

export function SettingsScreen({
  app,
  paths,
  facts,
  runtime,
  detail,
  tools,
  theme,
  density,
  onTheme,
  onDensity,
}: {
  app: AppInfo | null;
  paths: AppPathInfo | null;
  facts: StateFacts | null;
  runtime: RuntimeStatusView | null;
  detail: ProjectDetail | null;
  tools: ToolDiscovery[];
  theme: ThemeName;
  density: Density;
  onTheme: (theme: ThemeName) => void;
  onDensity: (density: Density) => void;
}): JSX.Element {
  const [tab, setTab] = useState("appearance");
  const problems = facts?.permissionProblems ?? [];

  return (
    <div className="screen screen--settings">
      <ScreenHeader
        eyebrow="Settings and doctor"
        title="Configuration with the real effects visible"
        lede="Local storage, runtime status, privacy, and recovery. Diagnostics give concrete facts without exposing secrets."
      />

      <Tabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "appearance", label: "Appearance", icon: <BranchIcon size={15} /> },
          { id: "data", label: "Data", icon: <FolderIcon size={15} /> },
          { id: "runtime", label: "Runtime", icon: <TerminalIcon size={15} /> },
          { id: "privacy", label: "Privacy", icon: <ShieldIcon size={15} /> },
          { id: "recovery", label: "Recovery", icon: <ArchiveIcon size={15} /> },
        ]}
      />

      <div className="settings-panel">
        <TabPanel id="appearance" active={tab === "appearance"}>
          <Card title="Theme and density" eyebrow="Local preference">
            <div className="inline-facts">
              <span className="harness-controls__label">Theme</span>
              <SegmentedControl
                label="Theme"
                value={theme}
                onChange={(value) => onTheme(value as ThemeName)}
                options={[
                  { value: "daybreak", label: "Daybreak" },
                  { value: "afterglow", label: "Afterglow" },
                ]}
              />
              <span className="harness-controls__label">Density</span>
              <SegmentedControl
                label="Density"
                value={density}
                onChange={(value) => onDensity(value as Density)}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "dense", label: "Dense" },
                ]}
              />
            </div>
            <p className="hint-line">
              Both themes meet the measured contrast pairs in `docs/design-system.md`; reduced
              motion follows the macOS accessibility setting.
            </p>
          </Card>
          <Card title="Keyboard" eyebrow="Every screen reachable without a mouse">
            <ul className="rule-list">
              <li>
                Command-1 through Command-5 switch Home, Studio, Work board, Cost lens, and
                Settings.
              </li>
              <li>Command-K opens the command palette; Escape closes it and returns focus.</li>
              <li>
                Command-O opens the project folder dialog. Command-W closes the window without
                quitting.
              </li>
              <li>
                Tab and Shift-Tab traverse the rail, catalog, actions, and dialogs in DOM order.
              </li>
            </ul>
          </Card>
        </TabPanel>

        <TabPanel id="data" active={tab === "data"}>
          <Card title="Local data" eyebrow="Per-user Application Support">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>Database</dt>
                <dd className="mono wrap">{facts?.database || paths?.database || "Unavailable"}</dd>
              </div>
              <div className="detail-row">
                <dt>Support</dt>
                <dd className="mono wrap">{paths?.support ?? "Unavailable"}</dd>
              </div>
              <div className="detail-row">
                <dt>Backups</dt>
                <dd className="mono wrap">{paths?.backups ?? "Unavailable"}</dd>
              </div>
              <div className="detail-row">
                <dt>Projects</dt>
                <dd>
                  {facts?.projects ?? 0} catalog entries · {facts?.tasks ?? 0} tasks ·{" "}
                  {facts?.events ?? 0} events
                </dd>
              </div>
              <div className="detail-row">
                <dt>Integrity</dt>
                <dd>
                  {facts && facts.integrity.length === 0 ? (
                    <Badge tone="success">Integrity check clean</Badge>
                  ) : (
                    <Badge tone="danger">Integrity problems reported</Badge>
                  )}
                </dd>
              </div>
              <div className="detail-row">
                <dt>Modes</dt>
                <dd>
                  Directories 0700 · database 0600 · cloud-synced and network locations refused
                </dd>
              </div>
            </dl>
            {problems.length > 0 ? (
              <Callout tone="danger" title="Private permissions need attention">
                <ul>
                  {problems.map((problem) => (
                    <li key={problem.path} className="mono wrap">
                      {problem.path} is mode {problem.mode} (expected {problem.expected})
                    </li>
                  ))}
                </ul>
              </Callout>
            ) : (
              <p className="hint-line">
                Runtime tokens are never stored in this database; the bindings table has no token
                column.
              </p>
            )}
          </Card>
        </TabPanel>

        <TabPanel id="runtime" active={tab === "runtime"}>
          <Card title="Runtime status" eyebrow="Supervisor-reported">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>State</dt>
                <dd>
                  <Badge tone={runtime?.state === "running" ? "success" : "attention"}>
                    {runtime?.state ?? "Unavailable"}
                  </Badge>
                </dd>
              </div>
              <div className="detail-row">
                <dt>Reason</dt>
                <dd>{runtime?.reason ?? "No supervisor status"}</dd>
              </div>
              <div className="detail-row">
                <dt>Workspace</dt>
                <dd className="mono wrap">{runtime?.workspace ?? "None"}</dd>
              </div>
              <div className="detail-row">
                <dt>Engine</dt>
                <dd>
                  {runtime?.engine
                    ? `${runtime.engine.version} (${runtime.engine.commit})`
                    : "No running engine reported"}
                </dd>
              </div>
              <div className="detail-row">
                <dt>Restarts</dt>
                <dd>{runtime?.restarts ?? 0} bounded process restarts</dd>
              </div>
              <div className="detail-row">
                <dt>Selected project</dt>
                <dd>{detail?.project.name ?? "None"}</dd>
              </div>
              <div className="detail-row">
                <dt>Binding</dt>
                <dd className="mono wrap">
                  {detail?.engine.binding
                    ? `${detail.engine.binding.executable} · ${detail.engine.binding.state}`
                    : "No runtime binding"}
                </dd>
              </div>
            </dl>
            {runtime?.lastFailure ? (
              <Callout tone="danger" title={runtime.lastFailure.code}>
                {runtime.lastFailure.message} Action: {runtime.lastFailure.action}
              </Callout>
            ) : null}
            <p className="hint-line">
              Starting and stopping runtimes is connected in P08. Mona does not launch an engine on
              shell navigation.
            </p>
          </Card>
          <Card title="Tool discovery" eyebrow="GUI launch environment">
            <ul className="evidence-list">
              {tools.map((tool) => (
                <li key={tool.name}>
                  <span className="mono">{tool.name}</span> · {tool.path ?? "not found"} ·{" "}
                  {tool.source}
                </li>
              ))}
            </ul>
          </Card>
        </TabPanel>

        <TabPanel id="privacy" active={tab === "privacy"}>
          <Card title="Boundaries" eyebrow="Full Access is not root">
            <ul className="rule-list">
              <li>
                <LockIcon size={15} /> The renderer is sandboxed with context isolation and a narrow
                typed bridge. No arbitrary shell, filesystem, or URL fetch is exposed.
              </li>
              <li>
                <ShieldIcon size={15} /> Runtime tokens stay in the owning process; they are never
                written to the database, renderer state, or logs.
              </li>
              <li>
                <FolderIcon size={15} /> Removing a catalog entry never deletes source files.
                Archive only hides the entry.
              </li>
              <li>
                <RefreshIcon size={15} /> Mona telemetry is off. Upstream engine telemetry remains
                separate and is never rewritten here.
              </li>
            </ul>
          </Card>
        </TabPanel>

        <TabPanel id="recovery" active={tab === "recovery"}>
          <Card title="Recovery" eyebrow="Transactional state">
            <dl className="detail-list">
              <div className="detail-row">
                <dt>Schema</dt>
                <dd>Versioned migrations with checksums and pre-migration snapshots</dd>
              </div>
              <div className="detail-row">
                <dt>Snapshots</dt>
                <dd className="mono wrap">{paths?.backups ?? "Unavailable"}</dd>
              </div>
              <div className="detail-row">
                <dt>Journal</dt>
                <dd>Failed migration journals and databases are preserved for diagnosis</dd>
              </div>
              <div className="detail-row">
                <dt>Restore</dt>
                <dd>Snapshot restore UI and diagnostics bundle arrive in P19</dd>
              </div>
            </dl>
            <p className="hint-line">
              The state layer already quiesces every writer during a backup or restore; the shell
              does not bypass that barrier.
            </p>
          </Card>
          <Card title="Application" eyebrow="Build facts">
            {app ? (
              <dl className="detail-list">
                <div className="detail-row">
                  <dt>Version</dt>
                  <dd>{app.version}</dd>
                </div>
                <div className="detail-row">
                  <dt>Electron</dt>
                  <dd>
                    {app.electron} · Node {app.node} · Chromium {app.chrome}
                  </dd>
                </div>
                <div className="detail-row">
                  <dt>Platform</dt>
                  <dd>
                    {app.platform} · {app.arch} · {app.packaged ? "packaged" : "development"}
                  </dd>
                </div>
              </dl>
            ) : (
              <EmptyState
                title="App facts unavailable"
                description="The narrow bridge did not return app information."
              />
            )}
          </Card>
        </TabPanel>
      </div>
    </div>
  );
}
