import type { CommandCatalogSnapshot } from "../../shared/contracts/commands";
import type {
  CommandExecutionEntry,
  CommandExecutionPlan,
} from "../../shared/contracts/command-execution";
import type { CommandCatalogEntry } from "../../shared/contracts/commands";
import { buildCommandCatalog, commandSpellings } from "../../shared/commands/catalog";
import { buildCommandExecutionPlan } from "../../shared/commands/execution-plan";

export interface ResolvedCommand {
  entry: CommandCatalogEntry;
  plan: CommandExecutionEntry;
  /** Canonical engine name; the spelling may have been an alias. */
  command: string;
}

/**
 * R03/R04 — the slash-command catalog and its execution plan as a read-only
 * main-process service.
 *
 * The rows and the plan are built from checked-in, validated data, so a
 * snapshot is a pure local read: no runtime start, no network request, no model
 * call. Both are validated once and reused; a malformed catalog throws instead
 * of rendering an empty list that would look like "no commands exist".
 */
export class CommandCatalogService {
  private cached: CommandCatalogSnapshot | null = null;
  private planCache: CommandExecutionPlan | null = null;
  private spellings: Map<string, CommandCatalogEntry> | null = null;

  snapshot(): CommandCatalogSnapshot {
    if (this.cached === null) this.cached = buildCommandCatalog();
    return this.cached;
  }

  executionPlan(): CommandExecutionPlan {
    if (this.planCache === null) this.planCache = buildCommandExecutionPlan(this.snapshot());
    return this.planCache;
  }

  /**
   * Resolve an exact canonical name or alias. Lookup is exact on purpose: a
   * prefix is a suggestion in the composer, never an executable command.
   */
  resolve(spelling: string): ResolvedCommand | null {
    if (this.spellings === null) this.spellings = commandSpellings(this.snapshot());
    const entry = this.spellings.get(spelling.toLowerCase());
    if (!entry) return null;
    const plan = this.executionPlan()[entry.name];
    if (!plan) return null;
    return { entry, plan, command: entry.name };
  }
}
