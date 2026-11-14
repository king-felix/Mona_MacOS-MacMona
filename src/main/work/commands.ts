import type { CommandCatalogSnapshot } from "../../shared/contracts/commands";
import { buildCommandCatalog } from "../../shared/commands/catalog";

/**
 * R03 — the slash-command catalog as a read-only main-process service.
 *
 * The rows are built from the checked-in pinned capture, so a snapshot is a
 * pure local read: no runtime start, no network request, no model call. The
 * snapshot is validated once and reused; a malformed catalog throws instead of
 * rendering an empty list that would look like "no commands exist".
 */
export class CommandCatalogService {
  private cached: CommandCatalogSnapshot | null = null;

  snapshot(): CommandCatalogSnapshot {
    if (this.cached === null) this.cached = buildCommandCatalog();
    return this.cached;
  }
}
