import { describe, expect, it, vi } from "vitest";
import type { EngineMcpList, EnginePlugin, EngineSettingsAdapter } from "../src/main/engine/types";
import { ExtensionWorkbench } from "../src/main/work/extensions";
import { openTestStore } from "./helpers/state";

const projectId = "prj_0000000000000001" as never;
const SECRET = ["sk", "fixture", "abcdef123456"].join("-");

function mcpList(): EngineMcpList {
  return {
    revision: "mcp-v1-abc123",
    servers: [
      {
        name: "fixture",
        origin: "global",
        writable: true,
        enabled: true,
        required: false,
        command: `${process.env.HOME ?? "/Users/test"}/.local/bin/mcp-fixture`,
        args: ["--stdio", `--token=${SECRET}`],
        envKeys: ["FIXTURE_TOKEN"],
        url: null,
        transport: null,
        enabledTools: [],
        disabledTools: [],
        headerKeys: [],
        credentialConfigured: true,
        authRequired: false,
        connected: true,
      },
      {
        name: "project-one",
        origin: "project",
        writable: false,
        enabled: true,
        required: false,
        command: "/usr/bin/project-mcp",
        args: [],
        envKeys: [],
        url: "https://user:pass@mcp.example.com/stream?key=abc",
        transport: "sse",
        enabledTools: [],
        disabledTools: [],
        headerKeys: ["Authorization"],
        credentialConfigured: true,
        authRequired: true,
        connected: false,
      },
    ],
  };
}

function plugin(overrides: Partial<EnginePlugin> = {}): EnginePlugin {
  return {
    id: "user/hash/fixture-plugin",
    name: "fixture-plugin",
    displayName: "Fixture plugin",
    version: "0.0.1",
    description: "Fixture only.",
    author: "Mona tests",
    scope: "user",
    origin: "codewhale-home",
    enabled: false,
    active: false,
    state: "disabled",
    trustStatus: "not-reviewed",
    compatibility: "full",
    inventory: {
      skills: 1,
      mcpServers: 0,
      commands: 0,
      agents: 0,
      hooks: 0,
      lsp: 0,
      lifecycleMutation: false,
      networkHosts: [],
      filesystemRoots: [],
    },
    contentHash: "a".repeat(64),
    diagnostics: [],
    reviewTokenUsable: false,
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<EngineSettingsAdapter> = {}) {
  const calls = {
    addMcpServer: vi.fn(async () => ({ revision: "mcp-v1-new", name: "fixture" })),
    controlMcpServer: vi.fn(async ({ name, action }: { name: string; action: string }) => ({
      revision: "mcp-v1-new",
      name,
      action: action === "reconnect" ? "reconnected" : action,
      ok: true,
      connection: {
        server: name,
        connected: true,
        authRequired: false,
        error: null,
      },
      message: action,
    })),
    setSkillEnabled: vi.fn(async (name: string, enabled: boolean) => ({ name, enabled })),
    controlPlugin: vi.fn(async () => ({ ok: true, message: "plugin updated" })),
    installPlugin: vi.fn(async () => ({
      id: "user/hash/fixture",
      name: "fixture",
      message: "Installed disabled and untrusted.",
    })),
    installSkill: vi.fn(async () => ({ name: "fixture", message: "installed" })),
    setWorkspaceTrust: vi.fn(async (trusted: boolean) => ({
      workspace: "/tmp/ws",
      trusted,
      configPath: "/tmp/config.toml",
      message: `trusted=${trusted}`,
    })),
  };
  const adapter = {
    discover: async () => ({ identity: { version: "0.10.2", commit: "abcdef1234567" } }),
    listProviders: async () => ({ current: "deepseek", currentExactId: "deepseek", providers: [] }),
    listModels: async () => ({ provider: "deepseek", exactId: null, models: [] }),
    refreshProviderModels: async () => ({ ok: true, message: "ok" }),
    readRuntimeConfig: async () => ({}),
    writeRuntimeSetting: async () => ({}),
    reloadRuntimeConfig: async () => ({ ok: true, message: "ok" }),
    switchProvider: async () => ({}),
    setProviderKey: async () => ({}),
    clearProviderKey: async () => ({ cleared: true, credentialState: "missing" }),
    listMcpServers: async () => mcpList(),
    addMcpServer: calls.addMcpServer,
    controlMcpServer: calls.controlMcpServer,
    readMcpTools: async (server?: string) => ({
      tools: [
        {
          server: server ?? "fixture",
          name: "echo",
          prefixedName: `mcp_${server ?? "fixture"}_echo`,
          description: "Echo text.",
          inputSchema: { type: "object" },
        },
      ],
      connections: [
        { server: server ?? "fixture", connected: true, authRequired: false, error: null },
      ],
    }),
    listSkills: async () => ({
      directory: "/Users/test/.codewhale/skills",
      directories: ["/tmp/ws/.codewhale/skills", "/Users/test/.codewhale/skills"],
      warnings: [],
      skills: [
        {
          name: "bundled",
          description: "Bundled skill.",
          path: "/Users/test/.codewhale/skills/bundled/SKILL.md",
          source: "native",
          pluginId: null,
          enabled: true,
          bundled: true,
          invocation: "model+user",
          aliases: [],
          bundledTier: "core",
        },
        {
          name: "project-note",
          description: "Project skill.",
          path: "/tmp/ws/.codewhale/skills/project-note/SKILL.md",
          source: "native",
          pluginId: null,
          enabled: true,
          bundled: false,
          invocation: "model+user",
          aliases: [],
          bundledTier: null,
        },
      ],
    }),
    readSkill: async () => ({}),
    setSkillEnabled: calls.setSkillEnabled,
    listPlugins: async () => ({
      plugins: [
        plugin(),
        plugin({
          id: "user/hash/approved",
          name: "approved",
          trustStatus: "approved",
        }),
      ],
      registryDiagnostics: [],
      validationClean: true,
    }),
    controlPlugin: calls.controlPlugin,
    installPlugin: calls.installPlugin,
    installSkill: calls.installSkill,
    readHooks: async () => ({
      workspace: "/tmp/ws",
      enabled: true,
      hooks: [
        {
          name: "guard",
          event: "tool_call_before",
          command: `guard --token ${SECRET}`,
          background: false,
          timeoutSecs: 5,
          source: "project",
        },
      ],
      problems: [`problem mentions ${SECRET}`],
    }),
    readInstructions: async () => ({
      workspace: "/tmp/ws",
      sources: [
        {
          kind: "project",
          status: "loaded",
          path: "/tmp/ws/AGENTS.md",
          relativePath: "AGENTS.md",
          exists: true,
          bytes: 120,
          warning: null,
        },
      ],
    }),
    readWorkspaceTrust: async () => ({ workspace: "/tmp/ws", trusted: false }),
    setWorkspaceTrust: calls.setWorkspaceTrust,
    listCommands: async () => ({
      commands: [
        {
          name: "help",
          summary: "Commands",
          kind: "builtin",
          binding: "host",
          aliases: [],
          hidden: false,
        },
        {
          name: "project-review",
          summary: "Review the project",
          kind: "user",
          binding: "prompt",
          aliases: [],
          hidden: false,
        },
      ],
    }),
    ...overrides,
  } as unknown as EngineSettingsAdapter;
  return { adapter, calls };
}

async function bench(options: { adapter?: EngineSettingsAdapter | null } = {}) {
  const { store } = await openTestStore();
  const adapter = options.adapter === undefined ? fakeAdapter().adapter : options.adapter;
  let live = adapter !== null;
  const workbench = new ExtensionWorkbench({
    store,
    engine: () => (live && adapter ? { adapter, workspace: "/tmp/ws" } : null),
  });
  return {
    store,
    workbench,
    goOffline: () => {
      live = false;
    },
  };
}

describe("MCP inventory", () => {
  it("redacts home paths, argument secrets, and URL userinfo while keeping scope and provenance", async () => {
    const { workbench } = await bench();
    const snapshot = await workbench.snapshot(projectId);
    const fixture = snapshot.mcp.servers.find((server) => server.name === "fixture")!;
    expect(fixture.command).toBe("~/.local/bin/mcp-fixture");
    expect(fixture.argsCount).toBe(2);
    expect(fixture.envKeys).toEqual(["FIXTURE_TOKEN"]);
    const project = snapshot.mcp.servers.find((server) => server.name === "project-one")!;
    expect(project.origin).toBe("project");
    expect(project.writable).toBe(false);
    expect(project.urlAuthority).toBe("https://mcp.example.com");
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(JSON.stringify(snapshot)).not.toContain("user:pass");
    expect(project.actions.find((action) => action.id === "mcp.enable")?.available).toBe(false);
    expect(project.actions.find((action) => action.id === "mcp.enable")?.reason).toContain(
      "read-only",
    );
  });

  it("requires an absolute command and a current revision before adding a server", async () => {
    const { adapter, calls } = fakeAdapter();
    const { workbench } = await bench({ adapter });
    await expect(
      workbench.addMcp(projectId, {
        expectedRevision: "mcp-v1-abc123",
        name: "npx-server",
        command: "npx",
        args: ["server"],
        url: null,
        transport: null,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls.addMcpServer).not.toHaveBeenCalled();

    const receipt = await workbench.addMcp(projectId, {
      expectedRevision: "mcp-v1-abc123",
      name: "fixture",
      command: "/usr/local/bin/mcp",
      args: [],
      url: null,
      transport: null,
      enabled: true,
    });
    expect(receipt.ok).toBe(true);
    expect(calls.addMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ revision: "mcp-v1-abc123", command: "/usr/local/bin/mcp" }),
    );
  });

  it("reports a failed handshake without inventing health", async () => {
    const { adapter } = fakeAdapter({
      controlMcpServer: async () => ({
        revision: "mcp-v1-new",
        name: "fixture",
        action: "reconnect_failed",
        ok: false,
        connection: {
          server: "fixture",
          connected: false,
          authRequired: false,
          error: `spawn failed with ${SECRET}`,
        },
        message: "reconnect_failed",
      }),
    });
    const { workbench } = await bench({ adapter });
    const receipt = await workbench.act({
      projectId,
      action: "mcp.reconnect",
      target: "fixture",
      expectedRevision: "mcp-v1-abc123",
    });
    expect(receipt.ok).toBe(false);
    expect(receipt.message).toContain("handshake failed");
    expect(receipt.message).not.toContain(SECRET);
    const snapshot = await workbench.snapshot(projectId);
    const server = snapshot.mcp.servers.find((entry) => entry.name === "fixture")!;
    expect(server.health.state).toBe("failed");
    expect(server.health.error).not.toContain(SECRET);
  });

  it("propagates a stale revision refusal from the engine", async () => {
    const { adapter } = fakeAdapter({
      controlMcpServer: async () => {
        throw Object.assign(new Error("MCP configuration changed; reload it before saving"), {
          code: "MALFORMED_RESPONSE",
        });
      },
    });
    const { workbench } = await bench({ adapter });
    await expect(
      workbench.act({
        projectId,
        action: "mcp.disable",
        target: "fixture",
        expectedRevision: "mcp-v1-stale",
      }),
    ).rejects.toThrow("MCP configuration changed");
  });
});

describe("skills, plugins, hooks, and scope", () => {
  it("toggles a skill through the engine and maps project versus global scope", async () => {
    const { adapter, calls } = fakeAdapter();
    const { workbench } = await bench({ adapter });
    const snapshot = await workbench.snapshot(projectId);
    expect(snapshot.skills.skills.find((skill) => skill.name === "bundled")?.scope).toBe("builtin");
    expect(snapshot.skills.skills.find((skill) => skill.name === "project-note")?.scope).toBe(
      "project",
    );
    const receipt = await workbench.act({
      projectId,
      action: "skill.disable",
      target: "project-note",
    });
    expect(receipt.ok).toBe(true);
    expect(calls.setSkillEnabled).toHaveBeenCalledWith("project-note", false);
  });

  it("keeps plugin trust as a terminal action and refuses enable before review", async () => {
    const { workbench } = await bench();
    const snapshot = await workbench.snapshot(projectId);
    const draft = snapshot.plugins.plugins.find((entry) => entry.name === "fixture-plugin")!;
    expect(draft.actions.find((action) => action.id === "plugin.enable")?.available).toBe(false);
    expect(draft.actions.find((action) => action.id === "plugin.enable")?.reason).toContain(
      "requires capability review",
    );
    expect(draft.actions.find((action) => action.id === "plugin.trust")?.available).toBe(false);
    await expect(
      workbench.act({ projectId, action: "plugin.trust", target: draft.id }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_ACTION" });
    const approved = snapshot.plugins.plugins.find((entry) => entry.name === "approved")!;
    expect(approved.actions.find((action) => action.id === "plugin.enable")?.available).toBe(true);
  });

  it("redacts hook commands and problems and never offers a hook mutation", async () => {
    const { workbench } = await bench();
    const snapshot = await workbench.snapshot(projectId);
    expect(snapshot.hooks.hooks[0]?.command).not.toContain(SECRET);
    expect(snapshot.hooks.problems[0]).not.toContain(SECRET);
    expect(snapshot.hooks.note).toContain("never executes");
    const gap = snapshot.gaps.find((entry) => entry.id === "hooks-mutation");
    expect(gap?.route).toContain("engine");
  });

  it("ties trust to the verified workspace action", async () => {
    const { adapter, calls } = fakeAdapter();
    const { workbench } = await bench({ adapter });
    const snapshot = await workbench.snapshot(projectId);
    expect(snapshot.workspaceTrust.trusted).toBe(false);
    const receipt = await workbench.act({
      projectId,
      action: "workspace.trust",
      target: "workspace",
    });
    expect(receipt.ok).toBe(true);
    expect(calls.setWorkspaceTrust).toHaveBeenCalledWith(true);
    expect(receipt.detail).toContain("Restart the engine");
  });
});

describe("offline and installation behavior", () => {
  it("serves the last verified inventory offline and disables actions", async () => {
    const { workbench, goOffline } = await bench();
    const live = await workbench.snapshot(projectId);
    expect(live.runtime).toBe("connected");
    goOffline();
    const cached = await workbench.snapshot(projectId);
    expect(cached.runtime).toBe("unavailable");
    expect(cached.mcp.servers.map((server) => server.name)).toEqual(
      live.mcp.servers.map((server) => server.name),
    );
    expect(cached.mcp.source).toBe("stored");
    expect(JSON.stringify(cached)).not.toContain(SECRET);
    await expect(
      workbench.act({ projectId, action: "skill.disable", target: "bundled" }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("installs a plugin disabled and untrusted through the engine", async () => {
    const { adapter, calls } = fakeAdapter();
    const { workbench } = await bench({ adapter });
    const receipt = await workbench.install(projectId, "plugin", "/tmp/fixture-plugin");
    expect(receipt.ok).toBe(true);
    expect(receipt.detail).toContain("disabled and untrusted");
    expect(calls.installPlugin).toHaveBeenCalledWith("/tmp/fixture-plugin");
  });
});
