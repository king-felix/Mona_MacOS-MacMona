import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from "react";
import type { AppInfo, AppPathInfo, ToolDiscovery, ZoomView } from "../../shared/contracts/bridge";
import type { ProjectId, TaskId } from "../../shared/contracts/ids";
import type { StudioActionResult, StudioMode, StudioSnapshot } from "../../shared/contracts/studio";
import type {
  IpcResult,
  ProjectDetail,
  ProjectSummary,
  RuntimeStatusView,
  StateFacts,
} from "../../shared/contracts/project-bridge";
import type { OpenResult } from "../../shared/contracts/open";
import { stepZoom } from "../../shared/zoom";
import type { CapabilitySnapshot } from "../../shared/contracts/capability";
import type { CommandCatalogSnapshot } from "../../shared/contracts/commands";
import type { TaskView } from "../../shared/contracts/board";
import {
  POLISH_ACCENTS,
  type PolishAccent,
  type PolishDigestView,
  type PolishStatusView,
  type PromptFavorite,
} from "../../shared/contracts/polish";
import { selectDroppedPath } from "./drop";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  KeyCap,
  Notification,
  TextField,
  VisuallyHidden,
} from "../design/primitives";
import {
  AgentsIcon,
  ArchiveIcon,
  BoardIcon,
  ChangesIcon,
  CostIcon,
  FolderIcon,
  HomeIcon,
  RefreshIcon,
  SearchIcon,
  SettingsIcon,
  SparkIcon,
  TerminalIcon,
  WarningIcon,
} from "../design/icons";
import {
  applyDensity,
  applyReducedMotion,
  applyTheme,
  type Density,
  type ThemeName,
} from "../design/tokens";
import { HomeScreen } from "./Home";
import { StudioScreen } from "./Studio";
import { BoardScreen } from "./Board";
import { CostScreen } from "./Cost";
import { ChangesScreen } from "./Changes";
import { SettingsScreen } from "./Settings";
import { AgentsScreen } from "./Agents";
import { CapabilitiesScreen, type CapabilityEntryRequest } from "./Capabilities";
import { MemoryScreen } from "./Memory";
import { TerminalPanel } from "./TerminalPanel";
import { rankPalette, type PaletteDetail, type PaletteEntry, type PaletteKind } from "./palette";
import { DraftJournal, SelectionEpoch, SubmissionGate, type SubmissionIdentity } from "./session";
import { HistoryPager, type HistoryView } from "./history";
import {
  classifyComposerText,
  couldBeCommandText,
  describeCommandIntent,
} from "./composer-commands";
import type { ScreenId } from "./types";
import { projectMonogram, projectAccent } from "./visual";

const SCREENS: Array<{ id: ScreenId; label: string; icon: JSX.Element }> = [
  { id: "home", label: "Home", icon: <HomeIcon size={17} /> },
  { id: "studio", label: "Studio", icon: <SparkIcon size={17} /> },
  { id: "board", label: "Work board", icon: <BoardIcon size={17} /> },
  { id: "changes", label: "Changes", icon: <ChangesIcon size={17} /> },
  { id: "cost", label: "Cost lens", icon: <CostIcon size={17} /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon size={17} /> },
  { id: "agents", label: "Agents", icon: <AgentsIcon size={17} /> },
  { id: "capabilities", label: "Capabilities", icon: <SearchIcon size={17} /> },
  { id: "memory", label: "Memory", icon: <ArchiveIcon size={17} /> },
];

const SCREEN_IDS = SCREENS.map((screen) => screen.id);

function isScreen(value: unknown): value is ScreenId {
  return typeof value === "string" && (SCREEN_IDS as string[]).includes(value);
}

type DraftStatus = "idle" | "saving" | "saved" | "error";

type DialogState =
  | { kind: "rename"; project: ProjectSummary; name: string }
  | { kind: "remove"; project: ProjectSummary }
  | null;

interface PaletteAction extends PaletteEntry {
  icon: JSX.Element;
  run: () => void;
}

const SETTINGS_TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "attention", label: "Attention" },
  { id: "data", label: "Data" },
  { id: "route", label: "Providers & route" },
  { id: "extensions", label: "Extensions" },
  { id: "runtime", label: "Runtime" },
  { id: "finder", label: "Finder" },
  { id: "privacy", label: "Privacy" },
  { id: "updates", label: "Updates" },
  { id: "recovery", label: "Recovery" },
];

export function Shell(): JSX.Element {
  const [catalog, setCatalog] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatusView | null>(null);
  const [facts, setFacts] = useState<StateFacts | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [paths, setPaths] = useState<AppPathInfo | null>(null);
  const [tools, setTools] = useState<ToolDiscovery[]>([]);
  const [screen, setScreen] = useState<ScreenId>("home");
  const [inspectorTab, setInspectorTab] = useState("task");
  const [theme, setTheme] = useState<ThemeName>(() => {
    const stored = localStorage.getItem("mona.theme");
    return stored === "afterglow" ? "afterglow" : "daybreak";
  });
  const [density, setDensity] = useState<Density>(() => {
    const stored = localStorage.getItem("mona.density");
    return stored === "dense" ? "dense" : "comfortable";
  });
  // Interface scale is owned by main (it persists in the settings table); the
  // shell mirrors it so Settings can show the exact percentage.
  const [zoom, setZoom] = useState<ZoomView | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A notice is only "success" when the reported outcome actually succeeded. A
  // refused notification is an attention state, not a green confirmation.
  const [noticeTone, setNoticeTone] = useState<"success" | "attention">("success");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteTasks, setPaletteTasks] = useState<TaskView[]>([]);
  const [paletteCapabilities, setPaletteCapabilities] = useState<CapabilitySnapshot | null>(null);
  // P19: the memory screen lists tasks for context selection. It reads the
  // board snapshot, which is stored state; opening the screen starts nothing.
  const [memoryTasks, setMemoryTasks] = useState<
    Array<{ id: string; title: string; status: string }>
  >([]);
  const [settingsTab, setSettingsTab] = useState("appearance");
  // P18: the terminal panel. A command is only ever prefilled, never executed.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalMode, setTerminalMode] = useState<"shell" | "log">("shell");
  const [terminalCommand, setTerminalCommand] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  // The composer's text is owned by the draft journal below; these two states
  // mirror it for rendering. Nothing else may hold a second copy of the text
  // across an await.
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("idle");
  // R03: the pinned command catalog. One local read at launch; opening the
  // list, filtering it, and reading help make no further call.
  const [commandCatalog, setCommandCatalog] = useState<CommandCatalogSnapshot | null>(null);
  const [studio, setStudio] = useState<StudioSnapshot | null>(null);
  const [studioMode, setStudioMode] = useState<StudioMode>("work");
  const [studioBusy, setStudioBusy] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [digest, setDigest] = useState<PolishDigestView | null>(null);
  const [polishStatus, setPolishStatus] = useState<PolishStatusView | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [favorites, setFavorites] = useState<PromptFavorite[]>([]);
  const [polishFocus, setPolishFocus] = useState<{
    taskId: TaskId | null;
    problemId: string | null;
    changeSetId: string | null;
  } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [identityDialog, setIdentityDialog] = useState<{
    project: ProjectSummary;
    accent: string | null;
    monogram: string;
  } | null>(null);
  const [favoriteDialog, setFavoriteDialog] = useState<{
    label: string;
    text: string;
  } | null>(null);
  const [quitOpen, setQuitOpen] = useState(false);

  const queryRef = useRef(query);
  const archivedRef = useRef(showArchived);
  const selectedRef = useRef<ProjectDetail | null>(null);
  // R01: the journal owns draft text and serializes writes; the epoch decides
  // which project load is current; the gate makes a submission single-flight
  // from the moment it is claimed.
  const [drafts] = useState(
    () =>
      new DraftJournal((projectId, threadId, text) =>
        window.mona.saveDraft(projectId, threadId, text),
      ),
  );
  const [epoch] = useState(() => new SelectionEpoch());
  const [submission] = useState(() => new SubmissionGate());
  // R02: stored history is read page by page. The pager owns its own request
  // token so a slow page for an abandoned project can never replace the page
  // on screen.
  const [history] = useState(
    () =>
      new HistoryPager({
        page: (projectId, options) => window.mona.projectHistory(projectId, options),
        item: (projectId, threadId, itemId) =>
          window.mona.projectHistoryItem(projectId, threadId, itemId),
      }),
  );
  const [historyView, setHistoryView] = useState<HistoryView>(() => history.view());
  const busyCount = useRef(0);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const studioTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openFolderRef = useRef<() => void>(() => undefined);
  const toggleFocusModeRef = useRef<() => void>(() => undefined);

  queryRef.current = query;
  archivedRef.current = showArchived;
  selectedRef.current = selected;

  useEffect(
    () =>
      drafts.subscribe((view) => {
        setDraft(view.text);
        setDraftStatus(view.phase);
      }),
    [drafts],
  );

  useEffect(() => history.subscribe(setHistoryView), [history]);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.mona as typeof window.mona & {
      commandCatalog?: typeof window.mona.commandCatalog;
    };
    if (typeof bridge.commandCatalog !== "function") return;
    void bridge.commandCatalog().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setCommandCatalog(result.value);
      } else {
        setNoticeTone("attention");
        setNotice(`The command catalog could not be read: ${result.error.message}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("mona.theme", theme);
  }, [theme]);
  useEffect(() => {
    applyDensity(density);
    localStorage.setItem("mona.density", density);
  }, [density]);
  useEffect(() => {
    applyReducedMotion(false);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.screen = screen;
  }, [screen]);
  useEffect(() => {
    document.documentElement.dataset.focusMode = focusMode ? "on" : "off";
  }, [focusMode]);

  const refreshCatalog = useCallback(async (): Promise<void> => {
    const result = await window.mona.listProjects(
      queryRef.current.trim() || undefined,
      archivedRef.current,
    );
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setCatalog(result.value);
  }, []);

  const beginBusy = useCallback((): void => {
    busyCount.current += 1;
    setBusy(true);
  }, []);
  const endBusy = useCallback((): void => {
    busyCount.current = Math.max(0, busyCount.current - 1);
    if (busyCount.current === 0) setBusy(false);
  }, []);

  const reportError = useCallback(
    (token: number, projectName: string, error: { code: string; message: string }): void => {
      const text = `${error.code}: ${error.message}`;
      // A failure is never hidden, even when the user has moved to another
      // project; it is labelled so it cannot be read as the current project's.
      setError(epoch.isCurrent(token) ? text : `${projectName} · ${text}`);
    },
    [epoch],
  );

  const reportNotice = useCallback(
    (
      token: number,
      projectName: string,
      text: string,
      tone: "success" | "attention" = "success",
    ): void => {
      setNoticeTone(tone);
      // A notice about a project the user has left is labelled, not presented
      // as if it described the project on screen.
      setNotice(epoch.isCurrent(token) ? text : `${projectName} · ${text}`);
    },
    [epoch],
  );

  const persistDraft = useCallback(async (): Promise<void> => {
    await drafts.flush();
    const failure = drafts.lastFailure;
    if (failure) setError(failure);
  }, [drafts]);

  const flushDraft = useCallback(async (): Promise<void> => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    await persistDraft();
  }, [persistDraft]);

  const writeDraft = useCallback(
    (text: string): void => {
      drafts.edit(text);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        draftTimer.current = null;
        void persistDraft();
      }, 500);
    },
    [drafts, persistDraft],
  );

  const onDraft = useCallback(
    (text: string) => {
      writeDraft(text);
    },
    [writeDraft],
  );

  const selectProject = useCallback(
    async (project: ProjectSummary, target?: ScreenId): Promise<void> => {
      // The epoch is claimed before the first await, so any older in-flight load
      // (or refresh) is invalid from this moment on, including A→B→A.
      const token = epoch.begin();
      const pendingFlush = flushDraft();
      beginBusy();
      try {
        const [result, studioResult, digestResult] = await Promise.all([
          window.mona.projectDetail(project.id),
          window.mona.studioState(project.id),
          window.mona.polishDigest(project.id),
        ]);
        setError(null);
        // The outgoing draft must be persisted before its key is replaced.
        await pendingFlush;
        if (!epoch.isCurrent(token)) return;
        if (!result.ok) {
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        const detail = result.value;
        // History is reset with the project it belongs to, before anything can
        // render it beside a different detail.
        history.open(detail.project.id, {
          events: detail.events,
          olderCursor: detail.history.olderCursor,
          hasMore: detail.history.hasMore,
          storedTotal: detail.history.storedTotal,
        });
        setSelected(detail);
        setStudio(studioResult.ok ? studioResult.value : null);
        const threadId = detail.draft?.threadId ?? detail.threads[0]?.id ?? null;
        drafts.open(detail.project.id, threadId, detail.draft?.text ?? "");
        const view = detail.view as {
          screen?: unknown;
          inspectorTab?: unknown;
          studioMode?: unknown;
          focusMode?: unknown;
        } | null;
        setInspectorTab(typeof view?.inspectorTab === "string" ? view.inspectorTab : "task");
        setStudioMode(view?.studioMode === "plan" ? "plan" : "work");
        setFocusMode(view?.focusMode === true);
        setScreen(target ?? (isScreen(view?.screen) ? view.screen : "studio"));
        setDigest(digestResult.ok ? digestResult.value : null);
        localStorage.setItem("mona.lastProject", detail.project.id);
        // Reading the project is the visit. The digest above was computed from
        // the old watermark, so entries remain visible; the next visit starts
        // after this mark. Whether a notification was acknowledged changes no
        // task.
        void window.mona.markPolishSeen(detail.project.id).then((marked) => {
          if (!marked.ok) return;
          void window.mona.polishStatus().then((status) => {
            if (status.ok) setPolishStatus(status.value);
          });
        });
      } finally {
        endBusy();
      }
    },
    [beginBusy, drafts, endBusy, epoch, flushDraft, history],
  );

  const refreshSelected = useCallback(async (): Promise<void> => {
    const current = selectedRef.current;
    if (!current) return;
    // The identity that matters is the selection this refresh belongs to, not
    // the project id: A→B→A must not apply A's old refresh.
    const token = epoch.current();
    const [detailResult, studioResult] = await Promise.all([
      window.mona.projectDetail(current.project.id),
      window.mona.studioState(current.project.id),
    ]);
    if (!epoch.isCurrent(token)) return;
    if (detailResult.ok) {
      const detail = detailResult.value;
      // A live refresh extends the transcript; it never replaces the older
      // pages the reader already loaded.
      history.mergeLive(detail.project.id, detail.events, detail.history.storedTotal);
      setSelected(detail);
    }
    if (studioResult.ok) setStudio(studioResult.value);
  }, [epoch, history]);

  const focusToggleAt = useRef(0);
  const toggleFocusMode = useCallback((): void => {
    // The Work menu accelerator and the in-window shortcut can both observe one
    // deliberate key press; one press must never toggle twice.
    const at = Date.now();
    if (at - focusToggleAt.current < 200) return;
    focusToggleAt.current = at;
    setFocusMode((previous) => {
      const next = !previous;
      if (next) setScreen("studio");
      return next;
    });
  }, []);

  /** Step or set the interface scale; main applies and persists it. */
  const applyZoom = useCallback(async (factor: number): Promise<void> => {
    try {
      const next = await window.mona.setZoom(factor);
      setZoom(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);
  const stepZoomBy = useCallback(
    (direction: "in" | "out"): void => {
      const current = zoom?.factor ?? 1;
      const next = stepZoom(current, direction);
      if (next !== current) void applyZoom(next);
    },
    [applyZoom, zoom],
  );

  const refreshFavorites = useCallback(async (): Promise<void> => {
    const result = await window.mona.promptFavorites();
    if (result.ok) setFavorites(result.value);
  }, []);

  const useFavorite = useCallback(
    (favorite: PromptFavorite): void => {
      // Insertion goes through the same journal path as typing, so it cannot
      // bypass serialization, and it never overwrites unsent text silently.
      const current = drafts.current()?.text ?? "";
      const text =
        current.trim().length === 0 ? favorite.text : `${current.trimEnd()}\n\n${favorite.text}`;
      writeDraft(text);
      setNotice(`Inserted “${favorite.label}” into the composer. Nothing has been sent.`);
    },
    [drafts, writeDraft],
  );

  const removeFavorite = useCallback(
    async (id: string): Promise<void> => {
      const result = await window.mona.removePromptFavorite(id);
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      setNotice("Prompt favorite removed.");
      await refreshFavorites();
    },
    [refreshFavorites],
  );

  const submitFavorite = useCallback(async (): Promise<void> => {
    if (!favoriteDialog) return;
    const label = favoriteDialog.label.trim();
    if (!label) return;
    const text = favoriteDialog.text;
    setFavoriteDialog(null);
    const result = await window.mona.savePromptFavorite({ label, text });
    if (!result.ok) {
      setError(`${result.error.code}: ${result.error.message}`);
      return;
    }
    setNotice("Prompt favorite saved locally.");
    await refreshFavorites();
  }, [favoriteDialog, refreshFavorites]);

  const revealEvidence = useCallback((path: string): void => {
    const project = selectedRef.current?.project.id;
    if (!project) return;
    void window.mona.revealWorkspacePath(project, path).then((result) => {
      if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
      else setNotice("Revealed evidence in Finder.");
    });
  }, []);

  const submitIdentity = useCallback(async (): Promise<void> => {
    if (!identityDialog) return;
    const { project, accent, monogram } = identityDialog;
    setIdentityDialog(null);
    const token = epoch.current();
    beginBusy();
    try {
      const result = await window.mona.setProjectIdentity({
        projectId: project.id,
        accent: accent as PolishAccent | null,
        monogram: monogram.trim().length === 0 ? null : monogram.trim(),
        expectedRevision: project.revision,
      });
      if (!result.ok) {
        reportError(token, project.name, result.error);
        return;
      }
      reportNotice(token, project.name, "Project identity updated.");
      await refreshCatalog();
      if (epoch.isCurrent(token) && selectedRef.current?.project.id === project.id) {
        await selectProject(result.value);
      }
    } finally {
      endBusy();
    }
  }, [
    beginBusy,
    endBusy,
    epoch,
    identityDialog,
    refreshCatalog,
    reportError,
    reportNotice,
    selectProject,
  ]);

  /**
   * A Finder handoff opens the project and puts the cursor in the composer.
   * It does not start the engine and it does not submit anything.
   */
  const focusComposer = useCallback((): void => {
    requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>(".composer textarea");
      composer?.focus();
    });
  }, []);

  const handleOpenResult = useCallback(
    async (result: OpenResult): Promise<void> => {
      if (!result.ok) {
        setError(
          `${result.code ?? "OPEN_FAILED"}: ${result.message ?? "Mona could not open that folder."}`,
        );
        return;
      }
      const token = epoch.current();
      setNotice(
        result.created
          ? `Added “${result.projectName ?? "project"}” to the catalog. Runtime not started.`
          : `Opened “${result.projectName ?? "project"}”. Runtime not started.`,
      );
      const list = await window.mona.listProjects(undefined, true);
      if (!list.ok) return;
      setCatalog(list.value);
      // An open result that arrives after the user selected something else must
      // not pull the view away from that newer choice.
      if (!epoch.isCurrent(token)) return;
      const project = list.value.find((entry) => entry.id === result.projectId);
      if (project) {
        await selectProject(project, "studio");
        focusComposer();
      }
    },
    [epoch, focusComposer, selectProject],
  );

  const boot = useCallback(async (): Promise<void> => {
    try {
      const [app, appPaths, list, status, stateFacts, discovered, favoriteList, polish, zoomState] =
        await Promise.all([
          window.mona.getAppInfo(),
          window.mona.getPaths(),
          window.mona.listProjects(),
          window.mona.runtimeStatus(),
          window.mona.stateFacts(),
          window.mona.discoverTools(["codewhale", "git", "node"]),
          window.mona.promptFavorites(),
          window.mona.polishStatus(),
          window.mona.zoom(),
        ]);
      setAppInfo(app);
      setPaths(appPaths);
      setZoom(zoomState);
      setRuntime(status);
      setFacts(stateFacts);
      setTools(discovered);
      setFavorites(favoriteList.ok ? favoriteList.value : []);
      setPolishStatus(polish.ok ? polish.value : null);
      if (!list.ok) {
        setError(`${list.error.code}: ${list.error.message}`);
        return;
      }
      setCatalog(list.value);
      const last = localStorage.getItem("mona.lastProject");
      const target = list.value.find((project) => project.id === last) ?? list.value[0];
      if (target) await selectProject(target, "home");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      document.body.dataset.ready = "true";
    }
  }, [selectProject]);

  useEffect(() => {
    void boot();
    const off = window.mona.onProjectsChanged((projectId) => {
      void (async () => {
        const result = await window.mona.listProjects(undefined, true);
        if (result.ok) {
          setCatalog(result.value);
          const target = projectId
            ? result.value.find((project) => project.id === projectId)
            : undefined;
          if (target) {
            await selectProject(target, "studio");
            focusComposer();
          }
        }
      })();
    });
    const offOpen = window.mona.onOpenResult((result) => {
      // Drops and the native dialog are answered by the caller that started
      // them; a Service handoff, second launch, or open-file event is announced
      // here. The catalog refresh and selection arrive on `projects:changed`.
      if (result.source === "drop" || result.source === "dialog") return;
      if (!result.ok) {
        setError(
          `${result.code ?? "OPEN_FAILED"}: ${result.message ?? "Mona could not open that folder."}`,
        );
        return;
      }
      setNotice(
        result.created
          ? `Added “${result.projectName ?? "project"}” from Finder. Runtime not started.`
          : `Opened “${result.projectName ?? "project"}” from Finder. Runtime not started.`,
      );
    });
    const offStudio = window.mona.onStudioChanged((push) => {
      const current = selectedRef.current?.project.id;
      if (!current || push.projectId !== current) return;
      if (push.kind !== "event" && studioTimer.current) {
        clearTimeout(studioTimer.current);
        studioTimer.current = null;
      }
      if (studioTimer.current) return;
      studioTimer.current = setTimeout(
        () => {
          studioTimer.current = null;
          void refreshSelected();
          if (push.kind !== "event") {
            void window.mona.refreshPolish(push.projectId as ProjectId).then((status) => {
              if (status.ok) setPolishStatus(status.value);
            });
          }
        },
        push.kind === "event" ? 400 : 40,
      );
    });
    return () => {
      off();
      offOpen();
      offStudio();
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (studioTimer.current) clearTimeout(studioTimer.current);
    };
  }, [boot, focusComposer, refreshCatalog, refreshSelected, selectProject]);

  useEffect(() => {
    const offFocus = window.mona.onPolishFocus((target) => {
      void (async () => {
        const list = await window.mona.listProjects(undefined, true);
        if (!list.ok) return;
        const project = list.value.find((entry) => entry.id === target.projectId);
        if (project) {
          await selectProject(project, isScreen(target.screen) ? target.screen : "studio");
        }
        setPolishFocus({
          taskId: target.taskId,
          problemId: target.problemId,
          changeSetId: target.changeSetId,
        });
      })();
    });
    const offToggle = window.mona.onToggleFocus(() => toggleFocusModeRef.current());
    return () => {
      offFocus();
      offToggle();
    };
  }, [selectProject]);

  useEffect(() => {
    if (!selected) return;
    const projectId = selected.project.id;
    const timer = setTimeout(() => {
      // Guard the write itself: the effect's cleanup cancels on a selection
      // change, but a mixed view must never be stored against another project.
      if (selectedRef.current?.project.id !== projectId) return;
      void window.mona.saveProjectView(projectId, {
        screen,
        inspectorTab,
        studioMode,
        focusMode,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [screen, inspectorTab, selected, studioMode, focusMode]);

  const openFolder = useCallback(async (): Promise<void> => {
    const token = epoch.current();
    beginBusy();
    setError(null);
    try {
      const result = await window.mona.openProject();
      if (!result.ok) {
        reportError(token, "Open folder", result.error);
        return;
      }
      if (!result.value) {
        setNotice("Folder selection canceled.");
        return;
      }
      setNotice(
        result.value.created ? "Project added to the catalog." : "Project opened from the catalog.",
      );
      await refreshCatalog();
      // The user asked for this folder explicitly: a newer explicit selection
      // still wins, so only select when nothing newer happened meanwhile.
      if (epoch.isCurrent(token)) await selectProject(result.value.project, "studio");
    } finally {
      endBusy();
    }
  }, [beginBusy, endBusy, epoch, refreshCatalog, reportError, selectProject]);
  openFolderRef.current = () => void openFolder();
  toggleFocusModeRef.current = toggleFocusMode;

  const onDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>): Promise<void> => {
      event.preventDefault();
      setDropActive(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      const selection = selectDroppedPath(files, (file) =>
        window.mona.pathForDroppedFile(file as File),
      );
      if (!selection.path) {
        if (selection.error) setError(selection.error);
        return;
      }
      beginBusy();
      try {
        const result = await window.mona.openDroppedFolder(selection.path);
        if (!result.ok) {
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        await handleOpenResult(result.value.result);
      } finally {
        endBusy();
      }
    },
    [beginBusy, endBusy, handleOpenResult],
  );

  const performProjectAction = useCallback(
    async (
      work: () => Promise<IpcResult<ProjectSummary>>,
      options: { success?: string; refreshDetail?: boolean; projectName?: string } = {},
    ): Promise<void> => {
      const token = epoch.current();
      const wasSelected = selectedRef.current?.project.id ?? null;
      beginBusy();
      setError(null);
      try {
        const result = await work();
        if (!result.ok) {
          reportError(token, options.projectName ?? "Project", result.error);
          return;
        }
        if (options.success) setNotice(options.success);
        await refreshCatalog();
        // A pin/rename may only reopen the project it changed, and only while
        // the user is still on it. A slow rename of A must not pull the view
        // back from B.
        if (
          options.refreshDetail &&
          epoch.isCurrent(token) &&
          selectedRef.current?.project.id === result.value.id &&
          result.value.id === wasSelected
        ) {
          await selectProject(result.value);
        }
      } finally {
        endBusy();
      }
    },
    [beginBusy, endBusy, epoch, refreshCatalog, reportError, selectProject],
  );

  const togglePin = useCallback(
    (project: ProjectSummary) => {
      void performProjectAction(
        () => window.mona.setProjectPinned(project.id, !project.pinned, project.revision),
        {
          success: project.pinned ? "Project unpinned." : "Project pinned.",
          refreshDetail: true,
          projectName: project.name,
        },
      );
    },
    [performProjectAction],
  );

  const toggleArchive = useCallback(
    (project: ProjectSummary) => {
      void performProjectAction(
        () => window.mona.setProjectArchived(project.id, !project.archived, project.revision),
        {
          success: project.archived
            ? "Project restored from archive."
            : "Project archived; source untouched.",
          projectName: project.name,
        },
      );
    },
    [performProjectAction],
  );

  const relocate = useCallback(
    async (project: ProjectSummary): Promise<void> => {
      const token = epoch.current();
      beginBusy();
      setError(null);
      try {
        const result = await window.mona.relocateProject(project.id, project.revision);
        if (!result.ok) {
          reportError(token, project.name, result.error);
          return;
        }
        if (!result.value) {
          setNotice("Relocation canceled.");
          return;
        }
        reportNotice(token, project.name, "Project rebound to the new folder.");
        await refreshCatalog();
        if (epoch.isCurrent(token)) await selectProject(result.value);
      } finally {
        endBusy();
      }
    },
    [beginBusy, endBusy, epoch, refreshCatalog, reportNotice, reportError, selectProject],
  );

  const reveal = useCallback((project: ProjectSummary) => {
    void window.mona.revealProject(project.id).then((result) => {
      if (!result.ok) setError(`${result.error.code}: ${result.error.message}`);
      else setNotice("Revealed in Finder.");
    });
  }, []);

  const submitRename = useCallback(async (): Promise<void> => {
    if (!dialog || dialog.kind !== "rename") return;
    const name = dialog.name.trim();
    if (!name) return;
    setDialog(null);
    await performProjectAction(
      () => window.mona.renameProject(dialog.project.id, name, dialog.project.revision),
      { success: "Project label renamed.", refreshDetail: true, projectName: dialog.project.name },
    );
  }, [dialog, performProjectAction]);

  const submitRemove = useCallback(async (): Promise<void> => {
    if (!dialog || dialog.kind !== "remove") return;
    const project = dialog.project;
    setDialog(null);
    const token = epoch.current();
    beginBusy();
    try {
      const result = await window.mona.removeProject(project.id, project.revision);
      if (!result.ok) {
        reportError(token, project.name, result.error);
        return;
      }
      if (epoch.isCurrent(token) && selectedRef.current?.project.id === project.id) {
        // Invalidate any load still in flight for the removed project, and drop
        // its draft with it.
        epoch.begin();
        drafts.close();
        setSelected(null);
        setStudio(null);
        setScreen("home");
      }
      reportNotice(
        token,
        project.name,
        "Removed from the catalog. The source folder was not touched.",
      );
      await refreshCatalog();
    } finally {
      endBusy();
    }
  }, [beginBusy, dialog, drafts, endBusy, epoch, refreshCatalog, reportNotice, reportError]);

  const startStudio = useCallback(async (): Promise<void> => {
    const current = selectedRef.current;
    if (!current) return;
    const token = epoch.current();
    const name = current.project.name;
    setStudioBusy(true);
    try {
      const result = await window.mona.startStudio(current.project.id);
      if (!result.ok) {
        reportError(token, name, result.error);
        return;
      }
      if (epoch.isCurrent(token)) setStudio(result.value);
      reportNotice(
        token,
        name,
        result.value.connection.state === "connected"
          ? "Owned runtime connected to this workspace."
          : result.value.connection.reason,
      );
      await refreshSelected();
    } finally {
      setStudioBusy(false);
    }
  }, [epoch, refreshSelected, reportError, reportNotice]);

  const submitTask = useCallback(async (): Promise<void> => {
    const current = selectedRef.current;
    const view = drafts.current();
    if (!current || !view) return;
    if (view.text.trim().length === 0) {
      setError("A task prompt must not be empty.");
      return;
    }
    const token = epoch.current();
    const name = current.project.name;
    // R03: a recognised Codewhale command is never submitted as a prompt. The
    // catalog explains what the line is and which route would run it; R04 wires
    // the execution. Nothing here reaches the engine or a model.
    if (!commandCatalog && couldBeCommandText(view.text)) {
      reportNotice(
        token,
        name,
        "The Codewhale command catalog is unavailable, so this slash text was not sent: it could be a command. Start the line with a space to send it as literal text.",
        "attention",
      );
      return;
    }
    const intent = commandCatalog ? classifyComposerText(view.text, commandCatalog) : null;
    if (intent && intent.kind !== "prompt") {
      const explanation = describeCommandIntent(intent);
      if (explanation) reportNotice(token, name, explanation, "attention");
      return;
    }
    // Immutable identity, captured before the first await. The bytes that are
    // sent, the thread they belong to, and the draft revision they came from
    // cannot drift afterwards.
    const identity: SubmissionIdentity = {
      projectId: current.project.id,
      threadId: view.threadId,
      draftRevision: view.revision,
      text: view.text,
      mode: studioMode,
    };
    // Claims synchronously, so a click plus ⌘Enter (or a repeated key) can
    // never dispatch twice, even before React re-renders `studioBusy`.
    if (!submission.claim(identity)) return;
    setStudioBusy(true);
    try {
      // Persist whatever is newest before sending; a failure here is reported
      // but does not silently block the submission the user asked for.
      await flushDraft();
      const result = await window.mona.submitTask(identity.projectId, identity.text, identity.mode);
      if (!result.ok) {
        reportError(token, name, result.error);
        return;
      }
      if (epoch.isCurrent(token)) setStudio(result.value.snapshot);
      if (result.value.outcome === "accepted") {
        const cleared = drafts.acceptSent(identity);
        const turnSuffix = result.value.turnId ? `: ${result.value.turnId}` : ".";
        reportNotice(
          token,
          name,
          cleared === "cleared"
            ? `Turn accepted${result.value.turnId ? turnSuffix : "."}`
            : cleared === "preserved"
              ? `Turn accepted${result.value.turnId ? turnSuffix : "."} Text typed since sending was kept.`
              : `Turn accepted${result.value.turnId ? turnSuffix : "."}`,
        );
      } else if (result.value.outcome === "outcome_unknown") {
        reportNotice(
          token,
          name,
          result.value.guidance ?? "Outcome unknown: reconcile the lookup before resending.",
          "attention",
        );
      } else {
        reportNotice(token, name, result.value.note ?? "The runtime did not accept the turn.");
      }
      await refreshSelected();
    } finally {
      submission.release(identity);
      setStudioBusy(false);
    }
  }, [
    commandCatalog,
    drafts,
    epoch,
    flushDraft,
    refreshSelected,
    reportError,
    reportNotice,
    studioMode,
    submission,
  ]);

  const runStudioAction = useCallback(
    async (
      action: (projectId: ProjectId) => Promise<IpcResult<StudioActionResult>>,
    ): Promise<void> => {
      const current = selectedRef.current;
      if (!current) return;
      const token = epoch.current();
      const name = current.project.name;
      setStudioBusy(true);
      try {
        const result = await action(current.project.id);
        if (!result.ok) {
          reportError(token, name, result.error);
          return;
        }
        if (epoch.isCurrent(token)) setStudio(result.value.snapshot);
        reportNotice(token, name, result.value.note);
        await refreshSelected();
      } finally {
        setStudioBusy(false);
      }
    },
    [epoch, refreshSelected, reportError, reportNotice],
  );

  const reconcileStudio = useCallback(async (): Promise<void> => {
    const current = selectedRef.current;
    if (!current) return;
    const token = epoch.current();
    const name = current.project.name;
    setStudioBusy(true);
    try {
      const result = await window.mona.reconcileSubmission(current.project.id);
      if (!result.ok) {
        reportError(token, name, result.error);
        return;
      }
      if (epoch.isCurrent(token)) setStudio(result.value.snapshot);
      reportNotice(
        token,
        name,
        `Reconciliation: ${result.value.status}${
          result.value.guidance ? ` · ${result.value.guidance}` : ""
        }`,
      );
      await refreshSelected();
    } finally {
      setStudioBusy(false);
    }
  }, [epoch, refreshSelected, reportError, reportNotice]);

  const openCapabilityEntry = useCallback(
    (entry: {
      kind: PaletteEntry["entryKind"];
      target: string | null;
      invocation: string;
    }): void => {
      if (entry.kind === "terminal") {
        setTerminalCommand(entry.invocation);
        setTerminalMode("shell");
        setTerminalOpen(true);
        return;
      }
      if (entry.kind === "settings_tab" && entry.target) {
        setSettingsTab(entry.target);
        setScreen("settings");
        return;
      }
      if (entry.kind === "screen" && isScreen(entry.target)) {
        setScreen(entry.target);
      }
    },
    [],
  );

  // The palette reads local records. Opening it never spends inference: the
  // board snapshot and the capability inventory are stored or read-only.
  useEffect(() => {
    if (!paletteOpen) return;
    const projectId = selectedRef.current?.project.id ?? null;
    if (projectId) {
      void window.mona.boardSnapshot(projectId).then((result) => {
        if (result.ok) setPaletteTasks(result.value.tasks);
      });
    }
    void window.mona.capabilitySnapshot().then((result) => {
      if (result.ok) setPaletteCapabilities(result.value);
    });
  }, [paletteOpen]);

  useEffect(() => {
    if (screen !== "memory") return;
    const projectId = selected?.project.id ?? null;
    if (!projectId) {
      setMemoryTasks([]);
      return;
    }
    let cancelled = false;
    void window.mona.boardSnapshot(projectId).then((result) => {
      if (cancelled) return;
      setMemoryTasks(
        result.ok
          ? result.value.tasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
            }))
          : [],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [screen, selected?.project.id]);

  const paletteActions = useMemo<PaletteAction[]>(() => {
    const actions: PaletteAction[] = SCREENS.map((entry) => ({
      id: `screen-${entry.id}`,
      kind: "screen" as PaletteKind,
      label: `Go to ${entry.label}`,
      hint: "Screen",
      keywords: [entry.id],
      icon: entry.icon,
      run: () => setScreen(entry.id),
    }));
    actions.push({
      id: "open-folder",
      kind: "action",
      label: "Open or import folder…",
      hint: "Project",
      icon: <FolderIcon size={16} />,
      run: () => void openFolder(),
    });
    actions.push({
      id: "focus-mode",
      kind: "action",
      label: focusMode ? "Turn Focus Mode off" : "Turn Focus Mode on",
      hint: "Layout · ⌘⇧F",
      icon: <SparkIcon size={16} />,
      run: () => toggleFocusMode(),
    });
    actions.push({
      id: "shortcuts",
      kind: "action",
      label: "Keyboard shortcuts",
      hint: "Help · ⌘/",
      icon: <KeyCap>?</KeyCap>,
      run: () => setShortcutsOpen(true),
    });
    actions.push({
      id: "quit",
      kind: "action",
      label: "Quit Mona…",
      hint: "Application",
      icon: <WarningIcon size={16} />,
      run: () => setQuitOpen(true),
    });
    if (selectedRef.current) {
      actions.push({
        id: "reveal",
        kind: "action",
        label: `Reveal ${selectedRef.current.project.name} in Finder`,
        hint: "Project",
        icon: <SearchIcon size={16} />,
        run: () => reveal(selectedRef.current!.project),
      });
    }
    for (const project of catalog) {
      actions.push({
        id: `project-${project.id}`,
        kind: "project",
        label: `Open ${project.name}`,
        hint: project.rootPath,
        icon: (
          <span className={`monogram monogram--${projectAccent(project)} monogram--tiny`}>
            {projectMonogram(project)}
          </span>
        ),
        run: () => void selectProject(project, "studio"),
      });
    }
    for (const tab of SETTINGS_TABS) {
      actions.push({
        id: `settings-${tab.id}`,
        kind: "setting",
        label: `Settings: ${tab.label}`,
        hint: "Setting",
        keywords: ["preferences", "configuration", tab.id],
        icon: <SettingsIcon size={16} />,
        run: () => {
          setSettingsTab(tab.id);
          setScreen("settings");
        },
      });
    }
    for (const favorite of favorites) {
      actions.push({
        id: `favorite-${favorite.id}`,
        kind: "prompt",
        label: `Insert prompt “${favorite.label}”`,
        hint: "Prompt favorite · inert text",
        keywords: [favorite.text.slice(0, 200)],
        icon: <SparkIcon size={16} />,
        run: () => useFavorite(favorite),
      });
    }
    for (const task of paletteTasks) {
      actions.push({
        id: `task-${task.id}`,
        kind: "prompt",
        label: `Task: ${task.title}`,
        hint: "Work board · open the task",
        keywords: [task.prompt.slice(0, 200), task.status],
        icon: <BoardIcon size={16} />,
        run: () => setScreen("board"),
      });
    }
    for (const row of paletteCapabilities?.rows ?? []) {
      // A cap with no entry point is not offered here; the explorer still shows
      // it and names the gap.
      if (row.entryPoint.kind === "none") continue;
      const detail: PaletteDetail = {
        classification: row.classification,
        cost: row.cost,
        effect: row.description,
        route: row.invocation,
        status: row.status,
      };
      actions.push({
        id: `capability-${row.id}`,
        kind: "capability",
        label: row.name,
        hint: `${row.entryPoint.label} · ${row.invocation}`,
        keywords: [row.id, row.integration, row.description, row.upstreamVersion],
        detail,
        entryKind: row.entryPoint.kind,
        entryTarget: row.entryPoint.target,
        openable: true,
        icon: <SearchIcon size={16} />,
        run: () =>
          openCapabilityEntry({
            kind: row.entryPoint.kind,
            target: row.entryPoint.target,
            invocation: row.invocation,
          }),
      });
    }
    // Scale actions go last: they are utilities, and inserting them earlier
    // would push projects and capabilities out of the first visible page of an
    // empty query.
    actions.push({
      id: "zoom-in",
      kind: "action",
      label: "Zoom in",
      hint: `Interface scale · ⇧⌘= or ⌘+ · now ${zoom?.percent ?? "100%"}`,
      keywords: ["bigger", "scale", "text size", "magnify"],
      icon: <SearchIcon size={16} />,
      run: () => stepZoomBy("in"),
    });
    actions.push({
      id: "zoom-out",
      kind: "action",
      label: "Zoom out",
      hint: `Interface scale · ⌘− · now ${zoom?.percent ?? "100%"}`,
      keywords: ["smaller", "scale", "text size"],
      icon: <SearchIcon size={16} />,
      run: () => stepZoomBy("out"),
    });
    actions.push({
      id: "zoom-reset",
      kind: "action",
      label: "Actual size",
      hint: "Interface scale · ⌘0 · back to 100%",
      keywords: ["reset", "100%", "default size"],
      icon: <SearchIcon size={16} />,
      run: () => void applyZoom(1),
    });
    return actions;
  }, [
    catalog,
    focusMode,
    openFolder,
    reveal,
    selectProject,
    toggleFocusMode,
    favorites,
    paletteTasks,
    paletteCapabilities,
    useFavorite,
    openCapabilityEntry,
  ]);

  const paletteResults = useMemo(
    () => rankPalette(paletteActions, paletteQuery, 16),
    [paletteActions, paletteQuery],
  );
  const filteredActions = paletteResults.matches;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        setPaletteQuery("");
        return;
      }
      if (event.metaKey && !event.shiftKey && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setTerminalMode("shell");
        setTerminalOpen((value) => !value);
        return;
      }
      if (event.metaKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        openFolderRef.current();
        return;
      }
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        toggleFocusModeRef.current();
        return;
      }
      if (event.metaKey && event.key === "/") {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Escape leaves Focus Mode when no dialog owns the key. The composer and
      // the timeline keep their own Escape behaviour; a dialog closes itself.
      const typing =
        event.target instanceof HTMLElement &&
        (event.target.tagName === "INPUT" ||
          event.target.tagName === "TEXTAREA" ||
          event.target.isContentEditable);
      if (event.key === "Escape" && !typing && !document.querySelector('[role="dialog"]')) {
        setFocusMode(false);
        return;
      }
      // Command-modified digits are never text input, so screen switching
      // stays available while the composer has focus.
      if (event.metaKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
        const next = SCREEN_IDS[Number(event.key) - 1];
        if (next) {
          event.preventDefault();
          setScreen(next);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeScreen = SCREENS.find((entry) => entry.id === screen) ?? SCREENS[0];
  const engineState = selected?.engine ?? null;
  // One short, deduplicated announcement per real change: quiet enough for a
  // screen reader during a long session, and never per streamed token.
  const attentionAnnouncement = useMemo(() => {
    if (!polishStatus) return "";
    const { blocked, unseenCompletions, running } = polishStatus.attention;
    const parts = [
      running ? "work in progress" : null,
      blocked > 0 ? `${blocked} blocked` : null,
      unseenCompletions > 0 ? `${unseenCompletions} finished since your last visit` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `Attention: ${parts.join(", ")}.` : "";
  }, [polishStatus]);

  return (
    <div
      className={`harness shell ${dropActive ? "shell--drop-active" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer?.types?.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
      {dropActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <span className="drop-overlay__label">Drop a folder to open it in Mona</span>
          <span className="drop-overlay__hint">
            One folder at a time · opening never starts the engine or submits a task
          </span>
        </div>
      ) : null}
      <a className="skip-link" href="#screen-main">
        Skip to content
      </a>
      <div className="titlebar" aria-hidden="true">
        <span className="titlebar__title">Mona</span>
      </div>

      <aside className="rail" aria-label="Primary">
        <div className="rail__brand">
          <span className="brand-mark" aria-hidden="true">
            ◐
          </span>
          <span className="brand-name">Mona</span>
        </div>

        <nav className="rail__nav" aria-label="Screens">
          {SCREENS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              data-nav
              className={`rail__item ${entry.id === screen ? "rail__item--current" : ""}`}
              aria-current={entry.id === screen ? "page" : undefined}
              aria-label={entry.label}
              title={entry.label}
              onClick={() => setScreen(entry.id)}
            >
              <span className="rail__icon" aria-hidden="true">
                {entry.icon}
              </span>
              <span className="rail__label">{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="rail__group" aria-label="Projects">
          <p className="rail__group-title">Projects</p>
          {catalog.length === 0 ? (
            <p className="rail__hint">No projects yet</p>
          ) : (
            catalog.slice(0, 6).map((project) => (
              <button
                key={project.id}
                type="button"
                className={`rail__project ${selected?.project.id === project.id ? "rail__project--current" : ""}`}
                onClick={() => void selectProject(project)}
                title={project.rootPath}
              >
                <span
                  className={`monogram monogram--${projectAccent(project)} monogram--tiny`}
                  aria-hidden="true"
                >
                  {projectMonogram(project)}
                </span>
                <span className="rail__project-name">{project.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="rail__footer">
          <span
            className={`status-dot ${selected?.engine.canExecute ? "status-dot--success" : "status-dot--attention"}`}
            aria-hidden="true"
          />
          <div>
            <p className="rail__footer-line">
              {selected
                ? selected.engine.canExecute
                  ? "Engine connected"
                  : "Engine disconnected"
                : "No project selected"}
            </p>
            <p className="rail__footer-line rail__footer-line--muted" data-testid="app-version">
              Mona {appInfo?.version ?? "0.1.0-p02"}
            </p>
          </div>
        </div>
      </aside>

      <main className="harness__main shell__main" id="screen-main" tabIndex={-1}>
        <div className="shell-topbar">
          <div className="shell-topbar__crumb">
            <span className="eyebrow">Workspace</span>
            <span className="shell-topbar__screen">{activeScreen?.label}</span>
            {selected ? <Badge tone="neutral">{selected.project.name}</Badge> : null}
          </div>
          <div className="shell-topbar__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshIcon size={14} />}
              onClick={() => void refreshCatalog()}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts (Command-/)"
            >
              Shortcuts <KeyCap>⌘/</KeyCap>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<TerminalIcon size={14} />}
              onClick={() => {
                setTerminalMode("shell");
                setTerminalOpen((value) => !value);
              }}
              title="Toggle the terminal (Command-J)"
            >
              Terminal <KeyCap>⌘J</KeyCap>
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<SearchIcon size={14} />}
              onClick={() => setPaletteOpen(true)}
            >
              Palette <KeyCap>⌘K</KeyCap>
            </Button>
          </div>
        </div>

        {error ? (
          <Callout
            tone="danger"
            title="Action could not be completed"
            action={
              <Button size="sm" variant="ghost" onClick={() => setError(null)}>
                Dismiss
              </Button>
            }
          >
            {error}
          </Callout>
        ) : null}
        {notice ? (
          <Notification tone={noticeTone} title={notice} onDismiss={() => setNotice(null)} />
        ) : null}

        <VisuallyHidden>
          <p aria-live="polite">Screen: {activeScreen?.label}</p>
          {attentionAnnouncement ? <p aria-live="polite">{attentionAnnouncement}</p> : null}
        </VisuallyHidden>

        {screen === "home" ? (
          <HomeScreen
            catalog={catalog}
            selectedId={selected?.project.id ?? null}
            query={query}
            showArchived={showArchived}
            busy={busy}
            onQuery={(value) => {
              setQuery(value);
              void window.mona
                .listProjects(value.trim() || undefined, showArchived)
                .then((result) => {
                  if (result.ok) setCatalog(result.value);
                  else setError(`${result.error.code}: ${result.error.message}`);
                });
            }}
            onToggleArchived={() => {
              const next = !showArchived;
              setShowArchived(next);
              void window.mona.listProjects(query.trim() || undefined, next).then((result) => {
                if (result.ok) setCatalog(result.value);
              });
            }}
            onOpenFolder={() => void openFolder()}
            onSelect={(project) => void selectProject(project, "studio")}
            onRename={(project) => setDialog({ kind: "rename", project, name: project.name })}
            onPin={togglePin}
            onArchive={toggleArchive}
            onRemove={(project) => setDialog({ kind: "remove", project })}
            onRelocate={(project) => void relocate(project)}
            onReveal={reveal}
            digest={digest}
            onEditIdentity={(project) =>
              setIdentityDialog({
                project,
                accent: project.accent,
                monogram: project.monogram ?? "",
              })
            }
            onOpenScreen={(screen) => {
              if (isScreen(screen)) setScreen(screen);
            }}
            onRevealEvidence={revealEvidence}
          />
        ) : null}
        {screen === "studio" ? (
          <StudioScreen
            detail={selected}
            studio={studio}
            studioBusy={studioBusy}
            mode={studioMode}
            draft={draft}
            draftStatus={draftStatus}
            commandCatalog={commandCatalog}
            inspectorTab={inspectorTab}
            onInspectorTab={setInspectorTab}
            onDraft={onDraft}
            onMode={setStudioMode}
            onOpenFolder={() => void openFolder()}
            onShowBoard={() => setScreen("board")}
            onStart={() => void startStudio()}
            onSubmit={() => void submitTask()}
            onInterrupt={() => void runStudioAction((id) => window.mona.interruptNow(id))}
            onPause={() => void runStudioAction((id) => window.mona.pauseAfterTask(id))}
            onResumeQueue={() => void runStudioAction((id) => window.mona.resumeQueue(id))}
            onCancelQueued={() => void runStudioAction((id) => window.mona.cancelQueued(id))}
            onStop={() => void runStudioAction((id) => window.mona.stopStudio(id))}
            onReconcile={() => void reconcileStudio()}
            focusMode={focusMode}
            favorites={favorites}
            onToggleFocus={toggleFocusMode}
            onUseFavorite={useFavorite}
            onRequestSaveFavorite={() =>
              setFavoriteDialog({ label: "", text: drafts.current()?.text ?? "" })
            }
            onRemoveFavorite={(id) => void removeFavorite(id)}
            history={
              selected && historyView.projectId === selected.project.id
                ? {
                    events: historyView.events,
                    storedTotal: historyView.storedTotal,
                    hasMore: historyView.hasMore,
                    loading: historyView.loading,
                    error: historyView.error,
                    threadId: historyView.threadId,
                    truncatedItems: historyView.truncatedItems,
                    completeItems: historyView.completeItems,
                    olderLoads: historyView.olderLoads,
                    onLoadOlder: () => void history.older(),
                    onLoadItem: (threadId, itemId) => void history.loadItem(threadId, itemId),
                    onSelectThread: (threadId) => void history.selectThread(threadId),
                  }
                : null
            }
          />
        ) : null}
        {screen === "board" ? (
          <BoardScreen
            detail={selected}
            onOpenFolder={() => void openFolder()}
            onShowStudio={() => setScreen("studio")}
            focusTaskId={polishFocus?.taskId ?? null}
          />
        ) : null}
        {screen === "changes" ? (
          <ChangesScreen
            detail={selected}
            onOpenFolder={() => void openFolder()}
            focusChangeSetId={polishFocus?.changeSetId ?? null}
            onFocusHandled={() => setPolishFocus(null)}
          />
        ) : null}
        {screen === "cost" ? (
          <CostScreen detail={selected} onOpenFolder={() => void openFolder()} />
        ) : null}
        {screen === "agents" ? (
          selected ? (
            <AgentsScreen
              detail={selected}
              engineThreadId={studio?.engineThreadId ?? null}
              onOpenFolder={() => void openFolder()}
              onShowStudio={() => setScreen("studio")}
            />
          ) : null
        ) : null}
        {screen === "settings" ? (
          <SettingsScreen
            app={appInfo}
            paths={paths}
            facts={facts}
            runtime={runtime}
            detail={selected}
            tools={tools}
            theme={theme}
            density={density}
            zoom={zoom}
            onTheme={setTheme}
            onDensity={setDensity}
            onZoom={(factor) => void applyZoom(factor)}
            polish={polishStatus}
            onPatchPreferences={async (patch) => {
              const result = await window.mona.setPolishPreferences(patch);
              if (!result.ok) {
                setError(`${result.error.code}: ${result.error.message}`);
                return;
              }
              const status = await window.mona.polishStatus();
              if (status.ok) setPolishStatus(status.value);
            }}
            onOpenStudio={() => setScreen("studio")}
            onTestNotification={async () => {
              const result = await window.mona.testNotification();
              if (!result.ok) {
                setError(`${result.error.code}: ${result.error.message}`);
                return;
              }
              const status = await window.mona.polishStatus();
              if (status.ok) setPolishStatus(status.value);
              setNoticeTone(result.value.delivered ? "success" : "attention");
              setNotice(
                result.value.delivered
                  ? "Test notification handed to macOS."
                  : `Notification was not delivered: ${result.value.suppressedReason ?? "unknown reason"}`,
              );
            }}
            onQuit={() => setQuitOpen(true)}
            openTab={settingsTab}
          />
        ) : null}
        {screen === "capabilities" ? (
          <CapabilitiesScreen
            onOpenEntry={(request: CapabilityEntryRequest) => {
              if (request.kind === "settings_tab" && request.target) {
                setSettingsTab(request.target);
                setScreen("settings");
                return;
              }
              if (request.kind === "screen" && isScreen(request.target)) {
                setScreen(request.target);
                return;
              }
              if (request.kind === "palette") {
                setPaletteOpen(true);
              }
            }}
            onTerminal={(command: string) => {
              setTerminalCommand(command);
              setTerminalMode("shell");
              setTerminalOpen(true);
            }}
          />
        ) : null}

        {screen === "memory" ? (
          <MemoryScreen
            projectId={selected?.project.id ?? null}
            projectName={selected?.project.name ?? null}
            boardTasks={memoryTasks}
          />
        ) : null}

        <TerminalPanel
          projectId={selected?.project.id ?? null}
          open={terminalOpen}
          mode={terminalMode}
          prefill={terminalCommand}
          onMode={setTerminalMode}
          onClose={() => setTerminalOpen(false)}
        />

        <footer className="harness__footer">
          <FolderIcon size={14} /> {catalog.length} local project{catalog.length === 1 ? "" : "s"} ·{" "}
          {engineState?.blockedReason
            ? "Execution unavailable"
            : engineState
              ? "Execution ready"
              : "No project selected"}{" "}
          · zero inference in navigation
        </footer>
      </main>

      <Dialog
        open={paletteOpen}
        title="Command palette"
        description="Local navigation over projects, prompts, actions, settings, and engine capabilities. No model call is made."
        onClose={() => setPaletteOpen(false)}
      >
        <div className="palette">
          <label className="field__label" htmlFor="shell-palette-filter">
            Search projects, prompts, actions, settings, and capabilities
          </label>
          <input
            id="shell-palette-filter"
            className="input"
            value={paletteQuery}
            onChange={(event) => setPaletteQuery(event.target.value)}
            placeholder="Project, prompt, setting, or capability…"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                const first = document.querySelector<HTMLButtonElement>(".palette__item");
                first?.focus();
              } else if (event.key === "Enter" && filteredActions[0]) {
                event.preventDefault();
                filteredActions[0].run();
                setPaletteOpen(false);
              }
            }}
          />
          <ul className="palette__list">
            {filteredActions.map((action) => (
              <li key={action.id}>
                <button
                  type="button"
                  className="palette__item"
                  onClick={() => {
                    action.run();
                    setPaletteOpen(false);
                  }}
                >
                  <span className="palette__icon" aria-hidden="true">
                    {action.icon}
                  </span>
                  <span className="palette__label">{action.label}</span>
                  <span className="palette__hint">{action.hint}</span>
                  {action.detail ? (
                    <span className="palette__detail">
                      <Badge
                        tone={
                          action.detail.classification === "destructive"
                            ? "danger"
                            : action.detail.classification === "write"
                              ? "attention"
                              : "neutral"
                        }
                      >
                        {action.detail.classification}
                      </Badge>
                      {action.detail.status === "blocked_gap" ? (
                        <Badge tone="danger">blocked</Badge>
                      ) : action.detail.status === "unavailable" ? (
                        <Badge tone="neutral">unavailable</Badge>
                      ) : null}
                      <span className="palette__cost">{action.detail.cost}</span>
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {filteredActions.length === 0 ? (
              <li className="palette__empty">No matching action.</li>
            ) : null}
          </ul>
          <p className="palette__count" data-testid="palette-count">
            {paletteResults.total} match{paletteResults.total === 1 ? "" : "es"}
            {paletteResults.truncated ? ` · showing the first ${filteredActions.length}` : ""} ·
            ranked locally
          </p>
        </div>
      </Dialog>

      <Dialog
        open={dialog?.kind === "rename"}
        title="Rename project label"
        description="The label is local to Mona. The folder name and its contents are unchanged."
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitRename()}
              disabled={!dialog || dialog.kind !== "rename" || !dialog.name.trim()}
            >
              Rename
            </Button>
          </>
        }
      >
        {dialog?.kind === "rename" ? (
          <TextField
            label="Project label"
            value={dialog.name}
            maxLength={200}
            autoFocus
            onChange={(event) =>
              setDialog({ kind: "rename", project: dialog.project, name: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitRename();
            }}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={dialog?.kind === "remove"}
        title="Remove from the project catalog?"
        description="This removes Mona's catalog entry only. The source folder and its files are not deleted."
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void submitRemove()}>
              Remove entry
            </Button>
          </>
        }
      >
        {dialog?.kind === "remove" ? (
          <div className="remove-summary">
            <p className="remove-summary__name">{dialog.project.name}</p>
            <p className="mono wrap">{dialog.project.rootPath}</p>
            <p className="hint-line">
              <WarningIcon size={14} /> Archive is the reversible option; removal frees the path for
              a fresh catalog entry.
            </p>
          </div>
        ) : null}
      </Dialog>
      <Dialog
        open={shortcutsOpen}
        title="Keyboard shortcuts"
        description="Every screen is reachable without a mouse. Navigation makes no model call."
        onClose={() => setShortcutsOpen(false)}
        footer={
          <Button variant="primary" onClick={() => setShortcutsOpen(false)}>
            Close
          </Button>
        }
      >
        <dl className="shortcut-list" data-testid="shortcut-list">
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘1</KeyCap>–<KeyCap>⌘8</KeyCap>
            </dt>
            <dd>Home, Studio, Work board, Changes, Cost lens, Settings, Agents, Capabilities</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘J</KeyCap>
            </dt>
            <dd>Toggle the integrated terminal</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘K</KeyCap>
            </dt>
            <dd>Command palette</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘O</KeyCap>
            </dt>
            <dd>Open a project folder</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘+</KeyCap> / <KeyCap>⌘−</KeyCap>
            </dt>
            <dd>Scale the whole interface up or down; ⌘0 returns to 100%</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘⇧F</KeyCap>
            </dt>
            <dd>Toggle Focus Mode (Studio)</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘⇧B</KeyCap>
            </dt>
            <dd>Show blockers in the work board</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘.</KeyCap>
            </dt>
            <dd>Interrupt current work (deliberate combination)</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘/</KeyCap>
            </dt>
            <dd>This shortcut list</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘W</KeyCap>
            </dt>
            <dd>Close the window; work continues</dd>
          </div>
          <div className="shortcut-row">
            <dt>
              <KeyCap>⌘Q</KeyCap>
            </dt>
            <dd>Quit; interrupts active work and stops the owned runtime</dd>
          </div>
        </dl>
      </Dialog>

      <Dialog
        open={identityDialog !== null}
        title="Project identity"
        description="A local color and monogram. The folder name and its contents are unchanged."
        onClose={() => setIdentityDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setIdentityDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void submitIdentity()}>
              Save identity
            </Button>
          </>
        }
      >
        {identityDialog ? (
          <div className="identity-editor" data-testid="identity-editor">
            <span className="harness-controls__label">Accent</span>
            <div className="identity-swatches" role="group" aria-label="Project accent">
              {POLISH_ACCENTS.map((accent) => (
                <button
                  key={accent}
                  type="button"
                  className={`swatch swatch--${accent} ${identityDialog.accent === accent ? "swatch--current" : ""}`}
                  aria-label={`Use the ${accent} accent`}
                  aria-pressed={identityDialog.accent === accent}
                  onClick={() => setIdentityDialog({ ...identityDialog, accent })}
                />
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setIdentityDialog({ ...identityDialog, accent: null })}
              >
                Automatic
              </Button>
            </div>
            <TextField
              label="Monogram"
              hint="One or two letters or digits. Leave empty to derive it from the name."
              value={identityDialog.monogram}
              maxLength={2}
              onChange={(event) =>
                setIdentityDialog({ ...identityDialog, monogram: event.target.value })
              }
            />
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={favoriteDialog !== null}
        title="Save prompt favorite"
        description="Favorites are inert local text. Inserting one fills the composer; nothing is sent."
        onClose={() => setFavoriteDialog(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFavoriteDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void submitFavorite()}
              disabled={!favoriteDialog || !favoriteDialog.label.trim()}
            >
              Save favorite
            </Button>
          </>
        }
      >
        {favoriteDialog ? (
          <div className="favorite-editor">
            <TextField
              label="Favorite label"
              value={favoriteDialog.label}
              maxLength={80}
              autoFocus
              onChange={(event) =>
                setFavoriteDialog({ ...favoriteDialog, label: event.target.value })
              }
            />
            <p className="hint-line">Exact text that will be inserted:</p>
            <pre className="favorite-preview" data-testid="favorite-preview">
              {favoriteDialog.text}
            </pre>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={quitOpen}
        title="Quit Mona?"
        description="Closing the last window keeps Mona running. Quitting interrupts active work and stops only the runtime Mona owns."
        onClose={() => setQuitOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setQuitOpen(false)}>
              Keep working
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setQuitOpen(false);
                // Persist whatever the composer holds before the app goes away;
                // the quit decision itself is unchanged.
                void (async () => {
                  await flushDraft();
                  await window.mona.quitMona(true);
                })();
              }}
            >
              Quit and interrupt
            </Button>
          </>
        }
      >
        <p className="hint-line">
          A finish already sent to the provider may still complete. Quit does not promise a rollback
          of external effects.
        </p>
      </Dialog>
    </div>
  );
}
