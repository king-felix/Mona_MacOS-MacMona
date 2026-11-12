import { useEffect, useState, type JSX } from "react";
import type { AppInfo, AppPathInfo, ToolDiscovery } from "../../shared/contracts/bridge";
import type {
  ProjectDetail,
  RuntimeStatusView,
  StateFacts,
} from "../../shared/contracts/project-bridge";
import type {
  PolishPreferences,
  PolishPreferencesPatch,
  PolishStatusView,
} from "../../shared/contracts/polish";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ScreenHeader,
  SegmentedControl,
  Switch,
  TabPanel,
  Tabs,
  TextField,
} from "../design/primitives";
import {
  ArchiveIcon,
  BranchIcon,
  ClockIcon,
  FolderIcon,
  LockIcon,
  RefreshIcon,
  ShieldIcon,
  TerminalIcon,
  WarningIcon,
} from "../design/icons";
import { FinderIntegration } from "./FinderIntegration";
import { RouteSettings } from "./RouteSettings";
import { ExtensionsSettings } from "./ExtensionsSettings";
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
  polish,
  onPatchPreferences,
  onTestNotification,
  onQuit,
  onOpenStudio,
  openTab,
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
  polish: PolishStatusView | null;
  onPatchPreferences: (patch: PolishPreferencesPatch) => void;
  onTestNotification: () => void;
  onQuit: () => void;
  onOpenStudio: () => void;
  /** Command palette or capability explorer requests a specific tab. */
  openTab?: string;
}): JSX.Element {
  const [tab, setTab] = useState(openTab ?? "appearance");
  useEffect(() => {
    if (openTab) setTab(openTab);
  }, [openTab]);
  const problems = facts?.permissionProblems ?? [];
  const preferences: PolishPreferences | null = polish?.preferences ?? null;
  const patchNotifications = (
    next: Omit<Partial<PolishPreferences["notifications"]>, "quietHours"> & {
      quietHours?: Partial<PolishPreferences["notifications"]["quietHours"]>;
    },
  ): void => {
    if (!preferences) return;
    onPatchPreferences({
      notifications: {
        ...preferences.notifications,
        ...next,
        quietHours: {
          ...preferences.notifications.quietHours,
          ...(next.quietHours ?? {}),
        },
      },
    });
  };

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
          { id: "attention", label: "Attention", icon: <WarningIcon size={15} /> },
          { id: "data", label: "Data", icon: <FolderIcon size={15} /> },
          { id: "route", label: "Providers & route", icon: <ShieldIcon size={15} /> },
          { id: "extensions", label: "Extensions", icon: <TerminalIcon size={15} /> },
          { id: "runtime", label: "Runtime", icon: <TerminalIcon size={15} /> },
          { id: "finder", label: "Finder", icon: <FolderIcon size={15} /> },
          { id: "privacy", label: "Privacy", icon: <ShieldIcon size={15} /> },
          { id: "recovery", label: "Recovery", icon: <ArchiveIcon size={15} /> },
        ]}
      />

      <div className="settings-panel">
        <TabPanel id="route" active={tab === "route"}>
          {detail ? (
            <RouteSettings projectId={detail.project.id} onOpenStudio={onOpenStudio} />
          ) : (
            <EmptyState
              icon={<ShieldIcon size={20} />}
              title="Open a project first"
              description="Provider and route settings are scoped to a project's live engine. Open a folder from Finder or Home, then return here."
            />
          )}
        </TabPanel>

        <TabPanel id="extensions" active={tab === "extensions"}>
          {detail ? (
            <ExtensionsSettings projectId={detail.project.id} onOpenStudio={onOpenStudio} />
          ) : (
            <EmptyState
              icon={<TerminalIcon size={20} />}
              title="Open a project first"
              description="Extensions are read from a project's engine. Open a folder, then return here to inspect MCP servers, skills, plugins, hooks, and instructions."
            />
          )}
        </TabPanel>

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
                Command-1 through Command-9 switch Home, Studio, Work board, Changes, Cost lens,
                Settings, Agents, Capabilities, and Memory. Command-J toggles the terminal.
              </li>
              <li>
                Command-Shift-F toggles Focus Mode; Command-Shift-B opens blockers; Command-period
                interrupts active work after a deliberate key combination.
              </li>
              <li>Command-K opens the command palette; Command-/ lists every shortcut.</li>
              <li>
                Command-O opens the project folder dialog. Command-W closes the window without
                quitting; Command-Q is the explicit quit.
              </li>
              <li>
                Tab and Shift-Tab traverse the rail, catalog, actions, and dialogs in DOM order.
              </li>
            </ul>
          </Card>
        </TabPanel>

        <TabPanel id="attention" active={tab === "attention"}>
          {polish && preferences ? (
            <>
              <Card title="Notifications" eyebrow="Local alerts only">
                <div className="settings-switches">
                  <Switch
                    label="Send completion, blocker, and limit alerts"
                    checked={preferences.notifications.enabled}
                    onChange={(enabled) => patchNotifications({ enabled })}
                  />
                  <Switch
                    label="Task completion"
                    checked={preferences.notifications.completion}
                    onChange={(completion) => patchNotifications({ completion })}
                  />
                  <Switch
                    label="Blockers"
                    checked={preferences.notifications.blocker}
                    onChange={(blocker) => patchNotifications({ blocker })}
                  />
                  <Switch
                    label="Cost limit warnings"
                    checked={preferences.notifications.limit}
                    onChange={(limit) => patchNotifications({ limit })}
                  />
                  <Switch
                    label="Show task details in notification text"
                    checked={preferences.notifications.showDetails}
                    onChange={(showDetails) => patchNotifications({ showDetails })}
                  />
                </div>
                <p className="hint-line">
                  Hidden details are the default: a lock screen shows only that Mona has an update,
                  never a prompt fragment, file name, or help request.
                </p>
                <div className="quiet-hours">
                  <Switch
                    label="Quiet hours"
                    checked={preferences.notifications.quietHours.enabled}
                    onChange={(enabled) => patchNotifications({ quietHours: { enabled } })}
                  />
                  <TextField
                    label="Starts"
                    type="time"
                    value={preferences.notifications.quietHours.start}
                    onChange={(event) =>
                      patchNotifications({ quietHours: { start: event.target.value } })
                    }
                    disabled={!preferences.notifications.quietHours.enabled}
                  />
                  <TextField
                    label="Ends"
                    type="time"
                    value={preferences.notifications.quietHours.end}
                    onChange={(event) =>
                      patchNotifications({ quietHours: { end: event.target.value } })
                    }
                    disabled={!preferences.notifications.quietHours.enabled}
                  />
                  <TextField
                    label="Time zone"
                    hint="IANA zone, for example Europe/Berlin. Quiet hours follow this zone across travel and daylight saving."
                    defaultValue={preferences.notifications.quietHours.timeZone}
                    disabled={!preferences.notifications.quietHours.enabled}
                    onBlur={(event) => {
                      const timeZone = event.target.value.trim();
                      if (timeZone && timeZone !== preferences.notifications.quietHours.timeZone) {
                        patchNotifications({ quietHours: { timeZone } });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </div>
                <p className="hint-line">
                  Quiet hours silence delivery only. Computation continues unless you explicitly
                  pause or interrupt. An alert inside the window is recorded as suppressed rather
                  than delivered later.
                </p>
              </Card>

              <Card title="Attention surfaces" eyebrow="Native macOS state">
                <div className="settings-switches">
                  <Switch
                    label="Dock badge"
                    checked={preferences.dockBadge}
                    onChange={(dockBadge) => onPatchPreferences({ dockBadge })}
                  />
                  <Switch
                    label="Menu-bar status"
                    checked={preferences.menuBarStatus}
                    onChange={(menuBarStatus) => onPatchPreferences({ menuBarStatus })}
                  />
                  <Switch
                    label="Keep the Mac awake while work is active"
                    checked={preferences.keepAwakeDuringWork}
                    onChange={(keepAwakeDuringWork) => onPatchPreferences({ keepAwakeDuringWork })}
                  />
                  <Switch
                    label="Open Mona at login"
                    checked={preferences.launchAtLogin}
                    onChange={(launchAtLogin) => onPatchPreferences({ launchAtLogin })}
                  />
                </div>
                <dl className="detail-list" data-testid="attention-state">
                  <div className="detail-row">
                    <dt>Menu bar</dt>
                    <dd>
                      {polish.attention.menuTitle} · {polish.menuBar.note}
                    </dd>
                  </div>
                  <div className="detail-row">
                    <dt>Badge</dt>
                    <dd>{polish.attention.badge ?? "None"}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>Blocked</dt>
                    <dd>{polish.attention.blocked}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>Finished since your last visit</dt>
                    <dd>{polish.attention.unseenCompletions}</dd>
                  </div>
                  <div className="detail-row">
                    <dt>Keep awake</dt>
                    <dd>
                      {polish.keepAwake.active ? "Assertion held" : "Released"} ·{" "}
                      {polish.keepAwake.note}
                    </dd>
                  </div>
                  <div className="detail-row">
                    <dt>Launch at login</dt>
                    <dd>
                      {polish.launchAtLogin.applied ? "Registered" : "Off"} ·{" "}
                      {polish.launchAtLogin.note}
                    </dd>
                  </div>
                </dl>
                <p className="hint-line">
                  The power assertion is scoped to an active turn or running task and is released
                  when work ends, the setting is turned off, or Mona quits.
                </p>
              </Card>

              <Card title="Delivery receipts" eyebrow="No silent drops">
                <div className="inline-facts">
                  <Button size="sm" variant="secondary" onClick={onTestNotification}>
                    Send test notification
                  </Button>
                  <Badge tone={polish.notifications.available ? "success" : "attention"}>
                    {polish.notifications.available ? "System available" : "Unavailable"}
                  </Badge>
                </div>
                <p className="hint-line">{polish.notifications.note}</p>
                {polish.notifications.recent.length === 0 ? (
                  <p className="hint-line">No alert has been attempted in this launch.</p>
                ) : (
                  <ul className="evidence-list" data-testid="notification-receipts">
                    {polish.notifications.recent
                      .slice()
                      .reverse()
                      .map((receipt) => (
                        <li key={`${receipt.key}-${receipt.at}`}>
                          <Badge
                            tone={
                              receipt.delivery === "shown"
                                ? "success"
                                : receipt.delivery === "handed_over"
                                  ? "attention"
                                  : receipt.delivery === "failed"
                                    ? "danger"
                                    : "neutral"
                            }
                          >
                            {receipt.delivery === "shown"
                              ? "shown"
                              : receipt.delivery === "handed_over"
                                ? "handed over"
                                : receipt.delivery === "failed"
                                  ? "system refused"
                                  : "suppressed"}
                          </Badge>{" "}
                          {receipt.kind} · {receipt.suppressedReason ?? receipt.title}{" "}
                          <span className="muted">{new Date(receipt.at).toLocaleString()}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </Card>

              <Card title="Quit" eyebrow="Closing is not quitting">
                <p className="hint-line">
                  Close the window to keep work running; the Dock icon and menu-bar status remain.
                  Quitting interrupts active work and stops only the runtime Mona owns.
                </p>
                <Button variant="danger" onClick={onQuit}>
                  Quit Mona…
                </Button>
              </Card>
            </>
          ) : (
            <Card>
              <EmptyState
                icon={<ClockIcon size={26} />}
                title="Attention state unavailable"
                description="The local preference store did not answer. Notifications and menu-bar state stay off rather than pretending to be configured."
              />
            </Card>
          )}
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

        <TabPanel id="finder" active={tab === "finder"}>
          <FinderIntegration />
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
