import annotationsFile from "./annotations.json";
import pinnedFile from "./pinned-commands.json";
import {
  CommandAnnotationFileSchema,
  CommandCatalogSnapshotSchema,
  PinnedCommandFileSchema,
  type CommandCatalogSnapshot,
} from "../contracts/commands";

/**
 * Build the validated R03 catalog from the generated pinned capture and the
 * curated annotations. This is a pure, local function: no process, no network,
 * no model. A missing or extra annotation is a build error, not a silent
 * default, because a row without an honest route claim is a lie the UI would
 * repeat.
 */
export function buildCommandCatalog(): CommandCatalogSnapshot {
  const pinned = PinnedCommandFileSchema.parse(pinnedFile);
  const annotations = CommandAnnotationFileSchema.parse(annotationsFile);
  const names = new Set(pinned.commands.map((command) => command.name));
  const missing = [...names].filter((name) => !(name in annotations.entries));
  const extra = Object.keys(annotations.entries).filter((name) => !names.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `commands without an annotation: ${missing.join(", ")}` : null,
        extra.length > 0 ? `annotations without a command: ${extra.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const commands = pinned.commands.map((command) => ({
    ...command,
    annotation: annotations.entries[command.name]!,
  }));
  const stats = {
    total: commands.length,
    runtimeApi: commands.filter((command) => command.annotation.support === "runtime-api").length,
    terminalOnly: commands.filter((command) => command.annotation.support === "terminal-only")
      .length,
    unavailable: commands.filter((command) => command.annotation.support === "unavailable").length,
    hidden: commands.filter((command) => command.hidden).length,
  };
  return CommandCatalogSnapshotSchema.parse({
    provenance: pinned.provenance,
    commands,
    stats,
  });
}

/** Every spelling the engine answers to, lower-cased, mapped to the command. */
export function commandSpellings(
  snapshot: CommandCatalogSnapshot,
): Map<string, CommandCatalogSnapshot["commands"][number]> {
  const spellings = new Map<string, CommandCatalogSnapshot["commands"][number]>();
  for (const command of snapshot.commands) {
    for (const spelling of [command.name, ...command.aliases]) {
      const key = spelling.toLowerCase();
      if (!spellings.has(key)) spellings.set(key, command);
    }
  }
  return spellings;
}
