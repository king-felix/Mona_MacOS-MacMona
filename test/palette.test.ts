import { describe, expect, it } from "vitest";
import { rankPalette, scoreEntry, type PaletteEntry } from "../src/renderer/shell/palette";

function entry(partial: Partial<PaletteEntry> & { id: string; label: string }): PaletteEntry {
  return {
    kind: "action",
    hint: "Action",
    ...partial,
  };
}

describe("command palette ranking", () => {
  it("ranks an exact label above a prefix and a prefix above a substring", () => {
    const items = [
      entry({ id: "a", label: "Open the work board" }),
      entry({ id: "b", label: "Open" }),
      entry({ id: "c", label: "Reopen project" }),
    ];
    const result = rankPalette(items, "open", 10);
    expect(result.matches.map((match) => match.id)).toEqual(["b", "a", "c"]);
  });

  it("matches keywords and hints only after the label", () => {
    const items = [
      entry({ id: "settings", label: "Settings: Runtime", hint: "Setting" }),
      entry({
        id: "terminal",
        label: "Toggle terminal",
        hint: "⌘J",
        keywords: ["console", "shell"],
      }),
    ];
    const result = rankPalette(items, "console", 10);
    expect(result.matches.map((match) => match.id)).toEqual(["terminal"]);
    const byHint = rankPalette(items, "setting", 10);
    expect(byHint.matches[0]?.id).toBe("settings");
  });

  it("prefers a real action over a capability row with the same words", () => {
    const items = [
      entry({
        id: "cap",
        kind: "capability",
        label: "diagnostics",
        hint: "run codewhale doctor",
      }),
      entry({ id: "action", kind: "action", label: "Diagnostics", hint: "Settings" }),
    ];
    const result = rankPalette(items, "diagnostics", 10);
    expect(result.matches[0]?.id).toBe("action");
  });

  it("handles subsequences and reports truncation", () => {
    const items = [
      entry({ id: "board", label: "Go to Work board" }),
      entry({ id: "cost", label: "Go to Cost lens" }),
      entry({ id: "agents", label: "Go to Agents" }),
    ];
    expect(rankPalette(items, "gtwb", 5).matches.map((match) => match.id)).toEqual(["board"]);
    expect(rankPalette(items, "gwb", 5).matches.map((match) => match.id)).toEqual(["board"]);
    const limited = rankPalette(items, "go", 2);
    expect(limited.matches).toHaveLength(2);
    expect(limited.total).toBe(3);
    expect(limited.truncated).toBe(true);
  });

  it("keeps caller order for an empty query and never hides the total", () => {
    const items = [
      entry({ id: "one", label: "One" }),
      entry({ id: "two", label: "Two" }),
      entry({ id: "three", label: "Three" }),
    ];
    const result = rankPalette(items, "   ", 2);
    expect(result.matches.map((match) => match.id)).toEqual(["one", "two"]);
    expect(result.total).toBe(3);
    expect(scoreEntry(items[0]!, "missing")).toBeNull();
  });
});
