#!/usr/bin/env node
// P17 live smoke: inspect MCP servers, skills, plugins, hooks, instructions,
// and commands from the pinned engine; configure a harmless local MCP server,
// observe its health, list its tools on demand, disable it, refuse a stale
// revision, and remove it while preserving unrelated configuration.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = resolve(new URL("..", import.meta.url).pathname);
const { CodewhaleAdapter } = require(join(ROOT, "dist/main/main/engine/adapter.js"));
const { MemorySubmissionStore } = require(join(ROOT, "dist/main/main/engine/submission-store.js"));
const { ExtensionWorkbench } = require(join(ROOT, "dist/main/main/work/extensions.js"));
const { StateStore } = require(join(ROOT, "dist/main/main/state/store.js"));

const base = await mkdtemp(join(tmpdir(), "mona-p17-smoke-"));
const home = join(base, "home");
const codeHome = join(home, ".codewhale");
const workspace = join(base, "ws");
await mkdir(codeHome, { recursive: true });
await mkdir(join(workspace, ".codewhale"), { recursive: true });
await mkdir(join(base, "supervisor"), { recursive: true });
await mkdir(join(base, "product"), { recursive: true });
const SECRET = ["sk", "smoke", `fixture${Date.now()}`].join("-");
await writeFile(join(codeHome, "config.toml"), 'provider = "deepseek"\nmodel = "deepseek-flash"\n');
// Unrelated global server, a secret-bearing disabled entry, and an unknown key
// that the engine must preserve across add/remove operations.
const mcpPath = join(codeHome, "mcp.json");
await writeFile(
  mcpPath,
  JSON.stringify(
    {
      schema_version: 1,
      mona_unknown_key: { keep: true },
      servers: {
        unrelated: {
          command: "/bin/cat",
          args: [],
          env: {},
          url: null,
          disabled: true,
          enabled: false,
          required: false,
          enabled_tools: [],
          disabled_tools: [],
        },
        "secret-server": {
          command: "/bin/cat",
          args: [],
          env: { MONA_FIXTURE_TOKEN: SECRET },
          url: null,
          disabled: true,
          enabled: false,
          required: false,
          enabled_tools: [],
          disabled_tools: [],
        },
      },
    },
    null,
    2,
  ),
);
// Project-scope MCP entry is read-only through the runtime.
const projectMcpPath = join(workspace, ".codewhale", "mcp.json");
await writeFile(
  projectMcpPath,
  JSON.stringify({ servers: { "project-entry": { command: "/bin/cat", enabled: true } } }, null, 2),
);
await writeFile(join(workspace, "AGENTS.md"), "# Fixture instructions\nInert project context.\n");

const report = {
  schema_version: 1,
  label: "P17 — tools and extensions",
  captured_at: new Date().toISOString(),
  ok: false,
  checks: {},
  observations: {},
  error: null,
};
const check = (name, value, detail = null) => {
  report.checks[name] = { ok: value === true, ...(detail ? { detail } : {}) };
  if (value !== true) report.first_failure ??= name;
};

const adapter = new CodewhaleAdapter({ store: new MemorySubmissionStore() });
const store = await StateStore.open({
  dbPath: join(base, "product", "mona.sqlite"),
  backupDir: join(base, "product", "backups"),
  artifactRoot: join(base, "product", "artifacts"),
});
let handle = null;
try {
  handle = await adapter.startOwnedRuntime({
    workspace,
    stateDir: join(base, "supervisor"),
    logDir: join(base, "supervisor", "logs"),
    env: { HOME: home, CODEWHALE_HOME: codeHome, DEEPSEEK_API_KEY: SECRET, NO_COLOR: "1" },
    startupTimeoutMs: 45_000,
  });
  const bench = new ExtensionWorkbench({
    store,
    engine: () => ({ adapter, workspace }),
  });
  const projectId = "prj_0000000000000001";

  const initial = await bench.snapshot(projectId);
  report.observations.initial = {
    runtime: initial.runtime,
    mcp: initial.mcp.servers.map((server) => ({
      name: server.name,
      origin: server.origin,
      writable: server.writable,
      enabled: server.enabled,
      credentialConfigured: server.credentialConfigured,
      envKeys: server.envKeys,
      actions: server.actions.map((action) => [action.id, action.available, action.reason]),
    })),
    skills: initial.skills.skills.length,
    plugins: initial.plugins.plugins.map((plugin) => ({
      name: plugin.name,
      scope: plugin.scope,
      trust: plugin.trustStatus,
    })),
    hooks: initial.hooks,
    instructions: initial.instructions.sources.filter((source) => source.exists),
    commands: initial.commands.userCount,
    capabilities: initial.capabilities,
    gaps: initial.gaps.map((gap) => gap.id),
  };
  check("live inventory", initial.runtime === "connected");
  check(
    "preseeded secret entry is visible without its value",
    initial.mcp.servers.some((server) => server.name === "secret-server"),
  );
  check("inventory contains no secret value", !JSON.stringify(initial).includes(SECRET));
  check("skills are inventoried", initial.skills.skills.length > 0);
  check("plugins are inventoried with scope", initial.plugins.plugins.length > 0);
  check(
    "instructions report the project file",
    initial.instructions.sources.some(
      (source) => source.relativePath === "AGENTS.md" && source.exists,
    ),
  );

  const trusted = await bench.act({
    projectId,
    action: "workspace.trust",
    target: "workspace",
  });
  check("workspace trust set", trusted.ok === true);
  const afterTrust = await bench.snapshot(projectId);
  check("project trust is reflected", afterTrust.workspaceTrust.trusted === true);
  const projectEntry = afterTrust.mcp.servers.find((server) => server.name === "project-entry");
  check(
    "project MCP entry is read-only after trust",
    Boolean(projectEntry && !projectEntry.writable),
  );
  check("project entry is labeled with project scope", projectEntry?.origin === "project");

  const revision = afterTrust.mcp.revision;
  check("MCP revision is present", typeof revision === "string" && revision.length > 0);
  const added = await bench.addMcp(projectId, {
    expectedRevision: revision,
    name: "mona-fixture",
    command: process.execPath,
    args: [join(ROOT, "test", "fixtures", "mcp", "echo-server.mjs")],
    url: null,
    transport: null,
    enabled: true,
  });
  report.observations.mcp_add = added;
  check("local test server added", added.ok === true);

  const afterAdd = await bench.snapshot(projectId);
  const fixture = afterAdd.mcp.servers.find((server) => server.name === "mona-fixture");
  check("added server appears with global scope", Boolean(fixture && fixture.origin === "global"));

  const stale = await bench
    .addMcp(projectId, {
      expectedRevision: revision,
      name: "stale-entry",
      command: "/bin/cat",
      args: [],
      url: null,
      transport: null,
      enabled: false,
    })
    .then(() => null)
    .catch((error) => error);
  report.observations.stale_add = stale?.message ?? null;
  check(
    "stale MCP revision refused",
    Boolean(stale && /changed|revision|If-Match/i.test(stale.message)),
  );

  const health = await bench.act({
    projectId,
    action: "mcp.reconnect",
    target: "mona-fixture",
    expectedRevision: afterAdd.mcp.revision,
  });
  report.observations.health = health;
  check("local test server handshake succeeded", health.ok === true);

  const tools = await bench.mcpTools(projectId, "mona-fixture");
  report.observations.tools = tools.tools.map((tool) => ({
    server: tool.server,
    name: tool.name,
    prefixed: tool.prefixedName,
    schema: tool.inputSchema,
  }));
  check(
    "tools are listed on demand",
    tools.tools.some((tool) => tool.name === "echo"),
  );
  check("tool listing has no error", tools.error === null);

  const disabled = await bench.act({
    projectId,
    action: "mcp.disable",
    target: "mona-fixture",
    expectedRevision: afterAdd.mcp.revision,
  });
  check("local test server disabled", disabled.ok === true);
  const afterDisable = await bench.snapshot(projectId);
  const disabledServer = afterDisable.mcp.servers.find((server) => server.name === "mona-fixture");
  const projectServer = afterDisable.mcp.servers.find((server) => server.name === "project-entry");
  check("disabled state is observed", disabledServer?.enabled === false);
  check("disable touched only the intended server", projectServer?.enabled === true);

  const missing = await bench.addMcp(projectId, {
    expectedRevision: afterDisable.mcp.revision,
    name: "missing-fixture",
    command: "/nonexistent/mona-fixture",
    args: [],
    url: null,
    transport: null,
    enabled: true,
  });
  check("missing executable entry can be configured", missing.ok === true);
  const afterMissing = await bench.snapshot(projectId);
  const missingHealth = await bench.act({
    projectId,
    action: "mcp.reconnect",
    target: "missing-fixture",
    expectedRevision: afterMissing.mcp.revision,
  });
  report.observations.missing_health = missingHealth;
  check(
    "missing executable is actionable",
    missingHealth.ok === false &&
      /no such file|not found|spawn failed/i.test(missingHealth.message),
  );

  const beforeRemove = await bench.snapshot(projectId);
  await bench.act({
    projectId,
    action: "mcp.remove",
    target: "missing-fixture",
    expectedRevision: beforeRemove.mcp.revision,
  });
  const afterFirstRemove = await bench.snapshot(projectId);
  await bench.act({
    projectId,
    action: "mcp.remove",
    target: "mona-fixture",
    expectedRevision: afterFirstRemove.mcp.revision,
  });
  const afterRemove = await bench.snapshot(projectId);
  const globalConfig = JSON.parse(await readFile(mcpPath, "utf8"));
  report.observations.global_config_after_remove = {
    keys: Object.keys(globalConfig),
    servers: Object.keys(globalConfig.servers ?? {}),
    unknown: globalConfig.mona_unknown_key,
  };
  check(
    "removed fixture is gone from the view",
    !afterRemove.mcp.servers.some((server) => server.name === "mona-fixture"),
  );
  check("unrelated server preserved", Boolean(globalConfig.servers?.unrelated));
  check("secret-bearing server preserved", Boolean(globalConfig.servers?.["secret-server"]));
  check("unknown configuration key preserved", globalConfig.mona_unknown_key?.keep === true);
  const projectText = await readFile(projectMcpPath, "utf8");
  check("project MCP file untouched", projectText.includes("project-entry"));

  const skillName = "debug";
  const beforeSkill = afterRemove.skills.skills.find((skill) => skill.name === skillName);
  check("skill fixture is present", Boolean(beforeSkill));
  await bench.act({ projectId, action: "skill.disable", target: skillName });
  const skillOff = await bench.snapshot(projectId);
  check(
    "skill disabled in engine state",
    skillOff.skills.skills.find((skill) => skill.name === skillName)?.enabled === false,
  );
  await bench.act({ projectId, action: "skill.enable", target: skillName });
  const skillOn = await bench.snapshot(projectId);
  check(
    "skill re-enabled",
    skillOn.skills.skills.find((skill) => skill.name === skillName)?.enabled === true,
  );

  const installed = await bench.install(
    projectId,
    "plugin",
    join(ROOT, "test", "fixtures", "plugin"),
  );
  report.observations.plugin_install = installed;
  check("plugin fixture installed", installed.ok === true);
  const afterInstall = await bench.snapshot(projectId);
  const plugin = afterInstall.plugins.plugins.find((entry) => entry.name === "mona-fixture-plugin");
  report.observations.installed_plugin = plugin ?? null;
  check(
    "plugin installed disabled and untrusted",
    Boolean(plugin && !plugin.enabled && plugin.trustStatus !== "approved"),
  );
  check("plugin inventory is visible", plugin?.inventory.skills === 1);
  check(
    "plugin enable is refused before review",
    plugin?.actions.find((action) => action.id === "plugin.enable")?.available === false,
  );
  const removed = await bench.act({
    projectId,
    action: "plugin.remove",
    target: plugin?.id ?? "missing",
  });
  check("plugin removed", removed.ok === true);
  const afterPluginRemove = await bench.snapshot(projectId);
  check(
    "plugin gone after removal",
    !afterPluginRemove.plugins.plugins.some((entry) => entry.name === "mona-fixture-plugin"),
  );

  report.observations.hooks = afterPluginRemove.hooks;
  report.observations.instructions = afterPluginRemove.instructions.sources.filter(
    (source) => source.exists,
  );
  const hostCommands = afterPluginRemove.commands.commands.filter(
    (command) => command.binding === "host",
  );
  report.observations.host_commands = hostCommands.slice(0, 5).map((command) => command.name);
  check("host commands are labeled as host-bound", hostCommands.length > 0);
  check("gaps are stated, not hidden", afterPluginRemove.gaps.length > 0);
  check("entire report contains no fixture secret", !JSON.stringify(report).includes(SECRET));
  report.ok = Object.values(report.checks).every((entry) => entry.ok);
} catch (error) {
  report.error = String(error?.stack ?? error);
} finally {
  if (handle) {
    try {
      await adapter.shutdownOwnedRuntime(handle);
    } catch (error) {
      report.stop_error = String(error);
    }
  }
  await store.close?.().catch?.(() => undefined);
}
const outDir = join(ROOT, "docs", "evidence", "macos", "artifacts");
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "p17-extensions-smoke.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify(
    { ok: report.ok, checks: Object.keys(report.checks).length, error: report.error },
    null,
    2,
  ),
);
process.exit(report.ok === true ? 0 : 1);
