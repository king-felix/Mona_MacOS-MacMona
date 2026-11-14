import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import monaMark from "../assets/mona-mark.png";
import { HARNESS_LABEL } from "./fixtures";
import {
  Badge,
  Button,
  Dialog,
  KeyCap,
  SegmentedControl,
  Switch,
  VisuallyHidden,
} from "./primitives";
import {
  BoardIcon,
  ChevronDownIcon,
  CostIcon,
  FolderIcon,
  HomeIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  WarningIcon,
} from "./icons";
import {
  applyDensity,
  applyReducedMotion,
  applyTheme,
  type Density,
  type ThemeName,
} from "./tokens";
import { HomeScreen } from "./screens/Home";
import { StudioScreen } from "./screens/Studio";
import { WorkBoardScreen } from "./screens/WorkBoard";
import { CostLensScreen } from "./screens/CostLens";
import { BlockerScreen } from "./screens/Blocker";
import { SettingsScreen } from "./screens/Settings";
import type { Scenario } from "./screens/types";

export type ScreenId = "home" | "studio" | "board" | "cost" | "blocker" | "settings";

export interface HarnessState {
  screen: ScreenId;
  theme: ThemeName;
  density: Density;
  scenario: Scenario;
  reducedMotion: boolean;
}

export const DEFAULT_HARNESS_STATE: HarnessState = {
  screen: "home",
  theme: "daybreak",
  density: "comfortable",
  scenario: "default",
  reducedMotion: false,
};

const SCREENS: Array<{
  id: ScreenId;
  label: string;
  icon: JSX.Element;
  render: (scenario: Scenario, openBlocker: () => void) => JSX.Element;
}> = [
  {
    id: "home",
    label: "Home",
    icon: <HomeIcon size={17} />,
    render: (scenario) => <HomeScreen scenario={scenario} />,
  },
  {
    id: "studio",
    label: "Studio",
    icon: <SparkIcon size={17} />,
    render: (scenario) => <StudioScreen scenario={scenario} />,
  },
  {
    id: "board",
    label: "Work board",
    icon: <BoardIcon size={17} />,
    render: (scenario, openBlocker) => (
      <WorkBoardScreen scenario={scenario} onOpenBlocker={openBlocker} />
    ),
  },
  {
    id: "cost",
    label: "Cost lens",
    icon: <CostIcon size={17} />,
    render: (scenario) => <CostLensScreen scenario={scenario} />,
  },
  {
    id: "blocker",
    label: "Blocker",
    icon: <WarningIcon size={17} />,
    render: (scenario) => <BlockerScreen scenario={scenario} />,
  },
  {
    id: "settings",
    label: "Settings",
    icon: <SettingsIcon size={17} />,
    render: (scenario) => <SettingsScreen scenario={scenario} />,
  },
];

const SCENARIOS: Array<{ value: Scenario; label: string }> = [
  { value: "default", label: "Default content" },
  { value: "empty", label: "Empty state" },
  { value: "disconnected", label: "Disconnected" },
  { value: "blocked", label: "Blocked work" },
  { value: "unknown-cost", label: "Unknown cost" },
];

declare global {
  interface Window {
    __monaHarness?: {
      set: (patch: Partial<HarnessState>) => void;
      snapshot: () => HarnessState;
    };
  }
}

export function Harness(): JSX.Element {
  const [state, setState] = useState<HarnessState>(DEFAULT_HARNESS_STATE);
  const [version, setVersion] = useState<string>("0.1.0-p02");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");

  const update = useCallback((patch: Partial<HarnessState>) => {
    setState((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    applyTheme(state.theme);
    applyDensity(state.density);
    applyReducedMotion(state.reducedMotion);
    document.documentElement.dataset.screen = state.screen;
  }, [state]);

  useEffect(() => {
    window.__monaHarness = {
      set: update,
      snapshot: () => state,
    };
    return () => {
      delete window.__monaHarness;
    };
  }, [state, update]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const info = await window.mona?.getAppInfo();
        if (!cancelled && info?.version) setVersion(info.version);
      } catch {
        // The harness still renders without the bridge; it never invents state.
      } finally {
        if (!cancelled) document.body.dataset.ready = "true";
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable === true;

      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (typing) return;
      if (event.metaKey && !event.shiftKey && /^[1-6]$/.test(event.key)) {
        const screen = SCREENS[Number(event.key) - 1];
        if (screen) {
          event.preventDefault();
          update({ screen: screen.id });
        }
      }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        update({ density: state.density === "dense" ? "comfortable" : "dense" });
      }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        update({ theme: state.theme === "daybreak" ? "afterglow" : "daybreak" });
      }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        update({ reducedMotion: !state.reducedMotion });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, update]);

  const active = SCREENS.find((screen) => screen.id === state.screen) ?? SCREENS[0];
  const openBlocker = useCallback(
    () => update({ screen: "blocker", scenario: "default" }),
    [update],
  );

  const commands = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    return SCREENS.filter((screen) => screen.label.toLowerCase().includes(query));
  }, [paletteQuery]);

  return (
    <div className="harness">
      <a className="skip-link" href="#screen-main">
        Skip to content
      </a>
      <div className="titlebar" aria-hidden="true">
        <span className="titlebar__title">Mona — design harness</span>
      </div>

      <aside className="rail" aria-label="Primary">
        <div className="rail__brand">
          <img
            className="brand-mark"
            src={monaMark}
            alt=""
            aria-hidden="true"
            width={24}
            height={24}
          />
          <span className="brand-name">Mona</span>
          <span className="brand-tag">harness</span>
        </div>

        <nav className="rail__nav" aria-label="Screens">
          {SCREENS.map((screen) => (
            <button
              key={screen.id}
              type="button"
              data-nav
              className={`rail__item ${screen.id === state.screen ? "rail__item--current" : ""}`}
              aria-current={screen.id === state.screen ? "page" : undefined}
              aria-label={screen.label}
              title={screen.label}
              onClick={() => update({ screen: screen.id })}
            >
              <span className="rail__icon" aria-hidden="true">
                {screen.icon}
              </span>
              <span className="rail__label">{screen.label}</span>
            </button>
          ))}
        </nav>

        <div className="rail__group" aria-label="Shortcuts">
          <p className="rail__group-title">Keys</p>
          <p className="rail__hint">
            <KeyCap>⌘</KeyCap>
            <KeyCap>1–6</KeyCap> screens
          </p>
          <p className="rail__hint">
            <KeyCap>⌘</KeyCap>
            <KeyCap>K</KeyCap> palette
          </p>
        </div>

        <div className="rail__footer">
          <span className="status-dot status-dot--attention" aria-hidden="true" />
          <div>
            <p className="rail__footer-line">Engine: not connected</p>
            <p className="rail__footer-line rail__footer-line--muted" data-testid="app-version">
              Mona {version} · harness
            </p>
          </div>
        </div>
      </aside>

      <main className="harness__main" id="screen-main" tabIndex={-1}>
        <div className="harness-banner" role="note">
          <Badge tone="attention" icon={<WarningIcon size={14} />}>
            {HARNESS_LABEL}
          </Badge>
          <p>
            Visual development harness: every name, path, event, and cost below is fixture data. No
            engine is attached, no inference is made, and nothing here is a live success state.
          </p>
        </div>

        <div className="harness-controls" aria-label="Harness controls">
          <div className="harness-controls__group">
            <span className="harness-controls__label">Theme</span>
            <SegmentedControl
              label="Theme"
              value={state.theme}
              onChange={(value) => update({ theme: value as ThemeName })}
              options={[
                { value: "daybreak", label: "Daybreak" },
                { value: "afterglow", label: "Afterglow" },
              ]}
            />
          </div>
          <div className="harness-controls__group">
            <span className="harness-controls__label">Density</span>
            <SegmentedControl
              label="Density"
              value={state.density}
              onChange={(value) => update({ density: value as Density })}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "dense", label: "Dense" },
              ]}
            />
          </div>
          <div className="harness-controls__group harness-controls__group--scenario">
            <label className="harness-controls__label" htmlFor="harness-scenario">
              Scenario
            </label>
            <div className="select">
              <select
                id="harness-scenario"
                className="input select__control harness-select"
                value={state.scenario}
                onChange={(event) => update({ scenario: event.target.value as Scenario })}
              >
                {SCENARIOS.map((scenario) => (
                  <option key={scenario.value} value={scenario.value}>
                    {scenario.label}
                  </option>
                ))}
              </select>
              <ChevronDownIcon size={14} className="select__chevron" />
            </div>
          </div>
          <div className="harness-controls__group">
            <Switch
              label="Reduced motion"
              checked={state.reducedMotion}
              onChange={(checked) => update({ reducedMotion: checked })}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<SearchIcon size={15} />}
            onClick={() => setPaletteOpen(true)}
          >
            Palette <KeyCap>⌘K</KeyCap>
          </Button>
        </div>

        <VisuallyHidden>
          <p aria-live="polite">Screen: {active?.label ?? "Home"}</p>
        </VisuallyHidden>

        <div className="harness__screen">{active?.render(state.scenario, openBlocker)}</div>

        <footer className="harness__footer">
          <span>
            <FolderIcon size={14} /> Fixture paths are illustrative. P07 replaces this harness with
            the real catalog and engine state.
          </span>
        </footer>
      </main>

      <Dialog
        open={paletteOpen}
        title="Command palette"
        description="Local, deterministic navigation. No model call is made."
        onClose={() => setPaletteOpen(false)}
      >
        <div className="palette">
          <label className="field__label" htmlFor="palette-filter">
            Filter screens
          </label>
          <input
            id="palette-filter"
            className="input"
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
            placeholder="Type a screen name…"
          />
          <ul className="palette__list">
            {commands.map((screen) => (
              <li key={screen.id}>
                <button
                  type="button"
                  className="palette__item"
                  onClick={() => {
                    update({ screen: screen.id });
                    setPaletteOpen(false);
                  }}
                >
                  <span className="palette__icon" aria-hidden="true">
                    {screen.icon}
                  </span>
                  <span>{screen.label}</span>
                  <KeyCap>⌘{SCREENS.indexOf(screen) + 1}</KeyCap>
                </button>
              </li>
            ))}
            {commands.length === 0 ? <li className="palette__empty">No matching screen.</li> : null}
          </ul>
        </div>
      </Dialog>
    </div>
  );
}
