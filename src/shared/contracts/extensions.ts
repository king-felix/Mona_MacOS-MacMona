import { z } from "zod";

/**
 * P17 — MCP servers, skills, plugins, hooks, rules, and instructions.
 *
 * Every row is a projection of engine-reported metadata. Secrets are never
 * represented: environment variables appear as key names, headers as key names,
 * URLs as scheme + host, and commands are redacted when they look credential
 * shaped. Actions state their scope and side effect before they are invoked.
 */

export type ExtensionScope = "builtin" | "global" | "project" | "plugin" | "user" | "unknown";

export const ExtensionActionIdSchema = z.enum([
  "mcp.add",
  "mcp.enable",
  "mcp.disable",
  "mcp.reconnect",
  "mcp.remove",
  "mcp.tools",
  "skill.enable",
  "skill.disable",
  "skill.install",
  "skill.trust",
  "skill.update",
  "plugin.enable",
  "plugin.disable",
  "plugin.trust",
  "plugin.revoke",
  "plugin.update",
  "plugin.remove",
  "plugin.install",
  "workspace.trust",
  "workspace.untrust",
]);
export type ExtensionActionId = z.infer<typeof ExtensionActionIdSchema>;

export interface ExtensionActionView {
  id: ExtensionActionId;
  label: string;
  available: boolean;
  /** Plain-language reason when unavailable; never a guessed success. */
  reason: string | null;
  scope: ExtensionScope;
  /** What the action writes or starts, stated before invocation. */
  sideEffect: string;
  destructive: boolean;
  /** True when the action needs a fresh engine revision (If-Match). */
  needsRevision: boolean;
}

export interface McpHealthView {
  state: "connected" | "failed" | "not_checked";
  error: string | null;
  checkedAt: string | null;
}

export interface McpServerView {
  name: string;
  origin: ExtensionScope;
  writable: boolean;
  enabled: boolean;
  required: boolean;
  /** Absolute executable path or null for URL transports. */
  command: string | null;
  argsCount: number;
  /** Scheme + host only for URL transports. */
  urlAuthority: string | null;
  envKeys: string[];
  headerKeys: string[];
  credentialConfigured: boolean;
  authRequired: boolean;
  connected: boolean;
  enabledTools: string[];
  disabledTools: string[];
  health: McpHealthView;
  actions: ExtensionActionView[];
}

export interface McpToolView {
  server: string;
  name: string;
  prefixedName: string;
  description: string;
  /** JSON schema as reported; rendered only on request. */
  inputSchema: unknown;
}

export interface McpView {
  revision: string | null;
  configPath: string | null;
  servers: McpServerView[];
  source: "live" | "stored" | "unavailable";
  error: string | null;
  readAt: string;
}

export interface SkillsView {
  directory: string | null;
  directories: string[];
  warnings: string[];
  skills: SkillView[];
  source: "live" | "stored" | "unavailable";
  error: string | null;
  readAt: string;
}

export interface SkillView {
  name: string;
  description: string;
  source: "native" | "plugin" | "unknown";
  scope: ExtensionScope;
  /** Home-redacted path; null when the engine reported none. */
  path: string | null;
  enabled: boolean;
  bundled: boolean;
  pluginId: string | null;
  invocation: string | null;
  aliases: string[];
  audit: string | null;
  actions: ExtensionActionView[];
}

export interface PluginInventoryView {
  skills: number;
  mcpServers: number;
  commands: number;
  agents: number;
  hooks: number;
  lsp: number;
  lifecycleMutation: boolean;
  networkHosts: string[];
  filesystemRoots: string[];
}

export interface PluginView {
  id: string;
  name: string;
  displayName: string | null;
  version: string | null;
  description: string | null;
  author: string | null;
  scope: ExtensionScope;
  origin: string;
  enabled: boolean;
  active: boolean;
  state: string;
  trustStatus: string;
  compatibility: string;
  inventory: PluginInventoryView;
  contentHash: string | null;
  diagnostics: Array<{ level: string; code: string; message: string }>;
  /** Review is available only where the engine provides a usable token. */
  reviewAvailable: boolean;
  actions: ExtensionActionView[];
}

export interface PluginsView {
  plugins: PluginView[];
  registryDiagnostics: string[];
  validationClean: boolean | null;
  source: "live" | "stored" | "unavailable";
  error: string | null;
  readAt: string;
}

export interface HookView {
  name: string;
  event: string;
  command: string;
  background: boolean;
  timeoutSecs: number | null;
  source: ExtensionScope;
}

export interface HooksView {
  workspace: string | null;
  enabled: boolean;
  hooks: HookView[];
  problems: string[];
  /** Hooks are engine-semantics only; Mona never executes them. */
  note: string;
  source: "live" | "stored" | "unavailable";
  error: string | null;
  readAt: string;
}

export interface InstructionView {
  kind: "project" | "global" | "unknown";
  status: string;
  path: string;
  relativePath: string | null;
  exists: boolean;
  bytes: number | null;
  warning: string | null;
}

export interface InstructionsView {
  workspace: string | null;
  sources: InstructionView[];
  source: "live" | "stored" | "unavailable";
  error: string | null;
  readAt: string;
}

export interface CommandView {
  name: string;
  summary: string;
  kind: "builtin" | "user" | "unknown";
  binding: "host" | "prompt" | "unknown";
  aliases: string[];
  hidden: boolean;
  scope: ExtensionScope;
}

export interface CommandsView {
  commands: CommandView[];
  userCount: number;
  source: "live" | "stored" | "unavailable";
  error: string | null;
  readAt: string;
}

export interface WorkspaceTrustView {
  workspace: string | null;
  trusted: boolean;
  configPath: string | null;
  note: string;
  actions: ExtensionActionView[];
}

export interface ExtensionCapabilities {
  mcpAdd: boolean;
  mcpAddNote: string;
  skillInstall: boolean;
  skillInstallNote: string;
  pluginInstall: boolean;
  pluginInstallNote: string;
  pluginTrust: boolean;
  pluginTrustNote: string;
  /** What the engine lets a client narrow; no token-savings claim is made. */
  selectiveDiscovery: "server" | "tool" | "none";
  selectiveDiscoveryNote: string;
}

export interface ExtensionGap {
  id: string;
  category: "mcp" | "skills" | "plugins" | "hooks" | "instructions" | "commands";
  statement: string;
  /** The verified route that still reaches the capability. */
  route: string;
}

export interface ExtensionsSnapshot {
  projectId: string;
  runtime: "connected" | "unavailable";
  runtimeNote: string;
  workspaceTrust: WorkspaceTrustView;
  mcp: McpView;
  skills: SkillsView;
  plugins: PluginsView;
  hooks: HooksView;
  instructions: InstructionsView;
  commands: CommandsView;
  capabilities: ExtensionCapabilities;
  gaps: ExtensionGap[];
}

export interface ExtensionActionReceipt {
  action: ExtensionActionId;
  target: string;
  ok: boolean;
  revision: string | null;
  message: string;
  /** Honest side-effect summary of what the engine reported. */
  detail: string | null;
}

export interface McpAddInput {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  transport: "sse" | null;
  enabled: boolean;
}
