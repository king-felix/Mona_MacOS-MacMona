import { homedir } from "node:os";
import type { ProjectId } from "../../shared/contracts/ids";
import type {
  CommandView,
  CommandsView,
  ExtensionActionId,
  ExtensionActionReceipt,
  ExtensionActionView,
  ExtensionGap,
  ExtensionScope,
  ExtensionsSnapshot,
  HookView,
  HooksView,
  InstructionView,
  InstructionsView,
  McpServerView,
  McpToolView,
  McpView,
  PluginView,
  PluginsView,
  SkillView,
  SkillsView,
  WorkspaceTrustView,
} from "../../shared/contracts/extensions";
import type {
  EngineCommands,
  EngineHook,
  EngineInstructionSource,
  EngineMcpList,
  EngineMcpServer,
  EnginePlugin,
  EngineSettingsAdapter,
  EngineSkill,
} from "../engine/types";
import type { StateStore } from "../state/store";
import { redactDiagnostics, redactHomePath } from "./settings";

const HOME = homedir();
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CACHE = {
  mcp: "extensions:mcp-cache",
  skills: "extensions:skills-cache",
  plugins: "extensions:plugins-cache",
  hooks: "extensions:hooks-cache",
  instructions: "extensions:instructions-cache",
  commands: "extensions:commands-cache",
  trust: "extensions:trust-cache",
} as const;

export class ExtensionError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_UNAVAILABLE"
      | "STALE_REVISION"
      | "UNSUPPORTED_ACTION"
      | "INVALID_INPUT"
      | "ACTION_FAILED",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

export interface ExtensionsEngineAccess {
  adapter: EngineSettingsAdapter;
  workspace: string;
}

export interface ExtensionWorkbenchOptions {
  store: StateStore;
  engine: (projectId: ProjectId) => ExtensionsEngineAccess | null;
  now?: () => Date;
}

export interface ExtensionActionInput {
  projectId: ProjectId;
  action: ExtensionActionId;
  target: string;
  expectedRevision?: string | null;
  token?: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactPath(path: string | null): string | null {
  if (!path) return null;
  return redactHomePath(path, HOME);
}

function redactText(text: string, limit = 2000): string {
  return redactDiagnostics(text.slice(0, limit)).text;
}

function scopeOf(value: string): ExtensionScope {
  switch (value) {
    case "builtin":
    case "global":
    case "project":
    case "plugin":
    case "user":
      return value;
    default:
      return "unknown";
  }
}

function urlAuthority(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function action(
  id: ExtensionActionId,
  label: string,
  options: {
    available?: boolean;
    reason?: string | null;
    scope?: ExtensionScope;
    sideEffect: string;
    destructive?: boolean;
    needsRevision?: boolean;
  },
): ExtensionActionView {
  return {
    id,
    label,
    available: options.available !== false,
    reason: options.reason ?? null,
    scope: options.scope ?? "global",
    sideEffect: options.sideEffect,
    destructive: options.destructive === true,
    needsRevision: options.needsRevision === true,
  };
}

function trustApproved(status: string): boolean {
  return status === "approved" || status === "trusted";
}

export class ExtensionWorkbench {
  private readonly store: StateStore;
  private readonly engine: ExtensionWorkbenchOptions["engine"];
  private readonly now: () => Date;
  /** Reconnect results are live observations, never persisted as health history. */
  private readonly health = new Map<
    string,
    { ok: boolean; error: string | null; checkedAt: string }
  >();

  constructor(options: ExtensionWorkbenchOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(projectId: ProjectId): Promise<ExtensionsSnapshot> {
    const access = this.engine(projectId);
    if (!access) {
      const [mcp, skills, plugins, hooks, instructions, commands, trust] = await Promise.all([
        this.cached<McpView>(CACHE.mcp),
        this.cached<SkillsView>(CACHE.skills),
        this.cached<PluginsView>(CACHE.plugins),
        this.cached<HooksView>(CACHE.hooks),
        this.cached<InstructionsView>(CACHE.instructions),
        this.cached<CommandsView>(CACHE.commands),
        this.cached<WorkspaceTrustView>(CACHE.trust),
      ]);
      return {
        projectId,
        runtime: "unavailable",
        runtimeNote:
          "The live engine is not connected. The last verified inventory is shown with its read time; no state is guessed and no action is enabled.",
        workspaceTrust: trust ?? {
          workspace: null,
          trusted: false,
          configPath: null,
          note: "Workspace trust has not been read in this installation yet.",
          actions: [],
        },
        mcp: mcp ? { ...mcp, source: "stored" } : emptyMcp(),
        skills: skills ? { ...skills, source: "stored" } : emptySkills(),
        plugins: plugins ? { ...plugins, source: "stored" } : emptyPlugins(),
        hooks: hooks ? { ...hooks, source: "stored" } : emptyHooks(),
        instructions: instructions ? { ...instructions, source: "stored" } : emptyInstructions(),
        commands: commands ? { ...commands, source: "stored" } : emptyCommands(),
        capabilities: capabilitiesFor(false),
        gaps: gapsFor(false),
      };
    }

    const mcp = await this.readMcp(access, projectId);
    const trust = await this.readTrust(access);
    const [skills, plugins, hooks, instructions, commands] = await Promise.all([
      this.readSkills(access),
      this.readPlugins(access),
      this.readHooks(access),
      this.readInstructions(access),
      this.readCommands(access),
    ]);
    return {
      projectId,
      runtime: "connected",
      runtimeNote:
        "Live inventory read from this project's engine. No server was started by reading.",
      workspaceTrust: trust,
      mcp,
      skills,
      plugins,
      hooks,
      instructions,
      commands,
      capabilities: capabilitiesFor(true),
      gaps: gapsFor(true),
    };
  }

  async mcpTools(
    projectId: ProjectId,
    server: string,
  ): Promise<{ tools: McpToolView[]; source: "live"; error: string | null }> {
    const access = this.requireEngine(projectId);
    if (!MCP_NAME.test(server)) {
      throw new ExtensionError("INVALID_INPUT", "server name is not a bounded identifier");
    }
    try {
      const result = await access.adapter.readMcpTools(server);
      return {
        tools: result.tools.map((tool) => ({
          server: tool.server,
          name: tool.name,
          prefixedName: tool.prefixedName,
          description: redactText(tool.description, 1000),
          inputSchema: tool.inputSchema,
        })),
        source: "live",
        error: null,
      };
    } catch (error) {
      // An engine error can echo a command line or a path; redact before it
      // reaches the renderer, exactly as every other extension surface does.
      return { tools: [], source: "live", error: redactText(describe(error)) };
    }
  }

  async addMcp(
    projectId: ProjectId,
    input: {
      expectedRevision: string;
      name: string;
      command: string | null;
      args: string[];
      url: string | null;
      transport: "sse" | null;
      enabled: boolean;
    },
  ): Promise<ExtensionActionReceipt> {
    const access = this.requireEngine(projectId);
    if (!MCP_NAME.test(input.name)) {
      throw new ExtensionError(
        "INVALID_INPUT",
        "server name must match [A-Za-z0-9._-], up to 64 characters",
      );
    }
    if (!input.expectedRevision) {
      throw new ExtensionError(
        "STALE_REVISION",
        "read the current MCP configuration before adding a server",
      );
    }
    if (input.command) {
      if (!input.command.startsWith("/")) {
        throw new ExtensionError(
          "INVALID_INPUT",
          "use an absolute executable path so the GUI launch environment cannot resolve a different binary",
        );
      }
      if (
        input.args.length > 32 ||
        input.args.some((arg) => arg.length > 2000 || arg.includes("\0"))
      ) {
        throw new ExtensionError("INVALID_INPUT", "server arguments are out of bounds");
      }
    }
    if (input.url) {
      const authority = urlAuthority(input.url);
      if (!authority) {
        throw new ExtensionError("INVALID_INPUT", "URL must be an http(s) endpoint");
      }
    }
    if (!input.command && !input.url) {
      throw new ExtensionError("INVALID_INPUT", "give the server a command or a URL");
    }
    const saved = await access.adapter.addMcpServer({
      revision: input.expectedRevision,
      name: input.name,
      command: input.command,
      args: input.args,
      url: input.url,
      transport: input.transport,
      enabled: input.enabled,
    });
    return {
      action: "mcp.add",
      target: saved.name,
      ok: true,
      revision: saved.revision,
      message: "MCP server added to the global configuration.",
      detail:
        "Review and connect it before relying on its tools; adding does not start the server.",
    };
  }

  async act(input: ExtensionActionInput): Promise<ExtensionActionReceipt> {
    const access = this.requireEngine(input.projectId);
    switch (input.action) {
      case "mcp.enable":
      case "mcp.disable":
      case "mcp.reconnect":
      case "mcp.remove": {
        if (!MCP_NAME.test(input.target)) {
          throw new ExtensionError("INVALID_INPUT", "server name is not a bounded identifier");
        }
        if (!input.expectedRevision) {
          throw new ExtensionError(
            "STALE_REVISION",
            "read the current MCP revision before changing a server",
          );
        }
        const operation =
          input.action === "mcp.enable"
            ? "enable"
            : input.action === "mcp.disable"
              ? "disable"
              : input.action === "mcp.reconnect"
                ? "reconnect"
                : "remove";
        const result = await access.adapter.controlMcpServer({
          revision: input.expectedRevision,
          name: input.target,
          action: operation,
        });
        this.health.set(`${input.projectId}:${result.name}`, {
          ok: result.ok,
          error: result.connection?.error ?? (result.ok ? null : result.message),
          checkedAt: this.now().toISOString(),
        });
        return {
          action: input.action,
          target: result.name,
          ok: result.ok,
          revision: result.revision,
          message:
            operation === "reconnect"
              ? result.ok
                ? "MCP handshake succeeded."
                : `MCP handshake failed: ${redactText(result.connection?.error ?? result.message)}`
              : `The engine reported ${result.action} for ${result.name}.`,
          detail: result.connection
            ? `connected=${result.connection.connected}${result.connection.error ? `; ${redactText(result.connection.error)}` : ""}`
            : result.action,
        };
      }
      case "skill.enable":
      case "skill.disable": {
        const enabled = input.action === "skill.enable";
        const result = await access.adapter.setSkillEnabled(input.target, enabled);
        return {
          action: input.action,
          target: result.name,
          ok: result.enabled === enabled,
          revision: null,
          message: `The engine reports ${result.name} ${result.enabled ? "enabled" : "disabled"}.`,
          detail: "The toggle is global for this engine; it does not edit the skill's files.",
        };
      }
      case "plugin.enable":
      case "plugin.disable":
      case "plugin.revoke":
      case "plugin.remove": {
        const operation =
          input.action === "plugin.enable"
            ? "enable"
            : input.action === "plugin.disable"
              ? "disable"
              : input.action === "plugin.revoke"
                ? "revoke"
                : "remove";
        const result = await access.adapter.controlPlugin({ id: input.target, action: operation });
        return {
          action: input.action,
          target: input.target,
          ok: result.ok,
          revision: null,
          message: `The engine reported ${operation} for ${input.target}.`,
          detail: redactText(result.message),
        };
      }
      case "plugin.trust": {
        throw new ExtensionError(
          "UNSUPPORTED_ACTION",
          "this engine redacts the plugin review token on its HTTP surface; trust the bundle from the Codewhale terminal (/plugins trust) and reload here",
        );
      }
      case "plugin.update":
      case "skill.update":
      case "skill.trust": {
        throw new ExtensionError(
          "UNSUPPORTED_ACTION",
          "this action has no verified desktop route in the pinned engine; use the Codewhale terminal for it",
        );
      }
      case "workspace.trust":
      case "workspace.untrust": {
        const trusted = input.action === "workspace.trust";
        const result = await access.adapter.setWorkspaceTrust(trusted);
        await this.store.putSettings(CACHE.trust, null).catch(() => undefined);
        return {
          action: input.action,
          target: result.workspace ?? input.target,
          ok: result.trusted === trusted,
          revision: null,
          message: result.message ?? `workspace trust set to ${result.trusted}`,
          detail:
            "Restart the engine to rebuild project MCP connections. Project hooks still need their separate digest approval.",
        };
      }
      default:
        throw new ExtensionError("UNSUPPORTED_ACTION", `unsupported action: ${input.action}`);
    }
  }

  async install(
    projectId: ProjectId,
    kind: "plugin" | "skill",
    source: string,
  ): Promise<ExtensionActionReceipt> {
    const access = this.requireEngine(projectId);
    const trimmed = source.trim();
    if (trimmed.length === 0 || trimmed.length > 4096) {
      throw new ExtensionError("INVALID_INPUT", "source is empty or too long");
    }
    if (kind === "plugin") {
      const result = await access.adapter.installPlugin(trimmed);
      return {
        action: "plugin.install",
        target: result.id || result.name,
        ok: true,
        revision: null,
        message: `Plugin installed: ${result.id || result.name}.`,
        detail: `${redactText(result.message)} It is installed disabled and untrusted until you review it.`,
      };
    }
    const result = await access.adapter.installSkill(trimmed);
    return {
      action: "skill.install",
      target: result.name,
      ok: true,
      revision: null,
      message: `Skill installed: ${result.name}.`,
      detail: redactText(result.message),
    };
  }

  // ------------------------------------------------------------------ readers

  private requireEngine(projectId: ProjectId): ExtensionsEngineAccess {
    const access = this.engine(projectId);
    if (!access) {
      throw new ExtensionError(
        "RUNTIME_UNAVAILABLE",
        "a live engine is required for this extension action; start the project studio first",
      );
    }
    return access;
  }

  private async readMcp(access: ExtensionsEngineAccess, projectId: ProjectId): Promise<McpView> {
    const readAt = this.now().toISOString();
    try {
      const [list, runtimeConfig] = await Promise.all([
        access.adapter.listMcpServers(),
        access.adapter.readRuntimeConfig().catch(() => null),
      ]);
      const view = this.mapMcp(list, readAt, projectId);
      view.configPath = redactPath(runtimeConfig?.mcpConfigPath ?? null);
      await this.store
        .putSettings(CACHE.mcp, { ...view, configPath: redactPath(view.configPath) })
        .catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<McpView>(CACHE.mcp);
      return cached
        ? { ...cached, source: "stored", error: `${describe(error)}; showing the last inventory` }
        : { ...emptyMcp(), error: describe(error) };
    }
  }

  private mapMcp(list: EngineMcpList, readAt: string, projectId: ProjectId): McpView {
    return {
      revision: list.revision,
      configPath: null,
      servers: list.servers.map((server) => this.mapMcpServer(server, projectId)),
      source: "live",
      error: null,
      readAt,
    };
  }

  private mapMcpServer(server: EngineMcpServer, projectId: ProjectId): McpServerView {
    const scope = scopeOf(server.origin);
    const health = this.health.get(`${projectId}:${server.name}`);
    const writable = server.writable;
    const actions: ExtensionActionView[] = [
      action("mcp.enable", "Enable", {
        available: writable && !server.enabled,
        reason: !writable
          ? "the runtime reports this project-scope entry as read-only; edit the project MCP file"
          : server.enabled
            ? "already enabled"
            : null,
        scope,
        sideEffect: "writes the global MCP configuration",
        needsRevision: true,
      }),
      action("mcp.disable", "Disable", {
        available: writable && server.enabled,
        reason: !writable
          ? "the runtime reports this project-scope entry as read-only; edit the project MCP file"
          : !server.enabled
            ? "already disabled"
            : null,
        scope,
        sideEffect: "writes the global MCP configuration",
        needsRevision: true,
      }),
      action("mcp.reconnect", "Check health", {
        available: server.enabled && writable,
        reason: !server.enabled
          ? "enable the server before checking a handshake"
          : !writable
            ? "health checks write the revision; this project entry is read-only"
            : null,
        scope,
        sideEffect: "starts this server process for one handshake; no model call",
        needsRevision: true,
      }),
      action("mcp.tools", "List tools", {
        available: server.enabled,
        reason: server.enabled ? null : "enable the server first",
        scope,
        sideEffect:
          "connects on demand and lists tool metadata; it does not add tools to model context",
      }),
      action("mcp.remove", "Remove", {
        available: writable,
        reason: writable ? null : "the runtime reports this project-scope entry as read-only",
        scope,
        sideEffect:
          "deletes this entry from the global MCP configuration; unrelated entries are preserved",
        destructive: true,
        needsRevision: true,
      }),
    ];
    return {
      name: server.name,
      origin: scope,
      writable,
      enabled: server.enabled,
      required: server.required,
      command: redactPath(server.command),
      argsCount: server.args.length,
      urlAuthority: urlAuthority(server.url),
      envKeys: server.envKeys,
      headerKeys: server.headerKeys,
      credentialConfigured: server.credentialConfigured,
      authRequired: server.authRequired,
      connected: server.connected,
      enabledTools: server.enabledTools,
      disabledTools: server.disabledTools,
      health: health
        ? {
            state: health.ok ? "connected" : "failed",
            error: health.error ? redactText(health.error) : null,
            checkedAt: health.checkedAt,
          }
        : {
            state: server.connected ? "connected" : "not_checked",
            error: null,
            checkedAt: null,
          },
      actions,
    };
  }

  private async readTrust(access: ExtensionsEngineAccess): Promise<WorkspaceTrustView> {
    try {
      const trust = await access.adapter.readWorkspaceTrust();
      const view: WorkspaceTrustView = {
        workspace: redactPath(trust.workspace),
        trusted: trust.trusted,
        configPath: null,
        note: trust.trusted
          ? "Project skills, commands, and MCP configuration are consulted for this workspace."
          : "Project skills and MCP configuration are not loaded until this workspace is trusted.",
        actions: [
          action("workspace.trust", "Trust this workspace", {
            available: !trust.trusted,
            reason: trust.trusted ? "already trusted" : null,
            scope: "project",
            sideEffect:
              "writes a trust record to the user config; project skills and MCP load on later turns, project hooks still need separate approval",
            needsRevision: false,
          }),
          action("workspace.untrust", "Revoke trust", {
            available: trust.trusted,
            reason: trust.trusted ? null : "not trusted",
            scope: "project",
            sideEffect:
              "removes the trust record; running MCP connections are not disconnected until the engine restarts",
            destructive: true,
            needsRevision: false,
          }),
        ],
      };
      await this.store.putSettings(CACHE.trust, view).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<WorkspaceTrustView>(CACHE.trust);
      return {
        ...(cached ?? {
          workspace: null,
          trusted: false,
          configPath: null,
          note: "Workspace trust could not be read.",
          actions: [],
        }),
        note: `${describe(error)}; trust state is not proven`,
      };
    }
  }

  private async readSkills(access: ExtensionsEngineAccess): Promise<SkillsView> {
    const readAt = this.now().toISOString();
    try {
      const result = await access.adapter.listSkills();
      const view: SkillsView = {
        directory: redactPath(result.directory),
        directories: result.directories.map((entry) => redactPath(entry) ?? entry),
        warnings: result.warnings.map((warning) => redactText(warning, 500)),
        skills: result.skills.map((skill) => this.mapSkill(skill)),
        source: "live",
        error: null,
        readAt,
      };
      await this.store.putSettings(CACHE.skills, view).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<SkillsView>(CACHE.skills);
      return cached
        ? { ...cached, source: "stored", error: `${describe(error)}; showing the last inventory` }
        : { ...emptySkills(), error: describe(error) };
    }
  }

  private mapSkill(skill: EngineSkill): SkillView {
    const path = skill.path ?? null;
    const scope: ExtensionScope = skill.bundled
      ? "builtin"
      : skill.source === "plugin"
        ? "plugin"
        : path && path.startsWith(HOME)
          ? "global"
          : path
            ? "project"
            : "unknown";
    return {
      name: skill.name,
      description: redactText(skill.description, 1000),
      source:
        skill.source === "plugin" ? "plugin" : skill.source === "native" ? "native" : "unknown",
      scope,
      path: redactPath(path),
      enabled: skill.enabled,
      bundled: skill.bundled,
      pluginId: skill.pluginId,
      invocation: skill.invocation,
      aliases: skill.aliases,
      audit: null,
      actions: [
        action("skill.enable", "Enable", {
          available: !skill.enabled,
          reason: skill.enabled ? "already enabled" : null,
          scope,
          sideEffect: "writes the engine's global skill activation state",
        }),
        action("skill.disable", "Disable", {
          available: skill.enabled,
          reason: skill.enabled ? null : "already disabled",
          scope,
          sideEffect: "writes the engine's global skill activation state",
          destructive: false,
        }),
        action("skill.trust", "Trust", {
          available: false,
          reason:
            "only Codewhale-managed installed skills can be trusted; bundled and project skills are governed by workspace trust",
          scope,
          sideEffect: "records a digest approval for an installed skill",
        }),
        action("skill.update", "Update", {
          available: false,
          reason: "update applies to Codewhale-managed installed skills, not this row",
          scope,
          sideEffect: "replaces an installed skill from its recorded source",
        }),
      ],
    };
  }

  private async readPlugins(access: ExtensionsEngineAccess): Promise<PluginsView> {
    const readAt = this.now().toISOString();
    try {
      const result = await access.adapter.listPlugins();
      const view: PluginsView = {
        plugins: result.plugins.map((plugin) => this.mapPlugin(plugin)),
        registryDiagnostics: result.registryDiagnostics.map((entry) => redactText(entry, 500)),
        validationClean: result.validationClean,
        source: "live",
        error: null,
        readAt,
      };
      await this.store.putSettings(CACHE.plugins, view).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<PluginsView>(CACHE.plugins);
      return cached
        ? { ...cached, source: "stored", error: `${describe(error)}; showing the last inventory` }
        : { ...emptyPlugins(), error: describe(error) };
    }
  }

  private mapPlugin(plugin: EnginePlugin): PluginView {
    const scope = scopeOf(plugin.scope);
    const approved = trustApproved(plugin.trustStatus);
    return {
      id: plugin.id,
      name: plugin.name,
      displayName: plugin.displayName,
      version: plugin.version,
      description: plugin.description ? redactText(plugin.description, 1000) : null,
      author: plugin.author ? redactText(plugin.author, 200) : null,
      scope,
      origin: plugin.origin,
      enabled: plugin.enabled,
      active: plugin.active,
      state: plugin.state,
      trustStatus: plugin.trustStatus,
      compatibility: plugin.compatibility,
      inventory: plugin.inventory,
      contentHash: plugin.contentHash,
      diagnostics: plugin.diagnostics.map((diagnostic) => ({
        level: diagnostic.level,
        code: diagnostic.code,
        message: redactText(diagnostic.message, 500),
      })),
      reviewAvailable: plugin.reviewTokenUsable,
      actions: [
        action("plugin.enable", "Enable", {
          available: approved && !plugin.enabled && scope !== "builtin",
          reason: !approved
            ? "requires capability review and trust first (terminal `/plugins trust`)"
            : plugin.enabled
              ? "already enabled"
              : scope === "builtin"
                ? "built-in plugins are managed by the engine build"
                : null,
          scope,
          sideEffect:
            "activates the bundle's skills, MCP servers, commands, and hooks for this engine",
        }),
        action("plugin.disable", "Disable", {
          available: plugin.enabled && scope !== "builtin",
          reason: plugin.enabled ? null : "already disabled",
          scope,
          sideEffect: "deactivates the bundle without deleting its files",
          destructive: false,
        }),
        action("plugin.revoke", "Revoke trust", {
          available: approved && scope !== "builtin",
          reason: approved ? null : "not trusted",
          scope,
          sideEffect: "revokes the digest approval and disables further activation",
          destructive: true,
        }),
        action("plugin.remove", "Remove", {
          available: scope !== "builtin",
          reason:
            scope === "builtin"
              ? "built-in plugins ship with the engine and cannot be removed here"
              : null,
          scope,
          sideEffect:
            "deletes the installed bundle directory; unrelated plugins and user files are preserved",
          destructive: true,
        }),
        action("plugin.trust", "Trust bundle", {
          available: false,
          reason:
            "the engine's HTTP detail redacts the review token; review and trust from the Codewhale terminal (/plugins trust)",
          scope,
          sideEffect: "records a capability review for this content and capability hash",
        }),
        action("plugin.update", "Update", {
          available: false,
          reason:
            "no verified desktop update route in this build; reinstall from the recorded source or use the Codewhale terminal",
          scope,
          sideEffect: "would replace the bundle from its recorded source",
        }),
      ],
    };
  }

  private async readHooks(access: ExtensionsEngineAccess): Promise<HooksView> {
    const readAt = this.now().toISOString();
    try {
      const result = await access.adapter.readHooks();
      const view: HooksView = {
        workspace: redactPath(result.workspace),
        enabled: result.enabled,
        hooks: result.hooks.map((hook) => this.mapHook(hook)),
        problems: result.problems.map((problem) => redactText(problem, 1000)),
        note: "Hooks are engine semantics: tool_call_before can deny, shell_env applies, and observers fire. Mona reads the set from the engine and never executes hook commands itself.",
        source: "live",
        error: null,
        readAt,
      };
      await this.store.putSettings(CACHE.hooks, view).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<HooksView>(CACHE.hooks);
      return cached
        ? { ...cached, source: "stored", error: `${describe(error)}; showing the last inventory` }
        : { ...emptyHooks(), error: describe(error) };
    }
  }

  private mapHook(hook: EngineHook): HookView {
    return {
      name: hook.name,
      event: hook.event,
      command: redactText(hook.command, 2000),
      background: hook.background,
      timeoutSecs: hook.timeoutSecs,
      source: scopeOf(hook.source),
    };
  }

  private async readInstructions(access: ExtensionsEngineAccess): Promise<InstructionsView> {
    const readAt = this.now().toISOString();
    try {
      const result = await access.adapter.readInstructions();
      const view: InstructionsView = {
        workspace: redactPath(result.workspace),
        sources: result.sources.map((source) => this.mapInstruction(source)),
        source: "live",
        error: null,
        readAt,
      };
      await this.store.putSettings(CACHE.instructions, view).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<InstructionsView>(CACHE.instructions);
      return cached
        ? { ...cached, source: "stored", error: `${describe(error)}; showing the last inventory` }
        : { ...emptyInstructions(), error: describe(error) };
    }
  }

  private mapInstruction(source: EngineInstructionSource): InstructionView {
    return {
      kind: source.kind === "project" || source.kind === "global" ? source.kind : "unknown",
      status: source.status,
      path: redactPath(source.path) ?? "",
      relativePath: source.relativePath,
      exists: source.exists,
      bytes: source.bytes,
      warning: source.warning ? redactText(source.warning, 500) : null,
    };
  }

  private async readCommands(access: ExtensionsEngineAccess): Promise<CommandsView> {
    const readAt = this.now().toISOString();
    try {
      const result: EngineCommands = await access.adapter.listCommands();
      const commands: CommandView[] = result.commands
        .filter((command) => !command.hidden)
        .map((command) => ({
          name: command.name,
          summary: redactText(command.summary, 500),
          kind: command.kind === "builtin" || command.kind === "user" ? command.kind : "unknown",
          binding:
            command.binding === "host" || command.binding === "prompt"
              ? command.binding
              : "unknown",
          aliases: command.aliases,
          hidden: command.hidden,
          scope: command.kind === "builtin" ? "builtin" : "global",
        }));
      const view: CommandsView = {
        commands,
        userCount: commands.filter((command) => command.kind === "user").length,
        source: "live",
        error: null,
        readAt,
      };
      await this.store.putSettings(CACHE.commands, view).catch(() => undefined);
      return view;
    } catch (error) {
      const cached = await this.cached<CommandsView>(CACHE.commands);
      return cached
        ? { ...cached, source: "stored", error: `${describe(error)}; showing the last inventory` }
        : { ...emptyCommands(), error: describe(error) };
    }
  }

  private async cached<T>(scope: string): Promise<T | null> {
    const stored = await this.store.getSettings(scope).catch(() => null);
    if (!stored || stored.value === null || typeof stored.value !== "object") return null;
    return stored.value as T;
  }
}

function capabilitiesFor(live: boolean) {
  return {
    mcpAdd: live,
    mcpAddNote: live
      ? "Adds a server to the user-global MCP configuration. Requires an absolute executable path or an http(s) URL, and the current revision."
      : "A live engine is required to add a server.",
    skillInstall: live,
    skillInstallNote: live
      ? "The engine installs skills from a remote source and requires explicit network approval. Local directories are discovered, not installed."
      : "A live engine is required to install a skill.",
    pluginInstall: live,
    pluginInstallNote: live
      ? "Local bundle directories and URLs are accepted. A new bundle is installed disabled and untrusted until reviewed."
      : "A live engine is required to install a plugin.",
    pluginTrust: false,
    pluginTrustNote:
      "The engine redacts the HTTP review token, so trust stays a terminal action: `/plugins trust` in Codewhale. Mona shows the exact review state.",
    selectiveDiscovery: "server" as const,
    selectiveDiscoveryNote:
      "The pinned engine exposes server-level enable/disable and on-demand tool listing, but no route to edit tool-level discovery budgets. Mona makes no token-savings claim.",
  };
}

function gapsFor(_live: boolean): ExtensionGap[] {
  return [
    {
      id: "mcp-project-readonly",
      category: "mcp",
      statement:
        "Project-scope MCP entries are read-only through the runtime; Mona shows them and their origin instead of rewriting the project file.",
      route:
        "Edit .codewhale/mcp.json in the project, then trust the workspace and restart the engine.",
    },
    {
      id: "plugin-trust-token",
      category: "plugins",
      statement:
        "The HTTP plugin detail redacts the review token, so capability trust cannot be completed from a desktop client.",
      route: "Open Codewhale and run /plugins trust <name>, then reload this screen.",
    },
    {
      id: "skill-install-network",
      category: "skills",
      statement:
        "Skill install takes a remote source and requires network approval; a local directory is discovered rather than installed.",
      route:
        "Approve the host in the engine network policy, then install from the verified source.",
    },
    {
      id: "hooks-mutation",
      category: "hooks",
      statement:
        "Hooks are read from engine semantics and are not editable here; project hooks also need a separate digest approval.",
      route:
        "Edit the hook configuration with the engine's own config tools; the engine enforces approval.",
    },
    {
      id: "selective-discovery",
      category: "mcp",
      statement:
        "No tool-level discovery budget is exposed; only whole servers can be enabled or disabled.",
      route: "Disable the server, or use enabled/disabled tool lists in the MCP configuration.",
    },
    {
      id: "commands-readonly",
      category: "commands",
      statement:
        "User commands are listed with their binding so a host command is never sent as a model prompt; editing them has no desktop route.",
      route: "Manage command templates with the engine's configuration files or terminal.",
    },
  ];
}

function emptyMcp(): McpView {
  return {
    revision: null,
    configPath: null,
    servers: [],
    source: "unavailable",
    error: "no MCP inventory has been read yet",
    readAt: new Date(0).toISOString(),
  };
}

function emptySkills(): SkillsView {
  return {
    directory: null,
    directories: [],
    warnings: [],
    skills: [],
    source: "unavailable",
    error: "no skill inventory has been read yet",
    readAt: new Date(0).toISOString(),
  };
}

function emptyPlugins(): PluginsView {
  return {
    plugins: [],
    registryDiagnostics: [],
    validationClean: null,
    source: "unavailable",
    error: "no plugin inventory has been read yet",
    readAt: new Date(0).toISOString(),
  };
}

function emptyHooks(): HooksView {
  return {
    workspace: null,
    enabled: false,
    hooks: [],
    problems: [],
    note: "Hooks are read from the engine and never executed by Mona.",
    source: "unavailable",
    error: "no hook inventory has been read yet",
    readAt: new Date(0).toISOString(),
  };
}

function emptyInstructions(): InstructionsView {
  return {
    workspace: null,
    sources: [],
    source: "unavailable",
    error: "no instruction inventory has been read yet",
    readAt: new Date(0).toISOString(),
  };
}

function emptyCommands(): CommandsView {
  return {
    commands: [],
    userCount: 0,
    source: "unavailable",
    error: "no command inventory has been read yet",
    readAt: new Date(0).toISOString(),
  };
}
