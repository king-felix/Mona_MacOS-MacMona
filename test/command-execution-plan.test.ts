import { describe, expect, it } from "vitest";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import { buildCommandExecutionPlan, planForName } from "../src/shared/commands/execution-plan";
import { COMMAND_SCREENS } from "../src/shared/contracts/command-execution";

describe("R04 command execution plan", () => {
  const catalog = buildCommandCatalog();
  const plan = buildCommandExecutionPlan(catalog);

  it("covers every catalogued command exactly once", () => {
    expect(Object.keys(plan)).toHaveLength(catalog.commands.length);
    for (const command of catalog.commands) {
      expect(plan[command.name], command.name).toBeDefined();
    }
    expect(planForName(plan, "new")).not.toBeNull();
    expect(planForName(plan, "not-a-command")).toBeNull();
  });

  it("keeps the native set small, typed and evidence-shaped", () => {
    const native = Object.entries(plan)
      .filter(([, entry]) => entry.kind === "native")
      .map(([name, entry]) => `${name}:${entry.kind === "native" ? entry.operation : ""}`);
    expect(native.sort()).toEqual([
      "compact:compact",
      "fork:fork",
      "new:new",
      "rename:rename",
      "retry:retry",
    ]);
    for (const entry of Object.values(plan)) {
      if (entry.kind !== "native") continue;
      if (entry.operation === "compact" || entry.operation === "retry") {
        expect(entry.confirm, entry.operation).toBe(true);
      }
    }
  });

  it("only reveals real Mona screens", () => {
    for (const entry of Object.values(plan)) {
      if (entry.kind !== "view") continue;
      expect(COMMAND_SCREENS).toContain(entry.screen);
      expect(entry.note.length).toBeGreaterThan(20);
    }
  });

  it("never builds a terminal invocation from user input", () => {
    // Fixed shell words only: no quoting, metacharacters, redirects or paths.
    const safe = /^codewhale(?: (?:[a-z0-9][a-z0-9-]*|--[a-z][a-z0-9-]*)){0,6}$/;
    for (const [name, entry] of Object.entries(plan)) {
      if (entry.kind !== "terminal") continue;
      expect(entry.invocation, name).toMatch(safe);
      expect(entry.invocation, name).not.toMatch(/[;&|`$()<>\\"']/);
    }
  });

  it("reports the five unavailable engine surfaces and nothing more", () => {
    const unavailable = Object.entries(plan)
      .filter(([, entry]) => entry.kind === "unavailable")
      .map(([name]) => name)
      .sort();
    expect(unavailable).toEqual(["attach", "lane", "remote-env", "workflow", "workflows"]);
  });

  it("routes every runtime-api row somewhere it can be honest about", () => {
    for (const command of catalog.commands) {
      const entry = plan[command.name]!;
      if (command.annotation.support === "runtime-api") {
        expect(["native", "view", "terminal"], command.name).toContain(entry.kind);
      }
      if (command.annotation.support === "terminal-only") {
        expect(entry.kind, command.name).toBe("terminal");
      }
    }
  });

  it("does not silently drop a command behind a missing route", () => {
    expect(catalog.commands.some((command) => !plan[command.name])).toBe(false);
    expect(catalog.stats.total).toBe(109);
  });
});
