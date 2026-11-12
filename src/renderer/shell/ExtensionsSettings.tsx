import { useEffect, useState, type JSX } from "react";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  ExtensionActionId,
  ExtensionActionReceipt,
  ExtensionsSnapshot,
  McpServerView,
  McpToolView,
  PluginView,
  SkillView,
} from "../../shared/contracts/extensions";
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  SelectField,
  TabPanel,
  Tabs,
  TextField,
} from "../design/primitives";
import { RefreshIcon, ShieldIcon, TerminalIcon, WarningIcon } from "../design/icons";

type Tone = "neutral" | "primary" | "accent" | "success" | "attention" | "danger";

interface Notice {
  tone: Tone;
  text: string;
}

function healthTone(server: McpServerView): Tone {
  if (server.health.state === "connected") return "success";
  if (server.health.state === "failed") return "danger";
  return "neutral";
}

function trustTone(status: string): Tone {
  if (status === "approved" || status === "trusted") return "success";
  if (status === "revoked") return "danger";
  return "attention";
}

export function ExtensionsSettings({
  projectId,
  onOpenStudio,
}: {
  projectId: ProjectId;
  onOpenStudio: () => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | null>(null);
  const [tab, setTab] = useState("mcp");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tools, setTools] = useState<{
    server: string;
    tools: McpToolView[];
    error: string | null;
  } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [addForm, setAddForm] = useState({
    name: "",
    command: "",
    args: "",
    url: "",
    enabled: true,
  });
  const [installKind, setInstallKind] = useState<"plugin" | "skill">("plugin");
  const [installSource, setInstallSource] = useState("");

  const load = async (): Promise<void> => {
    if (typeof window.mona.extensionsSnapshot !== "function") {
      setNotice({ tone: "attention", text: "This build does not expose the extension bridge." });
      return;
    }
    const result = await window.mona.extensionsSnapshot(projectId);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setSnapshot(result.value);
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  const applyReceipt = (receipt: ExtensionActionReceipt): void => {
    setNotice({
      tone: receipt.ok ? "success" : "danger",
      text: receipt.detail ? `${receipt.message} ${receipt.detail}` : receipt.message,
    });
  };

  const act = async (
    action: ExtensionActionId,
    target: string,
    expectedRevision?: string | null,
  ): Promise<void> => {
    setBusy(`${action}:${target}`);
    const result = await window.mona.extensionAction({
      projectId,
      action,
      target,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    applyReceipt(result.value);
    await load();
  };

  const listTools = async (server: string): Promise<void> => {
    setBusy(`tools:${server}`);
    const result = await window.mona.mcpTools(projectId, server);
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    setTools({ server, tools: result.value.tools, error: result.value.error });
  };

  const addServer = async (): Promise<void> => {
    if (!snapshot?.mcp.revision) {
      setNotice({ tone: "attention", text: "Read the MCP configuration before adding a server." });
      return;
    }
    setBusy("add");
    const args = addForm.args
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    const result = await window.mona.addMcpServer(projectId, {
      expectedRevision: snapshot.mcp.revision,
      name: addForm.name.trim(),
      command: addForm.command.trim() || null,
      args,
      url: addForm.url.trim() || null,
      transport: null,
      enabled: addForm.enabled,
    });
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    applyReceipt(result.value);
    setAddForm({ name: "", command: "", args: "", url: "", enabled: true });
    await load();
  };

  const install = async (): Promise<void> => {
    setBusy("install");
    const result = await window.mona.installExtension(projectId, installKind, installSource.trim());
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "danger", text: `${result.error.code}: ${result.error.message}` });
      return;
    }
    applyReceipt(result.value);
    setInstallSource("");
    await load();
  };

  if (!snapshot) {
    return (
      <EmptyState
        icon={<RefreshIcon size={20} />}
        title="Reading extensions"
        description="Mona is reading MCP servers, skills, plugins, hooks, instructions, and user commands from the engine. No server is started and no tool list enters model context."
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
        <Callout tone={notice.tone} title={notice.tone === "danger" ? "Not applied" : "Extensions"}>
          {notice.text}
        </Callout>
      ) : null}

      <Card title="Workspace scope" eyebrow="What project trust controls">
        <div className="inline-facts">
          <Badge tone={snapshot.workspaceTrust.trusted ? "success" : "attention"}>
            {snapshot.workspaceTrust.trusted ? "workspace trusted" : "project content gated"}
          </Badge>
          <span className="mono">{snapshot.workspaceTrust.workspace ?? "workspace unknown"}</span>
        </div>
        <p className="muted">{snapshot.workspaceTrust.note}</p>
        <div className="button-row">
          {snapshot.workspaceTrust.actions.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant={entry.destructive ? "ghost" : "secondary"}
              disabled={!entry.available || busy !== null || snapshot.runtime !== "connected"}
              title={entry.reason ?? entry.sideEffect}
              onClick={() => void act(entry.id, "workspace")}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </Card>

      <Tabs
        label="Extension categories"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "mcp", label: `MCP (${snapshot.mcp.servers.length})` },
          { id: "skills", label: `Skills (${snapshot.skills.skills.length})` },
          { id: "plugins", label: `Plugins (${snapshot.plugins.plugins.length})` },
          { id: "hooks", label: `Hooks (${snapshot.hooks.hooks.length})` },
          { id: "instructions", label: "Instructions" },
          { id: "commands", label: `Commands (${snapshot.commands.userCount})` },
        ]}
      />

      <TabPanel id="mcp" active={tab === "mcp"}>
        <Card
          title="MCP servers"
          eyebrow={
            snapshot.mcp.revision ? `revision ${snapshot.mcp.revision.slice(0, 12)}` : "no revision"
          }
          actions={
            <Badge tone={snapshot.mcp.source === "live" ? "success" : "primary"}>
              {snapshot.mcp.source}
            </Badge>
          }
        >
          <p className="muted">
            Reading this list does not start a server. “Check health” performs one handshake and
            reports the engine's error verbatim; “List tools” is on demand and never loads every
            server's tool descriptions into model context.
          </p>
          {snapshot.mcp.error ? <p className="muted">{snapshot.mcp.error}</p> : null}
          {snapshot.mcp.servers.length === 0 ? (
            <p className="muted">
              No MCP servers are configured for this engine. Add one below or use the engine's own
              `codewhale mcp` command.
            </p>
          ) : (
            <div className="ext-list">
              {snapshot.mcp.servers.map((server) => (
                <div className="ext-row" key={server.name}>
                  <div className="ext-row__head">
                    <span className="mono">{server.name}</span>
                    <Badge tone={server.enabled ? "success" : "neutral"}>
                      {server.enabled ? "enabled" : "disabled"}
                    </Badge>
                    <Badge tone={server.origin === "project" ? "primary" : "neutral"}>
                      {server.origin}
                    </Badge>
                    <Badge tone={healthTone(server)}>{server.health.state.replace("_", " ")}</Badge>
                    {server.credentialConfigured ? (
                      <Badge tone="accent">credential set</Badge>
                    ) : null}
                    {server.authRequired ? <Badge tone="attention">auth required</Badge> : null}
                  </div>
                  <div className="inline-facts">
                    <span className="mono">
                      {server.command ?? server.urlAuthority ?? "no transport"}
                    </span>
                    <span>{server.argsCount} args</span>
                    {server.envKeys.length > 0 ? (
                      <span>env keys: {server.envKeys.join(", ")} (values never shown)</span>
                    ) : null}
                    {server.headerKeys.length > 0 ? (
                      <span>header keys: {server.headerKeys.join(", ")}</span>
                    ) : null}
                  </div>
                  {server.health.error ? <p className="muted">{server.health.error}</p> : null}
                  <div className="button-row">
                    {server.actions
                      .filter((entry) => entry.id !== "mcp.remove")
                      .map((entry) => (
                        <Button
                          key={entry.id}
                          size="sm"
                          variant="ghost"
                          disabled={
                            !entry.available || busy !== null || snapshot.runtime !== "connected"
                          }
                          title={entry.reason ?? entry.sideEffect}
                          onClick={() =>
                            entry.id === "mcp.tools"
                              ? void listTools(server.name)
                              : void act(entry.id, server.name, snapshot.mcp.revision)
                          }
                        >
                          {busy === `${entry.id}:${server.name}` ? "Working…" : entry.label}
                        </Button>
                      ))}
                    {(() => {
                      const remove = server.actions.find((entry) => entry.id === "mcp.remove");
                      if (!remove) return null;
                      const confirming = confirmRemove === server.name;
                      return (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!remove.available || busy !== null}
                          title={remove.sideEffect}
                          onClick={() => {
                            if (!confirming) {
                              setConfirmRemove(server.name);
                              return;
                            }
                            setConfirmRemove(null);
                            void act("mcp.remove", server.name, snapshot.mcp.revision);
                          }}
                        >
                          {confirming ? "Confirm remove" : "Remove"}
                        </Button>
                      );
                    })()}
                  </div>
                  {server.actions.some((entry) => !entry.available) ? (
                    <p className="muted">
                      {server.actions
                        .filter((entry) => !entry.available && entry.reason)
                        .map((entry) => `${entry.label}: ${entry.reason}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {tools ? (
            <div className="ext-tools">
              <div className="inline-facts">
                <span className="mono">{tools.server}</span>
                <span>{tools.tools.length} tools</span>
                {tools.error ? <Badge tone="danger">{tools.error}</Badge> : null}
              </div>
              {tools.tools.length === 0 && !tools.error ? (
                <p className="muted">The server reported no tools.</p>
              ) : null}
              {tools.tools.map((tool) => (
                <div className="ext-row" key={`${tool.server}:${tool.name}`}>
                  <div className="ext-row__head">
                    <span className="mono">{tool.prefixedName}</span>
                    <span className="muted">{tool.description}</span>
                  </div>
                  <details>
                    <summary>Input schema</summary>
                    <pre className="mono">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
                  </details>
                </div>
              ))}
            </div>
          ) : null}

          <div className="form-grid">
            <TextField
              label="Server name"
              value={addForm.name}
              placeholder="fixture"
              onChange={(event) => setAddForm((form) => ({ ...form, name: event.target.value }))}
              disabled={snapshot.runtime !== "connected"}
            />
            <TextField
              label="Absolute command"
              mono
              value={addForm.command}
              placeholder="/usr/local/bin/my-mcp-server"
              hint="Global scope only. A bare PATH name is refused so the GUI cannot resolve a different binary."
              onChange={(event) => setAddForm((form) => ({ ...form, command: event.target.value }))}
              disabled={snapshot.runtime !== "connected"}
            />
            <TextField
              label="Arguments"
              mono
              value={addForm.args}
              placeholder="--stdio"
              onChange={(event) => setAddForm((form) => ({ ...form, args: event.target.value }))}
              disabled={snapshot.runtime !== "connected"}
            />
            <TextField
              label="or URL"
              mono
              value={addForm.url}
              placeholder="https://example.invalid/mcp"
              onChange={(event) => setAddForm((form) => ({ ...form, url: event.target.value }))}
              disabled={snapshot.runtime !== "connected"}
            />
            <SelectField
              label="Enabled"
              value={addForm.enabled ? "true" : "false"}
              options={[
                { value: "true", label: "Enabled" },
                { value: "false", label: "Disabled" },
              ]}
              onChange={(event) =>
                setAddForm((form) => ({ ...form, enabled: event.target.value === "true" }))
              }
            />
          </div>
          <div className="button-row">
            <Button
              variant="primary"
              disabled={snapshot.runtime !== "connected" || busy !== null || !snapshot.mcp.revision}
              onClick={() => void addServer()}
            >
              {busy === "add" ? "Adding…" : "Add global MCP server"}
            </Button>
          </div>
          <p className="muted">{snapshot.capabilities.mcpAddNote}</p>
        </Card>
      </TabPanel>

      <TabPanel id="skills" active={tab === "skills"}>
        <Card title="Skills" eyebrow={`${snapshot.skills.directories.length} discovery roots`}>
          <p className="muted">
            Skill rows are local metadata. Enabling a skill changes the engine's global activation
            state; it does not edit the skill's files or send anything to the model now.
          </p>
          {snapshot.skills.warnings.length > 0 ? (
            <Callout tone="attention" title="Discovery warnings">
              <ul>
                {snapshot.skills.warnings.map((warning, index) => (
                  <li key={`${warning}-${index}`}>{warning}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <div className="ext-list">
            {snapshot.skills.skills.map((skill) => (
              <SkillRow
                key={skill.name}
                skill={skill}
                runtime={snapshot.runtime}
                busy={busy}
                onAct={(action) => void act(action, skill.name)}
              />
            ))}
          </div>
          <div className="inline-facts">
            {snapshot.skills.directories.map((directory) => (
              <span className="mono" key={directory}>
                {directory}
              </span>
            ))}
          </div>
          <p className="muted">{snapshot.capabilities.skillInstallNote}</p>
        </Card>
      </TabPanel>

      <TabPanel id="plugins" active={tab === "plugins"}>
        <Card
          title="Plugins"
          eyebrow={
            snapshot.plugins.validationClean === null
              ? "registry state unknown"
              : snapshot.plugins.validationClean
                ? "registry clean"
                : "registry diagnostics present"
          }
        >
          <p className="muted">
            A plugin bundle can run code and add MCP servers. Mona shows its inventory and exact
            hashes; a new bundle stays installed, disabled, and untrusted until reviewed. The engine
            redacts the HTTP review token, so trust remains a terminal action.
          </p>
          <div className="ext-list">
            {snapshot.plugins.plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                runtime={snapshot.runtime}
                busy={busy}
                confirming={confirmRemove === plugin.id}
                onAct={(action) => {
                  if (action === "plugin.remove" && confirmRemove !== plugin.id) {
                    setConfirmRemove(plugin.id);
                    return;
                  }
                  setConfirmRemove(null);
                  void act(action, plugin.id);
                }}
              />
            ))}
          </div>
          {snapshot.plugins.registryDiagnostics.length > 0 ? (
            <Callout tone="attention" title="Registry diagnostics">
              <ul>
                {snapshot.plugins.registryDiagnostics.map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <div className="form-grid">
            <SelectField
              label="Install kind"
              value={installKind}
              options={[
                { value: "plugin", label: "Plugin bundle" },
                { value: "skill", label: "Skill (remote source)" },
              ]}
              onChange={(event) =>
                setInstallKind(event.target.value === "skill" ? "skill" : "plugin")
              }
            />
            <TextField
              label="Source"
              mono
              value={installSource}
              placeholder={
                installKind === "plugin" ? "/absolute/path/to/bundle" : "https://… or owner/repo"
              }
              hint="The engine validates the source. Network access needs explicit approval."
              onChange={(event) => setInstallSource(event.target.value)}
              disabled={snapshot.runtime !== "connected"}
            />
          </div>
          <div className="button-row">
            <Button
              variant="primary"
              disabled={
                snapshot.runtime !== "connected" || busy !== null || installSource.trim() === ""
              }
              onClick={() => void install()}
            >
              {busy === "install" ? "Installing…" : `Install ${installKind}`}
            </Button>
          </div>
          <p className="muted">
            {snapshot.capabilities.pluginInstallNote} {snapshot.capabilities.pluginTrustNote}
          </p>
        </Card>
      </TabPanel>

      <TabPanel id="hooks" active={tab === "hooks"}>
        <Card title="Hooks" eyebrow={snapshot.hooks.enabled ? "hook set loaded" : "not loaded"}>
          <p className="muted">{snapshot.hooks.note}</p>
          {snapshot.hooks.problems.length > 0 ? (
            <Callout tone="attention" title="Hook problems">
              <ul>
                {snapshot.hooks.problems.map((problem, index) => (
                  <li key={`${problem}-${index}`}>{problem}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {snapshot.hooks.hooks.length === 0 ? (
            <p className="muted">No hooks are loaded for this workspace.</p>
          ) : (
            <div className="ext-list">
              {snapshot.hooks.hooks.map((hook) => (
                <div className="ext-row" key={`${hook.source}:${hook.name}`}>
                  <div className="ext-row__head">
                    <span className="mono">{hook.name}</span>
                    <Badge tone="neutral">{hook.event}</Badge>
                    <Badge tone={hook.source === "project" ? "primary" : "neutral"}>
                      {hook.source}
                    </Badge>
                    <span className="muted">{hook.background ? "background" : "blocking"}</span>
                  </div>
                  <pre className="mono">{hook.command}</pre>
                </div>
              ))}
            </div>
          )}
          <p className="muted">
            Editing hooks has no desktop route in this build. Use the engine's configuration files
            or terminal; project hooks also require the engine's separate digest approval.
          </p>
        </Card>
      </TabPanel>

      <TabPanel id="instructions" active={tab === "instructions"}>
        <Card title="Rules and instructions" eyebrow="Loaded by the engine">
          <p className="muted">
            Instruction files are read by the engine's context loader. Mona shows what exists and
            what is missing; it never pastes these files into a prompt from the UI.
          </p>
          <div className="ext-list">
            {snapshot.instructions.sources.map((source) => (
              <div className="ext-row" key={`${source.kind}:${source.path}`}>
                <div className="ext-row__head">
                  <Badge tone={source.exists ? "success" : "neutral"}>
                    {source.exists ? source.status : "missing"}
                  </Badge>
                  <Badge tone={source.kind === "project" ? "primary" : "neutral"}>
                    {source.kind}
                  </Badge>
                  <span className="mono">{source.relativePath ?? source.path}</span>
                  {source.bytes !== null ? (
                    <span className="muted">{source.bytes} bytes</span>
                  ) : null}
                </div>
                {source.warning ? <p className="muted">{source.warning}</p> : null}
              </div>
            ))}
          </div>
        </Card>
      </TabPanel>

      <TabPanel id="commands" active={tab === "commands"}>
        <Card
          title="User commands"
          eyebrow={`${snapshot.commands.userCount} user · ${snapshot.commands.commands.length} visible`}
        >
          <p className="muted">
            Host-bound commands run locally and are never submitted as a model prompt. Mona lists
            them with their binding so that distinction is visible.
          </p>
          <div className="ext-list">
            {snapshot.commands.commands.map((command) => (
              <div className="ext-row" key={`${command.kind}:${command.name}`}>
                <div className="ext-row__head">
                  <span className="mono">/{command.name}</span>
                  <Badge tone={command.binding === "host" ? "success" : "neutral"}>
                    {command.binding}
                  </Badge>
                  <Badge tone="neutral">{command.kind}</Badge>
                  {command.aliases.length > 0 ? (
                    <span className="muted">aliases {command.aliases.join(", ")}</span>
                  ) : null}
                </div>
                <p className="muted">{command.summary}</p>
              </div>
            ))}
          </div>
          <p className="muted">
            User command templates have no desktop editing route in this build; manage them with the
            engine's configuration and terminal.
          </p>
        </Card>
      </TabPanel>

      <Card title="Known limits" eyebrow="Stated, not hidden">
        <div className="ext-list">
          {snapshot.gaps.map((gap) => (
            <div className="ext-row" key={gap.id}>
              <div className="ext-row__head">
                <Badge tone="attention">{gap.category}</Badge>
                <span className="mono">{gap.id}</span>
              </div>
              <p className="muted">{gap.statement}</p>
              <p className="muted">
                <TerminalIcon size={13} /> {gap.route}
              </p>
            </div>
          ))}
        </div>
        <div className="inline-facts">
          <ShieldIcon size={14} />
          <span>{snapshot.capabilities.selectiveDiscoveryNote}</span>
          <WarningIcon size={14} />
          <span>no extension has access to Mona's IPC bridge</span>
        </div>
      </Card>
    </div>
  );
}

function SkillRow({
  skill,
  runtime,
  busy,
  onAct,
}: {
  skill: SkillView;
  runtime: ExtensionsSnapshot["runtime"];
  busy: string | null;
  onAct: (action: ExtensionActionId) => void;
}): JSX.Element {
  return (
    <div className="ext-row">
      <div className="ext-row__head">
        <span className="mono">{skill.name}</span>
        <Badge tone={skill.enabled ? "success" : "neutral"}>
          {skill.enabled ? "enabled" : "disabled"}
        </Badge>
        <Badge tone={skill.scope === "builtin" ? "neutral" : "primary"}>{skill.scope}</Badge>
        {skill.invocation ? <span className="muted">{skill.invocation}</span> : null}
      </div>
      <p className="muted">{skill.description}</p>
      <div className="button-row">
        {skill.actions
          .filter((entry) => entry.available)
          .map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant="ghost"
              disabled={runtime !== "connected" || busy !== null}
              title={entry.sideEffect}
              onClick={() => onAct(entry.id)}
            >
              {busy === `${entry.id}:${skill.name}` ? "Working…" : entry.label}
            </Button>
          ))}
        {skill.path ? <span className="muted mono">{skill.path}</span> : null}
      </div>
    </div>
  );
}

function PluginRow({
  plugin,
  runtime,
  busy,
  confirming,
  onAct,
}: {
  plugin: PluginView;
  runtime: ExtensionsSnapshot["runtime"];
  busy: string | null;
  confirming: boolean;
  onAct: (action: ExtensionActionId) => void;
}): JSX.Element {
  return (
    <div className="ext-row">
      <div className="ext-row__head">
        <span className="mono">{plugin.name}</span>
        <Badge tone={plugin.enabled ? "success" : "neutral"}>
          {plugin.enabled ? "enabled" : plugin.state}
        </Badge>
        <Badge tone={trustTone(plugin.trustStatus)}>{plugin.trustStatus}</Badge>
        <Badge tone={plugin.compatibility === "full" ? "success" : "attention"}>
          {plugin.compatibility}
        </Badge>
        {plugin.version ? <span className="muted">v{plugin.version}</span> : null}
        <Badge tone="neutral">{plugin.scope}</Badge>
      </div>
      {plugin.description ? <p className="muted">{plugin.description}</p> : null}
      <div className="inline-facts">
        <span>{plugin.inventory.skills} skills</span>
        <span>{plugin.inventory.mcpServers} MCP servers</span>
        <span>{plugin.inventory.commands} commands</span>
        <span>{plugin.inventory.hooks} hooks</span>
        {plugin.inventory.lifecycleMutation ? (
          <Badge tone="attention">lifecycle mutation</Badge>
        ) : null}
        {plugin.inventory.networkHosts.length > 0 ? (
          <span>network: {plugin.inventory.networkHosts.join(", ")}</span>
        ) : null}
        {plugin.inventory.filesystemRoots.length > 0 ? (
          <span>files: {plugin.inventory.filesystemRoots.join(", ")}</span>
        ) : null}
        {plugin.contentHash ? (
          <span className="mono">sha {plugin.contentHash.slice(0, 12)}</span>
        ) : null}
      </div>
      {plugin.diagnostics.length > 0 ? (
        <ul className="route-warnings">
          {plugin.diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}:${diagnostic.message}`}>
              {diagnostic.level}: {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="button-row">
        {plugin.actions
          .filter((entry) => entry.available)
          .map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant="ghost"
              disabled={runtime !== "connected" || busy !== null}
              title={entry.sideEffect}
              onClick={() => onAct(entry.id)}
            >
              {busy === `${entry.id}:${plugin.id}`
                ? "Working…"
                : entry.id === "plugin.remove" && confirming
                  ? "Confirm remove"
                  : entry.label}
            </Button>
          ))}
        <span className="muted">
          {plugin.reviewAvailable ? "review token available" : "review token redacted by engine"}
        </span>
      </div>
      {plugin.actions.some((entry) => !entry.available && entry.reason) ? (
        <p className="muted">
          {plugin.actions
            .filter((entry) => !entry.available && entry.reason)
            .map((entry) => `${entry.label}: ${entry.reason}`)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
