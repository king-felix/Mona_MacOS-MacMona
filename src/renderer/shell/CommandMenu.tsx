import { useEffect, useRef, type JSX } from "react";
import type { CommandCatalogEntry, CommandCatalogSnapshot } from "../../shared/contracts/commands";
import type { CommandMatch } from "./composer-commands";

/**
 * R03 — the composer's command suggestion list and its detail panel.
 *
 * The list is a real listbox: aria-activedescendant points at the highlighted
 * option, Tab accepts, arrows move, and Escape closes before anything else.
 * Plain Enter is never intercepted here — the composer keeps it as a newline.
 */

export interface CommandMenuProps {
  catalog: CommandCatalogSnapshot;
  query: string;
  matches: CommandMatch[];
  selected: number;
  onHover: (index: number) => void;
  onAccept: (entry: CommandCatalogEntry) => void;
  engine: { version: string; commit: string } | null;
  /** Which side of the composer has room, measured by the Studio. */
  placement?: "above" | "below";
  maxHeight?: number;
  /** A short viewport (200% zoom) keeps the list and drops the detail/footer. */
  compact?: boolean;
}

const SUPPORT_LABEL: Record<CommandCatalogEntry["annotation"]["support"], string> = {
  "runtime-api": "Runtime API",
  "terminal-only": "TUI only",
  unavailable: "Unavailable",
};

function routeText(entry: CommandCatalogEntry): string {
  const route = entry.annotation.route;
  if (route.kind === "runtime-api") return route.endpoints.join(" · ");
  return route.note;
}

export function CommandMenu({
  catalog,
  query,
  matches,
  selected,
  onHover,
  onAccept,
  engine,
  placement = "above",
  maxHeight,
  compact = false,
}: CommandMenuProps): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const current = matches[selected]?.entry ?? null;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const option = list.querySelector<HTMLElement>(`[data-index="${selected}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [selected, matches.length]);

  const provenance = catalog.provenance;
  const drift =
    engine !== null &&
    (engine.version !== provenance.version ||
      !engine.commit.startsWith(provenance.commit.slice(0, 12)))
      ? `Engine reports ${engine.version} (${engine.commit.slice(0, 12)}); this catalog is pinned to ${provenance.version} (${provenance.commit.slice(0, 12)}).`
      : null;

  return (
    <div
      className={`command-menu command-menu--${placement}${compact ? " command-menu--compact" : ""}`}
      data-testid="command-menu"
      style={maxHeight === undefined ? undefined : { maxHeight }}
    >
      <div className="command-menu__head">
        <span className="command-menu__title">Codewhale commands</span>
        <span className="hint-line" role="status" aria-live="polite">
          {matches.length === 0
            ? `No catalogued command matches “${query}”. ⌘Enter sends the line as prompt text.`
            : `${matches.length} match${matches.length === 1 ? "" : "es"} · ${catalog.stats.total} catalogued`}
        </span>
      </div>
      {drift ? (
        <p className="command-menu__drift" role="status">
          {drift} The catalog does not re-qualify itself.
        </p>
      ) : null}
      {matches.length > 0 ? (
        <div
          className="command-menu__body"
          ref={listRef}
          role="listbox"
          id="composer-command-menu"
          aria-label="Codewhale commands"
        >
          {matches.map((match, index) => {
            const entry = match.entry;
            return (
              <div
                key={entry.name}
                id={`composer-command-option-${index}`}
                data-index={index}
                className={
                  index === selected ? "command-option command-option--active" : "command-option"
                }
                role="option"
                aria-selected={index === selected}
                onMouseDown={(event) => {
                  // Keep focus and the caret in the composer.
                  event.preventDefault();
                }}
                onMouseEnter={() => onHover(index)}
                onClick={() => onAccept(entry)}
              >
                <span className="command-option__name">/{entry.name}</span>
                {entry.aliases.length > 0 ? (
                  <span className="command-option__aliases">
                    {entry.aliases.map((alias) => `/${alias}`).join(" ")}
                  </span>
                ) : null}
                <span className="command-option__summary">{entry.summary}</span>
                <span
                  className={`command-option__support command-option__support--${entry.annotation.support}`}
                >
                  {SUPPORT_LABEL[entry.annotation.support]}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
      {current && !compact ? (
        /* R11 — not a live region. The combobox already announces the highlighted
           option through aria-activedescendant, and every option's accessible
           name carries its description and route class. A polite region here
           made a screen reader say each command twice on every arrow press. The
           panel stays as supplementary visual detail. */
        <div className="command-menu__detail">
          <p className="command-menu__detail-head">
            <code>/{current.name}</code>
            <span>{current.summary}</span>
          </p>
          <p className="command-menu__meta">
            <code>{current.usage}</code>
            {current.subcommands.length > 0 ? (
              <>
                <span className="command-menu__sep">·</span>
                {current.subcommands.map((verb) => (
                  <span className="command-verb" key={verb}>
                    {verb}
                  </span>
                ))}
              </>
            ) : null}
            <span className="command-menu__sep">·</span>
            <span>scope {current.annotation.scope}</span>
            <span className="command-menu__sep">·</span>
            <span>
              {current.annotation.cost === "may-spend"
                ? "may call the model"
                : current.annotation.cost === "unknown"
                  ? "cost not stated"
                  : "no model call"}
            </span>
            <span className="command-menu__sep">·</span>
            <span>effects {current.annotation.sideEffects.join(", ")}</span>
          </p>
          <p className="command-menu__support">
            <span className={`support-badge support-badge--${current.annotation.support}`}>
              {SUPPORT_LABEL[current.annotation.support]}
            </span>{" "}
            {routeText(current)}
          </p>
          {current.annotation.notes ? (
            <p className="command-menu__note">{current.annotation.notes}</p>
          ) : null}
        </div>
      ) : null}
      {compact ? null : (
        <div className="command-menu__foot">
          <span>↑↓ choose</span>
          <span>Tab accept</span>
          <span>Esc close</span>
          <span>Enter newline</span>
          <span>⌘Enter send</span>
        </div>
      )}
    </div>
  );
}
