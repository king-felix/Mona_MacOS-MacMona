import type { CommandCatalogSnapshot } from "../contracts/commands";
import type { CommandExecutionEntry, CommandExecutionPlan } from "../contracts/command-execution";

/**
 * R04 — where each catalogued command actually goes.
 *
 * This is a curated execution plan, not a second catalog: every row of the
 * pinned engine surface has exactly one entry, and a missing or extra entry is
 * a build error. The plan says what Mona can honestly do with the command:
 *
 *   native      Mona performs the operation through a typed main-process API.
 *   view        Mona opens the existing surface that owns the operation. It
 *               does not perform it, and the receipt says so.
 *   terminal    Only the Codewhale TUI/CLI implements it. Mona may prefill a
 *               fixed invocation into its terminal pane; it never runs it.
 *   unavailable This engine version exposes no route at all.
 *
 * The terminal invocations below are fixed strings with shell words only. No
 * typed argument is ever interpolated into them, so a command line cannot
 * become shell input.
 */

const TUI = "codewhale";

function native(
  entry: Extract<CommandExecutionEntry, { kind: "native" }>["operation"],
  confirm: boolean,
  note: string,
): CommandExecutionEntry {
  return { kind: "native", operation: entry, confirm, note };
}

function view(
  screen: Extract<CommandExecutionEntry, { kind: "view" }>["screen"],
  note: string,
  settingsTab?: string,
): CommandExecutionEntry {
  return { kind: "view", screen, settingsTab, note };
}

function terminal(invocation: string, note: string): CommandExecutionEntry {
  return { kind: "terminal", invocation, note };
}

function tui(name: string, note?: string): CommandExecutionEntry {
  return terminal(
    TUI,
    note ?? `Launching the Codewhale TUI opens a real session; Mona does not run /${name} for you.`,
  );
}

function unavailable(note: string): CommandExecutionEntry {
  return { kind: "unavailable", note };
}

const PLAN: Record<string, CommandExecutionEntry> = {
  // ---------------------------------------------------------- native (5)
  new: native(
    "new",
    false,
    "Starts a new conversation: a fresh engine thread and a new local generation. Earlier threads, their events, drafts, usage and attempts stay.",
  ),
  compact: native(
    "compact",
    true,
    "Compacts the current conversation in the engine. It may call the model, so Mona asks first.",
  ),
  retry: native(
    "retry",
    true,
    "Asks the engine to retry the current conversation's last turn. It may spend, so Mona asks first.",
  ),
  rename: native(
    "rename",
    false,
    "Retitles the current conversation through the engine and stores the same title locally.",
  ),
  fork: native(
    "fork",
    false,
    "Forks the current engine thread into a sibling conversation and makes it the current thread. The source thread is untouched.",
  ),

  // ------------------------------------------------------------ views (20)
  context: view(
    "studio",
    "Context is read and composed in the Studio inspector. Mona does not render the engine's provider-request preview because 0.10.2 exposes none.",
  ),
  cost: view(
    "cost",
    "The Cost lens owns thread and project usage, with unknown and partial totals kept distinct.",
  ),
  tokens: view("cost", "Token totals and their provenance live in the Cost lens."),
  diff: view("changes", "The Changes screen owns the workspace diff, receipts and restore points."),
  restore: view(
    "changes",
    "Restore points and one-file revert live in Changes. Whole-workspace restore is not surfaced by Mona yet (MONA-CAP-063).",
  ),
  task: view("board", "The Work board owns tasks, dispatch and acceptance criteria."),
  goal: view("agents", "Agent goals are set and inspected in the Agents screen."),
  fleet: view("agents", "Fleet runs, workers and stop controls live in the Agents screen."),
  subagents: view("agents", "Sub-agent runs and receipts live in the Agents screen."),
  mcp: view(
    "settings",
    "MCP servers, health and tools live in Settings › Extensions.",
    "extensions",
  ),
  skills: view(
    "settings",
    "Skills, their detail and enablement live in Settings › Extensions.",
    "extensions",
  ),
  skill: view(
    "settings",
    "Skills, their detail and enablement live in Settings › Extensions.",
    "extensions",
  ),
  plugin: view(
    "settings",
    "Plugins and their reviewed state live in Settings › Extensions.",
    "extensions",
  ),
  hooks: view(
    "settings",
    "Hooks are read-only in Settings › Extensions; editing is a terminal action.",
    "extensions",
  ),
  trust: view(
    "settings",
    "Workspace trust is shown in Settings › Extensions. Changing it is a permission change and stays an explicit action there.",
    "extensions",
  ),
  config: view(
    "settings",
    "Settings › Providers & route shows the effective route, engine selection and diagnostics. Arbitrary config keys remain a terminal action.",
    "route",
  ),
  model: view(
    "settings",
    "The saved route and live model catalog live in Settings › Providers & route.",
    "route",
  ),
  models: view(
    "settings",
    "The live model catalog lives in Settings › Providers & route.",
    "route",
  ),
  provider: view(
    "settings",
    "Provider, route and credential class live in Settings › Providers & route. Credential values are never rendered.",
    "route",
  ),

  // --------------------------------------------------------- terminal (79)
  // Runtime-API rows whose operation Mona deliberately leaves to the TUI/CLI.
  sessions: terminal("codewhale sessions", "Saved sessions are listed by the CLI, not by Mona."),
  resume: terminal(
    "codewhale sessions",
    "Mona will not resume a saved session whose workspace it cannot prove, so it points at the CLI listing here.",
  ),
  receipts: terminal(
    "codewhale receipts --last --format json",
    "The engine's action receipts are printed by the CLI. Mona's own change receipts live in Changes.",
  ),
  undo: terminal(
    TUI,
    "Conversation rewind forks a thread and belongs to the TUI. File restore is in Changes.",
  ),
  constitution: tui(
    "constitution",
    "Constitution status and preview have /v1 routes, but ratify/edit are TUI-local; Mona has no surface for either yet.",
  ),
  jobs: tui("jobs", "Background jobs and their stdin/poll/cancel controls are TUI-local."),
  lsp: tui("lsp", "Language-server control is TUI-local."),
  automation: tui("automation", "Scheduled automations and their run history are TUI-local."),
  voice: terminal(
    "codewhale speech",
    "Speech synthesis is the CLI's. Mona has no voice capture, so nothing is recorded or sent.",
  ),
  voicecontrol: tui(
    "voicecontrol",
    "Voice control is a TUI feature; Mona does not enable a microphone.",
  ),
  voicesend: tui("voicesend", "Sending dictated audio is a TUI feature; Mona does not send it."),

  // Account and setup.
  auth: terminal("codewhale auth", "OAuth account flows belong to the CLI."),
  login: terminal("codewhale login", "Account login belongs to the CLI."),
  logout: terminal("codewhale logout", "Account logout belongs to the CLI."),
  connect: terminal("codewhale login", "Connecting an account is the CLI's login flow."),
  disconnect: terminal("codewhale logout", "Disconnecting an account is the CLI's logout flow."),
  balance: terminal("codewhale account", "Account balance is reported by the CLI."),
  setup: terminal("codewhale setup", "First-run setup is the CLI's guided flow."),
  init: terminal("codewhale init", "Workspace initialisation is the CLI's."),
  update: terminal(
    "codewhale update",
    "Engine updates are the CLI's; Mona never upgrades the pinned engine silently.",
  ),

  // Session and conversation state.
  branch: tui("branch"),
  cache: tui("cache"),
  export: tui("export"),
  load: tui("load"),
  relay: tui("relay"),
  save: tui("save"),
  share: tui("share"),
  structcopy: tui("structcopy"),
  tree: tui("tree"),

  // Thread state and context.
  advisor: tui("advisor"),
  agent: tui("agent"),
  anchor: tui("anchor"),
  auto: tui("auto"),
  clear: tui("clear"),
  edit: tui("edit"),
  effort: tui("effort"),
  mode: tui("mode"),
  overview: tui("overview"),
  preview_request: tui("preview-request"),
  purge: tui("purge"),
  queue: tui("queue"),
  rlm: tui("rlm"),
  stash: tui("stash"),
  status: tui("status"),
  system: tui("system"),
  tools: tui("tools"),
  turn: tui("turn"),

  // Engine and workspace state.
  change: tui("change"),
  feedback: tui("feedback"),
  hf: tui("hf"),
  memory: tui("memory"),
  modeldb: tui("modeldb"),
  network: tui("network"),
  permissions: tui("permissions"),
  profile: tui("profile"),
  router: tui("router"),
  translate: tui("translate"),
  workspace: tui("workspace"),

  // TUI chrome. Mona's own chrome is not the TUI's chrome.
  color: tui(
    "color",
    "The TUI palette is not Mona's. Appearance in Settings controls Mona's own theme.",
  ),
  copy: tui("copy", "TUI clipboard capture is not Mona's composer."),
  exit: tui("exit", "Mona quits from its own menu (Command-Q); the TUI's exit is a TUI command."),
  fullscreen: tui(
    "fullscreen",
    "The TUI's fullscreen is not Mona's window. Immersive Studio is R05.",
  ),
  help: terminal("codewhale help", "The CLI prints its own command help."),
  home: tui("home"),
  hotbar: tui("hotbar"),
  import_claude: tui("import-claude"),
  inline: tui("inline"),
  links: tui("links"),
  note: tui("note"),
  pet: tui("pet"),
  pin: tui("pin"),
  review: terminal(
    "codewhale review",
    "Code review is the CLI's command; Mona's review screens are separate.",
  ),
  rc: terminal("codewhale rc", "Remote control is the CLI's."),
  settings: tui("settings", "The TUI has its own settings surface; Mona's is Settings."),
  statusline: tui("statusline"),
  theme: tui(
    "theme",
    "The TUI theme is not Mona's. Appearance in Settings controls Mona's own theme.",
  ),
  title: tui("title"),
  transcript: tui("transcript"),
  verbose: tui("verbose"),
  workbar: tui("workbar"),

  // ------------------------------------------------------ unavailable (5)
  attach: unavailable("Mona's composer does not attach media (RV-13)."),
  lane: unavailable("0.10.2 exposes no /v1 lane route; the CLI reports it as a blocked gap."),
  remote_env: unavailable("Remote environments are unavailable on this engine version."),
  workflow: unavailable(
    "Checked-in workflows run through a Lane Runtime and have no /v1 route on 0.10.2.",
  ),
  workflows: unavailable(
    "Checked-in workflows run through a Lane Runtime and have no /v1 route on 0.10.2.",
  ),
};

/** TUI names contain hyphens; the table above uses the canonical engine spelling. */
function canonicalKey(name: string): string {
  return name.replace(/-/g, "_");
}

/**
 * Validate the plan against the catalog. A row without an entry, an entry
 * without a row, or a route that contradicts the catalog's own support claim is
 * a build error: the UI must not repeat an execution promise nobody checked.
 */
export function buildCommandExecutionPlan(snapshot: CommandCatalogSnapshot): CommandExecutionPlan {
  const names = new Set(snapshot.commands.map((command) => command.name));
  const planKeys = new Set(Object.keys(PLAN));
  const missing: string[] = [];
  const extra: string[] = [];
  for (const name of names) {
    if (!planKeys.has(canonicalKey(name))) missing.push(name);
  }
  for (const key of planKeys) {
    if (![...names].some((name) => canonicalKey(name) === key)) extra.push(key);
  }
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `commands without an execution route: ${missing.join(", ")}` : null,
        extra.length > 0 ? `execution routes without a command: ${extra.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const plan: CommandExecutionPlan = {};
  for (const command of snapshot.commands) {
    const entry = PLAN[canonicalKey(command.name)]!;
    const support = command.annotation.support;
    if (entry.kind === "native" && support !== "runtime-api") {
      throw new Error(`/${command.name} is marked native but the catalog says ${support}`);
    }
    if (entry.kind === "native" && entry.operation !== command.name) {
      throw new Error(`/${command.name} claims the ${entry.operation} operation`);
    }
    if (entry.kind === "view" && support !== "runtime-api") {
      throw new Error(`/${command.name} is marked as a view but the catalog says ${support}`);
    }
    if (entry.kind === "terminal" && support === "unavailable") {
      throw new Error(`/${command.name} is unavailable but claims a terminal route`);
    }
    if (entry.kind === "unavailable" && support !== "unavailable") {
      throw new Error(`/${command.name} is marked unavailable but the catalog says ${support}`);
    }
    if (
      entry.kind === "terminal" &&
      !/^codewhale(?: (?:[a-z0-9][a-z0-9-]*|--[a-z][a-z0-9-]*)){0,6}$/.test(entry.invocation)
    ) {
      throw new Error(`/${command.name} has an unsafe terminal invocation: ${entry.invocation}`);
    }
    plan[command.name] = entry;
  }
  return plan;
}

/** Every spelling (canonical name and alias) the engine accepts. */
export function planForName(
  plan: CommandExecutionPlan,
  command: string,
): CommandExecutionEntry | null {
  return plan[command] ?? null;
}
