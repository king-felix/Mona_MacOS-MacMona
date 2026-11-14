import { describe, expect, it } from "vitest";
import { buildCommandCatalog } from "../src/shared/commands/catalog";
import {
  acceptCommand,
  classifyComposerText,
  couldBeCommandText,
  describeCommandSupport,
  insideFence,
  probeCommandToken,
  rankCommands,
} from "../src/renderer/shell/composer-commands";

const catalog = buildCommandCatalog();

function probe(text: string, caret = text.length) {
  return probeCommandToken(text, caret);
}

describe("R03 command position", () => {
  it("opens only at the start of a line, outside a fence, and not on a path", () => {
    expect(probe("/he").token?.name).toBe("he");
    expect(probe("/").token?.name).toBe("");
    expect(probe("Ask about /help").token).toBeNull();
    expect(probe("/Users/victor/projects").token).toBeNull();
    expect(probe("/Users/victor/projects").literal).toBe("path");
    expect(probe("//help").literal).toBe("path");
    expect(probe("\\/help").token).toBeNull();
    expect(probe("  /help").literal).toBe("outside-line-start");
    expect(probe("/help and more").token).toBeNull();
  });

  it("does not treat fenced pasted code as a command line", () => {
    const fenced = ["```sh", "/help", "```"].join("\n");
    expect(probe(fenced, fenced.indexOf("/help") + 2).literal).toBe("fenced-code");
    expect(insideFence(fenced, fenced.indexOf("/help"))).toBe(true);
    const closed = ["```", "/help", "```", "/help"].join("\n");
    expect(probe(closed, closed.length - 2).token?.name).toBe("help");
  });

  it("closes while a selection is active or the caret is in the arguments", () => {
    expect(probeCommandToken("/help", 2, 1, 3).token).toBeNull();
    expect(probe("/help now", 8).token).toBeNull();
  });

  it("accepts exactly the token and keeps surrounding text and the caret", () => {
    const help = catalog.commands.find((command) => command.name === "help")!;
    const text = "Before\n/he\nAfter";
    const token = probeCommandToken(text, 8)!.token!;
    const accepted = acceptCommand(text, token, help);
    expect(accepted.text).toBe("Before\n/help \nAfter");
    expect(accepted.caret).toBe("Before\n/help ".length);
  });
});

describe("R03 filtering and ranking", () => {
  it("shows the engine's empty-discovery set and filters to every command", () => {
    const empty = rankCommands(catalog, "");
    expect(empty.length).toBeGreaterThan(60);
    expect(empty.some((match) => match.entry.name === "lane")).toBe(false);
    const lane = rankCommands(catalog, "lane");
    expect(lane[0]?.entry.name).toBe("lane");
    expect(lane[0]?.entry.hidden).toBe(true);
  });

  it("ranks an exact name first, then aliases, then description matches", () => {
    expect(rankCommands(catalog, "help")[0]?.entry.name).toBe("help");
    const alias = rankCommands(catalog, "?");
    expect(alias[0]?.entry.name).toBe("help");
    expect(alias[0]?.alias).toBe("?");
    const summary = rankCommands(catalog, "clipboard");
    expect(summary.some((match) => match.entry.name === "copy")).toBe(true);
  });

  it("is deterministic for the same query", () => {
    expect(rankCommands(catalog, "co").map((match) => match.entry.name)).toEqual(
      rankCommands(catalog, "co").map((match) => match.entry.name),
    );
  });
});

describe("R03 submission intent", () => {
  it("resolves only exact names and aliases", () => {
    expect(classifyComposerText("/help", catalog)).toMatchObject({
      kind: "command",
      entry: { name: "help" },
    });
    expect(classifyComposerText("/?", catalog)).toMatchObject({
      kind: "command",
      entry: { name: "help" },
    });
    expect(classifyComposerText("/model refresh", catalog)).toMatchObject({
      kind: "command",
      entry: { name: "model" },
      args: "refresh",
    });
  });

  it("explains a required argument instead of sending or silently selecting", () => {
    const intent = classifyComposerText("/anchor", catalog);
    expect(intent.kind).toBe("incomplete");
    if (intent.kind === "incomplete") {
      expect(intent.reason).toBe("required-argument");
      expect(intent.entry.usage).toContain("<text>");
    }
  });

  it("reports an ambiguous prefix and never guesses", () => {
    const intent = classifyComposerText("/he", catalog);
    expect(intent.kind).toBe("ambiguous");
    if (intent.kind === "ambiguous") {
      expect(intent.matches[0]?.entry.name).toBe("help");
    }
  });

  it("does not refuse prose that only matches a command's description", () => {
    // `/the release is broken` matched 33 summaries before this rule; a summary
    // hit is a suggestion and must never block the prompt.
    expect(classifyComposerText("/the release is broken", catalog)).toEqual({
      kind: "prompt",
    });
    expect(classifyComposerText("/check the failing test", catalog)).toEqual({
      kind: "prompt",
    });
    // A bare command-name prefix stays ambiguous; words after it are prose.
    expect(classifyComposerText("/hel", catalog).kind).toBe("ambiguous");
    expect(classifyComposerText("/the", catalog).kind).toBe("ambiguous");
    expect(classifyComposerText("/hel now please", catalog)).toEqual({ kind: "prompt" });
    expect(classifyComposerText("/mode work", catalog)).toMatchObject({
      kind: "command",
      entry: { name: "mode" },
    });
  });

  it("leaves paths, escapes, prose and multiline text as prompt text", () => {
    expect(classifyComposerText("/Users/victor/file", catalog)).toEqual({ kind: "prompt" });
    expect(classifyComposerText("\\/help", catalog)).toEqual({ kind: "prompt" });
    expect(classifyComposerText("/zzzzz", catalog)).toEqual({ kind: "prompt" });
    expect(classifyComposerText("/help\nand a second line", catalog)).toEqual({ kind: "prompt" });
    expect(classifyComposerText("  /help", catalog)).toEqual({ kind: "prompt" });
  });

  it("fails closed on slash text when the catalog is unavailable", () => {
    expect(couldBeCommandText("/help")).toBe(true);
    expect(couldBeCommandText("/new")).toBe(true);
    expect(couldBeCommandText("/")).toBe(false);
    expect(couldBeCommandText("/Users/victor/file")).toBe(false);
    expect(couldBeCommandText("\\/help")).toBe(false);
    expect(couldBeCommandText(" /help")).toBe(false);
    expect(couldBeCommandText("/help\nmore")).toBe(false);
    expect(couldBeCommandText("plain prose")).toBe(false);
  });

  it("says which route would run each support class", () => {
    const help = catalog.commands.find((command) => command.name === "help")!;
    const goal = catalog.commands.find((command) => command.name === "goal")!;
    const lane = catalog.commands.find((command) => command.name === "lane")!;
    expect(describeCommandSupport(help)).toContain("TUI-only");
    expect(describeCommandSupport(goal)).toContain("/v1/threads/{id}/goal");
    expect(describeCommandSupport(lane)).toContain("Unavailable on the pinned engine");
  });
});
